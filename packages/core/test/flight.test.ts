import { describe, expect, it } from "vitest";
import { flightTurnShort, flightTurnText, wakeKey, wakeKeyPrefix } from "../src/flight.ts";

describe("flight turn texts", () => {
  it("keeps the wake key", () => {
    expect(wakeKey("r", 3)).toBe("flight:wake:r:3");
    expect(wakeKeyPrefix("r")).toBe("flight:wake:r:");
  });

  it("words the turn", () => {
    expect(flightTurnText(23, 41)).toBe("turn 23 of 41, then a fresh session");
    expect(flightTurnShort(23, 41)).toBe("turn 23 of 41");
  });
});
