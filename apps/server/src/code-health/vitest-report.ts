/** Pure adapter for existing Vitest final-result JSON. It reads no path or URL. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { CodeHealthReadError } from "./error.ts";
import { riskPath } from "./risk.ts";
import { TEST_REPORT_BYTES_MAX, TEST_REPORT_CASES_MAX, TestReport } from "./test-reports.ts";

const Context = TestReport.omit({ cases: true, expectedAttempts: true }).extend({
  workspaceRoot: z.string().min(1).max(2000),
  /** Explicit importer attestation; final-result JSON itself cannot prove retry policy. */
  retriesDisabled: z.boolean().default(false),
});
const Result = z.object({
  numTotalTests: z.number().int().min(0).max(TEST_REPORT_CASES_MAX),
  testResults: z
    .array(
      z.object({
        name: z.string().min(1).max(2000),
        assertionResults: z
          .array(
            z.object({
              ancestorTitles: z.array(z.string().max(500)).max(50),
              fullName: z.string().trim().min(1).max(500),
              title: z.string().max(500),
              status: z.enum(["passed", "failed", "skipped", "pending", "todo", "disabled"]),
              duration: z.number().min(0).max(86400000).nullable().optional(),
            }),
          )
          .max(TEST_REPORT_CASES_MAX),
      }),
    )
    .max(TEST_REPORT_CASES_MAX),
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function relativeFile(name: string, root: string): string {
  const source = name.replaceAll("\\", "/"),
    base = root.replaceAll("\\", "/").replace(/\/+$/, "");
  if (
    !/^(?:[A-Za-z]:)?\//.test(base) ||
    base.split("/").some((part) => part === ".." || part === ".")
  )
    throw new CodeHealthReadError(400, "The report workspace root must be canonical and absolute.");
  const windows = /^[A-Za-z]:\//.test(base);
  const prefix = windows ? `${base.toLowerCase()}/` : `${base}/`,
    candidate = windows ? source.toLowerCase() : source;
  const path = candidate.startsWith(prefix) ? source.slice(base.length + 1) : source;
  if (!riskPath(path) || path.includes(":"))
    throw new CodeHealthReadError(400, "A report file is outside the declared workspace.");
  return path;
}

/** Unknown internal retries remain partial observations; they cannot become complete attempt rates. */
export function vitestTestReport(raw: unknown, rawContext: unknown) {
  if (Buffer.byteLength(JSON.stringify(raw) ?? "") > TEST_REPORT_BYTES_MAX)
    throw new CodeHealthReadError(413, "Vitest report exceeds the one MiB limit.");
  const context = Context.safeParse(rawContext),
    report = Result.safeParse(raw);
  if (!context.success || !report.success)
    throw new CodeHealthReadError(400, "Invalid Vitest result data or import context.");
  const { workspaceRoot, retriesDisabled, ...metadata } = context.data;
  const states = {
    passed: "passed",
    failed: "failed",
    skipped: "skipped",
    pending: "not-run",
    todo: "not-run",
    disabled: "not-run",
  } as const;
  const seen = new Set<string>();
  const cases = report.data.testResults.flatMap((file) => {
    const path = relativeFile(file.name, workspaceRoot);
    return file.assertionResults.map((result) => {
      const suite = result.ancestorTitles.join(" > ");
      if (suite.length > 500)
        throw new CodeHealthReadError(
          400,
          "A test suite label exceeds the bounded import contract.",
        );
      const testId = `v_${hash([path, result.ancestorTitles, result.fullName])}`;
      if (seen.has(testId))
        throw new CodeHealthReadError(
          400,
          "Duplicate final test identities require project/retry-specific normalized evidence.",
        );
      seen.add(testId);
      return {
        testId,
        file: path,
        suite,
        name: result.fullName,
        attemptId: `final:${testId}`,
        executionOrder: retriesDisabled ? 0 : null,
        state: states[result.status],
        // Vitest final JSON exposes suite end time, not an individual test completion time.
        completedAt: null,
        duration: retriesDisabled ? (result.duration ?? null) : null,
        durationUnit: retriesDisabled ? ("ms" as const) : null,
      };
    });
  });
  if (cases.length > TEST_REPORT_CASES_MAX)
    throw new CodeHealthReadError(413, "Vitest report exceeds the test-attempt count limit.");
  const complete = retriesDisabled && cases.length === report.data.numTotalTests;
  return TestReport.parse({
    ...metadata,
    sourceFormat: "vitest-json-final",
    cases,
    expectedAttempts: complete ? cases.length : null,
    collectionNote: `Vitest final assertion results. ${retriesDisabled ? "Importer attests internal retries were disabled; one attempt per reported test is observed." : "Internal retry completeness/order is unknown; durations and failure percentages are withheld."} ${cases.length} final entries; ${report.data.numTotalTests} declared tests. Individual completion times are not supplied by this format.`,
  });
}
