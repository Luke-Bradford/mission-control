import { describe, expect, it } from "vitest";
import type { UsageSample } from "../src/types.ts";
import {
  fullAt5h,
  latestCrossing,
  pace5h,
  pace24h,
  projectAtReset,
  stopForecast,
  usageAt,
} from "../src/usage.ts";

const t0 = Date.UTC(2026, 9, 17, 1, 41);
const resetAt = t0 + 48 * 3600e3;
const s = (h: number, pct: number): UsageSample => ({
  accountId: "codex",
  window: "7d",
  at: t0 + h * 3600e3,
  pct,
  resetAt,
  source: "test",
});
const lin = [s(-24, 50), s(-12, 56), s(0, 62)];

describe("usage derivations", () => {
  it("interpolates usage linearly", () => {
    expect(usageAt(lin, t0 - 6 * 3600e3)).toBeCloseTo(59);
  });
  it("returns null with no samples", () => {
    expect(usageAt([], t0)).toBeNull();
  });
  it("clamps before the first and after the last sample", () => {
    expect(usageAt(lin, t0 - 100 * 3600e3)).toBe(50);
    expect(usageAt(lin, t0 + 100 * 3600e3)).toBe(62);
  });
  it("computes the last-24h pace in points per hour", () => {
    expect(pace24h(lin)).toBeCloseTo(0.5);
    expect(pace24h([s(0, 1)])).toBeNull();
  });
  it("projects usage at reset", () => {
    expect(projectAtReset(lin, resetAt)).toBeCloseTo(86);
  });
  it("forecasts the stop time, or null if not before reset", () => {
    expect(stopForecast(lin, 80, resetAt)).toBe(t0 + 36 * 3600e3);
    expect(stopForecast(lin, 90, resetAt)).toBeNull();
    expect(stopForecast(lin, 60, resetAt)).toBeNull();
  });
  it("finds the latest false-to-true crossing", () => {
    expect(latestCrossing([s(-2, 40), s(-1, 60), s(0, 40), s(1, 70)], (x) => x.pct >= 50)).toBe(
      t0 + 3600e3,
    );
    expect(latestCrossing([s(0, 10)], (x) => x.pct >= 50)).toBeNull();
  });
  it("divides by the hours actually covered when samples span less than 24h (clamp)", () => {
    // 6h of samples, +6 points: 1 point/h, not 6/24.
    const six = [s(-6, 50), s(0, 56)];
    expect(pace24h(six)).toBeCloseTo(1);
    expect(projectAtReset(six, resetAt)).toBeCloseTo(56 + 48);
    expect(stopForecast(six, 80, resetAt)).toBe(t0 + 24 * 3600e3);
  });
  it("uses only the last 24h when samples span longer", () => {
    // Flat for the first day, then +12 over the last 24h: 0.5/h.
    const long = [s(-48, 50), s(-24, 50), s(0, 62)];
    expect(pace24h(long)).toBeCloseTo(0.5);
  });
  it("measures pace up to an explicit `at`", () => {
    // At t0-12h only 12h are covered (50 -> 56): 0.5/h, not 6/24.
    expect(pace24h(lin, t0 - 12 * 3600e3)).toBeCloseTo(0.5);
    // 56 at t0-12h, +0.5/h for the 60h left to reset.
    expect(projectAtReset(lin, resetAt, t0 - 12 * 3600e3)).toBeCloseTo(86);
    const late = [s(-24, 50), s(-12, 50), s(0, 62)];
    expect(pace24h(late, t0 - 12 * 3600e3)).toBeCloseTo(0);
  });
  it("zero or negative pace: no stop forecast, and the projection never falls below usage", () => {
    const flat = [s(-24, 40), s(0, 40)];
    expect(pace24h(flat)).toBeCloseTo(0);
    expect(projectAtReset(flat, resetAt)).toBeCloseTo(40);
    expect(stopForecast(flat, 80, resetAt)).toBeNull();
    const down = [s(-24, 45), s(0, 40)];
    expect(pace24h(down)).toBeLessThan(0);
    expect(projectAtReset(down, resetAt)).toBeCloseTo(40);
    expect(stopForecast(down, 80, resetAt)).toBeNull();
  });
  it("returns null pace, projection and forecast when samples span under 3h", () => {
    const short = [s(-2.9, 50), s(0, 53)];
    expect(pace24h(short)).toBeNull();
    expect(projectAtReset(short, resetAt)).toBeNull();
    expect(stopForecast(short, 80, resetAt)).toBeNull();
    expect(pace24h([s(-3, 50), s(0, 53)])).toBeCloseTo(1);
  });
  it("does not assume sorted input or mutate it", () => {
    const shuffled = [s(0, 62), s(-24, 50), s(-12, 56)];
    const copy = [...shuffled];
    expect(pace24h(shuffled)).toBeCloseTo(0.5);
    expect(usageAt(shuffled, t0 - 6 * 3600e3)).toBeCloseTo(59);
    expect(shuffled).toEqual(copy);
  });
});

describe("five-hour pace", () => {
  const ten = Date.UTC(2026, 9, 17, 10, 0);
  const f = (min: number, pct: number): UsageSample => ({
    accountId: "claude-main",
    window: "5h",
    at: ten + min * 60e3,
    pct,
    resetAt: ten + 4 * 3600e3,
    source: "test",
  });

  it("pace5h is points per hour from the first sample of the window", () => {
    expect(pace5h([f(0, 40), f(60, 60)])).toBeCloseTo(20);
    expect(pace5h([f(60, 60), f(0, 40)])).toBeCloseTo(20);
  });
  it("pace5h is null with one sample or under 30 minutes between them", () => {
    expect(pace5h([f(0, 40)])).toBeNull();
    expect(pace5h([f(0, 40), f(20, 50)])).toBeNull();
    expect(pace5h([f(0, 40), f(30, 50)])).toBeCloseTo(20);
  });
  it("fullAt5h is when the latest reading reaches 100 at that pace", () => {
    expect(fullAt5h([f(0, 40), f(60, 60)], ten + 4 * 3600e3)).toBe(ten + 3 * 3600e3);
  });
  it("fullAt5h is null when the window resets first, or the pace is not positive", () => {
    expect(fullAt5h([f(0, 40), f(60, 60)], ten + 2.5 * 3600e3)).toBeNull();
    expect(fullAt5h([f(0, 40), f(60, 40)], ten + 4 * 3600e3)).toBeNull();
    expect(fullAt5h([f(0, 40)], ten + 4 * 3600e3)).toBeNull();
  });
});
