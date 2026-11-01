/** Shared code-health definitions. Collection and mutations belong to the server. */
import type { FindingResolutionOutcome, StoredFinding } from "./review.ts";
export const CODE_HEALTH_WINDOWS = ["7d", "30d", "90d"] as const;
export type CodeHealthWindow = (typeof CODE_HEALTH_WINDOWS)[number];
export const CODE_HEALTH_TABS = ["overview", "review", "risk", "test"] as const;
export type CodeHealthTab = (typeof CODE_HEALTH_TABS)[number];
export const CODE_HEALTH_EVIDENCE_PAGE_MAX = 50;
export const CODE_HEALTH_RECOMMENDATIONS_MAX = 3;

export type CodeHealthCollectionState =
  | "available"
  | "empty"
  | "loading"
  | "error"
  | "stale"
  | "disconnected"
  | "not-collected";

/** Dates are epoch milliseconds. Coverage describes observations, never an invented full window. */
export interface CodeHealthCoverage {
  state: CodeHealthCollectionState;
  requestedWindow: CodeHealthWindow;
  from: number;
  until: number;
  observedFrom: number | null;
  observedUntil: number | null;
  collectedAt: number | null;
  analysedSha: string | null;
  source: string;
  complete: boolean;
  note: string;
}

export interface CodeHealthEvidenceRef {
  id: string;
  repoId: string;
  label: string;
  definition: string;
  coverage: CodeHealthCoverage;
}

export interface CodeHealthRate {
  numerator: number;
  denominator: number;
  /** Percent, not a fraction or percentage-point change. Null means unavailable. */
  percent: number | null;
}

export interface CodeHealthReviewRound {
  reviewId: string;
  repoId: string;
  pr: number;
  headSha: string;
  round: number;
  state: "reported" | "pending" | "failed";
}

/** The reader selects the eligible repo/window cohort before calling the pure aggregates. */
export interface CodeHealthFinding {
  findingId: string;
  repoId: string;
  pr: number;
  reviewId: string;
  headSha: string;
  file: string | null;
  category: string | null;
  /** Disposition and later resolution are independent in the source. */
  state: StoredFinding["state"];
  resolution: FindingResolutionOutcome | null;
  resolvedReviewId: number | null;
  carry:
    | { kind: "unknown" }
    | { kind: "new" }
    | { kind: "carried"; priorFindings: { reviewId: number; pos: number }[] };
}

export interface CodeHealthPrRef {
  repoId: string;
  pr: number;
}

export interface CodeHealthFileMeasure {
  path: string;
  lines: number | null;
  analysedSha: string | null;
  mergedPrTouches: number | null;
  additions: number | null;
  deletions: number | null;
  findings: number | null;
  incidence: CodeHealthRate | null;
  evidence: CodeHealthEvidenceRef[];
}

export interface CodeHealthSizeHistory {
  path: string;
  points: { at: number; sha: string; lines: number }[];
  comparable: boolean;
  evidence: CodeHealthEvidenceRef[];
}

export interface CodeHealthCoupling {
  left: string;
  right: string;
  sharedPrs: number;
  lessFrequentlyChangedFilePrs: number;
  sharePercent: number;
  excludedBroadPrThreshold: number;
  evidence: CodeHealthEvidenceRef[];
}

export type CodeHealthCiClassification =
  | "candidate"
  | "confirmed-flaky"
  | "consistently-failing"
  | "infrastructure";

/** An executed attempt is a passed/failed test, not a job-state observation. */
export interface CodeHealthTestAttempt {
  attemptId: string;
  testId: string;
  repoId: string;
  headSha: string;
  workflow: string;
  job: string;
  state: "passed" | "failed" | "skipped" | "cancelled" | "not-run";
  completedAt: number | null;
  duration: number | null;
  durationUnit: "ms" | "s" | null;
  environment: string | null;
}

export type CodeHealthRecommendationState =
  | { kind: "proposed" }
  | { kind: "accepted"; owner: string; reviewAt: number; linkedWork: string | null }
  | { kind: "dismissed"; reason: string }
  | { kind: "snoozed"; until: number }
  | { kind: "paid-off"; assessment: string; assessedAt: number; evidenceId: string }
  | { kind: "no-effect"; reason: string; assessedAt: number; evidenceId: string };

export interface CodeHealthRecommendation {
  id: string;
  repoId: string;
  rule: string;
  ruleVersion: number;
  evidenceFingerprint: string;
  observation: string;
  uncertainty: string;
  proposal: string;
  rankingReason: string;
  target: { metric: string; direction: "increase" | "decrease"; baseline: number | null };
  createdAt: number;
  updatedAt: number;
  state: CodeHealthRecommendationState;
  evidence: CodeHealthEvidenceRef[];
}

export interface CodeHealthReviewQuality {
  reviewedPrs: number;
  rounds: { round: 1 | 2 | 3 | 4; prs: number }[];
  rework: CodeHealthRate;
  threeOrMoreRounds: CodeHealthRate;
  categories: { category: string; findings: number }[];
  uncategorised: CodeHealthRate;
}

/** Each tab is a bounded read; the other tab payloads are not fetched with it. */
export type CodeHealthTabData =
  | {
      tab: "overview";
      recommendations: CodeHealthRecommendation[];
      review: CodeHealthReviewQuality;
    }
  | { tab: "review"; review: CodeHealthReviewQuality }
  | {
      tab: "risk";
      files: CodeHealthFileMeasure[];
      sizeHistory: CodeHealthSizeHistory[];
      coupling: CodeHealthCoupling[];
    }
  | {
      tab: "test";
      mixedJobCandidates: number | null;
      namedTestRate: CodeHealthRate | null;
      disruption: {
        id: string;
        label: string;
        classification: CodeHealthCiClassification;
        rate: CodeHealthRate | null;
        evidence: CodeHealthEvidenceRef[];
      }[];
      durations: {
        file: string;
        p50Ms: number;
        p95Ms: number;
        environment: string;
        samples: number;
        evidence: CodeHealthEvidenceRef[];
      }[];
      qaProposals: {
        id: string;
        testId: string;
        judgement: "stale" | "wrong" | "slow" | "flaky";
        reviewer: string;
        at: number;
        evidence: CodeHealthEvidenceRef[];
      }[];
    };

export interface CodeHealthView {
  repoId: string;
  window: CodeHealthWindow;
  generatedAt: number;
  coverage: CodeHealthCoverage[];
  evidence: CodeHealthEvidenceRef[];
  data: CodeHealthTabData;
}

/** Read-only tool arguments. The server validates the repo against the calling run. */
export const CODE_HEALTH_READ_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tab"],
  properties: {
    tab: { type: "string", enum: CODE_HEALTH_TABS },
    window: { type: "string", enum: CODE_HEALTH_WINDOWS, default: "30d" },
    repo: { type: "string", minLength: 1 },
    evidence: { type: "string", minLength: 1 },
    cursor: { type: "string", minLength: 1 },
  },
} as const;

/** Conservative triage defaults from the approved plan, not validated defect predictors. */
export const CODE_HEALTH_RULES = {
  version: 1,
  recurringCorrection: { windowDays: 30, findings: 3, distinctPrs: 2 },
  repeatedRounds: { reportedRounds: 3 },
  repeatedlyChangedLargeFile: { windowDays: 30, lines: 1000, mergedPrTouches: 5 },
  mixedCi: { requiresOrderedFailureThenSuccess: true, classification: "candidate" },
} as const;

/** Half-open rolling UTC window: from <= observation < until. */
export function codeHealthWindowBounds(window: CodeHealthWindow, until: number) {
  if (!CODE_HEALTH_WINDOWS.includes(window) || !Number.isSafeInteger(until) || until < 0)
    throw new Error("Invalid code-health window");
  const days = Number.parseInt(window, 10);
  return { from: until - days * 86_400_000, until };
}

function count(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid code-health count");
}

export function codeHealthRate(
  numerator: number,
  denominator: number,
  complete: boolean,
): CodeHealthRate {
  count(numerator);
  count(denominator);
  if (numerator > denominator) throw new Error("Code-health numerator exceeds denominator");
  return {
    numerator,
    denominator,
    percent: complete && denominator > 0 ? (numerator / denominator) * 100 : null,
  };
}

/** Repeated snapshots count once. Conflicting identities require collection repair. */
function unique<T>(
  rows: readonly T[],
  identity: (row: T) => string,
  fingerprint: (row: T) => string,
): T[] {
  const result = new Map<string, { fingerprint: string; row: T }>();
  for (const row of rows) {
    const key = identity(row);
    if (!key.trim()) throw new Error("Missing code-health observation identity");
    const stamp = fingerprint(row);
    const previous = result.get(key);
    if (previous && previous.fingerprint !== stamp)
      throw new Error("Conflicting code-health observation identity");
    result.set(key, { fingerprint: stamp, row });
  }
  return [...result.values()].map((entry) => entry.row);
}

/** The reader supplies the selected window's cohort; this helper never blends repo results. */
export function codeHealthReviewRounds(rows: readonly CodeHealthReviewRound[], repoId: string) {
  const reported = unique(
    rows.filter((row) => row.repoId === repoId && row.state === "reported"),
    (row) => row.reviewId,
    (row) => JSON.stringify([row.pr, row.headSha, row.round]),
  );
  const maximum = new Map<number, number>();
  for (const row of reported) {
    count(row.pr);
    count(row.round);
    if (row.pr === 0 || row.round === 0) throw new Error("Invalid reported review");
    maximum.set(row.pr, Math.max(maximum.get(row.pr) ?? 0, row.round));
  }
  const values = [...maximum.values()];
  return {
    reviewedPrs: values.length,
    rounds: ([1, 2, 3, 4] as const).map((round) => ({
      round,
      prs: values.filter((value) => (round === 4 ? value >= 4 : value === round)).length,
    })),
    rework: codeHealthRate(values.filter((value) => value >= 2).length, values.length, true),
    threeOrMoreRounds: codeHealthRate(
      values.filter((value) => value >= 3).length,
      values.length,
      true,
    ),
  };
}

function distinctFindings(rows: readonly CodeHealthFinding[], repoId: string) {
  return unique(
    rows.filter((row) => row.repoId === repoId),
    (row) => row.findingId,
    (row) =>
      JSON.stringify([
        row.pr,
        row.reviewId,
        row.headSha,
        row.file,
        row.category,
        row.state,
        row.resolution,
        row.resolvedReviewId,
        row.carry,
      ]),
  );
}

export function codeHealthFindingCategories(rows: readonly CodeHealthFinding[], repoId: string) {
  const findings = distinctFindings(rows, repoId);
  const categories = new Map<string, number>();
  let uncategorised = 0;
  for (const finding of findings) {
    const category = finding.category?.trim();
    if (!category) uncategorised++;
    else categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  return {
    categories: [...categories].map(([category, findings]) => ({ category, findings })),
    uncategorised: codeHealthRate(uncategorised, findings.length, true),
  };
}

/** Caller preselects finding parent reviews and changed-file memberships in the same cohort/window. */
export function codeHealthFileIncidence(input: {
  repoId: string;
  file: string;
  eligiblePrs: readonly CodeHealthPrRef[];
  changedPrs: readonly CodeHealthPrRef[];
  findings: readonly CodeHealthFinding[];
  changedFilesComplete: boolean;
}) {
  const eligible = new Set(
    input.eligiblePrs.filter((row) => row.repoId === input.repoId).map((row) => row.pr),
  );
  const changed = new Set(
    input.changedPrs
      .filter((row) => row.repoId === input.repoId && eligible.has(row.pr))
      .map((row) => row.pr),
  );
  const findings = distinctFindings(input.findings, input.repoId).filter(
    (row) => row.file === input.file && eligible.has(row.pr),
  );
  const findingPrs = new Set(findings.filter((row) => changed.has(row.pr)).map((row) => row.pr));
  return {
    findings: findings.length,
    outsideDiffFindings: input.changedFilesComplete
      ? findings.filter((row) => !changed.has(row.pr)).length
      : null,
    incidence: codeHealthRate(findingPrs.size, changed.size, input.changedFilesComplete),
  };
}

export function codeHealthTestRate(
  rows: readonly CodeHealthTestAttempt[],
  repoId: string,
  complete: boolean,
) {
  const attempts = unique(
    rows.filter((row) => row.repoId === repoId),
    (row) => {
      if (!row.attemptId.trim() || !row.testId.trim())
        throw new Error("Missing code-health test identity");
      return JSON.stringify([row.attemptId, row.testId]);
    },
    (row) => JSON.stringify([row.headSha, row.workflow, row.job, row.state, row.completedAt]),
  );
  const executed = attempts.filter((row) => row.state === "passed" || row.state === "failed");
  return codeHealthRate(
    executed.filter((row) => row.state === "failed").length,
    executed.length,
    complete,
  );
}

/** Unknown units or environment stay unknown; raw review-command values cannot become ms. */
export function codeHealthDurationMs(
  value: number | null,
  unit: "ms" | "s" | null,
  environment: string | null,
): number | null {
  if (value === null || unit === null || !environment?.trim()) return null;
  if (unit !== "ms" && unit !== "s") throw new Error("Unknown code-health duration unit");
  const ms = unit === "s" ? value * 1000 : value;
  if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid code-health duration");
  return ms;
}
