import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLIGHT_ABOUT_MAX,
  FLIGHT_NOTED,
  FLIGHT_NOTES_PER_HOUR,
  MC_BAD_ARGS,
  MC_FLIGHT_ONLY,
  MC_RUN_ENDED,
  type Run,
  type SeatSessionRow,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig, CrewSeatConfig } from "../src/config.ts";
import { createFlightTools } from "../src/flight/tools.ts";
import type { McTool, McToolContext } from "../src/mcp/server.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const seat = (id: string, role: string, extra: Partial<CrewSeatConfig> = {}): CrewSeatConfig => ({
  id,
  role,
  accountId: "claude-main",
  model: "opus",
  area: [],
  ...extra,
});
const config = (): CcConfig => ({
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
});

let dir: string;
let store: Store;
let bus: ChangeBus;
let seen: string[];
let tool: McTool;
let nowMs: number;

const run = (id: string, agentId: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId,
  repoId: "mc",
  seq: 1,
  startedAt: NOW,
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
const row = (seatId: string, runId: string): SeatSessionRow => ({
  seatId,
  runId,
  cliSessionId: "cli",
  state: "idle",
  reason: null,
  worktree: null,
  updatedAt: NOW,
});
const live = (seatId: string, runId: string, over: Partial<Run> = {}) => {
  store.upsertRun(run(runId, seatId, over));
  store.setSeatSession(row(seatId, runId));
};
const ctx = (seatId = "flight-1", runId = "r-flight"): McToolContext => ({ seatId, runId });
const args = (over: Record<string, unknown> = {}) => ({
  about: "GUIDO-1 on 232",
  decision: "held it back",
  basis: "its PR is not green",
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-flight-tools-"));
  store = new Store(join(dir, "mc.sqlite"));
  bus = new ChangeBus();
  seen = [];
  bus.subscribe((t) => seen.push(t));
  nowMs = NOW;
  const [t] = createFlightTools({
    config: config(),
    store,
    bus,
    supervisor: {
      message: async () => {},
      busy: () => [],
      startRun: async () => ({ runId: "", branch: "" }),
    },
    engine: null,
    fetchTicket: async () => null,
    now: () => nowMs,
  });
  if (t === undefined) throw new Error("no tool");
  tool = t;
  live("flight-1", "r-flight");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("log_decision", () => {
  it("is shown only to a role that is granted it", () => {
    expect(tool).toMatchObject({ name: "log_decision", modes: [], grantable: ["read-only"] });
  });

  it("refuses a seat that is not a watch seat", async () => {
    live("guido-1", "r-guido");
    const r = await tool.call(ctx("guido-1", "r-guido"), args());
    expect(r).toEqual({ text: MC_FLIGHT_ONLY, isError: true });
    expect(store.flightDecisions(0, 10)).toEqual([]);
  });

  it("refuses an ended or foreign run", async () => {
    store.upsertRun(run("r-flight", "flight-1", { endedAt: NOW + 1, status: "ok" }));
    expect(await tool.call(ctx(), args())).toEqual({ text: MC_RUN_ENDED, isError: true });
    expect(await tool.call(ctx("flight-1", "r-other"), args())).toEqual({
      text: MC_RUN_ENDED,
      isError: true,
    });
  });

  it("refuses bad arguments", async () => {
    for (const bad of [
      args({ about: "" }),
      args({ about: "x".repeat(FLIGHT_ABOUT_MAX + 1) }),
      args({ extra: 1 }),
      { about: "a", decision: "d" },
      args({ seat: "Not A Seat" }),
    ]) {
      const r = await tool.call(ctx(), bad);
      expect(r.isError).toBe(true);
      expect(r.text.startsWith(MC_BAD_ARGS)).toBe(true);
    }
  });

  it("records a note and emits flight", async () => {
    const r = await tool.call(ctx(), args({ seat: "guido-1" }));
    expect(r).toEqual({ text: FLIGHT_NOTED });
    expect(store.flightDecisions(0, 10)).toEqual([
      {
        id: 1,
        at: NOW,
        kind: "note",
        seatId: "guido-1",
        targetRunId: null,
        ref: null,
        questionId: null,
        about: "GUIDO-1 on 232",
        decision: "held it back",
        basis: "its PR is not green",
      },
    ]);
    expect(seen).toEqual(["flight"]);
  });

  it("refuses a seat that is not in its session", async () => {
    const r = await tool.call(ctx(), args({ seat: "nobody-9" }));
    expect(r).toEqual({
      text: "Not done: nobody-9 is not a seat in your session.",
      isError: true,
    });
    expect(store.flightDecisions(0, 10)).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("allows 60 notes an hour, then refuses the 61st", async () => {
    for (let i = 0; i < FLIGHT_NOTES_PER_HOUR; i++) {
      expect((await tool.call(ctx(), args())).isError).toBeUndefined();
    }
    const r = await tool.call(ctx(), args());
    expect(r).toEqual({
      text: "Not done: you logged notes 60 times in the last hour, the most allowed. Wait, or ask the operator.",
      isError: true,
    });
    nowMs += 61 * 60_000;
    expect((await tool.call(ctx(), args())).isError).toBeUndefined();
  });
});
