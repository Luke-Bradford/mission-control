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
  /** The branches in `branches` whose changes are in `scope.modified`. */
  changedOn: string[];
  /** The ticket of each branch in `branches`, from the newest run on it, where it has one. */
  tickets: Record<string, number>;
  calls: MapCall[];
  /** Docked seats drop reads but retain unmerged modifications. */
  scope: { read: string[]; modified: MapChange[] };
  /** Recent accesses position an orb; they never identify what a seat is thinking about. */
  recent: { file: string; at: number }[];
  context: Pick<ContextUsage, "total" | "window"> | null;
  badges: MapBadges;
}

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
