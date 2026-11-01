import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { repeatOptions, repeatTest } from "../../../scripts/repeat-test.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-repeat-test-"));
  mkdirSync(join(root, "apps/test"), { recursive: true });
  writeFileSync(join(root, "apps/test/a.test.ts"), "");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
it.each(["0", "-1", "1.5", "101", "1e2", "2; echo bad"])(
  "refuses an invalid repetition count %s",
  (n) => {
    expect(() => repeatOptions(root, "apps/test/a.test.ts", n)).toThrow(/integer/);
  },
);
it.each([
  "apps/test/*.test.ts",
  "../apps/test/a.test.ts",
  "apps/test/../../a.test.ts",
  "apps/test/a.ts",
  "--help",
])("refuses non-exact test path %s", (file) => {
  expect(() => repeatOptions(root, file, "2")).toThrow();
});
it("refuses a test symlink escaping the checkout", () => {
  const other = mkdtempSync(join(tmpdir(), "mc-repeat-outside-"));
  try {
    writeFileSync(join(other, "outside.test.ts"), "");
    symlinkSync(join(other, "outside.test.ts"), join(root, "apps/test/link.test.ts"));
    expect(() => repeatOptions(root, "apps/test/link.test.ts", "2")).toThrow(/inside/);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
it("continues all repetitions after a failure and retains each report", () => {
  const options = repeatOptions(root, "apps/test/a.test.ts", "3", "a; echo remains literal");
  let run = 0;
  const execute = vi.fn((args: string[]) => {
    run++;
    const path = args.find((arg) => arg.startsWith("--outputFile="))?.slice(13);
    if (!path) throw Error("report path");
    writeFileSync(
      path,
      JSON.stringify({
        numPassedTests: run === 2 ? 0 : 1,
        numFailedTests: run === 2 ? 1 : 0,
        success: run !== 2,
      }),
    );
    return { status: run === 2 ? 1 : 0 };
  });
  const summary = repeatTest(options, execute);
  expect(execute).toHaveBeenCalledTimes(3);
  expect(summary.outcomes.map((run) => run.status)).toEqual(["passed", "failed", "passed"]);
  expect(summary.success).toBe(false);
  expect(execute.mock.calls[0]?.[0]).toContain("--testNamePattern=a; echo remains literal");
});
it("rejects zero executed tests even when Vitest exits successfully", () => {
  const summary = repeatTest(repeatOptions(root, "apps/test/a.test.ts", "1"), (args) => {
    const path = args.find((arg) => arg.startsWith("--outputFile="))?.slice(13);
    if (!path) throw Error("report path");
    writeFileSync(path, JSON.stringify({ numPassedTests: 0, numFailedTests: 0, success: true }));
    return { status: 0 };
  });
  expect(summary.success).toBe(false);
  expect(summary.outcomes[0]?.status).toBe("no-tests-executed");
});
it("cannot pass on a missing report or a process error", () => {
  const summary = repeatTest(repeatOptions(root, "apps/test/a.test.ts", "1"), () => ({
    status: null,
    error: new Error("not launched"),
  }));
  expect(summary.success).toBe(false);
  expect(summary.outcomes[0]?.status).toBe("invalid-report");
});

it("does not reuse an old successful report when a later run omits its result", () => {
  const options = repeatOptions(root, "apps/test/a.test.ts", "1");
  mkdirSync(options.output, { recursive: true });
  writeFileSync(
    join(options.output, "run-001.json"),
    JSON.stringify({ numPassedTests: 1, numFailedTests: 0, success: true }),
  );
  const summary = repeatTest(options, () => ({ status: 0 }));
  expect(summary.success).toBe(false);
  expect(summary.finalized).toBe(true);
  expect(summary.completed).toBe(1);
  expect(summary.outcomes[0]?.status).toBe("invalid-report");
});
