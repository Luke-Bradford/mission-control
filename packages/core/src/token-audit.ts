import type { PromptSection } from "./prompt-cost.ts";

/** A call that writes more than this many tokens to the cache... */
export const TOKEN_REWRITE_MIN_WRITE = 20_000;
/** ...while reading less than this share of the previous call's context is a cache rewrite. */
export const TOKEN_REWRITE_READ_RATIO = 0.5;
/** Where a call's added context came from. */
export const TOKEN_SOURCE_START = "start of run";
export const TOKEN_SOURCE_HUB_LINE = "hub line";
export const TOKEN_SOURCE_OWN_OUTPUT = "own earlier output";
export const TOKEN_SOURCE_UNATTRIBUTED = "unattributed";

export const TOKEN_AUDIT_DAYS_MAX = 365;
export const TOKEN_AUDIT_DAYS_DEFAULT = 7;
export const TOKEN_AUDIT_TOP_RUNS = 10;

/** What was added to the context since the previous call, from one source. */
export interface TokenSourceAdd {
  /** A tool name, or one of the `TOKEN_SOURCE_*` names. */
  source: string;
  /** Bash only: the command's first word, or `pnpm <script>`. */
  command: string | null;
  tokens: number;
}

/** One model call of a run. */
export interface TokenCall {
  /** Context size: input + cache read + cache write. */
  context: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  added: TokenSourceAdd[];
}

export interface TokenCounts {
  /** Tokens added to the context. */
  added: number;
  /** Added tokens times the calls left in the run. */
  reread: number;
  events: number;
}

/** What one run's transcript says about where its tokens went. */
export interface RunTokenAudit {
  calls: number;
  peakContext: number;
  medianContext: number;
  /** Cache reads over the whole run. */
  cacheRead: number;
  cacheWrite: number;
  output: number;
  rewrites: number;
  rewriteTokens: number;
  /** Cache reads on calls after the first `report_evidence`; null when it never ran. */
  readAfterReport: number | null;
  bySource: Record<string, TokenCounts>;
  byCommand: Record<string, TokenCounts>;
}

export interface TokenAuditRole {
  role: string;
  runs: number;
  calls: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reread: number;
  rewrites: number;
  medianPeakContext: number;
}

/** The run that put most into a row, so the page can link the row. */
export interface TokenAuditRunRef {
  runId: string;
  agentId: string;
  ticket: string | null;
  /** What the run put into the row: re-read tokens, or the section's tokens, or its cost in USD. */
  value: number;
}

export interface TokenAuditNamed extends TokenCounts {
  name: string;
  share: number;
  /** Always sent by the hub; optional so page fixtures made before it still type. */
  topRun?: TokenAuditRunRef | null;
}

/** A figure the hub records, with the window and unit it is in; or one it does not, with why. */
export type TokenAuditFigure<T> =
  | { recorded: true; days: number; unit: string; value: T }
  | { recorded: false; reason: string };

/** A role's context budget: no role has its own yet, so each gets this many tokens per call. */
export const TOKEN_CONTEXT_BUDGET = 150_000;
/** The most runs listed over the budget. */
export const TOKEN_AUDIT_OVER_BUDGET_RUNS = 10;

export interface TokenAuditContextRole {
  role: string;
  calls: number;
  p90Context: number;
  budget: number;
}

export interface TokenAuditFlight {
  wakes: number;
  wakesWithNoDecision: number;
  /** Median and 90th percentile of the context FLIGHT had when it woke. */
  contextAtWake: TokenAuditFigure<{ median: number; p90: number; samples: number }>;
  sessions: number;
  sessionsPerDay: number;
  startCost: { usd: number; totalUsd: number; share: number };
}

export interface TokenAuditFigures {
  contextByRole: TokenAuditFigure<TokenAuditContextRole[]>;
  overBudget: TokenAuditFigure<{
    budget: number;
    count: number;
    runs: (TokenAuditRunRef & { role: string })[];
  }>;
  longPassingCommands: TokenAuditFigure<never>;
  repeatedPrompt: TokenAuditFigure<never>;
  rewriteWait: TokenAuditFigure<never>;
  reviewRunsPerTicket: TokenAuditFigure<{ ticket: string; runs: number; latestRunId: string }[]>;
  flight: TokenAuditFigure<TokenAuditFlight>;
  costPerMergedPr: TokenAuditFigure<{
    mergedPrs: number;
    byRole: { role: string; usd: number; perPr: number; topRun: TokenAuditRunRef | null }[];
  }>;
}

export interface TokenAuditRun {
  runId: string;
  agentId: string;
  /** Always sent by the hub (null for a run with no ticket); optional for older fixtures. */
  ticket?: string | null;
  role: string;
  calls: number;
  peakContext: number;
  medianContext: number;
  output: number;
  reread: number;
  rewrites: number;
  /** Share (0..1) of cache reads after the first `report_evidence`; null when it never ran. */
  readAfterReportShare: number | null;
  costUsd: number | null;
}

export interface TokenAuditController {
  sessions: number;
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** `GET /api/audit/tokens?days=N` */
export interface TokenAuditView {
  days: number;
  since: number;
  /** Runs read and stored in the window. */
  runs: number;
  calls: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reread: number;
  rewrites: number;
  /** Share (0..1) of all cache reads that came after a run's first `report_evidence`. */
  readAfterReportShare: number | null;
  byRole: TokenAuditRole[];
  bySource: TokenAuditNamed[];
  byCommand: TokenAuditNamed[];
  topRuns: TokenAuditRun[];
  /** What the hub itself sent, by prompt section (estimated tokens). */
  hubSections: { section: PromptSection; tokens: number; topRun?: TokenAuditRunRef | null }[];
  /** FLIGHT's cost of starting sessions over the window; null with no FLIGHT seat. */
  flightStart: { usd: number; totalUsd: number; share: number } | null;
  /** Usage of controller sessions on this repo; null while the config switch is off. */
  controller: TokenAuditController | null;
  /** The figures the Tokens tab lists beyond the totals above. Always sent by the hub; optional for older fixtures. */
  figures?: TokenAuditFigures;
}
