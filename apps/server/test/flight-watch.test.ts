import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLIGHT_DEBOUNCE_MS,
  FLIGHT_MAX_WAKES,
  FLIGHT_NOTE_KEY,
  FLIGHT_UNPARK_KINDS,
  FLIGHT_WAKE_HEAD,
  type FlightSeatState,
  type FlightState,
  flightStartFailedText,
  type Run,
  type SeatSessionRow,
  wakeSummary,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig, CrewSeatConfig } from "../src/config.ts";
import { flightState, pending } from "../src/flight/state.ts";
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
  facts = null;
  enabled = true;
  started = 0;
  listener = null;
  vi.setSystemTime(T0);
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
});
afterEach(() => {
  watch.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("the FLIGHT watcher", () => {
  it("starts FLIGHT with the digest", async () => {
    await watch.check();
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.seatId).toBe("flight-1");
    const first = startCalls[0]?.first ?? "";
    expect(first.startsWith(`${FLIGHT_WAKE_HEAD} `)).toBe(true);
    const state = flightState({ config, store, busy: [], now: T0 });
    expect(JSON.parse(first.split("\n").at(-1) ?? "")).toEqual(state);
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

  it("wakes on a new question, once", async () => {
    liveCrew();
    ask();
    await watch.check();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.key).toBe("flight:wake:r-flight:1");
    expect(sendCalls[0]?.text.startsWith(`${FLIGHT_WAKE_HEAD} 1 question\n`)).toBe(true);
    await watch.check();
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

  it("announces a 20-minute question once", async () => {
    liveCrew();
    facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
    ask();
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
  const q = { id: 1, seat: "guido-1", ticket: null, text: "t", ageMin: 0 };
  const pr = { ref: "mc#1", pr: 1, seat: "guido-1", ready: false };
  const state = (over: Partial<FlightState>): FlightState => ({
    time: "12:00",
    repo: "mc",
    seats: [],
    questions: [],
    tickets: [],
    prs: [],
    recent: [],
    limits: { startsLeft: 4, messagesLeft: 30 },
    ...over,
  });

  it("says nothing new, then each part with its singular", () => {
    expect(wakeSummary(state({}))).toBe("nothing new");
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
    };
    it("is true for a question, a free build seat with a ticket, or a park FLIGHT can lift", () => {
      expect(pending(state({ questions: [q] }))).toBe(true);
      expect(pending(state({ seats: [s({ free: true })], tickets: [ticket] }))).toBe(true);
      expect(
        pending(state({ seats: [s({ parked: { kind: FLIGHT_UNPARK_KINDS[0], reason: "x" } })] })),
      ).toBe(true);
    });

    it("is false for a park that is the operator's, a free seat with no ticket, or nothing", () => {
      expect(pending(state({ seats: [s({ parked: { kind: "operator", reason: "x" } })] }))).toBe(
        false,
      );
      expect(pending(state({ seats: [s({ free: true })] }))).toBe(false);
      expect(pending(state({}))).toBe(false);
    });
  });
});
