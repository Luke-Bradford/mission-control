import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Escalation,
  FlowIssue,
  FlowPr,
  MachineSample,
  PullRequestView,
  Run,
  RunDigest,
  SubagentInfo,
} from "@mc/core";
import { COMMS_CAPCOM, NEW_LOOP } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { writeCrewPause } from "../src/crew-pause.ts";
import { NO_LOCK } from "../src/hud.ts";
import { overviewSummary } from "../src/overview.ts";
import { Store } from "../src/store.ts";
import { lockView, type TelemetryScope, telemetry } from "../src/telemetry.ts";

// 13:00 BST in London: local midnight is 2026-10-16T23:00Z.
const NOW = Date.parse("2026-10-17T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (iso: string) => Date.parse(iso);

let dir: string;
let store: Store;
let config: CcConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-telemetry-"));
  mkdirSync(join(dir, "ta"));
  store = new Store(join(dir, "mc.sqlite"));
  config = {
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [
      { id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 },
      { id: "codex-pro", vendor: "codex", alertAt: 70, stopAt: 80 },
    ],
    repos: [
      { id: "shop-app", github: "o/shop-app", project: 2, statusMap: {}, autonomy: "draft" },
      { id: "site-builder", github: "o/ae", project: 3, statusMap: {}, autonomy: "draft" },
    ],
    loops: [
      {
        id: "shop-app-ta",
        repoId: "shop-app",
        kind: "ta-loop",
        accountId: "claude-main",
        stateDir: join(dir, "ta"),
        worktree: join(dir, "wt"),
        launchdLabel: "x",
      },
      {
        id: "studio-builder",
        repoId: "site-builder",
        kind: "studio-loop",
        accountId: "codex-pro",
        stateDir: join(dir, "st"),
        logsDir: join(dir, "st-logs"),
        worktree: join(dir, "wt2"),
        launchdLabel: "y",
      },
    ],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (over: Partial<Run>): Run => ({
  id: "r",
  agentId: "shop-app-ta",
  repoId: "shop-app",
  seq: 1,
  startedAt: NOW - HOUR,
  endedAt: NOW - HOUR / 2,
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

const tok = (input: number, output: number, cacheRead = 0, cacheCreate = 0) => ({
  input,
  output,
  cacheRead,
  cacheCreate,
});

const digest = (over: Partial<RunDigest> = {}): RunDigest => ({
  toolCalls: 0,
  turns: 0,
  lastEventAt: null,
  model: null,
  contextTokens: null,
  contextWindow: null,
  liveTool: null,
  tools: {},
  subagents: [],
  minuteTokens: [],
  turnUsage: [],
  background: [],
  compactions: 0,
  ...over,
});

const escalation = (over: Partial<Escalation>): Escalation => ({
  id: "shop-app#9",
  repoId: "shop-app",
  issueNumber: 9,
  title: "[operator-decision] pick one",
  kind: "operator-decision",
  source: "title",
  openedAt: NOW - DAY,
  url: "https://github.com/o/shop-app/issues/9",
  question: null,
  ...over,
});

const pr = (n: number, mergedAt: number | null, repoId = "shop-app"): PullRequestView => ({
  repoId,
  number: n,
  title: "t",
  url: "u",
  branch: "b",
  ticket: null,
  state: mergedAt === null ? "open" : "merged",
  isDraft: false,
  review: null,
  ci: null,
  createdAt: 1,
  updatedAt: mergedAt ?? 2,
  mergedAt,
  headSha: null,
  mergeable: null,
});

/** Explicit recorded state evidence, independent of run wall time. */
const state = (agentId: string, when: number, to: "running" | "waiting" | "blocked" | "idle") =>
  store.addAgentEvent({ agentId, at: when, from: "idle", to, text: "recorded state" });

// Recorded state tests also need a run whose activity supports the interval.
const activity = (agentId: string, start: number, end: number) => {
  const id = `activity:${agentId}:${start}`;
  store.upsertRun(run({ id, agentId, startedAt: start, endedAt: end }));
  store.setDigest(id, digest({ lastEventAt: end }));
};

const ALL: TelemetryScope = { agent: null, account: null };
const tel = (range: "1h" | "6h" | "24h" | "7d" = "6h", now = NOW, scope = ALL) =>
  telemetry(config, store, range, now, scope);

describe("today, in the operator's timezone", () => {
  it("clips a run from 23:30 yesterday to its after-midnight half: tokens, tool calls, turns and cost", () => {
    // 23:30 → 00:30 BST
    store.upsertRun(
      run({
        id: "a",
        startedAt: at("2026-10-16T22:30:00Z"),
        endedAt: at("2026-10-16T23:30:00Z"),
        costUsd: 2,
        tokens: tok(600, 400, 5000, 7000),
      }),
    );
    store.setDigest("a", digest({ toolCalls: 10, turns: 4 }));
    // Wholly yesterday: not counted at all.
    store.upsertRun(
      run({
        id: "b",
        seq: 0,
        startedAt: at("2026-10-16T20:00:00Z"),
        endedAt: at("2026-10-16T21:00:00Z"),
        costUsd: 9,
        tokens: tok(9000, 0),
      }),
    );
    store.setDigest("b", digest({ toolCalls: 90, turns: 90 }));
    const t = tel().today;
    expect(t).toEqual({
      tokens: 500,
      costUsd: 1,
      toolCalls: 5,
      turns: 2,
      cacheRead: 2500,
      working: 0,
      agents: 2,
      commits: 0,
    });
  });

  it("counts running crew rows as working and ignores runs of unconfigured agents", () => {
    store.upsertRun(
      run({ id: "live", startedAt: NOW - 10 * MIN, endedAt: null, status: "running" }),
    );
    store.upsertRun(
      run({ id: "ghost", agentId: "ghost", repoId: "x", tokens: tok(1000, 0), costUsd: 5 }),
    );
    const t = tel().today;
    expect(t.working).toBe(1);
    expect(t.tokens).toBe(0);
    expect(t.costUsd).toBeNull();
  });

  it("on 2026-10-25 (25 h) at 23:00 a run across the repeated hour counts 3 h of a 24 h denominator", () => {
    const now = at("2026-10-25T23:00:00Z"); // 23:00 GMT; midnight was 2026-10-24T23:00Z (BST)
    // 00:30 BST → 02:30 GMT: three hours of wall time
    store.upsertRun(
      run({
        id: "a",
        startedAt: at("2026-10-24T23:30:00Z"),
        endedAt: at("2026-10-25T02:30:00Z"),
        tokens: tok(300, 0),
      }),
    );
    store.setDigest("a", digest({ lastEventAt: at("2026-10-25T02:30:00Z") }));
    state("shop-app-ta", at("2026-10-24T23:00:00Z"), "idle");
    state("shop-app-ta", at("2026-10-24T23:30:00Z"), "running");
    state("shop-app-ta", at("2026-10-25T02:30:00Z"), "idle");
    const t = tel("6h", now);
    expect(t.today.tokens).toBe(300);
    const u = t.utilisation.find((x) => x.agentId === "shop-app-ta");
    expect(u).toEqual({
      agentId: "shop-app-ta",
      working: 12.5,
      waiting: 0,
      blocked: 0,
      idle: 87.5,
      unknown: 0,
    });
  });
});

describe("utilisation", () => {
  it("working that overlaps an open title escalation counts as working only; shares sum to 100", () => {
    const now = at("2026-10-17T15:00:00Z"); // 16:00 BST: 16 h since midnight
    store.upsertRun(
      run({
        id: "a",
        startedAt: at("2026-10-17T08:00:00Z"),
        endedAt: at("2026-10-17T10:00:00Z"),
      }),
    );
    // Open since 07:00Z (8 h before now): 8 h minus the 2 h of work = 6 h waiting.
    store.replaceEscalations("shop-app", [
      escalation({ openedAt: at("2026-10-17T07:00:00Z") }),
      // label-only escalations never set an agent's state
      escalation({
        id: "shop-app#10",
        issueNumber: 10,
        source: "label",
        openedAt: at("2026-10-16T23:00:00Z"),
      }),
    ]);
    activity("shop-app-ta", at("2026-10-17T07:00:00Z"), now);
    state("shop-app-ta", at("2026-10-16T23:00:00Z"), "idle");
    state("studio-builder", at("2026-10-16T23:00:00Z"), "idle");
    state("shop-app-ta", at("2026-10-17T07:00:00Z"), "waiting");
    state("shop-app-ta", at("2026-10-17T08:00:00Z"), "running");
    state("shop-app-ta", at("2026-10-17T10:00:00Z"), "waiting");
    const u = tel("6h", now).utilisation;
    expect(u).toEqual([
      { agentId: "shop-app-ta", working: 12.5, waiting: 37.5, blocked: 0, idle: 50, unknown: 0 },
      { agentId: "studio-builder", working: 0, waiting: 0, blocked: 0, idle: 100, unknown: 0 },
    ]);
    for (const row of u) expect(row.working + row.waiting + row.idle).toBeCloseTo(100, 9);
  });

  it("recorded waiting since yesterday clips to midnight; overlapping runs are not double-counted", () => {
    const now = at("2026-10-17T15:00:00Z"); // 16 h since midnight
    store.upsertRun(
      run({ id: "a", startedAt: at("2026-10-17T07:00:00Z"), endedAt: at("2026-10-17T09:00:00Z") }),
    );
    store.upsertRun(
      run({
        id: "b",
        seq: 2,
        startedAt: at("2026-10-17T08:00:00Z"),
        endedAt: at("2026-10-17T11:00:00Z"),
      }),
    );
    store.replaceEscalations("shop-app", [escalation({ openedAt: at("2026-10-16T12:00:00Z") })]);
    activity("shop-app-ta", at("2026-10-16T12:00:00Z"), now);
    state("shop-app-ta", at("2026-10-16T12:00:00Z"), "waiting");
    state("shop-app-ta", at("2026-10-17T07:00:00Z"), "running");
    state("shop-app-ta", at("2026-10-17T11:00:00Z"), "waiting");
    const u = tel("6h", now).utilisation[0];
    // working 07:00–11:00 = 4 h (25%); waiting = 16 h − 4 h = 12 h (75%)
    expect(u).toEqual({
      agentId: "shop-app-ta",
      working: 25,
      waiting: 75,
      blocked: 0,
      idle: 0,
      unknown: 0,
    });
  });
});

describe("flow of work", () => {
  it("throughput: 14 local days oldest first, PRs by mergedAt, zeros kept", () => {
    store.replacePullRequests(
      "shop-app",
      [
        pr(1, at("2026-10-16T23:30:00Z")), // 00:30 BST on the 17th
        pr(2, at("2026-10-17T09:00:00Z")),
        pr(3, at("2026-10-03T23:30:00Z")), // 00:30 BST on the 4th: first day of the range
        pr(4, at("2026-10-03T22:30:00Z")), // 23:30 BST on the 3rd: outside
      ],
      0,
    );
    store.replacePullRequests(
      "site-builder",
      [pr(5, at("2026-10-10T12:00:00Z"), "site-builder")],
      0,
    );
    const th = tel().throughput;
    expect(th).toHaveLength(14);
    expect(th[0]).toEqual({ day: "2026-10-04", merged: 1 });
    expect(th[13]).toEqual({ day: "2026-10-17", merged: 2 });
    expect(th.find((d) => d.day === "2026-10-10")?.merged).toBe(1);
    expect(th.reduce((n, d) => n + d.merged, 0)).toBe(4);
    expect(th.filter((d) => d.merged === 0)).toHaveLength(11);
  });

  it("cycle time: p50 and p85 by size in XS S M L XL order then none, and the excluded count", () => {
    const issue = (number: number, size: string | null, days: number | null): FlowIssue => ({
      repoId: "shop-app",
      number,
      size,
      startAt: days === null ? null : NOW - DAY - days * DAY,
      doneAt: NOW - DAY,
    });
    store.replaceFlow(
      "shop-app",
      [
        issue(1, "M", 1),
        issue(2, "M", 4),
        issue(3, "M", 2),
        issue(4, "S", 1),
        issue(5, "S", 2),
        issue(6, null, 3),
        issue(7, "M", null),
        issue(8, null, null),
      ],
      [],
    );
    expect(tel().cycleTime).toEqual({
      rows: [
        { size: "XS", p50Ms: null, p85Ms: null, tickets: 0 },
        { size: "S", p50Ms: 1.5 * DAY, p85Ms: 1.85 * DAY, tickets: 2 },
        { size: "M", p50Ms: 2 * DAY, p85Ms: 3.4 * DAY, tickets: 3 },
        { size: "L", p50Ms: null, p85Ms: null, tickets: 0 },
        { size: "XL", p50Ms: null, p85Ms: null, tickets: 0 },
        { size: "none", p50Ms: 3 * DAY, p85Ms: 3 * DAY, tickets: 1 },
      ],
      excluded: 2,
    });
  });

  it("cycle time excludes missing Ready and Done before Ready from the percentiles", () => {
    store.replaceFlow(
      "shop-app",
      [
        { repoId: "shop-app", number: 1, size: "M", startAt: NOW - 4 * DAY, doneAt: NOW - DAY },
        { repoId: "shop-app", number: 2, size: "M", startAt: null, doneAt: NOW - DAY },
        { repoId: "shop-app", number: 3, size: "M", startAt: NOW, doneAt: NOW - DAY },
      ],
      [],
    );
    expect(tel().cycleTime.rows.find((r) => r.size === "M")).toEqual({
      size: "M",
      p50Ms: 3 * DAY,
      p85Ms: 3 * DAY,
      tickets: 1,
    });
    expect(tel().cycleTime.excluded).toBe(2);
  });

  it("CI green on first push ignores PRs with unknown CI", () => {
    const fp = (number: number, firstPushCi: FlowPr["firstPushCi"]): FlowPr => ({
      repoId: "shop-app",
      number,
      mergedAt: NOW - DAY,
      firstPushCi,
    });
    store.replaceFlow(
      "shop-app",
      [],
      [
        fp(1, "passing"),
        fp(2, "passing"),
        fp(3, "passing"),
        fp(4, "failing"),
        fp(5, null),
        fp(6, null),
      ],
    );
    expect(tel().quality).toEqual({
      ciGreenFirstPushPct: 75,
      prs: 4,
      reviewRoundsPerPr: null,
      firstPassReviewPct: null,
      reviewedPrs: 0,
      commitsPerRun: null,
      retroFindingsPerPr: null,
      sentBackPrs: 0,
      humanReviewWaitMs: null,
    });
  });
});

describe("agents", () => {
  it("spreads a 10-minute 1000-token run evenly over its wall time (72 points, tokens per minute)", () => {
    // range 1h: 72 buckets of 50 s; the run covers buckets 36..47 exactly
    store.upsertRun(
      run({
        id: "a",
        startedAt: NOW - 30 * MIN,
        endedAt: NOW - 20 * MIN,
        tokens: tok(600, 400, 99_999, 0),
      }),
    );
    const series = tel("1h").tokensPerMinute;
    expect(series.map((s) => s.agentId)).toEqual(["shop-app-ta", "studio-builder"]);
    const points = series[0]?.points ?? [];
    expect(points).toHaveLength(72);
    points.forEach((p, i) => {
      if (i >= 36 && i < 48) expect(p).toBeCloseTo(100, 9);
      else expect(p).toBe(0);
    });
    expect(series[1]?.points).toEqual(Array(72).fill(0));
  });

  it("live minutes: the last 60 minutes from the digests' real minute buckets", () => {
    const now = NOW + 30_000; // 12:00:30Z: the current minute is 12:00
    store.upsertRun(run({ id: "a", startedAt: now - 30 * MIN, endedAt: null, status: "running" }));
    store.setDigest(
      "a",
      digest({
        minuteTokens: [
          [NOW, 50],
          [NOW - 2 * MIN, 300],
          [NOW - 60 * MIN, 999], // 61st minute back: outside
        ],
      }),
    );
    const live = tel("6h", now).liveMinutes;
    const points = live[0]?.points ?? [];
    expect(points).toHaveLength(60);
    expect(points[59]).toBe(50);
    expect(points[57]).toBe(300);
    expect(points.reduce((a, b) => a + b, 0)).toBe(350);
    expect(live[1]?.points).toEqual(Array(60).fill(0));
  });

  it("tool latency: nearest-rank p50/p95 over digests of runs started in range", () => {
    const ds = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    store.upsertRun(run({ id: "a", startedAt: NOW - 2 * HOUR }));
    store.setDigest(
      "a",
      digest({
        tools: {
          Bash: { calls: 10, failed: 1, durationsMs: ds.slice(0, 10) },
          Read: { calls: 3, failed: 0, durationsMs: [] },
        },
      }),
    );
    store.upsertRun(run({ id: "b", seq: 2, agentId: "studio-builder", repoId: "site-builder" }));
    store.setDigest(
      "b",
      digest({ tools: { Bash: { calls: 12, failed: 2, durationsMs: ds.slice(10).reverse() } } }),
    );
    // started before the 6h range: not counted
    store.upsertRun(run({ id: "old", seq: 0, startedAt: NOW - 7 * HOUR, endedAt: NOW - HOUR }));
    store.setDigest(
      "old",
      digest({ tools: { Bash: { calls: 99, failed: 9, durationsMs: [999_999] } } }),
    );
    expect(tel().toolLatency).toEqual([
      { tool: "Bash", calls: 22, p50Ms: 1000, p95Ms: 1900, failed: 3, slowest: null },
      { tool: "Read", calls: 3, p50Ms: null, p95Ms: null, failed: 0, slowest: null },
    ]);
  });

  it("turn usage of each agent's latest run, and subagents of runs overlapping today", () => {
    const sub = (taskId: string): SubagentInfo => ({
      taskId,
      type: "Explore",
      description: "look",
      status: "completed",
      tokens: 10,
      toolUses: 2,
      durationMs: 3000,
    });
    store.upsertRun(
      run({
        id: "y",
        seq: 1,
        startedAt: at("2026-10-16T20:00:00Z"),
        endedAt: at("2026-10-16T21:00:00Z"),
      }),
    );
    store.setDigest("y", digest({ subagents: [sub("yesterday")] }));
    store.upsertRun(run({ id: "a", seq: 2 }));
    store.setDigest(
      "a",
      digest({
        subagents: [sub("t1")],
        turnUsage: [{ input: 1, output: 2, cacheRead: 3 }],
      }),
    );
    const t = tel();
    expect(t.turnUsage).toEqual([
      { agentId: "shop-app-ta", turns: [{ input: 1, output: 2, cacheRead: 3 }] },
      { agentId: "studio-builder", turns: [] },
    ]);
    expect(t.subagents).toEqual([{ ...sub("t1"), agentId: "shop-app-ta" }]);
  });
});

describe("capacity", () => {
  it("serves bounded chart series without inventing state or quota observations", () => {
    const since = NOW - 6 * HOUR;
    store.addAgentEvent({
      agentId: "shop-app-ta",
      at: since - HOUR,
      from: "idle",
      to: "running",
      text: "started before range",
    });
    store.addAgentEvent({
      agentId: "shop-app-ta",
      at: since + HOUR,
      from: "running",
      to: "waiting",
      text: "waiting",
    });
    store.addAgentEvent({
      agentId: "shop-app-ta",
      at: since + 2 * HOUR,
      from: "waiting",
      to: "parked",
      text: "parked",
    });
    store.addAgentEvent({
      agentId: "shop-app-ta",
      at: since + 3 * HOUR,
      from: "parked",
      to: "idle",
      text: "idle",
    });
    store.addUsage({
      accountId: "claude-main",
      window: "5h",
      at: since + HOUR,
      pct: 40,
      resetAt: NOW + HOUR,
      source: "oauth",
    });
    store.addUsage({
      accountId: "claude-main",
      window: "5h",
      at: since + 3 * HOUR,
      pct: 5,
      resetAt: NOW + 6 * HOUR,
      source: "oauth",
    });
    store.replaceFlow(
      "shop-app",
      [{ repoId: "shop-app", number: 42, size: "S", startAt: since, doneAt: since + 4 * HOUR }],
      [],
    );
    store.upsertRun(run({ id: "ticket-run", ticket: "shop-app#42", startedAt: since + HOUR }));
    store.replacePullRequests(
      "shop-app",
      [{ ...pr(9, since + 3 * HOUR), ticket: "shop-app#42" }],
      NOW,
    );
    store.addHubEvent("Updated to abc (auto)", since + 2 * HOUR);
    writeCrewPause(
      store,
      { seats: "all", reason: "operator break", at: since + 4 * HOUR, by: "operator" },
      since + 4 * HOUR,
    );
    writeCrewPause(store, null, since + 5 * HOUR);

    expect(tel("6h", NOW).series).toEqual({
      stateSpans: [
        { agentId: "shop-app-ta", state: "running", startedAt: since, endedAt: since + HOUR },
        {
          agentId: "shop-app-ta",
          state: "waiting",
          startedAt: since + HOUR,
          endedAt: since + 2 * HOUR,
        },
        {
          agentId: "shop-app-ta",
          state: "parked",
          startedAt: since + 2 * HOUR,
          endedAt: since + 3 * HOUR,
        },
        // The current idle state is only observed at its transition; it must not be drawn to now.
        {
          agentId: "shop-app-ta",
          state: "idle",
          startedAt: since + 3 * HOUR,
          endedAt: since + 3 * HOUR,
        },
      ],
      quota: [
        {
          accountId: "claude-main",
          window: "5h",
          alertAt: 85,
          stopAt: 95,
          points: [
            { at: since + HOUR, pct: 40 },
            { at: since + 3 * HOUR, pct: 5 },
          ],
          resets: [{ at: since + 3 * HOUR, resetAt: NOW + 6 * HOUR, cause: "oauth" }],
        },
      ],
      tickets: [
        {
          ticket: "shop-app#42",
          readyAt: since,
          startedAt: since + HOUR,
          mergedAt: since + 3 * HOUR,
          doneAt: since + 4 * HOUR,
        },
      ],
      annotations: [
        { at: since + 2 * HOUR, kind: "hub-update", cause: "Updated to abc (auto)" },
        { at: since + 3 * HOUR, kind: "quota-reset", cause: "oauth" },
        { at: since + 4 * HOUR, kind: "crew-paused", cause: "Crew paused: operator break" },
        { at: since + 5 * HOUR, kind: "crew-resumed", cause: "Crew resumed" },
      ],
    });
  });

  it("quota points per account window in range", () => {
    const sample = (accountId: string, window: "5h" | "7d", atMs: number, pct: number) =>
      store.addUsage({ accountId, window, at: atMs, pct, resetAt: NOW + DAY, source: "x" });
    sample("claude-main", "5h", NOW - 7 * HOUR, 1); // before the range
    sample("claude-main", "5h", NOW - 2 * HOUR, 20);
    sample("claude-main", "5h", NOW - HOUR, 30);
    sample("claude-main", "7d", NOW - HOUR, 60);
    expect(tel().quota).toEqual([
      {
        accountId: "claude-main",
        window: "5h",
        points: [
          { at: NOW - 2 * HOUR, pct: 20 },
          { at: NOW - HOUR, pct: 30 },
        ],
      },
      { accountId: "claude-main", window: "7d", points: [{ at: NOW - HOUR, pct: 60 }] },
    ]);
  });

  it("7 days of minute machine samples come back as at most 72 averaged points", () => {
    const sample = (atMs: number, cpuPct: number | null): MachineSample => ({
      at: atMs,
      cpuPct,
      cores: 8,
      memUsedBytes: 4,
      memTotalBytes: 8,
      diskFreeBytes: null,
      diskTotalBytes: null,
      agents: null,
    });
    store = new Store(":memory:"); // 10 080 inserts: keep them off the disk
    for (let t = NOW - 7 * DAY + MIN; t <= NOW; t += MIN) {
      store.addMachineSample(sample(t, t % (2 * MIN) === 0 ? 40 : 60));
    }
    const m = tel("7d").machine;
    expect(m.length).toBeLessThanOrEqual(72);
    expect(m.length).toBeGreaterThanOrEqual(70);
    for (const p of m) {
      expect(p.cpuPct).toBeCloseTo(50, 0);
      expect(p.memPct).toBe(50);
    }
    const ats = m.map((p) => p.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });

  it("the 7d view reads bucketed rows, not the raw samples, and matches averaging them", () => {
    store = new Store(":memory:");
    for (let t = NOW - 7 * DAY + MIN, i = 0; t <= NOW + 5 * MIN; t += MIN, i++) {
      const s: MachineSample = {
        at: t,
        cpuPct: i % 7 === 0 ? null : (i * 13) % 100,
        cores: 8,
        memUsedBytes: i % 11 === 0 ? null : (i * 17) % 1000,
        memTotalBytes: i % 13 === 0 ? 0 : 1000,
        diskFreeBytes: null,
        diskTotalBytes: null,
        agents: null,
      };
      store.addMachineSample(s);
    }
    // The previous behaviour: every sample in range, averaged per bucket in JS.
    const since = NOW - 7 * DAY;
    const bucketMs = (7 * DAY) / 72;
    const ref = new Map<number, { at: number; cpu: number[]; mem: number[] }>();
    // What the store kept: it prunes samples older than a week before its newest.
    for (const s of store.machineSamples(0)) {
      if (s.at < since || s.at > NOW) continue;
      const i = Math.min(71, Math.floor((s.at - since) / bucketMs));
      const b = ref.get(i) ?? { at: s.at, cpu: [], mem: [] };
      b.at = s.at;
      if (s.cpuPct !== null) b.cpu.push(s.cpuPct);
      if (s.memUsedBytes !== null && s.memTotalBytes > 0) {
        b.mem.push((s.memUsedBytes / s.memTotalBytes) * 100);
      }
      ref.set(i, b);
    }
    const mean = (xs: number[]) =>
      xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
    const expected = [...ref].sort((a, b) => a[0] - b[0]).map(([, b]) => b);

    const raw = vi.spyOn(store, "machineSamples");
    const m = tel("7d").machine;
    expect(raw).not.toHaveBeenCalled();
    expect(m).toHaveLength(expected.length);
    expect(m.length).toBeLessThanOrEqual(72);
    for (const [k, p] of m.entries()) {
      const b = expected[k] as (typeof expected)[number];
      expect(p.at).toBe(b.at);
      expect(p.cpuPct).toBeCloseTo(mean(b.cpu) as number, 9);
      expect(p.memPct).toBeCloseTo(mean(b.mem) as number, 9);
    }
  });

  it("machine points keep null where no sample in the bucket measured it", () => {
    store.addMachineSample({
      at: NOW - MIN,
      cpuPct: null,
      cores: 8,
      memUsedBytes: null,
      memTotalBytes: 8,
      diskFreeBytes: null,
      diskTotalBytes: null,
      agents: null,
    });
    expect(tel("1h").machine).toEqual([{ at: NOW - MIN, cpuPct: null, memPct: null }]);
  });
});

describe("cost", () => {
  it("tokens by ticket and totals over runs in range; cache hit = cacheRead ÷ (input + cacheRead + cacheCreate)", () => {
    store.upsertRun(
      run({
        id: "a",
        ticket: "shop-app#7",
        model: "opus",
        costUsd: 1,
        tokens: tok(100, 50, 300, 100),
      }),
    );
    store.setDigest("a", digest({ toolCalls: 4, turns: 2 }));
    store.upsertRun(
      run({
        id: "b",
        seq: 2,
        ticket: "shop-app#7",
        model: "opus",
        costUsd: 2,
        tokens: tok(100, 50, 100, 100),
      }),
    );
    store.setDigest("b", digest({ toolCalls: 6, turns: 3 }));
    store.upsertRun(
      run({
        id: "c",
        seq: 3,
        agentId: "studio-builder",
        repoId: "site-builder",
        ticket: "site-builder#3",
        tokens: tok(0, 10),
      }),
    );
    store.upsertRun(run({ id: "d", seq: 4, tokens: tok(0, 0) }));
    const t = tel();
    expect(t.tokensByTicket).toEqual([
      { ticket: "shop-app#7", tokens: 300, costUsd: 3 },
      { ticket: "site-builder#3", tokens: 10, costUsd: null },
    ]);
    // Run d has no usage at all: its all-zero row is dropped.
    expect(t.totals).toEqual([
      {
        agentId: "shop-app-ta",
        accountId: "claude-main",
        model: "opus",
        input: 200,
        output: 100,
        cacheRead: 400,
        cacheHitPct: 50,
        additions: null,
        deletions: null,
        turns: 5,
        toolCalls: 10,
        costUsd: 3,
      },
      {
        agentId: "studio-builder",
        accountId: "codex-pro",
        model: null,
        input: 0,
        output: 10,
        cacheRead: 0,
        cacheHitPct: null,
        additions: null,
        deletions: null,
        turns: 0,
        toolCalls: 0,
        costUsd: null,
      },
    ]);
  });
  it("a run straddling the start of the range counts pro rata to its wall time inside it", () => {
    store.upsertRun(
      run({
        id: "a",
        ticket: "shop-app#1",
        startedAt: NOW - 2 * HOUR,
        endedAt: NOW,
        costUsd: 4,
        tokens: tok(1000, 0),
      }),
    );
    const t = tel("1h");
    expect(t.tokensByTicket).toEqual([{ ticket: "shop-app#1", tokens: 500, costUsd: 2 }]);
    expect(t.totals[0]).toMatchObject({ input: 500, costUsd: 2 });
  });
  // #26 A3: a run whose branch names no ticket counts toward its PR's ticket.
  it("counts a run without a ticket of its own toward its PR's ticket", () => {
    store.upsertPullRequests(
      "shop-app",
      [
        {
          repoId: "shop-app",
          number: 41,
          title: "t",
          url: "https://github.com/o/shop-app/pull/41",
          branch: "chore/x",
          ticket: "shop-app#3349",
          state: "open",
          isDraft: false,
          review: null,
          ci: null,
          createdAt: 1,
          updatedAt: 2,
          mergedAt: null,
          headSha: null,
          mergeable: null,
        },
      ],
      0,
    );
    store.upsertRun(
      run({ id: "a", tokens: tok(10, 0), prs: [{ repo: "o/shop-app", number: 41 }] }),
    );
    expect(tel().tokensByTicket).toEqual([{ ticket: "shop-app#3349", tokens: 10, costUsd: null }]);
  });
});

describe("lockView", () => {
  it("labels holder and waiters and gives usualMs from three done holds", () => {
    const c: CcConfig = {
      ...config,
      repos: [{ ...(config.repos[0] as CcConfig["repos"][number]), fullSuite: ["pnpm -s test"] }],
      crew: {
        worktrees: join(dir, "wt"),
        maxSeats: 4,
        sessions: [
          {
            id: "shop-app-1",
            repoId: "shop-app",
            checkout: join(dir, "co"),
            seats: [
              { id: "guido-1", role: "GUIDO", accountId: "claude-main", model: "sonnet", area: [] },
            ],
          },
        ],
      },
    };
    const add = (id: string, started: number, length: number) => {
      store.addLockHold({
        runId: id,
        seatId: "guido-1",
        toolUseId: "call",
        command: "pnpm -s test",
        since: started,
        queuedAt: started,
      });
      store.deleteLockHold(id, "call", started + length);
    };
    add("outside", NOW - 7 * DAY - MIN, 50_000);
    add("a", NOW - 3 * HOUR, 100);
    add("b", NOW - 2 * HOUR, 200);
    const since = NOW - MIN;
    const state = {
      holder: { runId: "h", seatId: "guido-1", command: "pnpm -s test", since },
      waiting: [{ runId: "w", seatId: "guido-9", command: "make check", since }],
    };
    expect(lockView(c, store, state, NOW).holder?.usualMs).toBeNull();
    add("c", NOW - HOUR, 900);
    expect(lockView(c, store, state, NOW)).toEqual({
      holder: { ...state.holder, label: "shop-app full suite", usualMs: 200 },
      waiting: [{ ...state.waiting[0], label: "make check" }],
    });
    expect(lockView(c, store, NO_LOCK, NOW)).toEqual({ holder: null, waiting: [] });
  });
});

describe("empty store", () => {
  it("answers arrays empty, today zeros and costs null", () => {
    const t = tel();
    expect(t.today).toEqual({
      tokens: 0,
      cacheRead: 0,
      costUsd: null,
      toolCalls: 0,
      turns: 0,
      working: 0,
      agents: 2,
      commits: 0,
    });
    expect(t.throughput).toHaveLength(14);
    expect(t.throughput.every((d) => d.merged === 0)).toBe(true);
    expect(t.cycleTime).toEqual({
      rows: ["XS", "S", "M", "L", "XL", "none"].map((size) => ({
        size,
        p50Ms: null,
        p85Ms: null,
        tickets: 0,
      })),
      excluded: 0,
    });
    expect(t.quality).toEqual({
      ciGreenFirstPushPct: null,
      prs: 0,
      reviewRoundsPerPr: null,
      firstPassReviewPct: null,
      reviewedPrs: 0,
      commitsPerRun: null,
      retroFindingsPerPr: null,
      sentBackPrs: 0,
      humanReviewWaitMs: null,
    });
    expect(t.capcom).toEqual({
      answered: 0,
      medianMs: null,
      p90Ms: null,
      stopped: 0,
      longest: null,
      agentWaitMs: 0,
    });
    expect(t.tokensByStep).toEqual(
      ["plan", "build", "review"].map((step) => ({ step, tokens: 0, costUsd: null, runs: 0 })),
    );
    // Per-agent series are one per configured agent, all zero / idle.
    expect(t.tokensPerMinute.map((s) => s.points.every((p) => p === 0))).toEqual([true, true]);
    expect(t.liveMinutes.map((s) => s.points.every((p) => p === 0))).toEqual([true, true]);
    expect(t.utilisation.map((u) => [u.working, u.waiting, u.blocked, u.idle, u.unknown])).toEqual([
      [0, 0, 0, 0, 100],
      [0, 0, 0, 0, 100],
    ]);
    expect(t.turnUsage.map((u) => u.turns)).toEqual([[], []]);
    expect(t.toolLatency).toEqual([]);
    expect(t.subagents).toEqual([]);
    expect(t.quota).toEqual([]);
    expect(t.machine).toEqual([]);
    expect(t.tokensByTicket).toEqual([]);
    expect(t.totals).toEqual([]);
  });
});

describe("scope: agent and account", () => {
  const seed = () => {
    store.upsertRun(
      run({
        id: "ta",
        startedAt: NOW - 2 * HOUR,
        endedAt: NOW - HOUR,
        costUsd: 1,
        tokens: tok(100, 50, 400),
      }),
    );
    store.setDigest(
      "ta",
      digest({
        toolCalls: 4,
        turns: 2,
        tools: { Bash: { calls: 4, failed: 1, durationsMs: [10, 20, 30, 40] } },
        subagents: [
          {
            taskId: "t1",
            type: "Explore",
            description: "d",
            status: "completed",
            tokens: null,
            toolUses: null,
            durationMs: null,
          },
        ],
      }),
    );
    store.upsertRun(
      run({
        id: "st",
        agentId: "studio-builder",
        repoId: "site-builder",
        startedAt: NOW - 2 * HOUR,
        endedAt: NOW - HOUR,
        costUsd: 3,
        tokens: tok(1000, 500, 4000),
      }),
    );
    store.setDigest(
      "st",
      digest({
        toolCalls: 40,
        turns: 20,
        tools: { Read: { calls: 40, failed: 0, durationsMs: [5] } },
        subagents: [
          {
            taskId: "t2",
            type: "Explore",
            description: "d",
            status: "completed",
            tokens: null,
            toolUses: null,
            durationMs: null,
          },
        ],
      }),
    );
  };

  it("an agent restricts today, tool latency, subagents and totals to that loop's runs", () => {
    seed();
    const all = tel();
    expect(all.today.tokens).toBe(1650);
    expect(all.today.cacheRead).toBe(4400);
    const t = tel("6h", NOW, { agent: "shop-app-ta", account: null });
    expect(t.today).toMatchObject({
      tokens: 150,
      cacheRead: 400,
      costUsd: 1,
      toolCalls: 4,
      turns: 2,
      agents: 1,
    });
    expect(t.toolLatency.map((r) => r.tool)).toEqual(["Bash"]);
    expect(t.subagents.map((s) => s.agentId)).toEqual(["shop-app-ta"]);
    expect(t.totals.map((r) => r.agentId)).toEqual(["shop-app-ta"]);
    // Crew-wide parts stay crew-wide.
    expect(t.tokensPerMinute.map((s) => s.agentId)).toEqual(["shop-app-ta", "studio-builder"]);
  });

  it("an account restricts to the loops that run on it; both together intersect", () => {
    seed();
    const t = tel("6h", NOW, { agent: null, account: "codex-pro" });
    expect(t.today).toMatchObject({ tokens: 1500, cacheRead: 4000, agents: 1 });
    expect(t.toolLatency.map((r) => r.tool)).toEqual(["Read"]);
    expect(t.totals.map((r) => r.agentId)).toEqual(["studio-builder"]);
    const none = tel("6h", NOW, { agent: "shop-app-ta", account: "codex-pro" });
    expect(none.today).toMatchObject({ tokens: 0, agents: 0, working: 0, costUsd: null });
    expect(none.totals).toEqual([]);
  });

  it("working counts only running loops in scope", () => {
    store.upsertRun(
      run({ id: "live", startedAt: NOW - 10 * MIN, endedAt: null, status: "running" }),
    );
    expect(tel().today.working).toBe(1);
    expect(tel("6h", NOW, { agent: "studio-builder", account: null }).today.working).toBe(0);
  });
});

describe("totals model key", () => {
  it('a first-seen run with model "" makes a row whose model is null', () => {
    // Newest first, so the "" run (seq 2) is the one that creates the row.
    store.upsertRun(run({ id: "a", model: "", seq: 2, tokens: tok(10, 5) }));
    store.upsertRun(run({ id: "b", seq: 1, model: null, tokens: tok(20, 5) }));
    const rows = tel().totals.filter((r) => r.agentId === "shop-app-ta");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: null, input: 30, output: 10 });
  });

  it('a run with model "" takes the digest\'s model', () => {
    store.upsertRun(run({ id: "a", model: "", tokens: tok(10, 5) }));
    store.setDigest("a", digest({ model: "x" }));
    const rows = tel().totals.filter((r) => r.agentId === "shop-app-ta");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "x", input: 10 });
  });
});

describe("totals rows", () => {
  it("drops a row whose figures all round to zero", () => {
    store.upsertRun(run({ id: "z", tokens: tok(0, 0) }));
    store.upsertRun(run({ id: "n", agentId: "studio-builder", tokens: tok(10, 5) }));
    expect(tel().totals.map((r) => r.agentId)).toEqual(["studio-builder"]);
  });
});

describe("crew seats", () => {
  beforeEach(() => {
    config = {
      ...config,
      crew: {
        worktrees: join(dir, "crew-wt"),
        maxSeats: 4,
        sessions: [
          {
            id: "s1",
            repoId: "shop-app",
            checkout: join(dir, "crew-co"),
            seats: [
              { id: "GUIDO-1", role: "GUIDO", accountId: "claude-main", model: "sonnet", area: [] },
            ],
          },
        ],
      },
    };
  });

  it("counts scoped commits and crew-wide loop steps pro rata, excluding observed and other loops", () => {
    const seats = config.crew?.sessions[0]?.seats;
    seats?.push(
      { id: "FAO-1", role: "FAO", accountId: "claude-main", model: "sonnet", area: [] },
      { id: "RETRO-1", role: "RETRO", accountId: "claude-main", model: "sonnet", area: [] },
      { id: "FLIGHT-1", role: "FLIGHT", accountId: "claude-main", model: "sonnet", area: [] },
    );
    for (const [id, agentId, reviewId, costUsd] of [
      ["build", "GUIDO-1", null, 4],
      ["plan", "FAO-1", null, 2],
      ["review", "RETRO-1", 1, null],
      ["none", "RETRO-1", null, 10],
      ["watch", "FLIGHT-1", null, 10],
      ["observed", "shop-app-ta", null, 10],
    ] as const) {
      store.upsertRun(
        run({
          id,
          agentId,
          reviewId,
          costUsd,
          startedAt: NOW - 2 * HOUR,
          endedAt: NOW,
          tokens: tok(100, 100),
        }),
      );
      store.addRunCommit({ runId: id, repoId: "shop-app", branch: "b", sha: id, at: NOW - MIN });
    }
    store.addRunCommit({
      runId: "build",
      repoId: "shop-app",
      branch: "b",
      sha: "old",
      at: NOW - DAY,
    });
    const t = tel("1h", NOW, { agent: "GUIDO-1", account: null });
    expect(t.today.commits).toBe(1);
    expect(tel().today.commits).toBe(6);
    expect(t.tokensByStep).toEqual([
      { step: "plan", tokens: 100, costUsd: 1, runs: 1 },
      { step: "build", tokens: 100, costUsd: 2, runs: 1 },
      { step: "review", tokens: 100, costUsd: null, runs: 1 },
    ]);
  });

  it("reports every CAPCOM figure today, including pre-midnight questions and open wait time", () => {
    const midnight = at("2026-10-16T23:00:00Z");
    const question = (
      agentId: string,
      raised: number,
      answered: number | null,
      from: string | null,
    ) => {
      store.addQuestion({ agentId, runId: "c", text: "?", at: raised });
      if (answered !== null) {
        store.answerQuestions(agentId, answered);
        if (from)
          store.addComms({ from, to: agentId, at: answered + 1000, text: "answer", ticket: null });
      }
    };
    question("GUIDO-1", midnight - MIN, midnight + MIN, COMMS_CAPCOM);
    question("GUIDO-1", NOW - 20 * MIN, NOW - 10 * MIN, COMMS_CAPCOM);
    question("GUIDO-1", NOW - 8 * MIN, NOW - 5 * MIN, "flight");
    question("GUIDO-1", NOW - 4 * MIN, NOW - 3 * MIN, null);
    question("GUIDO-1", NOW - 2 * MIN, null, null);
    for (const [id, endedAt, endedBy] of [
      ["stop", midnight, "operator"],
      ["flight", NOW - MIN, "operator"],
      ["old", midnight - 1, "operator"],
      ["exit", NOW - MIN, "exit"],
    ] as const) {
      store.upsertRun(run({ id }));
      store.setRunEnded(id, endedAt, "ok", endedBy);
    }
    store.addFlightDecision({
      at: NOW - MIN,
      kind: "end",
      seatId: null,
      targetRunId: "flight",
      ref: null,
      questionId: null,
      about: "end",
      decision: "end",
      basis: "test",
    });
    expect(tel("1h", NOW, { agent: "shop-app-ta", account: null }).capcom).toEqual({
      answered: 2,
      medianMs: 6 * MIN,
      p90Ms: 10 * MIN,
      stopped: 1,
      longest: { agentId: "GUIDO-1", ms: 10 * MIN },
      agentWaitMs: 17 * MIN,
    });
  });

  it("takes human review waits from cleared ready/review notes raised within fourteen days", () => {
    for (const [key, kind, raised, cleared] of [
      ["ready", "ready", NOW - DAY, NOW - DAY + HOUR],
      ["review", "review", NOW - 2 * DAY, NOW - 2 * DAY + 3 * HOUR],
      ["old", "ready", NOW - 15 * DAY, NOW],
      ["open", "review", NOW - DAY, null],
      ["blocked", "blocked", NOW - DAY, NOW],
    ] as const) {
      store.raiseNote({
        key,
        kind,
        at: raised,
        text: key,
        runId: null,
        seatId: null,
        repoId: null,
      });
      if (cleared !== null) store.clearNote(key, cleared);
    }
    expect(tel().quality.humanReviewWaitMs).toBe(2 * HOUR);
  });

  it("totals, series and utilisation include a crew run", () => {
    store.upsertRun(
      run({
        id: "c1",
        agentId: "GUIDO-1",
        startedAt: NOW - 30 * MIN,
        endedAt: NOW - 20 * MIN,
        tokens: tok(600, 400),
      }),
    );
    state("GUIDO-1", NOW - 30 * MIN, "running");
    state("GUIDO-1", NOW - 20 * MIN, "idle");
    const t = tel("1h");
    expect(t.today.tokens).toBe(1000);
    expect(t.today.agents).toBe(3);
    expect(t.tokensPerMinute.map((s) => s.agentId)).toEqual([
      "shop-app-ta",
      "studio-builder",
      "GUIDO-1",
    ]);
    expect(t.utilisation.map((u) => u.agentId)).toEqual([
      "shop-app-ta",
      "studio-builder",
      "GUIDO-1",
    ]);
    expect(t.utilisation[2]?.working).toBeGreaterThan(0);
    expect(t.totals.find((r) => r.agentId === "GUIDO-1")).toMatchObject({
      accountId: "claude-main",
      input: 600,
      output: 400,
    });
  });

  /** A reported review of `prNumber` at `round`, with `blocking` Important findings. */
  const reported = (
    authorRunId: string,
    prNumber: number,
    round: number,
    blocking: number,
    minor = 0,
  ) => {
    const id = store.requestReview({
      authorRunId,
      repoId: "shop-app",
      seatId: "RETRO-1",
      prNumber,
      sha: "c".repeat(40),
      epoch: 0,
      attempt: 1,
      round,
      at: NOW - HOUR,
    }) as number;
    store.setReviewState(id, ["queued"], "running", { at: NOW - HOUR, runId: `rv-${id}` });
    store.recordFindings(id, `rv-${id}`, {
      verdict: { spec: "pass", quality: "pass" },
      summary: "s",
      findings: Array.from({ length: blocking + minor }, (_, i) => ({
        severity: i < blocking ? ("Important" as const) : ("Minor" as const),
        file: "a.ts",
        line: 1,
        summary: "x",
        scenario: "y",
        fix: "z",
      })),
      at: NOW - HOUR,
    });
  };

  it("quality: review rounds and first-pass rate per merged PR, commits per run", () => {
    store.replacePullRequests(
      "shop-app",
      [pr(7, NOW - DAY), pr(8, NOW - 2 * DAY), pr(9, NOW - 20 * DAY), pr(10, null)],
      0,
    );
    reported("a7", 7, 1, 1, 2);
    reported("b7", 7, 2, 0);
    reported("a8", 8, 1, 0);
    reported("a9", 9, 1, 1);
    reported("a10", 10, 1, 0);
    const c = (id: string, over: Partial<Run> = {}) =>
      store.upsertRun(
        run({
          id,
          agentId: "GUIDO-1",
          startedAt: NOW - 3 * HOUR,
          endedAt: NOW - 2 * HOUR,
          loop: NEW_LOOP,
          ...over,
        }),
      );
    c("c1");
    c("c2");
    c("c3", { endedAt: null });
    c("c4", { reviewId: 1 });
    c("c5", { loop: null });
    c("c6", { startedAt: NOW - 20 * DAY, endedAt: NOW - 20 * DAY + HOUR });
    const commit = (runId: string, sha: string) =>
      store.addRunCommit({ runId, repoId: "shop-app", branch: "b", sha, at: NOW - 2 * HOUR });
    for (const sha of ["1", "2", "3"]) commit("c1", sha.repeat(40));
    commit("c2", "4".repeat(40));
    expect(tel().quality).toMatchObject({
      retroFindingsPerPr: 1.5,
      sentBackPrs: 1,
      reviewRoundsPerPr: 1.5,
      firstPassReviewPct: 50,
      reviewedPrs: 2,
      commitsPerRun: 2,
    });
  });

  it("quality's review and commit figures are null with no data", () => {
    expect(tel().quality).toMatchObject({
      reviewRoundsPerPr: null,
      firstPassReviewPct: null,
      reviewedPrs: 0,
      commitsPerRun: null,
      retroFindingsPerPr: null,
      sentBackPrs: 0,
      humanReviewWaitMs: null,
    });
  });

  describe("a seat's waiting share", () => {
    const NOON = at("2026-10-17T15:00:00Z");
    // local midnight 2026-10-16T23:00Z: 16h elapsed at NOON
    const seatShare = () => tel("6h", NOON).utilisation.find((u) => u.agentId === "GUIDO-1");
    const ran = () => {
      store.setDigest("c1", digest({ lastEventAt: at("2026-10-17T11:00:00Z") }));
      state("GUIDO-1", at("2026-10-16T23:00:00Z"), "idle");
      state("GUIDO-1", at("2026-10-17T07:00:00Z"), "running");
      state("GUIDO-1", at("2026-10-17T11:00:00Z"), "idle");
      store.upsertRun(
        run({
          id: "c1",
          agentId: "GUIDO-1",
          startedAt: at("2026-10-17T07:00:00Z"),
          endedAt: at("2026-10-17T11:00:00Z"),
        }),
      );
    };
    const ask = (agentId: string, when: string) =>
      store.addQuestion({ agentId, runId: "c1", text: "q?", at: at(when) });

    it("blocks on its own questions without counting work or another seat's questions", () => {
      ran();
      ask("GUIDO-1", "2026-10-17T08:00:00Z");
      store.answerQuestions("GUIDO-1", at("2026-10-17T10:00:00Z"));
      ask("FLIGHT", "2026-10-17T12:00:00Z");
      expect(seatShare()).toEqual({
        agentId: "GUIDO-1",
        working: 12.5,
        waiting: 0,
        blocked: 12.5,
        idle: 75,
        unknown: 0,
      });
    });

    it("an open title escalation on the seat's repo leaves its waiting at 0; the loop's share is unchanged", () => {
      ran();
      store.replaceEscalations("shop-app", [escalation({ openedAt: at("2026-10-17T07:00:00Z") })]);
      expect(seatShare()).toEqual({
        agentId: "GUIDO-1",
        working: 25,
        waiting: 0,
        blocked: 0,
        idle: 75,
        unknown: 0,
      });
      state("shop-app-ta", at("2026-10-16T23:00:00Z"), "idle");
      state("shop-app-ta", at("2026-10-17T07:00:00Z"), "waiting");
      activity("shop-app-ta", at("2026-10-17T07:00:00Z"), NOON);
      expect(tel("6h", NOON).utilisation.find((u) => u.agentId === "shop-app-ta")).toEqual({
        agentId: "shop-app-ta",
        working: 0,
        waiting: 50,
        blocked: 0,
        unknown: 0,
        idle: 50,
      });
    });

    it("an unanswered question blocks until now", () => {
      ask("GUIDO-1", "2026-10-17T13:00:00Z");
      expect(seatShare()).toMatchObject({ working: 0, waiting: 0, blocked: 12.5, unknown: 87.5 });
    });
  });

  it("scopes to a seat by id or by its account", () => {
    store.upsertRun(
      run({
        id: "c1",
        agentId: "GUIDO-1",
        startedAt: NOW - 30 * MIN,
        endedAt: NOW - 20 * MIN,
        tokens: tok(600, 400),
      }),
    );
    expect(tel("1h", NOW, { agent: "GUIDO-1", account: null }).today.agents).toBe(1);
    expect(tel("1h", NOW, { agent: null, account: "claude-main" }).today.agents).toBe(2);
  });
});

describe("recorded state intervals", () => {
  it("clips midnight and separates overlapping waits, stalled, parked and idle", () => {
    const midnight = at("2026-10-16T23:00:00Z");
    const now = midnight + 8 * HOUR;
    activity("shop-app-ta", midnight - HOUR, midnight + 6 * HOUR);
    for (const [offset, from, to] of [
      [-1, "idle", "running"],
      [2, "running", "waiting"],
      [3, "waiting", "stalled"],
      [4, "stalled", "parked"],
      [6, "parked", "idle"],
    ] as const) {
      store.addAgentEvent({
        agentId: "shop-app-ta",
        at: midnight + offset * HOUR,
        from,
        to,
        text: "state",
      });
    }
    const row = tel("6h", now).utilisation[0];
    expect(row).toEqual({
      agentId: "shop-app-ta",
      working: 25,
      waiting: 12.5,
      blocked: 37.5,
      idle: 25,
      unknown: 0,
    });
    expect((row?.working ?? 0) + (row?.waiting ?? 0) + (row?.blocked ?? 0) + (row?.idle ?? 0)).toBe(
      100,
    );
  });
  it("discloses unavailable history instead of calling a whole run working", () => {
    store.upsertRun(run({ id: "legacy" }));
    expect(tel().utilisation[0]).toMatchObject({
      working: 0,
      waiting: 0,
      blocked: 0,
      idle: 0,
      unknown: 100,
    });
  });
});

it("counts committed lines once across retries and preserves unknown commit counts", () => {
  for (const id of ["retry", "first"]) {
    store.upsertRun(run({ id, tokens: tok(1, 0) }));
    store.addRunCommit({
      runId: id,
      repoId: "shop-app",
      branch: "b",
      sha: "a".repeat(40),
      at: NOW - MIN,
    });
  }
  const measured = new Map([[`shop-app#${"a".repeat(40)}`, { additions: 12, deletions: 3 }]]);
  const totals = telemetry(config, store, "6h", NOW, ALL, measured).totals;
  expect(totals[0]).toMatchObject({ input: 2, additions: 12, deletions: 3 });
  store.addRunCommit({
    runId: "retry",
    repoId: "shop-app",
    branch: "b",
    sha: "b".repeat(40),
    at: NOW - MIN,
  });
  expect(telemetry(config, store, "6h", NOW, ALL, measured).totals[0]).toMatchObject({
    additions: null,
    deletions: null,
  });
});

it("unions overlapping lock and cleared review waits without counting them as work", () => {
  const midnight = at("2026-10-16T23:00:00Z");
  activity("shop-app-ta", midnight, midnight + 4 * HOUR);
  state("shop-app-ta", midnight, "running");
  store.addLockHold({
    runId: "lock",
    toolUseId: "tool",
    seatId: "shop-app-ta",
    command: "just test",
    queuedAt: midnight - HOUR,
    since: midnight + 2 * HOUR,
  });
  store.raiseNote({
    key: "review",
    kind: "review",
    at: midnight + HOUR,
    text: "review",
    runId: null,
    seatId: "shop-app-ta",
    repoId: "shop-app",
  });
  store.clearNote("review", midnight + 3 * HOUR);
  expect(tel("6h", midnight + 4 * HOUR).utilisation[0]).toEqual({
    agentId: "shop-app-ta",
    working: 25,
    waiting: 75,
    blocked: 0,
    idle: 0,
    unknown: 0,
  });
});

it("round-trips legacy, missing and measured digest fields without inventing measurements", () => {
  for (const [id, value] of [
    ["legacy", digest()],
    [
      "unknown",
      digest({
        additions: null,
        deletions: null,
        tools: { Bash: { calls: 1, failed: 0, durationsMs: [], slowest: null } },
      }),
    ],
    [
      "measured",
      digest({
        additions: 0,
        deletions: 3,
        tools: {
          Bash: {
            calls: 1,
            failed: 0,
            durationsMs: [12],
            slowest: { detail: "just test", durationMs: 12 },
          },
        },
      }),
    ],
  ] as const) {
    store.setDigest(id, value);
    expect(store.digest(id)).toEqual({ lastText: null, ...value });
    expect(store.digests([id]).get(id)).toEqual({ lastText: null, ...value });
  }
});

it("aggregates the maximum timed call with its owning agent without guessing legacy detail", () => {
  store.upsertRun(run({ id: "a" }));
  store.upsertRun(run({ id: "b", agentId: "studio-builder", repoId: "site-builder" }));
  store.setDigest(
    "a",
    digest({
      tools: {
        Bash: {
          calls: 1,
          failed: 0,
          durationsMs: [2000],
          slowest: { detail: "just test", durationMs: 2000 },
        },
      },
    }),
  );
  store.setDigest(
    "b",
    digest({
      tools: {
        Bash: {
          calls: 1,
          failed: 0,
          durationsMs: [1000],
          slowest: { detail: null, durationMs: 1000 },
        },
        Read: { calls: 1, failed: 0, durationsMs: [5] },
      },
    }),
  );
  expect(tel().toolLatency[0]?.slowest).toEqual({
    detail: "just test",
    durationMs: 2000,
    agentId: "shop-app-ta",
  });
  expect(tel().toolLatency[1]?.slowest).toBeNull();
});

it("does not recount an old commit when a retry records it in a newer range", () => {
  for (const id of ["old", "retry"]) store.upsertRun(run({ id, tokens: tok(1, 0) }));
  for (const [runId, when] of [
    ["old", NOW - DAY],
    ["retry", NOW - MIN],
  ] as const)
    store.addRunCommit({ runId, repoId: "shop-app", branch: "b", sha: "a".repeat(40), at: when });
  const measured = new Map([[`shop-app#${"a".repeat(40)}`, { additions: 12, deletions: 3 }]]);
  expect(telemetry(config, store, "1h", NOW, ALL, measured).totals[0]).toMatchObject({
    additions: null,
    deletions: null,
  });
});

it("expires recovered running evidence at last activity plus the stall threshold or run end", () => {
  const start = NOW - 3 * HOUR;
  store.upsertRun(run({ id: "recovered", startedAt: start, endedAt: null }));
  store.setDigest("recovered", digest({ lastEventAt: start + 5 * MIN }));
  state("shop-app-ta", start, "running");
  const elapsed = NOW - at("2026-10-16T23:00:00Z");
  expect(tel().utilisation[0]?.working).toBeCloseTo(((15 * MIN) / elapsed) * 100);
  store.upsertRun(run({ id: "recovered", startedAt: start, endedAt: start + 7 * MIN }));
  expect(tel().utilisation[0]?.working).toBeCloseTo(((7 * MIN) / elapsed) * 100);
});

it.each([
  undefined,
  [],
  [{ id: "zero", at: NOW, tokens: 0 }],
  [
    { id: "old", at: at("2026-10-16T22:59:59Z"), tokens: 10 },
    { id: "first", at: at("2026-10-16T23:00:00Z"), tokens: 20 },
    { id: "second", at: at("2026-10-17T00:00:00Z"), tokens: 30 },
    { id: "now", at: NOW, tokens: 10 },
    { id: "unknown", at: null, tokens: 10 },
    { id: "future", at: NOW + 1, tokens: 20 },
  ],
])("agrees with Overview spend for attempt usage %j", (attemptUsage) => {
  store.upsertRun(
    run({ startedAt: at("2026-10-16T22:00:00Z"), endedAt: null, status: "running", costUsd: 10 }),
  );
  store.setDigest("r", digest({ attemptUsage }));
  const spend = overviewSummary(store, NOW, {
    repoIds: config.repos.map((r) => r.id),
    timezone: config.operator.timezone,
    attention: [],
  }).kpis.spendToday;
  const today = telemetry(config, store, "1h", NOW, ALL).today;
  expect(today.costUsd).toBeCloseTo(spend.usd);
  expect(today.costUsd).toBeCloseTo(
    attemptUsage?.length && attemptUsage[0]?.tokens ? 6 : (10 * 13) / 14,
  );
});
