import { describe, expect, it } from "vitest";
import { agentState, compactUtc, inferTicket } from "../src/runs.ts";
import type { Run } from "../src/types.ts";

function run(over: Partial<Run>): Run {
  return {
    id: "r",
    agentId: "a",
    repoId: "shop-app",
    seq: 1,
    startedAt: 100,
    endedAt: 200,
    status: "ok",
    sessionId: null,
    model: null,
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath: "",
    prs: [],
    summary: null,
    ...over,
  } as Run;
}
const base = { paused: false, sourceError: null, waitingOnOperator: false };

describe("inferTicket", () => {
  it("maps loop branch names", () => {
    expect(inferTicket("fix/3349-cart-total-rounding", "shop-app")).toBe("shop-app#3349");
    expect(inferTicket("feature/3822-wishlist-sync", "shop-app")).toBe("shop-app#3822");
    expect(inferTicket("feat/studio-1745-run-panel", "site-builder")).toBe("site-builder#1745");
    expect(inferTicket("fix/loop-812-x", "site-builder")).toBe("site-builder#812");
  });
  it("accepts docs/ and chore/ branches", () => {
    expect(inferTicket("docs/1600-x", "site-builder")).toBe("site-builder#1600");
    expect(inferTicket("docs/3714-returns-policy-spec", "shop-app")).toBe("shop-app#3714");
    expect(inferTicket("chore/studio-55", "site-builder")).toBe("site-builder#55");
    expect(inferTicket("docs/readme-tweak", "shop-app")).toBeNull();
  });
  it("returns null otherwise", () => {
    expect(inferTicket("main", "shop-app")).toBeNull();
    expect(inferTicket(null, "shop-app")).toBeNull();
  });
});

describe("agentState", () => {
  it("sourceError wins", () => {
    const runs = [
      run({ status: "running", startedAt: 50, endedAt: null }),
      run({ startedAt: 100, endedAt: 200 }),
    ];
    expect(agentState({ ...base, runs, sourceError: "boom" })).toEqual({
      state: "error",
      since: 200,
    });
    expect(agentState({ ...base, runs: [], sourceError: "boom" })).toEqual({
      state: "error",
      since: 0,
    });
  });
  it("running run means working, newest startedAt", () => {
    const runs = [
      run({ status: "running", startedAt: 10, endedAt: null }),
      run({ status: "running", startedAt: 30, endedAt: null }),
      run({ status: "blocked", startedAt: 20 }),
    ];
    expect(agentState({ ...base, runs, waitingOnOperator: true })).toEqual({
      state: "working",
      since: 30,
    });
  });
  it("blocked latest run or waitingOnOperator means waiting-you", () => {
    expect(
      agentState({ ...base, runs: [run({ status: "blocked", startedAt: 5, endedAt: 9 })] }),
    ).toEqual({ state: "waiting-you", since: 9 });
    expect(
      agentState({
        ...base,
        runs: [run({ startedAt: 5, endedAt: null })],
        waitingOnOperator: true,
      }),
    ).toEqual({ state: "waiting-you", since: 5 });
    expect(agentState({ ...base, runs: [], waitingOnOperator: true })).toEqual({
      state: "waiting-you",
      since: 0,
    });
  });
  it("otherwise idle, including paused and no runs", () => {
    expect(
      agentState({ ...base, runs: [run({ startedAt: 1, endedAt: 7 })], paused: true }),
    ).toEqual({ state: "idle", since: 7 });
    expect(agentState({ ...base, runs: [] })).toEqual({ state: "idle", since: 0 });
  });
  it("does not mutate input", () => {
    const runs = [run({ startedAt: 1 }), run({ startedAt: 9 })];
    agentState({ ...base, runs });
    expect(runs.map((r) => r.startedAt)).toEqual([1, 9]);
  });
});

describe("compactUtc", () => {
  it("stamps an instant so the text sorts by time", () => {
    expect(compactUtc(Date.parse("2026-10-19T12:00:00.123Z"))).toBe("20261019T120000Z");
  });
});
