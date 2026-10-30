import { describe, expect, it } from "vitest";
import { parseCheckOutput, queuePositionText, verifyReworkText } from "../src/verify.ts";

describe("verify queue text", () => {
  it("describes queued work", () => {
    expect(queuePositionText(0)).toBe("Verifying");
    expect(queuePositionText(2)).toBe("Verifying · 2nd in queue");
  });

  it("keeps useful check failures together", () => {
    const check = {
      command: "pnpm -s vitest run",
      ok: false,
      durationMs: 12,
      ...parseCheckOutput("FAIL apps/server/test/x.test.ts > x\napps/server/src/x.ts:3: error bad"),
    };
    expect(verifyReworkText({ sha: "abcdef0123", checks: [check] })).toContain(
      "Tests: apps/server/test/x.test.ts > x",
    );
  });

  it("captures Vitest's × failure line", () => {
    expect(parseCheckOutput("× suite > reports the failure").failingTests).toEqual([
      "suite > reports the failure",
    ]);
  });
});
