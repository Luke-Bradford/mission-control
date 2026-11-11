/**
 * Waste alarms: the hub's own checks for spend that buys no progress. Each check is scoped to one
 * ticket, run or seat, never the whole crew. Every threshold lives here, once.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const WASTE_CHECKS = [
  "unchanged-rerun",
  "retry-loop",
  "review-rounds",
  "restart-storm",
  "cost-without-output",
  "coordination-overhead",
  "ticket-churn",
  "runs-per-ticket",
] as const;
export type WasteCheck = (typeof WASTE_CHECKS)[number];

/** What each check looks at, for the Audit panel's rows. */
export const WASTE_CHECK_TITLES: Record<WasteCheck, string> = {
  "unchanged-rerun": "Unchanged rerun",
  "retry-loop": "Retry loop",
  "review-rounds": "Review rounds",
  "restart-storm": "Restart storm",
  "cost-without-output": "Cost without output",
  "coordination-overhead": "Coordination overhead",
  "ticket-churn": "Ticket churn",
  "runs-per-ticket": "Runs per ticket",
};

export const WASTE_THRESHOLDS = Object.freeze({
  /** An agent that starts more than this many times in `restartStormWindowMs` is in a storm. */
  restartStormStarts: 6,
  restartStormWindowMs: HOUR_MS,
  /** A ticket with this many failed attempts, or a run with this many carry-on resumes and no report. */
  retryFailedAttempts: 2,
  retryResumes: 3,
  /** A change past this many review rounds stops its reviews. */
  reviewRounds: 2,
  /** A ticket without a merge that has cost this many times the median cost of its size. */
  costFactor: 3,
  /** Merged tickets of a size needed before its median means anything. */
  costMinSizeSamples: 3,
  /** A ticket with more than this many runs and no merge. */
  runsPerTicket: 3,
  /** FLIGHT spend passing the developers' over this window, once it is at least this many dollars. */
  coordinationWindowMs: DAY_MS,
  coordinationMinUsd: 10,
  /** Tickets opened in the window reach tickets closed (with at least this many opened). */
  churnWindowMs: DAY_MS,
  churnMinOpened: 5,
  /** An event alarm (a rerun refused) stays open this long, then closes. */
  eventOpenMs: DAY_MS,
});

/** The two windows the Audit panel shows. */
export const WASTE_WINDOWS = ["day", "week"] as const;
export type WasteWindow = (typeof WASTE_WINDOWS)[number];
export const WASTE_WINDOW_MS: Record<WasteWindow, number> = { day: DAY_MS, week: 7 * DAY_MS };

/** A title that says a ticket is a piece of another ticket's work. */
export const WASTE_SPLIT_TITLE = /\b(?:half|halves|slice|slices|follow-?\s?ups?|part\s+\d+)\b/i;

/** What a check does when it fires. */
export type WasteAction = "refuse" | "park" | "stop-reviews" | "stop-restarts" | "alarm";

export const WASTE_ACTIONS: Record<WasteCheck, WasteAction> = {
  "unchanged-rerun": "refuse",
  "retry-loop": "park",
  "review-rounds": "stop-reviews",
  "restart-storm": "stop-restarts",
  "cost-without-output": "alarm",
  "coordination-overhead": "alarm",
  "ticket-churn": "alarm",
  "runs-per-ticket": "alarm",
};

/** One waste alarm as the hub keeps it. */
export interface WasteAlarm {
  id: number;
  check: WasteCheck;
  /** What it is about: a ticket ref, a run id or a seat id. One open alarm per check and subject. */
  subject: string;
  repoId: string | null;
  /** The ticket it names, `repo#n`, when it is about one. */
  ticket: string | null;
  seatId: string | null;
  /** The run it is about (an unchanged rerun, review rounds), when it is about one. */
  runId: string | null;
  /** How far past its threshold the cause is; a worse level after a resolve is a new alarm. */
  level: number;
  evidence: string;
  openedAt: number;
  /** When the cause ended, or the alarm timed out. */
  closedAt: number | null;
  /** When FLIGHT or the operator closed the hold with a basis. */
  resolvedAt: number | null;
  basis: string | null;
}

/** What a scan finds, before it is stored. */
export interface WasteFinding {
  check: WasteCheck;
  subject: string;
  repoId: string | null;
  ticket: string | null;
  seatId: string | null;
  runId: string | null;
  level: number;
  evidence: string;
}

/** The refusal a rerun gets. */
export const unchangedRerunText = (command: string, sha: string): string =>
  `Not run: ${command} already ran on commit ${sha.slice(0, 7)} and nothing has changed since (no commit, no edited file). Its result is recorded. Change something first, or read that result.`;

/** The refusal a start of a parked ticket gets. */
export const wasteParkText = (ref: string, evidence: string): string =>
  `Not started: ${ref} is parked by a waste alarm. ${evidence} FLIGHT or the operator decides what happens next.`;

/** The refusal a start of an agent in a restart storm gets. */
export const wasteStormText = (call: string, evidence: string): string =>
  `Not started: ${call} is in a restart storm. ${evidence} Its restarts stop until the hour's count falls back, or the operator starts it.`;

/** The line a held review shows. */
export const wasteReviewText = (evidence: string): string =>
  `Reviews of this change are stopped by a waste alarm. ${evidence} FLIGHT decides: fix or park.`;

/** One check's row: its limit, how often it fired and whether a merge followed. */
export interface WasteCheckRow {
  check: WasteCheck;
  title: string;
  /** The limit in words, from WASTE_THRESHOLDS. */
  threshold: string;
  action: WasteAction;
  fired: number;
  /** Alarms of this check whose ticket merged after the alarm opened. */
  progressAfter: number;
  /** Alarms that name a ticket, so progress can be judged. */
  withTicket: number;
}

/** Spend over one window. A figure is null where no run recorded its cost, never zero. */
export interface WasteSpend {
  window: WasteWindow;
  since: number;
  merged: number;
  /** Cost of runs that recorded one, in USD. */
  costUsd: number | null;
  runs: number;
  runsWithCost: number;
  tokens: number;
  /** Cost per merged change; null with no merge or no recorded cost. */
  perMergeUsd: number | null;
  /** Tokens per merged change, for runs of every vendor; null with no merge. */
  perMergeTokens: number | null;
  /** Share of recorded cost spent on building (developer runs), 0 to 1; null with no recorded cost. */
  buildingShareUsd: number | null;
  /** The same share over tokens, which both vendors record. */
  buildingShareTokens: number | null;
  /** Each vendor's coverage, so a partial total says what it covers. */
  vendors: {
    vendor: string;
    runs: number;
    runsWithCost: number;
    costUsd: number | null;
    tokens: number;
  }[];
}

/** What GET /waste serves. */
export interface WasteReport {
  at: number;
  spend: WasteSpend[];
  alarms: WasteAlarm[];
  checks: WasteCheckRow[];
}

/** The threshold of each check in words. */
export const wasteThresholdText = (check: WasteCheck): string => {
  const t = WASTE_THRESHOLDS;
  switch (check) {
    case "unchanged-rerun":
      return "the same check again on the same commit, nothing changed";
    case "retry-loop":
      return `${t.retryFailedAttempts} failed attempts, or ${t.retryResumes} carry-on resumes without a report`;
    case "review-rounds":
      return `more than ${t.reviewRounds} review rounds`;
    case "restart-storm":
      return `more than ${t.restartStormStarts} starts in an hour`;
    case "cost-without-output":
      return `${t.costFactor}x the median cost of its size, no merge`;
    case "coordination-overhead":
      return "FLIGHT spend passing the developers' for a day";
    case "ticket-churn":
      return "tickets opened reach tickets closed in a day, a split ticket, or a parked ticket starting";
    case "runs-per-ticket":
      return `more than ${t.runsPerTicket} runs without a merge`;
  }
};
