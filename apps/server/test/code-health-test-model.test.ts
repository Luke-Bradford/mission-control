import type { CodeHealthView } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeHealthReader } from "../src/code-health/read.ts";
import type { TestReportInput } from "../src/code-health/test-reports.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 2, 12),
  SHA = "a".repeat(40);
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  loops: [],
  repos: ["sample", "other"].map((id) => ({
    id,
    github: `example/${id}`,
    project: 1,
    statusMap: {},
    autonomy: "draft" as const,
  })),
  poll: { usageMinutes: 30, githubSeconds: 60 },
};
type TestData = Extract<CodeHealthView["data"], { tab: "test" }>;
describe("observed executed-attempt test health", () => {
  let store: Store, reader: CodeHealthReader;
  beforeEach(() => {
    store = new Store(":memory:");
    reader = new CodeHealthReader(store, config, () => NOW + 1);
  });
  afterEach(() => store.close());
  function body(
    states: TestReportInput["cases"][number]["state"][],
    patch: Partial<TestReportInput> = {},
  ): TestReportInput {
    const completedAt = patch.completedAt ?? NOW - 1;
    return {
      version: 1,
      repo: "sample",
      headSha: SHA,
      workflow: "CI",
      workflowRun: "101",
      job: "unit",
      jobRun: "201",
      runAttempt: 1,
      environment: "linux-node25",
      completedAt,
      expectedAttempts: states.length,
      cause: "unknown",
      causeEvidence: "",
      cases: states.map((state, i) => ({
        testId: "stable-a",
        file: "test/example.test.ts",
        suite: "example",
        name: "returns the required result",
        attemptId: `stable-a:${i}`,
        executionOrder: i,
        state,
        completedAt: completedAt - 100 + i,
        duration: 10 + i * 20,
        durationUnit: "ms",
      })),
      ...patch,
    };
  }
  const put = (value: TestReportInput) =>
    store.importCodeHealthTestReport(value, "operator", NOW, []);
  const view = (repo = "sample") => reader.read(repo, "30d", "test");
  const data = (repo = "sample") => view(repo).data as TestData;
  function qa(judgement: "flaky" | "wrong" = "flaky") {
    const testId = String(store.codeHealthTestAttempts("sample", NOW - 1000, NOW).rows[0].test_id);
    const id = store.requestReview({
      authorRunId: "author:fixture",
      repoId: "sample",
      seatId: "retro",
      prNumber: 7,
      sha: SHA,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: NOW - 1000,
    });
    if (id === null) throw new Error("Missing review fixture");
    store.setReviewState(id, ["queued"], "running", { at: NOW - 900, runId: "retro:fixture" });
    store.recordFindings(id, "retro:fixture", {
      verdict: { spec: "pass", quality: "fail" },
      summary: "Checked the same-commit retry behaviour.",
      findings: [
        {
          severity: "Important",
          category: "test-wrong",
          file: "test/example.test.ts",
          line: 12,
          summary: "This assertion changes without an input change.",
          scenario: "At the same commit and environment the assertion fails, then passes on retry.",
          fix: "Assert the documented stable outcome and remove the nondeterministic fixture.",
        },
      ],
      at: NOW - 500,
    });
    store.linkCodeHealthTestQa(
      {
        repo: "sample",
        testId,
        headSha: SHA,
        reviewId: id,
        findingPosition: 0,
        judgement,
        specEvidence: "The specification requires the same result for the same input and commit.",
      },
      "operator",
      NOW,
      [],
    );
  }
  it("keeps an uncollected named-test source distinct from zero failures", () => {
    expect(data()).toMatchObject({
      namedTestRate: null,
      mixedJobCandidates: null,
      disruption: [],
      durations: [],
      qaProposals: [],
    });
    expect(
      view().coverage.find((row) => row.source === "imported named-test attempts")?.state,
    ).toBe("not-collected");
  });
  it("uses executed attempts only and leaves mixed outcomes as candidates", () => {
    put(body(["failed", "passed", "skipped", "cancelled", "not-run"]));
    expect(data().namedTestRate).toEqual({ numerator: 1, denominator: 2, percent: 50 });
    expect(data().disruption).toHaveLength(1);
    expect(data().disruption[0]).toMatchObject({ classification: "candidate", ordered: true });
    expect(data().durations[0]).toMatchObject({
      p50Ms: 10,
      p95Ms: 30,
      samples: 2,
      environment: "linux-node25",
    });
  });
  it("requires exact-head QA evidence as well as an ordered failure then pass for confirmation", () => {
    put(body(["failed", "passed"]));
    qa();
    expect(data().disruption[0].classification).toBe("confirmed-flaky");
    expect(data().qaProposals[0]).toMatchObject({
      judgement: "flaky",
      reviewer: "retro",
      recordedBy: "operator",
      file: "test/example.test.ts",
      headSha: SHA,
    });
    const ref = data().qaProposals[0].evidence[0];
    const evidence = reader.evidence("sample", ref.id, undefined);
    expect(evidence.rows[0]).toMatchObject({
      reviewer: "retro",
      actor: "operator",
      headSha: SHA,
      line: 12,
    });
    expect(evidence.rows[0].specEvidence).toContain("specification");
  });
  it("does not turn a wrong-test proposal or a pass-then-failure series into confirmed flakiness", () => {
    put(body(["passed", "failed"]));
    qa("wrong");
    expect(data().disruption[0].classification).toBe("candidate");
  });
  it.each(["missing", "duplicate", "time-conflict"])(
    "keeps ambiguous retry order a candidate: %s",
    (kind) => {
      const value = body(["failed", "passed"]);
      if (kind === "missing") value.cases[1].executionOrder = null;
      if (kind === "duplicate") value.cases[1].executionOrder = 0;
      if (kind === "time-conflict")
        value.cases[0].completedAt = (value.cases[1].completedAt ?? 0) + 1;
      put(value);
      qa();
      expect(data().disruption[0]).toMatchObject({ classification: "candidate", ordered: false });
    },
  );
  it("uses explicit order when the report array is reversed", () => {
    const value = body(["failed", "passed"]);
    value.cases.reverse();
    put(value);
    qa();
    expect(data().disruption[0]).toMatchObject({
      classification: "confirmed-flaky",
      ordered: true,
    });
  });
  it("distinguishes observed repeated failures and recorded infrastructure causes", () => {
    put(body(["failed", "failed"]));
    expect(data().disruption[0].classification).toBe("consistently-failing");
    put(
      body(["failed"], {
        jobRun: "202",
        workflowRun: "102",
        cause: "infrastructure",
        causeEvidence: "The job recorded an unavailable dependency service.",
      }),
    );
    expect(
      data()
        .disruption.map((row) => row.classification)
        .sort(),
    ).toEqual(["consistently-failing", "infrastructure"]);
  });
  it("separates head/environment/workflow series and does not carry QA to a newer commit", () => {
    put(body(["failed", "passed"]));
    qa();
    put(body(["failed", "passed"], { headSha: "b".repeat(40), workflowRun: "102", jobRun: "202" }));
    put(body(["failed"], { workflowRun: "103", jobRun: "203", environment: "other-runtime" }));
    put(body(["failed"], { repo: "other", workflowRun: "104", jobRun: "204" }));
    expect(data().disruption).toHaveLength(3);
    expect(
      data().disruption.filter((row) => row.classification === "confirmed-flaky"),
    ).toHaveLength(1);
    expect(data("other").disruption[0].classification).toBe("candidate");
    const ref = data().disruption[0].evidence[0];
    expect(() => reader.evidence("other", ref.id, undefined)).toThrow(/unavailable/);
  });
  it("keeps incomplete collection percentages and classification provisional", () => {
    put(body(["failed", "passed"], { expectedAttempts: null }));
    qa();
    expect(data().namedTestRate).toMatchObject({ numerator: 1, denominator: 2, percent: null });
    expect(data().disruption[0].classification).toBe("candidate");
  });
  it("normalises known units and never pools distinct environments or unknown units", () => {
    const first = body(["passed", "passed"]);
    first.cases[0].duration = 1;
    first.cases[0].durationUnit = "s";
    first.cases[1].duration = 2000;
    put(first);
    const other = body(["passed"], {
      environment: "windows-node25",
      workflowRun: "102",
      jobRun: "202",
    });
    other.cases[0].duration = 4000;
    put(other);
    const unknown = body(["passed"], { workflowRun: "103", jobRun: "203" });
    unknown.cases[0].durationUnit = null;
    put(unknown);
    expect(
      data().durations.map((row) => [row.environment, row.p50Ms, row.p95Ms, row.samples]),
    ).toEqual([
      ["windows-node25", 4000, 4000, 1],
      ["linux-node25", 1000, 2000, 2],
    ]);
  });
  it("pages exact duration samples and retains excluded attempt states separately", () => {
    put(body(["passed", "failed", "skipped"]));
    const result = data(),
      duration = result.durations[0];
    expect(
      reader
        .evidence("sample", duration.evidence[0].id, undefined)
        .rows.map((row) => row.state)
        .sort(),
    ).toEqual(["failed", "passed"]);
    const ref = view().evidence.find((row) => row.label === "Imported named-test attempts");
    if (!ref) throw new Error("Missing attempt reference");
    expect(reader.evidence("sample", ref.id, undefined).rows).toHaveLength(3);
  });
  it("uses a half-open report-completion window and invalidates old evidence after import", () => {
    const start = NOW + 1 - 30 * 86400000;
    put(body(["failed"], { completedAt: start, workflowRun: "101", jobRun: "201" }));
    const ref = data().disruption[0].evidence[0];
    put(body(["passed"], { completedAt: NOW + 1, workflowRun: "102", jobRun: "202" }));
    expect(data().namedTestRate).toMatchObject({ numerator: 1, denominator: 1 });
    expect(() => reader.evidence("sample", ref.id, undefined)).toThrow(/source changed/);
  });
});
