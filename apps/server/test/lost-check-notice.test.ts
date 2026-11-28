import { describe, expect, it, vi } from "vitest";
import { createCheckRecorder } from "../src/guard/check-runs.ts";
import { notifyLostCheck } from "../src/main.ts";

describe("lost Codex check notice", () => {
  it("interrupts the active Codex seat when a focused test ends without a result", async () => {
    const command = "pnpm -s vitest apps/server/test/guard-check-runs.test.ts";
    const message = vi.fn(async () => {});
    const alive = { now: true };
    const recorder = createCheckRecorder({
      store: { addCheckRun: vi.fn() },
      checks: async () => ["pnpm -s lint"],
      state: async () => ({ head: "a".repeat(40), clean: true }),
      worktree: async () => "/work/trees/codex-1",
      processAlive: async () => alive.now,
      pollMs: 5,
      onLost: (runId, commands) =>
        notifyLostCheck(
          { run: () => ({ agentId: "codex-1" }) },
          { message },
          vi.fn(),
          runId,
          commands,
        ),
    });

    await recorder.admit?.({ runId: "run-1", toolUseId: "cell-1" }, command);
    recorder.dropRun("run-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    alive.now = false;

    await vi.waitFor(() =>
      expect(message).toHaveBeenCalledWith(
        "codex-1",
        `The test command ended without a final result: ${command}. Run it again; do not keep polling the lost command.`,
        { interrupt: true, questions: "none", expectedRunId: "run-1" },
      ),
    );
  });
});
