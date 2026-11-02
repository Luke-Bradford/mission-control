import type { CodeHealthCoverage, CodeHealthEvidenceRef, CodeHealthView } from "@mc/core";
import type { Store } from "../store.ts";
import type { CodeHealthEvidenceKind } from "./source.ts";
import { deriveTestHealth } from "./test-model.ts";

type Query = {
  repoId: string;
  from: number;
  until: number;
  revision: string;
  kind: CodeHealthEvidenceKind;
  testId?: string;
  seriesKey?: string;
  environmentKey?: string;
  file?: string;
  sha?: string;
};
export function buildTestTab(input: {
  store: Store;
  repoId: string;
  base: Omit<Query, "kind">;
  describe: (
    source: string,
    first: number | null,
    last: number | null,
    note: string,
    state?: CodeHealthCoverage["state"],
    sha?: string | null,
  ) => CodeHealthCoverage;
  reference: (
    query: Query,
    label: string,
    definition: string,
    coverage: CodeHealthCoverage,
  ) => CodeHealthEvidenceRef;
}) {
  const { store, repoId, base, describe, reference } = input;
  const ci = store.codeHealthCi(repoId, base.from, base.until),
    attempts = store.codeHealthTestAttempts(repoId, base.from, base.until),
    qa = store.codeHealthTestQa(repoId, base.from, base.until);
  const summary = deriveTestHealth(repoId, attempts, qa.rows);
  const evidence: CodeHealthEvidenceRef[] = [];
  const ciCoverage = describe(
    "CI job observations",
    ci.observedFrom,
    ci.observedUntil,
    `${ci.observations} polled job-state observations. Mixed job outcomes remain candidates: these snapshots do not establish named-test attempt order or cause.`,
  );
  evidence.push(
    reference(
      { ...base, kind: "ci" },
      "CI job observations",
      "Stored job states are independent of imported named-test attempts.",
      ciCoverage,
    ),
  );
  const namedCoverage = describe(
    "imported named-test attempts",
    attempts.observedFrom,
    attempts.observedUntil,
    `${attempts.reports} authenticated imported reports: ${summary.executed} executed attempts, ${summary.notExecuted} skipped/cancelled/not-run entries excluded. Reports are selected by their recorded completion time; a missing individual completion time is not invented. ${attempts.complete ? "Declared observed-report counts are complete; this is not complete GitHub history." : "Some observed report counts are unknown or the 20,000-row source bound was reached. Failure percentages stay unknown."} Retry order uses explicit execution metadata, never array or poll order.`,
    attempts.reports ? "available" : "not-collected",
  );
  namedCoverage.complete = attempts.reports > 0 && attempts.complete;
  evidence.push(
    reference(
      { ...base, kind: "test-attempts" },
      "Imported named-test attempts",
      "All recorded attempt states and reproduction identities; only passed/failed states enter the observed failure denominator.",
      namedCoverage,
    ),
  );
  evidence.push(
    reference(
      { ...base, kind: "test-reports" },
      "Imported report provenance",
      "Authenticated importer, declared workflow/job/run attempt, source format, completion time and collection limitations, including zero-case reports.",
      namedCoverage,
    ),
  );
  const durationCoverage = describe(
    "documented test durations",
    attempts.observedFrom,
    attempts.observedUntil,
    `Nearest-rank p50/p95 of executed test-attempt milliseconds, grouped by stable test/file/environment. ${summary.unnormalised} executed imported attempts lack a duration/unit/environment. ${ci.unnormalisedCommandRecords} legacy review-command values have undocumented duration units and are not converted. ${summary.omittedDurations} duration groups are outside the 50-row summary.`,
    summary.durations.length ? "available" : "not-collected",
  );
  durationCoverage.complete =
    attempts.complete && summary.unnormalised === 0 && attempts.reports > 0;
  evidence.push(
    reference(
      { ...base, kind: "durations" },
      "Unnormalised command evidence",
      "Legacy review command values retain their raw units; they do not enter test duration percentiles.",
      durationCoverage,
    ),
  );
  const qaFirst = qa.rows.length ? Math.min(...qa.rows.map((row) => row.at)) : null,
    qaLast = qa.rows.length ? Math.max(...qa.rows.map((row) => row.at)) : null;
  const qaCoverage = describe(
    "evidence-backed test QA proposals",
    qaFirst,
    qaLast,
    `An authenticated operator links/classifies an existing reported reviewer finding at the exact test/repo/head, with code and specification evidence. The recorded reviewer supplied that finding; no new review is claimed. Age alone is not evidence. ${qa.truncated ? "The 20,000-row proposal source bound was reached." : "All observed proposals are retained."} No test is quarantined and no QA seat or paid schedule starts here.`,
    qa.rows.length ? "available" : "not-collected",
  );
  qaCoverage.complete = qa.complete && qa.rows.length > 0;
  evidence.push(
    reference(
      { ...base, kind: "test-qa" },
      "Test QA proposal evidence",
      "Immutable source findings, reviewer provenance and the separate operator classification/specification rationale.",
      qaCoverage,
    ),
  );
  const data: Extract<CodeHealthView["data"], { tab: "test" }> = {
    tab: "test",
    mixedJobCandidates: ci.observations ? ci.mixedJobCandidates : null,
    namedTestRate: summary.rate,
    disruption: summary.disruption.map(({ seriesKey, ...row }) => ({
      ...row,
      evidence: [
        reference(
          { ...base, kind: "test-attempts", testId: row.testId, sha: row.headSha, seriesKey },
          "Ordered test-attempt evidence",
          "Exact repo, head, workflow run, job and environment. Candidate is not proof of flakiness; confirmation also requires linked QA evidence.",
          namedCoverage,
        ),
      ],
    })),
    durations: summary.durations.map(({ environmentKey, ...row }) => ({
      ...row,
      evidence: [
        reference(
          { ...base, kind: "test-durations", testId: row.testId, file: row.file, environmentKey },
          "Documented duration samples",
          "Only passed/failed attempts with documented milliseconds in this test/file/environment enter these nearest-rank percentiles.",
          durationCoverage,
        ),
      ],
    })),
    qaProposals: qa.rows.slice(0, 50).map((row) => ({
      id: row.id,
      testId: row.test_id,
      judgement: row.judgement,
      reviewer: row.reviewer,
      at: row.at,
      file: row.file,
      headSha: row.head_sha,
      recordedBy: row.actor,
      evidence: [
        reference(
          { ...base, kind: "test-qa", testId: row.test_id, sha: row.head_sha },
          "Linked QA code/spec evidence",
          "The source reviewer and reported finding are retained separately from the operator who classified/linked this proposal.",
          qaCoverage,
        ),
      ],
    })),
    omitted: {
      disruption: summary.omittedDisruption,
      durations: summary.omittedDurations,
      qaProposals: Math.max(0, qa.rows.length - 50),
    },
  };
  if (summary.omittedDisruption)
    namedCoverage.note += ` ${summary.omittedDisruption} disruption groups are outside the 50-row summary.`;
  return { data, evidence };
}
