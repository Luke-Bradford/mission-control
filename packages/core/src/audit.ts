import type { FindingCategory } from "./review.ts";
import type { LoopKind } from "./runtime.ts";

/** A merged PR at or above this many changed lines (additions plus deletions) is a size outlier. */
export const AUDIT_PR_OUTLIER_LINES = 800;
/** A seat with this many guard refusals in one UTC day is a refusal spike. */
export const AUDIT_REFUSAL_SPIKE = 10;
/** A run costing at least this many times the range's median run cost is a spend outlier. */
export const AUDIT_SPEND_OUTLIER_FACTOR = 2;
/** The longest window either side of a prompt or model change that the before/after metrics span. */
export const AUDIT_CHANGE_WINDOW_MS = 7 * 86_400_000;

/** Expected input + output tokens of a run whose size has too few recent runs to measure. */
export const AUDIT_EXPECTED_TOKENS_DEFAULT = 400_000;
/** How far back the per-size expected token use looks. */
export const AUDIT_BASELINE_DAYS = 14;
/** Fewest recent runs of a size before its own expected use replaces the default. */
export const AUDIT_BASELINE_MIN_RUNS = 5;
/** A size's expected token use is this many times the median of its recent runs. */
export const AUDIT_BASELINE_FACTOR = 1.5;
/** Review rounds, or blocking findings, from which a run's overuse is put down to rework. */
export const AUDIT_REWORK_ROUNDS = 4;
export const AUDIT_REWORK_BLOCKING = 10;
/** A cause needs at least this many blocking findings of its categories, and this share of all. */
export const AUDIT_CAUSE_MIN_FINDINGS = 3;
export const AUDIT_CAUSE_MIN_SHARE = 0.4;
/** Ticket sizes that are too wide on their own when they overrun with little rework. */
export const AUDIT_WIDE_SIZES: readonly string[] = ["L", "XL"];

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
  /**
   * Runs in range that passed their expected token use, each with why, and the causes repeated
   * across them (two or more runs with the same cause) with a prevention to propose. They are findings: no run is stopped for this.
   * The server always sets it; optional so web fixtures built before it type-check.
   */
  tokenOveruse?: {
    runs: AuditTokenOveruse[];
    groups: AuditOveruseGroup[];
    /** Expected input + output tokens per size, from the last `AUDIT_BASELINE_DAYS` days; `""` is no size. */
    expected: { size: string | null; tokens: number; measured: boolean }[];
  };
  /**
   * Reviewed PRs in range by how many review rounds they took, and the late findings (round 2 or
   * later, on a file unchanged since the previous review) per reviewer seat and model.
   * The server always sets it; optional so web fixtures built before it type-check.
   */
  reviewRounds?: {
    prs: { rounds: number; count: number }[];
    late: { seatId: string; model: string | null; findings: number; late: number }[];
  };
  /** Empty, in its final shape, until SURGEON proposals are stored. */
  surgeonProposals: { id: string; at: number; summary: string }[];
  /** Lists the server cut to AUDIT_LIST_CAP, by name, with how many each held; absent when none was cut. */
  capped?: Record<string, number>;
}

/** A list in the audit response holds at most this many rows (until the Audit page is redesigned). */
export const AUDIT_LIST_CAP = 50;

/** The audit with each list cut to AUDIT_LIST_CAP, and `capped` naming the lists it cut. */
export function capAudit(audit: AuditView): AuditView {
  const capped: Record<string, number> = {};
  const cut = <T>(name: string, list: T[]): T[] => {
    if (list.length <= AUDIT_LIST_CAP) return list;
    capped[name] = list.length;
    return list.slice(0, AUDIT_LIST_CAP);
  };
  const out: AuditView = {
    ...audit,
    longRunners: cut("longRunners", audit.longRunners),
    deathLoops: cut("deathLoops", audit.deathLoops),
    reworkRounds: cut("reworkRounds", audit.reworkRounds),
    refusalsByRule: cut("refusalsByRule", audit.refusalsByRule),
    refusals: cut("refusals", audit.refusals),
    refusalSpikes: cut("refusalSpikes", audit.refusalSpikes),
    spendOutliers: cut("spendOutliers", audit.spendOutliers),
    costPerMergedTicket: cut("costPerMergedTicket", audit.costPerMergedTicket),
    modelPromptTimeline: cut("modelPromptTimeline", audit.modelPromptTimeline),
    prSizes: {
      prs: cut("prSizes.prs", audit.prSizes.prs),
      outliers: cut("prSizes.outliers", audit.prSizes.outliers),
    },
    chatter: cut("chatter", audit.chatter),
    flakes: cut("flakes", audit.flakes),
    changes: cut("changes", audit.changes),
    surgeonProposals: cut("surgeonProposals", audit.surgeonProposals),
  };
  return Object.keys(capped).length === 0 ? audit : { ...out, capped };
}

export const AUDIT_OVERUSE_CAUSES = [
  "plan-gap",
  "flaky-test-loop",
  "rework-churn",
  "wide-ticket",
  "unexplained",
] as const;
export type AuditOveruseCause = (typeof AUDIT_OVERUSE_CAUSES)[number];

/** What would prevent a repeat: a lesson for the seats, a rule for plans, or a rule for splitting tickets. */
export interface AuditPrevention {
  kind: "lesson" | "plan-rule" | "split-rule";
  text: string;
}

/** What the run's reviews and transcript say about it, the input to `classifyOveruse`. */
export interface AuditOveruseFacts {
  size: string | null;
  reviewRounds: number;
  blocking: number;
  /** Blocking findings per category; `uncategorised` for those with none. */
  blockingByCategory: Partial<Record<FindingCategory | "uncategorised", number>>;
  turns: number | null;
}

/** One run that passed its expected token use. Raised by Audit; nothing stops the run. */
export interface AuditTokenOveruse extends AuditOveruseFacts {
  runId: string;
  agentId: string;
  ticket: string | null;
  startedAt: number;
  /** False while the run is open. */
  ended: boolean;
  /** Input + output tokens, the figure the budget counts. */
  tokens: number;
  /** Input tokens not served from cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** The size's expected input + output tokens. */
  expected: number;
  cause: AuditOveruseCause;
  prevention: AuditPrevention;
}

/** Runs that share a cause, with the prevention to propose for all of them. */
export interface AuditOveruseGroup {
  cause: AuditOveruseCause;
  runIds: string[];
  prevention: AuditPrevention;
}

/** Expected input + output tokens per ticket size. */
export interface TokenBaselines {
  /** Sizes with enough recent runs to measure; the key `""` is runs with no size. */
  bySize: ReadonlyMap<string, number>;
  expected(size: string | null): number;
}

/** The median of `sorted` (ascending, not empty). */
function medianOf(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Expected token use per size: `AUDIT_BASELINE_FACTOR` times the median of the given recent runs of that size, or
 * `AUDIT_EXPECTED_TOKENS_DEFAULT` for a size with fewer than `AUDIT_BASELINE_MIN_RUNS` of them.
 */
export function tokenBaselines(samples: { size: string | null; tokens: number }[]): TokenBaselines {
  const bySize = new Map<string, number[]>();
  for (const s of samples)
    bySize.set(s.size ?? "", [...(bySize.get(s.size ?? "") ?? []), s.tokens]);
  const measured = new Map<string, number>();
  for (const [size, tokens] of bySize) {
    if (tokens.length >= AUDIT_BASELINE_MIN_RUNS) {
      measured.set(
        size,
        Math.round(AUDIT_BASELINE_FACTOR * medianOf(tokens.sort((a, b) => a - b))),
      );
    }
  }
  return {
    bySize: measured,
    expected: (size) => measured.get(size ?? "") ?? AUDIT_EXPECTED_TOKENS_DEFAULT,
  };
}

/** The likeliest reason a run passed its expected token use, from what its reviews found. */
export function classifyOveruse(f: AuditOveruseFacts): AuditOveruseCause {
  const inCategories = (...categories: FindingCategory[]): boolean => {
    const n = categories.reduce((sum, c) => sum + (f.blockingByCategory[c] ?? 0), 0);
    return n >= AUDIT_CAUSE_MIN_FINDINGS && n >= f.blocking * AUDIT_CAUSE_MIN_SHARE;
  };
  if (inCategories("scope", "spec")) return "plan-gap";
  if (inCategories("test-wrong", "test-stale")) return "flaky-test-loop";
  if (f.reviewRounds >= AUDIT_REWORK_ROUNDS || f.blocking >= AUDIT_REWORK_BLOCKING) {
    return "rework-churn";
  }
  if (f.size !== null && AUDIT_WIDE_SIZES.includes(f.size)) return "wide-ticket";
  return "unexplained";
}

const PREVENTIONS: Record<AuditOveruseCause, AuditPrevention> = {
  "rework-churn": {
    kind: "lesson",
    text: "Run the repo's lint, typecheck and the tests the change touches before reporting, and fix every category of finding a review names across the whole change, not only the line it points at.",
  },
  "flaky-test-loop": {
    kind: "lesson",
    text: "When a test is wrong, stale or flaky, fix or quarantine it once with a note on the ticket rather than re-running it across review rounds.",
  },
  "plan-gap": {
    kind: "plan-rule",
    text: "A plan lists every file the change touches, including docs and callers, and the acceptance checks each one needs, before code starts.",
  },
  "wide-ticket": {
    kind: "split-rule",
    text: "Split a Size L or XL ticket into tickets of Size M or smaller before it is picked up.",
  },
  unexplained: {
    kind: "lesson",
    text: "Read the run's trace for what used the turns; there is not enough review data to name a cause.",
  },
};

/** The prevention to propose for a cause. */
export function overusePrevention(cause: AuditOveruseCause): AuditPrevention {
  return PREVENTIONS[cause];
}

/** Causes that repeat across at least two runs, the most runs first. */
export function groupOveruse(
  runs: { runId: string; cause: AuditOveruseCause }[],
): AuditOveruseGroup[] {
  const byCause = new Map<AuditOveruseCause, string[]>();
  for (const r of runs) byCause.set(r.cause, [...(byCause.get(r.cause) ?? []), r.runId]);
  return [...byCause]
    .filter(([, runIds]) => runIds.length >= 2)
    .map(([cause, runIds]) => ({ cause, runIds, prevention: overusePrevention(cause) }))
    .sort((a, b) => b.runIds.length - a.runIds.length);
}
