import type {
  CodeHealthFigure,
  CodeHealthOverview,
  CodeHealthRecommendation,
  CodeHealthWindow,
} from "@mc/core";

export const OVERVIEW_NOW = Date.UTC(2026, 10, 4, 19, 22);
const DAY = 86_400_000;

export function overviewRowId(n: number): string {
  return `chr_${String(n).padStart(32, "0")}`;
}

export function overviewRow(
  n: number,
  over: Partial<CodeHealthRecommendation> = {},
): CodeHealthRecommendation {
  return {
    id: overviewRowId(n),
    repoId: "sample",
    rule: n % 2 ? "repeated-rounds" : "recurring-correction",
    ruleVersion: 1,
    evidenceFingerprint: `fixture-${n}`,
    title: `Change number ${n}: settle the shared cause of repeated review rounds once`,
    observation: `Only ${n} of 67 merged PRs carry a hub review, so review figures stop early.`,
    uncertainty: `Uncertainty ${n}: this measures records, not whether a review happened.`,
    proposal: `Proposal ${n}: record every merged review in the hub`,
    rankingReason: "Blocks the evidence first, then measured size.",
    measure: {
      current: 3 + n,
      unit: "review rounds",
      window: "over recorded PR",
      sourceAt: OVERVIEW_NOW,
      coverage: "Merge records cover the whole window.",
    },
    target: {
      metric: "maximum reported review round for this PR",
      direction: "increase",
      baseline: null,
      value: 95,
      source: "policy",
    },
    decision:
      n % 3 === 0 ? { owner: "operator", tier: "operator" } : { owner: "FLIGHT", tier: "flight" },
    createdAt: OVERVIEW_NOW - DAY,
    updatedAt: OVERVIEW_NOW - 3600_000,
    state: { kind: "proposed" },
    evidence: [],
    ...over,
  };
}

function figure(
  over: Partial<CodeHealthFigure> & Pick<CodeHealthFigure, "id" | "label">,
): CodeHealthFigure {
  return {
    value: 12,
    unit: "merged PRs",
    state: "available",
    window: { label: "30d", from: OVERVIEW_NOW - 30 * DAY, until: OVERVIEW_NOW },
    comparison: {
      label: "Previous 30d",
      value: 10,
      from: OVERVIEW_NOW - 60 * DAY,
      until: OVERVIEW_NOW - 30 * DAY,
    },
    numerator: null,
    denominator: null,
    source: "Stored merge time",
    coverage: "Merge records cover the whole window.",
    updatedAt: OVERVIEW_NOW,
    note: "Counted by UTC day.",
    ...over,
  };
}

export function overviewFixture(
  options: {
    rows?: number;
    repo?: string;
    window?: CodeHealthWindow;
    generatedAt?: number;
    rowOver?: (n: number) => Partial<CodeHealthRecommendation>;
    outside?: number;
    files?: number;
    /** A 300-character file path, longer than the schema's usual ones. */
    longPath?: boolean;
    past?: number;
    tone?: "ok" | "warn" | "unknown";
    waste?: boolean;
  } = {},
): CodeHealthOverview {
  const repo = options.repo ?? "sample";
  const merged = figure({ id: "merged", label: "Merged PRs" });
  const hub = figure({
    id: "hub-review",
    label: "Merged PRs with a hub review",
    value: 31,
    unit: "% of merged PRs",
    comparison: { label: "Previous 30d", value: 63, from: 0, until: 1 },
    numerator: 4,
    denominator: 13,
  });
  const rework = figure({
    id: "rework",
    label: "Reviewed PRs reaching round 2",
    value: 74,
    unit: "% of reviewed PRs",
    comparison: { label: "Previous 30d", value: 58, from: 0, until: 1 },
  });
  const cost = figure({
    id: "cost",
    label: "Median cost per merged PR",
    value: null,
    unit: "USD, median of priced PRs",
    state: "unknown",
    comparison: null,
  });
  const touch = figure({
    id: "touch",
    label: "Findings per touch",
    value: 1.4,
    unit: "findings per touch",
    comparison: { label: "Previous 30d", value: 1.2, from: 0, until: 1 },
  });
  const detail = figure({
    id: "past",
    label: "What past recommendations achieved",
    value: options.past ?? 2,
    unit: "decided proposals shown",
    comparison: null,
  });
  return {
    version: 2,
    repoId: repo,
    window: options.window ?? "30d",
    generatedAt: options.generatedAt ?? OVERVIEW_NOW,
    sourceRevision: "rev-1",
    summaryRevision: "sum-1",
    verdict: {
      tone: options.tone ?? "warn",
      text: "Reviews almost stopped being recorded on 1 Nov, so the trend ends there.",
      figureIds: ["hub-review"],
    },
    rows: Array.from({ length: options.rows ?? 8 }, (_, i) => {
      const n = i + 1;
      return overviewRow(n, { repoId: repo, ...options.rowOver?.(n) });
    }),
    figures: [merged, hub, rework, cost, touch],
    outside: {
      state: options.outside === undefined ? "not-collected" : "available",
      items: Array.from({ length: options.outside ?? 0 }, (_, i) => ({
        source: `Node.js ${i}`,
        recordedAt: OVERVIEW_NOW - i * DAY,
        summary: `Outside item ${i}: Node 25 left support.`,
      })),
      note: "No outside source is collected yet.",
    },
    wasteAlarms: { state: "available", note: "", rows: [] },
    build: {
      mergedPerDay: Array.from({ length: 14 }, (_, i) => ({
        day: new Date(Date.UTC(2026, 9, 22 + i)).toISOString().slice(0, 10),
        noHubReview: 5 + i,
        round1: 3,
        round2: 2,
        round3Plus: i % 3,
      })),
      merged,
      hubReview: hub,
      rework,
      cost,
    },
    landing: {
      files: Array.from({ length: options.files ?? 3 }, (_, i) => ({
        path: `${options.longPath ? `${"deeply/nested/".repeat(20)}` : ""}apps/server/src/very/long/path/to/a/file-number-${i}.ts`,
        findings: 20 - i,
        touches: 10 + i,
        ratio: figure({
          id: `landing:${i}`,
          label: "Findings per touch",
          value: (20 - i) / (10 + i),
          unit: "findings per touch",
          comparison: null,
        }),
      })),
    },
    past: {
      funnel: [
        { kind: "proposed", count: 206 },
        { kind: "accepted", count: 1 },
        { kind: "dismissed", count: 2 },
      ],
      measured: { improved: 0, unchanged: 0, worse: 0, unmeasured: 1 },
      items: Array.from({ length: options.past ?? 2 }, (_, i) => ({
        id: `past-${i}`,
        title: `Past recommendation ${i}`,
        state: "accepted" as const,
        decidedAt: OVERVIEW_NOW - (i + 1) * DAY,
        metric: "Blocking per PR",
        baseline: 4,
        after:
          i === 0 ? { at: OVERVIEW_NOW, current: 2, change: "4 → 2", note: "Remeasured." } : null,
        outcome: i === 0 ? ("worked" as const) : ("waiting" as const),
      })),
      detail,
    },
  };
}
