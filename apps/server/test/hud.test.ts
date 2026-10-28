import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTENTION_LABEL,
  type BoardItem,
  COMMS_CAPCOM,
  DEFAULT_PROFILES,
  driverStopKey,
  type Escalation,
  FLIGHT_TRIAGE_WAIT_MS,
  NEW_LOOP,
  type Profile,
  type PullRequestView,
  type Run,
  type RunDigest,
  type RunLoop,
  type SeatSessionRow,
  type TestLockState,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { agentViews, attentionItems, crew, NO_LOCK } from "../src/hud.ts";
import { Store } from "../src/store.ts";
import { foldTranscript } from "../src/streamjson.ts";

// 13:00 BST in London: local midnight is 2026-10-16T23:00Z.
const NOW = Date.parse("2026-10-17T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let dir: string;
let store: Store;
let config: CcConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-hud-"));
  mkdirSync(join(dir, "ta"));
  store = new Store(join(dir, "mc.sqlite"));
  config = {
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 }],
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
        accountId: "claude-main",
        stateDir: join(dir, "st"),
        logsDir: join(dir, "st-logs"),
        worktree: join(dir, "wt2"),
        launchdLabel: "y",
      },
      {
        id: "shop-app-2",
        repoId: "shop-app",
        kind: "studio-loop",
        accountId: "claude-main",
        stateDir: join(dir, "st2"),
        logsDir: join(dir, "st2-logs"),
        worktree: join(dir, "wt3"),
        launchdLabel: "z",
      },
    ],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const run = (over: Partial<Run>): Run => ({
  id: "r1",
  agentId: "shop-app-ta",
  repoId: "shop-app",
  seq: 1,
  startedAt: NOW - HOUR,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: "claude-opus-5-5",
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

const digest = (over: Partial<RunDigest> = {}): RunDigest => ({
  toolCalls: 1,
  turns: 1,
  lastEventAt: NOW - MIN,
  model: "claude-opus-5-5",
  contextTokens: 100,
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

const boardItem = (over: Partial<BoardItem>): BoardItem => ({
  repoId: "shop-app",
  issueNumber: 42,
  title: "Fix the fence",
  status: "In progress",
  state: "in progress",
  labels: [],
  priority: null,
  updatedAt: NOW,
  url: "https://github.com/o/shop-app/issues/42",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: null,
  closed: false,
  prioritySource: null,
  createdAt: 1,
  itemId: null,
  projectId: null,
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

/** A transcript file whose mtime is `ageMs` before NOW. */
function transcript(name: string, lines: string[], ageMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  const t = (NOW - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

/** Records a collector status as if written at `at`. */
function statusAt(at: number, collector: string, ok: boolean, error: string | null) {
  vi.spyOn(Date, "now").mockReturnValue(at);
  store.setStatus(collector, ok, error);
  vi.restoreAllMocks();
}

const rowOf = (id: string) => crew(config, store, NOW).rows.find((r) => r.id === id);

describe("crew", () => {
  it("a loop with no runs: run, digest and context null, idle, and no attention item", () => {
    const c = crew(config, store, NOW);
    expect(c.rows.map((r) => [r.id, r.index])).toEqual([
      ["shop-app-ta", 0],
      ["studio-builder", 1],
      ["shop-app-2", 2],
    ]);
    expect(c.rows[0]).toEqual({
      id: "shop-app-ta",
      repoId: "shop-app",
      index: 0,
      hudState: "idle",
      stateSince: 0,
      events: [],
      accountId: "claude-main",
      kind: "loop",
      role: null,
      mode: null,
      area: [],
      model: null,
      sessionId: null,
      cli: { version: null, effort: null },
      review: null,
      reviewing: null,
      loopKind: "ta-loop",
      paused: false,
      note: null,
      stop: null,
      sourceError: null,
      ticket: null,
      ticketTitle: null,
      loop: null,
      asideRuns: [],
      queue: [],
      queuedMessages: 0,
      run: null,
      work: null,
      prs: [],
      summary: null,
      digest: null,
      contextWindow: null,
      lastOutputAt: null,
    });
    expect(c.firstRunToday).toBeNull();
    expect(attentionItems(config, store, NOW)).toEqual([]);
  });

  it("carries the latest run, its ticket's board title and its digest", () => {
    store.upsertRun(
      run({ id: "r0", seq: 1, startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR, status: "ok" }),
    );
    store.upsertRun(
      run({
        id: "r1",
        seq: 2,
        startedAt: NOW - HOUR,
        endedAt: NOW - 30 * MIN,
        status: "ok",
        branch: "fix/42-fence",
        ticket: "shop-app#42",
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
        costUsd: 1.5,
      }),
    );
    store.replaceBoard("shop-app", [boardItem({}), boardItem({ issueNumber: 43, title: "other" })]);
    const d = digest({ contextWindow: 1_000_000 });
    store.setDigest("r1", d);
    const row = rowOf("shop-app-ta");
    expect(row).toMatchObject({
      hudState: "idle",
      stateSince: NOW - 30 * MIN,
      ticket: "shop-app#42",
      ticketTitle: "Fix the fence",
      run: {
        id: "r1",
        seq: 2,
        startedAt: NOW - HOUR,
        endedAt: NOW - 30 * MIN,
        status: "ok",
        model: "claude-opus-5-5",
        branch: "fix/42-fence",
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
        costUsd: 1.5,
      },
      digest: d,
      contextWindow: 1_000_000,
      lastOutputAt: NOW - MIN,
    });
    // The run summary carries no transcript path.
    expect(Object.keys(row?.run ?? {}).sort()).toEqual(
      [
        "id",
        "seq",
        "startedAt",
        "endedAt",
        "status",
        "model",
        "branch",
        "tokens",
        "costUsd",
        "costEstimateUsd",
      ].sort(),
    );
  });

  it("ticketTitle is null when the ticket has no board row", () => {
    store.upsertRun(run({ ticket: "shop-app#99", status: "ok", endedAt: NOW - MIN }));
    store.replaceBoard("shop-app", [boardItem({})]);
    expect(rowOf("shop-app-ta")).toMatchObject({ ticket: "shop-app#99", ticketTitle: null });
  });

  it("ticketTitle falls back to the title the run began with, but only for the run's own ticket", () => {
    store.upsertRun(
      run({ ticket: "shop-app#99", ticketTitle: "Fence it", status: "ok", endedAt: NOW - MIN }),
    );
    expect(rowOf("shop-app-ta")).toMatchObject({ ticket: "shop-app#99", ticketTitle: "Fence it" });
    // A run with no ticket of its own takes its PR's; the stored title is not that ticket's.
    store.upsertRun(
      run({
        id: "r2",
        seq: 2,
        startedAt: NOW - 30 * MIN,
        ticket: null,
        ticketTitle: "Fence it",
        prs: [{ repo: "o/shop-app", number: 7 }],
        status: "ok",
        endedAt: NOW - MIN,
      }),
    );
    store.replacePullRequests(
      "shop-app",
      [
        {
          repoId: "shop-app",
          number: 7,
          title: "spec",
          url: "https://github.com/o/shop-app/pull/7",
          branch: "docs/42-spec",
          ticket: "shop-app#42",
          state: "open",
          isDraft: true,
          review: null,
          ci: null,
          createdAt: 1,
          updatedAt: 1,
          mergedAt: null,
          headSha: null,
          mergeable: null,
        },
      ],
      0,
    );
    expect(rowOf("shop-app-ta")).toMatchObject({ ticket: "shop-app#42", ticketTitle: null });
  });

  it("contextWindow falls back to the newest earlier run's digest that has one, else null", () => {
    store.upsertRun(run({ id: "r0", seq: 1, startedAt: NOW - 5 * HOUR, status: "ok" }));
    store.upsertRun(run({ id: "r1", seq: 2, startedAt: NOW - 4 * HOUR, status: "ok" }));
    store.upsertRun(run({ id: "r2", seq: 3, startedAt: NOW - 3 * HOUR, status: "ok" }));
    store.upsertRun(run({ id: "r3", seq: 4, startedAt: NOW - 10 * MIN }));
    expect(rowOf("shop-app-ta")?.contextWindow).toBeNull();
    store.setDigest("r0", digest({ contextWindow: 1_000_000 }));
    store.setDigest("r1", digest({ contextWindow: 200_000 }));
    store.setDigest("r2", digest({ contextWindow: null }));
    store.setDigest("r3", digest({ contextWindow: null }));
    const row = rowOf("shop-app-ta");
    expect(row?.digest?.contextWindow).toBeNull();
    expect(row?.contextWindow).toBe(200_000);
  });

  it("a paused ta-loop with no running run is parked", () => {
    writeFileSync(join(dir, "ta", "PAUSE"), "");
    expect(rowOf("shop-app-ta")).toMatchObject({ hudState: "parked", paused: true });
  });

  it("an open title-marker escalation of any kind on the loop's repo blocks it", () => {
    store.replaceEscalations("shop-app", [escalation({ kind: "loop-blocked" })]);
    store.replaceEscalations("site-builder", [
      escalation({ id: "ae#2", repoId: "site-builder", kind: "mvp-ready" }),
    ]);
    expect(rowOf("shop-app-ta")?.hudState).toBe("blocked");
    expect(rowOf("studio-builder")?.hudState).toBe("blocked");
  });

  it("a label-only escalation is listed in Needs you but never changes a loop's state", () => {
    store.replaceEscalations("shop-app", [
      escalation({ title: "needs a design", kind: "operator-decision", source: "label" }),
    ]);
    store.replaceEscalations("site-builder", [
      escalation({
        id: "ae#3",
        repoId: "site-builder",
        title: "triaged design",
        kind: "autonomy-question",
        source: "label",
      }),
    ]);
    expect(rowOf("shop-app-ta")?.hudState).toBe("idle");
    expect(rowOf("studio-builder")?.hudState).toBe("idle");
    expect(attentionItems(config, store, NOW).filter((i) => i.escalationId !== null)).toHaveLength(
      2,
    );
  });

  it("carries a studio loop's note", () => {
    store.setStatus("studio-loop:studio-builder:note", true, "stopped: quota");
    expect(rowOf("studio-builder")?.note).toBe("stopped: quota");
  });

  it("carries a TA loop's note (launchd job missing)", () => {
    store.setStatus("ta-loop:shop-app-ta:note", true, "launchd job missing: x");
    expect(rowOf("shop-app-ta")?.note).toBe("launchd job missing: x");
  });

  it("a studio loop whose driver stopped is stopped, with its stop; a paused or running one is not", () => {
    const stop = {
      reason: "7-day quota utilization 88% >= QUOTA_STOP_PCT=80% -- refusing to fire",
      at: NOW - HOUR,
      quota: { usedPct: 88, stopPct: 80 },
      resumesAt: NOW + 5 * HOUR,
    };
    expect(rowOf("studio-builder")).toMatchObject({ hudState: "idle", stop: null });
    store.setSetting(driverStopKey("studio-builder"), JSON.stringify(stop));
    expect(rowOf("studio-builder")).toMatchObject({ hudState: "stopped", stop });
    // Not a Needs-you item.
    expect(
      attentionItems(config, store, NOW).filter((i) => i.agentId === "studio-builder"),
    ).toEqual([]);
    // A garbled value is no stop.
    store.setSetting(driverStopKey("studio-builder"), "{nope");
    expect(rowOf("studio-builder")).toMatchObject({ hudState: "idle", stop: null });
  });

  // Review Focus 3: heartbeats move the file mtime, not the newest event.
  it("a working run whose transcript grew a minute ago is running, though its newest event is 15 min old", () => {
    const path = transcript("t.log", ['{"type":"tool_progress"}'], MIN);
    store.upsertRun(run({ transcriptPath: path }));
    store.setDigest("r1", digest({ lastEventAt: NOW - 15 * MIN }));
    expect(rowOf("shop-app-ta")).toMatchObject({ hudState: "running", lastOutputAt: NOW - MIN });
  });

  it("a working run whose transcript has not grown for 11 min is stalled", () => {
    const path = transcript("t.log", ['{"type":"tool_progress"}'], 11 * MIN);
    store.upsertRun(run({ transcriptPath: path }));
    store.setDigest("r1", digest({ lastEventAt: NOW - 15 * MIN }));
    expect(rowOf("shop-app-ta")).toMatchObject({
      hudState: "stalled",
      lastOutputAt: NOW - 11 * MIN,
    });
  });

  it("a stalled loop's stateSince is when the stall began, not the run start", () => {
    const path = transcript("t.log", ['{"type":"tool_progress"}'], 15 * MIN);
    store.upsertRun(run({ transcriptPath: path, startedAt: NOW - 2 * HOUR }));
    store.setDigest("r1", digest({ lastEventAt: NOW - 15 * MIN }));
    expect(rowOf("shop-app-ta")).toMatchObject({ hudState: "stalled", stateSince: NOW - 5 * MIN });
  });

  it("a running loop keeps its run start as stateSince", () => {
    store.upsertRun(run({ startedAt: NOW - 2 * HOUR }));
    store.setDigest("r1", digest({ lastEventAt: NOW - MIN }));
    expect(rowOf("shop-app-ta")).toMatchObject({ hudState: "running", stateSince: NOW - 2 * HOUR });
  });

  // Review Focus 3 Decision: a printed result, then silence on a background shell, is a stall.
  it("a running run whose transcript ends in a result line and has not grown for 11 min is stalled", () => {
    const at = new Date(NOW - 12 * MIN).toISOString();
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m" }),
      JSON.stringify({
        type: "assistant",
        message: { id: "m1", content: [{ type: "text", text: "done" }] },
        parent_tool_use_id: null,
        timestamp: at,
      }),
      JSON.stringify({ type: "result", total_cost_usd: 1, is_error: false }),
    ];
    const path = transcript("t.log", lines, 11 * MIN);
    store.upsertRun(run({ transcriptPath: path }));
    store.setDigest("r1", foldTranscript(null, lines, NOW - 11 * MIN).digest);
    expect(rowOf("shop-app-ta")).toMatchObject({
      hudState: "stalled",
      lastOutputAt: NOW - 11 * MIN,
    });
  });

  // Ruling R21 (run #28): a result line, then a background shell the run waits on.
  it("a run waiting on a background task after its result is running for up to 60 min of quiet", () => {
    const at = new Date(NOW - 70 * MIN).toISOString();
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m" }),
      JSON.stringify({
        type: "system",
        subtype: "task_started",
        task_id: "b1",
        task_type: "local_bash",
        is_backgrounded: true,
        description: "Run the full suite",
      }),
      JSON.stringify({
        type: "assistant",
        message: { id: "m1", content: [{ type: "text", text: "waiting on the suite" }] },
        parent_tool_use_id: null,
        timestamp: at,
      }),
      JSON.stringify({ type: "result", total_cost_usd: 1, is_error: false }),
    ];
    store.upsertRun(run({ seq: 28 }));
    store.setDigest("r1", foldTranscript(null, lines, NOW - 35 * MIN).digest);
    store.upsertRun(run({ seq: 28, transcriptPath: transcript("t.log", lines, 35 * MIN) }));
    expect(rowOf("shop-app-ta")).toMatchObject({
      hudState: "running",
      lastOutputAt: NOW - 35 * MIN,
    });
    expect(attentionItems(config, store, NOW)).toEqual([]);
    store.upsertRun(run({ seq: 28, transcriptPath: transcript("t.log", lines, 61 * MIN) }));
    // 61 min silent against the 60 min limit: the stall began a minute ago.
    expect(rowOf("shop-app-ta")).toMatchObject({
      hudState: "stalled",
      lastOutputAt: NOW - 61 * MIN,
      stateSince: NOW - MIN,
    });
    // Once the task closes, the ordinary 10-minute rule applies again.
    const closed = [
      ...lines,
      JSON.stringify({
        type: "system",
        subtype: "task_notification",
        task_id: "b1",
        status: "completed",
      }),
    ];
    store.setDigest("r1", foldTranscript(null, closed, NOW - 35 * MIN).digest);
    store.upsertRun(run({ seq: 28, transcriptPath: transcript("t.log", closed, 35 * MIN) }));
    expect(rowOf("shop-app-ta")?.hudState).toBe("stalled");
  });

  it("reads a persisted digest without the background field as none", () => {
    const { background: _, ...old } = digest({ lastEventAt: NOW - 35 * MIN });
    store.upsertRun(run({ transcriptPath: transcript("t.log", ["{}"], 35 * MIN) }));
    store.setDigest("r1", old as RunDigest);
    expect(rowOf("shop-app-ta")).toMatchObject({ hudState: "stalled", digest: { background: [] } });
  });

  // Review Focus 4
  it("firstRunToday uses the operator's local midnight: 23:50 yesterday is ignored, 00:10 today wins", () => {
    store.upsertRun(run({ id: "y", startedAt: Date.parse("2026-10-16T22:50:00Z") }));
    store.upsertRun(
      run({
        id: "t2",
        agentId: "studio-builder",
        repoId: "site-builder",
        startedAt: Date.parse("2026-10-17T08:00:00Z"),
        endedAt: Date.parse("2026-10-17T09:00:00Z"),
        status: "ok",
      }),
    );
    store.upsertRun(
      run({
        id: "t1",
        agentId: "shop-app-2",
        startedAt: Date.parse("2026-10-16T23:10:00Z"),
        endedAt: Date.parse("2026-10-16T23:40:00Z"),
        status: "ok",
      }),
    );
    expect(crew(config, store, NOW).firstRunToday).toBe(Date.parse("2026-10-16T23:10:00Z"));
  });

  it("firstRunToday ignores runs of agents that are not configured", () => {
    store.upsertRun(run({ id: "x", agentId: "gone", startedAt: NOW - HOUR }));
    expect(crew(config, store, NOW).firstRunToday).toBeNull();
  });
});

describe("attention items", () => {
  it("lists escalations of every produced kind, a stalled and an error loop, sorted by kind then time", () => {
    store.replaceEscalations("shop-app", [
      escalation({
        id: "shop-app#1",
        issueNumber: 1,
        title: "[operator-decision] a",
        openedAt: NOW - 2 * HOUR,
      }),
      escalation({
        id: "shop-app#2",
        issueNumber: 2,
        title: "[mvp-ready] b",
        kind: "mvp-ready",
        openedAt: NOW - 5 * HOUR,
        url: "https://github.com/o/shop-app/issues/2",
      }),
      escalation({
        id: "shop-app#3",
        issueNumber: 3,
        title: "[loop-blocked] c",
        kind: "loop-blocked",
        openedAt: NOW - 9 * HOUR,
      }),
      escalation({
        id: "shop-app#4",
        issueNumber: 4,
        title: "label only",
        source: "label",
        openedAt: NOW - 3 * HOUR,
      }),
      escalation({
        id: "shop-app#5",
        issueNumber: 5,
        title: "autonomy q",
        kind: "autonomy-question",
        source: "label",
        openedAt: NOW - 4 * HOUR,
      }),
    ]);
    store.replaceEscalations("other", [
      escalation({ id: "other#1", repoId: "other", issueNumber: 1, title: "no loop here" }),
    ]);
    // shop-app-ta stalled on run r7 in Bash.
    const path = transcript("t.log", ["{}"], 20 * MIN);
    store.upsertRun(run({ id: "r7", transcriptPath: path }));
    store.setDigest(
      "r7",
      digest({ lastEventAt: NOW - 25 * MIN, liveTool: { name: "Bash", since: NOW - 30 * MIN } }),
    );
    // studio-builder's collector failing, never having succeeded.
    statusAt(NOW - 5 * MIN, "studio-loop:studio-builder", false, "logs dir missing");

    const items = attentionItems(config, store, NOW);
    expect(items.map((i) => [i.kind, i.key])).toEqual([
      ["stalled", `stall:shop-app-ta:r7:${NOW - 20 * MIN}`],
      ["error", "error:studio-builder:never"],
      ["decision", "esc:other#1"],
      ["decision", "esc:shop-app#5"],
      ["decision", "esc:shop-app#1"],
      ["approval", "esc:shop-app#2"],
      ["question", "esc:shop-app#4"],
      ["parked", "esc:shop-app#3"],
    ]);
    expect(items[0]).toEqual({
      key: `stall:shop-app-ta:r7:${NOW - 20 * MIN}`,
      kind: "stalled",
      agentId: "shop-app-ta",
      repoId: "shop-app",
      text: "No output",
      tool: "Bash",
      at: NOW - 20 * MIN,
      url: null,
      escalationId: null,
      ticket: null,
      owner: "operator",
      acked: false,
    });
    expect(items[1]).toEqual({
      key: "error:studio-builder:never",
      kind: "error",
      agentId: "studio-builder",
      repoId: "site-builder",
      text: "logs dir missing",
      tool: null,
      at: NOW - 5 * MIN,
      url: null,
      escalationId: null,
      ticket: null,
      owner: "operator",
      acked: false,
    });
    // The first loop on the escalation's repo; none for a repo without a loop.
    expect(items.find((i) => i.key === "esc:shop-app#2")).toEqual({
      key: "esc:shop-app#2",
      kind: "approval",
      agentId: "shop-app-ta",
      repoId: "shop-app",
      text: "[mvp-ready] b",
      tool: null,
      at: NOW - 5 * HOUR,
      url: "https://github.com/o/shop-app/issues/2",
      escalationId: "shop-app#2",
      ticket: "shop-app#2",
      owner: "operator",
      acked: false,
    });
    expect(items.find((i) => i.key === "esc:other#1")?.agentId).toBeNull();
  });

  it("a stall with no live tool has tool null", () => {
    const path = transcript("t.log", ["{}"], 20 * MIN);
    store.upsertRun(run({ transcriptPath: path }));
    store.setDigest("r1", digest({ lastEventAt: NOW - 20 * MIN }));
    expect(attentionItems(config, store, NOW)[0]).toMatchObject({ kind: "stalled", tool: null });
  });

  it("a failing collector that stored no text is an error item reading 'collector failed'", () => {
    statusAt(NOW - 5 * MIN, "ta-loop:shop-app-ta", false, null);
    expect(attentionItems(config, store, NOW)).toEqual([
      expect.objectContaining({ kind: "error", agentId: "shop-app-ta", text: "collector failed" }),
    ]);
  });

  it("a loop that has never succeeded keeps its first failure's time, so a read stays read", () => {
    const c = "ta-loop:shop-app-ta";
    statusAt(NOW - 30 * MIN, c, false, "boom");
    store.ack(["error:shop-app-ta:never"], NOW - 29 * MIN);
    statusAt(NOW - 10 * MIN, c, false, "boom");
    expect(attentionItems(config, store, NOW)).toEqual([
      expect.objectContaining({ key: "error:shop-app-ta:never", at: NOW - 30 * MIN, acked: true }),
    ]);
  });

  it("an ack covers the item as read: a re-raised note is unread again", () => {
    const raise = (at: number) =>
      store.raiseNote({
        key: "blocked:x",
        kind: "blocked",
        runId: null,
        seatId: null,
        repoId: null,
        text: "parked",
        at,
      });
    raise(NOW - 20 * MIN);
    store.ack(["note:blocked:x"], NOW - 10 * MIN);
    expect(attentionItems(config, store, NOW)[0]).toMatchObject({ acked: true });
    store.clearNote("blocked:x", NOW - 5 * MIN);
    raise(NOW - 2 * MIN);
    expect(attentionItems(config, store, NOW)[0]).toMatchObject({ acked: false });
  });

  it("an error that recovers and fails again is a new key, timed at its last success", () => {
    const c = "ta-loop:shop-app-ta";
    statusAt(NOW - 30 * MIN, c, false, "boom");
    expect(attentionItems(config, store, NOW).map((i) => [i.key, i.at])).toEqual([
      ["error:shop-app-ta:never", NOW - 30 * MIN],
    ]);
    store.ack(["error:shop-app-ta:never"], NOW - 29 * MIN);
    statusAt(NOW - 20 * MIN, c, true, null);
    expect(attentionItems(config, store, NOW)).toEqual([]);
    statusAt(NOW - 10 * MIN, c, false, "boom again");
    expect(attentionItems(config, store, NOW)).toEqual([
      expect.objectContaining({
        key: `error:shop-app-ta:${NOW - 20 * MIN}`,
        at: NOW - 20 * MIN,
        text: "boom again",
        acked: false,
      }),
    ]);
  });

  // Review Focus 5
  it("an acked stall stays acked; a new stall on another run is not", () => {
    const path = transcript("t.log", ["{}"], 20 * MIN);
    const key = (runId: string) => `stall:shop-app-ta:${runId}:${NOW - 20 * MIN}`;
    store.upsertRun(run({ id: "r1", transcriptPath: path }));
    store.ack([key("r1")], NOW - MIN);
    expect(attentionItems(config, store, NOW)[0]).toMatchObject({ key: key("r1"), acked: true });
    store.upsertRun(run({ id: "r2", seq: 2, startedAt: NOW - 30 * MIN, transcriptPath: path }));
    expect(attentionItems(config, store, NOW)[0]).toMatchObject({ key: key("r2"), acked: false });
  });

  it("a second stall in the same run is a new key: ack, recover, stall again pulses again", () => {
    store.upsertRun(run({ transcriptPath: transcript("t.log", ["{}"], 20 * MIN) }));
    const first = attentionItems(config, store, NOW)[0];
    expect(first).toMatchObject({ key: `stall:shop-app-ta:r1:${NOW - 20 * MIN}`, acked: false });
    store.ack([first?.key ?? ""], NOW - MIN);
    expect(attentionItems(config, store, NOW)[0]?.acked).toBe(true);
    // The transcript grows again (recovered), then goes quiet for 12 minutes.
    store.upsertRun(run({ transcriptPath: transcript("t.log", ["{}", "{}"], MIN) }));
    expect(attentionItems(config, store, NOW)).toEqual([]);
    store.upsertRun(run({ transcriptPath: transcript("t.log", ["{}", "{}"], 12 * MIN) }));
    expect(attentionItems(config, store, NOW)[0]).toMatchObject({
      key: `stall:shop-app-ta:r1:${NOW - 12 * MIN}`,
      kind: "stalled",
      acked: false,
    });
  });
});

describe("attentionItems: PRs waiting on you", () => {
  const pr = (over: Partial<PullRequestView> = {}): PullRequestView => ({
    repoId: "shop-app",
    number: 7,
    title: "spec",
    url: "https://github.com/o/shop-app/pull/7",
    branch: "docs/42-spec",
    ticket: "shop-app#42",
    state: "open",
    isDraft: true,
    review: null,
    ci: null,
    createdAt: NOW - 9 * DAY,
    updatedAt: NOW - 9 * DAY,
    mergedAt: null,
    headSha: null,
    mergeable: null,
    ...over,
  });
  const seed = (prs: PullRequestView[]) => {
    store.replaceBoard("shop-app", [boardItem({})]);
    store.replacePullRequests("shop-app", prs, 0);
  };
  const prItems = () => attentionItems(config, store, NOW).filter((i) => i.kind === "pr");

  it("gives a newly eligible draft a full triage wait", () => {
    config.crew = {
      worktrees: dir,
      maxSeats: 1,
      sessions: [
        {
          id: "s",
          repoId: "shop-app",
          checkout: dir,
          seats: [
            { id: "flight-1", role: "FLIGHT", accountId: "claude-main", model: "opus", area: [] },
          ],
        },
      ],
    };
    store.upsertRun(run({ id: "f", agentId: "flight-1" }));
    store.setSeatSession({
      seatId: "flight-1",
      runId: "f",
      cliSessionId: null,
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    seed([pr({ updatedAt: NOW - HOUR })]);
    expect(prItems()[0]).toMatchObject({ owner: "flight", flightTriage: "waiting" });
    expect(
      attentionItems(config, store, NOW + FLIGHT_TRIAGE_WAIT_MS).find((i) => i.kind === "pr"),
    ).toMatchObject({ owner: "operator", flightTriage: "missed" });
    store.setSeatSession({
      seatId: "flight-1",
      runId: null,
      cliSessionId: null,
      state: "stopped",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    expect(prItems()[0]?.owner).toBe("operator");
  });

  it("a 9-day-old draft on a board ticket is a pr item", () => {
    seed([pr()]);
    expect(prItems()).toEqual([
      {
        key: `pr:shop-app#7:${NOW - 9 * DAY}`,
        kind: "pr",
        agentId: null,
        repoId: "shop-app",
        text: "PR #7 · You: decide on the draft",
        tool: null,
        at: NOW - 9 * DAY,
        url: "https://github.com/o/shop-app/pull/7",
        escalationId: null,
        ticket: "shop-app#42",
        owner: "operator",
        acked: false,
      },
    ]);
  });

  it("approved merges, plain reviews", () => {
    seed([
      pr({ isDraft: false, review: "approved" }),
      pr({ number: 8, isDraft: false, updatedAt: NOW - 2 * HOUR }),
    ]);
    expect(prItems().map((i) => i.text)).toEqual(["PR #7 · You: merge", "PR #8 · You: review"]);
  });

  it("not while an agent is running on the ticket, nor when recent, closed or off-board", () => {
    seed([pr()]);
    store.upsertRun(run({ ticket: "shop-app#42" }));
    expect(prItems()).toEqual([]);
    store.upsertRun(run({ status: "ok", endedAt: NOW - HOUR }));
    expect(prItems()).toHaveLength(1);
    seed([pr({ updatedAt: NOW - 59 * MIN })]);
    expect(prItems()).toEqual([]);
    seed([
      pr({ state: "closed" }),
      pr({ number: 9, ticket: "shop-app#99" }),
      pr({ number: 10, ticket: null }),
    ]);
    expect(prItems()).toEqual([]);
  });

  it("not while the ticket's run is still open, even set aside off its seat", () => {
    seed([pr({ updatedAt: NOW - 2 * HOUR })]);
    // an open run that no seat is running: status is not "running", ended_at is null
    store.upsertRun(run({ ticket: "shop-app#42", status: "ok", endedAt: null }));
    expect(prItems()).toEqual([]);
    store.upsertRun(run({ ticket: "shop-app#42", status: "ok", endedAt: NOW - MIN }));
    expect(prItems().map((i) => i.text)).toEqual(["PR #7 · You: decide on the draft"]);
  });

  it("a PR's item clears once its ticket is closed on the board", () => {
    seed([pr()]);
    expect(prItems()).toHaveLength(1);
    store.replaceBoard("shop-app", [boardItem({ closed: true })]);
    expect(prItems()).toEqual([]);
  });

  it("a PR on a ticket with no run is the operator's as before", () => {
    seed([pr({ updatedAt: NOW - 2 * HOUR })]);
    expect(prItems().map((i) => i.text)).toEqual(["PR #7 · You: decide on the draft"]);
  });

  it("a changed PR is a new key, and an ack of the old one does not carry", () => {
    seed([pr()]);
    const old = prItems()[0]?.key as string;
    store.ack([old], NOW);
    expect(prItems()[0]?.acked).toBe(true);
    seed([pr({ updatedAt: NOW - 2 * HOUR })]);
    expect(prItems()[0]).toMatchObject({ acked: false });
    expect(prItems()[0]?.key).not.toBe(old);
  });
});

describe("crew seats in the rows", () => {
  const withCrew = (): CcConfig => ({
    ...config,
    crew: {
      worktrees: join(dir, "crew-wt"),
      maxSeats: 4,
      sessions: [
        {
          id: "shop-app-1",
          repoId: "shop-app",
          checkout: join(dir, "crew-co"),
          seats: [
            {
              id: "GUIDO-1",
              role: "GUIDO",
              accountId: "claude-main",
              model: "sonnet",
              area: ["apps/**"],
            },
            { id: "RETRO-1", role: "RETRO", accountId: "claude-main", model: "haiku", area: [] },
          ],
        },
      ],
    },
  });
  const seat = (over: Partial<SeatSessionRow>): SeatSessionRow => ({
    seatId: "GUIDO-1",
    runId: "c1",
    cliSessionId: null,
    state: "running",
    reason: null,
    worktree: null,
    updatedAt: NOW - 5 * MIN,
    ...over,
  });
  const crewRun = (over: Partial<Run> = {}): Run =>
    run({ id: "c1", agentId: "GUIDO-1", repoId: "shop-app", ...over });
  const rowOf = (c: CcConfig, id: string) => crew(c, store, NOW).rows.find((r) => r.id === id);

  it("shows a transferred run's binding without changing another seat or observed loop", () => {
    const c = withCrew();
    store.upsertRun(crewRun());
    store.setSeatSession(seat({}));
    store.setSetting(
      "account-transfer:c1",
      JSON.stringify({ source: "claude-main", target: "destination", pending: false }),
    );
    expect(rowOf(c, "GUIDO-1")?.accountId).toBe("destination");
    expect(agentViews(c, store, NOW).find((a) => a.id === "GUIDO-1")?.accountId).toBe(
      "destination",
    );
    expect(rowOf(c, "RETRO-1")?.accountId).toBe("claude-main");
    expect(rowOf(c, "shop-app-ta")?.accountId).toBe("claude-main");
  });

  it("lists seats after the loops, with role, mode, area, model and session", () => {
    const c = withCrew();
    store.upsertRun(crewRun());
    store.setSeatSession(seat({}));
    const rows = crew(c, store, NOW).rows;
    expect(rows.map((r) => r.id)).toEqual([
      "shop-app-ta",
      "studio-builder",
      "shop-app-2",
      "GUIDO-1",
      "RETRO-1",
    ]);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(rows[0]).toMatchObject({ kind: "loop", role: null, mode: null, area: [], model: null });
    expect(rows[3]).toMatchObject({
      kind: "crew",
      loopKind: "crew",
      role: "GUIDO",
      mode: "writer",
      area: ["apps/**"],
      model: "sonnet",
      sessionId: "shop-app-1",
      repoId: "shop-app",
      accountId: "claude-main",
      hudState: "running",
      stateSince: NOW - 5 * MIN,
    });
    expect(rows[3]?.run?.id).toBe("c1");
    expect(rows[4]).toMatchObject({
      kind: "crew",
      role: "RETRO",
      mode: "read-only",
      hudState: "idle",
    });
    expect(rows[4]?.run).toBeNull();
  });

  it("a crew row's loop names the run's profile and the step for its phase", () => {
    const c = withCrew();
    const feature = DEFAULT_PROFILES.find((p) => p.name === "feature") as Profile;
    store.upsertRun(
      crewRun({
        ticket: "shop-app#5",
        loop: { ...NEW_LOOP, phase: "working" },
        profile: { profile: feature, route: { by: "size", size: "M" }, hash: "h" },
      }),
    );
    store.setSeatSession(seat({}));
    expect(rowOf(c, "GUIDO-1")?.loop).toMatchObject({ profile: "feature", step: "implement" });
    store.setRunLoop("c1", { ...NEW_LOOP, phase: "ci" });
    expect(rowOf(c, "GUIDO-1")?.loop).toMatchObject({ profile: "feature", step: "verify" });
    store.setRunLoop("c1", { ...NEW_LOOP, phase: "parked" });
    expect(rowOf(c, "GUIDO-1")?.loop).toMatchObject({ profile: "feature", step: null });
  });

  it("uses the run profile's review round limit", () => {
    const c = withCrew();
    const profile = { ...DEFAULT_PROFILES[0], rounds: 2 } as Profile;
    store.upsertRun(
      crewRun({
        loop: { ...NEW_LOOP, phase: "review" },
        profile: { profile, route: { by: "size", size: "S" }, hash: "h" },
      }),
    );
    store.setSeatSession(seat({}));
    for (let n = 1; n <= 3; n++)
      store.claimLine(`fix:c1:0:${n}`, {
        runId: "c1",
        seatId: "GUIDO-1",
        origin: "engine",
        text: "fix",
        at: NOW,
      });
    expect(rowOf(c, "GUIDO-1")?.loop?.tries).toMatchObject({ n: 2, max: 2 });
  });

  it("a run without a profile has no profile or step on its loop", () => {
    const c = withCrew();
    store.upsertRun(crewRun({ ticket: "shop-app#5", loop: NEW_LOOP }));
    store.setSeatSession(seat({}));
    expect(rowOf(c, "GUIDO-1")?.loop).not.toHaveProperty("profile");
    expect(rowOf(c, "GUIDO-1")?.loop).not.toHaveProperty("steps");
    expect(rowOf(c, "GUIDO-1")?.loop).not.toHaveProperty("planned");
  });

  it("a parked seat reports its queued messages", () => {
    const c = withCrew();
    store.upsertRun(crewRun());
    const send = (at: number) =>
      store.addComms({ at, from: COMMS_CAPCOM, to: "GUIDO-1", ticket: null, text: "hello" });
    send(NOW - 20 * MIN);
    send(NOW - 10 * MIN - 1);
    send(NOW - 10 * MIN);
    send(NOW - 5 * MIN);
    send(NOW - MIN);
    store.setSeatSession(
      seat({ state: "parked", reason: "rate limited", updatedAt: NOW - 10 * MIN }),
    );
    expect(rowOf(c, "GUIDO-1")).toMatchObject({ hudState: "parked", queuedMessages: 3 });
    store.setSeatSession(seat({ state: "running" }));
    expect(rowOf(c, "GUIDO-1")?.queuedMessages).toBe(0);
  });

  it("a crew row's loop carries the profile's steps and whether a planner's plan landed", () => {
    const c = withCrew();
    const feature = DEFAULT_PROFILES.find((p) => p.name === "feature") as Profile;
    store.upsertRun(
      crewRun({
        ticket: "shop-app#5",
        loop: { ...NEW_LOOP, phase: "ci" },
        profile: { profile: feature, route: { by: "size", size: "M" }, hash: "h" },
      }),
    );
    store.setSeatSession(seat({}));
    const loop = rowOf(c, "GUIDO-1")?.loop;
    expect(loop?.steps).toEqual(feature.steps.map((s) => ({ name: s.name, phase: s.phase })));
    expect(loop?.planned).toBe(false);
    store.upsertRun(
      run({ id: "p1", agentId: "RETRO-1", repoId: "shop-app", ticket: "shop-app#6" }),
    );
    store.addLoopEvent("p1:plan", "p1", "planned", NOW);
    expect(rowOf(c, "GUIDO-1")?.loop?.planned).toBe(false);
    store.upsertRun(
      run({ id: "p2", agentId: "RETRO-1", repoId: "shop-app", ticket: "shop-app#5" }),
    );
    store.addLoopEvent("p2:plan", "p2", "planned", NOW);
    expect(rowOf(c, "GUIDO-1")?.loop?.planned).toBe(true);
  });

  it("a writer seat's row lists its queue in order without the ticket it holds; other rows have none", () => {
    const c = withCrew();
    store.replaceQueue("GUIDO-1", [
      { repoId: "shop-app", issue: 5 },
      { repoId: "shop-app", issue: 3 },
      { repoId: "shop-app", issue: 8 },
    ]);
    store.takeQueued("GUIDO-1", NOW);
    expect(rowOf(c, "GUIDO-1")?.queue).toEqual([
      { ref: "shop-app#3", issue: 3, pos: 1 },
      { ref: "shop-app#8", issue: 8, pos: 2 },
    ]);
    expect(rowOf(c, "RETRO-1")?.queue).toEqual([]);
    expect(rowOf(c, "shop-app-ta")?.queue).toEqual([]);
  });

  const tokens = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheCreate: 0 });

  it("work counts only the latest run's commits and guard refusals; a loop or no run has none", () => {
    const c = withCrew();
    store.upsertRun(crewRun({ id: "c0", startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR }));
    store.upsertRun(crewRun({ id: "c1", seq: 2 }));
    store.setSeatSession(seat({}));
    const commit = (runId: string, sha: string) =>
      store.addRunCommit({ runId, repoId: "shop-app", branch: "b", sha, at: NOW });
    commit("c0", "a".repeat(40));
    commit("c1", "b".repeat(40));
    commit("c1", "c".repeat(40));
    const hit = (runId: string) =>
      store.addGuardHit({ agentId: "GUIDO-1", runId, rule: "network", text: "x", at: NOW });
    hit("c0");
    hit("c0");
    hit("c1");
    expect(rowOf(c, "GUIDO-1")?.work).toEqual({ commits: 2, denials: 1 });
    expect(rowOf(c, "RETRO-1")?.work).toBeNull();
    store.upsertRun(run({ id: "l1" }));
    expect(rowOf(c, "shop-app-ta")?.work).toBeNull();
  });

  describe("a running crew run's cost estimate", () => {
    const costRun = (over: Partial<Run>) =>
      crewRun({ model: "sonnet", tokens: tokens(150_000), ...over });
    const estimate = () => rowOf(withCrew(), "GUIDO-1")?.run?.costEstimateUsd;

    it("carries the run's cost per token over the tokens since its last result", () => {
      store.upsertRun(costRun({ costUsd: 1 }));
      store.setSeatSession(seat({}));
      store.setDigest("c1", digest({ costTokens: 100_000 }));
      expect(estimate()).toBeCloseTo(1.5, 10);
    });

    it("with no cost yet, prices the tokens at the newest earlier same-model run's rate", () => {
      store.upsertRun(
        crewRun({
          id: "c0",
          startedAt: NOW - 5 * HOUR,
          endedAt: NOW - 4 * HOUR,
          status: "ok",
          model: "sonnet",
          costUsd: 2,
          tokens: tokens(400_000),
        }),
      );
      store.upsertRun(
        crewRun({
          id: "cx",
          startedAt: NOW - 3 * HOUR,
          endedAt: NOW - 2 * HOUR,
          status: "ok",
          model: "opus",
          costUsd: 90,
          tokens: tokens(1000),
        }),
      );
      store.upsertRun(costRun({ seq: 2 }));
      store.setSeatSession(seat({}));
      expect(estimate()).toBeCloseTo((150_000 * 2) / 400_000, 10);
    });

    it("is null for an ended run, a loop row, and when no rate exists", () => {
      store.upsertRun(costRun({ costUsd: 1 }));
      store.setSeatSession(seat({}));
      expect(estimate()).toBeNull();
      store.upsertRun(run({ id: "l1", costUsd: 1, tokens: tokens(10) }));
      store.setDigest("l1", digest({ costTokens: 5 }));
      expect(rowOf(withCrew(), "shop-app-ta")?.run?.costEstimateUsd).toBeNull();
      store.setDigest("c1", digest({ costTokens: 100_000 }));
      store.setRunEnded("c1", NOW, "ok", "engine");
      expect(estimate()).toBeNull();
    });
  });

  it("a scratch seat's crew row says scratch", () => {
    const c = withCrew();
    const retro = c.crew?.sessions[0]?.seats.find((s) => s.id === "RETRO-1");
    if (retro) retro.mode = "scratch";
    expect(rowOf(c, "RETRO-1")?.mode).toBe("scratch");
  });

  it("a reviewing seat says which PR", () => {
    const c = withCrew();
    const sha = "c".repeat(40);
    store.upsertRun(crewRun());
    store.setSeatSession(seat({}));
    const id = store.requestReview({
      authorRunId: "c1",
      repoId: "shop-app",
      seatId: "RETRO-1",
      prNumber: 12,
      sha,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: NOW - MIN,
    });
    if (id === null) throw new Error("not queued");
    store.upsertRun(
      crewRun({ id: "r1", agentId: "RETRO-1", reviewId: id, ticket: "shop-app#90", loop: null }),
    );
    expect(rowOf(c, "RETRO-1")?.reviewing).toEqual({ prNumber: 12, sha, ref: "shop-app#90" });
    expect(rowOf(c, "GUIDO-1")?.reviewing).toBeNull();
    // an ended review run is no longer reviewing
    store.setRunEnded("r1", NOW, "ok", "engine");
    expect(rowOf(c, "RETRO-1")?.reviewing).toBeNull();
  });

  it("carries the CLI version and the seat's configured effort; a loop has neither", () => {
    const c = withCrew();
    const seatCfg = c.crew?.sessions[0]?.seats[0];
    if (seatCfg) seatCfg.effort = "max";
    const rows = crew(c, store, NOW, NO_LOCK, () => "2.1.302").rows;
    const by = (id: string) => rows.find((r) => r.id === id);
    expect(by("GUIDO-1")?.cli).toEqual({ version: "2.1.302", effort: "max" });
    expect(by("RETRO-1")?.cli).toEqual({ version: "2.1.302", effort: null });
    expect(by("shop-app-ta")?.cli).toEqual({ version: null, effort: null });
    expect(
      crew(c, store, NOW, NO_LOCK, () => null).rows.find((r) => r.id === "GUIDO-1")?.cli.version,
    ).toBe(null);
  });

  it("asks for the CLI version once per call, however many seats there are", () => {
    const c = withCrew();
    c.crew?.sessions[0]?.seats.push({
      id: "GUIDO-2",
      role: "GUIDO",
      accountId: "claude-main",
      model: "sonnet",
      area: [],
    });
    let calls = 0;
    const rows = crew(c, store, NOW, NO_LOCK, () => {
      calls += 1;
      return "2.1.302";
    }).rows;
    expect(rows.filter((r) => r.cli.version === "2.1.302")).toHaveLength(3);
    expect(calls).toBe(1);
  });

  describe("review", () => {
    const BRANCH = "feature/90-x";
    const pr = (over: Partial<PullRequestView>): PullRequestView => ({
      repoId: "shop-app",
      number: 7,
      title: "t",
      url: "u",
      branch: BRANCH,
      ticket: null,
      state: "open",
      isDraft: false,
      review: null,
      ci: null,
      createdAt: NOW - HOUR,
      updatedAt: NOW - HOUR,
      mergedAt: null,
      headSha: null,
      mergeable: null,
      ...over,
    });
    const reviewOf = (prs: PullRequestView[], runBranch: string | null = BRANCH) => {
      const c = withCrew();
      store.upsertRun(crewRun({ branch: runBranch }));
      store.setSeatSession(seat({ state: "idle" }));
      for (const repoId of ["shop-app", "site-builder"]) {
        store.replacePullRequests(
          repoId,
          prs.filter((p) => p.repoId === repoId),
          NOW,
        );
      }
      return rowOf(c, "GUIDO-1")?.review;
    };

    it("is null when the run's branch has no open PR", () => {
      expect(reviewOf([])).toBeNull();
      expect(reviewOf([pr({ branch: "feature/other" })])).toBeNull();
      expect(reviewOf([pr({ state: "merged" })])).toBeNull();
      expect(reviewOf([pr({ state: "closed" })])).toBeNull();
      expect(reviewOf([pr({})], null)).toBeNull();
      expect(reviewOf([pr({ repoId: "site-builder" })])).toBeNull();
    });

    it("names the open PR and its state", () => {
      expect(reviewOf([pr({ isDraft: true })])).toEqual({
        prNumber: 7,
        state: "draft",
        reviewing: null,
      });
      expect(reviewOf([pr({})])).toEqual({ prNumber: 7, state: "open", reviewing: null });
      expect(reviewOf([pr({ review: "requested" })])).toEqual({
        prNumber: 7,
        state: "open",
        reviewing: null,
      });
      expect(reviewOf([pr({ review: "changes" })])).toEqual({
        prNumber: 7,
        state: "changes",
        reviewing: null,
      });
      expect(reviewOf([pr({ review: "approved" })])).toEqual({
        prNumber: 7,
        state: "approved",
        reviewing: null,
      });
    });

    it("names the newest of several open PRs on the branch", () => {
      expect(reviewOf([pr({ number: 7 }), pr({ number: 9 }), pr({ number: 8 })])).toEqual({
        prNumber: 9,
        state: "open",
        reviewing: null,
      });
      expect(
        reviewOf([pr({ number: 9, state: "closed" }), pr({ number: 7, review: "approved" })]),
      ).toEqual({ prNumber: 7, state: "approved", reviewing: null });
    });

    it("names the review seat while a review of the open PR is queued, starting or running", () => {
      let attempt = 0;
      const ask = (prNumber: number, at: number, repoId = "shop-app") => {
        attempt += 1;
        return store.requestReview({
          authorRunId: "c1",
          repoId,
          seatId: "RETRO-1",
          prNumber,
          sha: "c".repeat(40),
          epoch: 0,
          attempt,
          round: 1,
          at,
        });
      };
      const reviewing = () => reviewOf([pr({ number: 7 })])?.reviewing;
      expect(reviewing()).toBeNull();
      // other PRs, in this repo or another, leave PR 7 alone
      expect(ask(8, NOW - MIN)).not.toBeNull();
      expect(ask(7, NOW - MIN, "site-builder")).not.toBeNull();
      expect(reviewing()).toBeNull();
      const id = ask(7, NOW - MIN) as number;
      expect(reviewing()).toBe("RETRO-1");
      store.setReviewState(id, ["queued"], "running", { at: NOW, runId: "rr" });
      expect(reviewing()).toBe("RETRO-1");
      store.setReviewState(id, ["running"], "superseded", { at: NOW });
      expect(reviewing()).toBeNull();
    });

    it("is null for a loop row", () => {
      expect(rowOf(withCrew(), "shop-app-ta")?.review).toBeNull();
    });
  });

  describe("loop on a crew row", () => {
    const loopOf = (over: Partial<RunLoop>): RunLoop => ({ ...NEW_LOOP, ...over });
    it("a looped run's row carries its phase, text, PR and park reason", () => {
      const c = withCrew();
      store.upsertRun(crewRun({ ticket: "mission-control#197" }));
      store.setSeatSession(seat({}));
      store.setRunLoop("c1", loopOf({ phase: "ci", pushFor: "abcdef1234" }));
      expect(rowOf(c, "GUIDO-1")?.loop).toEqual({
        phase: "ci",
        text: "CI on abcdef1",
        prNumber: null,
        parked: null,
        tries: { n: 1, max: 3, failures: 0, runs: 0 },
        wait: "ci",
      });
      store.setRunLoop("c1", loopOf({ phase: "review", prNumber: 208 }));
      expect(rowOf(c, "GUIDO-1")?.loop).toEqual({
        phase: "review",
        text: "In review · PR #208",
        prNumber: 208,
        parked: null,
        tries: { n: 1, max: 3 },
        wait: null,
      });
      store.setRunLoop(
        "c1",
        loopOf({
          phase: "parked",
          parked: { kind: "ci", reason: "CI failed 3 times", ended: false },
        }),
      );
      expect(rowOf(c, "GUIDO-1")?.loop).toEqual({
        phase: "parked",
        text: "Blocked: CI failed 3 times",
        prNumber: null,
        parked: "CI failed 3 times",
        tries: null,
        wait: "operator",
      });
      store.setRunLoop("c1", loopOf({ phase: "working" }));
      expect(rowOf(c, "GUIDO-1")?.loop?.text).toBe("Working on mission-control#197");
    });
    it("a done loop is carried with its PR", () => {
      const c = withCrew();
      store.upsertRun(crewRun());
      store.setSeatSession(seat({}));
      store.setRunLoop("c1", loopOf({ phase: "done", prNumber: 9 }));
      expect(rowOf(c, "GUIDO-1")?.loop).toEqual({
        phase: "done",
        text: "Done · PR #9",
        prNumber: 9,
        parked: null,
        tries: null,
        wait: null,
      });
    });
    it("a parked-ended loop on an ended run still carries its reason", () => {
      const c = withCrew();
      store.upsertRun(crewRun({ status: "ok", endedAt: NOW - MIN }));
      store.setRunLoop(
        "c1",
        loopOf({ phase: "parked", parked: { kind: "ci", reason: "gave up", ended: true } }),
      );
      expect(rowOf(c, "GUIDO-1")?.loop).toMatchObject({
        phase: "parked",
        text: "Blocked: gave up",
        parked: "gave up",
      });
    });
    it("a crew run without a loop has none", () => {
      const c = withCrew();
      store.upsertRun(crewRun());
      store.setSeatSession(seat({}));
      expect(rowOf(c, "GUIDO-1")?.loop).toBeNull();
    });
    it("an observed loop agent has none, whatever its run holds", () => {
      store.upsertRun(run({ id: "l1", agentId: "shop-app-ta", repoId: "shop-app" }));
      store.setRunLoop("l1", loopOf({ phase: "review", prNumber: 3 }));
      expect(rowOf(withCrew(), "shop-app-ta")?.loop).toBeNull();
      expect(rowOf(withCrew(), "shop-app-ta")?.asideRuns).toEqual([]);
    });

    describe("set-aside runs", () => {
      const aside = { worktree: "/wt", wake: false };
      it("lists the seat's other set-aside runs; the held run is the row's", () => {
        const c = withCrew();
        store.upsertRun(
          crewRun({ id: "a", startedAt: NOW - 3 * MIN, ticket: "mission-control#5" }),
        );
        store.setRunLoop("a", loopOf({ phase: "review", prNumber: 12, aside }));
        store.upsertRun(crewRun({ id: "b", startedAt: NOW - MIN }));
        store.setRunLoop("b", loopOf({ phase: "working" }));
        store.setSeatSession(seat({ runId: "b" }));
        const row = rowOf(c, "GUIDO-1");
        expect(row?.run?.id).toBe("b");
        expect(row?.asideRuns).toHaveLength(1);
        expect(row?.asideRuns?.[0]).toMatchObject({
          runId: "a",
          ticket: "mission-control#5",
          loop: { phase: "review", prNumber: 12 },
        });
      });
      it("a lone set-aside run the seat does not hold is the row's run, not an aside run", () => {
        const c = withCrew();
        store.upsertRun(crewRun({ id: "a" }));
        store.setRunLoop("a", loopOf({ phase: "review", prNumber: 12, aside }));
        store.setSeatSession(seat({ runId: null, state: "idle" }));
        const row = rowOf(c, "GUIDO-1");
        expect(row?.run?.id).toBe("a");
        expect(row?.asideRuns).toEqual([]);
      });
    });

    describe("wait", () => {
      const aside = { worktree: "/wt", wake: false };
      const waitOf = (c: CcConfig, lock?: TestLockState) =>
        crew(c, store, NOW, lock).rows.find((r) => r.id === "GUIDO-1")?.loop?.wait;
      const start = (over: Partial<RunLoop>, runOver: Partial<Run> = {}) => {
        store.upsertRun(crewRun(runOver));
        store.setSeatSession(seat({}));
        store.setRunLoop("c1", loopOf(over));
      };
      const note = (key: string) =>
        store.raiseNote({
          key,
          kind: "ready",
          runId: "c1",
          seatId: "GUIDO-1",
          repoId: "shop-app",
          text: "t",
          at: NOW,
        });
      it("lock: the run is in line for the test lock", () => {
        start({ phase: "working" });
        const lock: TestLockState = {
          holder: null,
          waiting: [{ runId: "c1", seatId: "GUIDO-1", command: "pnpm -s test", since: NOW - MIN }],
        };
        expect(waitOf(withCrew(), lock)).toBe("lock");
      });
      it("operator: the run is parked", () => {
        start({ phase: "parked", parked: { kind: "ci", reason: "x", ended: false } });
        expect(waitOf(withCrew())).toBe("operator");
      });
      it("seat: a set-aside run flagged to wake", () => {
        start({ phase: "review", aside: { ...aside, wake: true } });
        expect(waitOf(withCrew())).toBe("seat");
      });
      it("ci: the run is in CI", () => {
        start({ phase: "ci" });
        expect(waitOf(withCrew())).toBe("ci");
      });
      it("operator: a review with an open ready note", () => {
        start({ phase: "review" });
        note("ready:c1:abc");
        expect(waitOf(withCrew())).toBe("operator");
      });
      it.each(["working", "ci", "review"] as const)("main: a %s run updating main", (phase) => {
        start({ phase, mainMerge: { mainSha: "abc", files: ["a.ts"] } });
        expect(waitOf(withCrew())).toBe("main");
      });
      /** A run in review at epoch 1, pushed at abc123, with a queued review of it; its id. */
      const queueReview = (): number => {
        start({ phase: "review", epoch: 1 });
        store.setRunPush({ runId: "c1", sha: "abc123", at: NOW });
        const id = store.requestReview({
          authorRunId: "c1",
          repoId: "shop-app",
          seatId: "RETRO-1",
          prNumber: 4,
          sha: "abc123",
          epoch: 1,
          attempt: 1,
          round: 1,
          at: NOW,
        });
        if (id === null) throw new Error("no review");
        return id;
      };
      /** The crew config with RETRO-1 a scratch seat, which makes it the review seat. */
      const withReviewSeat = (): CcConfig => {
        const c = withCrew();
        const seats = c.crew?.sessions[0]?.seats ?? [];
        for (const s of seats) if (s.id === "RETRO-1") s.mode = "scratch";
        return c;
      };
      it("retro: a review with a review seat, a push and a queued review of it", () => {
        queueReview();
        expect(waitOf(withReviewSeat())).toBe("retro");
      });
      it("null: a review with no review seat", () => {
        queueReview();
        expect(waitOf(withCrew())).toBeNull();
      });
      it("null: a reported review the seat is fixing", () => {
        const id = queueReview();
        store.setReviewState(id, ["queued"], "running", { at: NOW, runId: "rr" });
        store.recordFindings(id, "rr", {
          verdict: { spec: "pass", quality: "fail" },
          summary: "s",
          findings: [
            { severity: "Important", file: "a.ts", line: 1, summary: "s", scenario: "w", fix: "f" },
          ],
          at: NOW,
        });
        store.claimLine(`fix:c1:1:${id}`, {
          runId: "c1",
          seatId: "GUIDO-1",
          origin: "engine",
          text: "fix",
          at: NOW,
        });
        expect(waitOf(withReviewSeat())).toBeNull();
      });
      it("null: working, and an ended run", () => {
        start({ phase: "working" });
        expect(waitOf(withCrew())).toBeNull();
        store.upsertRun(crewRun({ status: "ok", endedAt: NOW - MIN }));
        store.setRunLoop("c1", loopOf({ phase: "ci" }));
        expect(waitOf(withCrew())).toBeNull();
      });
    });

    describe("tries", () => {
      const triesOf = (c: CcConfig) => rowOf(c, "GUIDO-1")?.loop?.tries;
      it("ci: the CI try", () => {
        store.upsertRun(crewRun());
        store.setSeatSession(seat({}));
        store.setRunLoop("c1", loopOf({ phase: "ci", ciFails: 1 }));
        expect(triesOf(withCrew())).toEqual({ n: 2, max: 3, failures: 1, runs: 0 });
      });
      it("review: the round, from the fix lines claimed this epoch", () => {
        store.upsertRun(crewRun());
        store.setSeatSession(seat({}));
        store.setRunLoop("c1", loopOf({ phase: "review", epoch: 0 }));
        store.claimLine("fix:c1:0:7", {
          runId: "c1",
          seatId: "GUIDO-1",
          origin: "engine",
          text: "fix",
          at: NOW,
        });
        expect(triesOf(withCrew())).toEqual({ n: 2, max: 3 });
      });
      it("working: none", () => {
        store.upsertRun(crewRun());
        store.setSeatSession(seat({}));
        store.setRunLoop("c1", loopOf({ phase: "working" }));
        expect(triesOf(withCrew())).toBeNull();
      });
    });
  });

  it("a running seat stalls after STALL_MS without output", () => {
    const c = withCrew();
    store.upsertRun(crewRun());
    store.setSeatSession(seat({}));
    store.setDigest("c1", digest({ lastEventAt: NOW - 11 * MIN }));
    expect(rowOf(c, "GUIDO-1")).toMatchObject({ hudState: "stalled", stateSince: NOW - MIN });
    store.setDigest("c1", digest({ lastEventAt: NOW - 9 * MIN }));
    expect(rowOf(c, "GUIDO-1")?.hudState).toBe("running");
  });

  it("a seat that wrote nothing is stalled from its row's last change plus STALL_MS", () => {
    const c = withCrew();
    store.upsertRun(crewRun());
    store.setSeatSession(seat({ updatedAt: NOW - 11 * MIN }));
    expect(rowOf(c, "GUIDO-1")).toMatchObject({
      hudState: "stalled",
      lastOutputAt: null,
      stateSince: NOW - MIN,
    });
  });

  it("a seat's background task does not stretch its stall: stateSince is never in the future", () => {
    const c = withCrew();
    store.upsertRun(crewRun());
    store.setSeatSession(seat({}));
    store.setDigest(
      "c1",
      digest({
        lastEventAt: NOW - 11 * MIN,
        background: [{ taskId: "b1", description: "sleep", type: "local_bash" }],
      }),
    );
    const row = rowOf(c, "GUIDO-1");
    expect(row).toMatchObject({ hudState: "stalled", stateSince: NOW - MIN });
    expect(row?.stateSince).toBeLessThanOrEqual(NOW);
  });

  it("a stall never began before its run did", () => {
    // silent for 15 min by an old event, but the run only started 2 min ago
    store.upsertRun(run({ startedAt: NOW - 2 * MIN }));
    store.setDigest("r1", digest({ lastEventAt: NOW - 15 * MIN }));
    expect(rowOf(withCrew(), "shop-app-ta")).toMatchObject({
      hudState: "stalled",
      stateSince: NOW - 2 * MIN,
    });
  });

  it("carries the seat's reason, and maps parked, stopped and error", () => {
    const c = withCrew();
    store.upsertRun(crewRun());
    store.setSeatSession(seat({ state: "parked", reason: "rate limited until 14:00" }));
    expect(rowOf(c, "GUIDO-1")).toMatchObject({
      hudState: "parked",
      note: "rate limited until 14:00",
    });
    store.setSeatSession(seat({ state: "stopped", reason: null, runId: null }));
    expect(rowOf(c, "GUIDO-1")?.hudState).toBe("stopped");
    store.setSeatSession(seat({ state: "error", reason: "process exited 1" }));
    expect(rowOf(c, "GUIDO-1")).toMatchObject({
      hudState: "error",
      sourceError: "process exited 1",
    });
  });

  it("an error seat is an error attention item; a stalled one a stall item", () => {
    const c = withCrew();
    store.upsertRun(crewRun());
    store.setSeatSession(
      seat({ state: "error", reason: "process exited 1", updatedAt: NOW - MIN }),
    );
    const err = attentionItems(c, store, NOW).find((i) => i.agentId === "GUIDO-1");
    expect(err).toMatchObject({
      kind: "error",
      key: `error:GUIDO-1:${NOW - MIN}`,
      text: "process exited 1",
      repoId: "shop-app",
    });
    store.setSeatSession(seat({}));
    store.setDigest("c1", digest({ lastEventAt: NOW - 11 * MIN }));
    const stall = attentionItems(c, store, NOW).find((i) => i.agentId === "GUIDO-1");
    expect(stall).toMatchObject({ kind: "stalled", key: `stall:GUIDO-1:c1:${NOW - 11 * MIN}` });
  });

  it("firstRunToday counts a crew run", () => {
    const c = withCrew();
    store.upsertRun(crewRun({ startedAt: NOW - 2 * HOUR }));
    expect(crew(c, store, NOW).firstRunToday).toBe(NOW - 2 * HOUR);
  });
});

describe("crew items: strays, questions, crew errors and the test lock", () => {
  const withCrew = (): CcConfig => ({
    ...config,
    crew: {
      worktrees: join(dir, "crew-wt"),
      maxSeats: 4,
      sessions: [
        {
          id: "shop-app-1",
          repoId: "shop-app",
          checkout: join(dir, "crew-co"),
          seats: [
            {
              id: "GUIDO-1",
              role: "GUIDO",
              accountId: "claude-main",
              model: "sonnet",
              area: ["apps/**"],
            },
            {
              id: "GUIDO-2",
              role: "GUIDO",
              accountId: "claude-main",
              model: "sonnet",
              area: ["web/**"],
            },
          ],
        },
      ],
    },
  });
  const seat = (seatId: string, runId: string, over: Partial<SeatSessionRow> = {}) =>
    store.setSeatSession({
      seatId,
      runId,
      cliSessionId: null,
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: NOW - 30 * MIN,
      ...over,
    });
  const crewRun = (id: string, agentId: string) =>
    store.upsertRun(run({ id, agentId, repoId: "shop-app", startedAt: NOW - HOUR }));
  const items = (c: CcConfig, lock: TestLockState = NO_LOCK) =>
    attentionItems(c, store, NOW, lock).filter((i) => i.agentId?.startsWith("GUIDO"));

  it("lists a stray outside every area, and one in another writer's area, by its key", () => {
    const c = withCrew();
    store.addStrays([
      {
        sessionId: "shop-app-1",
        path: "docs/c.md",
        agentId: "GUIDO-1",
        kind: "outside",
        at: NOW - 2 * MIN,
      },
      {
        sessionId: "shop-app-1",
        path: "web/b.ts",
        agentId: "GUIDO-1",
        kind: "other-area",
        at: NOW - MIN,
      },
    ]);
    const strays = store.strays();
    expect(strays.map((s) => s.key)).toEqual(
      ["docs/c.md", "web/b.ts"].map(
        (p) =>
          `stray:${createHash("sha256").update(`shop-app-1\0${p}`).digest("hex").slice(0, 16)}`,
      ),
    );
    expect(items(c)).toEqual([
      {
        key: strays[0]?.key,
        kind: "stray",
        path: "docs/c.md",
        sessionId: "shop-app-1",
        agentId: "GUIDO-1",
        repoId: "shop-app",
        text: "docs/c.md changed in s/shop-app-1 outside every agent's area",
        tool: null,
        at: NOW - 2 * MIN,
        url: null,
        escalationId: null,
        ticket: null,
        owner: "operator",
        acked: false,
      },
      expect.objectContaining({
        key: strays[1]?.key,
        kind: "stray",
        text: "web/b.ts changed in s/shop-app-1 inside GUIDO-2's area",
      }),
    ]);
    store.clearStrays("shop-app-1", ["docs/c.md"]);
    expect(items(c).map((i) => i.text)).toEqual([
      "web/b.ts changed in s/shop-app-1 inside GUIDO-2's area",
    ]);
  });

  it("re-recording a stray moves it to the latest seat and time, under the same key", () => {
    store.addStrays([{ sessionId: "s", path: "x", agentId: "GUIDO-1", kind: "outside", at: 1 }]);
    store.addStrays([{ sessionId: "s", path: "x", agentId: "GUIDO-2", kind: "outside", at: 2 }]);
    expect(store.strays()).toMatchObject([{ path: "x", agentId: "GUIDO-2", at: 2 }]);
  });

  it("lists a seat's open question until it is answered", () => {
    const c = withCrew();
    const id = store.addQuestion({
      agentId: "GUIDO-1",
      runId: "c1",
      text: "Lanes per customer?",
      at: NOW - MIN,
    });
    expect(items(c)).toEqual([
      expect.objectContaining({
        key: `ask:${id}`,
        kind: "question",
        agentId: "GUIDO-1",
        repoId: "shop-app",
        text: "GUIDO-1 asks: Lanes per customer?",
        at: NOW - MIN,
      }),
    ]);
    expect(items(c)[0]).not.toHaveProperty("path");
    expect(items(c)[0]).not.toHaveProperty("sessionId");
    store.answerQuestions("GUIDO-1", NOW);
    expect(items(c)).toEqual([]);
  });

  it("FLIGHT holds a question for 20 minutes", () => {
    const base = withCrew();
    const session = base.crew?.sessions[0];
    if (session === undefined) throw new Error("no session");
    const c: CcConfig = {
      ...base,
      crew: {
        ...base.crew,
        worktrees: join(dir, "crew-wt"),
        maxSeats: 4,
        sessions: [
          {
            ...session,
            seats: [
              ...session.seats,
              { id: "FLIGHT-1", role: "FLIGHT", accountId: "claude-main", model: "opus", area: [] },
            ],
          },
        ],
      },
    };
    const asked = (agentId: string, runId: string) =>
      store.addQuestion({ agentId, runId, text: "Lanes?", at: NOW - 5 * MIN });
    const keys = (at: number) =>
      attentionItems(c, store, at)
        .filter((i) => i.kind === "question" && i.owner === "operator")
        .map((i) => i.key);
    store.upsertRun(run({ id: "f1", agentId: "FLIGHT-1", repoId: "shop-app" }));
    const flightRow = (over: Partial<SeatSessionRow>) =>
      store.setSeatSession({
        seatId: "FLIGHT-1",
        runId: "f1",
        cliSessionId: null,
        state: "idle",
        reason: null,
        worktree: null,
        updatedAt: NOW,
        ...over,
      });
    flightRow({});
    store.replaceEscalations("shop-app", [escalation({ openedAt: NOW })]);
    store.raiseNote({
      key: "triage",
      kind: "flag",
      runId: null,
      seatId: null,
      repoId: null,
      text: "Update needs approval",
      at: NOW,
    });
    const newKeys = ["esc:shop-app#9", "note:triage"];
    for (const key of newKeys) {
      expect(attentionItems(c, store, NOW).find((i) => i.key === key)).toMatchObject({
        owner: "flight",
        flightTriage: "waiting",
      });
      expect(
        attentionItems(c, store, NOW + FLIGHT_TRIAGE_WAIT_MS).find((i) => i.key === key),
      ).toMatchObject({ owner: "operator", flightTriage: "missed" });
    }
    flightRow({ state: "parked" });
    expect(attentionItems(c, store, NOW).find((i) => i.key === "note:triage")?.owner).toBe(
      "operator",
    );
    flightRow({});
    const id = asked("GUIDO-1", "c1");
    const own = asked("FLIGHT-1", "f1");
    // younger than 20 minutes while FLIGHT is live: held back; its own is shown
    expect(keys(NOW)).toEqual([`ask:${own}`]);
    // 20 minutes old: shown
    expect(keys(NOW + 15 * MIN)).toEqual([`ask:${id}`, `ask:${own}`]);
    // passed: shown at once
    store.passQuestion(id, NOW);
    expect(keys(NOW)).toEqual([`ask:${id}`, `ask:${own}`]);
    // FLIGHT stopped: shown
    const held = asked("GUIDO-1", "c1");
    expect(keys(NOW)).not.toContain(`ask:${held}`);
    flightRow({ runId: null, state: "stopped" });
    expect(keys(NOW)).toContain(`ask:${held}`);
  });

  it("FLIGHT triages questions from every session", () => {
    const base = withCrew();
    const session = base.crew?.sessions[0];
    if (session === undefined) throw new Error("no session");
    const c: CcConfig = {
      ...base,
      crew: {
        ...base.crew,
        worktrees: join(dir, "crew-wt"),
        maxSeats: 4,
        sessions: [
          {
            ...session,
            seats: [
              ...session.seats,
              { id: "FLIGHT-1", role: "FLIGHT", accountId: "claude-main", model: "opus", area: [] },
            ],
          },
          {
            ...session,
            id: "other",
            seats: [
              { id: "GUIDO-9", role: "GUIDO", accountId: "claude-main", model: "opus", area: [] },
            ],
          },
        ],
      },
    };
    store.upsertRun(run({ id: "f1", agentId: "FLIGHT-1", repoId: "shop-app" }));
    store.setSeatSession({
      seatId: "FLIGHT-1",
      runId: "f1",
      cliSessionId: null,
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    const asked = (agentId: string) =>
      store.addQuestion({ agentId, runId: "c1", text: "Lanes?", at: NOW - 5 * MIN });
    const mine = asked("GUIDO-1");
    const other = asked("GUIDO-9");
    const keys = attentionItems(c, store, NOW)
      .filter((i) => i.kind === "question" && i.owner === "operator")
      .map((i) => i.key);
    expect(keys).toEqual([]);
    expect(keys).not.toContain(`ask:${other}`);
    expect(keys).not.toContain(`ask:${mine}`);
  });

  it("lists an unacked crew error as an error item", () => {
    const c = withCrew();
    const id = store.addCrewError({
      agentId: "GUIDO-1",
      runId: "c1",
      text: "the clone failed an object check",
      at: NOW - MIN,
    });
    expect(items(c)).toEqual([
      expect.objectContaining({
        key: `crew-error:${id}`,
        kind: "error",
        agentId: "GUIDO-1",
        repoId: "shop-app",
        text: "the clone failed an object check",
        at: NOW - MIN,
        acked: false,
      }),
    ]);
    store.ackCrewError(id);
    expect(items(c)).toEqual([]);
  });

  it("shows a seat waiting for the test lock as waiting, never stalled", () => {
    const c = withCrew();
    crewRun("c1", "GUIDO-1");
    crewRun("c2", "GUIDO-2");
    seat("GUIDO-1", "c1");
    seat("GUIDO-2", "c2");
    store.setDigest("c2", digest({ lastEventAt: NOW - 20 * MIN }));
    const lock: TestLockState = {
      holder: { runId: "c1", seatId: "GUIDO-1", command: "pnpm -s test", since: NOW - 5 * MIN },
      waiting: [{ runId: "c2", seatId: "GUIDO-2", command: "pnpm -s test", since: NOW - 20 * MIN }],
    };
    store.setDigest("c1", digest({ lastEventAt: NOW - MIN }));
    const row = crew(c, store, NOW, lock).rows.find((r) => r.id === "GUIDO-2");
    expect(row).toMatchObject({
      hudState: "waiting",
      note: "waiting for the test lock",
      stateSince: NOW - 20 * MIN,
    });
    expect(items(c, lock)).toEqual([]);
    // without the lock's word it is an ordinary stall
    expect(crew(c, store, NOW).rows.find((r) => r.id === "GUIDO-2")?.hudState).toBe("stalled");
  });

  it("raises the lock item when the holder has stalled and someone waits", () => {
    const c = withCrew();
    crewRun("c1", "GUIDO-1");
    crewRun("c2", "GUIDO-2");
    seat("GUIDO-1", "c1");
    seat("GUIDO-2", "c2");
    store.setDigest("c1", digest({ lastEventAt: NOW - 11 * MIN }));
    store.setDigest("c2", digest({ lastEventAt: NOW - MIN }));
    const lock: TestLockState = {
      holder: { runId: "c1", seatId: "GUIDO-1", command: "pnpm -s test", since: NOW - 15 * MIN },
      waiting: [{ runId: "c2", seatId: "GUIDO-2", command: "pnpm -s test", since: NOW - 4 * MIN }],
    };
    const lockItems = items(c, lock).filter((i) => i.kind === "lock");
    expect(lockItems).toEqual([
      {
        key: `lock:c1:${NOW - 15 * MIN}`,
        kind: "lock",
        agentId: "GUIDO-1",
        repoId: "shop-app",
        text: "GUIDO-2 waiting for the test lock, held by a stalled run (GUIDO-1)",
        tool: null,
        at: NOW - 11 * MIN,
        url: null,
        escalationId: null,
        ticket: null,
        owner: "operator",
        acked: false,
      },
    ]);
    // the lock sorts first
    expect(attentionItems(c, store, NOW, lock)[0]?.kind).toBe("lock");
    // a holder still printing, or nobody waiting: no lock item
    store.setDigest("c1", digest({ lastEventAt: NOW - MIN }));
    expect(items(c, lock).filter((i) => i.kind === "lock")).toEqual([]);
    store.setDigest("c1", digest({ lastEventAt: NOW - 11 * MIN }));
    expect(items(c, { ...lock, waiting: [] }).filter((i) => i.kind === "lock")).toEqual([]);
  });
});

describe("the engine's notes in Needs you", () => {
  const note = (key: string, kind: "blocked" | "review" | "flag" | "ratelimit", at = NOW - MIN) =>
    store.raiseNote({
      key,
      kind,
      runId: "r1",
      seatId: "guido-1",
      repoId: "shop-app",
      text: `text of ${key}`,
      at,
    });
  const noteItems = () =>
    attentionItems(config, store, NOW).filter((i) => i.key.startsWith("note:"));

  it("shows each kind with its note's text, and drops it when the note clears", () => {
    note("blocked:r1:0", "blocked", NOW - 4 * MIN);
    note("review:r1:abc", "review", NOW - 3 * MIN);
    note("flag:r1:hard-rules:00c296383f2b261b436d5a1d7951db07f82174af", "flag", NOW - 2 * MIN);
    note("ratelimit:r1", "ratelimit", NOW - MIN);
    expect(noteItems().map((i) => [i.key, i.kind, i.text, i.agentId, i.repoId])).toEqual([
      ["note:blocked:r1:0", "blocked", "text of blocked:r1:0", "guido-1", "shop-app"],
      ["note:review:r1:abc", "review", "text of review:r1:abc", "guido-1", "shop-app"],
      [
        "note:flag:r1:hard-rules:00c296383f2b261b436d5a1d7951db07f82174af",
        "flag",
        "text of flag:r1:hard-rules:00c296383f2b261b436d5a1d7951db07f82174af",
        "guido-1",
        "shop-app",
      ],
      ["note:ratelimit:r1", "ratelimit", "text of ratelimit:r1", "guido-1", "shop-app"],
    ]);
    expect(ATTENTION_LABEL.ratelimit).toBe("Rate-limited");
    store.clearNote("review:r1:abc", NOW);
    store.clearNote("ratelimit:r1", NOW);
    expect(noteItems().map((i) => i.kind)).toEqual(["blocked", "flag"]);
    store.clearNotesFor("r1", NOW);
    expect(noteItems()).toEqual([]);
  });

  it("links a run's note to its ticket and PR", () => {
    store.upsertRun({
      id: "r1",
      agentId: "guido-1",
      repoId: "shop-app",
      seq: 1,
      startedAt: NOW - HOUR,
      endedAt: null,
      status: "running",
      sessionId: null,
      model: null,
      branch: "feature/7-x",
      ticket: "shop-app#7",
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
      loop: { ...NEW_LOOP, prNumber: 12 },
    });
    store.upsertPullRequests(
      "shop-app",
      [
        {
          repoId: "shop-app",
          number: 12,
          title: "t",
          url: "https://github.com/o/shop-app/pull/12",
          branch: "feature/7-x",
          ticket: "shop-app#7",
          state: "open",
          isDraft: true,
          review: null,
          ci: "passing",
          createdAt: NOW - HOUR,
          updatedAt: NOW - MIN,
          mergedAt: null,
          headSha: null,
          mergeable: null,
        },
      ],
      NOW,
    );
    note("review:r1:abc", "review");
    expect(noteItems()[0]).toMatchObject({
      ticket: "shop-app#7",
      url: "https://github.com/o/shop-app/pull/12",
    });
  });

  const endedRun = (over: Partial<Run> = {}, loop: Partial<RunLoop> = {}) =>
    store.upsertRun({
      id: "r1",
      agentId: "guido-1",
      repoId: "shop-app",
      seq: 1,
      startedAt: NOW - HOUR,
      endedAt: NOW - MIN,
      status: "failed",
      sessionId: null,
      model: null,
      branch: "feature/7-x",
      ticket: "shop-app#7",
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
      loop: {
        ...NEW_LOOP,
        phase: "parked",
        prNumber: 12,
        parked: { kind: "ended", reason: "run ended (stopped)", ended: true },
        ...loop,
      },
      ...over,
    });
  const pr12 = (state: "open" | "merged" | "closed") =>
    store.upsertPullRequests(
      "shop-app",
      [
        {
          repoId: "shop-app",
          number: 12,
          title: "t",
          url: "https://github.com/o/shop-app/pull/12",
          branch: "feature/7-x",
          ticket: "shop-app#7",
          state,
          isDraft: false,
          review: null,
          ci: "passing",
          createdAt: NOW - HOUR,
          updatedAt: NOW - MIN,
          mergedAt: null,
          headSha: null,
          mergeable: null,
        },
      ],
      NOW,
    );
  const keys = () => noteItems().map((i) => i.key);
  const KEY = "note:blocked:r1:0";

  it("leaves out an ended park whose PR was merged or closed", () => {
    store.replaceBoard("shop-app", [boardItem({ issueNumber: 7 })]);
    endedRun();
    note("blocked:r1:0", "blocked");
    pr12("open");
    expect(keys()).toEqual([KEY]);
    pr12("merged");
    expect(keys()).toEqual([]);
    pr12("closed");
    expect(keys()).toEqual([]);
  });

  it("leaves out an ended park whose ticket is closed, gone from the board, or in a repo no longer configured", () => {
    endedRun({}, { prNumber: null });
    note("blocked:r1:0", "blocked");
    store.replaceBoard("shop-app", [boardItem({ issueNumber: 7, closed: true })]);
    expect(keys()).toEqual([]);
    store.replaceBoard("shop-app", [boardItem({ issueNumber: 8 })]);
    expect(keys()).toEqual([]);
    store.replaceBoard("shop-app", [boardItem({ issueNumber: 7 })]);
    expect(keys()).toEqual([KEY]);
    endedRun({ repoId: "old-repo", ticket: "old-repo#225" }, { prNumber: null });
    expect(keys()).toEqual([]);
  });

  it("finds an ended park's PR by its branch when the loop has no PR number", () => {
    store.replaceBoard("shop-app", [boardItem({ issueNumber: 7 })]);
    endedRun({}, { prNumber: null });
    note("blocked:r1:0", "blocked");
    pr12("open");
    expect(keys()).toEqual([KEY]);
    pr12("merged");
    expect(keys()).toEqual([]);
  });

  it("keeps an ended park while its repo's board is unread", () => {
    endedRun({}, { prNumber: null });
    note("blocked:r1:0", "blocked");
    expect(keys()).toEqual([KEY]);
  });

  it("keeps a park that is not ended, even with its PR merged", () => {
    endedRun(
      { endedAt: null, status: "running" },
      { parked: { kind: "refused", reason: "Push refused.", ended: false } },
    );
    note("blocked:r1:0", "blocked");
    pr12("merged");
    expect(keys()).toEqual([KEY]);
  });

  it("a dismissed note stays dismissed", () => {
    note("blocked:r1:0", "blocked");
    expect(keys()).toEqual([KEY]);
    expect(store.dismissNote("blocked:r1:0", NOW)).toBe(true);
    expect(keys()).toEqual([]);
    note("blocked:r1:0", "blocked");
    expect(keys()).toEqual([]);
  });

  it("a new park of the same run is listed again", () => {
    note("blocked:r1:0", "blocked");
    store.dismissNote("blocked:r1:0", NOW);
    store.clearNote("blocked:r1:0", NOW);
    store.raiseNote({
      key: "blocked:r1:0",
      kind: "blocked",
      runId: "r1",
      seatId: "guido-1",
      repoId: "shop-app",
      text: "shop-app#7 parked: Push refused.",
      at: NOW,
    });
    expect(noteItems().map((i) => [i.key, i.text])).toEqual([
      [KEY, "shop-app#7 parked: Push refused."],
    ]);
  });
});

describe("crew heartbeat", () => {
  it("fetches each whole-hub event query once for multiple rows and keeps their events separate", () => {
    config.loops.forEach((agent, i) => {
      const runId = `r${i}`;
      store.upsertRun(run({ id: runId, agentId: agent.id }));
      store.addRunCommit({
        runId,
        repoId: agent.repoId,
        branch: "work",
        sha: `sha${i}`,
        at: NOW - (i + 1) * MIN,
      });
      store.addLockHold({
        runId,
        seatId: agent.id,
        toolUseId: `tool${i}`,
        command: "test",
        since: NOW - (i + 2) * MIN,
      });
      store.addComms({
        from: agent.id,
        to: "CAPCOM",
        ticket: null,
        text: "Update",
        at: NOW - (i + 3) * MIN,
      });
    });
    const queries = ["runCommitsSince", "lockRuns", "commsEvidence"] as const;
    const spies = queries.map((query) => vi.spyOn(store, query));
    const rows = crew(config, store, NOW).rows;
    expect(rows).toHaveLength(config.loops.length);
    rows.forEach((row, i) => {
      expect(row.events).toEqual([
        { kind: "message", at: NOW - (i + 3) * MIN },
        { kind: "test", at: NOW - (i + 2) * MIN },
        { kind: "commit", at: NOW - (i + 1) * MIN },
      ]);
    });
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledExactlyOnceWith(NOW - 2 * HOUR);
    }
  });

  it("includes ticketless messages from the seat only within the ticketed run's window", () => {
    store.upsertRun(run({ ticket: "shop-app#42", endedAt: NOW - 5 * MIN, status: "ok" }));
    const message = { from: "shop-app-ta", to: "CAPCOM", ticket: null, text: "Update" };
    for (const at of [NOW - HOUR - 1, NOW - HOUR, NOW - 5 * MIN, NOW - 4 * MIN, NOW + MIN]) {
      store.addComms({ ...message, at });
    }
    store.addComms({ ...message, ticket: "shop-app#42", at: NOW - 10 * MIN });
    store.addComms({ ...message, ticket: "shop-app#99", at: NOW - 9 * MIN });
    store.addComms({ ...message, from: "studio-builder", at: NOW - 8 * MIN });
    expect(rowOf("shop-app-ta")?.events).toEqual([
      { kind: "message", at: NOW - HOUR },
      { kind: "message", at: NOW - 10 * MIN },
      { kind: "message", at: NOW - 5 * MIN },
    ]);
  });

  it("uses real run events, clips the window and does not mix runs", () => {
    store.upsertRun(run({}));
    store.upsertRun(run({ id: "other", agentId: "studio-builder" }));
    store.addRunCommit({
      runId: "r1",
      repoId: "shop-app",
      branch: "work",
      sha: "abc",
      at: NOW - MIN,
    });
    store.setRunPush({ runId: "r1", sha: "abc", at: NOW - 2 * MIN });
    store.addLoopEvent("test", "r1", "CI passed on abc", NOW - 3 * MIN);
    store.addLoopEvent("pr", "r1", "PR #9 opened", NOW - 4 * MIN);
    store.addLoopEvent("park", "r1", "Parked: needs input", NOW - 5 * MIN);
    store.addLoopEvent("old", "r1", "PR #8 opened", NOW - 121 * MIN);
    store.addLoopEvent("future", "r1", "PR #10 opened", NOW + MIN);
    store.addLoopEvent("other", "other", "PR #11 opened", NOW - MIN);
    const row = rowOf("shop-app-ta");
    expect(row?.events).toEqual([
      { kind: "park", at: NOW - 5 * MIN },
      { kind: "pr-opened", at: NOW - 4 * MIN },
      { kind: "test", at: NOW - 3 * MIN },
      { kind: "push", at: NOW - 2 * MIN },
      { kind: "commit", at: NOW - MIN },
    ]);
    expect(row?.stateSince).toBe(NOW - HOUR);
  });
});

it("heartbeat includes completed reviews and sent messages, without counting requests as reviews", () => {
  store.upsertRun(run({}));
  const request = {
    authorRunId: "r1",
    repoId: "shop-app",
    seatId: "retro",
    prNumber: 9,
    sha: "abc",
    epoch: 0,
    attempt: 1,
    round: 1,
    at: NOW - 10 * MIN,
  };
  const id = store.requestReview(request);
  if (id === null) throw new Error("no review");
  store.setReviewState(id, ["queued"], "reported", { at: NOW - 4 * MIN });
  store.requestReview({ ...request, attempt: 2 });
  store.addComms({
    from: "shop-app-ta",
    to: "CAPCOM",
    ticket: null,
    text: "Tests passed",
    at: NOW - 3 * MIN,
  });
  store.addComms({
    from: "CAPCOM",
    to: "shop-app-ta",
    ticket: null,
    text: "Please check",
    at: NOW - 2 * MIN,
  });
  expect(rowOf("shop-app-ta")?.events).toEqual([
    { kind: "review", at: NOW - 4 * MIN },
    { kind: "message", at: NOW - 3 * MIN },
  ]);
});

describe("messages are not Needs you", () => {
  let c: CcConfig;
  beforeEach(() => {
    const seat = (id: string, role: string) => ({
      id,
      role,
      accountId: "claude-main",
      model: "opus",
      area: [],
    });
    c = {
      ...config,
      loops: [],
      crew: {
        worktrees: join(dir, "crew-wt"),
        maxSeats: 4,
        sessions: [
          {
            id: "shop-app-1",
            repoId: "shop-app",
            checkout: join(dir, "crew-co"),
            seats: [seat("flight-1", "FLIGHT"), seat("guido-1", "GUIDO")],
          },
        ],
      },
    };
  });
  const say = (at: number, from: string, to: string, text: string) =>
    store.addComms({ at, from, to, ticket: null, text });
  const up = (seatId: string) => {
    store.upsertRun(run({ id: `r-${seatId}`, agentId: seatId }));
    store.setSeatSession({
      seatId,
      runId: `r-${seatId}`,
      cliSessionId: null,
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: NOW - HOUR,
    });
  };
  const chatter = (cfg: CcConfig = c, at = NOW) =>
    attentionItems(cfg, store, at, NO_LOCK, []).filter(
      (i) => i.kind === "tag" || i.kind === "message",
    );

  it("raises no item for a seat's narration on its direct line", () => {
    up("flight-1");
    say(NOW - 10 * MIN, COMMS_CAPCOM, "guido-1", "How is it going?");
    say(NOW - 9 * MIN, "guido-1", COMMS_CAPCOM, "Tests are running.");
    say(NOW - 8 * MIN, "guido-1", COMMS_CAPCOM, "Parser done, moving on to the CLI.");
    expect(chatter()).toEqual([]);
  });

  it("never counts FLIGHT's own summaries, on its direct line or tagged", () => {
    up("flight-1");
    say(NOW - 10 * MIN, COMMS_CAPCOM, "flight-1", "Anything for me?");
    say(NOW - 9 * MIN, "flight-1", COMMS_CAPCOM, "Nothing needs you. Shall I keep watching?");
    say(NOW - 8 * MIN, "flight-1", COMMS_CAPCOM, "@CAPCOM nothing needs you.");
    say(NOW - 7 * MIN, "flight-1", "crew", "@CAPCOM FYI: GUIDO-1 merged #42.");
    expect(chatter()).toEqual([]);
  });

  it("counts a question to @CAPCOM from FLIGHT as the operator's tag", () => {
    up("flight-1");
    say(NOW - 9 * MIN, "flight-1", COMMS_CAPCOM, "@CAPCOM nothing else needs you.");
    say(NOW - 8 * MIN, "flight-1", COMMS_CAPCOM, "@CAPCOM merge #551 now, or wait for #498?");
    expect(chatter()).toEqual([
      expect.objectContaining({
        kind: "tag",
        agentId: "flight-1",
        owner: "operator",
        text: "@CAPCOM merge #551 now, or wait for #498?",
      }),
    ]);
    expect(chatter()[0]?.flightTriage).toBeUndefined();
  });

  it("leaves a seat's @CAPCOM tag and direct-line question with FLIGHT, triaged or not", () => {
    up("flight-1");
    say(NOW - 10 * MIN, COMMS_CAPCOM, "guido-1", "How is it going?");
    say(NOW - 9 * MIN, "guido-1", COMMS_CAPCOM, "Please confirm the target branch.");
    say(NOW - 8 * MIN, "guido-1", "crew", "@CAPCOM the API key is missing");
    const items = chatter();
    expect(items.map((i) => [i.kind, i.owner, i.flightTriage])).toEqual([
      ["tag", "flight", "waiting"],
      ["message", "flight", "waiting"],
    ]);
    expect(items.find((i) => i.kind === "message")?.text).toBe("Please confirm the target branch.");
    // past the triage window: FLIGHT has missed it, but it is still not the operator's
    const late = NOW + FLIGHT_TRIAGE_WAIT_MS;
    expect(chatter(c, late).map((i) => [i.owner, i.flightTriage])).toEqual([
      ["flight", "missed"],
      ["flight", "missed"],
    ]);
    // FLIGHT down: nobody triages, it says so, and still nothing reaches Needs you
    store.upsertRun(run({ id: "r-flight-1", agentId: "flight-1", endedAt: NOW, status: "ok" }));
    expect(chatter().map((i) => [i.owner, i.flightTriage])).toEqual([
      ["flight", "down"],
      ["flight", "down"],
    ]);
  });

  it("raises a seat's @CAPCOM line to FLIGHT under the seat only, never as FLIGHT's own", () => {
    up("flight-1");
    say(NOW - 8 * MIN, "guido-1", "flight-1", "@CAPCOM should I drop the table?");
    expect(chatter().map((i) => [i.kind, i.agentId, i.owner])).toEqual([
      ["tag", "guido-1", "flight"],
    ]);
  });

  it.each([
    ["tag", "guido-1", "crew", "@CAPCOM the API key is missing", "@CAPCOM and the secret too"],
    [
      "message",
      "guido-1",
      COMMS_CAPCOM,
      "Which branch should I use?",
      "Also, which base for the PR?",
    ],
  ] as const)(
    "keeps FLIGHT's brief on a seat's %s for the operator while it writes again",
    (kind, from, to, first, next) => {
      up("flight-1");
      say(NOW - 10 * MIN, COMMS_CAPCOM, "guido-1", "How is it going?");
      say(NOW - 8 * MIN, from, to, first);
      const key = chatter()[0]?.key ?? "";
      expect(chatter()).toEqual([expect.objectContaining({ kind, owner: "flight" })]);
      store.addBrief({
        key,
        context: "GUIDO-1 needs the operator.",
        ask: "Decide for GUIDO-1?",
        recommendation: "Yes.",
        options: [],
        basis: "product direction",
        at: NOW - 7 * MIN,
        for: "operator",
      });
      // promoted by the brief, and still the same item after the seat writes again
      expect(chatter()).toEqual([expect.objectContaining({ key, kind, owner: "operator" })]);
      say(NOW - 5 * MIN, from, to, next);
      expect(chatter()).toEqual([
        expect.objectContaining({
          key,
          kind,
          owner: "operator",
          text: next,
          brief: expect.objectContaining({ ask: "Decide for GUIDO-1?" }),
        }),
      ]);
    },
  );

  it("hands a seat's tag to the operator once FLIGHT briefs it for them", () => {
    up("flight-1");
    say(NOW - 8 * MIN, "guido-1", "crew", "@CAPCOM the API key is missing");
    const key = chatter()[0]?.key ?? "";
    store.addBrief({
      key,
      context: "GUIDO-1 needs a production key.",
      ask: "Add the key to the vault?",
      recommendation: "Add it.",
      options: [],
      basis: "spending",
      at: NOW - MIN,
      for: "operator",
    });
    expect(chatter()).toEqual([expect.objectContaining({ key, owner: "operator" })]);
  });

  it("leaves another agent's chatter to its Comms thread when no FLIGHT seat is configured", () => {
    const noFlight: CcConfig = {
      ...c,
      crew: c.crew && {
        ...c.crew,
        sessions: c.crew.sessions.map((s) => ({
          ...s,
          seats: s.seats.filter((x) => x.id !== "flight-1"),
        })),
      },
    };
    say(NOW - 10 * MIN, COMMS_CAPCOM, "guido-1", "How is it going?");
    say(NOW - 9 * MIN, "guido-1", COMMS_CAPCOM, "Which branch should I use?");
    say(NOW - 8 * MIN, "guido-1", "crew", "@CAPCOM the API key is missing");
    expect(chatter(noFlight)).toEqual([]);
  });

  it("raises a seat question once, not again for the Comms line ask_operator mirrors it to", () => {
    up("flight-1");
    up("guido-1");
    say(NOW - 10 * MIN, COMMS_CAPCOM, "guido-1", "Carry on with #42.");
    // ask_operator records the question and writes the same text to CAPCOM at the same instant
    const text = "@CAPCOM which lane should #42 go in? Please confirm.";
    const id = store.addQuestion({ agentId: "guido-1", runId: "r-guido-1", text, at: NOW - MIN });
    say(NOW - MIN, "guido-1", COMMS_CAPCOM, text);
    const mine = () =>
      attentionItems(c, store, NOW, NO_LOCK, []).filter((i) => i.agentId === "guido-1");
    expect(mine().map((i) => [i.kind, i.key])).toEqual([["question", `ask:${id}`]]);
    // answered, its mirrored line is still no item
    store.answerQuestions("guido-1", NOW);
    expect(mine()).toEqual([]);
  });
});
