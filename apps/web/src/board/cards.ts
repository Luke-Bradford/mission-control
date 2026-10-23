import {
  type AttentionItem,
  type BoardItem,
  type CrewRow,
  type HudColumn,
  hudColumnOf,
  OWNER_OPERATOR,
  type PrCheck,
  type PullRequestView,
  prYouAction,
  REVIEW_STATUS_CONTEXT,
  startOfLocalDay,
} from "@mc/core";
import { BUILD_LOOP_TEMPLATE, LOOP_PHASE_LABEL } from "../crew.ts";

const DAY = 86_400_000;

/** The tooltip on the "Status out of date" flag: what GitHub says and what the board's Status says. */
export const statusOutOfDateTitle = (item: Pick<BoardItem, "closed" | "status">): string =>
  `GitHub says ${item.closed ? "Closed" : "Open"}; the board's Status says ${item.status || "none"}`;

export const ticketRef = (i: Pick<BoardItem, "repoId" | "issueNumber">): string =>
  `${i.repoId}#${i.issueNumber}`;

/** P0 is 0, P1 is 1; no priority (or a label that is not `P<n>`) sorts last. */
export function priorityRank(p: string | null): number {
  const m = p === null ? null : /^P(\d+)$/.exec(p);
  return m?.[1] ? Number(m[1]) : 99;
}

/** Priority (P0 first, none last), then the most recently updated. */
export function sortCards(items: BoardItem[]): BoardItem[] {
  return [...items].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || b.updatedAt - a.updatedAt,
  );
}

/**
 * Whole local days from `ms` to `now` (0 for today and for the future). `todayStart` is
 * `startOfLocalDay(now, tz)`, worked out once per render by the caller (#26 A1); `tz` null (and
 * so `todayStart` null): 24 h days.
 */
export function daysAgo(
  ms: number,
  now: number,
  tz: string | null,
  todayStart: number | null,
): number {
  const days =
    tz === null || todayStart === null
      ? Math.floor((now - ms) / DAY)
      : Math.round((todayStart - startOfLocalDay(ms, tz)) / DAY);
  return Math.max(0, days);
}

/** Lower is better: open or merged over closed, code branches over other, over docs/chore. */
function prRank(pr: PullRequestView): [number, number] {
  const live = pr.state === "closed" ? 1 : 0;
  const b = pr.branch;
  const prefix = /^(fix|feat|feature)\//.test(b) ? 0 : /^(docs|chore)\//.test(b) ? 2 : 1;
  return [live, prefix];
}

/**
 * The PR a card shows. The loops open spec PRs (`docs/…`) and umbrella branches on the same
 * ticket; the code PR is the one a card should show.
 */
export function cardPr(item: BoardItem, prs: PullRequestView[]): PullRequestView | null {
  const ref = ticketRef(item);
  const mine = prs.filter((p) => p.ticket === ref);
  mine.sort((a, b) => {
    const [al, ap] = prRank(a);
    const [bl, bp] = prRank(b);
    return al - bl || ap - bp || b.updatedAt - a.updatedAt;
  });
  return mine[0] ?? null;
}

/** The agent whose run is still going on this ticket; a finished run never marks a card. */
export function cardAgent(item: BoardItem, crew: CrewRow[]): CrewRow | null {
  const ref = ticketRef(item);
  return crew.find((r) => r.run?.status === "running" && r.ticket === ref) ?? null;
}

/** An escalation or a waiting PR names this card, or the agent working it has something waiting on you. */
export function needsMe(item: BoardItem, items: AttentionItem[], crew: CrewRow[]): boolean {
  const ref = ticketRef(item);
  const mine = items.filter((a) => a.owner === OWNER_OPERATOR);
  if (mine.some((a) => a.ticket === ref)) return true;
  if (cardColumn(item) !== "In progress") return false;
  const agent = cardAgent(item, crew);
  return agent !== null && mine.some((a) => a.agentId === agent.id);
}

/** Merged when any PR on the ticket is merged (not only the one the card shows), else Closed. */
export function doneOutcome(item: BoardItem, prs: PullRequestView[]): "Merged" | "Closed" {
  const ref = ticketRef(item);
  return prs.some((p) => p.ticket === ref && p.state === "merged") ? "Merged" : "Closed";
}

/** The first blocker still open, else null. */
export function firstBlocker(item: BoardItem): string | null {
  return item.blockedBy.find((b) => !b.closed)?.ref ?? null;
}

/** Columns for work not yet started: an open blocker moves a card out of these into Blocked. */
const NOT_STARTED: readonly HudColumn[] = ["Backlog", "Refinement", "Ready"];

/** The column a card sits in: its Status's, except that a ticket not yet started with an open blocker is Blocked. */
export function cardColumn(item: BoardItem): HudColumn {
  const col = hudColumnOf(item);
  return NOT_STARTED.includes(col) && firstBlocker(item) !== null ? "Blocked" : col;
}

const HOUR = 3_600_000;

/** `1 hour`, `5 hours`, `1 day`, `9 days`: how long a PR has waited. */
export function waitingText(ms: number): string {
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? "" : "s"}`;
  return ms >= DAY ? n(Math.floor(ms / DAY), "day") : n(Math.floor(ms / HOUR), "hour");
}

/** What you must do to the PR the card shows (`prYouAction`), with how long it has waited. */
export function cardYouWait(
  item: BoardItem,
  prs: PullRequestView[],
  crew: CrewRow[],
  now: number,
): { action: string; waiting: string } | null {
  const pr = cardPr(item, prs);
  // Done is done: nothing on the card waits on you.
  if (!pr || cardColumn(item) === "Done") return null;
  const action = prYouAction(pr, cardAgent(item, crew) !== null, now);
  return action === null ? null : { action, waiting: waitingText(now - pr.updatedAt) };
}

/**
 * Contract-first (the server data ticket adds this to mc/core's CrewRow): a writer seat's queued
 * tickets, 1 the next it takes. Switch to the core type once that merges.
 */
export interface CardQueueItem {
  ref: string;
  issue: number;
  pos: number;
}
export type QueueRow = CrewRow & { queue?: CardQueueItem[] };

/** A seat named on a card: its call sign and config index (its colour). */
export interface CardSeat {
  id: string;
  index: number;
  hudState?: CrewRow["hudState"];
}

export const NOT_QUEUED = "Unassigned · FLIGHT will offer it to an agent";
export const NO_PR_YET = "No PR yet";
export const NO_REVIEWER = "No reviewer on it now";
export const NO_LOOP_STEP = "no template step";

/** `feature › implement · try 2 of 3`: the agent's template, step and try; the run number when it has no loop. */
export function cardStep(agent: CrewRow): string {
  const loop = agent.loop;
  if (!loop) return `${agent.run ? `run #${agent.run.seq}` : "run"} · ${NO_LOOP_STEP}`;
  const tpl = loop.profile ?? BUILD_LOOP_TEMPLATE;
  const node = loop.step ?? LOOP_PHASE_LABEL[loop.phase];
  const tries = loop.tries ? ` · try ${loop.tries.n} of ${loop.tries.max}` : "";
  return `${tpl} › ${node}${tries}`;
}

/** The seat a Ready card is queued for and its place in that queue; null when it is not queued. */
export function cardQueue(
  item: BoardItem,
  crew: readonly QueueRow[],
): (CardSeat & { pos: number }) | null {
  if (cardColumn(item) !== "Ready") return null;
  const ref = ticketRef(item);
  for (const row of crew) {
    const entry = row.queue?.find((q) => q.ref === ref);
    if (entry) return { id: row.id, index: row.index, pos: entry.pos };
  }
  return null;
}

/** The seat reviewing the card's PR (or the card's ticket); null when none is. */
export function cardReviewer(
  item: BoardItem,
  pr: PullRequestView | null,
  crew: readonly CrewRow[],
): CardSeat | null {
  const ref = ticketRef(item);
  const row = crew.find((r) => {
    const rv = r.reviewing;
    if (!rv) return false;
    return (pr && r.repoId === pr.repoId && rv.prNumber === pr.number) || rv.ref === ref;
  });
  return row ? { id: row.id, index: row.index, hudState: row.hudState } : null;
}

const CHECK_WORST: Record<PrCheck["state"], number> = { passing: 0, pending: 1, failing: 2 };

/** `check passing · e2e failing`: the PR's checks by name, worst state per name, without mc/review; null when none. */
export function checksText(checks: readonly PrCheck[] | undefined): string | null {
  const byName = new Map<string, PrCheck["state"]>();
  for (const c of checks ?? []) {
    if (c.name === REVIEW_STATUS_CONTEXT) continue;
    const seen = byName.get(c.name);
    if (seen === undefined || CHECK_WORST[c.state] > CHECK_WORST[seen]) byName.set(c.name, c.state);
  }
  if (byName.size === 0) return null;
  return [...byName].map(([name, state]) => `${name} ${state}`).join(" · ");
}
