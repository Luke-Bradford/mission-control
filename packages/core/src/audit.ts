import type { LoopKind } from "./runtime.ts";

/** A merged PR at or above this many changed lines (additions plus deletions) is a size outlier. */
export const AUDIT_PR_OUTLIER_LINES = 800;
/** A seat with this many guard refusals in one UTC day is a refusal spike. */
export const AUDIT_REFUSAL_SPIKE = 10;
/** A run costing at least this many times the range's median run cost is a spend outlier. */
export const AUDIT_SPEND_OUTLIER_FACTOR = 2;
/** The longest window either side of a prompt or model change that the before/after metrics span. */
export const AUDIT_CHANGE_WINDOW_MS = 7 * 86_400_000;

/** What ran a long runner: a crew seat's loop kind, or "observed" for an adopted loop's run. */
export type AuditRunKind = LoopKind | "observed";

export interface AuditPrSize {
  repoId: string;
  number: number;
  ticket: string | null;
  mergedAt: number;
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** One window's metrics around a prompt or model change; a null is a metric with nothing to measure. */
export interface AuditMetrics {
  merged: number;
  reviewFailRate: number | null;
  medianCostPerMergedTicket: number | null;
  reworkRounds: number;
}

export interface AuditChange {
  kind: "prompt" | "model";
  agentId: string;
  /** When the first run with the new value started. */
  at: number;
  /** The previous value, null when the agent's previous run recorded none. */
  from: string | null;
  to: string;
  /** The length of each of the two equal windows. */
  windowMs: number;
  before: AuditMetrics;
  after: AuditMetrics;
}

/** The `/api/audit` response for one range. */
export interface AuditView {
  range: { since: number; until: number };
  longRunners: {
    runId: string;
    agentId: string;
    ticket: string | null;
    startedAt: number;
    /** The three fields below are always set by the server; optional so web fixtures built before them type-check. */
    /** Null while the run is open. */
    endedAt?: number | null;
    /** Null when the run's agent is no longer configured. */
    kind?: AuditRunKind | null;
    /** False for observed-loop runs, watch runs, and open runs no seat holds (stale records). */
    actionable?: boolean;
    durationMs: number;
  }[];
  deathLoops: { runId: string; agentId: string | null; parks: number }[];
  reworkRounds: { runId: string; agentId: string | null; rounds: number; maxRound: number }[];
  refusalsByRule: { rule: string; count: number }[];
  /** Refusals per seat, run and rule, so the page can link to the Agent page and the run trace. */
  refusals: { agentId: string; runId: string | null; rule: string; count: number }[];
  refusalSpikes: { agentId: string; day: number; count: number }[];
  spendOutliers: { runId: string; agentId: string; ticket: string | null; costUsd: number }[];
  questions: { asked: number; answered: number; answerMs: number | null };
  costPerMergedTicket: { ticket: string; costUsd: number | null }[];
  modelPromptTimeline: {
    at: number;
    model: string | null;
    accountId: string | null;
    effort: string | null;
    promptHash: string | null;
  }[];
  prSizes: { prs: AuditPrSize[]; outliers: AuditPrSize[] };
  /** Long back-and-forth between two seats on one ticket. */
  chatter: { from: string; to: string; ticket: string; rounds: number }[];
  /** Checks that failed, then passed on the same head; kept for FLIGHT_SIGNAL_KEEP_MS only. */
  flakes: { key: string; count: number; lastAt: number }[];
  changes: AuditChange[];
  /** Empty, in its final shape, until SURGEON proposals are stored. */
  surgeonProposals: { id: string; at: number; summary: string }[];
}
