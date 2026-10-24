import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardItem,
  COMMS_CAPCOM,
  FLIGHT_DEBOUNCE_MS,
  FLIGHT_HEADLINE,
  FLIGHT_MAX_WAKES,
  FLIGHT_MIN_WAKE_GAP_MS,
  FLIGHT_NOTE_KEY,
  FLIGHT_NOTE_SECTIONS,
  FLIGHT_REWAKE_MS,
  FLIGHT_STARTS_PER_HOUR,
  FLIGHT_UNPARK_KINDS,
  FLIGHT_WAKE_HEAD,
  type FlightLedgerEntry,
  type FlightSeatState,
  type FlightState,
  type FlightWake,
  flightStartFailedText,
  NEW_LOOP,
  type PullRequestView,
  type Run,
  type SeatSessionRow,
  wakeSummary,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig, CrewSeatConfig } from "../src/config.ts";
import {
  flightOwnSeatIds,
  flightSeat,
  flightStartCap,
  flightState,
  markPrsShown,
  ownReply,
  pending,
  wakeFacts,
} from "../src/flight/state.ts";
import { createFlightWatch, type FlightWatch } from "../src/flight/watch.ts";
import type { SeatFacts, SendResult, SupervisorEvent } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";

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
let sendCalls: { runId: string; key: string; text: string }[];
let endCalls: string[];
let statusCalls: number;
let startFails: string | null;
let sendFails = false;
let facts: SeatFacts | null;
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
        return { runId };
      },
      send: async (runId, key, text): Promise<SendResult> => {
        sendCalls.push({ runId, key, text });
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
    },
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "mc-flight-watch-"));
  store = new Store(join(dir, "mc.sqlite"));
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

  it("does not wake again when a merged PR leaves the list after its wake", async () => {
    liveCrew();
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
    expect(sendCalls[0]?.text).not.toContain("to release");
    sendCalls = [];
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
    liveCrew();
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
    say(T0 + MIN, "guido-1", COMMS_CAPCOM, "tests pass");
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

  it("carries a ledger index and headline without in_progress prose", async () => {
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
    expect(sentWake().facts.prs).toHaveLength(1);
    expect(sentWake().questions).toHaveLength(1);
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
    liveCrew();
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
      sendCalls[0]?.text.startsWith(`${FLIGHT_WAKE_HEAD} 1 question · 1 item to brief\n`),
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

  it("an unbriefed item re-wakes hourly", async () => {
    liveCrew();
    raiseBlocked();
    await watch.check();
    nowMs = T0 + 59 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    nowMs = T0 + 61 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
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

  it("re-wakes hourly while something waits, and not otherwise", async () => {
    liveCrew();
    ask();
    await watch.check();
    nowMs = T0 + 59 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    nowMs = T0 + 61 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]?.key.endsWith(":2")).toBe(true);

    store.answerQuestions("guido-1", nowMs);
    nowMs = T0 + 130 * MIN;
    await watch.check();
    nowMs = T0 + 200 * MIN;
    await watch.check();
    expect(sendCalls).toHaveLength(2);
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
      expect(wakeFacts(state({ prs: [{ ...pr, state: "merged" }] }))).not.toBe(
        wakeFacts(state({ prs: [pr] })),
      );
      expect(wakeFacts(stopped)).not.toBe(wakeFacts(state({ seats: [s({ free: true })] })));
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
