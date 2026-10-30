import { describe, expect, it } from "vitest";
import { type CrewPause, pauseWithout, seatIsPaused } from "../src/crew-pause.ts";

const pause = (over: Partial<CrewPause> = {}): CrewPause => ({
  seats: ["a", "b"],
  reason: "CI is red",
  at: 1,
  by: "op",
  ...over,
});

describe("pauseWithout", () => {
  it("lets one seat out of a named pause, keeping who set it and naming who let it out", () => {
    const next = pauseWithout(pause(), "a", "FLIGHT");
    expect(next).toEqual(pause({ seats: ["b"], liftedBy: "FLIGHT" }));
    expect(seatIsPaused(next, "a")).toBe(false);
    expect(seatIsPaused(next, "b")).toBe(true);
  });

  it("keeps an all-seats pause all, with the seat as an exception and the actor named", () => {
    const next = pauseWithout(pause({ seats: "all" }), "a", "FLIGHT");
    expect(next).toEqual(pause({ seats: "all", except: ["a"], liftedBy: "FLIGHT" }));
    expect(seatIsPaused(next, "a")).toBe(false);
    expect(seatIsPaused(next, "later-seat")).toBe(true);
  });

  it("ends the pause when no seat is left, and names nobody when no actor is given", () => {
    expect(pauseWithout(pause({ seats: ["a"] }), "a", "FLIGHT")).toBeNull();
    expect(pauseWithout(pause(), "a")).toEqual(pause({ seats: ["b"] }));
  });
});
