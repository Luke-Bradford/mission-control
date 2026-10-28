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
  waiting: { kind: "test-lock" | "parked"; since: number; reason: string } | null;
}

export interface MapSeat {
  /** A crew seat id, or FLIGHT for its current turn on this repo. */
  seat: string;
  state: MapState;
  since: number;
  ticket: number | null;
  title: string | null;
  calls: MapCall[];
  /** Docked seats drop reads but retain unmerged modifications. */
  scope: { read: string[]; modified: MapChange[] };
  /** Recent accesses position an orb; they never identify what a seat is thinking about. */
  recent: { file: string; at: number }[];
  context: Pick<ContextUsage, "total" | "window"> | null;
  badges: MapBadges;
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
  /** Open PR branches whose head the checkout hasn't fetched, so their pairs went unchecked. */
  conflictsUnchecked?: string[];
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
