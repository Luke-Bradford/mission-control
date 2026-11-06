import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunTokenAudit, TokenAuditView } from "@mc/core";
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
});
