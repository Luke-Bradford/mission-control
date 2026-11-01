/**
 * What a ticket waits on, read one way for every gate: GitHub's blocked-by links, the `Depends on`
 * and `After PR` lines of its body, and a PR based on another open PR's branch. Pure: the server
 * hands it the stored board and PRs.
 */

import { statusOutOfDate } from "./hud.ts";
import { dependsOn } from "./repo-rules.ts";
import type { BoardItem, PullRequestView } from "./types.ts";

/** The issue a wait names (`repo#number`) or the PR (`PR number`), and how it reads in a refusal. */
export interface DependencyWait {
  ref: string;
  text: string;
  /** The hub never read this PR: it gates a start, but its ending is not a release. */
  unread?: true;
}

/** What the body names: the shape the board card stores as `after`. */
export interface BodyDependencies {
  issues: number[];
  prs: number[];
}

/** The PR numbers on a ticket body's `After PR` lines, in order, without repeats. */
export function afterPrs(body: string): number[] {
  const out: number[] = [];
  for (const line of body.match(/^\s*(?:[-*]\s+)?After PRs?\b.*$/gim) ?? []) {
    for (const m of line.replace(/^\s*(?:[-*]\s+)?After PRs?\b/i, "").matchAll(/\d+/g)) {
      const n = Number(m[0]);
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

export const bodyDependencies = (body: string): BodyDependencies => ({
  issues: dependsOn(body),
  prs: afterPrs(body),
});

/** The part of a PR the waits read. */
export type WaitPr = Pick<
  PullRequestView,
  "number" | "state" | "branch" | "ticket" | "isDraft" | "ci" | "review"
> &
  Partial<Pick<PullRequestView, "base" | "closingIssues">>;

/** The part of a card the waits read. */
export type WaitCard = Pick<BoardItem, "issueNumber" | "blockedBy"> & Pick<BoardItem, "after">;

/** Where an open PR is, in words: "PR 1033 in CI". */
export function prStageText(pr: Pick<WaitPr, "number" | "isDraft" | "ci" | "review">): string {
  const at = `PR ${pr.number}`;
  if (pr.isDraft) return `${at} is a draft`;
  if (pr.ci === "failing") return `${at} failing CI`;
  if (pr.ci === "passing")
    return pr.review === "approved" ? `${at} ready to merge` : `${at} in review`;
  return `${at} in CI`;
}

/** Whether the PR is the ticket's own: it closes the issue, or (without closing references) its branch names it. */
export const prCarries = (
  pr: Pick<WaitPr, "closingIssues" | "ticket">,
  repoId: string,
  issue: number,
): boolean =>
  pr.closingIssues?.length ? pr.closingIssues.includes(issue) : pr.ticket === `${repoId}#${issue}`;

export interface WaitInput {
  repoId: string;
  card: WaitCard;
  board: Pick<BoardItem, "issueNumber" | "closed" | "status" | "state">[];
  prs: readonly WaitPr[];
}

/**
 * Every open wait of the ticket, each with a reason in plain words. Closed is not merged: a closed
 * dependency ends its wait only when a merged PR carries it (or, with no PR row left, its card is in
 * Done); a closed unmerged PR or a manual close keeps the wait, for FLIGHT to re-plan. An `After PR`
 * ends only when that PR merged; one the store has no row for is unresolved until it is read.
 */
export function ticketWaits(i: WaitInput): DependencyWait[] {
  const { repoId, card, board, prs } = i;
  const out = new Map<string, DependencyWait>();
  const issueWait = (ref: string, issue: number | null) => {
    if (out.has(ref)) return;
    const open =
      issue === null
        ? undefined
        : prs.find((p) => p.state === "open" && prCarries(p, repoId, issue));
    out.set(ref, { ref, text: open ? `${ref} (${prStageText(open)})` : ref });
  };
  for (const b of card.blockedBy) {
    if (b.closed) continue;
    const m = /^(.+)#(\d+)$/.exec(b.ref);
    issueWait(b.ref, m?.[1] === repoId ? Number(m[2]) : null);
  }
  for (const n of card.after?.issues ?? []) {
    const dep = board.find((b) => b.issueNumber === n);
    if (dep?.closed === true) {
      // closed is not merged: a merged PR proves the work landed; with no PR row at all (swept as
      // old) the card's own Done status stands in; a closed unmerged PR, or a manual close, waits
      const carrying = prs.filter((p) => prCarries(p, repoId, n));
      const landed =
        carrying.some((p) => p.state === "merged") ||
        (carrying.length === 0 && !statusOutOfDate(dep));
      if (landed) continue;
      const ref = `${repoId}#${n}`;
      out.set(ref, { ref, text: `${ref} (closed without merging)` });
      continue;
    }
    issueWait(`${repoId}#${n}`, n);
  }
  for (const n of card.after?.prs ?? []) {
    const p = prs.find((x) => x.number === n);
    if (p?.state === "merged") continue;
    const text =
      p === undefined
        ? `PR ${n} (not read yet)`
        : p.state === "open"
          ? prStageText(p)
          : `PR ${n} (closed without merging)`;
    out.set(`PR ${n}`, {
      ref: `PR ${n}`,
      text,
      ...(p === undefined ? { unread: true as const } : {}),
    });
  }
  // a PR of this ticket stacked on another open PR's branch
  for (const own of prs) {
    if (own.state !== "open" || !prCarries(own, repoId, card.issueNumber)) continue;
    const under = prs.find(
      (p) => p.state === "open" && p.number !== own.number && p.branch === own.base,
    );
    if (under)
      out.set(`PR ${under.number}`, { ref: `PR ${under.number}`, text: prStageText(under) });
  }
  return [...out.values()];
}

/** A waiting ticket: what it waits on and the chain from it to the work at the root. */
export interface WaitChain {
  ref: string;
  waits: DependencyWait[];
  /** The ticket, then what it waits on first, and so on to the root; a cycle ends the chain. */
  chain: string[];
}

/** Each ticket in `cards` that waits on something, with its chain; in issue order. */
export function waitChains(i: {
  repoId: string;
  cards: readonly WaitCard[];
  board: WaitInput["board"];
  prs: readonly WaitPr[];
}): WaitChain[] {
  const { repoId, cards, board, prs } = i;
  const waitsOf = (c: WaitCard) => ticketWaits({ repoId, card: c, board, prs });
  const byRef = new Map(cards.map((c) => [`${repoId}#${c.issueNumber}`, c]));
  const out: WaitChain[] = [];
  for (const c of [...cards].sort((a, b) => a.issueNumber - b.issueNumber)) {
    const waits = waitsOf(c);
    if (waits.length === 0) continue;
    const ref = `${repoId}#${c.issueNumber}`;
    const chain = [ref];
    let next: DependencyWait | undefined = waits[0];
    while (next !== undefined) {
      if (chain.includes(next.ref)) break;
      chain.push(next.ref);
      const dep = byRef.get(next.ref);
      next = dep === undefined ? undefined : waitsOf(dep)[0];
    }
    out.push({ ref, waits, chain });
  }
  return out;
}

const BUILDS_ON =
  /\b(?:cut from|builds? on|based on|on top of|stacked on|branch(?:ed)? from)\s+(?:the\s+)?(?:open\s+)?PR\s*#?(\d+)/gi;

/**
 * The first open PR a new ticket's body says it is cut from or builds on, with no line that makes it
 * wait: the line to add (`Depends on #N` when the PR carries a ticket of the repo, else `After PR N`).
 */
export function undeclaredPrDependency(
  body: string,
  repoId: string,
  prs: readonly WaitPr[],
): { pr: number; line: string } | null {
  const declaredPrs = afterPrs(body);
  const declaredIssues = dependsOn(body);
  for (const m of body.matchAll(BUILDS_ON)) {
    const n = Number(m[1]);
    const pr = prs.find((p) => p.number === n && p.state === "open");
    if (pr === undefined || declaredPrs.includes(n)) continue;
    const ticket = /^(.+)#(\d+)$/.exec(pr.ticket ?? "");
    const issue = pr.closingIssues?.[0] ?? (ticket?.[1] === repoId ? Number(ticket[2]) : null);
    if (issue !== null && declaredIssues.includes(issue)) continue;
    return { pr: n, line: issue === null ? `After PR ${n}` : `Depends on #${issue}` };
  }
  return null;
}
