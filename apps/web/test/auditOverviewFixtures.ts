import type {
  CodeHealthFigure,
  CodeHealthOverview,
  CodeHealthRecommendation,
  CodeHealthWindow,
} from "@mc/core";
import { CODE_HEALTH_OVERVIEW_VERSION } from "@mc/core";

const DAY = 86_400_000;
export const OVERVIEW_REPO = "sample";

/** The approved prototype's eight rows (fictional wording), in rank order. */
const ROWS = [
  {
    rule: "collection",
    title: "Record every merged PR's review in the hub, including reviews run outside seats",
    observation:
      "Only 2 of 67 PRs merged since 1 Nov have a hub review, so every review figure stops at 31 Oct.",
    uncertainty:
      "Fresh-agent reviews by the controller leave no record here. This measures records, not whether a review happened.",
    metric: "Merged PRs with a hub review",
    unit: "%",
    current: 3,
    target: 95,
    tier: "flight",
    owner: "FLIGHT",
    review: [18, "Nov"],
  },
  {
    rule: "recurring-correction",
    title: "Move CI and the hub off Node 25, which left support on 1 June",
    observation:
      "Node 22, 24 and 26 got High-severity TLS and DNS fixes on 21 Oct. Node 25 did not.",
    uncertainty:
      "Which of the fixes the hub actually reaches is not proven. It serves HTTP and makes outbound fetches.",
    metric: "Runtime in support",
    unit: "",
    current: null,
    target: 1,
    tier: "operator",
    owner: "operator",
    review: [11, "Nov"],
  },
  {
    rule: "repeated-rounds",
    title: "Run both reviewers on the same 20 PRs before acting on the rework rise",
    observation: "Round 2 rate 58% → 74%. One reviewer's blocking findings 134 → 764.",
    uncertainty:
      "A stricter reviewer and worse code look the same here. A reviewer rule also landed on 30 Oct.",
    metric: "Findings both reviewers raise",
    unit: "findings",
    current: null,
    target: 20,
    tier: "flight",
    owner: "FLIGHT",
    review: [22, "Nov"],
  },
  {
    rule: "recurring-correction",
    title: "Each FLIGHT tool declares whether it writes; drop the hand-kept lists",
    observation: "flight/tools.ts: 118 findings in 85 PR touches, 1.4 per touch.",
    uncertainty: "New features land here, so some findings follow growth and not this design.",
    metric: "Findings a week, flight/tools.ts",
    unit: "findings",
    current: 57,
    target: 20,
    tier: "flight",
    owner: "FLIGHT",
    review: [25, "Nov"],
  },
  {
    rule: "recurring-correction",
    title: "Settle FLIGHT's wake reasons by id, not by matching words in decision text",
    observation: "flight/state.ts: 74 findings in 54 touches. PR 1219 took 7 in 3 rounds.",
    uncertainty: "Word matching explains PR 1219. Other findings concern holds and restarts.",
    metric: "Correctness a week, flight/state.ts",
    unit: "findings",
    current: 33,
    target: 10,
    tier: "flight",
    owner: "FLIGHT",
    review: [25, "Nov"],
  },
  {
    rule: "repeatedly-changed-large-file",
    title: "Stop adding generated evidence to main; keep it as CI artifacts",
    observation: "docs/evidence added 333,063 lines this week: 1,947 files.",
    uncertainty: "Reviewers do read some evidence in the PR. Artifacts expire.",
    metric: "Evidence lines added a week",
    unit: "lines",
    current: 333_000,
    target: 1000,
    tier: "flight",
    owner: "FLIGHT",
    review: [18, "Nov"],
  },
  {
    rule: "mixed-ci",
    title: "Write named test results in CI and import them",
    observation: "CI shows 68 mixed-outcome job groups. Nothing can name the tests.",
    uncertainty: "Mixed job results are candidates, not proven flaky tests.",
    metric: "Mixed job groups with a named test",
    unit: "%",
    current: 0,
    target: 80,
    tier: "operator",
    owner: "operator",
    review: [25, "Nov"],
  },
  {
    rule: "collection",
    title: "Find out why git-env refusals went from 1 to 152 in a week",
    observation: "The guard stops ordinary work if these are normal reads.",
    uncertainty: "Some refusals could be right: a seat reading outside its worktree.",
    metric: "git-env refusals a week",
    unit: "refusals",
    current: 152,
    target: 20,
    tier: "operator",
    owner: "operator",
    review: [18, "Nov"],
  },
] as const;

export const ROW_ID = (index: number) =>
  index < 3
    ? `chr_${"abc"[index]?.repeat(32)}`
    : `chr_${(index + 1).toString(16).padStart(32, "0")}`;

export function proposal(
  index: number,
  at: number,
  repo = OVERVIEW_REPO,
  over: Partial<CodeHealthRecommendation> = {},
): CodeHealthRecommendation {
  const base = ROWS[index % ROWS.length] as (typeof ROWS)[number];
  const copy = index >= ROWS.length ? ` (${Math.floor(index / ROWS.length) + 1})` : "";
  return {
    id: ROW_ID(index),
    repoId: repo,
    rule: base.rule,
    ruleVersion: 1,
    evidenceFingerprint: `fixture-${index}`,
    title: `${base.title}${copy}`,
    observation: base.observation,
    uncertainty: base.uncertainty,
    proposal: `${base.title}${copy}`,
    rankingReason: "Ranked by measured size, then risk.",
    measure: {
      current: base.current,
      unit: base.unit,
      window: "30d",
      sourceAt: at,
      coverage: "Stored review records.",
    },
    target: {
      metric: base.metric,
      direction: "decrease",
      baseline: base.current,
      value: base.target,
    },
    decision: { owner: base.owner, tier: base.tier },
    createdAt: at,
    updatedAt: at,
    state: { kind: "proposed" },
    evidence: [],
    ...over,
  };
}

function figure(
  id: string,
  label: string,
  value: number | null,
  unit: string,
  at: number,
  window: CodeHealthWindow,
  over: Partial<CodeHealthFigure> = {},
): CodeHealthFigure {
  const days = Number.parseInt(window, 10);
  return {
    id,
    label,
    value,
    unit,
    state: value === null ? "unknown" : "available",
    window: { label: window, from: at - days * DAY, until: at },
    comparison:
      value === null
        ? null
        : {
            label: `Previous ${window}`,
            value: value * 0.9,
            from: at - 2 * days * DAY,
            until: at - days * DAY,
          },
    numerator: null,
    denominator: null,
    source: "Stored merge records",
    coverage: "Merge records cover the whole window.",
    updatedAt: at,
    note: "Counted by the day each PR merged, in UTC.",
    ...over,
  };
}

export function overviewFixture(
  at: number,
  options: {
    repo?: string;
    window?: CodeHealthWindow;
    rows?: number;
    over?: Partial<CodeHealthOverview>;
  } = {},
): CodeHealthOverview {
  const repo = options.repo ?? OVERVIEW_REPO,
    window = options.window ?? "30d";
  const merged = figure("merged", "Merged PRs", 297, "merged PRs", at, window);
  const hubReview = figure(
    "hub-review",
    "Merged PRs with a hub review",
    63,
    "% of merged PRs",
    at,
    window,
    {
      numerator: 187,
      denominator: 297,
    },
  );
  const rework = figure(
    "rework",
    "Reviewed PRs reaching round 2",
    74,
    "% of reviewed PRs",
    at,
    window,
    {
      numerator: 138,
      denominator: 187,
    },
  );
  const cost = figure(
    "cost",
    "Median cost per merged PR",
    1.63,
    "USD, median of priced PRs",
    at,
    window,
    {
      state: "partial",
      numerator: 90,
      denominator: 120,
      coverage: "90 of 120 merged PRs with runs have every run's cost recorded.",
    },
  );
  const days = Array.from({ length: 14 }, (_, i) => ({
    day: new Date(at - (13 - i) * DAY).toISOString().slice(0, 10),
    noHubReview: i > 9 ? 20 : 4,
    round1: 6 + (i % 5),
    round2: 8 - (i % 4),
    round3Plus: i % 3,
  }));
  const files = Array.from({ length: 12 }, (_, i) => ({
    path: `apps/server/src/${i % 2 ? "flight" : "engine"}/very-long-module-name-${i}.ts`,
    findings: 118 - i * 7,
    touches: 85 - i * 3,
    ratio: figure(
      `landing:${i}`,
      `Findings per touch ${i}`,
      (118 - i * 7) / (85 - i * 3),
      "findings per touch",
      at,
      window,
    ),
  }));
  const rows = Array.from({ length: options.rows ?? 8 }, (_, i) => proposal(i, at, repo));
  return {
    version: CODE_HEALTH_OVERVIEW_VERSION,
    repoId: repo,
    window,
    generatedAt: at,
    sourceRevision: "rev-1",
    summaryRevision: `sum-${rows.length}-${window}`,
    verdict: {
      tone: "warn",
      text: "138 of 187 reviewed PRs needed a second round in the last 30d (74%, was 58%). 187 of 297 merged PRs have a hub review record.",
      figureIds: ["rework", "hub-review"],
    },
    rows,
    figures: [merged, hubReview, rework, cost],
    outside: {
      state: "not-collected",
      items: [],
      note: "Outside sources (new releases, advisories, vendor guides) are not collected yet, so none are listed rather than guessed.",
    },
    wasteAlarms: { state: "not-available", note: "Waste-alarm rows are not available yet." },
    build: { mergedPerDay: days, merged, hubReview, rework, cost },
    landing: { files },
    past: {
      funnel: [
        { kind: "proposed", count: 206 },
        { kind: "accepted", count: 2 },
        { kind: "dismissed", count: 1 },
        { kind: "paid-off", count: 1 },
      ],
      measured: { improved: 1, unchanged: 1, worse: 0, unmeasured: 0 },
      items: [
        {
          id: `chr_${"e".repeat(32)}`,
          title: "RETRO must record a category",
          state: "paid-off",
          decidedAt: at - 5 * DAY,
          metric: "Uncategorised findings",
          baseline: 100,
          after: { at: at - DAY, current: 0, change: "improved", note: "Re-measured." },
          outcome: "worked",
        },
        {
          id: `chr_${"f".repeat(32)}`,
          title: "Overview tests stop starving their neighbours",
          state: "accepted",
          decidedAt: at - 2 * DAY,
          metric: "CI mixed outcomes",
          baseline: null,
          after: null,
          outcome: "waiting",
        },
      ],
      detail: figure(
        "past",
        "What past recommendations achieved",
        2,
        "decided proposals shown",
        at,
        window,
      ),
    },
    ...options.over,
  };
}

/** The reads the Audit overview makes for the fixture repo, one per window. */
export function auditOverviewApi(at: number, repo = OVERVIEW_REPO): Record<string, unknown> {
  const api: Record<string, unknown> = {};
  for (const window of ["7d", "30d", "90d"] as const)
    api[`/api/code-health/overview?repo=${repo}&window=${window}`] = overviewFixture(at, {
      repo,
      window,
    });
  return api;
}
