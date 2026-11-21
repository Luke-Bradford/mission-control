import type { Telemetry } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  cacheHitPct,
  costCoverage,
  costPerMergedTicket,
  stackTokens,
} from "../src/telemetry/costMath.ts";

describe("stackTokens", () => {
  const rows = [
    { agentId: "a", points: [1, 2, 2] },
    { agentId: "b", points: [10, 10, 10] },
    { agentId: "c", points: [5, 0, 5] },
    { agentId: "d", points: [2, 2, 2] },
    { agentId: "e", points: [1, 1, 1] },
  ];
  it("keeps the three busiest seats and sums the rest into Other", () => {
    const layers = stackTokens(rows);
    expect(layers.map((l) => l.id)).toEqual(["b", "c", "d", "other"]);
    expect(layers[3]?.values).toEqual([2, 3, 3]);
  });
  it("layers sum to the total at every point", () => {
    const layers = stackTokens(rows);
    const total = rows[0]?.points.map((_, i) => rows.reduce((a, r) => a + (r.points[i] ?? 0), 0));
    const sum = layers[0]?.values.map((_, i) => layers.reduce((a, l) => a + (l.values[i] ?? 0), 0));
    expect(sum).toEqual(total);
  });
  it("has no Other layer when three seats or fewer are in view", () => {
    expect(stackTokens(rows.slice(0, 3)).map((l) => l.id)).toEqual(["b", "c", "a"]);
  });
});

describe("cost figures", () => {
  it("cache hit is the share of input served from cache, a dash when there is none", () => {
    expect(cacheHitPct({ tokens: 100, cacheRead: 300 })).toBe(75);
    expect(cacheHitPct({ tokens: 0, cacheRead: 0 })).toBeNull();
  });
  it("cost per merged ticket averages only tickets with a full cost", () => {
    expect(
      costPerMergedTicket([
        { ticket: "r#1", tokens: 1, costUsd: 1, totalCostUsd: 10 },
        { ticket: "r#2", tokens: 1, costUsd: 1, totalCostUsd: 20 },
        { ticket: "r#3", tokens: 1, costUsd: 1, totalCostUsd: null },
        { ticket: "r#4", tokens: 1, costUsd: 1 },
      ]),
    ).toBe(15);
    expect(costPerMergedTicket([{ ticket: "r#3", tokens: 1, costUsd: null }])).toBeNull();
  });
  it("coverage counts usage rows and names what is missing, never as zero", () => {
    const totals = [
      { agentId: "dev-1", model: "sonnet", costUsd: 1, input: 5, output: 5 },
      { agentId: "dev-2", model: "sonnet", costUsd: null, input: 5, output: 0 },
      { agentId: "dev-3", model: null, costUsd: null, input: 0, output: 0 },
      { agentId: "dev-4", model: "opus", costUsd: 2, input: 1, output: 1 },
    ] as Telemetry["totals"];
    const c = costCoverage(totals);
    expect(c.costPct).toBe(50);
    expect(c.tokensPct).toBe(75);
    expect(c.missingCost).toEqual(["dev-2 on sonnet", "dev-3"]);
    expect(c.missingTokens).toEqual(["dev-3"]);
    expect(costCoverage([]).costPct).toBeNull();
  });
});
