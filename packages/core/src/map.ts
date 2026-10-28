import type { ReviewFinding } from "./review.ts";
import type { SeatState } from "./runtime.ts";
import type { ContextUsage, PrCheck } from "./types.ts";

/** Map paths are repo-relative; all times are Unix milliseconds. */
export type MapState = SeatState | "stalled";

export interface MapChange {
  file: string;
  add: number;
  rem: number;
  /** Churn must be labelled "edit churn"; only diff is the branch's real change. */
  source: "diff" | "churn";
}

/** Parsed runner output, never inferred from a tool's error or exit status. */
export type MapTests =
  | { runner: "vitest"; status: "passed" | "failed"; passed: number; failed: number }
  | { runner: null; status: "unknown" };

export interface MapReviewCounts {
  Critical: number;
  Important: number;
  Minor: number;
}

export interface MapCall {
  tool: string;
  detail: string;
  files: string[];
  since: number;
}

export interface MapBadges {
  questions: { id: number; from: string; to: string; ticket: number | null; since: number }[];
  /** Refused or failed in the last ten minutes; calls cut off by a stopped run are excluded. */
  failures: { at: number; tool: string; refused: boolean; why: string }[];
  /** Latest review of this ticket only; findings have no inferred "fixed" state. */
  review: { ticket: number; round: number; counts: MapReviewCounts; at: number } | null;
  tests: (MapTests & { at: number; editedSince: boolean }) | null;
  ci: { sha: string; checks: PrCheck[]; at: number } | null;
  /** `stopped`: parked because the operator stopped the run; waiting on nobody, so never stuck. */
  waiting: { kind: "test-lock" | "parked"; since: number; reason: string; stopped: boolean } | null;
}

export interface MapSeat {
  /** A crew seat id, or FLIGHT for its current turn on this repo. */
  seat: string;
  state: MapState;
  since: number;
  ticket: number | null;
  title: string | null;
  /**
   * Every branch whose unmerged changes are in `scope.modified` (the current run's first, then
   * runs set aside), which name the seat in conflicts and conflictsUnchecked.
   */
  branches: string[];
  /**
   * The ticket the seat's current run is on, when `ticket` is another: the ticket its changes are
   * on, while its current run has none yet. null otherwise.
   */
  nowTicket: number | null;
  /** The branches in `branches` whose changes are in `scope.modified`. */
  changedOn: string[];
  /** The ticket of each branch in `branches`, from the newest run on it, where it has one. */
  tickets: Record<string, number>;
  calls: MapCall[];
  /** Docked seats drop reads but retain unmerged modifications. */
  scope: { read: string[]; modified: MapChange[] };
  /**
   * The seat's last accesses, oldest first, a run of accesses to one file listed once at its
   * latest: its path on the map, kept for MAP_RECENT_MS after each call ends (its run's end, for a
   * call cut off). Name-only listings are left out. They never identify what a seat is thinking.
   */
  recent: { file: string; at: number }[];
  context: Pick<ContextUsage, "total" | "window"> | null;
  badges: MapBadges;
}

/** How long the hub keeps a seat's finished calls, and so its path, after they end. */
export const MAP_RECENT_MS = 15 * 60_000;
/** The most accesses a seat's `recent` lists (a run of accesses to one file counts once). */
export const MAP_RECENT_CAP = 48;
/**
 * Tools that only match names (Glob, LS): the files they list were never opened, so the map counts
 * them neither as read nor on a seat's path.
 */
export const MAP_NAME_ONLY_TOOLS: readonly string[] = ["Glob", "LS"];
export const namesOnly = (tool: string): boolean => MAP_NAME_ONLY_TOOLS.includes(tool);

/** Why a branch's conflicts went unchecked: its head isn't in the checkout, or the check failed. */
export const MAP_UNCHECKED_REASONS = ["head not fetched", "merge check failed"] as const;
export interface MapUnchecked {
  branch: string;
  reason: (typeof MAP_UNCHECKED_REASONS)[number];
}

/** GET /api/repos/:repoId/map, including every delta up to seq. */
export interface MapSnapshot {
  repoId: string;
  tree: { path: string; lines: number }[];
  imports: { from: string; to: string }[];
  seats: MapSeat[];
  findings: (ReviewFinding & { seat: string; ticket: number; round: number })[];
  /** Computed merge conflicts between open PR heads, never read/write overlap. */
  conflicts: { file: string; branches: [string, string]; shas: [string, string] }[];
  /** Open PR branches with a pair that went unchecked: unknown, never reported clean. */
  conflictsUnchecked: MapUnchecked[];
  seq: number;
}

/** Repo-scoped event: map frames. Refetch the snapshot on reconnect or a gap in seq. */
export type MapDelta = { seq: number } & (
  | {
      type: "call.start";
      seat: string;
      tool: string;
      detail: string;
      files: string[];
      /** Present for writes only: this call's written payload, never message usage. */
      writeTok?: number;
    }
  | {
      type: "call.end";
      seat: string;
      files: string[];
      /** This call's own result payload, approximately four characters per token. */
      resultTok: number;
      error: boolean;
      refused: boolean;
      why: string | null;
      tests: MapTests | null;
    }
  | { type: "edit"; seat: string; file: string; add: number; rem: number }
  | { type: "state"; seat: string; state: MapState; since: number }
  | { type: "message"; from: string; to: string; kind: string; ticket: number | null }
  | { type: "review"; seat: string; ticket: number; round: number; counts: MapReviewCounts }
  | { type: "diff"; seat: string; file: string; add: number; rem: number }
);
