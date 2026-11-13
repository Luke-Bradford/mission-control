import { expect, it } from "vitest";
import {
  allTime,
  planProgress,
  runOutcome,
  SILENT_AFTER_MS,
  silentFor,
  stoppedReason,
} from "../src/agent/control.ts";
import { crewRow } from "./fixtures.ts";

const NOW = 10_000_000;
it("a working seat is silent only after ten quiet minutes", () => {
  const working = (ago: number) =>
    crewRow({ kind: "crew", hudState: "running", lastOutputAt: NOW - ago });
  expect(SILENT_AFTER_MS).toBe(10 * 60_000);
  expect(silentFor(working(SILENT_AFTER_MS - 1), NOW)).toBeNull();
  expect(silentFor(working(SILENT_AFTER_MS), NOW)).toBe(SILENT_AFTER_MS);
  expect(silentFor(crewRow({ kind: "crew", hudState: "idle", lastOutputAt: 0 }), NOW)).toBeNull();
});
it("a stopped seat says why in words", () => {
  const stopped = crewRow({
    hudState: "stopped",
    stop: { reason: "weekly limit", at: 1, quota: null, resumesAt: null },
  });
  expect(stoppedReason(stopped, NOW, null)).toContain("weekly limit");
  expect(stoppedReason(crewRow({ hudState: "stopped", note: null, stop: null }), NOW, null)).toBe(
    "Stopped by you.",
  );
  expect(stoppedReason(crewRow({ hudState: "running" }), NOW, null)).toBeNull();
});
it("plan progress counts done tasks and hides without a list", () => {
  expect(planProgress([])).toBeNull();
  expect(
    planProgress([
      { id: "1", text: "a", status: "done" },
      { id: "2", text: "b", status: "pending" },
    ]),
  ).toEqual({ done: 1, total: 2 });
});
it("run outcomes use the operator's words", () => {
  expect(runOutcome({ status: "running" }).word).toBe("now");
  expect(runOutcome({ status: "ok" }).word).toBe("finished");
  expect(runOutcome({ status: "blocked", loop: { parked: "needs a call" } } as never).word).toBe(
    "parked: needs a call",
  );
});
it("all-time figures total the runs and leave cost null when none is recorded", () => {
  const r = (over: object) =>
    ({ startedAt: 0, endedAt: 3_600_000, costUsd: null, ticket: "a#1", ...over }) as never;
  const t = allTime([r({}), r({ startedAt: 10, ticket: "a#2" })]);
  expect(t.runs).toBe(2);
  expect(t.tickets).toBe(2);
  expect(t.costUsd).toBeNull();
  expect(t.firstRunAt).toBe(0);
});
