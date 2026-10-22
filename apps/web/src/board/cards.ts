import {
  type AttentionItem,
  type BoardItem,
  type CrewRow,
  type HudColumn,
  hudColumnOf,
  type PullRequestView,
  prYouAction,
  startOfLocalDay,
} from "@mc/core";

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
  if (items.some((a) => a.ticket === ref)) return true;
  const agent = cardAgent(item, crew);
  return agent !== null && items.some((a) => a.agentId === agent.id);
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
