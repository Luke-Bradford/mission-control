import { describe, expect, it } from "vitest";
import { vitestVerdict } from "../src/ci-vitest.ts";

const RPC = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"';
const passed = { numFailedTests: 0, numFailedTestSuites: 0, numTotalTestSuites: 100 };
const output = (...errors: string[]) =>
  [
    " Test Files  100 passed (100)",
    "      Tests  3913 passed | 18 skipped (3931)",
    "⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯",
    `Vitest caught ${errors.length} unhandled error${errors.length === 1 ? "" : "s"} during the test run.`,
    "This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.",
    ...errors.flatMap((e) => ["", "⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯", e, "    at Object.onTimeout"]),
  ].join("\n");

describe("vitestVerdict", () => {
  it("passes a clean run", () => {
    expect(vitestVerdict(0, passed, " Test Files  1 passed (1)")).toBe(0);
  });

  it("passes when every file passed and the only error is the worker RPC timeout", () => {
    expect(vitestVerdict(1, passed, output(RPC))).toBe(0);
    expect(vitestVerdict(1, passed, output(RPC, RPC))).toBe(0);
  });

  it("fails when a test failed, even with the RPC timeout", () => {
    expect(vitestVerdict(1, { ...passed, numFailedTests: 1 }, output(RPC))).toBe(1);
    expect(vitestVerdict(1, { ...passed, numFailedTestSuites: 1 }, output(RPC))).toBe(1);
  });

  it("fails on any other unhandled error, alone or beside the timeout", () => {
    expect(vitestVerdict(1, passed, output("Error: boom"))).toBe(1);
    expect(vitestVerdict(1, passed, output(RPC, "Error: boom"))).toBe(1);
  });

  it("fails when the exit has no explained cause, or no report was read", () => {
    expect(vitestVerdict(1, passed, " Test Files  100 passed (100)")).toBe(1);
    expect(vitestVerdict(1, undefined, output(RPC))).toBe(1);
    expect(vitestVerdict(1, { ...passed, numTotalTestSuites: 0 }, output(RPC))).toBe(1);
  });
});
