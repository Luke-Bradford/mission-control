import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACE,
  DEFAULT_REPO_RULES,
  eligibleToStart,
  type PaceSettings,
  paceIsOn,
  paceRefusal,
} from "../src/index.ts";

const WEEKEND: PaceSettings = {
  on: true,
  until: 2000,
  since: 1000,
  labels: ["bug", "severity:low"],
  maxStarts: 2,
  note: "weekend",
};

describe("paceIsOn", () => {
  it("is off by default and normal never slows by itself", () => {
    expect(paceIsOn(DEFAULT_PACE, 1)).toBe(false);
    expect(paceIsOn({ ...WEEKEND, on: false }, 1500)).toBe(false);
  });
  it("is on until the end time, then normal resumes", () => {
    expect(paceIsOn(WEEKEND, 1999)).toBe(true);
    expect(paceIsOn(WEEKEND, 2000)).toBe(false);
  });
});

describe("paceRefusal", () => {
  it("lets a ticket with every named label start while starts are left", () => {
    expect(paceRefusal({ ...WEEKEND, startsLeft: 2 }, "mc#1", ["bug", "severity:low"])).toBeNull();
  });
  it("holds a ticket missing a label, and everything once the starts are used", () => {
    expect(paceRefusal({ ...WEEKEND, startsLeft: 2 }, "mc#1", ["bug"])).toMatch(/weekend/);
    expect(paceRefusal({ ...WEEKEND, startsLeft: 0 }, "mc#1", ["bug", "severity:low"])).toMatch(
      /no starts left/,
    );
  });
  it("names no labels means any ticket matches", () => {
    expect(paceRefusal({ ...WEEKEND, labels: [], startsLeft: 1 }, "mc#1", [])).toBeNull();
  });
});

describe("eligibleToStart with pace", () => {
  const base = {
    repoId: "mc",
    issue: 7,
    card: {
      labels: ["area:server", "bug"],
      assignees: [],
      blockedBy: [],
      size: "S",
      status: "Ready",
      state: "planned" as const,
      closed: false,
    },
    rules: { ...DEFAULT_REPO_RULES, areas: { "area:server": ["apps/server/**"] } },
    seat: { call: "GUIDO-1", area: ["apps/server/**"], loop: "build" as const },
    login: null,
    hasRun: false,
    lane: undefined,
    laneDefault: false,
    body: null,
    closed: () => undefined,
  };
  it("holds only a ticket the slow mode does not name", () => {
    const pace = { ...WEEKEND, startsLeft: 2 };
    expect(eligibleToStart({ ...base, pace })).toMatch(/weekend/);
    expect(
      eligibleToStart({
        ...base,
        card: { ...base.card, labels: [...base.card.labels, "severity:low"] },
        pace,
      }),
    ).toBeNull();
  });
  it("holds nothing for pace when there is no setting", () => {
    expect(eligibleToStart(base)).toBeNull();
  });
});
