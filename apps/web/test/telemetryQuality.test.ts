import { describe, expect, it } from "vitest";
import { collectedFrom, readQuality14, rollingRate } from "../src/telemetry/quality.ts";

describe("rollingRate", () => {
  it("pools the trailing numerators and denominators, rather than averaging percentages", () => {
    expect(
      rollingRate(
        [
          { pass: 1, total: 1 },
          { pass: 9, total: 99 },
        ],
        7,
      ),
    ).toEqual([100, 10]);
  });
  it("is a gap on a day with no data, never a bridge from the days before", () => {
    expect(rollingRate([{ pass: 1, total: 1 }, null, { pass: 1, total: 1 }], 7)).toEqual([
      100,
      null,
      100,
    ]);
  });
  it("is a gap, not zero, while the window holds no data", () => {
    expect(rollingRate([null, null, { pass: 4, total: 5 }], 2)).toEqual([null, null, 80]);
    expect(rollingRate([{ pass: 4, total: 5 }, null, null, null], 2)).toEqual([
      80,
      null,
      null,
      null,
    ]);
  });
});

describe("collectedFrom", () => {
  it("is the first day with a value, or -1 when none", () => {
    expect(collectedFrom([null, null, 0, 40])).toBe(2);
    expect(collectedFrom([null, null])).toBe(-1);
  });
});

describe("readQuality14", () => {
  it("keeps a rounds sum that is larger than the number of reviewed PRs", () => {
    const days = Array.from({ length: 14 }, (_, i) => ({
      day: `2026-11-${String(i + 1).padStart(2, "0")}`,
      ciPrs: 2,
      ciGreenPrs: 1,
      reviewedPrs: 2,
      firstPassPrs: 1,
      roundsSum: 3,
    }));
    expect(readQuality14(days)?.[0]?.rounds).toEqual({ pass: 3, total: 2 });
  });

  it("rejects a missing or malformed fixed daily window", () => {
    expect(readQuality14(undefined)).toBeNull();
    expect(readQuality14([{ day: "2026-10-01", ciPrs: 1 }])).toBeNull();
  });
});
