import type { CodeHealthCoverage, CodeHealthRecommendation, CodeHealthView } from "@mc/core";
export function codeHealthBrowserApi(at = Date.now()) {
  const coverage: CodeHealthCoverage = {
    state: "available",
    requestedWindow: "30d",
    from: at - 30 * 86400000,
    until: at,
    observedFrom: at - 10 * 86400000,
    observedUntil: at,
    collectedAt: at,
    analysedSha: null,
    source: "reported reviews and findings",
    complete: false,
    note: "Observed cohort only; earlier periods are unobserved.",
  };
  const refs = [
    {
      id: "ch_review_fixture",
      repoId: "sample",
      label: "Reported review cohort",
      definition: "Distinct PRs with a reported review, grouped by maximum reported round.",
      coverage,
    },
    {
      id: "ch_finding_fixture",
      repoId: "sample",
      label: "Finding categories and resolutions",
      definition: "Distinct finding identities; dispositions and resolutions remain separate.",
      coverage,
    },
  ];
  const recommendations: CodeHealthRecommendation[] = [
    {
      id: `chr_${"a".repeat(32)}`,
      repoId: "sample",
      rule: "repeated-rounds",
      ruleVersion: 1,
      evidenceFingerprint: "fixture-rounds",
      observation:
        "A sample PR reached three reported review rounds in the observed 30-day cohort.",
      uncertainty: "Another review may follow. Rounds do not establish a production defect.",
      proposal: "Inspect planning and corrections before extending the same work.",
      rankingReason: "The conservative reported-round threshold was met.",
      target: { metric: "reported review rounds", direction: "decrease", baseline: 3 },
      createdAt: at,
      updatedAt: at,
      state: { kind: "proposed" },
      evidence: [refs[0]],
    },
    {
      id: `chr_${"b".repeat(32)}`,
      repoId: "sample",
      rule: "recurring-correction",
      ruleVersion: 1,
      evidenceFingerprint: "fixture-corrections",
      observation: "Four spec findings concern src/example.ts across two PRs within 30 days.",
      uncertainty: "Unknown carry lineage is retained; findings do not imply escaped defects.",
      proposal: "Inspect the shared cause and propose a narrow invariant or regression test.",
      rankingReason: "Distinct findings and PRs meet the conservative triage threshold.",
      target: {
        metric: "spec findings on src/example.ts per 30 days",
        direction: "decrease",
        baseline: 4,
      },
      createdAt: at,
      updatedAt: at,
      state: { kind: "proposed" },
      evidence: [refs[1]],
    },
    {
      id: `chr_${"c".repeat(32)}`,
      repoId: "sample",
      rule: "collection",
      ruleVersion: 1,
      evidenceFingerprint: "fixture-collection",
      observation: "Dated file touches and ordered per-test results have not been collected.",
      uncertainty: "Job-only mixed outcomes remain candidates; no named-test rate is inferred.",
      proposal: "Collect dated file changes and ordered test results before judging risk.",
      rankingReason: "Missing measurements require collection, not a negative repo judgement.",
      target: { metric: "missing measurement sources", direction: "decrease", baseline: null },
      createdAt: at,
      updatedAt: at,
      state: { kind: "proposed" },
      evidence: [],
    },
  ];
  const review = {
    reviewedPrs: 320,
    rounds: [
      { round: 1 as const, prs: 103 },
      { round: 2 as const, prs: 128 },
      { round: 3 as const, prs: 87 },
      { round: 4 as const, prs: 2 },
    ],
    rework: { numerator: 217, denominator: 320, percent: 67.8 },
    threeOrMoreRounds: { numerator: 89, denominator: 320, percent: 27.8 },
    categories: [
      { category: "correctness", findings: 523 },
      { category: "spec", findings: 384 },
      { category: "test-missing", findings: 195 },
      { category: "style", findings: 81 },
      { category: "docs", findings: 69 },
      { category: "test-wrong", findings: 60 },
      { category: "security", findings: 41 },
      { category: "scope", findings: 7 },
      { category: "test-stale", findings: 2 },
    ],
    uncategorised: { numerator: 915, denominator: 2277, percent: 40.2 },
  };
  const overview: CodeHealthView = {
    repoId: "sample",
    window: "30d",
    generatedAt: at,
    coverage: [
      coverage,
      {
        ...coverage,
        state: "not-collected",
        source: "named-test results",
        observedFrom: null,
        observedUntil: null,
        collectedAt: null,
        note: "No stable test IDs or ordered executed-attempt denominator.",
      },
    ],
    evidence: refs,
    data: { tab: "overview", recommendations, review },
  };
  const api: Record<string, unknown> = {
    "/api/config": {
      operator: { id: "operator", timezone: "UTC" },
      repos: [{ id: "sample", github: "example/sample" }],
    },
    "/api/operator/bootstrap": { token: "fictional-operator-token" },
    "/api/code-health/recommendations?repo=sample&cursor=0": {
      recommendations: [],
      nextCursor: null,
    },
  };
  for (const window of ["7d", "30d", "90d"])
    for (const tab of ["overview", "review"])
      api[`/api/code-health?repo=sample&window=${window}&tab=${tab}`] = {
        ...overview,
        window,
        data: tab === "overview" ? overview.data : { tab, review },
      };
  for (const ref of refs) {
    api[`/api/code-health/evidence/${ref.id}?repo=sample&cursor=0`] = {
      reference: ref,
      rows: Array.from({ length: 50 }, (_, i) => ({
        reviewId: i + 1,
        pr: 101 + i,
        round: (i % 3) + 1,
        file: "src/example.ts",
        category: "spec",
        state: "reported",
        sha: "deadbeef".repeat(5),
      })),
      nextCursor: "50",
      truncated: false,
    };
    api[`/api/code-health/evidence/${ref.id}?repo=sample&cursor=50`] = {
      reference: ref,
      rows: [{ reviewId: 51, pr: 151, round: 3, state: "reported" }],
      nextCursor: null,
      truncated: false,
    };
  }
  return api;
}
