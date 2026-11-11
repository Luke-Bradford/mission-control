import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Run, TokenAuditSummary, TokenAuditView, TokenCall, TokenSourceAdd } from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { auditEndedRuns, auditTranscript } from "../src/token-audit/audit.ts";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
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

const run = (id: string, agentId: string, startedAt: number, over: Partial<Run> = {}): Run => ({
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
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

interface Frame {
  at: number | null;
  id: string;
  context: number;
  out: number;
  /** A tool the call used; its result arrives before the next call. */
  tool?: { name: string; chars: number };
}

/** A transcript whose assistant frames carry a timestamp, as the hub's own transcript files do. */
const transcript = (frames: Frame[]): string[] => {
  const lines: string[] = [];
  let prevTool: Frame["tool"];
  frames.forEach((f, i) => {
    if (prevTool !== undefined) {
      lines.push(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: `t${i - 1}`,
                content: "x".repeat(prevTool.chars),
              },
            ],
          },
        }),
      );
    }
    lines.push(
      JSON.stringify({
        type: "assistant",
        ...(f.at === null ? {} : { timestamp: new Date(f.at).toISOString() }),
        message: {
          id: f.id,
          content:
            f.tool === undefined
              ? []
              : [{ type: "tool_use", id: `t${i}`, name: f.tool.name, input: {} }],
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: f.context - 100,
            cache_creation_input_tokens: 100,
            output_tokens: f.out,
          },
        },
      }),
    );
    prevTool = f.tool;
  });
  return lines;
};

/** A run that began a day and a half ago and is still calling: two calls before the window, two in it. */
const OLD_RUN: Frame[] = [
  {
    at: NOW - DAY - 12 * HOUR,
    id: "a1",
    context: 1000,
    out: 10,
    tool: { name: "Bash", chars: 400 },
  },
  { at: NOW - 3 * HOUR, id: "a2", context: 2000, out: 20, tool: { name: "Read", chars: 400 } },
  // Exactly an hour back: the window is (from, now], so this call is out.
  { at: NOW - HOUR, id: "a3", context: 3000, out: 30, tool: { name: "Bash", chars: 400 } },
  { at: NOW - HOUR + MIN, id: "a4", context: 4000, out: 40, tool: { name: "Read", chars: 400 } },
  { at: NOW - 10 * MIN, id: "a5", context: 5000, out: 50 },
];
const NEW_RUN: Frame[] = [
  { at: NOW - 30 * MIN, id: "b1", context: 800, out: 5, tool: { name: "Bash", chars: 200 } },
  { at: NOW - 20 * MIN, id: "b2", context: 1500, out: 7 },
];

let dir: string;
let store: Store;
let app: FastifyInstance;
const appAt = async (now: number) => {
  const a = buildApp({ config, store, bus: new ChangeBus(), now: () => now });
  await a.ready();
  return a;
};
const save = (r: Run, frames: Frame[]) => {
  store.upsertRun(r);
  const { audit, calls } = auditTranscript(transcript(frames));
  store.saveRunTokenAudit(r.id, NOW, audit, calls);
  return calls;
};
const get = async <T>(url: string, a: FastifyInstance = app): Promise<T> => {
  const res = await a.inject({ method: "GET", url });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<T>();
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-token-window-"));
  store = new Store(join(dir, "mc.sqlite"));
  app = await appAt(NOW);
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Event receipts: what the transcript's calls say for the window, summed with no help from the view. */
const receipts = (calls: TokenCall[], from: number, to: number) => {
  const inside = calls.filter((c) => c.at != null && c.at > from && c.at <= to);
  const bySource = new Map<string, number>();
  for (const c of inside)
    for (const a of c.added) bySource.set(a.source, (bySource.get(a.source) ?? 0) + a.tokens);
  return {
    calls: inside.length,
    output: inside.reduce((s, c) => s + c.output, 0),
    bySource,
  };
};

describe("GET /api/audit/tokens?hours=", () => {
  it("counts calls by when they were made, including an old run's new calls, and matches the receipts", async () => {
    const oldCalls = save(run("r-old", "dev-1", NOW - DAY - 12 * HOUR), OLD_RUN);
    const newCalls = save(run("r-new", "rev-1", NOW - 30 * MIN), NEW_RUN);
    const from = NOW - HOUR;

    const v = await get<TokenAuditView>("/api/audit/tokens?hours=1");
    expect(v).toMatchObject({ hours: 1, basis: "events", runs: 2, since: from });
    // a4 and a5 are in; a3 is exactly an hour back and out. Both of the new run's calls are in.
    const old = receipts(oldCalls, from, NOW);
    const fresh = receipts(newCalls, from, NOW);
    expect(old.calls).toBe(2);
    expect(v.calls).toBe(old.calls + fresh.calls);
    expect(v.output).toBe(old.output + fresh.output);
    expect(v.output).toBe(40 + 50 + 5 + 7);
    expect(v.byRole.map((r) => [r.role, r.runs, r.calls, r.output])).toEqual(
      expect.arrayContaining([
        ["developer", 1, 2, 90],
        ["reviewer", 1, 2, 12],
      ]),
    );
    const want = new Map(old.bySource);
    for (const [k, t] of fresh.bySource) want.set(k, (want.get(k) ?? 0) + t);
    expect(new Map(v.bySource.map((s) => [s.name, s.added]))).toEqual(want);
    // a4's Bash result (arrived for a4) is re-read by a4 and a5; a5's Read by a5 alone.
    const a4 = oldCalls[3]?.added.find((a) => a.source === "Bash");
    expect(v.bySource.find((s) => s.name === "Bash")?.reread).toBeGreaterThanOrEqual(
      (a4?.tokens ?? 0) * 2,
    );
    // Cache figures are summed from the calls in the window, not shared out from the run.
    expect(v.cacheRead).toBe(
      [...oldCalls.slice(3), ...newCalls].reduce((s, c) => s + c.cacheRead, 0),
    );
    expect(v.figures?.contextByRole).toMatchObject({ recorded: true });
  });

  it("is a different cut from days: days=1 drops a run that started earlier, hours=24 keeps its calls", async () => {
    save(run("r-old", "dev-1", NOW - DAY - 12 * HOUR), OLD_RUN);
    const days = await get<TokenAuditView>("/api/audit/tokens?days=1");
    expect(days.runs).toBe(0);
    expect(days.basis).toBe("runs");
    const hours = await get<TokenAuditView>("/api/audit/tokens?hours=24");
    expect(hours.runs).toBe(1);
    // a2 (3h ago), a3, a4, a5: a1 is 36 hours back.
    expect(hours.calls).toBe(4);
  });

  it("says complete with real zeros for a covered, empty window, and names a gap otherwise", async () => {
    save(run("r-old", "dev-1", NOW - DAY - 12 * HOUR), OLD_RUN);
    // Ten hours on, nothing overlaps the last hour and every run is read and timed: a true zero.
    const later = await appAt(NOW + 10 * HOUR);
    const empty = await get<TokenAuditView>("/api/audit/tokens?hours=1", later);
    await later.close();
    expect(empty.calls).toBe(0);
    expect(empty.coverage).toMatchObject({ status: "complete", reason: null });

    // A run that ran in the window whose audit is not stored yet: its calls are unknown.
    store.upsertRun(run("r-live", "rev-1", NOW - 20 * MIN, { endedAt: null, status: "running" }));
    const pending = await get<TokenAuditView>("/api/audit/tokens?hours=1");
    expect(pending.coverage).toMatchObject({ status: "partial", pendingRuns: 1, untimedRuns: 0 });
    expect(pending.coverage?.reason).toContain("no token audit stored yet");
  });

  it("names audits stored without call times, and is unavailable when nothing timed is in the window", async () => {
    // Stored before call times existed: the calls have none.
    const untimed = transcript([
      { at: null, id: "u1", context: 1000, out: 5 },
      { at: null, id: "u2", context: 1500, out: 5 },
    ]);
    store.upsertRun(run("r-untimed", "dev-1", NOW - 30 * MIN, { seq: 2 }));
    const { audit, calls } = auditTranscript(untimed);
    store.saveRunTokenAudit("r-untimed", NOW, audit, calls);
    const v = await get<TokenAuditView>("/api/audit/tokens?hours=1");
    expect(v.calls).toBe(0);
    expect(v.coverage).toMatchObject({ status: "unavailable", untimedRuns: 1 });
    expect(v.coverage?.reason).toContain("without a time");

    // With a timed run beside it the window is partial: some data, named gaps.
    save(run("r-new", "rev-1", NOW - 30 * MIN, { seq: 3 }), NEW_RUN);
    const both = await get<TokenAuditView>("/api/audit/tokens?hours=1");
    expect(both.calls).toBe(2);
    expect(both.coverage).toMatchObject({ status: "partial", untimedRuns: 1 });
  });

  it("refuses an hours value outside 1..24, or sent with days", async () => {
    for (const q of ["hours=0", "hours=25", "hours=x", "hours=1&days=1", "hours=1&shape=full"]) {
      const res = await app.inject({ method: "GET", url: `/api/audit/tokens?${q}` });
      expect(res.statusCode, q).toBe(400);
    }
    const ok = await app.inject({ method: "GET", url: "/api/audit/tokens?hours=24" });
    expect(ok.statusCode).toBe(200);
  });
});

describe("call times of a stored audit", () => {
  it("are back-filled once from a retained transcript; one that cannot give them stays untimed", async () => {
    mkdirSync(join(dir, "crew"));
    const path = join(dir, "crew", "r-back.jsonl");
    writeFileSync(path, `${transcript(NEW_RUN).join("\n")}\n`);
    store.upsertRun(run("r-back", "rev-1", NOW - 30 * MIN, { transcriptPath: path }));
    store.upsertRun(run("r-gone", "rev-1", NOW - 30 * MIN, { seq: 2 }));
    // Both were stored by the version that kept no call times.
    const stamp = (id: string) => {
      const { audit, calls } = auditTranscript(transcript(NEW_RUN));
      store.saveRunTokenAudit(
        id,
        NOW,
        audit,
        calls.map((c) => ({ ...c, at: null })),
      );
      (store as unknown as { db: DatabaseSync }).db
        .prepare("UPDATE run_token_audit SET timestamps_checked = 0 WHERE run_id = ?")
        .run(id);
    };
    stamp("r-back");
    stamp("r-gone");
    expect(store.runTokenCalls("r-back").map((c) => c.at)).toEqual([null, null]);

    await auditEndedRuns({ store, config, now: NOW });
    expect(store.runTokenCalls("r-back").map((c) => c.at)).toEqual([
      NOW - 30 * MIN,
      NOW - 20 * MIN,
    ]);
    expect(store.runTokenCalls("r-gone").map((c) => c.at)).toEqual([null, null]);
    // Neither is tried again.
    expect(store.runsToRetimeTokens(10)).toEqual([]);
  });
});

describe("GET /api/audit/tokens?shape=summary", () => {
  /** Many roles' worth of sources and commands in the window, so the full read is long. */
  const seedMany = () => {
    for (let r = 0; r < 6; r++) {
      const agent = r % 2 === 0 ? "dev-1" : "rev-1";
      const id = `r-big-${r}`;
      store.upsertRun(run(id, agent, NOW - 40 * MIN, { seq: r + 1, ticket: `repo#${r}` }));
      const calls: TokenCall[] = [];
      for (let c = 0; c < 4; c++) {
        const added: TokenSourceAdd[] = [];
        for (let s = 0; s < 60; s++) {
          added.push({
            source: `mcp tool number ${s} with a long descriptive name`,
            command: c === 0 ? null : `command-${s}-${(r + c) % 7}`,
            tokens: 10 + ((s * 7 + r + c) % 90),
          });
        }
        calls.push({
          at: NOW - (30 - r * 3 - c) * MIN,
          context: 1000 * (c + 1),
          cacheRead: 500,
          cacheWrite: 100,
          output: 20,
          added,
        });
      }
      const { audit } = auditTranscript([]);
      store.saveRunTokenAudit(id, NOW, { ...audit, calls: calls.length }, calls);
    }
  };

  const sum = (xs: { added: number; reread: number; events: number }[]) => ({
    added: xs.reduce((s, x) => s + x.added, 0),
    reread: xs.reduce((s, x) => s + x.reread, 0),
    events: xs.reduce((s, x) => s + x.events, 0),
  });

  it("lists the top 15 with an other row so the totals equal the full read, under 20,000 characters", async () => {
    seedMany();
    for (const q of ["hours=1", "hours=24"]) {
      const full = await get<TokenAuditView>(`/api/audit/tokens?${q}`);
      const res = await app.inject({ method: "GET", url: `/api/audit/tokens?${q}&shape=summary` });
      expect(res.statusCode).toBe(200);
      expect(res.body.length, q).toBeLessThan(20_000);
      const s = res.json<TokenAuditSummary>();
      expect(full.bySource.length).toBeGreaterThan(15);
      expect(s.bySource).toHaveLength(16);
      expect(s.bySource.at(-1)?.name).toBe("other");
      expect(s.byCommand.at(-1)?.name).toBe("other");
      expect(s.bySource.slice(0, 15).map((r) => r.name)).toEqual(
        full.bySource.slice(0, 15).map((r) => r.name),
      );
      expect(sum(s.bySource)).toEqual(sum(full.bySource));
      expect(sum(s.byCommand)).toEqual(sum(full.byCommand));
      expect(s.otherSources).toBe(full.bySource.length - 15);
      expect(s.reread).toBe(full.reread);
      expect(s.calls).toBe(full.calls);
      expect(s.byRole).toEqual(full.byRole);
      expect(s.coverage).toEqual(full.coverage);
      // Detailed evidence stays one request away.
      expect(s.links.full).toBe(`/api/audit/tokens?${q}`);
      expect(s.links.runs.length).toBeGreaterThan(0);
      expect(s.topRuns.length).toBeLessThanOrEqual(5);
    }
  });

  it("has no other row when everything fits, and answers days too", async () => {
    save(run("r-new", "rev-1", NOW - 30 * MIN), NEW_RUN);
    const s = await get<TokenAuditSummary>("/api/audit/tokens?days=1&shape=summary");
    expect(s.basis).toBe("runs");
    expect(s.bySource.map((r) => r.name)).not.toContain("other");
    expect(s.links.full).toBe("/api/audit/tokens?days=1");
    expect(JSON.stringify(s).length).toBeLessThan(20_000);
  });
});
