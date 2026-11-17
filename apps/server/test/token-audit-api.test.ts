import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PullRequestView,
  Run,
  RunTokenAudit,
  TokenAuditFigures,
  TokenAuditView,
  TokenCall,
} from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const DAY = 86_400_000;

const config = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/w",
    maxSeats: 2,
    sessions: [
      {
        id: "s",
        repoId: "repo",
        checkout: "/tmp/c",
        seats: [
          { id: "dev-1", role: "developer", accountId: "a", model: "m", area: [] },
          { id: "rev-1", role: "reviewer", accountId: "a", model: "m", area: [] },
        ],
      },
    ],
  },
} as unknown as CcConfig;

const run = (id: string, agentId: string, startedAt: number): Run => ({
  id,
  agentId,
  repoId: "repo",
  seq: 1,
  startedAt,
  endedAt: startedAt + 1000,
  status: "ok",
  sessionId: null,
  model: null,
  branch: null,
  ticket: null,
  costUsd: 2,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
});

const audit = (over: Partial<RunTokenAudit>): RunTokenAudit => ({
  calls: 10,
  peakContext: 90_000,
  medianContext: 60_000,
  cacheRead: 500_000,
  cacheWrite: 50_000,
  output: 4_000,
  rewrites: 1,
  rewriteTokens: 30_000,
  readAfterReport: 100_000,
  bySource: {},
  byCommand: {},
  ...over,
});

const withFlight = {
  ...config,
  crew: {
    ...config.crew,
    sessions: [
      {
        id: "s",
        repoId: "repo",
        checkout: "/tmp/c",
        seats: [
          { id: "dev-1", role: "developer", accountId: "a", model: "m", area: [] },
          { id: "rev-1", role: "reviewer", accountId: "a", model: "m", area: [] },
          { id: "flight-1", role: "FLIGHT", accountId: "a", model: "m", area: [] },
        ],
      },
    ],
  },
} as unknown as CcConfig;

const call = (context: number): TokenCall => ({
  context,
  cacheRead: 0,
  cacheWrite: 0,
  output: 1,
  added: [],
});

const pr = (number: number, ticket: string): PullRequestView =>
  ({
    repoId: "repo",
    number,
    title: "t",
    url: "u",
    branch: `b${number}`,
    ticket,
    state: "merged",
    isDraft: false,
    review: null,
    ci: null,
    createdAt: 1,
    updatedAt: 1,
    mergedAt: NOW - DAY,
    headSha: "a".repeat(40),
    mergeable: null,
    changedFiles: 0,
    files: [],
  }) as PullRequestView;

let dir: string;
let store: Store;
let app: FastifyInstance;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-token-api-"));
  store = new Store(join(dir, "mc.sqlite"));
  app = buildApp({ config, store, bus: new ChangeBus(), now: () => NOW });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/audit/tokens", () => {
  it("returns totals by role, by source and by command for the window", async () => {
    store.upsertRun(run("r-dev", "dev-1", NOW - DAY));
    store.upsertRun(run("r-rev", "rev-1", NOW - 2 * DAY));
    store.upsertRun(run("r-old", "dev-1", NOW - 30 * DAY));
    store.saveRunTokenAudit(
      "r-dev",
      NOW,
      audit({
        bySource: {
          Bash: { added: 1000, reread: 8000, events: 2 },
          Read: { added: 500, reread: 2000, events: 1 },
        },
        byCommand: { "pnpm test": { added: 1000, reread: 8000, events: 2 } },
      }),
      [],
    );
    store.saveRunTokenAudit(
      "r-rev",
      NOW,
      audit({
        calls: 4,
        peakContext: 50_000,
        bySource: { Bash: { added: 100, reread: 400, events: 1 } },
        byCommand: { git: { added: 100, reread: 400, events: 1 } },
        readAfterReport: null,
      }),
      [],
    );
    store.saveRunTokenAudit(
      "r-old",
      NOW,
      audit({ bySource: { Bash: { added: 9, reread: 9, events: 1 } } }),
      [],
    );

    const res = await app.inject({ method: "GET", url: "/api/audit/tokens?days=7" });
    expect(res.statusCode).toBe(200);
    const v = res.json<TokenAuditView>();
    expect(v.days).toBe(7);
    expect(v.runs).toBe(2);
    expect(v.calls).toBe(14);
    expect(v.reread).toBe(10_400);
    expect(v.rewrites).toBe(2);
    expect(v.byRole.map((r) => [r.role, r.runs, r.reread])).toEqual([
      ["developer", 1, 10_000],
      ["reviewer", 1, 400],
    ]);
    expect(v.bySource.map((s) => [s.name, s.reread, s.events])).toEqual([
      ["Bash", 8400, 3],
      ["Read", 2000, 1],
    ]);
    expect(v.byCommand.map((c) => [c.name, c.reread])).toEqual([
      ["pnpm test", 8000],
      ["git", 400],
    ]);
    expect(v.topRuns.map((r) => r.runId)).toEqual(["r-dev", "r-rev"]);
    expect(v.topRuns[0]?.readAfterReportShare).toBeCloseTo(0.2);
    expect(v.topRuns[1]?.readAfterReportShare).toBeNull();
    expect(v.controller).toBeNull();
  });

  it("answers 400 for a days value that is not a whole number from 1 to 365", async () => {
    for (const days of ["0", "abc", "366", "-1", "1.5"]) {
      const res = await app.inject({ method: "GET", url: `/api/audit/tokens?days=${days}` });
      expect(res.statusCode, days).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: "/api/audit/tokens" })).statusCode).toBe(200);
  });

  it("names the run and ticket behind each row", async () => {
    store.upsertRun({ ...run("r-a", "dev-1", NOW - DAY), ticket: "repo#1" });
    store.upsertRun({ ...run("r-b", "dev-1", NOW - DAY), seq: 2, ticket: "repo#2" });
    store.saveRunTokenAudit(
      "r-a",
      NOW,
      audit({
        bySource: { Bash: { added: 10, reread: 100, events: 1 } },
        byCommand: { git: { added: 10, reread: 100, events: 1 } },
      }),
      [],
    );
    store.saveRunTokenAudit(
      "r-b",
      NOW,
      audit({
        bySource: { Bash: { added: 10, reread: 300, events: 1 } },
        byCommand: { git: { added: 10, reread: 300, events: 1 } },
      }),
      [],
    );
    store.recordPromptSections("r-a", 0, NOW - DAY, [
      { section: "tool_results", bytes: 40, tokens: 10 },
    ]);
    store.recordPromptSections("r-b", 0, NOW - DAY, [
      { section: "tool_results", bytes: 400, tokens: 100 },
    ]);
    const v = (
      await app.inject({ method: "GET", url: "/api/audit/tokens?days=7" })
    ).json<TokenAuditView>();
    expect(v.topRuns.map((r) => [r.runId, r.ticket])).toEqual([
      ["r-b", "repo#2"],
      ["r-a", "repo#1"],
    ]);
    expect(v.bySource[0]?.topRun).toEqual({
      runId: "r-b",
      agentId: "dev-1",
      ticket: "repo#2",
      value: 300,
    });
    expect(v.byCommand[0]?.topRun?.runId).toBe("r-b");
    expect(v.hubSections[0]?.topRun).toEqual({
      runId: "r-b",
      agentId: "dev-1",
      ticket: "repo#2",
      value: 100,
    });
  });

  it("records each figure with its window and unit, or names why it is not recorded", async () => {
    app = buildApp({ config: withFlight, store, bus: new ChangeBus(), now: () => NOW });
    await app.ready();
    store.upsertRun({ ...run("r-a", "dev-1", NOW - DAY), ticket: "repo#1", costUsd: 4 });
    store.upsertRun({ ...run("r-b", "dev-1", NOW - DAY), seq: 2, ticket: "repo#2", costUsd: 6 });
    store.upsertRun({ ...run("rv-1", "rev-1", NOW - DAY), ticket: "repo#1", reviewId: 11 });
    store.upsertRun({ ...run("rv-2", "rev-1", NOW - DAY), seq: 2, ticket: "repo#1", reviewId: 12 });
    store.upsertRun({ ...run("f-1", "flight-1", NOW - DAY) });
    store.saveRunTokenAudit("r-a", NOW, audit({ peakContext: 300_000 }), [
      call(100),
      call(200),
      call(300),
      call(400),
      call(300_000),
    ]);
    store.saveRunTokenAudit("r-b", NOW, audit({ peakContext: 50_000 }), [call(50_000)]);
    store.upsertPullRequests("repo", [pr(1, "repo#1"), pr(2, "repo#2")], NOW);
    store.addFlightWake("f-1", NOW - 3 * 3_600_000, ["q"]);
    store.addFlightWake("f-1", NOW - 2 * 3_600_000, ["ci"]);
    store.addFlightWake("f-1", NOW - 3_600_000, ["q"]);
    // Context at a wake is the latest usage at or before it; the last entry follows every wake.
    const usage = (at: number, context: number) => ({
      id: `m${at}`,
      at,
      tokens: context,
      usage: { input: context - 800, output: 5, cacheRead: 700, cacheCreate: 100 },
    });
    store.setDigest("f-1", {
      toolCalls: 0,
      turns: 0,
      lastEventAt: null,
      attemptUsage: [
        usage(NOW - 4 * 3_600_000, 1000),
        usage(NOW - 2.5 * 3_600_000, 5000),
        usage(NOW - 1.2 * 3_600_000, 9000),
        usage(NOW - 30 * 60_000, 777_777),
      ],
    } as never);
    store.addFlightDecision({
      at: NOW - 2 * 3_600_000 + 1000,
      kind: "answer",
      seatId: "flight-1",
      targetRunId: null,
      ref: null,
      questionId: null,
      about: "x",
      decision: "y",
      basis: "z",
    });
    const v = (
      await app.inject({ method: "GET", url: "/api/audit/tokens?days=7" })
    ).json<TokenAuditView>();
    const f = v.figures as TokenAuditFigures;

    const ctx = f.contextByRole;
    expect(ctx).toMatchObject({ recorded: true, days: 7, unit: "tokens per model call" });
    if (!ctx.recorded) throw new Error("context");
    const dev = ctx.value.find((r) => r.role === "developer");
    expect(dev?.calls).toBe(6);
    expect(dev?.p90Context).toBe(300_000);
    expect(dev?.budget).toBeGreaterThan(0);

    const over = f.overBudget;
    expect(over).toMatchObject({ recorded: true, days: 7, unit: "runs" });
    if (!over.recorded) throw new Error("over");
    expect(over.value.count).toBe(1);
    expect(over.value.runs[0]).toMatchObject({ runId: "r-a", ticket: "repo#1" });

    for (const key of ["longPassingCommands", "repeatedPrompt", "rewriteWait"] as const) {
      const fig = f[key];
      expect(fig.recorded, key).toBe(false);
      if (!fig.recorded) expect(fig.reason.length, key).toBeGreaterThan(10);
    }

    const rev = f.reviewRunsPerTicket;
    expect(rev).toMatchObject({ recorded: true, days: 7, unit: "review runs" });
    if (!rev.recorded) throw new Error("rev");
    expect(rev.value).toEqual([{ ticket: "repo#1", runs: 2, latestRunId: "rv-2" }]);

    const fl = f.flight;
    expect(fl).toMatchObject({ recorded: true, days: 7, unit: "wakes" });
    if (!fl.recorded) throw new Error("flight");
    expect(fl.value.wakes).toBe(3);
    expect(fl.value.wakesWithNoDecision).toBe(2);
    expect(fl.value.sessions).toBe(1);
    expect(fl.value.sessionsPerDay).toBeCloseTo(1 / 7);
    expect(fl.value.contextAtWake).toEqual({
      recorded: true,
      days: 7,
      unit: "tokens",
      value: { median: 5000, p90: 9000, samples: 3 },
    });
    expect(fl.value.startCost).toMatchObject({ usd: expect.any(Number) });

    const cost = f.costPerMergedPr;
    expect(cost).toMatchObject({ recorded: true, days: 7, unit: "USD per merged PR" });
    if (!cost.recorded) throw new Error("cost");
    expect(cost.value.mergedPrs).toBe(2);
    expect(cost.value.byRole).toEqual([
      {
        role: "developer",
        usd: 10,
        perPr: 5,
        topRun: { runId: "r-b", agentId: "dev-1", ticket: "repo#2", value: 6 },
      },
      expect.objectContaining({ role: "reviewer", usd: 4, perPr: 2 }),
    ]);
  });

  it("names the reason where there is nothing to compute from", async () => {
    const v = (
      await app.inject({ method: "GET", url: "/api/audit/tokens?days=7" })
    ).json<TokenAuditView>();
    for (const key of ["flight", "costPerMergedPr", "reviewRunsPerTicket"] as const) {
      const fig = (v.figures as TokenAuditFigures)[key];
      expect(fig.recorded, key).toBe(false);
      if (!fig.recorded) expect(fig.reason.length, key).toBeGreaterThan(10);
    }
    expect(v.figures?.contextByRole.recorded).toBe(false);
  });
});
