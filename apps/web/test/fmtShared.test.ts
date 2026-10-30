import { describe, expect, it } from "vitest";
import { agoWords, cost, elapsed, minutesAgo, percent, plural, shortSha } from "../src/fmt.ts";

describe("shared formatters", () => {
  it("pluralises with its count, and takes an irregular plural", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(3, "file")).toBe("3 files");
    expect(plural(1, "fix", "fixes")).toBe("1 fix");
    expect(plural(0, "fix", "fixes")).toBe("0 fixes");
  });

  it("cuts a sha to seven characters", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
    expect(shortSha("")).toBe("");
  });

  it("formats a 0–100 value as a percent at the asked precision, and none as a dash", () => {
    expect(percent(42.6)).toBe("43%");
    expect(percent(42.6149, 2)).toBe("42.61%");
    expect(percent(50, 3)).toBe("50%");
    expect(percent(null)).toBe("—");
    expect(percent(undefined)).toBe("—");
  });

  it("formats cost with a tilde, and none as a dash", () => {
    expect(cost(1.8)).toBe("~$1.80");
    expect(cost(1.8, false)).toBe("$1.80");
    expect(cost(null)).toBe("—");
    expect(cost(undefined)).toBe("—");
  });

  it("formats a span of time, floored, and none as a dash", () => {
    expect(elapsed(null)).toBe("—");
    expect(elapsed(59_999)).toBe("0m");
    expect(elapsed(3_600_000 + 5 * 60_000)).toBe("1h 5m");
    expect(elapsed(26 * 3_600_000)).toBe("1d 2h");
  });

  it("words a count of days and a number of minutes ago", () => {
    expect(agoWords(0)).toBe("today");
    expect(agoWords(1)).toBe("1 day ago");
    expect(agoWords(4)).toBe("4 days ago");
    expect(minutesAgo(0.5)).toBe("now");
    expect(minutesAgo(90)).toBe("90 min ago");
    expect(minutesAgo(600)).toBe("10 h ago");
    expect(minutesAgo(4320)).toBe("3 days ago");
  });
});
