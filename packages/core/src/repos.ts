import { FLOW_BATCH, FLOW_LONG_TIMELINES, FLOW_TIMELINE_MAX_PAGES, PR_MAX_PAGES } from "./board.ts";
import { HUD_COLUMNS, type HudColumn, hudColumnOf } from "./hud.ts";
import type { GithubBudget, TicketState } from "./types.ts";

/** The state a ticket in each HUD column has. */
export const COLUMN_STATE: Record<HudColumn, TicketState> = {
  Backlog: "planned",
  Refinement: "planned",
  Ready: "planned",
  Blocked: "blocked",
  "In progress": "in progress",
  "In review": "review",
  "Ready for QA": "review",
  Done: "done",
};

/** The columns the hub moves a run's card to. */
export const MOVE_COLUMNS = [
  "In progress",
  "In review",
  "Blocked",
] as const satisfies readonly HudColumn[];
export type MoveColumn = (typeof MOVE_COLUMNS)[number];

/**
 * The Status option a card moved to `column` takes: the option named `column` (any case) whose
 * mapped state is the column's; else the first option with that state whose name is not another
 * column's; else null.
 */
export function optionForColumn(
  options: string[],
  map: Record<string, TicketState>,
  column: HudColumn,
): string | null {
  const key = (s: string) => s.trim().toLowerCase();
  const state = COLUMN_STATE[column];
  const named = options.find((o) => key(o) === key(column) && map[o] === state);
  const isColumnName = (o: string) => HUD_COLUMNS.some((c) => key(c) === key(o));
  if (named !== undefined) return named;
  return options.find((o) => map[o] === state && !isColumnName(o)) ?? null;
}

/** A first guess at a status map for a project's Status options; the operator edits it. */
export function proposeStatusMap(options: string[]): Record<string, TicketState> {
  const out: Record<string, TicketState> = {};
  for (const option of options) {
    const key = option.trim().toLowerCase();
    const column = HUD_COLUMNS.find((c) => c.toLowerCase() === key);
    if (column) out[option] = COLUMN_STATE[column];
    else if (/done|closed|shipped|complete/i.test(option)) out[option] = "done";
    else if (/review|qa/i.test(option)) out[option] = "review";
    else if (/progress|doing|active|wip/i.test(option)) out[option] = "in progress";
    else if (/block/i.test(option)) out[option] = "blocked";
    else out[option] = "planned";
  }
  return out;
}

/** The HUD column each status of an open issue lands in. */
export function statusColumns(
  statusMap: Record<string, TicketState>,
): { status: string; column: HudColumn }[] {
  return Object.entries(statusMap).map(([status, state]) => ({
    status,
    column: hudColumnOf({ status, state, closed: false }),
  }));
}

/** Columns no status reaches, in board order; Backlog is excluded (an issue with no Status lands there). */
export function missingColumns(statusMap: Record<string, TicketState>): HudColumn[] {
  const reached = new Set(statusColumns(statusMap).map((s) => s.column));
  return HUD_COLUMNS.filter((c) => c !== "Backlog" && !reached.has(c));
}

/** GitHub's GraphQL allowance per hour, in points (one point per simple request). */
export const GITHUB_POINTS_PER_HOUR = 5000;

/** Upper bounds, in requests per hour, of what polling one repo's board costs. */
export function githubBudget(i: {
  items: number;
  needsYouLabels: number;
  githubSeconds: number;
}): GithubBudget {
  // Board pages, three title-marker searches, one search per label, milestones, PR page 1.
  const perPoll = Math.ceil(i.items / 100) + 3 + i.needsYouLabels + 1 + 1;
  const boardPerHour = (3600 / i.githubSeconds) * perPoll;
  const sweepPerHour = PR_MAX_PAGES;
  // Two batched reads, plus the later timeline pages of the few long issues, one call each.
  const longIssues = Math.min(i.items, FLOW_LONG_TIMELINES);
  const flowPerHour =
    2 * Math.ceil(i.items / FLOW_BATCH) + longIssues * (FLOW_TIMELINE_MAX_PAGES - 1);
  return {
    boardPerHour,
    sweepPerHour,
    flowPerHour,
    totalPerHour: boardPerHour + sweepPerHour + flowPerHour,
  };
}
