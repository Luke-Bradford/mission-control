import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pauseWithout, type Run } from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  messageUnpausedSeat,
  pauseAwareSupervisor,
  pausedSeat,
  readCrewPause,
  reviewPausedMs,
  startUnpausedRun,
  writeCrewPause,
} from "../src/crew-pause.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
const liveRun = (id = "guido-2:run"): Run => ({
  id,
  agentId: "guido-2",
  repoId: "mc",
  seq: 1,
  startedAt: 100,
  endedAt: null,
  status: "running",
  sessionId: "cli",
  model: "opus",
  branch: null,
  ticket: "mc#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
});
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
  // A run let out keeps the operator's original seat coverage.
  store.upsertRun(liveRun());
  const next = pauseWithout(op, "guido-2", {
    runId: "guido-2:run",
    by: "FLIGHT",
    at: 300,
    reason: "Finish mc#7",
  });
  expect(
    writeCrewPause(
      store,
      next,
      300,
      [],
      "FLIGHT",
      "FLIGHT let GUIDO-2 out of the crew pause for mc#7 (run guido-2:run): Finish mc#7",
    ),
  ).toBe(true);
  expect(readCrewPause(store)).toEqual(next);
  expect(store.hubEvents(0).map((e) => e.text)).toContain(
    "FLIGHT let GUIDO-2 out of the crew pause for mc#7 (run guido-2:run): Finish mc#7",
  );
});

it("expires grants when their run ends, without needing a pause edit or restart", () => {
  const run = liveRun();
  store.upsertRun(run);
  const original = { seats: [run.agentId], reason: "Save tokens", at: 1, by: "operator" };
  const next = pauseWithout(original, run.agentId, {
    runId: run.id,
    by: "FLIGHT",
    at: 2,
    reason: "Finish this run",
  });
  writeCrewPause(store, next, 2);
  expect(pausedSeat(store, run.agentId, run.id)).toBeNull();
  expect(pausedSeat(store, run.agentId, null)?.reason).toBe("Save tokens");
  store.upsertRun({ ...run, endedAt: 3, status: "ok" });
  expect(pausedSeat(store, run.agentId, run.id)?.reason).toBe("Save tokens");
  expect(readCrewPause(store)).toMatchObject({ seats: original.seats, except: [], by: "operator" });
  store.close();
  store = new Store(join(dir, "test.sqlite"));
  expect(pausedSeat(store, run.agentId, run.id)).not.toBeNull();
});

it("does not carry old persisted seat-ID exceptions into another run", () => {
  const run = liveRun();
  store.upsertRun(run);
  store.setSetting(
    "crew.paused",
    JSON.stringify({
      seats: "all",
      reason: "Old pause",
      at: 1,
      by: "operator",
      except: [run.agentId],
      liftedBy: "FLIGHT",
    }),
  );
  expect(readCrewPause(store)).toEqual({
    seats: "all",
    reason: "Old pause",
    at: 1,
    by: "operator",
    except: [],
    legacyExcept: [run.agentId],
    liftedBy: "FLIGHT",
  });
  expect(pausedSeat(store, run.agentId, run.id)).not.toBeNull();
});

it("does not apply another seat's run grant or a missing run", () => {
  store.upsertRun(liveRun());
  const original = { seats: "all" as const, reason: "Hold", at: 1, by: "operator" };
  writeCrewPause(
    store,
    pauseWithout(original, "other-seat", {
      runId: "guido-2:run",
      by: "FLIGHT",
      at: 2,
      reason: "wrong seat",
    }),
    2,
  );
  expect(readCrewPause(store)?.except).toEqual([]);
  writeCrewPause(
    store,
    pauseWithout(original, "guido-2", {
      runId: "missing",
      by: "FLIGHT",
      at: 2,
      reason: "missing run",
    }),
    2,
  );
  expect(readCrewPause(store)?.except).toEqual([]);
});

it("fails closed when a persisted pause time cannot be represented as a date", () => {
  store.setSetting(
    "crew.paused",
    JSON.stringify({ seats: "all", reason: "Hold", at: Number.MAX_VALUE, by: "operator" }),
  );
  expect(readCrewPause(store)).toMatchObject({
    seats: "all",
    at: 0,
    reason: "Crew pause setting is unreadable",
  });
});
