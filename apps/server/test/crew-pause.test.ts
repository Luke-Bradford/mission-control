import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pauseAwareSupervisor, startUnpausedRun } from "../src/crew-pause.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-crew-pause-"));
  store = new Store(join(dir, "test.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("refuses direct starts on paused seats and allows other seats and resume", async () => {
  const supervisor = { startRun: vi.fn(async () => ({ runId: "run", branch: "branch" })) };
  store.setSetting(
    "crew.paused",
    JSON.stringify({ seats: ["builder-1"], reason: "Save tokens", at: 1, by: "operator" }),
  );
  await expect(startUnpausedRun(store, supervisor, "builder-1", 7)).rejects.toThrow(
    "Paused: Save tokens",
  );
  expect(supervisor.startRun).not.toHaveBeenCalled();
  await startUnpausedRun(store, supervisor, "builder-2", 8);
  expect(supervisor.startRun).toHaveBeenCalledWith("builder-2", 8);
  store.setSetting("crew.paused", "null");
  await startUnpausedRun(store, supervisor, "builder-1", 7);
  expect(supervisor.startRun).toHaveBeenCalledWith("builder-1", 7);
});

it("gates FLIGHT watch starts across restart, permits other seats and resumes", async () => {
  const raw = {
    startWatch: vi.fn(async (_seatId: string, _opts?: { first?: string }) => ({ runId: "watch" })),
  };
  store.setSetting(
    "crew.paused",
    JSON.stringify({ seats: "all", reason: "Save tokens", at: 1, by: "operator" }),
  );
  let supervisor = pauseAwareSupervisor(store, raw);
  await expect(supervisor.startWatch("flight-1")).rejects.toThrow("Paused: Save tokens");
  store.close();
  store = new Store(join(dir, "test.sqlite"));
  supervisor = pauseAwareSupervisor(store, raw);
  await expect(supervisor.startWatch("flight-1")).rejects.toThrow("Paused: Save tokens");
  expect(raw.startWatch).not.toHaveBeenCalled();
  store.setSetting(
    "crew.paused",
    JSON.stringify({ seats: ["builder-1"], reason: "Save tokens", at: 1, by: "operator" }),
  );
  await supervisor.startWatch("flight-1", { first: "digest" });
  expect(raw.startWatch).toHaveBeenCalledWith("flight-1", { first: "digest" });
  store.setSetting("crew.paused", "null");
  await supervisor.startWatch("flight-1");
  expect(raw.startWatch).toHaveBeenCalledTimes(2);
});
