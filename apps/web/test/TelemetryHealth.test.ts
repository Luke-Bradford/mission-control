import type { CrewRow } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  type CrewCounts,
  crewCounts,
  crewVerdict,
  type QuotaWindow,
  tightestQuota,
} from "../src/telemetry/health.ts";

const quota = (over: Partial<QuotaWindow> = {}): QuotaWindow => ({
  name: "acct-a · 7d",
  pct: 40,
  alertAt: 80,
  stopAt: 95,
  resetAt: null,
  ...over,
});
const crew = (over: Partial<CrewCounts> = {}): CrewCounts => ({
  running: 9,
  configured: 11,
  waiting: 0,
  stalled: 0,
  ...over,
});
const verdict = (over: Partial<Parameters<typeof crewVerdict>[0]> = {}) =>
  crewVerdict({ quotas: [quota()], machineWarning: null, crew: crew(), ...over });

describe("the crew verdict", () => {
  it("is Healthy with nothing to flag, and says how many seats run", () => {
    expect(verdict()).toEqual({ word: "Healthy", reason: "9 of 11 seats running" });
  });

  it("is Needs attention for a quota at its stop level, naming the window", () => {
    expect(verdict({ quotas: [quota(), quota({ name: "acct-b · 5h", pct: 96 })] })).toEqual({
      word: "Needs attention",
      reason: "acct-b · 5h at stop level",
    });
  });

  it("is Needs attention for a machine capacity warning", () => {
    expect(verdict({ machineWarning: "memory low" })).toEqual({
      word: "Needs attention",
      reason: "machine at its capacity warning",
    });
  });

  it.each([
    [1, "1 seat stalled or in error"],
    [2, "2 seats stalled or in error"],
  ])("is Needs attention for %s stalled or errored seats", (stalled, reason) => {
    expect(verdict({ crew: crew({ stalled }) })).toEqual({ word: "Needs attention", reason });
  });

  it("is Watch for a quota at its alert level", () => {
    expect(verdict({ quotas: [quota({ pct: 80 })] })).toEqual({
      word: "Watch",
      reason: "acct-a · 7d at alert level",
    });
  });

  it.each([
    [1, "9 of 11 running · 1 question waiting"],
    [3, "9 of 11 running · 3 questions waiting"],
  ])("is Watch while %s seat questions wait", (waiting, reason) => {
    expect(verdict({ crew: crew({ waiting }) })).toEqual({ word: "Watch", reason });
  });

  it("puts Needs attention above Watch when both apply", () => {
    expect(
      verdict({ quotas: [quota({ pct: 85 })], crew: crew({ stalled: 1, waiting: 2 }) }).word,
    ).toBe("Needs attention");
  });
});

it("counts seats by state", () => {
  const rows = [
    { hudState: "running" },
    { hudState: "running" },
    { hudState: "waiting" },
    { hudState: "stalled" },
    { hudState: "error" },
    { hudState: "idle" },
  ] as CrewRow[];
  expect(crewCounts(rows)).toEqual({ running: 2, configured: 6, waiting: 1, stalled: 2 });
});

it("picks the quota window with the highest used share", () => {
  expect(tightestQuota([])).toBeNull();
  expect(
    tightestQuota([quota({ pct: 10 }), quota({ name: "b", pct: 70 }), quota({ pct: 30 })])?.name,
  ).toBe("b");
});
