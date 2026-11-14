// Register the shared mocks before importing the modules under test.
import "./supervisor-harness.ts";

import { CHECK_BASH_TIMEOUT_MS } from "@mc/core";
import { describe, expect, it } from "vitest";
import { type CheckRecorder, createCheckRecorder } from "../src/guard/check-runs.ts";
import { TestLock } from "../src/guard/lock.ts";
import { codexSupervisor } from "./codex-supervisor-harness.ts";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";
import { seatState, store, until } from "./supervisor-harness.ts";

skipTestsIf(await blockedHere("crew-run"));

const spy = () => {
  const calls: unknown[][] = [];
  const checks: CheckRecorder = {
    begin: async (k, c) => void calls.push(["begin", k, c]),
    end: async (k, ok) => void calls.push(["end", k, ok]),
    lockedBy: async () => null,
    dropRun: (runId) => void calls.push(["drop", runId]),
    drops: () => [],
    pending: () => [],
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

  it("releases a check record after an interrupted Codex turn", async () => {
    const checks = createCheckRecorder({
      store: { addCheckRun: () => {} },
      checks: async () => [],
      state: async () => ({ head: "a".repeat(40), clean: true }),
    });
    const { sup } = codexSupervisor({ command: "pnpm -s test", holdItem: true }, { checks });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() =>
      expect(checks.running?.(runId, "pnpm -s test another.test.ts")).resolves.toBe("pnpm -s test"),
    );
    await sup.interrupt("guido-1");
    await until(() =>
      expect(
        checks.admit?.({ runId, toolUseId: "next" }, "pnpm -s test another.test.ts"),
      ).resolves.toBeNull(),
    );
    await sup.endRunByEngine(runId);
  });
});

describe("a Codex command handed back before it exits", () => {
  it("keeps its lock and its record, and counts no result for it", async () => {
    const command = "pnpm -s lint";
    const rows: unknown[] = [];
    let clock = Date.now();
    const lock = new TestLock({ holds: store });
    const checks = createCheckRecorder({
      store: { addCheckRun: (row) => void rows.push(row) },
      checks: async () => [command],
      state: async () => ({ head: "a".repeat(40), clean: true }),
      now: () => clock,
      release: (key) => lock.release(key),
    });
    const { sup } = codexSupervisor({ command, holdTurn: true }, { checks, lock });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    // the item completes (no exit code) shortly after its approval
    await new Promise((done) => setTimeout(done, 300));
    expect(lock.state().holder?.runId).toBe(runId);
    expect(await checks.running?.(runId, command)).toBe(command);
    expect(rows).toEqual([]);
    // nothing can report its exit: past its own timeout the hub stops holding the lock for it
    clock += CHECK_BASH_TIMEOUT_MS + 1;
    expect(await checks.running?.(runId, command)).toBeNull();
    expect(lock.state().holder).toBeNull();
    await sup.endRunByEngine(runId);
  });
});

describe("a Codex seat's test-lock outcome (#1411)", () => {
  it.each([
    ["pnpm -s test", 0, "pass"],
    ["pnpm -s test", 1, "fail"],
    // tail's status, not the suite's: never pass
    ["pnpm -s test | tail -5", 0, "done"],
    ["pnpm -s test | tail -5", 1, "fail"],
  ])("ends the lock row for `%s` with exit %s as %s", async (command, exitCode, outcome) => {
    const lock = new TestLock({ holds: store });
    const { sup } = codexSupervisor({ command, exitCode }, { lock });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(store.lockRuns(0)[0]?.outcome).toBe(outcome));
    await sup.endRunByEngine(runId);
  });
});
