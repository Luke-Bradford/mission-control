import type { CodeHealthCoverage, CodeHealthEvidenceRef, CodeHealthView } from "@mc/core";
import { codeHealthBrowserApi } from "./codeHealthBrowserFixtures.ts";

/** Fictional imported results. Not a reconstruction of a real repo's test history. */
export function testHealthFixture(at = Date.UTC(2026, 10, 2, 12), count = 4) {
  const failed = Array.from({ length: count }, (_, i) => 4 - (i % 4)).reduce((a, b) => a + b, 0);
  const executed = Array.from({ length: count }, (_, i) => (i % 4 === 2 ? 2 : 5)).reduce(
    (a, b) => a + b,
    0,
  );
  const base: CodeHealthCoverage = {
    state: count ? "available" : "not-collected",
    requestedWindow: "30d",
    from: at - 30 * 86400000,
    until: at,
    observedFrom: count ? at - 86400000 : null,
    observedUntil: count ? at : null,
    collectedAt: count ? at : null,
    analysedSha: "a".repeat(40),
    source: "CI job observations",
    complete: false,
    note: count
      ? "120 polled job-state observations. These are repeated snapshots, not test attempts."
      : "Job observations are not collected.",
  };
  const coverage = [
    base,
    {
      ...base,
      source: "imported named-test attempts",
      complete: count > 0,
      note: count
        ? `${count} authenticated imported reports: ${executed} executed attempts, 3 skipped/cancelled/not-run entries excluded. Declared observed-report counts are complete; this is not complete GitHub history. Retry order uses explicit metadata.`
        : "Stable test IDs and executed-attempt history are not collected.",
    },
    {
      ...base,
      source: "documented test durations",
      note: "Nearest-rank p50/p95 from documented milliseconds, stable test/file/environment. 8 legacy command values have unknown units and are excluded.",
    },
    {
      ...base,
      source: "evidence-backed test QA proposals",
      note: "Original reviewer findings with code/spec evidence; classification actor is separate. Age alone is not evidence.",
    },
  ];
  const reference = (id: string, title: string, source: number): CodeHealthEvidenceRef => ({
    id: `ch_test_${id}`,
    repoId: "sample",
    label: title,
    definition:
      "Fictional exact-head evidence. Explicit order is not inferred from polling or array position.",
    coverage: coverage[source],
  });
  const ci = reference("ci", "CI job observations", 0),
    attempts = reference("attempts", "Imported named-test attempts", 1),
    reports = reference("reports", "Imported report provenance", 1),
    raw = reference("raw", "Unnormalised command evidence", 2),
    qa = reference("qa", "Test QA proposal evidence", 3),
    linkedQa = reference("qa_linked", "Linked QA code/spec evidence", 3),
    ordered = reference("ordered", "Ordered test-attempt evidence", 1),
    samples = reference("samples", "Documented duration samples", 2);
  const scoped = (ref: CodeHealthEvidenceRef, index: number): CodeHealthEvidenceRef =>
    index
      ? {
          ...ref,
          id: `${ref.id}_${index}`,
          definition: `${ref.definition} Scoped to test-${index} at ${"a".repeat(40)}.`,
        }
      : ref;
  const data: Extract<CodeHealthView["data"], { tab: "test" }> = {
    tab: "test",
    mixedJobCandidates: count ? 3 : null,
    namedTestRate: count
      ? {
          numerator: failed,
          denominator: executed,
          percent: Math.round((1000 * failed) / executed) / 10,
        }
      : null,
    disruption: Array.from({ length: count }, (_, i) => ({
      id: `group-${i}`,
      testId: `test-${i}`,
      headSha: "a".repeat(40),
      ordered: i !== 0,
      label: `tests/account-${i}.test.ts › account ${i} › preserves saved changes`,
      classification: (
        ["candidate", "confirmed-flaky", "consistently-failing", "infrastructure"] as const
      )[i % 4],
      rate: {
        numerator: 4 - (i % 4),
        denominator: i % 4 === 2 ? 2 : 5,
        percent: i % 4 === 2 ? 100 : 20 * (4 - (i % 4)),
      },
      evidence: [scoped(ordered, i)],
    })),
    durations: Array.from({ length: count ? Math.min(count, 50) : 0 }, (_, i) => ({
      testId: `test-${i}`,
      label: `account ${i} › saves a draft`,
      file: `tests/account-${i}.test.ts`,
      p50Ms: i % 4 === 2 ? 60 : 120,
      p95Ms: 240,
      environment: i % 2 ? "Linux · Node 25" : "macOS · Node 25",
      samples: i % 4 === 2 ? 2 : 5,
      evidence: [scoped(samples, i)],
    })),
    qaProposals: Array.from({ length: count ? Math.min(count, 50) : 0 }, (_, i) => ({
      id: `qa-${i}`,
      testId: `test-${i}`,
      judgement: (["stale", "flaky", "wrong", "slow"] as const)[i % 4],
      reviewer: `reviewer-${i}`,
      recordedBy: "operator-fixture",
      at,
      file: `tests/account-${i}.test.ts`,
      headSha: "a".repeat(40),
      evidence: [scoped(linkedQa, i)],
    })),
    omitted: { disruption: 0, durations: 0, qaProposals: 0 },
  };
  const evidence = [ci, attempts, reports, raw, qa],
    view: CodeHealthView = {
      repoId: "sample",
      window: "30d",
      generatedAt: at,
      coverage,
      evidence,
      data,
    },
    api = codeHealthBrowserApi(at);
  for (const window of ["7d", "30d", "90d"] as const) {
    api[`/api/code-health?repo=sample&window=${window}&tab=test`] = {
      ...view,
      window,
      coverage: coverage.map((row) => ({
        ...row,
        requestedWindow: window,
        from: at - Number.parseInt(window, 10) * 86400000,
      })),
    };
  }
  const pages = (ref: CodeHealthEvidenceRef, rows: Record<string, unknown>[]) => {
    for (let cursor = 0; cursor < Math.max(1, rows.length); cursor += 50)
      api[`/api/code-health/evidence/${ref.id}?repo=sample&cursor=${cursor}`] = {
        reference: ref,
        rows: rows.slice(cursor, cursor + 50),
        nextCursor: cursor + 50 < rows.length ? String(cursor + 50) : null,
        truncated: false,
      };
  };
  const allAttempts: Record<string, unknown>[] = [],
    allQa: Record<string, unknown>[] = [];
  for (let group = 0; group < count; group++) {
    const n = group % 4 === 2 ? 2 : 5,
      failures = 4 - (group % 4);
    const rows = Array.from({ length: n }, (_, i) => ({
      attemptId: `attempt-${group}-${i}`,
      name: data.disruption[group].label,
      testId: `test-${group}`,
      state: i < failures ? "failed" : "passed",
      headSha: "a".repeat(40),
      file: `tests/account-${group}.test.ts`,
      workflow: "checks",
      workflowRun: "1234",
      job: "web",
      jobRun: "5678",
      runAttempt: 1,
      executionOrder: group === 0 && i === 0 ? null : i,
      executionOrderStatus: group === 0 && i === 0 ? "missing" : "explicit",
      environment: group % 2 ? "Linux · Node 25" : "macOS · Node 25",
      completedAt: at - 60000 + i * 1000,
      durationMs: n === 2 ? (i ? 240 : 60) : [60, 120, 120, 180, 240][i],
      cause: group % 4 === 3 && i < failures ? "infrastructure" : null,
      causeEvidence:
        group % 4 === 3 && i < failures ? "Runner disconnected before the test completed." : null,
    }));
    const proposal = {
      id: `qa-${group}`,
      testId: `test-${group}`,
      headSha: "a".repeat(40),
      reviewer: `reviewer-${group}`,
      actor: "operator-fixture",
      file: `tests/account-${group}.test.ts`,
      line: 12,
      summary: "The assertion needs investigation against the saved-draft contract.",
      scenario: "Save a draft and reopen it.",
      specEvidence: "docs/drafts.md: retained drafts must reopen unchanged.",
      judgement: data.qaProposals[group].judgement,
      reviewId: 42 + group,
    };
    allAttempts.push(...rows);
    allQa.push(proposal);
    pages(scoped(ordered, group), rows);
    pages(scoped(samples, group), rows);
    pages(scoped(linkedQa, group), [proposal]);
  }
  // Preserve explicit excluded states alongside executed attempts in the imported-source drawer.
  const excluded = count
    ? ["skipped", "cancelled", "not-run"].map((state, i) => ({
        attemptId: `excluded-${i}`,
        testId: "test-0",
        state,
        headSha: "a".repeat(40),
        executionOrderStatus: "missing",
      }))
    : [];
  pages(attempts, [...allAttempts, ...excluded]);
  pages(qa, allQa);
  pages(
    reports,
    data.disruption.map((row, i) => ({
      reportId: `report-${i}`,
      headSha: row.headSha,
      workflow: "checks",
      workflowRun: "1234",
      job: "web",
      jobRun: "5678",
      runAttempt: 1,
      expectedAttempts: (row.rate?.denominator ?? 0) + (i === 0 ? 3 : 0),
      sourceFormat: "fixture",
      completedAt: at,
      actor: "operator-fixture",
    })),
  );
  pages(
    ci,
    count
      ? Array.from({ length: 120 }, (_, i) => ({
          observationId: i,
          sha: "a".repeat(40),
          job: `job-${i % 3}`,
          state: i % 2 ? "success" : "failure",
          at: at - 120000 + i * 1000,
        }))
      : [],
  );
  pages(
    raw,
    count
      ? Array.from({ length: 8 }, (_, i) => ({
          commandRecordId: i,
          command: "fixture test command",
          duration: 120,
          durationUnit: null,
        }))
      : [],
  );
  return {
    data,
    view,
    coverage,
    evidence,
    api,
    refs: { ci, attempts, reports, raw, qa: linkedQa, ordered, samples },
  };
}
