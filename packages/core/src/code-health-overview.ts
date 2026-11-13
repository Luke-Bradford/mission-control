/** The Audit page's first screen as one stored, page-shaped summary. The server builds it; the page only shows it. */
import type { CodeHealthRecommendation, CodeHealthWindow } from "./code-health.ts";

/** Bump when the stored shape changes, so an older stored summary is rebuilt rather than served. */
export const CODE_HEALTH_OVERVIEW_VERSION = 1;
/** The ranked rows on the first screen. */
export const CODE_HEALTH_OVERVIEW_ROWS_MAX = 10;
/** Files shown under "Where findings land". */
export const CODE_HEALTH_OVERVIEW_FILES_MAX = 10;
/** Recorded proposals shown under "What past recommendations achieved". */
export const CODE_HEALTH_OVERVIEW_PAST_MAX = 20;
/** A stored summary is rebuilt after this long even when no source changed, so the window edge keeps rolling. */
export const CODE_HEALTH_OVERVIEW_TTL_MS = 10 * 60_000;

export type CodeHealthFigureState =
  | "available"
  /** Some of the inputs are unknown, so the value covers only the known part. */
  | "partial"
  | "unknown"
  | "not-collected"
  | "not-available";

/** Every figure carries its own detail: what it counts, over what, against what, from where. */
export interface CodeHealthFigure {
  id: string;
  label: string;
  /** Null is unknown or undefined (no denominator), never zero. */
  value: number | null;
  unit: string;
  state: CodeHealthFigureState;
  window: { label: string; from: number; until: number };
  /** The same figure over the equal window before this one; null when there is nothing to compare. */
  comparison: { label: string; value: number | null; from: number; until: number } | null;
  /** The part counted, when the figure is a share. */
  numerator: number | null;
  denominator: number | null;
  source: string;
  coverage: string;
  /** Epoch ms of the newest stored input behind the figure; null when there is none. */
  updatedAt: number | null;
  note: string;
}

export interface CodeHealthMergedDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Merged that day with no hub review record: unreviewed, not "zero rounds". */
  noHubReview: number;
  round1: number;
  round2: number;
  round3Plus: number;
}

export interface CodeHealthFileLanding {
  path: string;
  /** Distinct findings (one per PR, file, category, summary and fix) in the window. */
  findings: number;
  /** Merged PRs that changed this exact path in the window. */
  touches: number;
  /** Findings per touch; value null when there were no touches. */
  ratio: CodeHealthFigure;
}

export interface CodeHealthPastItem {
  id: string;
  title: string;
  state: CodeHealthRecommendation["state"]["kind"];
  decidedAt: number;
  metric: string;
  baseline: number | null;
  /** From stored acceptance and re-measure records only. Null means no result has been recorded. */
  after: { at: number; current: number | null; change: string; note: string } | null;
  outcome: "worked" | "no-effect" | "worse" | "unchanged" | "unmeasured" | "waiting";
}

export interface CodeHealthOverview {
  version: number;
  repoId: string;
  window: CodeHealthWindow;
  generatedAt: number;
  /** The code-health source revision this summary was built from. */
  sourceRevision: string;
  /** Changes only when the content shown changes, not when it is merely rebuilt. */
  summaryRevision: string;
  verdict: { tone: "ok" | "warn" | "unknown"; text: string; figureIds: string[] };
  /** The ranked proposals, without evidence references; the code-health read serves the evidence. */
  rows: CodeHealthRecommendation[];
  figures: CodeHealthFigure[];
  outside: {
    state: "available" | "not-collected";
    items: { source: string; recordedAt: number; summary: string }[];
    note: string;
  };
  wasteAlarms: { state: "not-available"; note: string };
  build: {
    mergedPerDay: CodeHealthMergedDay[];
    merged: CodeHealthFigure;
    hubReview: CodeHealthFigure;
    rework: CodeHealthFigure;
    cost: CodeHealthFigure;
  };
  landing: { files: CodeHealthFileLanding[] };
  past: {
    funnel: { kind: string; count: number }[];
    measured: { improved: number; unchanged: number; worse: number; unmeasured: number };
    items: CodeHealthPastItem[];
    detail: CodeHealthFigure;
  };
}
