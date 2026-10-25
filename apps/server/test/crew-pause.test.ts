import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startUnpausedRun } from "../src/crew-pause.ts";
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
