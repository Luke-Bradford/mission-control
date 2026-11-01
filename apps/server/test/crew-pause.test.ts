import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  messageUnpausedSeat,
  pauseAwareSupervisor,
  readCrewPause,
  reviewPausedMs,
  startUnpausedRun,
  writeCrewPause,
} from "../src/crew-pause.ts";
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

it("refuses FLIGHT messages before sending instructions to a paused destination", async () => {
  const supervisor = { message: vi.fn(async () => {}) };
  store.setSetting(
    "crew.paused",
    JSON.stringify({
      seats: ["builder-1"],
      reason: "Save tokens",
      at: 1,
      by: "operator",
    }),
  );
  await expect(
    messageUnpausedSeat(store, supervisor, "builder-1", "Rework", { interrupt: false }),
  ).rejects.toThrow("Paused: Save tokens");
  expect(supervisor.message).not.toHaveBeenCalled();
  await messageUnpausedSeat(store, supervisor, "builder-2", "Rework", { interrupt: false });
  store.setSetting("crew.paused", "null");
  await messageUnpausedSeat(store, supervisor, "builder-1", "Rework", { interrupt: false });
  expect(supervisor.message).toHaveBeenCalledTimes(2);
  expect(supervisor.message).toHaveBeenLastCalledWith("builder-1", "Rework", {
    interrupt: false,
    enforcePause: true,
  });
});

it("persists review pause time through edits and restart, including pauses between engine ticks", () => {
  // A review only needs its identity and start for pause accounting.
  const review = { id: 17, seatId: "builder-1", startedAt: 100, createdAt: 100 };
  const pause = { seats: ["builder-1"], reason: "Save tokens", at: 200, by: "operator" };
  writeCrewPause(store, pause, 200, [review]);
  expect(reviewPausedMs(store, review, 300)).toBe(100);
  store.close();
  store = new Store(join(dir, "test.sqlite"));
  writeCrewPause(store, { ...pause, at: 400 }, 400, [review]);
  writeCrewPause(store, null, 500, [review]);
  expect(reviewPausedMs(store, review, 600)).toBe(300);
});

it("FLIGHT's write never clears or replaces a pause another actor set, and logs the refusal", () => {
  const op = { seats: "all" as const, reason: "freeze", at: 100, by: "operator" };
  writeCrewPause(store, op, 100);
  expect(writeCrewPause(store, null, 200, [], "FLIGHT")).toBe(false);
  expect(
    writeCrewPause(
      store,
      { seats: ["guido-2"], reason: "mine", at: 200, by: "FLIGHT" },
      200,
      [],
      "FLIGHT",
    ),
  ).toBe(false);
  expect(readCrewPause(store)).toEqual(op);
  expect(store.hubEvents(0).map((e) => e.text)).toContain(
    "Crew pause kept: FLIGHT cannot replace the pause operator set (freeze)",
  );
  // a seat let out is the same record, still the operator's
  expect(
    writeCrewPause(store, { ...op, except: ["guido-2"], liftedBy: "FLIGHT" }, 300, [], "FLIGHT"),
  ).toBe(true);
  expect(readCrewPause(store)).toMatchObject({ by: "operator", except: ["guido-2"] });
});
