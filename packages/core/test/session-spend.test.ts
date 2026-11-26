import { describe, expect, it } from "vitest";
import {
  FAST_PRICE_MULTIPLIER,
  priceFor,
  type SpendTokens,
  tokensCostUsd,
} from "../src/session-spend.ts";

const M = 1_000_000;
const none: SpendTokens = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

describe("session spend prices", () => {
  it("prices each token kind", () => {
    const cost = (k: keyof SpendTokens) => tokensCostUsd("claude-opus-5-5", { ...none, [k]: M });
    expect(cost("input")).toBeCloseTo(4);
    expect(cost("output")).toBeCloseTo(20);
    expect(cost("cacheWrite5m")).toBeCloseTo(5);
    expect(cost("cacheWrite1h")).toBeCloseTo(8);
    expect(cost("cacheRead")).toBeCloseTo(0.2);
    expect(tokensCostUsd("gpt-9", { ...none, input: M })).toBeNull();
  });

  it("takes the longest matching prefix, and a cache read without its own figure is 0.1x input", () => {
    expect(priceFor("claude-opus-5-5-20261101")?.input).toBe(4);
    expect(priceFor("claude-opus-5-20260601")?.input).toBe(5);
    expect(priceFor("claude-opus-5")?.cacheRead).toBeCloseTo(0.5);
    expect(priceFor("claude-sonnet-5-5[1m]")?.cacheRead).toBeCloseTo(0.1);
    expect(priceFor("<synthetic>")).toBeNull();
  });

  it("multiplies a fast message", () => {
    const t = { ...none, output: M };
    expect(tokensCostUsd("claude-opus-5-5", t, true)).toBeCloseTo(20 * FAST_PRICE_MULTIPLIER);
  });
});
