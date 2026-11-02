import { describe, expect, it } from "vitest";
import {
  type CrewPause,
  pauseWithout,
  sameCrewPauseRecord,
  seatIsPaused,
} from "../src/crew-pause.ts";

const pause = (over: Partial<CrewPause> = {}): CrewPause => ({
  seats: ["a", "b"],
  reason: "CI is red",
  at: 1,
  by: "op",
  ...over,
});

const grant = { runId: "a:run-1", by: "FLIGHT", at: 2, reason: "Finish the urgent fix" };

describe("run-bound crew pause exceptions", () => {
  it.each([{ seats: "all" as const }, { seats: ["a", "b"] }, { seats: ["a"] }])(
    "keeps the pause's full scope and owner for $seats",
    ({ seats }) => {
      const original = pause({ seats });
      const next = pauseWithout(original, "a", grant);
      expect(next).toEqual({ ...original, liftedBy: "FLIGHT", except: [{ ...grant, seat: "a" }] });
      expect(seatIsPaused(next, "a", grant.runId)).toBe(false);
      expect(seatIsPaused(next, "a")).toBe(true);
      expect(seatIsPaused(next, "a", "a:run-2")).toBe(true);
    },
  );

  it("keeps unrelated runs separate, replacing only a grant for the same run", () => {
    const first = pauseWithout(pause(), "a", grant);
    const second = pauseWithout(first, "b", { ...grant, runId: "b:run-1" });
    const updated = pauseWithout(second, "a", { ...grant, reason: "Continue this run" });
    expect(updated.except).toHaveLength(2);
    expect(seatIsPaused(updated, "b", "b:run-1")).toBe(false);
    expect(seatIsPaused(updated, "b", grant.runId)).toBe(true);
    expect(updated.except?.find((item) => item.seat === "a")?.reason).toBe("Continue this run");
  });

  it("allows exception edits but refuses another actor clearing or changing pause coverage", () => {
    const original = pause();
    expect(sameCrewPauseRecord(original, pauseWithout(original, "a", grant))).toBe(true);
    expect(sameCrewPauseRecord(original, null)).toBe(false);
    expect(sameCrewPauseRecord(original, pause({ seats: ["b"] }))).toBe(false);
  });
});
