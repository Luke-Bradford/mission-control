import { describe, expect, it } from "vitest";
import { vitestTestReport } from "../src/code-health/vitest-report.ts";

const context = {
  version: 1,
  repo: "sample",
  headSha: "a".repeat(40),
  workflow: "CI",
  workflowRun: "101",
  job: "unit",
  jobRun: "201",
  runAttempt: 1,
  environment: "linux-node25",
  completedAt: 10000,
  workspaceRoot: "/workspace/sample",
};
function raw() {
  return {
    numTotalTests: 2,
    testResults: [
      {
        name: "/workspace/sample/test/example.test.ts",
        assertionResults: [
          {
            ancestorTitles: ["example"],
            fullName: "example returns the result",
            title: "returns the result",
            status: "passed",
            duration: 12,
          },
          {
            ancestorTitles: ["example"],
            fullName: "example rejects bad input",
            title: "rejects bad input",
            status: "failed",
            duration: 25,
          },
        ],
      },
    ],
  };
}
describe("existing Vitest final-result artifacts", () => {
  it("strips only the declared workspace and keeps retry completeness unknown by default", () => {
    const value = vitestTestReport(raw(), context);
    expect(value).toMatchObject({ sourceFormat: "vitest-json-final", expectedAttempts: null });
    expect(value.cases[0]).toMatchObject({
      file: "test/example.test.ts",
      state: "passed",
      executionOrder: null,
      completedAt: null,
      duration: null,
      durationUnit: null,
    });
    expect(value.collectionNote).toContain("retry completeness/order is unknown");
  });
  it("uses documented milliseconds and one ordinal only with explicit disabled-retry attestation", () => {
    const value = vitestTestReport(raw(), { ...context, retriesDisabled: true });
    expect(value.expectedAttempts).toBe(2);
    expect(value.cases[1]).toMatchObject({
      state: "failed",
      duration: 25,
      durationUnit: "ms",
      executionOrder: 0,
      completedAt: null,
    });
  });
  it("derives stable test identities independently of report order", () => {
    const before = vitestTestReport(raw(), context),
      source = raw();
    source.testResults[0].assertionResults.reverse();
    const after = vitestTestReport(source, context);
    expect(before.cases.map((row) => row.testId).sort()).toEqual(
      after.cases.map((row) => row.testId).sort(),
    );
  });
  it("does not turn skipped or unrun results into executed failures", () => {
    const source = raw();
    source.testResults[0].assertionResults[0].status = "skipped";
    source.testResults[0].assertionResults[1].status = "todo";
    expect(vitestTestReport(source, context).cases.map((row) => row.state)).toEqual([
      "skipped",
      "not-run",
    ]);
  });
  it("keeps count mismatches partial instead of dropping cases or inventing completeness", () => {
    const source = raw();
    source.numTotalTests = 3;
    expect(vitestTestReport(source, { ...context, retriesDisabled: true })).toMatchObject({
      expectedAttempts: null,
    });
  });
  it("refuses ambiguous duplicate project/retry identities", () => {
    const source = raw();
    source.testResults[0].assertionResults.push({ ...source.testResults[0].assertionResults[0] });
    source.numTotalTests = 3;
    expect(() => vitestTestReport(source, context)).toThrow(/Duplicate final test identities/);
  });
  it.each([
    "/workspace/other/test.ts",
    "/workspace/sample-else/test.ts",
    "../escape.test.ts",
    "https://example.test/report",
  ])("does not follow an outside path or URL: %s", (name) => {
    const source = raw();
    source.testResults[0].name = name;
    expect(() => vitestTestReport(source, context)).toThrow();
  });
  it("supports canonical Windows workspace paths without accessing them", () => {
    const source = raw();
    source.testResults[0].name = "C:\\work\\sample\\test\\example.test.ts";
    expect(
      vitestTestReport(source, { ...context, workspaceRoot: "C:\\work\\sample" }).cases[0].file,
    ).toBe("test/example.test.ts");
  });
  it("caps reports and rejects malformed result states", () => {
    expect(() => vitestTestReport({ blob: "x".repeat(1024 * 1024) }, context)).toThrow(/one MiB/);
    const source = raw();
    source.testResults[0].assertionResults[0].status = "unknown";
    expect(() => vitestTestReport(source, context)).toThrow(/Invalid Vitest/);
  });
});
