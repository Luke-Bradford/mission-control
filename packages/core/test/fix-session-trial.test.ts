import { describe, expect, it } from "vitest";
import {
  assignFixArm,
  type FixSessionArm,
  type FixTrialEntry,
  type FixTrialStratum,
  fixTrialStratum,
} from "../src/index.ts";

const entry = (
  arm: FixSessionArm,
  merged = false,
  stratum: FixTrialStratum = "small",
  n = 0,
): FixTrialEntry => ({ ticket: `r#${n}`, stratum, arm, merged });

describe("fixTrialStratum", () => {
  it("maps Size labels to strata", () => {
    expect(fixTrialStratum("xs")).toBe("small");
    expect(fixTrialStratum(" S ")).toBe("small");
    expect(fixTrialStratum("M")).toBe("medium");
    expect(fixTrialStratum("XL")).toBe("large");
    expect(fixTrialStratum("L")).toBe("large");
    expect(fixTrialStratum("")).toBeNull();
    expect(fixTrialStratum(null)).toBeNull();
  });
});

describe("assignFixArm", () => {
  it("breaks a tie by the issue number", () => {
    expect(assignFixArm([], "small", 12)).toBe("fresh");
    expect(assignFixArm([], "small", 13)).toBe("continue");
  });
  it("gives the arm with fewer in the stratum", () => {
    expect(assignFixArm([entry("fresh")], "small", 12)).toBe("continue");
    expect(assignFixArm([entry("continue")], "small", 13)).toBe("fresh");
    // another stratum does not count
    expect(assignFixArm([entry("fresh", false, "large")], "small", 12)).toBe("fresh");
  });
  it("gives the other arm when one is full", () => {
    const merged = Array.from({ length: 10 }, (_, i) => entry("fresh", true, "medium", i));
    expect(assignFixArm(merged, "small", 12)).toBe("continue");
    const assigned = Array.from({ length: 15 }, (_, i) => entry("continue", false, "medium", i));
    expect(assignFixArm(assigned, "small", 13)).toBe("fresh");
  });
  it("gives none when both are full", () => {
    const both = [
      ...Array.from({ length: 10 }, (_, i) => entry("fresh", true, "small", i)),
      ...Array.from({ length: 15 }, (_, i) => entry("continue", false, "small", 20 + i)),
    ];
    expect(assignFixArm(both, "small", 12)).toBeNull();
  });
});
