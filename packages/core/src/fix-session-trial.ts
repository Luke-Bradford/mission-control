/**
 * The fix-session trial (#1643): whether a developer run woken for a fix saves tokens in a fresh
 * CLI session with a bounded handoff, against resuming its own session, without more rework. The
 * arms, strata and assignment rule live here; the server applies them and reads the receipts.
 */

export type FixSessionArm = "continue" | "fresh";
export type FixTrialStratum = "small" | "medium" | "large";

/** Merged tickets per arm that end the trial. */
export const FIX_TRIAL_TARGET = 10;
/** An arm stops taking tickets at this many assigned, merged or not, so held ones cannot flood it. */
export const FIX_TRIAL_MAX_ASSIGNED = 15;

/** The size stratum of a ticket's Size label; null (no assignment) when there is none or it is unknown. */
export function fixTrialStratum(size: string | null): FixTrialStratum | null {
  switch (size?.trim().toUpperCase()) {
    case "XS":
    case "S":
      return "small";
    case "M":
      return "medium";
    case "L":
    case "XL":
      return "large";
    default:
      return null;
  }
}

export interface FixTrialEntry {
  ticket: string;
  stratum: FixTrialStratum;
  arm: FixSessionArm;
  merged: boolean;
}

/**
 * The arm for a run's first fix boundary, or null when both arms are full. A full arm (10 merged
 * or 15 assigned) takes no more; with one full, the other takes it; otherwise the arm with fewer
 * tickets assigned in the stratum, and on a tie an even issue number goes to fresh, an odd one to
 * continue.
 */
export function assignFixArm(
  entries: readonly FixTrialEntry[],
  stratum: FixTrialStratum,
  issue: number,
): FixSessionArm | null {
  const count = (arm: FixSessionArm, only?: FixTrialStratum, merged = false): number =>
    entries.filter(
      (e) => e.arm === arm && (only === undefined || e.stratum === only) && (!merged || e.merged),
    ).length;
  const full = (arm: FixSessionArm): boolean =>
    count(arm, undefined, true) >= FIX_TRIAL_TARGET || count(arm) >= FIX_TRIAL_MAX_ASSIGNED;
  const freshFull = full("fresh");
  const continueFull = full("continue");
  if (freshFull && continueFull) return null;
  if (freshFull) return "continue";
  if (continueFull) return "fresh";
  const fresh = count("fresh", stratum);
  const kept = count("continue", stratum);
  if (fresh !== kept) return fresh < kept ? "fresh" : "continue";
  return issue % 2 === 0 ? "fresh" : "continue";
}

export const fixArmEventText = (ticket: string, arm: FixSessionArm, stratum: FixTrialStratum) =>
  `fix-session trial: ${ticket} is in the ${arm} arm (${stratum})`;
export const freshWokenEventText = (call: string) =>
  `back to ${call} for rework in a fresh session`;
export const freshFallbackEventText = (call: string, why: string) =>
  `fresh session could not start; ${call} resumed its session instead: ${why}`;

export type FixTrialStatus = "merged" | "open" | "held" | "ended-unmerged";

/** Token figures of one run's audit, or sums and medians of them. */
export interface FixTrialTokens {
  calls: number;
  peakContext: number;
  medianContext: number;
  /** The context of the first call of the run's first fresh session; null with none. */
  fixStartContext: number | null;
  cacheRead: number;
  readAfterReport: number | null;
  readAfterReportShare: number | null;
  cacheWrite: number;
  output: number;
  rewrites: number;
  reread: number;
  costUsd: number | null;
}

export interface FixTrialRun {
  runId: string;
  ticket: string;
  agentId: string;
  /** null when the ticket's Size was removed after the assignment. */
  stratum: FixTrialStratum | null;
  size: string | null;
  arm: FixSessionArm;
  status: FixTrialStatus;
  /** Why a `held` run is held, or how an `ended-unmerged` one ended; null otherwise. */
  reason: string | null;
  fixWakes: number;
  freshSessions: number;
  fallbacks: number;
  ciFailures: number;
  reviewRounds: number;
  blockingRounds: number;
  /** null while the run's audit is not stored yet. */
  tokens: FixTrialTokens | null;
}

/** The figures an arm is compared on; a median or a total over its merged runs. */
export interface FixTrialFigures {
  runs: number;
  ciFailures: number;
  reviewRounds: number;
  blockingRounds: number;
  fixWakes: number;
  calls: number;
  peakContext: number;
  medianContext: number;
  fixStartContext: number;
  cacheRead: number;
  readAfterReport: number;
  cacheWrite: number;
  output: number;
  rewrites: number;
  reread: number;
  costUsd: number;
}

export interface FixTrialIncomplete {
  runId: string;
  ticket: string;
  status: FixTrialStatus;
  reason: string | null;
}

export interface FixTrialArm {
  assigned: number;
  merged: number;
  /** Every run of the arm that is not merged, named with why. */
  incomplete: FixTrialIncomplete[];
  /** Medians over the arm's merged runs. */
  median: FixTrialFigures;
  /** Sums over the arm's merged runs. */
  total: FixTrialFigures;
}

/** `GET /api/audit/fix-sessions` */
export interface FixTrialView {
  enabled: boolean;
  target: number;
  maxAssigned: number;
  runs: FixTrialRun[];
  arms: Record<FixSessionArm, FixTrialArm>;
}
