export { OWNERS, type Owner, STAGES, type Stage } from "./board-model.ts";

import type { BoardItem } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The collector stores done board items this long after their last update; older closes are unknown, not zero. */
export const BOARD_KEEP_DONE_DAYS = 30;
export const BOARD_KEEP_DONE_MS = BOARD_KEEP_DONE_DAYS * DAY_MS;
/** The default view's window, and the one the overview's done count uses. */
export const BOARD_DONE_DAYS = 7;
export const BOARD_DONE_MS = BOARD_DONE_DAYS * DAY_MS;
/** The done-window choices the board offers. */
export const DONE_RANGES = [7, 14, 30] as const;

/** Pull requests are kept this long after their last update, and a sweep reads at most this many pages. */
export const PR_KEEP_DAYS = 30;
export const PR_KEEP_MS = PR_KEEP_DAYS * DAY_MS;
export const PR_MAX_PAGES = 10;

/** The QA board's history (test-lock holds, CI runs, review findings) is kept at least this long. */
export const QA_RETENTION_DAYS = 90;

/** Aliased issue or PR lookups per flow query. */
export const FLOW_BATCH = 20;

/** Status events per timeline page, and the pages read per issue (more events are truncated). */
export const FLOW_TIMELINE_PAGE_SIZE = 100;
export const FLOW_TIMELINE_MAX_PAGES = 5;
/**
 * The Done issues of the last FLOW_DAYS the budget allows to have more than one page of status
 * events (nearly none do); an allowance, not a bound.
 */
export const FLOW_LONG_TIMELINES = 5;

/** Additive single-select fields on the GitHub Project; the existing Status field is never touched. */
export const STAGE_FIELD = "Stage";

export const SIZE_FIELD = "Size";

export const PRIORITY_FIELD = "Priority";
export const PRIORITIES = ["P0", "P1", "P2"] as const;

/** P0 is 0, P1 is 1; no priority (or a label that is not `P<n>`) sorts last. */
export function priorityRank(p: string | null): number {
  const m = p === null ? null : /^P(\d+)$/.exec(p);
  return m?.[1] ? Number(m[1]) : 99;
}

/** The project's built-in single-select field the board columns come from. */
export const STATUS_FIELD = "Status";

/** The ticket type labels the setup action creates (colours are hex without `#`). */
export const TYPE_LABELS: readonly { name: string; color: string }[] = [
  { name: "type:feature", color: "1d76db" },
  { name: "type:bug", color: "d73a4a" },
  { name: "type:chore", color: "c5def5" },
  { name: "type:test", color: "bfd4f2" },
  { name: "type:docs", color: "0075ca" },
  { name: "type:research", color: "5319e7" },
];

/** A `p0`-`p3` label stands in for a Priority field value. */
export const LABEL_PRIORITY = /^p([0-3])$/i;

export function labelPriority(labels: string[]): string | null {
  for (const l of labels) {
    const m = LABEL_PRIORITY.exec(l);
    if (m) return `P${m[1]}`;
  }
  return null;
}

export const OWNER_FIELD = "Owner";

export const BOARD_COLUMNS = ["needs detail", "ready", "in flight", "blocked", "done"] as const;
export type BoardColumnKey = (typeof BOARD_COLUMNS)[number];

/** A ticket with no Stage counts as Ready; only an explicit "Needs detail" puts it in that column. */
export function columnOf(item: Pick<BoardItem, "state" | "stage">): BoardColumnKey {
  switch (item.state) {
    case "planned":
      return item.stage === "Needs detail" ? "needs detail" : "ready";
    case "in progress":
    case "review":
      return "in flight";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
  }
}

/** The PRs a list returns: open ones, and ones that changed in the last this many days. */
export const PR_LIST_DAYS = 7;
/** `?days=` on a PR list reaches back at most this far. */
export const PR_LIST_DAYS_MAX = 3650;
