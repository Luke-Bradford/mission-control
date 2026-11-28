import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLIGHT_SEAT_WAITING_MS,
  type FlightState,
  NEW_LOOP,
  type Run,
  type RunDigest,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { flightSignals } from "../src/flight/signals.ts";
import { SIDEBAR_WAITING_MAX, workspaceWaitingText } from "../src/hud/seat-waiting.ts";
import { foldTranscript } from "../src/run/streamjson.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-28T10:21:00Z");
const MIN = 60_000;
const RUN = "guido-1:r1";
const LAST = "Blocked until the operator grants database access.";

let dir: string;
let store: Store;

const config = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
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
        ],
      },
    ],
  },
} as unknown as CcConfig;
const session = config.crew?.sessions[0];
if (session === undefined) throw new Error("no session");
const seats = [
  { id: "guido-1", loop: "build", free: false, atStop: false, area: [] },
] as unknown as FlightState["seats"];

const run: Run = {
  id: RUN,
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 300 * MIN,
  endedAt: null,
  status: "running",
  sessionId: "cli",
  model: "opus",
  branch: "feature/7-x",
  ticket: "mc#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
};
const digest = { lastText: LAST } as RunDigest;

const waits = () =>
  flightSignals({ config, store, session, seats, now: NOW }).signals.filter(
    (s) => s.kind === "seat_waiting",
  );

/** The seat's row: its turn ended `ago` before now, in `state`. */
const seatRow = (state: "running" | "idle", ago: number) => {
  store.setSeatSession({
    seatId: "guido-1",
    runId: RUN,
    cliSessionId: "cli",
    state,
    reason: null,
    worktree: "/w/guido-1",
    updatedAt: NOW - ago,
  });
  store.setSeatTurnStarted("guido-1", NOW - ago - MIN);
  store.setSeatTurnEnded("guido-1", NOW - ago);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-seat-waiting-"));
  store = new Store(join(dir, "mc.sqlite"));
  store.upsertRun(run);
  store.setRunLoop(RUN, { ...NEW_LOOP, phase: "working" }, NOW - 300 * MIN);
  store.setDigest(RUN, digest);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a seat idle at its prompt with its run unreported (#2318)", () => {
  it("wakes FLIGHT once, 30 minutes after its turn ended, with its last message", () => {
    seatRow("idle", FLIGHT_SEAT_WAITING_MS - MIN);
    expect(waits()).toEqual([]);
    seatRow("idle", FLIGHT_SEAT_WAITING_MS);
    const [signal, ...more] = waits();
    expect(more).toEqual([]);
    expect(signal?.key).toBe(`${RUN}:${NOW - FLIGHT_SEAT_WAITING_MS}`);
    expect(signal?.evidence).toContain("guido-1");
    expect(signal?.evidence).toContain("mc#7");
    expect(signal?.evidence).toContain(`waiting on the operator: ${LAST}`);
  });

  it("reads the target and the whole message after the first sentence, transcript to status", () => {
    const said = "All safe work is complete. Waiting on FLIGHT to reset my branch.";
    const line = JSON.stringify({
      type: "assistant",
      message: { id: "m1", content: [{ type: "text", text: said }] },
      parent_tool_use_id: null,
      timestamp: new Date(NOW - 40 * MIN).toISOString(),
    });
    store.setDigest(RUN, foldTranscript(null, [line], 1).digest);
    seatRow("idle", FLIGHT_SEAT_WAITING_MS);
    const crewWs = { owner: "crew" as const, name: "guido-1 · mc#7" };
    expect(workspaceWaitingText(store, ["guido-1"], crewWs)).toBe(`waiting on FLIGHT: ${said}`);
    expect(waits()[0]?.evidence).toContain(`waiting on FLIGHT: ${said}`);
  });

  it("cuts a long message in cmux's sidebar line; FLIGHT's evidence keeps it whole", () => {
    const long = `Waiting on FLIGHT. ${"More detail here. ".repeat(30)}`.trim();
    store.setDigest(RUN, { lastText: "Waiting on FLIGHT.", lastMessage: long } as RunDigest);
    seatRow("idle", FLIGHT_SEAT_WAITING_MS);
    const line = workspaceWaitingText(store, ["guido-1"], {
      owner: "crew",
      name: "guido-1 · mc#7",
    }) as string;
    expect(line.length).toBe(SIDEBAR_WAITING_MAX);
    expect(line.endsWith("…")).toBe(true);
    expect(waits()[0]?.evidence).toContain(`waiting on FLIGHT: ${long}`);
  });

  it("a seat whose question already reached FLIGHT raises no wake, though it shows waiting", () => {
    seatRow("idle", 120 * MIN);
    store.addQuestion({
      agentId: "guido-1",
      runId: RUN,
      text: "May I reset my branch?",
      at: NOW - 121 * MIN,
    });
    expect(waits()).toEqual([]);
    const crewWs = { owner: "crew" as const, name: "guido-1 · mc#7" };
    expect(workspaceWaitingText(store, ["guido-1"], crewWs)).toBe(
      `waiting on the operator: ${LAST}`,
    );
  });

  it("a seat really at work raises nothing, however long its run", () => {
    seatRow("running", 120 * MIN);
    expect(waits()).toEqual([]);
  });

  it("a seat past its report raises nothing", () => {
    seatRow("idle", 120 * MIN);
    store.setRunLoop(RUN, { ...NEW_LOOP, phase: "review" }, NOW - 100 * MIN);
    expect(waits()).toEqual([]);
  });

  it("names the seat's cmux workspace line, and nothing for an operator workspace", () => {
    seatRow("idle", MIN);
    const crewWs = { owner: "crew" as const, name: "guido-1 · mc#7" };
    expect(workspaceWaitingText(store, ["guido-1"], crewWs)).toBe(
      `waiting on the operator: ${LAST}`,
    );
    expect(workspaceWaitingText(store, ["guido-1"], { ...crewWs, owner: "operator" })).toBeNull();
    seatRow("running", MIN);
    expect(workspaceWaitingText(store, ["guido-1"], crewWs)).toBeNull();
  });
});
