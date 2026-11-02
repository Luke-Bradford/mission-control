import type { CodeHealthCoverage, CodeHealthEvidenceRef, CodeHealthView } from "@mc/core";
import { codeHealthBrowserApi } from "./codeHealthBrowserFixtures.ts";

/** Fictional measured fixtures. These never create historical QA records. */
export function codeRiskFixture(at = Date.now(), count = 6) {
  const coverage: CodeHealthCoverage = {
    state: "available",
    requestedWindow: "30d",
    from: at - 30 * 86400000,
    until: at,
    observedFrom: at - 20 * 86400000,
    observedUntil: at - 1000,
    collectedAt: at,
    analysedSha: "b".repeat(40),
    source: "dated file evidence",
    complete: true,
    note: "Fictional observed cohort; no claim of complete GitHub history.",
  };
  const ref: CodeHealthEvidenceRef = {
    id: "ch_file_fixture",
    repoId: "sample",
    label: "File snapshots, PRs and findings",
    definition: "Measured fictional file evidence at recorded SHAs.",
    coverage,
  };
  const paths = Array.from({ length: count }, (_, i) =>
    i === count - 1 ? "src/state.test.ts" : `src/domain/${i === 0 ? "state" : `worker-${i}`}.ts`,
  );
  const data: Extract<CodeHealthView["data"], { tab: "risk" }> = {
    tab: "risk",
    files: paths.map((path, i) => ({
      path,
      lines: i === 1 ? null : 1200 - i * 10,
      analysedSha: i === 1 ? null : coverage.analysedSha,
      mergedPrTouches: i === 1 ? null : Math.max(0, 15 - i),
      additions: i === 1 ? null : 100,
      deletions: i === 1 ? null : 40,
      findings: i === 1 ? null : i % 4,
      outsideDiffFindings: null,
      incidence: null,
      evidence: [ref],
    })),
    sizeHistory: paths
      .map((path, i) => ({
        path,
        comparable: i !== 2,
        points: [
          { at: at - 20 * 86400000, sha: "a".repeat(40), lines: 900 - i * 10 },
          { at: at - 1000, sha: "b".repeat(40), lines: 1200 - i * 10 },
        ],
        evidence: [ref],
      }))
      .filter((_, i) => i !== 1),
    coupling:
      paths.length < 3
        ? []
        : [
            {
              left: paths[0],
              right: paths[2],
              sharedPrs: 5,
              lessFrequentlyChangedFilePrs: 8,
              sharePercent: 62.5,
              excludedBroadPrThreshold: 25,
              evidence: [ref],
            },
          ],
  };
  const api = codeHealthBrowserApi(at);
  for (const window of ["7d", "30d", "90d"] as const)
    api[`/api/code-health?repo=sample&window=${window}&tab=risk`] = {
      repoId: "sample",
      window,
      generatedAt: at,
      data,
      coverage: [
        { ...coverage, requestedWindow: window, from: at - Number(window.slice(0, -1)) * 86400000 },
      ],
      evidence: [ref],
    } satisfies CodeHealthView;
  api["/api/code-health/evidence/ch_file_fixture?repo=sample&cursor=0"] = {
    reference: ref,
    rows: [{ file: paths[0], sha: "b".repeat(40), lines: 1200, pr: 101, category: "spec" }],
    nextCursor: null,
    truncated: false,
  };
  return { data, coverage: [coverage], ref, api };
}
