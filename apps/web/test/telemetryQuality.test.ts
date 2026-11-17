import { describe, expect, it } from "vitest";
import { collectedFrom, rollingRate } from "../src/telemetry/quality.ts";

describe("rollingRate", () => {
  it("averages the trailing window of daily rates, skipping days without data", () => {
    expect(rollingRate([50, null, 100, 100], 3)).toEqual([50, 50, 75, 100]);
  });
  it("is a gap, not zero, while the window holds no data", () => {
    expect(rollingRate([null, null, 80], 2)).toEqual([null, null, 80]);
    expect(rollingRate([80, null, null, null], 2)).toEqual([80, 80, null, null]);
  });
});

describe("collectedFrom", () => {
  it("is the first day with a value, or -1 when none", () => {
    expect(collectedFrom([null, null, 0, 40])).toBe(2);
    expect(collectedFrom([null, null])).toBe(-1);
  });
});
