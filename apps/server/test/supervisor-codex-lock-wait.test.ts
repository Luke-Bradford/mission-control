// Register the shared mocks before importing the modules under test.
import "./supervisor-harness.ts";

import { describe, expect, it, vi } from "vitest";
import { TestLock } from "../src/guard/lock.ts";
import { codexSupervisor } from "./codex-supervisor-harness.ts";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";
import { recorded, until } from "./supervisor-harness.ts";

// The real wait is an hour: shorten it so the run out is quick.
vi.mock("@mc/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mc/core")>()),
  CODEX_LOCK_WAIT_MS: 300,
}));

skipTestsIf(await blockedHere("crew-run"));

describe("a Codex seat's check that outwaits the test lock (#1939)", () => {
  it("is told in its next turn who holds the lock and with what", async () => {
    const lock = new TestLock();
    await lock.acquire(
      { runId: "other", toolUseId: "x" },
      "OTHER-SEAT",
      "pnpm -s test:related",
      1000,
      new AbortController().signal,
    );
    const { sup } = codexSupervisor({ command: "pnpm -s test", exitCode: 0 }, { lock });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => {
      const sent = JSON.stringify(
        recorded().filter((l) => l.method === "turn/steer" || l.method === "turn/start"),
      );
      expect(sent).toContain("OTHER-SEAT");
      expect(sent).toContain("pnpm -s test:related");
    });
    await sup.endRunByEngine(runId);
  });
});
