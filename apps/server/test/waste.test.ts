import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequestView, Run, WasteCheck } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { wasteReport } from "../src/spend/waste.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let dir: string;
let store: Store;

const config = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [
    { id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 },
    { id: "codex-main", vendor: "codex", alertAt: 70, stopAt: 80 },
  ],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/w",
    maxSeats: 4,
    sessions: [
      {
        id: "s",
        repoId: "mc",
        checkout: "/c",
        seats: [
          { id: "flight-1", role: "FLIGHT", accountId: "claude-main", area: [] },
          { id: "guido-1", role: "GUIDO", accountId: "claude-main", area: ["apps/server/**"] },
          { id: "guido-cx", role: "GUIDO", accountId: "codex-main", area: ["apps/web/**"] },
        ],
      },
    ],
  },
} as unknown as CcConfig;

let n = 0;
const run = (agentId: string, over: Partial<Run> = {}): Run => {
  n += 1;
  return {
    id: `r${n}`,
    agentId,
    repoId: "mc",
    seq: n,
    startedAt: NOW - MIN,
    endedAt: NOW - MIN / 2,
    status: "ok",
    sessionId: "cli",
    model: "m",
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath: "/x",
    prs: [],
    summary: null,
    ...over,
  };
};

beforeEach(() => {
  n = 0;
  dir = mkdtempSync(join(tmpdir(), "mc-waste-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const mergedPr = (number: number, branch: string, mergedAt: number): PullRequestView => ({
  repoId: "mc",
  number,
  title: `PR ${number}`,
  url: "u",
  branch,
  ticket: `mc#${number}`,
  state: "merged",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: mergedAt - HOUR,
  updatedAt: mergedAt,
  mergedAt,
  headSha: "h",
  mergeable: null,
});

const _checkOn = (runId: string, command: string, sha: string, at: number, ok = false) =>
  store.addCheckRun({ runId, command, headSha: sha, ok, exitCode: ok ? 0 : 1, at });

const _REVIEW_ROUNDS: WasteCheck = "review-rounds";

describe("the read route's report", () => {
  it("serves spend per merged change and the building share, with vendor coverage", () => {
    // Claude records a cost; Codex records tokens only (cost unknown, never zero)
    store.upsertRun(
      run("guido-1", {
        costUsd: 6,
        tokens: { input: 100, output: 50, cacheRead: 9999, cacheCreate: 50 },
      }),
    );
    store.upsertRun(
      run("flight-1", {
        costUsd: 4,
        tokens: { input: 100, output: 100, cacheRead: 0, cacheCreate: 0 },
      }),
    );
    store.upsertRun(
      run("guido-cx", {
        costUsd: null,
        tokens: { input: 300, output: 100, cacheRead: 0, cacheCreate: 0 },
      }),
    );
    const report = wasteReport(config, store, NOW);
    const day = report.spend.find((s) => s.window === "day");
    const week = report.spend.find((s) => s.window === "week");
    expect(report.spend.map((s) => s.window)).toEqual(["day", "week"]);
    expect(day).toMatchObject({
      merged: 0,
      costUsd: 10,
      runs: 3,
      runsWithCost: 2,
      perMergeUsd: null,
      tokens: 200 + 200 + 400,
    });
    // building: claude developer $6 of the $10 recorded; tokens: 200 + 400 of 800
    expect(day?.buildingShareUsd).toBeCloseTo(0.6);
    expect(day?.buildingShareTokens).toBeCloseTo(0.75);
    const codex = day?.vendors.find((v) => v.vendor === "codex");
    expect(codex).toMatchObject({ runs: 1, runsWithCost: 0, costUsd: null, tokens: 400 });
    expect(day?.vendors.find((v) => v.vendor === "claude")).toMatchObject({
      runs: 2,
      runsWithCost: 2,
      costUsd: 10,
    });
    expect(week?.merged).toBe(0);
  });

  it("divides by the changes merged in the window", () => {
    store.upsertRun(run("guido-1", { costUsd: 9 }));
    store.upsertPullRequests(
      "mc",
      [mergedPr(1, "a", NOW - HOUR), mergedPr(2, "b", NOW - 3 * DAY)],
      NOW,
    );
    const report = wasteReport(config, store, NOW);
    expect(report.spend.find((s) => s.window === "day")).toMatchObject({
      merged: 1,
      perMergeUsd: 9,
    });
    expect(report.spend.find((s) => s.window === "week")).toMatchObject({
      merged: 2,
      perMergeUsd: 4.5,
    });
  });
});

describe("FLIGHT's activity per day on the read route", () => {
  const tokens = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheCreate: 0 });

  it("counts wakes and FLIGHT's share of tokens in each 24-hour bucket", () => {
    store.upsertRun(run("flight-1", { startedAt: NOW - 2 * HOUR, tokens: tokens(300) }));
    store.upsertRun(run("guido-1", { startedAt: NOW - 3 * HOUR, tokens: tokens(700) }));
    store.upsertRun(run("flight-1", { startedAt: NOW - 30 * HOUR, tokens: tokens(100) }));
    for (const at of [NOW - HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR, NOW - 30 * HOUR])
      store.addFlightWake("r1", at, ["q"]);
    const days = wasteReport(config, store, NOW).flight;
    expect(days).toHaveLength(14);
    expect(days.at(-1)?.since).toBe(NOW - DAY);
    expect(days.at(-1)).toMatchObject({
      wakes: 3,
      flightTokens: 300,
      totalTokens: 1000,
    });
    expect(days.at(-1)?.tokenShare).toBeCloseTo(0.3);
    expect(days.at(-2)).toMatchObject({ wakes: 1, flightTokens: 100, totalTokens: 100 });
    expect(days.at(-2)?.tokenShare).toBe(1);
    expect(days[0]).toMatchObject({ wakes: 0, totalTokens: 0, tokenShare: null });
  });
});
