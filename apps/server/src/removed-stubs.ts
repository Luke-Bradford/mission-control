/**
 * Empty answers for routes whose feature is removed but whose web page is not yet. The web cut
 * deletes the Audit code-health page and the Tokens tab; it then deletes these and their routes.
 */
import {
  CODE_HEALTH_OVERVIEW_VERSION,
  CODE_HEALTH_TABS,
  CODE_HEALTH_WINDOWS,
  type CodeHealthFigure,
  type CodeHealthOverview,
  type CodeHealthRate,
  type CodeHealthReviewQuality,
  type CodeHealthTabData,
  type CodeHealthView,
  type CodeHealthWindow,
  type TokenAuditView,
} from "@mc/core";

const REMOVED = "Code health was removed; this page goes in the web cut.";
const DAY_MS = 86_400_000;

const rate: CodeHealthRate = { numerator: 0, denominator: 0, percent: null };
const review: CodeHealthReviewQuality = {
  reviewedPrs: 0,
  rounds: [],
  rework: rate,
  threeOrMoreRounds: rate,
  categories: [],
  uncategorised: rate,
};

/** The window a query names; anything else reads as the default. */
export function removedWindow(raw: unknown): CodeHealthWindow {
  return CODE_HEALTH_WINDOWS.find((w) => w === raw) ?? "30d";
}

/** An empty tab for the requested tab name (overview when it is not a known one). */
export function removedCodeHealthView(
  repoId: string,
  window: CodeHealthWindow,
  tab: unknown,
  at: number,
): CodeHealthView {
  const name = CODE_HEALTH_TABS.find((t) => t === tab) ?? "overview";
  const data: CodeHealthTabData =
    name === "overview"
      ? { tab: "overview", recommendations: [], review }
      : name === "review"
        ? { tab: "review", review }
        : name === "risk"
          ? { tab: "risk", files: [], sizeHistory: [], coupling: [] }
          : {
              tab: "test",
              mixedJobCandidates: null,
              namedTestRate: null,
              disruption: [],
              durations: [],
              qaProposals: [],
            };
  return { repoId, window, generatedAt: at, coverage: [], evidence: [], data };
}

const figure = (id: string, window: CodeHealthWindow, at: number): CodeHealthFigure => {
  const from = at - Number.parseInt(window, 10) * DAY_MS;
  return {
    id,
    label: id,
    value: null,
    unit: "",
    state: "not-available",
    window: { label: window, from, until: at },
    comparison: null,
    numerator: null,
    denominator: null,
    source: "removed",
    coverage: REMOVED,
    updatedAt: null,
    note: REMOVED,
  };
};

export function removedCodeHealthOverview(
  repoId: string,
  window: CodeHealthWindow,
  at: number,
): CodeHealthOverview {
  return {
    version: CODE_HEALTH_OVERVIEW_VERSION,
    repoId,
    window,
    generatedAt: at,
    sourceRevision: "removed",
    summaryRevision: "removed",
    verdict: { tone: "unknown", text: REMOVED, figureIds: [] },
    rows: [],
    figures: [],
    outside: { state: "not-collected", items: [], note: REMOVED },
    wasteAlarms: { state: "available", note: REMOVED, rows: [] },
    build: {
      mergedPerDay: [],
      merged: figure("merged", window, at),
      hubReview: figure("hubReview", window, at),
      rework: figure("rework", window, at),
      cost: figure("cost", window, at),
    },
    landing: { files: [] },
    past: {
      funnel: [],
      measured: { improved: 0, unchanged: 0, worse: 0, unmeasured: 0 },
      items: [],
      detail: figure("past", window, at),
    },
  };
}

export function removedTokenAudit(days: number, hours: number | null, at: number): TokenAuditView {
  return {
    days,
    hours,
    basis: hours === null ? "runs" : "events",
    coverage: null,
    since: at - (hours === null ? days * DAY_MS : hours * 3_600_000),
    runs: 0,
    calls: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reread: 0,
    rewrites: 0,
    readAfterReportShare: null,
    byRole: [],
    bySource: [],
    byCommand: [],
    topRuns: [],
    hubSections: [],
    flightStart: null,
    controller: null,
  };
}
