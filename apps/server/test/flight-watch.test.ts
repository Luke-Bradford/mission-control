import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_STALL_MS,
  type BoardItem,
  COMMS_CAPCOM,
  CREW_PAUSE_SETTING,
  carriedFrom,
  FLIGHT_CONTEXT_ROTATE_TOKENS,
  FLIGHT_DEBOUNCE_MS,
  FLIGHT_DOWN_NOTE_KEY,
  FLIGHT_DOWN_STALL_MS,
  FLIGHT_GHOST_MS,
  FLIGHT_HANDOVER_ASK,
  FLIGHT_HANDOVER_TOPIC,
  FLIGHT_HEADLINE,
  FLIGHT_HOUR_MS,
  FLIGHT_IDLE_MS,
  FLIGHT_LEFT_HEAD,
  FLIGHT_LEFT_NOTE_KEY,
  FLIGHT_LOOPS_SETTING,
  FLIGHT_MAIN_SETTING,
  FLIGHT_MAX_WAKES,
  FLIGHT_MERGE_STALL_MS,
  FLIGHT_MIN_WAKE_GAP_MS,
  FLIGHT_NOTE_KEY,
  FLIGHT_NOTE_SECTIONS,
  FLIGHT_RETROSPECTIVE_SETTING,
  FLIGHT_REWAKE_MS,
  FLIGHT_RUN_TOOLS_SETTING,
  FLIGHT_SIGNAL_KEEP_MS,
  FLIGHT_SIGNALS_SETTING,
  FLIGHT_STARTS_PER_HOUR,
  FLIGHT_TICK_MS,
  FLIGHT_UNPARK_KINDS,
  FLIGHT_WAKE_HEAD,
  type FlightLedgerEntry,
  type FlightSeatState,
  type FlightState,
  type FlightWake,
  FOR_THE_CONTROLLER,
  flightDownText,
  flightStartFailedText,
  GITHUB_RATE_SETTING,
  handoverKey,
  NEW_LOOP,
  type PullRequestView,
  RULING_PARK,
  type Run,
  type SeatSessionRow,
  wakeSummary,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import { flightQuestion } from "../src/comms.ts";
import type { CcConfig, CrewSeatConfig } from "../src/config.ts";
import { tickLogOf } from "../src/engine/ticks.ts";
import * as retrospective from "../src/flight/retrospective.ts";
import {
  flightLoopHeartbeat,
  markFlightSignalsShown,
  observeFlightChecks,
  observeFlightMain,
  recordFlightWait,
  recordSeatCall,
} from "../src/flight/signals.ts";
import {
  deliveredFacts,
  flightOwnSeatIds,
  flightSeat,
  flightStartCap,
  flightState,
  flightView,
  markPrsShown,
  ownReply,
  pending,
  wakeFacts,
} from "../src/flight/state.ts";
import { createFlightWatch, type FlightWatch, flightToolsDigest } from "../src/flight/watch.ts";
import { attentionItems } from "../src/hud.ts";
import { recordNoReport } from "../src/runtime/no-report.ts";
import type { SeatFacts, SendResult, SupervisorEvent } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";
import { foldTranscript } from "../src/streamjson.ts";

const T0 = Date.parse("2026-10-22T12:00:00Z");
const MIN = 60_000;
const seat = (id: string, role: string, extra: Partial<CrewSeatConfig> = {}): CrewSeatConfig => ({
  id,
  role,
  accountId: "claude-main",
  model: "opus",
  area: [],
  ...extra,
});
const config: CcConfig = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/none",
    maxSeats: 8,
    sessions: [
      {
        id: "s1",
        repoId: "mc",
        checkout: "/tmp/none/clone",
        seats: [
          seat("flight-1", "FLIGHT"),
          seat("guido-1", "GUIDO", { area: ["apps/**"] }),
          seat("inco-1", "INCO", { area: ["apps/web/**"] }),
          seat("retro-1", "RETRO", { mode: "scratch" }),
        ],
      },
    ],
  },
};

let dir: string;
let store: Store;
let bus: ChangeBus;
let nowMs: number;
let watch: FlightWatch;
let emitted: string[];
let startCalls: { seatId: string; first: string | undefined }[];
let sendCalls: {
  runId: string;
  key: string;
  text: string;
  cost?: { wake: number; pieces: readonly { section: string; bytes: number }[] };
}[];
let endCalls: string[];
let statusCalls: number;
let startFails: string | null;
let sendFails = false;
let facts: SeatFacts | null;
/** What the supervisor's `sessionAlive` answers for FLIGHT. */
let alive: boolean | null;
let resumeCalls: string[];
/** What a take-back does, when a test says. */
let onResume: ((runId: string) => void | Promise<void>) | null;
let enabled: boolean;
let started = 0;
let listener: ((e: SupervisorEvent) => void) | null = null;

const run = (id: string, agentId: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId,
  repoId: "mc",
  seq: 1,
  startedAt: T0,
  endedAt: null,
  status: "running",
  sessionId: "cli",
  model: "opus",
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
  ...over,
});
const row = (seatId: string, runId: string | null, state: SeatSessionRow["state"] = "idle") => ({
  seatId,
  runId,
  cliSessionId: "cli",
  state,
  reason: null,
  worktree: null,
  updatedAt: T0,
});
const live = (seatId: string, runId: string) => {
  store.upsertRun(run(runId, seatId));
  store.setSeatSession(row(seatId, runId));
};
/** FLIGHT is running between turns, and the two developer seats each hold a run. */
const liveCrew = () => {
  live("flight-1", "r-flight");
  live("guido-1", "r-guido");
  live("inco-1", "r-inco");
  facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
};
/** Only FLIGHT is running between turns: no developer seat holds a run, so the crew is idle. */
const flightOnly = () => {
  live("flight-1", "r-flight");
  facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
};
/** The developer seats' runs end: only FLIGHT may be live, so the pace is the idle one. */
const idleCrew = () => {
  for (const [seatId, runId] of [
    ["guido-1", "r-guido"],
    ["inco-1", "r-inco"],
  ] as const) {
    store.upsertRun(run(runId, seatId, { endedAt: nowMs, status: "ok" }));
    store.setSeatSession(row(seatId, null));
  }
};
const ask = (agentId = "guido-1", runId = "r-guido", at = nowMs) =>
  store.addQuestion({ agentId, runId, text: "Which lane?", at });
const notesOpen = () => store.notes().filter((n) => n.key === FLIGHT_NOTE_KEY);
const noFlight = () => {
  const runId = store.seatSession("flight-1")?.runId ?? "r-flight";
  store.upsertRun(run(runId, "flight-1", { endedAt: nowMs, status: "ok" }));
  store.setSeatSession(row("flight-1", null));
};

const makeWatch = () => {
  watch = createFlightWatch({
    config,
    store,
    bus,
    enabled: true,
    now: () => nowMs,
    supervisor: {
      status: () => {
        statusCalls++;
        return { enabled, note: null };
      },
      on: (fn) => {
        listener = fn;
        return () => {};
      },
      busy: () => [],
      seatFacts: () => facts,
      startWatch: async (seatId, opts) => {
        startCalls.push({ seatId, first: opts?.first });
        if (startFails !== null) throw new Error(startFails);
        const runId = `r-flight-${++started}`;
        store.upsertRun(run(runId, seatId));
        store.setSeatSession(row(seatId, runId));
        facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
        if (alive === false) alive = true;
        return { runId };
      },
      send: async (runId, key, text, cost): Promise<SendResult> => {
        sendCalls.push({ runId, key, text, cost });
        if (sendFails) return "busy";
        const ok = store.claimLine(key, {
          runId,
          seatId: "flight-1",
          origin: "engine",
          text,
          at: nowMs,
        });
        return ok ? "sent" : "dup";
      },
      endRunByEngine: async (runId) => {
        endCalls.push(runId);
        store.upsertRun(run(runId, "flight-1", { endedAt: nowMs, status: "ok" }));
        store.setSeatSession(row("flight-1", null));
      },
      sessionAlive: () => alive,
      resumeRun: async (runId) => {
        resumeCalls.push(runId);
        await onResume?.(runId);
      },
    },
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "mc-flight-watch-"));
  store = new Store(join(dir, "mc.sqlite"));
  // T0 is after 03:00 on Oct 22: these watcher tests start after today's report was delivered.
  // The daily-retrospective tests below advance to later days to exercise preparation itself.
  store.setSetting(
    `${FLIGHT_RETROSPECTIVE_SETTING}:mc`,
    JSON.stringify({ day: "2026-10-22", told: true }),
  );
  bus = new ChangeBus();
  emitted = [];
  bus.subscribe((t) => emitted.push(t));
  nowMs = T0;
  startCalls = [];
  sendCalls = [];
  endCalls = [];
  statusCalls = 0;
  startFails = null;
  sendFails = false;
  facts = null;
  alive = null;
  resumeCalls = [];
  onResume = null;
  enabled = true;
  started = 0;
  listener = null;
  vi.setSystemTime(T0);
  makeWatch();
});
afterEach(() => {
  watch.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

it("keeps an older unanswered discussion visible and waking after 101 newer answered threads", () => {
  const current = () => flightState({ config, store, busy: [], now: nowMs });
  expect(pending(current())).toBe(false);
  const waiting = store.ensureDiscussion("note:waiting", "v1");
  store.askDiscussion(waiting.id, "waiting-question", "Why?", T0);
  for (let n = 0; n < 101; n++) {
    const answered = store.ensureDiscussion(`note:answered-${n}`, "v1");
    store.askDiscussion(answered.id, `ask-${n}`, "Why?", T0 + n + 1);
    expect(
      store.replyDiscussion(answered.id, `ask-${n}`, `reply-${n}`, "Because", T0 + n + 2),
    ).toBe(true);
  }
  expect(store.pendingDiscussions().map((t) => t.id)).toEqual([waiting.id]);
  expect(current().discussions.map((t) => t.id)).toEqual([waiting.id]);
  expect(pending(current())).toBe(true);
  expect(store.replyDiscussion(waiting.id, "waiting-question", "answer", "Because", T0 + 200)).toBe(
    true,
  );
  expect(pending(current())).toBe(false);
});

it("bounds pending discussions by the oldest unanswered question, not thread creation", () => {
  const threads = [];
  for (let n = 0; n < 102; n++) {
    const thread = store.ensureDiscussion(`note:pending-${n}`, "v1");
    // Keep the oldest wait first; the remaining questions reverse thread creation order.
    store.askDiscussion(thread.id, `ask-${n}`, "Why?", T0 + (n === 0 ? 0 : 102 - n));
    threads.push(thread.id);
  }
  expect(store.pendingDiscussions().map((t) => t.id)).toEqual(
    [threads[0], ...threads.slice(1).reverse()].slice(0, 100),
  );
});

const stored = (number: number, over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "mc",
  number,
  title: `PR ${number}`,
  url: "u",
  branch: `feature/${number}-x`,
  ticket: `mc#${number}`,
  state: "open",
  isDraft: true,
  review: null,
  ci: null,
  createdAt: T0,
  updatedAt: T0,
  mergedAt: null,
  headSha: `sha${number}`,
  mergeable: null,
  author: null,
  assignees: [],
  ...over,
});
const listed = () => flightState({ config, store, busy: [], now: nowMs }).prs;

describe("FLIGHT's PR list", () => {
  it("keeps a PR listed, marked stale with its last good read, when a poll could not read it", () => {
    store.upsertPullRequests("mc", [stored(7)], T0);
    expect(listed()).toEqual([
      {
        ref: "mc#7",
        pr: 7,
        untrustedAuthor: true,
        awaitingFlight: null,
        seat: "",
        runId: "",
        ready: false,
        state: "open",
        headSha: "sha7",
        readAt: "13:00",
        stale: false,
        review: null,
        failingChecks: [],
      },
    ]);
    store.markPullRequestsStale("mc");
    expect(listed()).toMatchObject([{ pr: 7, state: "open", readAt: "13:00", stale: true }]);
    store.upsertPullRequests("mc", [stored(7)], T0 + MIN);
    expect(listed()[0]?.stale).toBe(false);
  });

  it("FLIGHT's first digest lists a merged PR once, and no second wake follows", async () => {
    store.upsertPullRequests("mc", [stored(7, { state: "merged", mergedAt: T0 }), stored(8)], T0);
    await watch.check();
    expect(startCalls).toHaveLength(1);
    const first = JSON.parse(startCalls[0]?.first?.split("\n").at(-1) ?? "") as FlightWake;
    expect(first.prs.entries.map((p) => [p.pr, p.state])).toEqual([
      [7, "merged"],
      [8, "open"],
    ]);
    expect(listed().map((p) => p.pr)).toEqual([8]);
    facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
    await watch.check();
    expect(sendCalls).toEqual([]);
  });

  it("lists a merged PR once, then drops it", () => {
    store.upsertPullRequests("mc", [stored(7), stored(8)], T0);
    store.upsertPullRequests("mc", [stored(7, { state: "merged", mergedAt: T0 })], T0 + MIN);
    expect(listed().map((p) => [p.pr, p.state])).toEqual([
      [7, "merged"],
      [8, "open"],
    ]);
    // reading is not delivering: it stays listed until FLIGHT has received it
    expect(listed().map((p) => p.pr)).toEqual([7, 8]);
    markPrsShown(store, flightState({ config, store, busy: [], now: nowMs }));
    expect(listed().map((p) => p.pr)).toEqual([8]);
  });

  it("a wake that failed to send still lists the merged PR at the next one", async () => {
    liveCrew();
    ask();
    store.upsertPullRequests("mc", [stored(7, { state: "merged", mergedAt: T0 })], T0);
    sendFails = true;
    await watch.check();
    sendFails = false;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
    const last = JSON.parse(sendCalls[1]?.text.split("\n").at(-1) ?? "") as FlightWake;
    expect(last.prs.entries.map((p) => [p.pr, p.state])).toEqual([[7, "merged"]]);
    await watch.check();
    expect(sendCalls).toHaveLength(2);
  });

  it("sends a due wake with the wake's number and its digest and lessons pieces", async () => {
    liveCrew();
    ask();
    store.upsertPullRequests("mc", [stored(7, { state: "merged", mergedAt: T0 })], T0);
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    const call = sendCalls[0];
    expect(call?.cost?.wake).toBe(1);
    expect(call?.cost?.pieces.map((p) => p.section)).toEqual(["lessons", "digest"]);
    const digest = JSON.stringify(JSON.parse(call?.text.split("\n").at(-1) ?? ""));
    expect(call?.cost?.pieces.reduce((n, p) => n + p.bytes, 0)).toBe(Buffer.byteLength(digest));
  });

  it("does not wake again when a merged PR leaves the list after its wake", async () => {
    liveCrew();
    ask();
    store.upsertPullRequests("mc", [stored(7, { state: "merged", mergedAt: T0 }), stored(8)], T0);
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    await watch.check();
    expect(sendCalls).toHaveLength(1);
  });

  it("still lists the PR of a parked run, with its seat", () => {
    live("guido-1", "r-guido");
    store.upsertRun(run("r-guido", "guido-1", { ticket: "mc#7" }));
    store.setRunLoop("r-guido", {
      ...NEW_LOOP,
      phase: "parked",
      parked: { kind: "silent", reason: "x", ended: false },
      prNumber: 7,
    });
    store.upsertPullRequests("mc", [stored(7)], T0);
    expect(listed()).toMatchObject([{ pr: 7, seat: "guido-1", state: "open" }]);
  });
});

describe("FLIGHT's evidence", () => {
  const check = (name: string, state: "passing" | "failing" | "pending") => ({
    name,
    kind: "check" as const,
    state,
    conclusion: state,
    attempt: 1,
    url: null,
  });
  const review = (
    sha: string,
    spec: "pass" | "fail",
    findings: number,
    at = T0,
    runId = "r-retro",
    round = 1,
  ) => {
    const id = store.requestReview({
      authorRunId: "r-guido",
      repoId: "mc",
      seatId: "guido-1",
      prNumber: 7,
      sha,
      epoch: 0,
      attempt: 1,
      round,
      at,
    });
    if (id === null) throw new Error("review not queued");
    store.setReviewState(id, ["queued"], "running", { runId, at });
    store.recordFindings(id, runId, {
      verdict: { spec, quality: "pass" },
      summary: "s",
      findings: Array.from({ length: findings }, () => ({
        severity: "Critical" as const,
        file: "a.ts",
        line: 1,
        summary: "x",
        scenario: "y",
        fix: "z",
      })),
      at,
    });
  };
  const parkedOf = () =>
    flightState({ config, store, busy: [], now: nowMs }).seats.find((s) => s.id === "guido-1")
      ?.parked;
  const park = (kind: string) => {
    live("guido-1", "r-guido");
    store.setRunLoop("r-guido", {
      ...NEW_LOOP,
      phase: "parked",
      parked: { kind, reason: "x", ended: false },
    });
  };

  it("carries RETRO's verdict, blocking findings, head and failing checks on a PR", () => {
    store.upsertPullRequests(
      "mc",
      [stored(7, { checks: [check("lint", "failing"), check("test", "passing")] })],
      T0,
    );
    review("sha7", "fail", 2);
    expect(listed()[0]).toMatchObject({
      headSha: "sha7",
      failingChecks: ["lint"],
      review: { spec: "fail", quality: "pass", blocking: 2, sha: "sha7" },
    });
  });

  it("carries the latest reported review, not an earlier or unreported one", () => {
    store.upsertPullRequests("mc", [stored(7, {})], T0);
    review("sha6", "fail", 2, T0, "r-retro", 1);
    review("sha7", "pass", 0, T0 + 1, "r-retro-2", 2);
    const failed = store.requestReview({
      authorRunId: "r-guido",
      repoId: "mc",
      seatId: "guido-1",
      prNumber: 7,
      sha: "sha8",
      epoch: 0,
      attempt: 1,
      round: 3,
      at: T0 + 2,
    });
    if (failed === null) throw new Error("review not queued");
    store.setReviewState(failed, ["queued"], "failed", { at: T0 + 2, failure: "crashed" });
    expect(listed()[0]?.review).toEqual({
      spec: "pass",
      quality: "pass",
      blocking: 0,
      sha: "sha7",
    });
  });

  it("carries a ruling park's last report, cut to 1,500 characters", () => {
    park("ruling");
    store.addEvidence("r-guido", "old", T0);
    store.addEvidence("r-guido", "r".repeat(2000), T0 + 1);
    expect(parkedOf()?.report).toHaveLength(1500);
    expect(parkedOf()?.report?.startsWith("rrr")).toBe(true);
  });

  it("carries a review-ruling park's report too", () => {
    park("review-ruling");
    store.addEvidence("r-guido", "short", T0);
    expect(parkedOf()?.report).toBe("short");
  });

  it("carries no report on other parks", () => {
    park("silent");
    store.addEvidence("r-guido", "note", T0);
    expect(parkedOf()?.report).toBeUndefined();
  });
});

describe("FLIGHT's flow queues", () => {
  it("keeps a review carried across a main merge current", () => {
    live("guido-1", "r-guido");
    store.setRunLoop("r-guido", {
      ...NEW_LOOP,
      phase: "ci",
      prNumber: 7,
      carry: { from: "old-sha", to: "new-sha" },
    });
    store.upsertPullRequests("mc", [stored(7, { headSha: "old-sha", ci: "passing" })], T0);
    const oldReview = store.requestReview({
      authorRunId: "r-guido",
      repoId: "mc",
      seatId: "retro-1",
      prNumber: 7,
      sha: "old-sha",
      epoch: 0,
      attempt: 1,
      round: 1,
      at: T0,
    });
    if (oldReview === null) throw new Error("review not queued");
    store.setReviewState(oldReview, ["queued"], "running", { runId: "r-retro", at: T0 });
    store.recordFindings(oldReview, "r-retro", {
      verdict: { spec: "pass", quality: "pass" },
      summary: "clean",
      findings: [],
      at: T0,
    });
    store.upsertPullRequests("mc", [stored(7, { headSha: "new-sha", ci: "passing" })], T0 + MIN);

    expect(carriedFrom({ from: "old-sha", to: "new-sha" }, null, "new-sha")).toBe("old-sha");
    expect(flightState({ config, store, busy: [], now: T0 + MIN }).mergeQueue).toEqual([]);
  });

  it("waits for review when the reported review is from an older PR head", () => {
    store.upsertPullRequests("mc", [stored(7, { headSha: "old-sha", ci: "passing" })], T0);
    const oldReview = store.requestReview({
      authorRunId: "r-author",
      repoId: "mc",
      seatId: "retro-1",
      prNumber: 7,
      sha: "old-sha",
      epoch: 0,
      attempt: 1,
      round: 1,
      at: T0,
    });
    if (oldReview === null) throw new Error("review not queued");
    store.setReviewState(oldReview, ["queued"], "running", { runId: "r-retro", at: T0 });
    store.recordFindings(oldReview, "r-retro", {
      verdict: { spec: "pass", quality: "pass" },
      summary: "clean",
      findings: [],
      at: T0,
    });
    store.upsertPullRequests("mc", [stored(7, { headSha: "new-sha", ci: "passing" })], T0 + MIN);
    store.requestReview({
      authorRunId: "r-author",
      repoId: "mc",
      seatId: "retro-1",
      prNumber: 7,
      sha: "new-sha",
      epoch: 1,
      attempt: 1,
      round: 1,
      at: T0 + MIN,
    });

    expect(flightState({ config, store, busy: [], now: T0 + MIN }).mergeQueue).toEqual([
      { pr: 7, waitsOn: ["review"] },
    ]);
  });

  it("keeps another repository's reviews out of this session's queue", () => {
    store.requestReview({
      authorRunId: "r-other-author",
      repoId: "other",
      seatId: "retro-other",
      prNumber: 1,
      sha: "other-sha",
      epoch: 0,
      attempt: 1,
      round: 1,
      at: T0,
    });

    const result = flightState({ config, store, busy: [], now: T0 });

    expect(result.reviewQueue).toEqual({
      queued: 0,
      waitMin: 0,
      running: 0,
      seats: [{ seat: "retro-1", queued: 0, running: 0, idle: true }],
    });
  });

  it("names a machine hold that leaves queued reviews without a reviewer", () => {
    const crew = config.crew;
    if (crew === undefined) throw new Error("test fixture has no crew");
    const flowConfig: CcConfig = {
      ...config,
      crew: {
        ...crew,
        sessions: crew.sessions.map((session) => ({
          ...session,
          seats: [...session.seats, seat("retro-2", "RETRO", { mode: "scratch" })],
        })),
      },
    };
    for (let n = 1; n <= 5; n++) {
      store.requestReview({
        authorRunId: `r-author-${n}`,
        repoId: "mc",
        seatId: n % 2 === 0 ? "retro-2" : "retro-1",
        prNumber: n,
        sha: `sha-${n}`,
        epoch: 0,
        attempt: 1,
        round: 1,
        at: T0,
      });
    }
    store.replaceBoard("mc", [
      {
        repoId: "mc",
        issueNumber: 6,
        title: "Ready ticket",
        status: "Ready",
        state: "planned",
        labels: [],
        priority: null,
        updatedAt: T0,
        url: "u",
        stage: null,
        owner: null,
        parent: null,
        subIssues: null,
        blockedBy: [],
        milestone: null,
        size: null,
        closed: false,
        prioritySource: null,
        createdAt: T0,
        itemId: "I6",
        projectId: "P1",
      },
    ]);
    store.addMachineSample({
      at: T0,
      cpuPct: null,
      memUsedBytes: 1,
      diskFreeBytes: 10 * 1024 ** 3,
      diskTotalBytes: 100 * 1024 ** 3,
      swapUsedBytes: 0,
      memTotalBytes: 100 * 1024 ** 3,
      memoryPressureFreePct: 90,
      load1: 0,
      cores: 8,
      agents: null,
    });

    const result = flightState({ config: flowConfig, store, busy: [], now: T0 });

    expect(result.reviewQueue).toEqual({
      queued: 5,
      waitMin: 0,
      running: 0,
      seats: [
        { seat: "retro-1", queued: 3, running: 0, idle: true },
        { seat: "retro-2", queued: 2, running: 0, idle: true },
      ],
    });
    expect(result.flowHolds).toContainEqual({
      kind: "machine",
      reason: "disk free is 10.0 GB (below 15 GB)",
      blocks: "5 queued reviews for 2 idle review seats; 1 eligible ticket for 2 idle build seats",
      feedbackLoop: "the hold blocks reviews; held reviews cannot merge",
      blocking: true,
    });
    expect(wakeFacts(result)).toContain("machine");
  });

  it("keeps a machine hold's wake fact stable while its reading changes", () => {
    store.requestReview({
      authorRunId: "r-author",
      repoId: "mc",
      seatId: "retro-1",
      prNumber: 1,
      sha: "sha",
      epoch: 0,
      attempt: 1,
      round: 1,
      at: T0,
    });
    const sample = (at: number, diskFreeBytes: number) =>
      store.addMachineSample({
        at,
        cpuPct: null,
        memUsedBytes: 1,
        diskFreeBytes,
        diskTotalBytes: 100 * 1024 ** 3,
        memTotalBytes: 100 * 1024 ** 3,
        cores: 8,
        agents: null,
      });
    sample(T0, 10 * 1024 ** 3);
    const first = flightState({ config, store, busy: [], now: T0 });
    sample(T0 + MIN, 9.8 * 1024 ** 3);
    const second = flightState({ config, store, busy: [], now: T0 + MIN });

    expect(second.flowHolds?.[0]).toMatchObject({
      kind: "machine",
      reason: "disk free is 9.8 GB (below 15 GB)",
      blocking: true,
    });
    expect(wakeFacts(second)).toBe(deliveredFacts(first));
  });

  it("does not claim a build-only pause blocks a review", () => {
    store.requestReview({
      authorRunId: "r-author",
      repoId: "mc",
      seatId: "retro-1",
      prNumber: 1,
      sha: "sha",
      epoch: 0,
      attempt: 1,
      round: 1,
      at: T0,
    });
    store.setSetting(
      CREW_PAUSE_SETTING,
      JSON.stringify({ seats: ["guido-1"], reason: "builders off", at: T0, by: "operator" }),
    );

    const hold = flightState({ config, store, busy: [], now: T0 }).flowHolds?.find(
      (candidate) => candidate.kind === "crew-pause",
    );

    expect(hold).toMatchObject({
      reason: "builders off",
      blocks: "1 build seat, 0 review seats and 0 queued reviews",
      blocking: false,
    });
  });

  it("lists merge waits, including pending CI and conflicts, and quota and stopped-seat holds", () => {
    live("guido-1", "r-guido");
    store.setRunLoop("r-guido", {
      ...NEW_LOOP,
      phase: "review",
      prNumber: 7,
      awaitingFlight: "sha",
    });
    store.upsertPullRequests(
      "mc",
      [
        stored(7, {
          checks: [
            {
              name: "test",
              kind: "check",
              state: "failing",
              conclusion: "failing",
              attempt: 1,
              url: null,
            },
            {
              name: "build",
              kind: "check",
              state: "pending",
              conclusion: "pending",
              attempt: 1,
              url: null,
            },
          ],
          mergeable: "CONFLICTING",
        }),
      ],
      T0,
    );
    store.addUsage({
      accountId: "claude-main",
      window: "5h",
      at: T0,
      pct: 95,
      resetAt: T0 + MIN,
      source: "test",
    });
    store.setSeatSession(row("inco-1", null, "stopped"));

    const result = flightState({ config, store, busy: [], now: T0 });

    expect(result.mergeQueue).toEqual([
      {
        pr: 7,
        waitsOn: ["CI: test", "CI pending: build", "merge conflict", "review", "FLIGHT merge"],
      },
    ]);
    expect(result.flowHolds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "quota", reason: "GUIDO-1's 5h quota is 95% (stop 95%)" }),
        expect.objectContaining({ kind: "seat-stopped", reason: "INCO-1 is stopped" }),
      ]),
    );
  });
});

describe("FLIGHT's holds", () => {
  const heldCard = (status: string) =>
    store.replaceBoard("mc", [
      {
        repoId: "mc",
        issueNumber: 9,
        title: "Ticket 9",
        status,
        state: "planned",
        labels: [],
        priority: null,
        updatedAt: T0,
        url: "u",
        stage: null,
        owner: null,
        parent: null,
        subIssues: null,
        blockedBy: [],
        milestone: null,
        size: null,
        closed: false,
        prioritySource: null,
        createdAt: T0,
        itemId: "I9",
        projectId: "P1",
      },
    ]);
  beforeEach(() => heldCard("Backlog"));
  const hold = () => store.addHold({ ref: "mc#9", waitsOn: 7, basis: "same files", at: T0 });

  it("lists a hold in the digest with its age", () => {
    store.upsertPullRequests("mc", [stored(7)], T0);
    hold();
    nowMs = T0 + 5 * MIN;
    expect(flightState({ config, store, busy: [], now: nowMs }).holds).toEqual([
      { ref: "mc#9", waitsOn: 7, ageMin: 5, prState: "open", told: false },
    ]);
  });

  it("wakes once when the waited-on PR merges, with the hold listed", async () => {
    liveCrew();
    store.upsertPullRequests("mc", [stored(7)], T0);
    hold();
    await watch.check();
    // an open PR moving through the pipeline wakes nothing; the hold's release is the wake
    expect(sendCalls).toEqual([]);
    // updatedAt is over an hour old, so the PR is not listed and only the hold can cause the wake
    store.upsertPullRequests(
      "mc",
      [stored(7, { state: "merged", mergedAt: T0, updatedAt: T0 - 120 * MIN })],
      T0 + MIN,
    );
    nowMs = T0 + FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text).toContain("1 hold to release");
    const sent = JSON.parse(sendCalls[0]?.text.split("\n").at(-1) ?? "") as FlightWake;
    expect(sent.holds).toMatchObject([{ ref: "mc#9", waitsOn: 7, prState: "merged" }]);
    await watch.check();
    expect(sendCalls).toHaveLength(1);
  });

  it("wakes when the PR closes unmerged, and a released hold wakes nothing", async () => {
    flightOnly();
    store.upsertPullRequests("mc", [stored(7)], T0);
    hold();
    store.upsertPullRequests(
      "mc",
      [stored(7, { state: "closed", updatedAt: T0 - 120 * MIN })],
      T0 + MIN,
    );
    sendCalls = [];
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text).toContain("1 hold to release");
    // FLIGHT keeps the hold: it is told once, not at every re-wake
    nowMs = T0 + 3 * 60 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(flightState({ config, store, busy: [], now: nowMs }).holds).toMatchObject([
      { ref: "mc#9", prState: "closed", told: true },
    ]);
    store.releaseHold("mc#9", nowMs);
    expect(flightState({ config, store, busy: [], now: nowMs }).holds).toEqual([]);
  });

  it("reports a hold whose PR is not in the stored read as unknown", () => {
    hold();
    expect(flightState({ config, store, busy: [], now: nowMs }).holds).toMatchObject([
      { ref: "mc#9", prState: "unknown", told: false },
    ]);
  });

  it("remembers a hold was told across a store reopen", () => {
    store.upsertPullRequests("mc", [stored(7, { state: "closed", updatedAt: T0 - 120 * MIN })], T0);
    hold();
    markPrsShown(store, flightState({ config, store, busy: [], now: nowMs }));
    store.close();
    store = new Store(join(dir, "mc.sqlite"));
    store.setSetting(
      `${FLIGHT_RETROSPECTIVE_SETTING}:mc`,
      JSON.stringify({ day: "2026-10-22", told: true }),
    );
    expect(flightState({ config, store, busy: [], now: nowMs }).holds).toMatchObject([
      { ref: "mc#9", prState: "closed", told: true },
    ]);
  });

  it("drops a hold whose card the board has moved past, and does not wake for it", async () => {
    liveCrew();
    store.upsertPullRequests("mc", [stored(7)], T0);
    hold();
    await watch.check();
    sendCalls = [];
    heldCard("Ready");
    store.upsertPullRequests(
      "mc",
      [stored(7, { state: "merged", mergedAt: T0, updatedAt: T0 - 120 * MIN })],
      T0 + MIN,
    );
    nowMs = T0 + MIN;
    expect(flightState({ config, store, busy: [], now: nowMs }).holds).toEqual([]);
    await watch.check();
    expect(sendCalls).toEqual([]);
    expect(store.activeHolds()).toEqual([]);
  });
});

const raiseBlocked = (key = "blocked:r1:0", over: Record<string, unknown> = {}) =>
  store.raiseNote({
    key,
    kind: "blocked",
    runId: null,
    seatId: "guido-1",
    repoId: "mc",
    text: "mc#7 parked",
    at: T0,
    ...over,
  });

describe("FLIGHT's items to brief", () => {
  const items = () => flightState({ config, store, busy: [], now: T0 + 5 * MIN }).items;

  it("lists the operator's items with no brief, not a briefed or controller one", () => {
    live("flight-1", "r-flight");
    raiseBlocked();
    raiseBlocked("cleanup-branch:x");
    expect(items()).toEqual([
      {
        key: "note:blocked:r1:0",
        kind: "blocked",
        ticket: null,
        text: "mc#7 parked",
        ageMin: 5,
        triageRemainingMs: 15 * MIN,
      },
    ]);
    store.addBrief({
      key: "note:blocked:r1:0",
      context: "c",
      recommendation: "r",
      options: [],
      basis: "b",
      at: T0,
    });
    expect(items()).toEqual([]);
  });

  it("leaves out FLIGHT's own replies and tags, and keeps another seat's reply", () => {
    live("flight-1", "r-flight");
    const say = (at: number, from: string, to: string, text: string) =>
      store.addComms({ at, from, to, ticket: null, text });
    say(T0, COMMS_CAPCOM, "flight-1", "status?");
    say(T0 + MIN, "flight-1", COMMS_CAPCOM, "No change @CAPCOM");
    say(T0, COMMS_CAPCOM, "guido-1", "how is it going?");
    say(T0 + MIN, "guido-1", COMMS_CAPCOM, "Please confirm the target branch.");
    const listed = items();
    expect(listed.map((i) => i.kind)).toEqual(["message"]);
    expect(listed.some((i) => i.key.includes("flight-1"))).toBe(false);
  });

  it("lists nothing without a FLIGHT seat", () => {
    raiseBlocked();
    const cfg = structuredClone(config);
    for (const s of cfg.crew?.sessions[0]?.seats ?? []) if (s.id === "flight-1") s.retiring = true;
    expect(flightState({ config: cfg, store, busy: [], now: T0 }).items).toEqual([]);
  });
});

describe("FLIGHT's brief in the digest", () => {
  const setNotes = (at: number) =>
    store.setFlightBriefSection({
      sessionId: "s1",
      section: "lessons",
      text: "Ship the brief.",
      updatedAt: at,
      updatedBy: "flight-1",
    });

  it("starts FLIGHT with the note sections", async () => {
    setNotes(T0);
    await watch.check();
    const state = JSON.parse(startCalls[0]?.first?.split("\n")[2] ?? "") as FlightWake;
    expect(state.brief?.map((b) => b.section)).toEqual(FLIGHT_NOTE_SECTIONS);
    expect(state.brief?.[3]?.text).toBe("Ship the brief.");
  });

  it("carries a ledger index and headline, and a ledger edit does not wake FLIGHT", async () => {
    for (const [section, text] of [
      ["in_progress", "Wiring the page."],
      [FLIGHT_HEADLINE, "H"],
    ] as const) {
      store.setFlightBriefSection({
        sessionId: "s1",
        section,
        text,
        updatedAt: T0,
        updatedBy: "flight-1",
      });
    }
    const entry: FlightLedgerEntry = {
      kind: "work",
      key: "w-ledger",
      title: "Wire the page",
      status: "active",
      next: "plan it",
      owner: null,
      waitsOn: null,
      due: null,
      refs: [],
      priority: null,
      createdAt: T0,
      updatedAt: T0,
      outcome: null,
      basis: "ticket",
    };
    store.putFlightLedgerEntry("s1", entry, 0);
    store.putFlightLedgerEntry("s1", { ...entry, key: "old", status: "done" }, 0);
    await watch.check();
    const line = startCalls[0]?.first ?? "";
    const state = JSON.parse(line.split("\n")[2] ?? "") as FlightWake;
    expect(state.ledger.entries).toEqual([
      { kind: "work", key: "w-ledger", title: "Wire the page", status: "active", next: "plan it" },
    ]);
    expect(state.ledgerMore).toBe(0);
    expect(state.headline).toBe("H");
    expect(state.brief?.map((b) => b.section)).toEqual(FLIGHT_NOTE_SECTIONS);
    expect(line).not.toContain("Wiring the page.");
    facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    store.putFlightLedgerEntry("s1", { ...entry, next: "Review it", updatedAt: nowMs }, 0);
    bus.emit("flight");
    await watch.check();
    expect(sendCalls).toHaveLength(0);
    // A real question can wake FLIGHT at the same time; the ledger edit was not throttled.
    live("guido-1", "r-guido");
    ask();
    await watch.check();
    expect(sendCalls).toHaveLength(1);
  });

  it("a brief edit alone does not wake FLIGHT", async () => {
    liveCrew();
    await watch.check();
    const sent = sendCalls.length;
    setNotes(T0);
    nowMs = T0 + MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(sent);
  });

  const sentWake = (): FlightWake =>
    JSON.parse(sendCalls.at(-1)?.text.split("\n").at(-1) ?? "") as FlightWake;

  describe("the wake status /api/flight serves", () => {
    const status = () => flightView(config, store, nowMs, () => true).wake;

    it("knows nothing before FLIGHT's first wake", () => {
      expect(status()).toEqual({ lastWakeAt: null, wokeOn: null, nextWakeAt: null });
    });

    it("records a start's time and what woke it", async () => {
      live("guido-1", "r-guido");
      ask();
      await watch.check();
      expect(startCalls).toHaveLength(1);
      expect(status()?.lastWakeAt).toBe(nowMs);
      expect(status()?.wokeOn).toContain("q (1)");
      expect(status()?.nextWakeAt).toBe(nowMs + FLIGHT_REWAKE_MS);
    });

    it("keeps the last wake but drops a stale schedule across a restart", async () => {
      liveCrew();
      ask();
      await watch.check();
      expect(status()?.nextWakeAt).toBe(nowMs + FLIGHT_REWAKE_MS);
      const woke = status();
      facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
      makeWatch();
      watch.start();
      await watch.check();
      expect(status()).toEqual({ ...woke, nextWakeAt: null });
    });

    it("records a wake sent to a live FLIGHT, and keeps it across a new watch", async () => {
      liveCrew();
      ask();
      await watch.check();
      expect(sendCalls).toHaveLength(1);
      const woke = status();
      expect(woke?.lastWakeAt).toBe(nowMs);
      expect(woke?.wokeOn).toContain("q (1)");
      nowMs += 5 * MIN;
      makeWatch();
      expect(status()).toEqual({ ...woke, nextWakeAt: woke?.nextWakeAt ?? null });
    });

    it("calls a backstop re-wake a reminder, as the digest does", async () => {
      liveCrew();
      ask();
      await watch.check();
      // the unanswered question goes stale at 10 minutes, and that wakes FLIGHT for itself
      nowMs += 11 * MIN;
      await watch.check();
      expect(status()?.wokeOn).toEqual(["signals (1)"]);
      nowMs += FLIGHT_REWAKE_MS + MIN;
      await watch.check();
      expect(sendCalls).toHaveLength(3);
      expect(status()?.wokeOn).toEqual(["reminder"]);
    });

    it("leaves a failed send unrecorded", async () => {
      liveCrew();
      ask();
      sendFails = true;
      await watch.check();
      expect(status()?.lastWakeAt).toBeNull();
    });

    it("schedules the re-wake backstop only while work is pending", async () => {
      liveCrew();
      ask();
      await watch.check();
      const woke = nowMs;
      nowMs += MIN;
      await watch.check();
      expect(status()?.nextWakeAt).toBe(woke + FLIGHT_REWAKE_MS);
      store.answerQuestion(store.openQuestions()[0]?.id ?? 0, nowMs);
      idleCrew();
      await watch.check();
      expect(status()).toMatchObject({ lastWakeAt: woke, nextWakeAt: null });
    });

    it("schedules a planned entry that is not yet due, and nothing once FLIGHT is down", async () => {
      liveCrew();
      store.setFlightPlans(
        "s1",
        {
          upsert: [
            {
              id: "recheck",
              dueAt: nowMs + 10 * MIN,
              kind: "PR recheck",
              target: "mc#1",
              label: "Re-check",
              status: "pending",
            },
          ],
        },
        nowMs,
      );
      ask();
      await watch.check();
      expect(status()?.nextWakeAt).toBe(nowMs + 10 * MIN);
      expect(flightView(config, store, nowMs, () => false).wake?.nextWakeAt).toBeNull();
    });
  });

  it("omits the brief after start and resends it after FLIGHT edits it", async () => {
    setNotes(T0);
    await watch.check();
    facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
    live("guido-1", "r-guido");
    ask();
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sentWake().brief).toBeUndefined();
    expect(sentWake().briefVersion).toBe(1);
    store.setFlightBriefSection({
      sessionId: "s1",
      section: "lessons",
      text: "A new lesson.",
      updatedAt: nowMs,
      updatedBy: "flight-1",
    });
    nowMs += FLIGHT_REWAKE_MS;
    await watch.check();
    expect(sentWake().brief?.find((b) => b.section === "lessons")?.text).toBe("A new lesson.");
    expect(sentWake().briefVersion).toBe(2);
    nowMs += FLIGHT_REWAKE_MS;
    await watch.check();
    expect(sentWake().brief).toBeUndefined();
    expect(sentWake().briefVersion).toBe(2);
  });

  it("compares against the last delivered wake, never a failed send or a silent pass", async () => {
    liveCrew();
    setNotes(T0);
    store.upsertPullRequests("mc", [stored(7)], T0);
    ask();
    await watch.check();
    expect(sentWake().brief).toBeDefined();
    store.markPullRequestsStale("mc");
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    nowMs += FLIGHT_REWAKE_MS;
    sendFails = true;
    await watch.check();
    const failed = sentWake();
    expect(failed.prs.entries).toMatchObject([{ pr: 7, stale: true }]);
    sendFails = false;
    await watch.check();
    expect(sentWake()).toEqual(failed);
    nowMs += FLIGHT_REWAKE_MS;
    await watch.check();
    expect(sentWake().prs).toEqual({ entries: [], unchanged: 1, removed: [] });
    expect(sentWake().seats).toEqual({ entries: [], unchanged: 3, removed: [] });
    expect(sentWake().brief).toBeUndefined();
    expect(sentWake().facts.q).toHaveLength(1);
    expect(sentWake().questions).toHaveLength(1);
  });

  it("does not repeat memory titles beyond the wake cap after a full tool read", async () => {
    liveCrew();
    ask();
    for (let n = 0; n < 100; n++)
      store.putFlightMemory({
        repoId: "mc",
        topic: `topic ${n}`,
        kind: "lesson",
        body: "Lesson",
        source: "test",
        author: "flight",
        updatedAt: T0,
      });
    await watch.check();
    const read = flightState({ config, store, busy: [], now: nowMs });
    expect(read.memory).toHaveLength(100);
    watch.seen("r-flight", read);
    nowMs += FLIGHT_REWAKE_MS;
    await watch.check();
    expect(sentWake().memory.titles.lesson.entries).toEqual([]);
    expect(sentWake().memory.titles.lesson.unchanged).toBe(100);
  });

  it("emits attention at the triage deadline between watch ticks", async () => {
    liveCrew();
    nowMs = T0 + MIN;
    raiseBlocked();
    await watch.check();
    emitted.length = 0;
    nowMs = T0 + 20 * MIN;
    await vi.advanceTimersByTimeAsync(19 * MIN);
    expect(emitted).toContain("attention");
    watch.stop();
    emitted.length = 0;
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(emitted).toEqual([]);
  });

  it("compares the next wake with the full state read mid-turn, including flips back", async () => {
    liveCrew();
    setNotes(T0);
    ask();
    await watch.check();
    expect(sentWake().seats.entries.find((s) => s.id === "guido-1")?.state).toBe("idle");
    store.setSeatSession(row("guido-1", "r-guido", "running"));
    const read = flightState({ config, store, busy: [], now: nowMs });
    read.headline = "Working";
    for (const note of read.brief) note.text = "Mid-turn note";
    read.tickets = [
      {
        ref: "mc#999",
        title: "Seen mid-turn",
        column: "Ready",
        ready: true,
        priority: null,
        labels: [],
        blockedBy: [],
        laneLabel: null,
        assignees: [],
      },
    ];
    watch.seen("r-flight", read);
    store.setSeatSession(row("guido-1", "r-guido", "idle"));
    nowMs += FLIGHT_REWAKE_MS;
    await watch.check();
    const next = sentWake();
    expect(next.seats.entries).toMatchObject([{ id: "guido-1", state: "idle" }]);
    expect(next.seats.unchanged).toBe(2);
    expect(next.headline).toBe("");
    expect(next.brief?.map((b) => b.section)).toEqual(FLIGHT_NOTE_SECTIONS);
    expect(next.briefVersion).toBe(3);
    expect(next.tickets.removed).toEqual(["mc#999"]);
    nowMs += FLIGHT_REWAKE_MS;
    await watch.check();
    expect(sentWake().seats.entries).toEqual([]);
    expect(sentWake().brief).toBeUndefined();
  });

  it("ignores a late tool read from a previous run", async () => {
    liveCrew();
    ask();
    await watch.check();
    const stale = flightState({ config, store, busy: [], now: nowMs });
    for (const seat of stale.seats) seat.state = "running";
    watch.seen("old-flight", stale);
    nowMs += FLIGHT_REWAKE_MS;
    await watch.check();
    expect(sentWake().seats.entries).toEqual([]);
  });

  it.each(["restart", "run", "rotation"])(
    "sends the full brief and lists after a %s",
    async (change) => {
      liveCrew();
      setNotes(T0);
      ask();
      await watch.check();
      nowMs += FLIGHT_REWAKE_MS;
      if (change === "restart") {
        watch.stop();
        makeWatch();
      } else if (change === "run") {
        live("flight-1", "new-flight");
      } else {
        watch.rotate();
        await watch.check();
        const first = JSON.parse(startCalls.at(-1)?.first?.split("\n").at(-1) ?? "") as FlightWake;
        expect(first.brief).toBeDefined();
        expect(first.seats.unchanged).toBe(0);
        facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
        nowMs += FLIGHT_REWAKE_MS;
        await watch.check();
        expect(sendCalls.at(-1)?.runId).toBe(store.seatSession("flight-1")?.runId);
        expect(sentWake().seats).toEqual({ entries: [], unchanged: 3, removed: [] });
        expect(sentWake().brief).toBeUndefined();
        expect(sentWake().briefVersion).toBe(1);
        return;
      }
      await watch.check();
      expect(sentWake().brief).toBeDefined();
      expect(sentWake().seats.unchanged).toBe(0);
      expect(sentWake().briefVersion).toBe(1);
    },
  );
});

describe("the FLIGHT watcher", () => {
  it("starts FLIGHT with the digest", async () => {
    await watch.check();
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.seatId).toBe("flight-1");
    const first = startCalls[0]?.first ?? "";
    expect(first.startsWith(`${FLIGHT_WAKE_HEAD} `)).toBe(true);
    const digest = JSON.parse(first.split("\n").at(-1) ?? "") as FlightWake;
    expect(digest.repo).toBe("mc");
    expect(digest.seats.entries.map((s) => ({ id: s.id, state: s.state, free: s.free }))).toEqual([
      { id: "guido-1", state: null, free: true },
      { id: "inco-1", state: null, free: true },
      { id: "retro-1", state: null, free: true },
    ]);
    expect(digest.seats.unchanged).toBe(0);
    expect(digest.seats.removed).toEqual([]);
    expect(digest.brief?.map((b) => b.section)).toEqual(FLIGHT_NOTE_SECTIONS);
    expect(digest.brief?.every((b) => b.text === "")).toBe(true);
    expect(digest.headline).toBe("");
    expect(digest.briefVersion).toBe(1);
    for (const list of ["recent", "prs", "ledger", "tickets"] as const) {
      expect(digest[list]).toEqual({ entries: [], unchanged: 0, removed: [] });
    }
    expect(digest.facts.q).toEqual([]);
  });

  it("a retiring watch seat is not FLIGHT; a retiring build seat is not free or counted", () => {
    const cfg = structuredClone(config);
    const seats = cfg.crew?.sessions[0]?.seats ?? [];
    const byId = (id: string) => {
      const x = seats.find((y) => y.id === id);
      if (!x) throw new Error(id);
      return x;
    };
    byId("flight-1").retiring = true;
    expect(flightSeat(cfg)).toBeNull();
    // two build seats count; a retiring one does not
    delete byId("flight-1").retiring;
    expect(flightStartCap(cfg)).toBe(FLIGHT_STARTS_PER_HOUR * 2);
    byId("inco-1").retiring = true;
    expect(flightStartCap(cfg)).toBe(FLIGHT_STARTS_PER_HOUR);
    const state = flightState({ config: cfg, store, busy: [], now: T0 });
    expect(state.seats.map((s) => s.id)).toEqual(["guido-1", "retro-1"]);
    // a second watch seat takes over while the first retires
    seats.push(seat("flight-2", "FLIGHT"));
    byId("flight-1").retiring = true;
    expect(flightSeat(cfg)?.seat.id).toBe("flight-2");
  });

  it("lists only the tickets of the hub's lane", () => {
    const cfg = structuredClone(config);
    if (cfg.crew === undefined) throw new Error("no crew");
    cfg.crew.lane = "work";
    const card = (n: number, labels: string[]): BoardItem => ({
      repoId: "mc",
      issueNumber: n,
      title: `Ticket ${n}`,
      status: "Ready",
      state: "planned",
      labels,
      priority: null,
      updatedAt: T0,
      url: "u",
      stage: null,
      owner: null,
      parent: null,
      subIssues: null,
      blockedBy: [],
      milestone: null,
      size: null,
      closed: false,
      prioritySource: null,
      createdAt: T0 - n,
      itemId: `I${n}`,
      projectId: "P1",
    });
    store.replaceBoard("mc", [card(1, ["lane:home"]), card(2, ["lane:work"])]);
    const refs = (c: CcConfig) =>
      flightState({ config: c, store, busy: [], now: T0 }).tickets.map((t) => t.ref);
    expect(refs(cfg)).toEqual(["mc#2"]);
    delete cfg.crew.lane;
    expect(refs(cfg).sort()).toEqual(["mc#1", "mc#2"]);
  });

  it("does not start FLIGHT while its seat has a pending change", async () => {
    let blocked = true;
    const w = createFlightWatch({
      config,
      store,
      bus,
      enabled: true,
      blocked: (id) => blocked && id === "flight-1",
      now: () => nowMs,
      supervisor: {
        status: () => ({ enabled: true, note: null }),
        on: () => () => {},
        busy: () => [],
        seatFacts: () => facts,
        startWatch: async (seatId, opts) => {
          startCalls.push({ seatId, first: opts?.first });
          return { runId: "x" };
        },
        send: async () => "sent",
        endRunByEngine: async () => {},
        resumeRun: async () => {},
      },
    });
    await w.check();
    expect(startCalls).toEqual([]);
    blocked = false;
    await w.check();
    expect(startCalls).toHaveLength(1);
    w.stop();
  });

  it("the operator's Stop holds", async () => {
    store.setSeatSession(row("flight-1", null, "stopped"));
    await watch.check();
    expect(startCalls).toEqual([]);
  });

  it("starts FLIGHT 3 times an hour, then raises a note once; a live FLIGHT clears it", async () => {
    startFails = "boom";
    for (let i = 0; i < 3; i++) await watch.check();
    expect(startCalls).toHaveLength(3);
    expect(notesOpen()).toEqual([]);
    await watch.check();
    await watch.check();
    expect(startCalls).toHaveLength(3);
    expect(notesOpen()).toMatchObject([
      { kind: "blocked", seatId: "flight-1", repoId: "mc", text: flightStartFailedText("boom") },
    ]);
    // the open note holds past the hour, after the start count has expired
    nowMs += 61 * MIN;
    await watch.check();
    expect(startCalls).toHaveLength(3);
    expect(notesOpen()).toHaveLength(1);
    live("flight-1", "r-hand");
    facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
    await watch.check();
    expect(notesOpen()).toEqual([]);
    // the clear emptied the start count: three more starts before the next note
    noFlight();
    for (let i = 0; i < 3; i++) await watch.check();
    expect(startCalls).toHaveLength(6);
    expect(notesOpen()).toEqual([]);
  });

  describe("a FLIGHT run with no live session (#798)", () => {
    const ghostRun = () => {
      live("flight-1", "r-ghost");
      alive = false;
      facts = null;
    };

    it("takes it back once, then ends it (engine, reason recorded) and starts FLIGHT", async () => {
      ghostRun();
      await watch.check();
      expect(resumeCalls).toEqual(["r-ghost"]);
      expect(endCalls).toEqual([]);
      expect(startCalls).toEqual([]);
      nowMs += FLIGHT_GHOST_MS - 1;
      await watch.check();
      expect(resumeCalls).toEqual(["r-ghost"]);
      expect(endCalls).toEqual([]);
      nowMs += 1;
      await watch.check();
      expect(endCalls).toEqual(["r-ghost"]);
      expect(startCalls).toHaveLength(1);
      expect(store.seatSession("flight-1")?.runId).toBe("r-flight-1");
      expect(store.agentEvents(0).map((e) => [e.agentId, e.from, e.to, e.text])).toEqual([
        [
          "flight-1",
          "idle",
          "idle",
          "Idle → Idle: its CLI session was gone (run #1 ended to start FLIGHT afresh)",
        ],
      ]);
      expect(notesOpen()).toEqual([]);
    });

    it("leaves a run its take-back brought back alone", async () => {
      ghostRun();
      onResume = () => {
        alive = true;
        facts = { inTurn: false, resumedAt: nowMs, rateLimitedUntil: null };
      };
      await watch.check();
      nowMs += FLIGHT_GHOST_MS;
      await watch.check();
      expect(resumeCalls).toEqual(["r-ghost"]);
      expect(endCalls).toEqual([]);
      expect(startCalls).toEqual([]);
      expect(store.seatSession("flight-1")?.runId).toBe("r-ghost");
    });

    it("waits while the hub cannot tell (a restart's take-back), and while the seat is held", async () => {
      live("flight-1", "r-ghost");
      alive = null;
      nowMs += 10 * FLIGHT_GHOST_MS;
      await watch.check();
      expect([resumeCalls, endCalls, startCalls]).toEqual([[], [], []]);
      watch.stop();
      let held = true;
      watch = createFlightWatch({
        config,
        store,
        bus,
        enabled: true,
        blocked: () => held,
        now: () => nowMs,
        supervisor: {
          status: () => ({ enabled: true, note: null }),
          on: () => () => {},
          busy: () => [],
          seatFacts: () => null,
          sessionAlive: () => false,
          startWatch: async () => ({ runId: "x" }),
          send: async () => "sent",
          endRunByEngine: async (runId) => void endCalls.push(runId),
          resumeRun: async (runId) => void resumeCalls.push(runId),
        },
      });
      for (let i = 0; i < 2; i++) {
        await watch.check();
        nowMs += FLIGHT_GHOST_MS;
      }
      expect([resumeCalls, endCalls]).toEqual([[], []]);
      held = false;
      await watch.check();
      expect(resumeCalls).toEqual(["r-ghost"]);
    });

    it("says the process is gone when FLIGHT will not start again, once", async () => {
      ghostRun();
      await watch.check();
      nowMs += FLIGHT_GHOST_MS;
      startFails = "could not start the CLI";
      for (let i = 0; i < 4; i++) await watch.check();
      expect(endCalls).toEqual(["r-ghost"]);
      expect(startCalls).toHaveLength(3);
      expect(notesOpen()).toMatchObject([
        {
          kind: "blocked",
          seatId: "flight-1",
          text: flightStartFailedText(
            "its process is gone, and a restart failed: could not start the CLI",
          ),
        },
      ]);
      // said in that note: a later failure is just the failure
      live("flight-1", "r-hand");
      alive = true;
      facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
      await watch.check();
      expect(notesOpen()).toEqual([]);
      noFlight();
      alive = null;
      for (let i = 0; i < 4; i++) await watch.check();
      expect(notesOpen()).toMatchObject([
        { text: flightStartFailedText("could not start the CLI") },
      ]);
    });

    it("leaves a parked FLIGHT, or one at its account's stop line, to that first", async () => {
      live("flight-1", "r-ghost");
      store.setSeatSession(row("flight-1", "r-ghost", "parked"));
      alive = false;
      await watch.check();
      nowMs += 10 * FLIGHT_GHOST_MS;
      await watch.check();
      expect([resumeCalls, endCalls, startCalls]).toEqual([[], [], []]);
      store.setSeatSession(row("flight-1", "r-ghost"));
      store.addUsage({
        accountId: "claude-main",
        window: "5h",
        at: nowMs - 1000,
        pct: 95,
        resetAt: nowMs + 60 * MIN,
        source: "test",
      });
      await watch.check();
      expect([resumeCalls, endCalls, startCalls]).toEqual([[], [], []]);
    });

    it("forgets a run it was waiting on when the watch stops", async () => {
      ghostRun();
      await watch.check();
      expect(resumeCalls).toEqual(["r-ghost"]);
      watch.stop();
      makeWatch();
      nowMs += FLIGHT_GHOST_MS;
      await watch.check();
      // a new wait, with a new take-back: nothing ended on the old one's clock
      expect(resumeCalls).toEqual(["r-ghost", "r-ghost"]);
      expect(endCalls).toEqual([]);
    });
  });

  it("does not start FLIGHT at the account's stop", async () => {
    for (const window of ["5h", "7d"] as const) {
      store.addUsage({
        accountId: "claude-main",
        window,
        at: T0 - 1000,
        pct: 95,
        resetAt: T0 + 60 * MIN,
        source: "test",
      });
    }
    await watch.check();
    expect(startCalls).toEqual([]);
  });

  describe("FLIGHT down without a failed start", () => {
    const down = () => store.notes().filter((n) => n.key === FLIGHT_DOWN_NOTE_KEY);

    it("says so while FLIGHT is parked, and clears once it is live again", async () => {
      store.upsertRun(run("r-parked", "flight-1"));
      store.setSeatSession(row("flight-1", "r-parked", "parked"));
      await watch.check();
      expect(down().map((n) => [n.kind, n.text])).toEqual([
        ["blocked", flightDownText("it is parked")],
      ]);
      await watch.check();
      expect(down()).toHaveLength(1);
      live("flight-1", "r-flight");
      facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
      await watch.check();
      expect(down()).toEqual([]);
    });

    it("says so while FLIGHT waits on its account at the stop line", async () => {
      store.addUsage({
        accountId: "claude-main",
        window: "5h",
        at: T0 - 1000,
        pct: 95,
        resetAt: T0 + 60 * MIN,
        source: "test",
      });
      await watch.check();
      expect(down().map((n) => n.text)).toEqual([
        flightDownText("claude-main is at its stop line"),
      ]);
    });

    it("says nothing when the operator stopped FLIGHT", async () => {
      store.upsertRun(run("r-stopped", "flight-1", { endedAt: T0, status: "ok" }));
      store.setSeatSession(row("flight-1", "r-stopped", "stopped"));
      await watch.check();
      expect(down()).toEqual([]);
    });

    const atStop = (resetAt: number) =>
      store.addUsage({
        accountId: "claude-main",
        window: "5h",
        at: nowMs - 1000,
        pct: 95,
        resetAt,
        source: "test",
      });
    const failedStart = () => store.notes().filter((n) => n.key === FLIGHT_NOTE_KEY);

    it("hands over from the stop line to failed starts, never both open", async () => {
      atStop(T0 + 10 * MIN);
      await watch.check();
      expect(down()).toHaveLength(1);
      // past the reset FLIGHT is restarting, not down; then its starts fail
      nowMs = T0 + 11 * MIN;
      atStop(nowMs - 1);
      startFails = "boom";
      for (let i = 0; i < 4; i++) {
        await watch.check();
        expect(down().length + failedStart().length).toBeLessThanOrEqual(1);
      }
      expect(down()).toEqual([]);
      expect(failedStart()).toHaveLength(1);
    });

    it("hands over from a silent turn to failed starts when FLIGHT dies", async () => {
      live("flight-1", "r-flight");
      facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
      nowMs = T0 + FLIGHT_DOWN_STALL_MS + MIN;
      await watch.check();
      expect(down()).toHaveLength(1);
      noFlight();
      startFails = "boom";
      for (let i = 0; i < 4; i++) {
        await watch.check();
        expect(down().length + failedStart().length).toBeLessThanOrEqual(1);
      }
      expect(failedStart()).toHaveLength(1);
    });

    it("leaves the note alone while FLIGHT's facts are unknown after a hub restart", async () => {
      live("flight-1", "r-flight");
      facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
      nowMs = T0 + FLIGHT_DOWN_STALL_MS + MIN;
      await watch.check();
      expect(down()).toHaveLength(1);
      facts = null;
      await watch.check();
      expect(down()).toHaveLength(1);
    });

    it("gives FLIGHT the background-task allowance a loop gets", async () => {
      live("flight-1", "r-flight");
      store.setDigest("r-flight", {
        toolCalls: 1,
        turns: 1,
        lastEventAt: T0,
        model: "opus",
        contextTokens: 100,
        contextWindow: null,
        liveTool: null,
        tools: {},
        subagents: [],
        minuteTokens: [],
        turnUsage: [],
        background: [{ taskId: "b1", description: "full suite", type: "bash" }],
        compactions: 0,
      });
      facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
      nowMs = T0 + FLIGHT_DOWN_STALL_MS + MIN;
      await watch.check();
      expect(down()).toEqual([]);
      nowMs = T0 + BACKGROUND_STALL_MS + MIN;
      await watch.check();
      expect(down()).toHaveLength(1);
    });

    it("clears the note when the watch is off", async () => {
      store.upsertRun(run("r-parked", "flight-1"));
      store.setSeatSession(row("flight-1", "r-parked", "parked"));
      await watch.check();
      expect(down()).toHaveLength(1);
      enabled = false;
      await watch.check();
      expect(down()).toEqual([]);
    });

    it("says so when FLIGHT has been silent in a turn for 30 minutes", async () => {
      live("flight-1", "r-flight");
      facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
      nowMs = T0 + FLIGHT_DOWN_STALL_MS - MIN;
      await watch.check();
      expect(down()).toEqual([]);
      nowMs = T0 + FLIGHT_DOWN_STALL_MS + MIN;
      await watch.check();
      expect(down().map((n) => n.text)).toEqual([flightDownText("no output for 31 min in a turn")]);
      facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
      await watch.check();
      expect(down()).toEqual([]);
    });

    it("uses the last turn line rather than a transcript touch while FLIGHT is in a turn", async () => {
      const transcriptPath = join(dir, "flight.jsonl");
      const first = JSON.stringify({
        type: "assistant",
        timestamp: new Date(T0).toISOString(),
        message: { content: [{ type: "text", text: "working" }] },
      });
      writeFileSync(transcriptPath, `${first}\n`);
      live("flight-1", "r-flight");
      store.upsertRun(run("r-flight", "flight-1", { transcriptPath }));
      store.setDigest("r-flight", foldTranscript(null, [first], T0).digest);
      facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };

      nowMs = T0 + FLIGHT_DOWN_STALL_MS + MIN;
      // HUD context reads refresh mtime without adding an agent turn.
      utimesSync(transcriptPath, nowMs / 1000, nowMs / 1000);
      await watch.check();
      expect(down().map((n) => n.text)).toEqual([flightDownText("no output for 31 min in a turn")]);

      const next = JSON.stringify({
        type: "assistant",
        timestamp: new Date(nowMs).toISOString(),
        message: { content: [{ type: "text", text: "back" }] },
      });
      writeFileSync(transcriptPath, `${first}\n${next}\n`);
      store.setDigest("r-flight", foldTranscript(null, [first, next], nowMs).digest);
      await watch.check();
      expect(down()).toEqual([]);
    });
  });

  it("does not wake while FLIGHT is rate-limited", async () => {
    liveCrew();
    ask();
    facts = { inTurn: false, resumedAt: null, rateLimitedUntil: nowMs + MIN };
    await watch.check();
    expect(sendCalls).toEqual([]);
    facts = { inTurn: false, resumedAt: null, rateLimitedUntil: nowMs - 1 };
    await watch.check();
    expect(sendCalls).toHaveLength(1);
  });

  it("FLIGHT's own event checks at once; other seats' events and boards are debounced", async () => {
    watch.start();
    await vi.advanceTimersByTimeAsync(0);
    statusCalls = 0;
    listener?.({ kind: "idle", seatId: "flight-1", runId: "r", resumed: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls).toBe(1);
    listener?.({ kind: "idle", seatId: "guido-1", runId: "r", resumed: false });
    bus.emit("boards");
    await vi.advanceTimersByTimeAsync(FLIGHT_DEBOUNCE_MS - 1);
    expect(statusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls).toBe(2);
    bus.emit("boards");
    await vi.advanceTimersByTimeAsync(FLIGHT_DEBOUNCE_MS);
    expect(statusCalls).toBe(3);
    listener?.({ kind: "idle", seatId: "guido-1", runId: "r", resumed: false });
    await vi.advanceTimersByTimeAsync(FLIGHT_DEBOUNCE_MS - 1);
    expect(statusCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls).toBe(4);
  });

  it("wakes for due plans once, retains overdue labels and retries pending work hourly after restart", async () => {
    flightOnly();
    store.setFlightPlans(
      "s1",
      {
        upsert: [
          {
            id: "recheck",
            dueAt: T0 + MIN,
            kind: "PR recheck",
            target: "mc#2368",
            label: "Re-check PR #2368 after the nudge",
            status: "pending",
          },
        ],
      },
      T0,
    );
    await watch.check();
    expect(sendCalls).toHaveLength(0);
    expect(flightState({ config, store, busy: [], now: nowMs }).planned?.[0]).toMatchObject({
      id: "recheck",
      minutesFromNow: 1,
      overdue: false,
    });
    nowMs += MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text).toContain("Re-check PR #2368 after the nudge");
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    store.close();
    store = new Store(join(dir, "mc.sqlite"));
    store.setSetting(
      `${FLIGHT_RETROSPECTIVE_SETTING}:mc`,
      JSON.stringify({ day: "2026-10-22", told: true }),
    );
    watch.stop();
    makeWatch();
    nowMs += 61 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
    const state = flightState({ config, store, busy: [], now: nowMs });
    expect(state.planned?.[0]).toMatchObject({
      status: "pending",
      overdue: true,
      label: "Re-check PR #2368 after the nudge",
      target: "mc#2368",
    });
    store.setFlightPlans(
      "s1",
      {
        upsert: [
          {
            id: "recheck",
            dueAt: T0 + MIN,
            kind: "PR recheck",
            target: "mc#2368",
            label: "Re-check PR #2368 after the nudge",
            status: "cancelled",
          },
        ],
      },
      nowMs,
    );
    nowMs += 61 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
  });

  it("wakes on a new question, once", async () => {
    liveCrew();
    ask();
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.key).toBe("flight:wake:r-flight:1");
    expect(
      sendCalls[0]?.text.startsWith(
        `${FLIGHT_WAKE_HEAD} 1 question · 1 item to brief · woke on: q (1), items (1)\n`,
      ),
    ).toBe(true);
    await watch.check();
    expect(sendCalls).toHaveLength(1);
  });

  it("wakes on a new Needs-you item, once", async () => {
    liveCrew();
    raiseBlocked();
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text.startsWith(`${FLIGHT_WAKE_HEAD} 1 item to brief`)).toBe(true);
    await watch.check();
    expect(sendCalls).toHaveLength(1);
  });

  it("a second Needs-you item wakes again", async () => {
    liveCrew();
    raiseBlocked();
    await watch.check();
    nowMs = T0 + FLIGHT_MIN_WAKE_GAP_MS;
    raiseBlocked("blocked:r1:1", { at: nowMs });
    await watch.check();
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]?.text.startsWith(`${FLIGHT_WAKE_HEAD} 2 items to brief`)).toBe(true);
  });

  it("an unbriefed item re-wakes hourly when no run is live", async () => {
    flightOnly();
    raiseBlocked();
    await watch.check();
    // it goes stale after 10 minutes, which wakes FLIGHT once for itself
    nowMs = T0 + 11 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
    nowMs = T0 + 70 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
    nowMs = T0 + 72 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(3);
  });

  it("a question that goes away and comes back wakes again", async () => {
    liveCrew();
    ask();
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    // the seat's run ends: the question no longer counts, and the wake facts are empty
    store.upsertRun(run("r-guido", "guido-1", { endedAt: nowMs, status: "ok" }));
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    store.upsertRun(run("r-guido", "guido-1"));
    nowMs = T0 + FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
  });

  it("holds a second wake until the gap has passed, then sends it without another event", async () => {
    liveCrew();
    raiseBlocked();
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    nowMs = T0 + MIN;
    raiseBlocked("blocked:r1:1", { at: nowMs });
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FLIGHT_MIN_WAKE_GAP_MS - MIN - 1);
    expect(sendCalls).toHaveLength(1);
    nowMs = T0 + FLIGHT_MIN_WAKE_GAP_MS;
    await vi.advanceTimersByTimeAsync(1);
    expect(sendCalls).toHaveLength(2);
  });

  it("measures the gap from the end of FLIGHT's turn, not only from the wake", async () => {
    liveCrew();
    raiseBlocked();
    watch.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendCalls).toHaveLength(1);
    // a turn longer than the gap: its own end must not wake it straight away
    nowMs = T0 + 3 * MIN;
    raiseBlocked("blocked:r1:1", { at: nowMs });
    listener?.({ kind: "idle", seatId: "flight-1", runId: "r-flight", resumed: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(sendCalls).toHaveLength(1);
    nowMs = T0 + 3 * MIN + FLIGHT_MIN_WAKE_GAP_MS;
    await vi.advanceTimersByTimeAsync(FLIGHT_MIN_WAKE_GAP_MS);
    expect(sendCalls).toHaveLength(2);
    watch.stop();
  });

  it("drops a held wake when the watcher stops", async () => {
    liveCrew();
    raiseBlocked();
    await watch.check();
    nowMs = T0 + MIN;
    raiseBlocked("blocked:r1:1", { at: nowMs });
    await watch.check();
    watch.stop();
    nowMs = T0 + FLIGHT_MIN_WAKE_GAP_MS;
    await vi.advanceTimersByTimeAsync(FLIGHT_MIN_WAKE_GAP_MS);
    expect(sendCalls).toHaveLength(1);
  });

  it("does not wake mid-turn", async () => {
    liveCrew();
    ask();
    facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
    await watch.check();
    expect(sendCalls).toEqual([]);
    facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
    await watch.check();
    expect(sendCalls).toHaveLength(1);
  });

  it("re-wakes hourly while something waits, and not otherwise, even with a run live", async () => {
    liveCrew();
    ask();
    await watch.check();
    nowMs = T0 + 11 * MIN;
    await watch.check();
    // the question went stale at 10 minutes: that is its own wake
    expect(sendCalls).toHaveLength(2);
    nowMs = T0 + 70 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
    nowMs = T0 + 72 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(3);
    expect(sendCalls[2]?.key.endsWith(":3")).toBe(true);

    store.answerQuestions("guido-1", nowMs);
    nowMs = T0 + 200 * MIN;
    await watch.check();
    nowMs = T0 + 300 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(3);
  });

  it("a rotation requested before a fresh start needs no second session", async () => {
    watch.rotate();
    await watch.check();
    expect(startCalls).toHaveLength(1);
    facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
    await watch.check();
    expect(endCalls).toEqual([]);
  });

  it("a requested rotation waits for the turn and does not consume a start", async () => {
    liveCrew();
    facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
    watch.rotate();
    await watch.check();
    expect(endCalls).toEqual([]);
    facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
    await watch.check();
    expect(endCalls).toEqual(["r-flight"]);
    await watch.check();
    expect(startCalls).toHaveLength(1);
    startFails = "boom";
    noFlight();
    for (let i = 0; i < 3; i++) await watch.check();
    expect(startCalls).toHaveLength(4);
    expect(notesOpen()).toEqual([]);
    await watch.check();
    expect(notesOpen()).toHaveLength(1);
  });

  describe("a handover at FLIGHT_CONTEXT_ROTATE_TOKENS of context", () => {
    /** A digest whose last assistant turn reports this much context. */
    const context = (tokens: number, runId = "r-flight") => {
      const line = JSON.stringify({
        type: "assistant",
        timestamp: new Date(nowMs).toISOString(),
        message: {
          id: "m1",
          content: [{ type: "text", text: "working" }],
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: tokens - 11_000,
            cache_creation_input_tokens: 10_000,
            output_tokens: 50,
          },
        },
      });
      store.setDigest(runId, foldTranscript(null, [line], nowMs).digest);
    };
    const idle = () =>
      listener?.({ kind: "idle", seatId: "flight-1", runId: "r-flight", resumed: false });

    it("sends one handover wake at 151K, then rotates once that turn ends", async () => {
      liveCrew();
      watch.start();
      context(FLIGHT_CONTEXT_ROTATE_TOKENS + 1000);
      await watch.check();
      expect(sendCalls.map((c) => c.text)).toEqual([FLIGHT_HANDOVER_ASK]);
      expect(endCalls).toEqual([]);

      // its turn is running, then it ends
      facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
      await watch.check();
      facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
      nowMs += MIN;
      idle();
      await watch.check();
      expect(sendCalls.map((c) => c.text)).toEqual([FLIGHT_HANDOVER_ASK]);
      expect(endCalls).toEqual(["r-flight"]);
      await watch.check();
      expect(startCalls).toHaveLength(1);
    });

    it("does nothing at the limit or under it", async () => {
      liveCrew();
      context(FLIGHT_CONTEXT_ROTATE_TOKENS);
      await watch.check();
      await watch.check();
      expect(sendCalls).toEqual([]);
      expect(endCalls).toEqual([]);
    });

    it("rotates at once when the handover for this run was already sent", async () => {
      liveCrew();
      context(FLIGHT_CONTEXT_ROTATE_TOKENS + 1000);
      store.claimLine(handoverKey("r-flight"), {
        runId: "r-flight",
        seatId: "flight-1",
        origin: "engine",
        text: FLIGHT_HANDOVER_ASK,
        at: T0,
      });
      await watch.check();
      // the repeat is refused as a duplicate, and the run is rotated
      expect(sendCalls).toHaveLength(1);
      expect(endCalls).toEqual(["r-flight"]);
    });

    it("gives the next session's start brief the handover and where to read", async () => {
      liveCrew();
      store.putFlightMemory({
        repoId: "mc",
        topic: FLIGHT_HANDOVER_TOPIC,
        kind: "crew",
        body: "Mid-way through #77; promised the operator a PR by noon.",
        source: "flight handover",
        author: "flight",
        updatedAt: T0,
      });
      context(FLIGHT_CONTEXT_ROTATE_TOKENS + 1000);
      store.claimLine(handoverKey("r-flight"), {
        runId: "r-flight",
        seatId: "flight-1",
        origin: "engine",
        text: FLIGHT_HANDOVER_ASK,
        at: T0,
      });
      await watch.check();
      await watch.check();
      expect(startCalls).toHaveLength(1);
      const first = startCalls[0]?.first ?? "";
      expect(first).toContain("Mid-way through #77; promised the operator a PR by noon.");
      expect(first).toContain("flight_state");
      expect(first).toContain("tracked items, plans, memory");
    });

    it("tells the FLIGHT page the context and when the session is renewed", () => {
      liveCrew();
      expect(flightView(config, store, nowMs, () => true).seat?.context).toEqual({
        tokens: null,
        rotateAt: FLIGHT_CONTEXT_ROTATE_TOKENS,
        text: null,
      });
      context(151_000);
      expect(flightView(config, store, nowMs, () => true).seat?.context).toEqual({
        tokens: 151_000,
        rotateAt: FLIGHT_CONTEXT_ROTATE_TOKENS,
        text: "context 151K · fresh session at 150K",
      });
    });
  });

  it("rotates after 40 wakes, and the next start is not counted", async () => {
    liveCrew();
    for (let i = 1; i <= FLIGHT_MAX_WAKES; i++) {
      store.claimLine(`flight:wake:r-flight:${i}`, {
        runId: "r-flight",
        seatId: "flight-1",
        origin: "engine",
        text: "w",
        at: T0,
      });
    }
    ask();
    await watch.check();
    expect(endCalls).toEqual(["r-flight"]);
    expect(sendCalls).toEqual([]);

    await watch.check();
    expect(startCalls).toHaveLength(1);

    startFails = "boom";
    noFlight();
    for (let i = 0; i < 3; i++) await watch.check();
    expect(startCalls).toHaveLength(4);
    expect(notesOpen()).toEqual([]);
    await watch.check();
    expect(startCalls).toHaveLength(4);
    expect(notesOpen()).toHaveLength(1);
  });

  it("rotates a run whose tool set is older than FLIGHT's, and records the set a fresh run starts with", async () => {
    liveCrew();
    ask();
    // no record (a run from before the set was kept): not rotated for it
    await watch.check();
    expect(endCalls).toEqual([]);
    const sent = sendCalls.length;
    // a record for this run from another tool set: rotated at its next idle pass
    store.setSetting(
      FLIGHT_RUN_TOOLS_SETTING,
      JSON.stringify({ runId: "r-flight", tools: "an-older-set" }),
    );
    await watch.check();
    expect(endCalls).toEqual(["r-flight"]);
    expect(sendCalls).toHaveLength(sent);
    // the fresh run is recorded with today's set, so it is not rotated again
    noFlight();
    await watch.check();
    expect(startCalls).toHaveLength(1);
    expect(JSON.parse(store.getSetting(FLIGHT_RUN_TOOLS_SETTING) ?? "{}")).toMatchObject({
      tools: flightToolsDigest(),
    });
  });

  it("debounces checks after attention", async () => {
    watch.start();
    await vi.advanceTimersByTimeAsync(0);
    statusCalls = 0;
    bus.emit("attention");
    await vi.advanceTimersByTimeAsync(2000);
    bus.emit("attention");
    await vi.advanceTimersByTimeAsync(2000);
    bus.emit("attention");
    await vi.advanceTimersByTimeAsync(FLIGHT_DEBOUNCE_MS - 4000 - 1);
    expect(statusCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls).toBe(1);
  });

  it("does nothing when disabled", async () => {
    const off = createFlightWatch({
      config,
      store,
      bus,
      enabled: false,
      now: () => nowMs,
      supervisor: {
        status: () => {
          statusCalls++;
          return { enabled: true, note: null };
        },
        on: () => () => {},
        busy: () => [],
        seatFacts: () => facts,
        startWatch: async (seatId, opts) => {
          startCalls.push({ seatId, first: opts?.first });
          return { runId: "x" };
        },
        send: async () => "sent",
        endRunByEngine: async () => {},
        resumeRun: async () => {},
      },
    });
    await off.check();
    expect(statusCalls).toBe(0);
    expect(startCalls).toEqual([]);
    enabled = false;
    await watch.check();
    expect(startCalls).toEqual([]);
  });

  it("triages another session's question without gaining the power to answer it", async () => {
    const sessions = config.crew?.sessions ?? [];
    sessions.push({
      id: "s2",
      repoId: "mc",
      checkout: "/tmp/none/clone2",
      seats: [seat("guido-9", "GUIDO", { area: ["apps/**"] })],
    });
    try {
      expect(flightOwnSeatIds(config)).toEqual(new Set(["guido-1", "inco-1", "retro-1"]));
      liveCrew();
      facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
      ask("guido-9", "r-guido-9");
      nowMs = T0 + 20 * MIN;
      expect(flightState({ config, store, busy: [], now: nowMs }).questions).toEqual([]);
      await watch.check();
      expect(emitted.filter((t) => t === "attention")).toEqual(["attention"]);
      store.addQuestion({ agentId: "guido-1", runId: "r-guido", text: "Which lane?", at: T0 });
      await watch.check();
      expect(emitted.filter((t) => t === "attention")).toEqual(["attention", "attention"]);
    } finally {
      sessions.pop();
    }
  });

  it("announces a 20-minute question once", async () => {
    liveCrew();
    facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
    ask();
    raiseBlocked();
    nowMs = T0 + 19 * MIN;
    await watch.check();
    expect(emitted.filter((t) => t === "attention")).toEqual([]);
    nowMs = T0 + 20 * MIN;
    await watch.check();
    await watch.check();
    expect(emitted.filter((t) => t === "attention")).toEqual(["attention"]);
  });
});

describe("wakeSummary", () => {
  const s = (over: Partial<FlightSeatState>): FlightSeatState => ({
    id: "guido-1",
    runId: null,
    call: "GUIDO-1",
    role: "GUIDO",
    loop: "build",
    area: [],
    state: null,
    free: false,
    ticket: null,
    title: null,
    phase: null,
    parked: null,
    stalled: false,
    idleMin: null,
    openQuestion: false,
    atStop: false,
    ...over,
  });
  const park = { kind: "silent", reason: "x" };
  const q = {
    id: 1,
    seat: "guido-1",
    ticket: null,
    text: "t",
    ageMin: 0,
    triageRemainingMs: 20 * MIN,
  };
  const pr = {
    ref: "mc#1",
    pr: 1,
    seat: "guido-1",
    runId: "r-1",
    ready: false,
    state: "open" as const,
    headSha: null,
    readAt: "12:00",
    stale: false,
    review: null,
    failingChecks: [],
  };
  const state = (over: Partial<FlightState>): FlightState => ({
    signals: [],
    triage: [],
    time: "12:00",
    repo: "mc",
    lane: null,
    hubLogin: null,
    seats: [],
    aside: [],
    questions: [],
    tickets: [],
    prs: [],
    items: [],
    holds: [],
    recent: [],
    limits: { startsLeft: 4, messagesLeft: 30 },
    brief: [],
    headlineAgeMin: null,
    headline: "",
    ledger: [],
    ledgerMore: 0,
    ...over,
  });

  it("counts the items to brief", () => {
    const item = {
      key: "a",
      kind: "blocked" as const,
      ticket: null,
      text: "t",
      ageMin: 0,
      triageRemainingMs: 20 * MIN,
    };
    expect(wakeSummary(state({ items: [item] }))).toBe("1 item to brief");
    expect(wakeSummary(state({ items: [item, { ...item, key: "b" }] }))).toBe("2 items to brief");
  });

  it("says nothing new, then each part with its singular", () => {
    expect(wakeSummary(state({}))).toBe("nothing new");
    expect(wakeSummary(state({ prs: [pr, { ...pr, pr: 2, state: "merged" }] }))).toBe(
      "1 PR in review",
    );
    expect(
      wakeSummary(
        state({
          questions: [q],
          seats: [s({ free: true }), s({ id: "r", parked: park })],
          prs: [pr],
        }),
      ),
    ).toBe("1 question · 1 free seat · 1 parked · 1 PR in review");
    expect(
      wakeSummary(
        state({
          questions: [q, { ...q, id: 2 }],
          seats: [
            s({ free: true }),
            s({ id: "b", free: true }),
            s({ id: "c", parked: park }),
            s({ id: "d", parked: park }),
          ],
          prs: [pr, { ...pr, pr: 2 }],
        }),
      ),
    ).toBe("2 questions · 2 free seats · 2 parked · 2 PRs in review");
  });

  it("does not count a free review seat", () => {
    expect(wakeSummary(state({ seats: [s({ loop: "review", free: true })] }))).toBe("nothing new");
  });

  describe("pending", () => {
    const ticket = {
      ref: "mc#1",
      title: "t",
      column: "Ready" as const,
      priority: null,
      labels: [],
      ready: true,
      blockedBy: [],
      laneLabel: null,
      assignees: [],
    };
    it("an awaiting-flight head is a wake fact and remains pending", () => {
      const before = state({ prs: [pr] });
      const held = state({ prs: [{ ...pr, awaitingFlight: "head" }] });
      expect(wakeFacts(held)).not.toBe(wakeFacts(before));
      expect(pending(held)).toBe(true);
      expect(pending(before)).toBe(false);
    });

    it("is true for a question, a free build seat with a ticket, or a park FLIGHT can lift", () => {
      expect(pending(state({ questions: [q] }))).toBe(true);
      expect(pending(state({ seats: [s({ free: true })], tickets: [ticket] }))).toBe(true);
      expect(
        pending(state({ seats: [s({ parked: { kind: FLIGHT_UNPARK_KINDS[0], reason: "x" } })] })),
      ).toBe(true);
    });

    it("is true for a stopped build seat even with no ticket, and the summary counts it", () => {
      const stopped = state({ seats: [s({ state: "stopped", free: true })] });
      expect(pending(stopped)).toBe(true);
      expect(wakeSummary(stopped)).toBe("1 free seat · 1 stopped");
      // a PR merging is a routine step: in the digest, not a wake fact
      expect(wakeFacts(state({ prs: [{ ...pr, state: "merged" }] }))).toBe(
        wakeFacts(state({ prs: [pr] })),
      );
      expect(wakeFacts(state({ prs: [{ ...pr, awaitingFlight: "sha" }] }))).not.toBe(
        wakeFacts(state({ prs: [pr] })),
      );
      expect(wakeFacts(stopped)).not.toBe(wakeFacts(state({ seats: [s({ free: true })] })));
    });

    it("raises the idle-reviewers fact only once a queued review has waited 10 minutes", () => {
      const queue = (queued: number, waitMin: number) =>
        state({
          reviewQueue: {
            queued,
            running: 0,
            waitMin,
            seats: [{ seat: "retro-1", queued, running: 0, idle: true }],
          },
        });
      expect(wakeFacts(queue(1, 9))).toBe(wakeFacts(queue(0, 0)));
      expect(wakeFacts(queue(1, 10))).not.toBe(wakeFacts(queue(0, 0)));
    });

    it("ignores a free seat next to tickets that are not ready, until one is", () => {
      const seats = [s({ free: true }), s({ id: "b", free: true })];
      const notReady = { ...ticket, ref: "mc#2", column: "Backlog" as const, ready: false };
      const idle = state({ seats, tickets: [notReady] });
      expect(pending(idle)).toBe(false);
      expect(wakeFacts(idle)).toBe(wakeFacts(state({ seats })));
      const woken = state({ seats, tickets: [notReady, ticket] });
      expect(pending(woken)).toBe(true);
      expect(wakeFacts(woken)).not.toBe(wakeFacts(idle));
      expect(wakeFacts(woken)).toBe(wakeFacts(state({ seats, tickets: [ticket] })));
    });

    it("is false for a park that is the operator's, a free seat with no ticket, or nothing", () => {
      expect(pending(state({ seats: [s({ parked: { kind: "operator", reason: "x" } })] }))).toBe(
        false,
      );
      expect(pending(state({ seats: [s({ free: true })] }))).toBe(false);
      expect(pending(state({}))).toBe(false);
    });

    it("is true for a ruling park, which FLIGHT settles, and false for a budget park", () => {
      expect(pending(state({ seats: [s({ parked: { kind: "ruling", reason: "r" } })] }))).toBe(
        true,
      );
      expect(pending(state({ seats: [s({ parked: { kind: "budget", reason: "r" } })] }))).toBe(
        false,
      );
    });

    it("counts a parked set-aside run, in pending and in wakeFacts", () => {
      const aside = {
        runId: "r1",
        seat: "guido-1",
        ticket: "#1",
        phase: "parked" as const,
        parked: { kind: "ruling", reason: "r" },
      };
      expect(pending(state({ aside: [aside] }))).toBe(true);
      const unparked = state({ aside: [{ ...aside, parked: null }] });
      expect(pending(unparked)).toBe(false);
      expect(wakeFacts(state({ aside: [aside] }))).not.toBe(wakeFacts(unparked));
    });
  });
});

describe("ownReply", () => {
  it("leaves FLIGHT's own direct-line reply out of its digest and keeps another seat's", () => {
    expect(ownReply({ kind: "message", agentId: "flight-1" }, "flight-1")).toBe(true);
    expect(ownReply({ kind: "message", agentId: "guido-1" }, "flight-1")).toBe(false);
    expect(ownReply({ kind: "tag", agentId: "flight-1" }, "flight-1")).toBe(true);
    expect(ownReply({ kind: "question", agentId: "flight-1" }, "flight-1")).toBe(false);
    expect(ownReply({ kind: "message", agentId: "flight-1" }, null)).toBe(false);
  });
});

const triageCard = (over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: "mc",
  issueNumber: 176,
  title: "Ops signals",
  status: "Backlog",
  state: "planned",
  labels: [],
  priority: null,
  prioritySource: null,
  updatedAt: T0,
  createdAt: T0,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: null,
  closed: false,
  itemId: "I176",
  projectId: "P1",
  ...over,
});
const signalState = () => flightState({ config, store, busy: [], now: nowMs });
const observeCheck = (
  sha: string,
  state: "failing" | "passing" | "pending",
  attempt = 1,
  runId = 1,
) => {
  observeFlightChecks(
    store,
    "mc",
    [
      stored(7, {
        headSha: sha,
        checks: [
          {
            name: "unit (linux)",
            workflow: "keeper",
            kind: "check",
            state,
            conclusion: state,
            attempt,
            url: `https://github.com/o/mc/actions/runs/${runId}/job/7`,
          },
        ],
      }),
    ],
    nowMs,
  );
};
const flake = (sha: string) => {
  observeCheck(sha, "failing");
  observeCheck(sha, "pending", 2);
  observeCheck(sha, "passing", 2);
};

describe("ops signals", () => {
  beforeEach(() => {
    signalState();
  });
  const setup = {
    flaky_test() {
      flake("head-a");
      flake("head-b");
    },
    repeat_park() {
      store.replaceBoard("mc", [triageCard({ status: "Ready" })]);
      store.upsertRun(run("r-build", "guido-1", { ticket: "mc#176" }));
      store.addLoopEvent("park-1", "r-build", "parked: push stuck", T0 - MIN);
      store.addLoopEvent("park-2", "r-build", "parked: push stuck", T0);
    },
    main_red() {
      store.setSetting(
        `${FLIGHT_MAIN_SETTING}:mc`,
        JSON.stringify({ sha: "main-sha", ci: "failing", at: T0 }),
      );
    },
    idle_seat() {
      store.setSeatSession({ ...row("guido-1", null), updatedAt: T0 - FLIGHT_IDLE_MS });
      store.replaceBoard("mc", [triageCard({ status: "Ready" })]);
      store.replaceQueue("guido-1", [{ repoId: "mc", issue: 176 }]);
    },
    old_park() {
      store.replaceBoard("mc", [triageCard({ status: "Ready" })]);
      store.upsertRun(run("r-park", "guido-1", { ticket: "mc#176" }));
      store.setRunLoop("r-park", {
        ...NEW_LOOP,
        phase: "parked",
        parked: { kind: "push", reason: "push stuck", ended: false },
      });
      store.setSeatSession(row("guido-1", "r-park", "parked"));
      store.addLoopEvent("park-old", "r-park", "parked: push stuck", T0 - 16 * MIN);
    },
    merge_stalled() {
      store.upsertRun(run("r-ready", "guido-1", { ticket: "mc#176" }));
      store.setRunLoop("r-ready", { ...NEW_LOOP, prNumber: 7 });
      store.setSeatSession(row("guido-1", "r-ready"));
      store.upsertPullRequests("mc", [stored(7, { ticket: "mc#176", isDraft: false })], T0);
      store.raiseNote({
        key: "ready:r-ready",
        kind: "ready",
        runId: "r-ready",
        seatId: "guido-1",
        repoId: "mc",
        text: "mc#176 is ready to merge",
        at: T0 - 11 * MIN,
      });
    },
    item_stale() {
      store.raiseNote({
        key: "blocked:r1:0",
        kind: "blocked",
        runId: null,
        seatId: "guido-1",
        repoId: "mc",
        text: "mc#7 parked",
        at: T0 - 11 * MIN,
      });
    },
    run_no_pr() {
      store.upsertRun(
        run("r-nopr", "guido-1", {
          ticket: "mc#176",
          endedAt: T0 - MIN,
          endedBy: "exit",
          status: "failed",
        }),
      );
    },
    controller_unanswered() {
      store.addFlightDecision({
        at: T0 - 16 * MIN,
        kind: "note",
        seatId: null,
        targetRunId: null,
        ref: null,
        questionId: null,
        about: `${FOR_THE_CONTROLLER} approve the budget change`,
        decision: "asked",
        basis: "b",
      });
    },
    wait_over() {
      recordFlightWait(store, "mc#9", { on: "PR 7 merging", until: T0 - MIN, at: T0 - 30 * MIN });
    },
    seat_call() {
      recordSeatCall(store, "mc", {
        seat: "guido-1",
        reason: "blocked on a change outside my area",
        ref: "mc#7",
        at: T0,
      });
    },
    github_budget() {
      store.setSetting(
        GITHUB_RATE_SETTING,
        JSON.stringify({
          queries: {
            PullRequests: { cost: 1, limit: 5000, remaining: 1249, resetAt: T0 + 60 * MIN, at: T0 },
          },
          pollCost: 1,
        }),
      );
    },
    hub_error() {
      flightLoopHeartbeat(store, "engine", T0 - 3 * MIN, MIN);
      flightLoopHeartbeat(store, "sessions", T0, MIN);
    },
  };

  it.each(Object.keys(setup) as (keyof typeof setup)[])(
    "delivers %s once per key, including across a hub restart",
    async (kind) => {
      live("flight-1", "r-flight");
      facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
      setup[kind]();
      expect(signalState().signals.map((s) => s.kind)).toContain(kind);
      await watch.check();
      const digest = JSON.parse(sendCalls[0]?.text.split("\n").at(-1) ?? "{}");
      expect(digest.signals.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind, evidence: expect.any(String) })]),
      );
      expect(sendCalls[0]?.text.split("\n")[0]).toContain("woke on: signals");
      expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
      nowMs += FLIGHT_MIN_WAKE_GAP_MS;
      await watch.check();
      expect(sendCalls).toHaveLength(1);
      watch.stop();
      store.close();
      store = new Store(join(dir, "mc.sqlite"));
      store.setSetting(
        `${FLIGHT_RETROSPECTIVE_SETTING}:mc`,
        JSON.stringify({ day: "2026-10-22", told: true }),
      );
      makeWatch();
      expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
      await watch.check();
      expect(
        sendCalls
          .flatMap((c) => JSON.parse(c.text.split("\n").at(-1) ?? "{}").signals.entries)
          .filter((s: { told?: boolean }) => !s.told),
      ).toHaveLength(1);
    },
  );

  it("needs two fail-then-pass cases within seven days, never just two failures or a new head", () => {
    observeCheck("head-a", "failing");
    observeCheck("head-a", "failing");
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    observeCheck("head-b", "passing", 2);
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    flake("head-c");
    observeCheck("head-c", "passing", 2);
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    flake("head-d");
    expect(signalState().signals).toEqual([
      expect.objectContaining({ kind: "flaky_test", key: "mc:keeper/unit (linux)" }),
    ]);
  });

  it("delivers red main already present on the first run", async () => {
    liveCrew();
    store.setSetting(`${FLIGHT_SIGNALS_SETTING}:mc`, "");
    observeFlightMain(store, "mc", { sha: "first-red", ci: "failing", at: nowMs });
    await watch.check();
    const digest = JSON.parse(sendCalls[0]?.text.split("\n").at(-1) ?? "{}");
    expect(digest.signals.entries).toContainEqual(
      expect.objectContaining({
        kind: "main_red",
        key: "first-red",
        told: false,
      }),
    );
    expect(signalState().signals[0]?.told).toBe(true);
  });

  it.each(["main_red", "github_budget", "idle_seat", "hub_error"] as const)(
    "leaves live %s untold during first-run seeding",
    (kind) => {
      store.setSetting(`${FLIGHT_SIGNALS_SETTING}:mc`, "");
      setup[kind]();
      expect(signalState().signals).toContainEqual(expect.objectContaining({ kind, told: false }));
    },
  );

  it("seeds historical flakes and missing reports but leaves watch errors untold", () => {
    setup.flaky_test();
    store.upsertRun(
      run("old-report", "guido-1", {
        ticket: "mc#176",
        loop: { ...NEW_LOOP },
        endedAt: T0,
        endedBy: "engine",
        status: "failed",
      }),
    );
    store.setSeatSession({ ...row("flight-1", null, "error"), reason: "resume failed" });
    const saved = JSON.parse(store.getSetting(`${FLIGHT_SIGNALS_SETTING}:mc`) ?? "{}");
    store.setSetting(
      `${FLIGHT_SIGNALS_SETTING}:mc`,
      JSON.stringify({ ...saved, initialized: false }),
    );
    expect(signalState().signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "flaky_test", told: true }),
        expect.objectContaining({ key: "report:old-report", told: true }),
        expect.objectContaining({ key: `watch:flight-1:${T0}`, told: false }),
      ]),
    );
  });

  it.each(["checks", "notes"])(
    "tracks flaky jobs separately within one workflow using %s",
    (source) => {
      for (const n of [1, 2]) {
        const sha = `head-${n}`;
        const observe = (passing: boolean) =>
          observeFlightChecks(
            store,
            "mc",
            [
              stored(7, {
                headSha: sha,
                checks: ["unit", "integration", "healthy"].map((name, job) => ({
                  name,
                  workflow: "CI",
                  kind: "check",
                  state: passing || name === "healthy" ? "passing" : "failing",
                  conclusion: passing || name === "healthy" ? "success" : "failure",
                  attempt: passing ? 2 : 1,
                  url: `https://github.com/o/mc/actions/runs/${n}/job/${job}`,
                })),
              }),
            ],
            nowMs,
          );
        observe(false);
        if (source === "checks") observe(true);
        const runId = `flake-${n}`;
        store.upsertRun(
          run(runId, "guido-1", {
            loop: {
              ...NEW_LOOP,
              rerun: { sha, at: T0, runs: [{ id: n, name: "CI" }], flaked: true },
            },
          }),
        );
        store.raiseNote({
          key: `flake:${runId}:${sha}`,
          kind: "flag",
          repoId: "mc",
          seatId: "guido-1",
          runId,
          text: `CI failed on ${sha} then passed`,
          at: nowMs,
        });
        if (n === 1) expect(signalState().signals).toEqual([]);
      }
      expect(
        signalState()
          .signals.map((s) => s.key)
          .sort(),
      ).toEqual(["mc:CI/integration", "mc:CI/unit"]);
      const saved = JSON.parse(store.getSetting(`${FLIGHT_SIGNALS_SETTING}:mc`) ?? "{}");
      expect(Object.values(saved.flakes)).toHaveLength(4);
    },
  );

  it("counts two distinct re-run attempts on the same head", () => {
    flake("head-a");
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    observeCheck("head-a", "failing", 3);
    observeCheck("head-a", "passing", 4);
    expect(signalState().signals[0]?.kind).toBe("flaky_test");
  });

  it("reads flake records and does not count a check observation of the same flake twice", () => {
    const note = (sha: string, n: number) => {
      const id = `flake-run-${n}`;
      store.upsertRun(
        run(id, "guido-1", {
          loop: {
            ...NEW_LOOP,
            rerun: { sha, at: T0, runs: [{ id: n, name: "keeper" }], flaked: true },
          },
        }),
      );
      store.raiseNote({
        key: `flake:${id}:${sha}`,
        kind: "flag",
        repoId: "mc",
        seatId: "guido-1",
        runId: id,
        text: `keeper failed on ${sha} then passed`,
        at: T0,
      });
    };
    flake("head-a");
    note("head-a", 1);
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    observeCheck("head-b", "failing", 1, 2);
    note("head-b", 2);
    expect(signalState().signals[0]).toMatchObject({
      kind: "flaky_test",
      evidence: expect.stringContaining("head-b"),
    });
  });

  it("prunes fired keys and old flake cases after seven days", () => {
    flake("old-head");
    setup.main_red();
    const state = signalState();
    markFlightSignalsShown(store, state, nowMs);
    nowMs += FLIGHT_SIGNAL_KEEP_MS + 1;
    flake("new-head");
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    const saved = JSON.parse(store.getSetting(`${FLIGHT_SIGNALS_SETTING}:mc`) ?? "{}");
    expect(Object.values(saved.signals)).toHaveLength(1); // Main is still red and remains told.
    expect(Object.values(saved.flakes)).toHaveLength(1);
  });

  it("does not spend a signal on a failed delivery", async () => {
    liveCrew();
    setup.main_red();
    sendFails = true;
    await watch.check();
    expect(signalState().signals).toHaveLength(1);
    sendFails = false;
    await watch.check();
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    expect(sendCalls).toHaveLength(2);
  });

  it("retains a fired key for seven days from delivery, not from the fault's onset", () => {
    store.setSetting(
      `${FLIGHT_MAIN_SETTING}:mc`,
      JSON.stringify({ sha: "old-fault", ci: "failing", at: T0 - 6 * 24 * 60 * MIN }),
    );
    markFlightSignalsShown(store, signalState(), nowMs);
    nowMs += 2 * 24 * 60 * MIN;
    store.setSetting(
      `${FLIGHT_MAIN_SETTING}:mc`,
      JSON.stringify({ sha: "old-fault", ci: "failing", at: nowMs }),
    );
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
  });

  it("keeps the first red SHA until green resets the episode, including null rollups", () => {
    observeFlightMain(store, "mc", { sha: "first-red", ci: "failing", at: nowMs });
    expect(signalState().signals[0]).toMatchObject({ key: "first-red", told: false });
    markFlightSignalsShown(store, signalState(), nowMs);
    observeFlightMain(store, "mc", { sha: "second-red", ci: "failing", at: ++nowMs });
    expect(signalState().signals).toEqual([
      expect.objectContaining({
        key: "first-red",
        told: true,
        evidence: expect.stringContaining("second-red"),
      }),
    ]);
    expect(JSON.parse(wakeFacts(signalState())).signals).toEqual([]);
    observeFlightMain(store, "mc", { sha: "pending", ci: null, at: ++nowMs });
    observeFlightMain(store, "mc", { sha: "third-red", ci: "failing", at: ++nowMs });
    expect(signalState().signals[0]).toMatchObject({ key: "first-red", told: true });
    observeFlightMain(store, "mc", { sha: "green", ci: "passing", at: ++nowMs });
    expect(signalState().signals).toEqual([]);
    observeFlightMain(store, "mc", { sha: "next-red", ci: "failing", at: ++nowMs });
    expect(signalState().signals[0]).toMatchObject({ key: "next-red", told: false });
  });

  it("retains a collected main failure that recovers before FLIGHT reads it", () => {
    observeFlightMain(store, "mc", { sha: "main-sha", ci: "failing", at: T0 });
    observeFlightMain(store, "mc", { sha: "main-sha", ci: "passing", at: T0 + 1 });
    nowMs++;
    expect(signalState().signals).toEqual([
      expect.objectContaining({ kind: "main_red", key: "main-sha", since: T0, told: false }),
    ]);
    markFlightSignalsShown(store, signalState(), nowMs);
    expect(signalState().signals).toEqual([]);
    observeFlightMain(store, "mc", { sha: "main-sha", ci: "failing", at: ++nowMs });
    expect(signalState().signals[0]).toMatchObject({ key: "main-sha", told: false });
  });

  it("prefers the first red merge SHA over newer merges and names both episode SHAs", () => {
    store.upsertPullRequests(
      "mc",
      [
        stored(7, { state: "merged", mergedAt: T0, mergeCommitSha: "first-red" }),
        stored(8, { state: "merged", mergedAt: T0 + MIN, mergeCommitSha: "latest-red" }),
      ],
      T0,
    );
    observeFlightMain(store, "mc", { sha: "first-red", ci: "failing", at: nowMs, committedAt: T0 });
    observeFlightMain(store, "mc", {
      sha: "latest-red",
      ci: "failing",
      at: ++nowMs,
      committedAt: T0 + MIN,
    });
    const evidence = signalState().signals[0]?.evidence;
    expect(evidence).toContain("first red SHA first-red");
    expect(evidence).toContain("latest SHA latest-red");
    expect(evidence).toContain("episode merge: #7");
    expect(evidence).not.toContain("#8");
  });

  it.each([0, 5_000, 5_001])(
    "uses a five-second fallback tolerance for merge time +%i",
    (offset) => {
      store.upsertPullRequests(
        "mc",
        [
          stored(7, { state: "merged", mergedAt: T0 - MIN }),
          stored(8, { state: "merged", mergedAt: T0 + offset }),
        ],
        T0,
      );
      observeFlightMain(store, "mc", { sha: "red", ci: "failing", at: nowMs, committedAt: T0 });
      expect(signalState().signals[0]?.evidence).toContain(offset <= 5_000 ? ": #8" : ": #7");
    },
  );

  it("keeps distinct park reasons and tickets separate", () => {
    store.replaceBoard("mc", [
      triageCard({ issueNumber: 1, status: "Ready" }),
      triageCard({ issueNumber: 2, status: "Ready" }),
    ]);
    store.upsertRun(
      run("r1", "guido-1", {
        ticket: "mc#1",
        loop: {
          ...NEW_LOOP,
          phase: "parked",
          parked: { kind: "push", reason: "push stuck", ended: false },
        },
      }),
    );
    store.upsertRun(run("r2", "inco-1", { ticket: "mc#2" }));
    store.addLoopEvent("p1", "r1", "parked: push stuck", T0);
    store.addLoopEvent("p2", "r2", "parked: push stuck", T0);
    store.addLoopEvent("p3", "r1", "parked: no report", T0);
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    store.addLoopEvent("p4", "r1", "parked: push stuck", T0);
    expect(signalState().signals[0]?.key).toBe("mc#1:push stuck");
  });

  it("requires fifteen idle minutes and eligible queued work", () => {
    setup.idle_seat();
    nowMs = T0 - 1;
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    nowMs = T0;
    store.replaceBoard("mc", [
      triageCard({ status: "Ready", blockedBy: [{ ref: "mc#1", closed: false }] }),
    ]);
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    store.replaceBoard("mc", [triageCard({ status: "Ready" })]);
    expect(signalState().signals[0]?.kind).toBe("idle_seat");
  });

  it("does not count a previous run's last turn as time idle after the seat is freed", () => {
    setup.idle_seat();
    store.setSeatTurnEnded("guido-1", T0 - 30 * MIN);
    store.setSeatSession({ ...row("guido-1", null), updatedAt: T0 });
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
  });

  it("checks every token reading with a strict 25% threshold, once per reset", () => {
    const rate = (remaining: number, resetAt: number) =>
      store.setSetting(
        GITHUB_RATE_SETTING,
        JSON.stringify({
          queries: {
            old: { limit: 5000, remaining: 0, at: T0 - 1, resetAt: T0 },
            new: { limit: 5000, remaining, at: T0, resetAt },
          },
          pollCost: 1,
        }),
      );
    rate(1250, T0 + 60 * MIN);
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    rate(1249, T0 + 60 * MIN);
    markFlightSignalsShown(store, signalState(), nowMs);
    rate(0, T0 + 60 * MIN);
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    rate(1249, T0 + 120 * MIN);
    expect(signalState().signals[0]?.kind).toBe("github_budget");
  });

  it("reports watch failures, missing run reports and silent hub loops by source", () => {
    store.setSeatSession({
      ...row("flight-1", "watch-failed", "error"),
      reason: "failed to resume session",
    });
    store.upsertRun(
      run("no-report", "guido-1", {
        ticket: "mc#176",
        loop: { ...NEW_LOOP },
        endedAt: T0,
        endedBy: "engine",
        status: "failed",
      }),
    );
    store.upsertRun(run("reported", "inco-1", { endedAt: T0, endedBy: "engine", status: "ok" }));
    store.setRunEnded("no-report", T0, "failed", "engine");
    store.setRunEnded("reported", T0, "ok", "engine");
    store.addEvidence("reported", "Done", T0);
    flightLoopHeartbeat(store, "engine", T0 - 3 * MIN, MIN);
    flightLoopHeartbeat(store, "sessions", T0, MIN);

    expect(
      signalState()
        .signals.map((s) => s.key)
        .sort(),
    ).toEqual([`loop:engine:${T0 - 3 * MIN}`, "report:no-report", `watch:flight-1:${T0}`]);
    markFlightSignalsShown(store, signalState(), nowMs);
    expect(signalState().signals.filter((s) => !s.told)).toEqual([]);
    expect(store.getSetting(FLIGHT_LOOPS_SETTING)).toContain("sessions");
  });
});

describe("triage and quiet wakes", () => {
  beforeEach(() => {
    signalState();
  });
  it("wakes once for a new Backlog ticket with Ready empty, also across restart", async () => {
    flightOnly();
    store.replaceBoard("mc", [triageCard()]);
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text.split("\n")[0]).toContain("woke on: triage");
    expect(signalState().triage).toEqual([]);
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    watch.stop();
    store.close();
    store = new Store(join(dir, "mc.sqlite"));
    store.setSetting(
      `${FLIGHT_RETROSPECTIVE_SETTING}:mc`,
      JSON.stringify({ day: "2026-10-22", told: true }),
    );
    makeWatch();
    await watch.check();
    expect(sendCalls).toHaveLength(1);
  });

  it("keeps new, finished plan and resolved dependency causes separate per ticket", () => {
    const card = triageCard({ status: "Refinement", blockedBy: [{ ref: "mc#1", closed: false }] });
    store.replaceBoard("mc", [card]);
    const initial = signalState();
    expect(initial.triage[0]?.cause).toBe("new");
    markFlightSignalsShown(store, initial, nowMs);
    store.upsertRun(run("planner", "guido-1", { ticket: "mc#176" }));
    store.addLoopEvent("planner:plan", "planner", "Plan written for mc#176", T0);
    store.replaceBoard("mc", [{ ...card, blockedBy: [{ ref: "mc#1", closed: true }] }]);
    const next = signalState();
    expect(next.triage.map((t) => t.cause).sort()).toEqual(["dependency", "plan"]);
    markFlightSignalsShown(store, next, nowMs);
    expect(signalState().triage).toEqual([]);
  });

  it("wakes FLIGHT once when a chain of waiting tickets has stood still for 30 minutes", async () => {
    liveCrew();
    const root = triageCard({ issueNumber: 1, status: "In progress", state: "in progress" });
    const mid = triageCard({
      issueNumber: 2,
      status: "Blocked",
      state: "blocked",
      after: { issues: [1], prs: [] },
    });
    const top = triageCard({
      issueNumber: 3,
      status: "Blocked",
      state: "blocked",
      after: { issues: [2], prs: [] },
    });
    store.replaceBoard("mc", [root, mid, top]);
    const stalled = () => signalState().signals.filter((x) => x.kind === "chain_stalled");
    expect(stalled()).toEqual([]);
    nowMs += 29 * MIN;
    expect(stalled()).toEqual([]);
    nowMs += MIN;
    const found = stalled();
    // one signal for the whole chain, not one for each ticket in it
    expect(found.map((x) => x.key)).toEqual(["mc#3>mc#2>mc#1"]);
    expect(found[0]?.evidence).toContain("30 min");
    markFlightSignalsShown(store, signalState(), nowMs);
    expect(stalled().filter((x) => !x.told)).toEqual([]);
  });

  it("drops a stalled chain that ended before FLIGHT was told", () => {
    liveCrew();
    const waiting = triageCard({
      issueNumber: 2,
      status: "Blocked",
      state: "blocked",
      after: { issues: [1], prs: [] },
    });
    const root = triageCard({ issueNumber: 1, status: "In progress", state: "in progress" });
    store.replaceBoard("mc", [root, waiting]);
    signalState();
    nowMs += 31 * MIN;
    expect(signalState().signals.filter((x) => x.kind === "chain_stalled")).toHaveLength(1);
    store.replaceBoard("mc", [{ ...root, status: "Done", state: "done", closed: true }, waiting]);
    store.upsertPullRequests(
      "mc",
      [stored(7, { ticket: "mc#1", closingIssues: [1], state: "merged", mergedAt: nowMs })],
      nowMs,
    );
    expect(signalState().signals.filter((x) => x.kind === "chain_stalled")).toEqual([]);
  });

  it("keeps the stored PR list and wake facts stable on a phase-only move and metadata timestamp change", () => {
    liveCrew();
    const build = run("r-guido", "guido-1", {
      ticket: "mc#176",
      loop: { ...NEW_LOOP, phase: "ci", prNumber: 7 },
    });
    store.upsertRun(build);
    store.setRunLoop(build.id, build.loop ?? null);
    store.upsertPullRequests("mc", [stored(7)], T0);
    const before = signalState();
    store.setRunLoop(build.id, {
      ...NEW_LOOP,
      prNumber: 7,
      phase: "review",
      aside: { worktree: "/tmp/aside", wake: false },
    });
    store.upsertPullRequests("mc", [stored(7, { updatedAt: T0 + MIN })], T0 + MIN);
    const after = signalState();
    expect(after.prs.map(({ readAt: _readAt, ...pr }) => pr)).toEqual(
      before.prs.map(({ readAt: _readAt, ...pr }) => pr),
    );
    expect(wakeFacts(after)).toBe(wakeFacts(before));
    expect(deliveredFacts(after)).toBe(deliveredFacts(before));
  });

  it("ignores PR attention timestamps but wakes on a different action", () => {
    store.replaceBoard("mc", [triageCard()]);
    store.upsertPullRequests(
      "mc",
      [stored(7, { ticket: "mc#176", isDraft: false, updatedAt: T0 - 120 * MIN })],
      T0,
    );
    const before = signalState();
    store.upsertPullRequests(
      "mc",
      [stored(7, { ticket: "mc#176", isDraft: false, updatedAt: T0 - 60 * MIN })],
      T0,
    );
    expect(wakeFacts(signalState())).toBe(wakeFacts(before));
    store.upsertPullRequests(
      "mc",
      [
        stored(7, {
          ticket: "mc#176",
          isDraft: false,
          updatedAt: T0 - 60 * MIN,
          review: "approved",
        }),
      ],
      T0,
    );
    expect(wakeFacts(signalState())).not.toBe(wakeFacts(before));
  });

  it("only wakes for a stream question, whose key survives later progress messages", () => {
    liveCrew();
    const path = join(dir, "guido.jsonl");
    store.upsertRun(run("r-guido", "guido-1", { transcriptPath: path }));
    store.addComms({
      from: COMMS_CAPCOM,
      to: "guido-1",
      text: "How is it going?",
      ticket: null,
      at: T0 - MIN,
    });
    const messages = (texts: string[]) =>
      writeFileSync(
        path,
        `${texts
          .map((text, n) =>
            JSON.stringify({
              type: "assistant",
              timestamp: new Date(T0 + n).toISOString(),
              message: { content: [{ type: "text", text }] },
            }),
          )
          .join("\n")}\n`,
      );
    messages(["Tests are running. https://example.test/?q=1 `?`"]);
    expect(signalState().items).toEqual([]);
    // narration on the direct line is no item at all: its unread count lives on the Comms thread
    expect(attentionItems(config, store, nowMs).find((i) => i.kind === "message")).toBeUndefined();
    messages(["Tests are running.", "Please confirm the target branch."]);
    const question = signalState();
    const hudQuestion = attentionItems(config, store, nowMs).find((i) => i.kind === "message");
    expect(hudQuestion).toMatchObject({ owner: "flight", flightTriage: "waiting" });
    expect(question.items).toHaveLength(1);
    expect(question.items[0]?.text).toBe("Please confirm the target branch.");
    messages(["Tests are running.", "Please confirm the target branch.", "Still waiting."]);
    expect(signalState().items[0]?.key).toBe(question.items[0]?.key);
    expect(signalState().items[0]).not.toHaveProperty("wakeKey");
    expect(question.items[0]).not.toHaveProperty("wakeKey");
    expect(wakeFacts(signalState())).toBe(wakeFacts(question));
    store.addBrief({
      key: question.items[0]?.key ?? "",
      context: "Checking branch",
      recommendation: "I will handle it",
      options: [],
      basis: "question",
      at: T0 + 2,
      for: "flight",
    });
    expect(attentionItems(config, store, nowMs).find((i) => i.kind === "message")).toMatchObject({
      key: question.items[0]?.key,
      owner: "flight",
      flightTriage: "handling",
      brief: { context: "Checking branch" },
    });
  });
});

describe("ops review regressions", () => {
  beforeEach(() => {
    signalState();
  });

  it("groups budget parks by their ceiling, not the tokens each one used", () => {
    store.replaceBoard("mc", [triageCard({ status: "Ready" })]);
    for (const [id, used] of [
      ["budget-a", 1001],
      ["budget-b", 1043],
    ]) {
      const reason = `used ${used} input + output tokens of a 1000-token budget`;
      store.upsertRun(
        run(id as string, "guido-1", {
          ticket: "mc#176",
          loop: { ...NEW_LOOP, phase: "parked", parked: { kind: "budget", reason, ended: false } },
        }),
      );
      store.addLoopEvent(`${id}:park`, id as string, `parked: ${reason}`, T0);
    }
    expect(signalState().signals).toEqual([
      expect.objectContaining({
        kind: "repeat_park",
        key: "mc#176:used <n> input + output tokens of a 1000-token budget",
      }),
    ]);
  });

  it("normalizes SHA evidence and keys repeated parks by ticket and reason, excluding closed and absent tickets", () => {
    store.replaceBoard("mc", [triageCard({ status: "Ready" })]);
    for (const [id, sha] of [
      ["push-a", "abcdef123"],
      ["push-b", "fedcba321"],
    ]) {
      const reason = `CI pending for 20 minutes on ${sha}`;
      store.upsertRun(
        run(id as string, "guido-1", {
          ticket: "mc#176",
          loop: {
            ...NEW_LOOP,
            phase: "parked",
            parked: { kind: "ci-pending", reason, ended: false },
          },
        }),
      );
      store.addLoopEvent(`${id}:park`, id as string, `parked: ${reason}`, T0);
    }
    const current = signalState();
    expect(current.signals).toEqual([
      expect.objectContaining({
        kind: "repeat_park",
        key: "mc#176:CI pending for 20 minutes on <sha>",
        told: false,
        evidence: expect.stringContaining("<sha>"),
      }),
    ]);
    expect(current.signals[0]?.evidence).not.toMatch(/abcdef123|fedcba321/);
    markFlightSignalsShown(store, current, nowMs);
    store.setRunLoop("push-a", {
      ...NEW_LOOP,
      phase: "parked",
      parked: { kind: "push", reason: "push stuck", ended: false },
    });
    expect(signalState().signals).toHaveLength(1);
    expect(signalState().signals[0]?.key).toBe(current.signals[0]?.key);
    expect(signalState().signals[0]?.told).toBe(true);
    expect(JSON.parse(wakeFacts(signalState())).signals).toEqual([]);
    store.replaceBoard("mc", [triageCard({ closed: true })]);
    expect(signalState().signals).toEqual([]);
    store.replaceBoard("mc", []);
    expect(signalState().signals).toEqual([]);
  });

  it("seeds existing backlog, plans and parks as told and prunes closed/off-board triage", () => {
    store.setSetting(`${FLIGHT_SIGNALS_SETTING}:mc`, "");
    store.replaceBoard("mc", [triageCard(), triageCard({ issueNumber: 177, closed: true })]);
    for (const n of [176, 177, 178]) {
      const id = `plan-${n}`;
      store.upsertRun(run(id, "guido-1", { ticket: `mc#${n}` }));
      store.addLoopEvent(`${id}:plan`, id, "plan landed", T0);
      store.addLoopEvent(`${id}:park:1`, id, "parked: push stuck", T0);
      store.addLoopEvent(`${id}:park:2`, id, "parked: push stuck", T0);
    }
    const initial = signalState();
    expect(initial.triage).toEqual([]);
    expect(initial.signals).toEqual([expect.objectContaining({ kind: "repeat_park", told: true })]);
    expect(JSON.parse(wakeFacts(initial)).signals).toEqual([]);
    const saved = JSON.parse(store.getSetting(`${FLIGHT_SIGNALS_SETTING}:mc`) ?? "{}");
    expect(Object.keys(saved.triage).sort()).toEqual(["mc#176:new", "mc#176:plan"]);
    store.replaceBoard("mc", [triageCard({ issueNumber: 179 })]);
    expect(signalState().triage).toEqual([
      expect.objectContaining({ ref: "mc#179", cause: "new" }),
    ]);
    expect(
      Object.keys(JSON.parse(store.getSetting(`${FLIGHT_SIGNALS_SETTING}:mc`) ?? "{}").triage),
    ).toEqual(["mc#179:new"]);
  });

  it("names only the facts that cause the second wake", async () => {
    liveCrew();
    observeFlightMain(store, "mc", { sha: "red", ci: "failing", at: T0 });
    await watch.check();
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    ask();
    await watch.check();
    const header = sendCalls[1]?.text.split("\n")[0] ?? "";
    expect(header).toContain("woke on: q (1), items (1)");
    expect(header).not.toContain("signals (");
    expect(Buffer.byteLength(header)).toBeLessThan(1000);
  });

  it("observes both token budgets even when the latest reading is healthy", () => {
    store.setSetting(
      GITHUB_RATE_SETTING,
      JSON.stringify({
        queries: {
          first: { limit: 5000, remaining: 100, resetAt: T0 + MIN, at: T0 - 1 },
          second: { limit: 5000, remaining: 4500, resetAt: T0 + 2 * MIN, at: T0 },
          third: { limit: 5000, remaining: 50, resetAt: T0 + 3 * MIN, at: T0 - 2 },
        },
        pollCost: 3,
      }),
    );
    expect(
      signalState()
        .signals.map((s) => s.key)
        .sort(),
    ).toEqual([String(T0 + MIN), String(T0 + 3 * MIN)]);
    markFlightSignalsShown(store, signalState(), nowMs);
    nowMs += 4 * MIN;
    expect(signalState().signals).toEqual([]);
  });

  it("requires the pass to follow the latest failing attempt", () => {
    for (const sha of ["a", "b"]) {
      observeCheck(sha, "failing", 1);
      observeCheck(sha, "failing", 2);
      observeCheck(sha, "passing", 2);
    }
    expect(signalState().signals).toEqual([]);
  });

  it("ignores statuses, same-attempt passes and closed PR checks", () => {
    for (const kind of ["status", "check"] as const) {
      for (const sha of ["a", "b"]) {
        for (const state of ["failing", "passing"] as const) {
          observeFlightChecks(
            store,
            "mc",
            [
              stored(7, {
                headSha: sha,
                checks: [
                  { name: "mc/review", kind, state, conclusion: state, attempt: 1, url: null },
                ],
              }),
            ],
            nowMs,
          );
        }
      }
    }
    for (const state of ["failing", "passing"] as const) {
      observeFlightChecks(
        store,
        "mc",
        [
          stored(8, {
            state: "closed",
            headSha: "a",
            checks: [
              {
                name: "test",
                kind: "check",
                state,
                conclusion: state,
                attempt: state === "failing" ? 1 : 2,
                url: null,
              },
            ],
          }),
        ],
        nowMs,
      );
    }
    expect(signalState().signals).toEqual([]);
    expect(JSON.parse(store.getSetting(`${FLIGHT_SIGNALS_SETTING}:mc`) ?? "{}").flakes).toEqual({});
  });

  it("detects engine-ended missing reports and live silent parks, excluding operator stops", () => {
    for (const [id, endedBy] of [
      ["engine-ended", "engine"],
      ["operator-ended", "operator"],
    ] as const) {
      store.upsertRun(
        run(id, "guido-1", {
          ticket: "mc#176",
          loop: { ...NEW_LOOP },
          status: "failed",
          endedAt: T0,
          endedBy,
        }),
      );
      store.setRunEnded(id, T0, "failed", endedBy);
    }
    store.upsertRun(
      run("silent", "inco-1", {
        ticket: "mc#176",
        loop: {
          ...NEW_LOOP,
          phase: "parked",
          parked: { kind: "silent", reason: "stopped twice without reporting", ended: false },
        },
      }),
    );
    expect(
      signalState()
        .signals.map((s) => s.key)
        .sort(),
    ).toEqual(["report:engine-ended", "report:silent"]);
  });

  it.each(["failed", "superseded"] as const)(
    "uses only structured diagnostics for a %s review",
    (state) => {
      const reviewId = store.requestReview({
        authorRunId: "author",
        repoId: "mc",
        seatId: "retro-1",
        prNumber: 7,
        sha: "head",
        epoch: 1,
        attempt: 1,
        round: 1,
        at: T0,
      }) as number;
      store.setReviewState(reviewId, ["queued"], state, { at: T0 });
      const r = run("failed-review", "retro-1", { reviewId, endedAt: T0, status: "failed" });
      store.upsertRun(r);
      recordNoReport(
        store,
        r,
        "review",
        { code: 1, signal: null, lastStderr: "private stderr" },
        foldTranscript(
          null,
          [
            JSON.stringify({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              stop_reason: "model_context_window_exceeded",
              terminal_reason: "aborted_streaming",
              errors: ["private error text"],
            }),
          ],
          T0,
        ),
        T0,
      );
      const signals = signalState().signals;
      if (state === "superseded") {
        expect(signals).toEqual([]);
        return;
      }
      expect(JSON.stringify(signals)).not.toContain("private");
      expect(JSON.stringify(signals)).toContain("aborted_streaming");
      expect(signals).toContainEqual(
        expect.objectContaining({
          key: `report:${r.id}`,
          kind: "hub_error",
          evidence: expect.stringContaining("stop reason model_context_window_exceeded"),
        }),
      );
    },
  );

  it.each(["queued", "starting", "running", "reported", "superseded", "failed"] as const)(
    "only treats pending reviews as missing reports: %s",
    (state) => {
      const reviewId = store.requestReview({
        authorRunId: "author",
        repoId: "mc",
        seatId: "retro-1",
        prNumber: 7,
        sha: "head",
        epoch: 1,
        attempt: 1,
        round: 1,
        at: T0,
      });
      expect(reviewId).not.toBeNull();
      store.setReviewState(reviewId as number, ["queued"], state, { at: T0, runId: "review-run" });
      store.upsertRun(
        run("review-run", "retro-1", {
          reviewId,
          ticket: "mc#176",
          endedAt: T0,
          endedBy: "engine",
          status: "failed",
        }),
      );
      const signals = signalState().signals;
      if (["queued", "starting", "running"].includes(state))
        expect(signals).toContainEqual(expect.objectContaining({ key: "report:review-run" }));
      else expect(signals).toEqual([]);
    },
  );

  it("raises a hub_error for a blocking review that holds no finding text", () => {
    live("guido-1", "r-guido");
    const reviewId = store.requestReview({
      authorRunId: "r-guido",
      repoId: "mc",
      seatId: "retro-1",
      prNumber: 7,
      sha: "head1234",
      epoch: 1,
      attempt: 1,
      round: 2,
      at: T0,
    }) as number;
    store.setReviewState(reviewId, ["queued"], "reported", { at: T0 });
    expect(signalState().signals).toEqual([]);
    store.db.prepare("UPDATE reviews SET blocking = 1 WHERE id = ?").run(reviewId);
    expect(signalState().signals).toContainEqual(
      expect.objectContaining({
        kind: "hub_error",
        key: `findings:r-guido:${reviewId}`,
        evidence: expect.stringContaining("no finding text is stored"),
      }),
    );
  });

  it("keeps watch errors stable across updates and restart, and keys a new error after recovery", () => {
    store.replaceBoard("mc", [triageCard({ status: "Ready" })]);
    store.replaceQueue("guido-1", [{ repoId: "mc", issue: 176 }]);
    store.setSeatSession({ ...row("guido-1", null), updatedAt: T0 - FLIGHT_IDLE_MS });
    store.setSeatSession({ ...row("flight-1", null, "error"), reason: "resume failed" });
    markFlightSignalsShown(store, signalState(), nowMs);
    store.setSeatSession({ ...row("guido-1", null), updatedAt: T0 });
    store.setSeatSession({
      ...row("flight-1", null, "error"),
      reason: "resume failed",
      updatedAt: T0 + 1,
    });
    nowMs += FLIGHT_IDLE_MS;
    expect(
      signalState()
        .signals.filter((s) => !s.told)
        .map((s) => s.key)
        .sort(),
    ).toEqual([`guido-1:${T0}`]);
    store.close();
    store = new Store(join(dir, "mc.sqlite"));
    store.setSetting(
      `${FLIGHT_RETROSPECTIVE_SETTING}:mc`,
      JSON.stringify({ day: "2026-10-22", told: true }),
    );
    expect(signalState().signals.filter((s) => s.key.startsWith("watch:"))).toEqual([
      expect.objectContaining({ key: `watch:flight-1:${T0}`, told: true }),
    ]);
    store.setSeatSession({ ...row("flight-1", null), updatedAt: nowMs });
    store.setSeatSession({
      ...row("flight-1", null, "error"),
      reason: "resume failed",
      updatedAt: ++nowMs,
    });
    expect(signalState().signals.filter((s) => s.key.startsWith("watch:"))).toEqual([
      expect.objectContaining({ key: `watch:flight-1:${nowMs}`, told: false }),
    ]);
  });

  it("names what a stuck engine tick is doing in the silent-engine signal", () => {
    flightLoopHeartbeat(store, "engine", T0 - 3 * MIN, MIN);
    flightLoopHeartbeat(store, "sessions", T0, MIN);
    expect(signalState().signals[0]?.evidence).not.toContain("still running");
    const ticks = tickLogOf(store);
    ticks.begin(T0 - 2 * MIN);
    ticks.step("reconcile mc guido-1:run-1 ci");
    expect(signalState().signals[0]?.evidence).toContain(
      "still running; on reconcile mc guido-1:run-1 ci",
    );
  });

  it("guards sleep/wake silence and writes each source heartbeat at most once a minute", () => {
    const write = vi.spyOn(store, "setSetting");
    flightLoopHeartbeat(store, "engine", T0, MIN);
    flightLoopHeartbeat(store, "sessions", T0, MIN);
    for (let n = 1; n < 60; n++) flightLoopHeartbeat(store, "sessions", T0 + n * 1000, MIN);
    expect(write.mock.calls.filter(([key]) => key === FLIGHT_LOOPS_SETTING)).toHaveLength(2);
    nowMs += 10 * MIN;
    expect(signalState().signals).toEqual([]);
    flightLoopHeartbeat(store, "sessions", nowMs, MIN);
    expect(signalState().signals[0]?.key).toBe(`loop:engine:${T0}`);
    markFlightSignalsShown(store, signalState(), nowMs);
    flightLoopHeartbeat(store, "engine", nowMs, MIN);
    expect(signalState().signals).toEqual([]);
    nowMs += 3 * MIN;
    flightLoopHeartbeat(store, "sessions", nowMs, MIN);
    expect(signalState().signals[0]).toMatchObject({
      key: `loop:engine:${T0 + 10 * MIN}`,
      told: false,
    });
  });

  it("recovers from malformed settings", () => {
    for (const key of [
      `${FLIGHT_SIGNALS_SETTING}:mc`,
      `${FLIGHT_MAIN_SETTING}:mc`,
      FLIGHT_LOOPS_SETTING,
      GITHUB_RATE_SETTING,
    ])
      store.setSetting(key, "{broken");
    expect(signalState().signals).toEqual([]);
    flightLoopHeartbeat(store, "engine", T0, MIN);
    observeFlightMain(store, "mc", { sha: "red", ci: "failing", at: T0 });
    expect(signalState().signals[0]?.told).toBe(false);
  });

  it.each([
    ["Tests pass. https://example.com/?q=1", false],
    ["`should I?` is code", false],
    ["Please confirm the target branch.", true],
    ["Let me know when ready.", true],
    ["Waiting on you", true],
    ["Need your approval", true],
  ])("classifies direct message %s", (text, question) => {
    expect(flightQuestion(text as string)).toBe(question);
  });
});

describe("daily retrospective wakes", () => {
  it("retries failed preparation at most once an hour without restarting", async () => {
    flightOnly();
    nowMs = Date.parse("2026-10-24T02:00:00Z");
    const prepare = vi
      .spyOn(retrospective, "prepareRetrospective")
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockRejectedValueOnce(new Error("still unavailable"));
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await watch.check();
        await watch.check();
        expect(prepare).toHaveBeenCalledTimes(attempt);
        expect(sendCalls).toHaveLength(0);
        nowMs += FLIGHT_HOUR_MS - 1;
        await watch.check();
        expect(prepare).toHaveBeenCalledTimes(attempt);
        nowMs++;
      }
      await watch.check();
      await watch.check();
      expect(prepare).toHaveBeenCalledTimes(3);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.text).toContain('"day":"2026-10-24"');
      nowMs += FLIGHT_HOUR_MS;
      await watch.check();
      expect(prepare).toHaveBeenCalledTimes(3);
      expect(sendCalls).toHaveLength(1);
    } finally {
      prepare.mockRestore();
    }
  });

  it("prepares off the serial chain once per day, serves questions meanwhile and replaces stale reports", async () => {
    liveCrew();
    nowMs = Date.parse("2026-10-24T02:00:00Z");
    store.setSetting(
      `${FLIGHT_RETROSPECTIVE_SETTING}:mc`,
      JSON.stringify({ day: "2026-10-23", told: false, report: { day: "2026-10-23" } }),
    );
    const original = retrospective.prepareRetrospective;
    let finish: () => void = () => {};
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const prepare = vi
      .spyOn(retrospective, "prepareRetrospective")
      .mockImplementation(async (...args) => {
        await work;
        await original(...args);
      });
    try {
      ask();
      await watch.check(); // Must resolve while retrospective git work is still pending.
      expect(sendCalls).toHaveLength(1);
      expect(
        JSON.parse(sendCalls[0]?.text.split("\n").at(-1) ?? "{}").retrospective,
      ).toBeUndefined();
      await watch.check();
      expect(prepare).toHaveBeenCalledTimes(1);
      nowMs += FLIGHT_MIN_WAKE_GAP_MS;
      finish();
      await work;
      await watch.check();
      await watch.check();
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls.at(-1)?.text).toContain('"day":"2026-10-24"');
      expect(sendCalls.every((c) => !c.text.includes('"day":"2026-10-23"'))).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      prepare.mockRestore();
    }
  });

  it.each([
    ["2026-10-24T01:59:00Z", "2026-10-24T02:00:00Z", "2026-10-24"],
    ["2026-10-25T02:59:00Z", "2026-10-25T03:00:00Z", "2026-10-25"],
  ])("wakes at local 03:00 (%s), once across a durable restart", async (before, at, day) => {
    flightOnly();
    nowMs = Date.parse(before);
    await watch.check();
    expect(sendCalls).toHaveLength(0);
    nowMs = Date.parse(at);
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text).toContain('"retrospective":');
    expect(sendCalls[0]?.text).toContain(`"${day}"`);
    expect(sendCalls[0]?.text.split("\n")[0]).toContain("woke on: retrospective (1)");
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    watch.stop();
    store.close();
    store = new Store(join(dir, "mc.sqlite"));
    makeWatch();
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    nowMs += 25 * 60 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
  });
  it("retries an undelivered fact after restart without recomputing it", async () => {
    liveCrew();
    nowMs = Date.parse("2026-10-24T02:00:00Z");
    sendFails = true;
    await watch.check();
    const first = flightState({ config, store, busy: [], now: nowMs }).retrospective;
    expect(first?.day).toBe("2026-10-24");
    const failedAttempts = sendCalls.length;
    watch.stop();
    makeWatch();
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    sendFails = false;
    await watch.check();
    expect(sendCalls).toHaveLength(failedAttempts + 1);
    expect(sendCalls.at(-1)?.text).toContain(`"at":${first?.at}`);
    expect(flightState({ config, store, busy: [], now: nowMs }).retrospective).toBeUndefined();
  });
  it("includes the retrospective in a fresh run's first wake and honours Stop", async () => {
    nowMs = Date.parse("2026-10-24T02:00:00Z");
    store.setSeatSession(row("flight-1", null, "stopped"));
    await watch.check();
    expect(startCalls).toHaveLength(0);
    store.setSeatSession(row("flight-1", null));
    await watch.check();
    expect(startCalls[0]?.first).toContain('"retrospective":');
    expect(flightState({ config, store, busy: [], now: nowMs }).retrospective).toBeUndefined();
  });
});

describe("every wake ends with each reason handled", () => {
  const flightIdle = () =>
    listener?.({ kind: "idle", seatId: "flight-1", runId: "r-flight", resumed: false });
  const leftNotes = () => store.notes().filter((n) => n.key === FLIGHT_LEFT_NOTE_KEY);
  /** A wake on one open question, then FLIGHT's turn ends. */
  const wokeOnAQuestion = async () => {
    liveCrew();
    watch.start();
    const id = ask();
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    flightIdle();
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    return id;
  };
  const decide = (over: Partial<Parameters<Store["addFlightDecision"]>[0]>) =>
    store.addFlightDecision({
      at: nowMs,
      kind: "answer",
      seatId: null,
      targetRunId: null,
      ref: null,
      questionId: null,
      about: "a",
      decision: "d",
      basis: "b",
      ...over,
    });

  it("re-wakes once with 'You left these' when a reason gets no decision", async () => {
    await wokeOnAQuestion();
    await watch.check();
    expect(sendCalls).toHaveLength(2);
    const line = sendCalls[1]?.text.split("\n")[0] ?? "";
    expect(line).toContain(`${FLIGHT_LEFT_HEAD} q 1`);
    // one re-wake only: the same silence again does not send a third
    flightIdle();
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
  });

  it("holds a question that arrived with the re-wake to its own first miss", async () => {
    const q1 = await wokeOnAQuestion();
    ask("inco-1", "r-inco", nowMs);
    await watch.check();
    expect(sendCalls[1]?.text.split("\n")[0]).toContain(FLIGHT_LEFT_HEAD);
    flightIdle();
    decide({ questionId: q1 });
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    await watch.check();
    // the new question was missed once: it is re-woken for, not sent to the operator
    expect(leftNotes()).toEqual([]);
    expect(sendCalls.at(-1)?.text.split("\n")[0]).toContain(`${FLIGHT_LEFT_HEAD} q 2`);
  });

  it("keeps the operator item while the reason it lists is still undecided", async () => {
    await wokeOnAQuestion();
    const q2 = ask("inco-1", "r-inco", nowMs);
    await watch.check();
    flightIdle();
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    await watch.check();
    expect(leftNotes()[0]?.text).toContain("q 1");
    // the re-wake for the second question ends clean, but question 1 is still open
    flightIdle();
    decide({ questionId: q2 });
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    await watch.check();
    expect(leftNotes()).toHaveLength(1);
    // once question 1 is answered the item clears
    store.answerQuestions("guido-1", nowMs);
    await watch.check();
    expect(leftNotes()).toEqual([]);
  });

  it("raises one operator item when the second wake leaves them again, and none before", async () => {
    await wokeOnAQuestion();
    await watch.check();
    expect(leftNotes()).toEqual([]);
    flightIdle();
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    await watch.check();
    expect(leftNotes()).toHaveLength(1);
    expect(leftNotes()[0]).toMatchObject({ kind: "blocked", seatId: "flight-1" });
    expect(leftNotes()[0]?.text).toContain("q 1");
    // the operator sees it as itself, not as an item FLIGHT triages
    const item = attentionItems(config, store, nowMs).find((i) =>
      i.key.endsWith(FLIGHT_LEFT_NOTE_KEY),
    );
    expect(item).toMatchObject({ owner: "operator" });
    expect(item?.flightTriage).toBeUndefined();
  });

  it("clears the item once a later wake's reasons are all handled", async () => {
    await wokeOnAQuestion();
    await watch.check();
    flightIdle();
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(leftNotes()).toHaveLength(1);
    // FLIGHT answers the question later; the next audit of a fresh wake finds nothing left
    store.answerQuestions("guido-1", nowMs);
    ask("guido-1", "r-guido", nowMs);
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    flightIdle();
    decide({ questionId: store.openQuestions()[0]?.id ?? 0 });
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(leftNotes()).toEqual([]);
  });

  it("counts a decision that names the reason's target as handling it", async () => {
    const id = await wokeOnAQuestion();
    decide({ kind: "brief", about: `ask:${id}: briefed for the operator`, decision: "passed up" });
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(leftNotes()).toEqual([]);
  });

  it("counts a wait on the target as handling it", async () => {
    const id = await wokeOnAQuestion();
    decide({
      kind: "wait",
      about: `ask:${id}: waiting on the lane decision`,
      decision: "waiting until later",
    });
    await watch.check();
    expect(sendCalls).toHaveLength(1);
  });

  it("counts a reason settled in the state (the question answered) as handled", async () => {
    await wokeOnAQuestion();
    store.answerQuestions("guido-1", nowMs);
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(leftNotes()).toEqual([]);
  });

  it("does not audit while FLIGHT's turn is still running", async () => {
    liveCrew();
    ask();
    await watch.check();
    // no idle event: the turn that followed the wake has not ended
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
  });

  it("a decision for one signal's target leaves another of the same kind unhandled", async () => {
    liveCrew();
    watch.start();
    for (const seatId of ["guido-1", "guido-2"])
      recordSeatCall(store, "mc", { seat: seatId, reason: "stuck", ref: null, at: nowMs });
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    flightIdle();
    // names the kind and one seat only
    decide({ kind: "note", seatId: "guido-1", about: "seat_call from guido-1", decision: "on it" });
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
    const line = sendCalls[1]?.text.split("\n")[0] ?? "";
    expect(line).toContain("guido-2");
    expect(line).not.toContain("guido-1");
  });

  it("a brief or wait that names the ticket or PR handles a stalled merge", async () => {
    liveCrew();
    watch.start();
    store.setRunLoop("r-guido", { ...NEW_LOOP, prNumber: 7 });
    store.upsertRun(run("r-guido", "guido-1", { ticket: "mc#176" }));
    store.setRunLoop("r-guido", { ...NEW_LOOP, prNumber: 7 });
    store.upsertPullRequests("mc", [stored(7, { ticket: "mc#176", isDraft: false })], T0);
    store.raiseNote({
      key: "ready:r-guido",
      kind: "ready",
      runId: "r-guido",
      seatId: "guido-1",
      repoId: "mc",
      text: "mc#176 is ready to merge",
      at: nowMs - 11 * MIN,
    });
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text).toContain("PR #7");
    flightIdle();
    decide({
      kind: "brief",
      ref: "mc#176",
      about: "PR #7 stalled",
      decision: "briefed the operator",
    });
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(leftNotes()).toEqual([]);
  });

  it("a brief on an item's ticket handles both the item and its stale signal", async () => {
    liveCrew();
    watch.start();
    store.upsertRun(run("r-guido", "guido-1", { ticket: "mc#176" }));
    store.raiseNote({
      key: "blocked:r-guido:0",
      kind: "blocked",
      runId: "r-guido",
      seatId: "guido-1",
      repoId: "mc",
      text: "mc#176 blocked on the operator",
      at: nowMs - 11 * MIN,
    });
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text).toContain("item_stale");
    flightIdle();
    decide({
      kind: "brief",
      ref: "mc#176",
      about: "mc#176 is blocked on the operator",
      decision: "briefed the operator",
    });
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(leftNotes()).toEqual([]);
  });

  it("a decision with an item's kind in it does not settle every stale item of that kind", async () => {
    liveCrew();
    watch.start();
    for (const r of ["r1", "r2"])
      store.raiseNote({
        key: `blocked:${r}:0`,
        kind: "blocked",
        runId: null,
        seatId: "guido-1",
        repoId: "mc",
        text: `mc#7 parked (${r})`,
        at: nowMs - 11 * MIN,
      });
    await watch.check();
    flightIdle();
    decide({ kind: "note", about: "r1 blocked handled", decision: "on it" });
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
    const line = sendCalls[1]?.text.split("\n")[0] ?? "";
    expect(line).toContain("r2");
    expect(line).not.toContain("r1");
  });

  it("a decision about something else leaves the reason unhandled", async () => {
    await wokeOnAQuestion();
    decide({ kind: "note", about: "mc#999 something else", decision: "noted" });
    await watch.check();
    expect(sendCalls).toHaveLength(2);
  });
});

describe("the pace of FLIGHT's re-wake", () => {
  it("does not speed up while a run is live: nothing pending means no re-wake", async () => {
    live("guido-1", "r-guido");
    noFlight();
    await watch.check();
    expect(startCalls).toHaveLength(1);
    facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
    for (const later of [16 * MIN, FLIGHT_REWAKE_MS + MIN, 3 * FLIGHT_REWAKE_MS]) {
      nowMs = T0 + later;
      await watch.check();
    }
    expect(sendCalls).toHaveLength(0);
  });
});

describe("a seat's call to FLIGHT", () => {
  it("wakes FLIGHT within one tick with the seat's reason", async () => {
    liveCrew();
    watch.start();
    await vi.advanceTimersByTimeAsync(0);
    sendCalls = [];
    recordSeatCall(store, "mc", {
      seat: "guido-1",
      reason: "blocked on a change in apps/web",
      ref: "mc#7",
      at: nowMs,
    });
    bus.emit("attention");
    nowMs += FLIGHT_DEBOUNCE_MS;
    await vi.advanceTimersByTimeAsync(FLIGHT_DEBOUNCE_MS);
    expect(FLIGHT_DEBOUNCE_MS).toBeLessThanOrEqual(FLIGHT_TICK_MS);
    expect(sendCalls).toHaveLength(1);
    const text = sendCalls[0]?.text ?? "";
    expect(text.split("\n")[0]).toContain("woke on: signals (1)");
    expect(text).toContain("guido-1 calls FLIGHT about mc#7: blocked on a change in apps/web");
  });

  it("is told once, and a call FLIGHT never decides on is left to the audit", async () => {
    liveCrew();
    watch.start();
    recordSeatCall(store, "mc", {
      seat: "guido-1",
      reason: "need a ruling",
      ref: "mc#7",
      at: nowMs,
    });
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    listener?.({ kind: "idle", seatId: "flight-1", runId: "r-flight", resumed: false });
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]?.text.split("\n")[0]).toContain(`${FLIGHT_LEFT_HEAD} signals`);
  });
});

describe("the sweep's new checks hold back until their time", () => {
  beforeEach(() => {
    store.setSeatSession({ ...row("guido-1", null), updatedAt: nowMs });
    flightOnly();
  });
  const kinds = () =>
    flightState({ config, store, busy: [], now: nowMs }).signals.map((s) => s.kind);

  it("an idle seat with startable work counts after 10 minutes, not before", () => {
    store.setSeatSession({ ...row("guido-1", null), updatedAt: T0 - 9 * MIN });
    store.replaceBoard("mc", [triageCard({ status: "Ready" })]);
    store.replaceQueue("guido-1", [{ repoId: "mc", issue: 176 }]);
    expect(kinds()).not.toContain("idle_seat");
    nowMs += MIN;
    expect(kinds()).toContain("idle_seat");
  });

  it("a park counts after 15 minutes, not before", () => {
    store.replaceBoard("mc", [triageCard({ status: "Ready" })]);
    store.upsertRun(run("r-park", "guido-1", { ticket: "mc#176" }));
    store.setRunLoop("r-park", {
      ...NEW_LOOP,
      phase: "parked",
      parked: { kind: "push", reason: "push stuck", ended: false },
    });
    store.setSeatSession(row("guido-1", "r-park", "parked"));
    store.addLoopEvent("p", "r-park", "parked: push stuck", T0 - 14 * MIN);
    expect(kinds()).not.toContain("old_park");
    nowMs += 2 * MIN;
    expect(kinds()).toContain("old_park");
  });

  it("a controller request counts after 15 minutes, and an answer from CAPCOM ends it", () => {
    store.addFlightDecision({
      at: T0 - 14 * MIN,
      kind: "note",
      seatId: null,
      targetRunId: null,
      ref: null,
      questionId: null,
      about: `${FOR_THE_CONTROLLER} approve it`,
      decision: "asked",
      basis: "b",
    });
    expect(kinds()).not.toContain("controller_unanswered");
    nowMs += 2 * MIN;
    expect(kinds()).toContain("controller_unanswered");
    // once told, it stays only while the request is unanswered
    markFlightSignalsShown(store, flightState({ config, store, busy: [], now: nowMs }), nowMs);
    store.addComms({
      at: nowMs,
      from: COMMS_CAPCOM,
      to: "flight-1",
      ticket: null,
      text: "approved",
    });
    expect(kinds()).not.toContain("controller_unanswered");
  });

  it("an ended run with no PR counts; one with a PR, or a missing report already told, does not", () => {
    store.upsertRun(
      run("r-nopr", "guido-1", {
        ticket: "mc#176",
        endedAt: T0,
        endedBy: "exit",
        status: "failed",
      }),
    );
    expect(kinds()).toContain("run_no_pr");
    store.upsertPullRequests("mc", [stored(7, { ticket: "mc#176" })], T0);
    expect(kinds()).not.toContain("run_no_pr");
  });

  it("a wait counts as over once its time passes", () => {
    recordFlightWait(store, "mc#9", { on: "PR 7", until: T0 + 5 * MIN, at: T0 });
    expect(kinds()).not.toContain("wait_over");
    nowMs += 6 * MIN;
    expect(kinds()).toContain("wait_over");
  });
});

describe("routine pipeline steps stay in the digest (#1239)", () => {
  /** A tick past the minimum gap, so a wake that is due is not held back. */
  const tick = async () => {
    nowMs += FLIGHT_MIN_WAKE_GAP_MS;
    vi.setSystemTime(nowMs);
    await watch.check();
  };
  const holdPr = (over: Partial<PullRequestView> = {}) => {
    store.upsertRun(run("r-pr", "guido-1", { ticket: "mc#176" }));
    store.setRunLoop("r-pr", { ...NEW_LOOP, prNumber: 7 });
    store.setSeatSession(row("guido-1", "r-pr"));
    store.upsertPullRequests(
      "mc",
      [stored(7, { ticket: "mc#176", isDraft: false, ...over })],
      nowMs,
    );
  };

  it("a PR going pending, green, review queued, merged wakes FLIGHT never", async () => {
    flightOnly();
    holdPr({ ci: "pending" });
    await watch.check();
    expect(sendCalls).toEqual([]);
    const before = wakeFacts(flightState({ config, store, busy: [], now: nowMs }));
    holdPr({ ci: "passing" });
    await tick();
    store.requestReview({
      authorRunId: "r-pr",
      repoId: "mc",
      seatId: "retro-1",
      prNumber: 7,
      sha: "sha7",
      epoch: 0,
      attempt: 1,
      round: 1,
      at: nowMs,
    });
    await tick();
    holdPr({ ci: "passing", review: "approved" });
    await tick();
    holdPr({ ci: "passing", state: "merged", mergedAt: nowMs });
    await tick();
    expect(sendCalls).toEqual([]);
    expect(startCalls).toEqual([]);
    expect(wakeFacts(flightState({ config, store, busy: [], now: nowMs }))).toBe(before);
    // still in the digest FLIGHT reads
    expect(listed().map((p) => [p.pr, p.state])).toEqual([[7, "merged"]]);
  });

  it("a ready PR with a queued merge wakes nothing until the stall rule fires, then once", async () => {
    flightOnly();
    holdPr({ ci: "passing" });
    store.raiseNote({
      key: "ready:r-pr",
      kind: "ready",
      runId: "r-pr",
      seatId: "guido-1",
      repoId: "mc",
      text: "mc#176 is ready to merge",
      at: nowMs,
    });
    await watch.check();
    expect(sendCalls).toEqual([]);
    nowMs += FLIGHT_MERGE_STALL_MS - MIN;
    await watch.check();
    expect(sendCalls).toEqual([]);
    nowMs += MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    const head = sendCalls[0]?.text.split("\n")[0] ?? "";
    expect(head).toContain("signals");
    const digest = JSON.parse(sendCalls[0]?.text.split("\n").at(-1) ?? "{}");
    expect(JSON.stringify(digest.signals.entries)).toContain("PR #7");
    await tick();
    expect(sendCalls).toHaveLength(1);
  });

  it("a park the engine clears alone is no wake; a ruling park is", async () => {
    flightOnly();
    holdPr();
    store.setRunLoop("r-pr", {
      ...NEW_LOOP,
      prNumber: 7,
      phase: "parked",
      parked: { kind: "push", reason: "push stuck", ended: false },
    });
    store.setSeatSession(row("guido-1", "r-pr", "parked"));
    await watch.check();
    expect(sendCalls).toEqual([]);
    store.setRunLoop("r-pr", {
      ...NEW_LOOP,
      prNumber: 7,
      phase: "parked",
      parked: { kind: RULING_PARK, reason: "needs a ruling", ended: false },
    });
    await tick();
    expect(sendCalls).toHaveLength(1);
  });

  it("a question wakes FLIGHT within one tick", async () => {
    liveCrew();
    await watch.check();
    ask();
    await tick();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text.split("\n")[0]).toContain("q (1)");
  });

  it("an item for FLIGHT wakes it within one tick", async () => {
    liveCrew();
    await watch.check();
    store.raiseNote({
      key: "blocked:r1:0",
      kind: "blocked",
      runId: null,
      seatId: "guido-1",
      repoId: "mc",
      text: "mc#7 parked",
      at: nowMs,
    });
    await tick();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text.split("\n")[0]).toContain("items");
  });

  it("a failed run wakes FLIGHT within one tick", async () => {
    liveCrew();
    await watch.check();
    store.upsertRun(
      run("r-nopr", "guido-1", {
        ticket: "mc#176",
        endedAt: nowMs,
        endedBy: "exit",
        status: "failed",
      }),
    );
    await tick();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text.split("\n")[0]).toContain("signals");
  });

  it("a free seat with startable work wakes FLIGHT within one tick", async () => {
    flightOnly();
    store.setSeatSession(row("guido-1", null));
    await watch.check();
    expect(sendCalls).toEqual([]);
    store.replaceBoard("mc", [triageCard({ status: "Ready" })]);
    await tick();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text.split("\n")[0]).toContain("free");
  });

  it("the hour re-wake fires for a fact left unhandled, not for a digest change", async () => {
    liveCrew();
    holdPr({ ci: "pending" });
    await watch.check();
    holdPr({ ci: "passing" });
    nowMs += FLIGHT_REWAKE_MS + MIN;
    await tick();
    expect(sendCalls).toEqual([]);
    ask();
    await tick();
    expect(sendCalls).toHaveLength(1);
    nowMs += FLIGHT_REWAKE_MS;
    await tick();
    expect(sendCalls).toHaveLength(2);
  });

  it("a merged PR that woke nothing rides in the next wake, even an hour later", async () => {
    flightOnly();
    await watch.check();
    store.upsertPullRequests("mc", [stored(7, { state: "merged", mergedAt: nowMs })], nowMs);
    await watch.check();
    expect(sendCalls).toEqual([]);
    nowMs += 61 * MIN;
    vi.setSystemTime(nowMs);
    ask();
    await watch.check();
    const last = JSON.parse(sendCalls[0]?.text.split("\n").at(-1) ?? "") as FlightWake;
    expect(last.prs.entries.map((p) => [p.pr, p.state])).toEqual([[7, "merged"]]);
  });

  it("idle review seats with a review queued for 10 minutes wake FLIGHT once", async () => {
    flightOnly();
    await watch.check();
    store.requestReview({
      authorRunId: "r-author",
      repoId: "mc",
      seatId: "retro-1",
      prNumber: 7,
      sha: "sha7",
      epoch: 0,
      attempt: 1,
      round: 1,
      at: nowMs,
    });
    await watch.check();
    expect(sendCalls).toEqual([]);
    nowMs += FLIGHT_IDLE_MS - MIN;
    await watch.check();
    expect(sendCalls).toEqual([]);
    nowMs += 2 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text.split("\n")[0]).toContain("reviews");
  });

  it("stores each wake's reasons on the run, and counts them per hour by reason", async () => {
    liveCrew();
    await watch.check();
    ask();
    await tick();
    expect(store.flightWakes(0)).toEqual([
      { runId: "r-flight", at: nowMs, reasons: ["q", "items"] },
    ]);
    const view = flightView(config, store, nowMs + MIN);
    expect(view.wakeHistory?.byReason).toEqual([
      { reason: "items", n: 1 },
      { reason: "q", n: 1 },
    ]);
    const hours = view.wakeHistory?.perHour ?? [];
    expect(hours).toHaveLength(24);
    expect(hours.at(-1)).toEqual({ at: expect.any(Number), n: 1, byReason: { q: 1, items: 1 } });
  });
});
