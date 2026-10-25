import type { AttentionItem, BoardItem, PullRequestView, Run, RunDigest } from "@mc/core";
import { CI_FAILED_EVENT_PREFIX, CI_PASSED_EVENT_PREFIX, NEW_LOOP, OWNER_OPERATOR } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type OverviewScope, overviewSummary } from "../src/overview.ts";
import { Store } from "../src/store.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-17T12:00:30Z");
const END = Math.floor(NOW / MIN) * MIN;
let store: Store;
const scope: OverviewScope = {
  repoIds: ["repo"],
  seatIds: ["seat"],
  timezone: "Europe/London",
  attention: [],
};
const summary = () => overviewSummary(store, NOW, scope);
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => {
  store.close();
});

const card = (ticket: number, status = "Ready", extra: Partial<BoardItem> = {}): BoardItem => ({
  repoId: "repo",
  issueNumber: ticket,
  title: `Ticket ${ticket}`,
  status,
  state: "planned",
  labels: [],
  priority: null,
  updatedAt: NOW - ticket * MIN,
  url: "",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: null,
  closed: false,
  prioritySource: null,
  createdAt: NOW - HOUR,
  itemId: null,
  projectId: null,
  ...extra,
});
const run = (ticket: number, extra: Partial<Run> = {}): Run => ({
  id: `run-${ticket}`,
  agentId: "seat",
  repoId: "repo",
  seq: ticket,
  startedAt: NOW - HOUR,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: null,
  ticket: `repo#${ticket}`,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  loop: { ...NEW_LOOP },
  ...extra,
});
const pr = (ticket: number, extra: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "repo",
  number: ticket + 100,
  title: `PR ${ticket}`,
  url: "",
  branch: "b",
  ticket: `repo#${ticket}`,
  state: "open",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW - HOUR,
  updatedAt: NOW - MIN,
  mergedAt: null,
  headSha: null,
  mergeable: null,
  ...extra,
});
const digest = (minuteTokens: RunDigest["minuteTokens"]): RunDigest => ({
  toolCalls: 0,
  turns: 0,
  lastEventAt: NOW,
  model: null,
  contextTokens: null,
  contextWindow: null,
  liveTool: null,
  tools: {},
  subagents: [],
  minuteTokens,
  turnUsage: [],
  background: [],
  compactions: 0,
});

it("returns zeros and nulls from an empty store", () => {
  const result = overviewSummary(store, NOW, { ...scope, seatIds: [] });
  expect(result.at).toBe(NOW);
  expect(result.kpis).toEqual({
    working: { now: 0, of: 0, series: Array(30).fill(0) },
    tokensPerMin: { now: 0, series: Array(30).fill(0) },
    spendToday: { usd: 0, perHour: Array(14).fill(0), series: Array(30).fill(0) },
    inFlight: { count: 0, oldestAt: null, series: Array(30).fill(0) },
    mergedToday: { count: 0, perHour: Array(14).fill(0), series: Array(30).fill(0) },
    ciPassRate24h: { pct: null, runs: 0, redNow: 0, series: Array(30).fill(null) },
    cycleTime: { medianMs: null, n: 0, avg14dMs: null, series: Array(30).fill(null) },
    needsYou: { count: 0, overHour: 0, series: Array(30).fill(0) },
  });
  expect(result.pipeline).toHaveLength(6);
  expect(
    result.pipeline.every((s) => s.count === 0 && s.oldestAt === null && s.cards.length === 0),
  ).toBe(true);
  expect(result.machine).toEqual({
    cpu: Array(30).fill(null),
    mem: Array(30).fill(null),
    diskFreeGb: null,
    disk: Array(30).fill(null),
  });
});

it("assigns one card per stage, including set-aside review and merging precedence", () => {
  store.replaceBoard("repo", [
    card(1),
    card(2),
    card(3),
    card(4),
    card(5),
    card(6, "Done", { closed: true }),
  ]);
  store.upsertRun(run(2));
  store.upsertRun(run(3, { loop: { ...NEW_LOOP, phase: "ci", prNumber: 103 } }));
  store.upsertRun(
    run(4, { loop: { ...NEW_LOOP, phase: "review", aside: { worktree: "", wake: false } } }),
  );
  store.upsertRun(
    run(5, { loop: { ...NEW_LOOP, phase: "review", merging: { sha: "sha", done: [] } } }),
  );
  store.replacePullRequests(
    "repo",
    [pr(3, { ci: "failing" }), pr(6, { state: "merged", mergedAt: NOW - MIN })],
    NOW,
  );
  const result = summary();
  expect(result.pipeline.map((s) => [s.stage, s.count, s.cards[0]?.ticket])).toEqual([
    ["ready", 1, 1],
    ["building", 1, 2],
    ["checks", 1, 3],
    ["review", 1, 4],
    ["merging", 1, 5],
    ["merged", 1, 6],
  ]);
  expect(result.pipeline[2]?.cards[0]).toMatchObject({ who: "seat", pr: 103, ci: ["fail"] });
  expect(result.kpis.inFlight).toEqual({
    count: 4,
    oldestAt: NOW - HOUR,
    series: Array(30).fill(4),
  });
  expect(result.kpis.mergedToday.count).toBe(1);
  expect(result.kpis.ciPassRate24h.redNow).toBe(1);
});

it("caps cards at six without capping totals; merged cards are newest first", () => {
  store.replaceBoard(
    "repo",
    Array.from({ length: 8 }, (_, i) => card(i + 1)),
  );
  store.replacePullRequests(
    "repo",
    Array.from({ length: 8 }, (_, i) =>
      pr(i + 10, { state: "merged", mergedAt: NOW - (i + 1) * MIN }),
    ),
    NOW,
  );
  const result = summary();
  expect(result.pipeline[0]).toMatchObject({ count: 8, oldestAt: NOW - 8 * MIN });
  expect(result.pipeline[0]?.cards.map((c) => c.ticket)).toEqual([8, 7, 6, 5, 4, 3]);
  expect(result.pipeline[5]?.cards.map((c) => c.ticket)).toEqual([10, 11, 12, 13, 14, 15]);
  expect(result.pipeline[5]?.oldestAt).toBe(NOW - 8 * MIN);
});

it("counts distinct seats per minute from carried turn state, excluding the incomplete minute", () => {
  const state = (at: number, to: "running" | "idle") =>
    store.addAgentEvent({ agentId: "seat", at, from: "idle", to, text: "turn" });
  state(END - 40 * MIN, "running");
  state(END - 29 * MIN, "idle");
  state(END - 2 * MIN, "running");
  state(END - 2 * MIN + 10, "idle");
  state(END - 2 * MIN + 20, "running");
  expect(summary().kpis.working).toEqual({
    now: 1,
    of: 1,
    series: [1, ...Array(27).fill(0), 1, 1],
  });
});

it("sums fleet token buckets and falls back to wall-time spend without attempt usage", () => {
  const midnight = Date.parse("2026-10-16T23:00:00Z");
  store.upsertRun(run(1, { startedAt: midnight - HOUR, endedAt: midnight + HOUR, costUsd: 4 }));
  store.upsertRun(run(2));
  store.upsertRun(run(3, { repoId: "other", costUsd: 100 }));
  store.setDigest(
    "run-2",
    digest([
      [END - 31 * MIN, 999],
      [END - 30 * MIN, 10],
      [END - MIN, 20],
      [END, 30],
    ]),
  );
  store.upsertRun(run(4));
  store.setDigest(
    "run-4",
    digest([
      [END - MIN, 7],
      [END, 5],
    ]),
  );
  expect(summary().kpis.tokensPerMin).toEqual({ now: 27, series: [10, ...Array(28).fill(0), 27] });
  expect(summary().kpis.spendToday).toEqual({
    usd: 2,
    perHour: [2, ...Array(13).fill(0)],
    series: Array(30).fill(0),
  });
});

it("counts CI outcomes in 24 hours, local-day merges and valid cycle times", () => {
  store.upsertRun(run(1));
  store.addLoopEvent("pass", "run-1", `${CI_PASSED_EVENT_PREFIX}abc`, NOW - MIN);
  store.addLoopEvent("fail", "run-1", `${CI_FAILED_EVENT_PREFIX}def`, NOW - HOUR);
  store.addLoopEvent("old", "run-1", `${CI_FAILED_EVENT_PREFIX}ghi`, NOW - 25 * HOUR);
  store.addLoopEvent("future", "run-1", `${CI_FAILED_EVENT_PREFIX}jkl`, NOW + MIN);
  const midnight = Date.parse("2026-10-16T23:00:00Z");
  store.replacePullRequests(
    "repo",
    [
      pr(1, { mergedAt: midnight, state: "merged" }),
      pr(2, { mergedAt: midnight - 1, state: "merged" }),
      pr(3, { mergedAt: NOW + 1, state: "merged" }),
    ],
    NOW,
  );
  store.replaceFlow(
    "repo",
    [
      { repoId: "repo", number: 1, size: null, startAt: NOW - 3 * HOUR, doneAt: NOW - HOUR },
      { repoId: "repo", number: 2, size: null, startAt: NOW - 5 * HOUR, doneAt: NOW - HOUR },
      { repoId: "repo", number: 3, size: null, startAt: NOW - 48 * HOUR, doneAt: NOW - 42 * HOUR },
      { repoId: "repo", number: 4, size: null, startAt: null, doneAt: NOW },
      { repoId: "repo", number: 5, size: null, startAt: NOW + 1, doneAt: NOW },
    ],
    [],
  );
  expect(summary().kpis.ciPassRate24h).toEqual({
    pct: 50,
    runs: 2,
    redNow: 0,
    series: [...Array(29).fill(0), 50],
  });
  expect(summary().kpis.mergedToday).toEqual({
    count: 1,
    perHour: [1, ...Array(13).fill(0)],
    series: Array(30).fill(0),
  });
  expect(summary().kpis.cycleTime).toEqual({
    medianMs: 3 * HOUR,
    n: 2,
    avg14dMs: 4 * HOUR,
    series: Array(30).fill(3 * HOUR),
  });
});

it("averages machine readings into complete minutes and takes the latest disk reading", () => {
  for (const [at, cpuPct] of [
    [END - MIN, 20],
    [END - MIN + 100, 40],
    [END, 99],
  ] as const) {
    store.addMachineSample({
      at,
      cpuPct,
      cores: 8,
      memUsedBytes: 50,
      memTotalBytes: 100,
      diskFreeBytes: 10 * 1024 ** 3,
      diskTotalBytes: 20 * 1024 ** 3,
      agents: null,
    });
  }
  expect(summary().machine).toEqual({
    cpu: [...Array(29).fill(null), 30],
    mem: [...Array(29).fill(null), 50],
    diskFreeGb: 10,
    disk: [...Array(29).fill(null), 10],
  });
});

it("counts open operator attention, including acknowledgements, and scopes by repo", () => {
  const attention: AttentionItem[] = [HOUR + 1, HOUR, MIN].map((age, i) => ({
    key: `item-${i}`,
    kind: "question" as const,
    agentId: "seat",
    repoId: "repo",
    text: "?",
    at: NOW - age,
    tool: null,
    url: null,
    escalationId: null,
    ticket: null,
    acked: true,
    owner: OWNER_OPERATOR,
  }));
  const first = attention[0] as AttentionItem;
  const result = overviewSummary(store, NOW, {
    ...scope,
    attention: [...attention, { ...first, repoId: "other" }, { ...first, owner: "flight" }],
  });
  expect(result.kpis.needsYou).toEqual({
    count: 3,
    overHour: 1,
    series: [...Array(29).fill(2), 3],
  });
});

it("uses the review column without a live run and excludes closed or out-of-scope cards", () => {
  store.replaceBoard("repo", [card(1, "In review"), card(2, "Ready", { closed: true })]);
  store.replaceBoard("other", [card(3, "Ready", { repoId: "other" })]);
  expect(summary().pipeline.map((s) => s.count)).toEqual([0, 0, 0, 1, 0, 0]);
});

it("includes a live ticket before the board poll has collected its card", () => {
  store.upsertRun(run(1, { ticketTitle: "New ticket" }));
  expect(summary().pipeline[1]?.cards[0]).toMatchObject({
    ticket: 1,
    title: "New ticket",
    who: "seat",
  });
});

it("keeps a merge at local midnight in the first hourly bucket", () => {
  const midnight = Date.parse("2026-10-16T23:00:00Z");
  store.replacePullRequests("repo", [pr(1, { state: "merged", mergedAt: midnight })], midnight);
  expect(overviewSummary(store, midnight, scope).kpis.mergedToday).toEqual({
    count: 1,
    perHour: [1],
    series: Array(30).fill(0),
  });
});

it("weights spend by attempt tokens and excludes undated, past-day and future attempts", () => {
  const midnight = Date.parse("2026-10-16T23:00:00Z");
  store.upsertRun(run(1, { startedAt: midnight - HOUR, costUsd: 10 }));
  store.setDigest("run-1", {
    ...digest([]),
    attemptUsage: [
      { id: "old", at: midnight - 1, tokens: 10 },
      { id: "first", at: midnight, tokens: 20 },
      { id: "second", at: midnight + HOUR, tokens: 40 },
      { id: "unknown", at: null, tokens: 10 },
      { id: "future", at: NOW + 1, tokens: 20 },
    ],
  });
  expect(summary().kpis.spendToday).toEqual({
    usd: 6,
    perHour: [2, 4, ...Array(12).fill(0)],
    series: Array(30).fill(0),
  });
  store.setDigest("run-1", { ...digest([]), attemptUsage: [{ id: "zero", at: NOW, tokens: 0 }] });
  const fallback = summary().kpis.spendToday;
  store.setDigest("run-1", digest([]));
  expect(summary().kpis.spendToday).toEqual(fallback);
});

it("uses the latest successful Ready move and keeps the queue out of in-flight", () => {
  store.replaceBoard("repo", [card(1), card(2)]);
  for (const [at, state] of [
    [NOW - 4 * HOUR, "done"],
    [NOW - 2 * HOUR, "done"],
    [NOW, "failed"],
  ] as const)
    store.addBoardMove({
      runId: "run-1",
      repoId: "repo",
      issue: 1,
      column: "Ready",
      state,
      detail: null,
      at,
    });
  expect(summary().pipeline[0]?.cards.map((c) => c.since)).toEqual([NOW - 2 * HOUR, NOW - 2 * MIN]);
  expect(summary().kpis.inFlight).toEqual({ count: 0, oldestAt: null, series: Array(30).fill(0) });
});

it("limits pipeline to crew repos while retaining other repo metrics", () => {
  store.replaceBoard("repo", [card(1)]);
  store.upsertRun(run(1));
  expect(overviewSummary(store, NOW, { ...scope, pipelineRepoIds: [] }).kpis.inFlight.count).toBe(
    0,
  );
  expect(
    overviewSummary(store, NOW, { ...scope, pipelineRepoIds: [] }).pipeline.every(
      (p) => p.count === 0,
    ),
  ).toBe(true);
});

it("retains parked runs in building or review according to their card", () => {
  store.replaceBoard("repo", [card(1), card(2, "In review")]);
  for (const n of [1, 2]) store.upsertRun(run(n, { loop: { ...NEW_LOOP, phase: "parked" } }));
  expect(summary().pipeline.map((p) => p.count)).toEqual([0, 1, 0, 1, 0, 0]);
  expect(summary().kpis.inFlight.count).toBe(2);
});

it("counts flakes and parked CI failures but excludes unsuccessful rerun requests", () => {
  store.upsertRun(run(1));
  for (const [i, text] of [
    "CI flaked on abc: passed on re-run",
    "parked: CI failed 3 times",
    "CI failed again on the re-run of abc",
    "CI failed on abc; no run could be re-run",
  ].entries())
    store.addLoopEvent(`ci-${i}`, "run-1", text, NOW);
  expect(summary().kpis.ciPassRate24h).toMatchObject({ pct: 0, runs: 3 });
});

it("reads only open or recently merged PRs", () => {
  store.replacePullRequests(
    "repo",
    [
      pr(1),
      pr(2, { state: "closed" }),
      pr(3, { state: "merged", mergedAt: NOW - 48 * HOUR }),
      pr(4, { state: "merged", mergedAt: NOW }),
    ],
    NOW,
  );
  expect(store.overviewPullRequests("repo", NOW - HOUR).map((p) => p.number)).toEqual([104, 101]);
});

it("includes an attempt at now in the current hour", () => {
  store.upsertRun(run(1, { startedAt: NOW, costUsd: 2 }));
  store.setDigest("run-1", {
    ...digest([]),
    attemptUsage: [{ id: "now", at: NOW, tokens: 10 }],
  });
  expect(summary().kpis.spendToday).toEqual({
    usd: 2,
    perHour: [...Array(13).fill(0), 2],
    series: Array(30).fill(0),
  });
});

it("serves complete-minute KPI history with scoped run intervals and rolling outcomes", () => {
  store.upsertRun(run(1, { startedAt: END - 2 * MIN, endedAt: END - MIN, status: "ok" }));
  store.upsertRun(run(2, { repoId: "other", startedAt: END - 30 * MIN }));
  store.addLoopEvent("pass", "run-1", `${CI_PASSED_EVENT_PREFIX}abc`, END - 2 * MIN);
  store.addLoopEvent("fail", "run-1", `${CI_FAILED_EVENT_PREFIX}abc`, END - MIN);
  store.replaceFlow(
    "repo",
    [{ repoId: "repo", number: 1, size: null, startAt: END - 3 * MIN, doneAt: END - MIN }],
    [],
  );
  const kpis = summary().kpis;
  expect(kpis.inFlight.series).toEqual([...Array(28).fill(0), 1, 0]);
  expect(kpis.ciPassRate24h.series).toEqual([...Array(28).fill(null), 100, 50]);
  expect(kpis.cycleTime.series).toEqual([...Array(29).fill(null), 2 * MIN]);
  expect(kpis.needsYou.series).toEqual(Array(30).fill(0));
});

it("serves minute spend and merge buckets without changing today's hourly totals", () => {
  store.upsertRun(run(1, { startedAt: END - 2 * MIN, endedAt: END, status: "ok", costUsd: 4 }));
  store.replacePullRequests(
    "repo",
    [pr(1, { state: "merged", mergedAt: END - MIN }), pr(2, { state: "merged", mergedAt: END })],
    NOW,
  );
  expect(summary().kpis.spendToday.series).toEqual([...Array(28).fill(0), 2, 2]);
  expect(summary().kpis.spendToday.usd).toBe(4);
  expect(summary().kpis.mergedToday.series).toEqual([...Array(29).fill(0), 1]);
  expect(summary().kpis.mergedToday.count).toBe(2);
});

it("traces currently open operator needs back to their appearance", () => {
  const item: AttentionItem = {
    key: "question",
    kind: "question",
    agentId: "seat",
    repoId: "repo",
    text: "?",
    at: END - MIN,
    tool: null,
    url: null,
    escalationId: null,
    ticket: null,
    acked: true,
  };
  const result = overviewSummary(store, NOW, {
    ...scope,
    attention: [item, { ...item, key: "other", repoId: "other" }],
  });
  expect(result.kpis.needsYou.series).toEqual([...Array(29).fill(0), 1]);
});

it("averages known disk samples, preserving missing minutes and excluding the current minute", () => {
  for (const [at, diskFreeBytes] of [
    [END - MIN, 8 * 1024 ** 3],
    [END - MIN + 1, 12 * 1024 ** 3],
    [END, 50 * 1024 ** 3],
  ] as const) {
    store.addMachineSample({
      at,
      cpuPct: null,
      cores: 8,
      memUsedBytes: null,
      memTotalBytes: 100,
      diskFreeBytes,
      diskTotalBytes: null,
      agents: null,
    });
  }
  expect(summary().machine.disk).toEqual([...Array(29).fill(null), 10]);
  expect(summary().machine.diskFreeGb).toBe(50);
});
