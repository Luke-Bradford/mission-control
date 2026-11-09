import type {
  ChainNode,
  DependencyChain,
  DependencyEdge,
  DependencyWait,
  DependencyWork,
} from "./dependencies-model.ts";

export type {
  ChainNode,
  DependencyChain,
  DependencyEdge,
  DependencyWait,
  DependencyWork,
} from "./dependencies-model.ts";

/**
 * What a ticket waits on, read one way for every gate: GitHub's blocked-by links, the `Depends on`
 * and `After PR` lines of its body, and a PR based on another open PR's branch. Pure: the server
 * hands it the stored board and PRs.
 */

import { statusOutOfDate } from "./hud.ts";
import { dependsOn } from "./repo-rules.ts";
import type { BoardItem, PullRequestView } from "./types.ts";

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

/**
 * Group the complete wait graph beneath its terminal work. Strongly connected components
 * make cycles explicit; a shared descendant appears once per root, with its other roots named.
 * This is a read model: it neither observes waits nor changes their stored start times.
 */
export function dependencyChains(input: {
  repoId: string;
  work: readonly DependencyWork[];
  edges: readonly DependencyEdge[];
  now: number;
}): DependencyChain[] {
  const work = new Map(input.work.map((w) => [w.ref, w]));
  const waits = new Map<string, DependencyEdge[]>();
  const children = new Map<string, DependencyEdge[]>();
  const unknown = (ref: string): DependencyWork => ({
    ref,
    title: null,
    state: "unknown",
    reason: "Work not read yet",
    owner: "—",
    seatId: null,
  });
  for (const edge of input.edges) {
    for (const ref of [edge.from, edge.to]) if (!work.has(ref)) work.set(ref, unknown(ref));
    const existing = waits.get(edge.from) ?? [];
    const same = existing.find((e) => e.to === edge.to);
    if (same) {
      // A hold and a body line can name the same wait. Keep its oldest real observation.
      if (edge.since !== null && (same.since === null || edge.since < same.since))
        same.since = edge.since;
      continue;
    }
    const copy = { ...edge };
    waits.set(edge.from, [...existing, copy]);
    children.set(edge.to, [...(children.get(edge.to) ?? []), copy]);
  }
  for (const edges of children.values()) edges.sort((a, b) => a.from.localeCompare(b.from));

  let next = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (ref: string) => {
    indices.set(ref, next);
    low.set(ref, next++);
    stack.push(ref);
    onStack.add(ref);
    for (const { to } of waits.get(ref) ?? []) {
      if (!indices.has(to)) {
        visit(to);
        low.set(ref, Math.min(low.get(ref) as number, low.get(to) as number));
      } else if (onStack.has(to)) {
        low.set(ref, Math.min(low.get(ref) as number, indices.get(to) as number));
      }
    }
    if (low.get(ref) !== indices.get(ref)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
    } while (member !== ref);
    components.push(component.sort());
  };
  for (const ref of [...work.keys()].sort()) if (!indices.has(ref)) visit(ref);
  const componentOf = new Map(components.flatMap((c, i) => c.map((ref) => [ref, i] as const)));
  const cyclic = new Set(
    components.flatMap((c, i) =>
      c.length > 1 || waits.get(c[0] as string)?.some((e) => e.to === c[0]) ? [i] : [],
    ),
  );
  const roots = components.flatMap((members, i) => {
    const terminal = members.every((ref) =>
      (waits.get(ref) ?? []).every((e) => componentOf.get(e.to) === i),
    );
    // Also expose a cycle with an external wait: it cannot be freed by that wait ending.
    return (terminal || cyclic.has(i)) && members.some((ref) => children.has(ref))
      ? [{ ref: members[0] as string, members, component: i }]
      : [];
  });
  const reaches = new Map<string, Set<string>>();
  for (const root of roots) {
    const seen = new Set<string>();
    const pending = [...root.members];
    while (pending.length) {
      const ref = pending.pop() as string;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const set = reaches.get(ref) ?? new Set<string>();
      set.add(root.ref);
      reaches.set(ref, set);
      for (const child of children.get(ref) ?? []) pending.push(child.from);
    }
  }
  const age = (since: number | null) =>
    since === null || !Number.isFinite(since) ? null : Math.max(0, input.now - since);
  return roots
    .map((root): DependencyChain => {
      const seen = new Set<string>();
      const durations: number[] = [];
      const cycleRefs = new Set<string>();
      const render = (ref: string, edge: DependencyEdge | null): ChainNode => {
        seen.add(ref);
        const component = componentOf.get(ref) as number;
        if (cyclic.has(component))
          for (const member of components[component] ?? []) cycleRefs.add(member);
        const incomingAge = age(edge?.since ?? null);
        if (incomingAge !== null) durations.push(incomingAge);
        const node: ChainNode = {
          ref,
          title: work.get(ref)?.title ?? null,
          edge: edge?.kind ?? null,
          waitedMs: incomingAge,
          alsoWaitsOn: [...(reaches.get(ref) ?? [])].filter((r) => r !== root.ref).sort(),
          children: [],
        };
        for (const child of children.get(ref) ?? [])
          if (!seen.has(child.from)) node.children.push(render(child.from, child));
        return node;
      };
      const tree = render(root.ref, null);
      // Include alternate paths and cycle back edges within this chain. A shared dependent's
      // older wait on another root must not make this root's chain look older.
      for (const ref of seen) {
        for (const edge of waits.get(ref) ?? []) {
          const waited = age(edge.since);
          if (seen.has(edge.to) && waited !== null) durations.push(waited);
        }
      }
      const fact = work.get(root.ref) as DependencyWork;
      const descendants = [...seen].filter((ref) => ref !== root.ref).sort();
      const frees = descendants.filter(
        (ref) =>
          !cyclic.has(root.component) &&
          (waits.get(ref) ?? []).every((edge) => edge.to === root.ref),
      );
      return {
        repoId: input.repoId,
        root: tree,
        state: cycleRefs.size ? "stuck" : fact.state,
        reason: cycleRefs.size
          ? `These tickets wait on each other: ${[...cycleRefs].sort().join(", ")}.`
          : fact.reason,
        owner: fact.owner,
        seatId: fact.seatId,
        longestWaitMs: durations.length ? Math.max(...durations) : null,
        frees,
        stillWaiting: descendants.filter((ref) => !frees.includes(ref)),
      };
    })
    .sort(compareDependencyChains);
}

/** Shared order for one repository or a combined response: longest known wait first. */
export function compareDependencyChains(a: DependencyChain, b: DependencyChain): number {
  return (
    Number(a.longestWaitMs === null) - Number(b.longestWaitMs === null) ||
    (b.longestWaitMs ?? 0) - (a.longestWaitMs ?? 0) ||
    Number(b.state === "stuck") - Number(a.state === "stuck") ||
    a.root.ref.localeCompare(b.root.ref)
  );
}
