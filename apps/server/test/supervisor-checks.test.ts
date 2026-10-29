// Register the shared mocks before importing the modules under test.
import "./supervisor-harness.ts";

import { describe, expect, it } from "vitest";
import type { CheckRecorder } from "../src/check-runs.ts";
import { codexSupervisor } from "./codex-supervisor-harness.ts";
import { seatState, until } from "./supervisor-harness.ts";

const spy = () => {
  const calls: unknown[][] = [];
  const checks: CheckRecorder = {
    begin: async (k, c) => void calls.push(["begin", k, c]),
    end: async (k, ok) => void calls.push(["end", k, ok]),
    dropRun: (runId) => void calls.push(["drop", runId]),
  };
  return { calls, checks };
};

describe("a Codex seat's check records", () => {
  it.each([
    [0, true],
    [1, false],
  ])(
    "starts a record at the command's approval and ends it with exit %s (ok = %s)",
    async (exitCode, ok) => {
      const { calls, checks } = spy();
      const { sup } = codexSupervisor({ command: "pnpm -s lint", exitCode }, { checks });
      sup.start();
      const { runId } = await sup.startRun("guido-1", 42);
      await until(() => expect(calls.some((c) => c[0] === "end")).toBe(true));
      const [begin, end] = calls.filter((c) => c[0] !== "drop");
      // the same call: the end names the id the begin did
      const key = begin?.[1];
      expect(key).toEqual({ runId, toolUseId: expect.any(String) });
      expect(begin).toEqual(["begin", key, "pnpm -s lint"]);
      expect(end).toEqual(["end", key, ok]);
      await until(() => expect(seatState("guido-1")).toBe("idle"));
      // the turn's end forgets any call that never reported
      expect(calls).toContainEqual(["drop", runId]);
      await sup.endRunByEngine(runId);
    },
  );
});
