import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLIGHT_IDLE_SEAT_WAKE_MS, type FlightState } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { flightSignals } from "../src/flight/signals.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

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

const idleFor = (ms: number) =>
  store.setSeatSession({
    seatId: "guido-1",
    runId: null,
    cliSessionId: "cli",
    state: "idle",
    reason: null,
    worktree: null,
    updatedAt: NOW - ms,
  });
const usage = (pct: number, resetAt = NOW + 3 * DAY) =>
  store.addUsage({
    accountId: "claude-main",
    window: "7d",
    at: NOW - MIN,
    pct,
    resetAt,
    source: "t",
  });
const read = (at = NOW) =>
  flightSignals({ config, store, session, seats, now: at }).signals.filter(
    (s) => s.kind === "budget_unused",
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-budget-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("budget unused", () => {
  it("raises one fact naming the account's weekly use, once per idle spell", () => {
    idleFor(FLIGHT_IDLE_SEAT_WAKE_MS);
    usage(40);
    const first = read();
    expect(first).toHaveLength(1);
    expect(first[0]?.evidence).toMatch(
      /guido-1 idle since .* claude-main has used 40% of its week/,
    );
    expect(read(NOW + MIN)).toHaveLength(1);
    expect(read(NOW + MIN)[0]?.key).toBe(first[0]?.key);
  });

  it("raises nothing for a short idle", () => {
    idleFor(FLIGHT_IDLE_SEAT_WAKE_MS - MIN);
    usage(40);
    expect(read()).toEqual([]);
  });

  it("raises nothing for an account at or past half its week", () => {
    idleFor(FLIGHT_IDLE_SEAT_WAKE_MS);
    usage(60);
    expect(read()).toEqual([]);
  });

  it("ignores a stale reading whose week has reset", () => {
    idleFor(FLIGHT_IDLE_SEAT_WAKE_MS);
    usage(10, NOW - MIN);
    expect(read()).toEqual([]);
  });
});
