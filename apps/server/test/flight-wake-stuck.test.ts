import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FlightState, type Run, wakeStuckKey, wakeStuckText } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { flightSignals, markFlightSignalsShown } from "../src/flight/signals.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const MIN = 60_000;

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
  { id: "guido-1", loop: "build", free: true, atStop: false, area: [] },
] as unknown as FlightState["seats"];

const run = (over: Partial<Run> = {}): Run => ({
  id: "guido-1:r1",
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 60 * MIN,
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
const read = (at = NOW) => {
  const state = flightSignals({ config, store, session, seats, now: at });
  return { state, stuck: state.signals.filter((s) => s.kind === "wake_stuck") };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-wake-stuck-"));
  store = new Store(join(dir, "mc.sqlite"));
  store.upsertRun(run());
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("wake stuck", () => {
  it("raises one fact for a run whose wake failed twice running, and tells FLIGHT once", () => {
    const text = wakeStuckText("could not resume: dependencies could not be reinstalled");
    store.addLoopEvent(wakeStuckKey("guido-1:r1"), "guido-1:r1", text, NOW - MIN);
    const { state, stuck } = read();
    expect(stuck).toEqual([
      expect.objectContaining({ key: "guido-1:r1", told: false, evidence: `guido-1:r1: ${text}` }),
    ]);
    markFlightSignalsShown(store, { ...state, repo: session.repoId } as FlightState, NOW);
    expect(read(NOW + MIN).stuck).toEqual([expect.objectContaining({ told: true })]);
  });

  it("raises nothing once the run has ended", () => {
    store.addLoopEvent(wakeStuckKey("guido-1:r1"), "guido-1:r1", wakeStuckText("x"), NOW - MIN);
    store.setRunEnded("guido-1:r1", NOW, "failed", "engine");
    expect(read().stuck).toEqual([]);
  });
});
