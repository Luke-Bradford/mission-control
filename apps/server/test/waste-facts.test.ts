import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequestView, Run, RunLoop } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { flightSignals } from "../src/flight/signals.ts";
import { flightState } from "../src/flight/state.ts";
import {
  openWasteAlarms,
  resolveWasteAlarm,
  syncWasteAlarms,
  wasteReport,
} from "../src/spend/waste.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

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

const pr = (number: number, state: "open" | "merged" = "open"): PullRequestView => ({
  repoId: "mc",
  number,
  title: `PR ${number}`,
  url: "u",
  branch: `feature/${number}`,
  ticket: `mc#${number}`,
  state,
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW - 5 * HOUR,
  updatedAt: NOW,
  mergedAt: state === "merged" ? NOW : null,
  headSha: "h",
  mergeable: null,
});

const author = (id = "r1"): Run => ({
  id,
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 5 * HOUR,
  endedAt: null,
  status: "ok",
  sessionId: "cli",
  model: "m",
  branch: "feature/7",
  ticket: "mc#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
});

/** A review of PR `number` that reported, failing (blocking findings) or passing. */
const reported = (runId: string, number: number, round: number, blocking: number) => {
  const id = store.requestReview({
    authorRunId: runId,
    repoId: "mc",
    seatId: "retro-1",
    prNumber: number,
    sha: `sha${round}`,
    epoch: 1,
    attempt: 1,
    round,
    at: NOW - 4 * HOUR + round * MIN,
  });
  if (id === null) throw new Error("review not recorded");
  const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } })
    .db;
  db.prepare("UPDATE reviews SET state = 'reported', blocking = ?, ended_at = ? WHERE id = ?").run(
    blocking,
    NOW - 3 * HOUR + round * MIN,
    id,
  );
};

const awaiting = (): RunLoop =>
  ({ phase: "review", awaitingFlight: "sha1", prNumber: 7 }) as unknown as RunLoop;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-waste-facts-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("failed review rounds", () => {
  it("raises one alarm at two failed rounds and holds nothing", () => {
    store.upsertPullRequests("mc", [pr(7)], NOW);
    store.upsertRun(author());
    reported("r1", 7, 1, 2);
    syncWasteAlarms(config, store, NOW);
    expect(openWasteAlarms(store).filter((a) => a.check === "failed-review-rounds")).toEqual([]);
    reported("r1", 7, 2, 1);
    reported("r1", 7, 3, 0); // a passing round is not a failed one
    expect(syncWasteAlarms(config, store, NOW)).toBe(true);
    const alarms = openWasteAlarms(store).filter((a) => a.check === "failed-review-rounds");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ level: 2, ticket: "mc#7", repoId: "mc" });
    // unchanged facts: no second alarm, nothing changes
    expect(syncWasteAlarms(config, store, NOW + MIN)).toBe(false);
    expect(openWasteAlarms(store).filter((a) => a.check === "failed-review-rounds")).toHaveLength(
      1,
    );
  });

  it("ignores a merged PR", () => {
    store.upsertPullRequests("mc", [pr(7, "merged")], NOW);
    store.upsertRun(author());
    reported("r1", 7, 1, 2);
    reported("r1", 7, 2, 2);
    syncWasteAlarms(config, store, NOW);
    expect(openWasteAlarms(store).filter((a) => a.check === "failed-review-rounds")).toEqual([]);
  });

  it("puts the count of failed rounds on the PR in FLIGHT's state", () => {
    store.upsertPullRequests("mc", [pr(7)], NOW);
    store.upsertRun(author());
    reported("r1", 7, 1, 2);
    reported("r1", 7, 2, 1);
    const state = flightState({ config, store, busy: [], now: NOW });
    expect(state.prs.find((p) => p.pr === 7)?.reviewRounds).toBe(2);
  });

  it("wakes FLIGHT once for the alarm", () => {
    store.upsertPullRequests("mc", [pr(7)], NOW);
    store.upsertRun(author());
    reported("r1", 7, 1, 2);
    reported("r1", 7, 2, 1);
    syncWasteAlarms(config, store, NOW);
    const read = (at: number) =>
      flightSignals({ config, store, session, seats: [], now: at }).signals.filter(
        (s) => s.kind === "waste_alarm",
      );
    expect(read(NOW)).toHaveLength(1);
    expect(read(NOW + MIN)).toHaveLength(1);
    expect(read(NOW + MIN)[0]?.key).toBe(read(NOW)[0]?.key);
  });
});

describe("clearance waiting", () => {
  const hold = (since: number) => {
    store.upsertRun(author());
    store.setRunLoop("r1", awaiting(), since);
  };

  it("raises an alarm at two hours and not before", () => {
    hold(NOW - 2 * HOUR + MIN);
    syncWasteAlarms(config, store, NOW);
    expect(openWasteAlarms(store).filter((a) => a.check === "clearance-waiting")).toEqual([]);
    syncWasteAlarms(config, store, NOW + MIN);
    const alarms = openWasteAlarms(store).filter((a) => a.check === "clearance-waiting");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ ticket: "mc#7", runId: "r1", level: 2 });
    expect(alarms[0]?.evidence).toMatch(/waited 2 hours on FLIGHT's clearance/);
    expect(syncWasteAlarms(config, store, NOW + 2 * MIN)).toBe(false);
  });

  it("shows on the waste route from 24 hours, and closes when cleared", () => {
    hold(NOW - 3 * HOUR);
    syncWasteAlarms(config, store, NOW);
    expect(wasteReport(config, store, NOW).alarms.map((a) => a.check)).not.toContain(
      "clearance-waiting",
    );
    syncWasteAlarms(config, store, NOW + 21 * HOUR);
    expect(
      wasteReport(config, store, NOW + 21 * HOUR).alarms.find(
        (a) => a.check === "clearance-waiting",
      ),
    ).toMatchObject({ level: 24 });
    store.setRunLoop("r1", { phase: "ci" } as unknown as RunLoop, NOW + 22 * HOUR);
    syncWasteAlarms(config, store, NOW + 22 * HOUR);
    expect(openWasteAlarms(store).filter((a) => a.check === "clearance-waiting")).toEqual([]);
  });

  it("wakes FLIGHT once while the wait stands", () => {
    hold(NOW - 3 * HOUR);
    syncWasteAlarms(config, store, NOW);
    syncWasteAlarms(config, store, NOW + HOUR);
    const signals = flightSignals({ config, store, session, seats: [], now: NOW + HOUR }).signals;
    expect(signals.filter((s) => s.kind === "waste_alarm")).toHaveLength(1);
  });

  it("wakes FLIGHT once for each head: a new head restarts the two hours", () => {
    const keys = (at: number) =>
      flightSignals({ config, store, session, seats: [], now: at })
        .signals.filter((s) => s.kind === "waste_alarm" && s.evidence.includes("clearance"))
        .map((s) => s.key)
        .sort();
    const open = () => openWasteAlarms(store).filter((a) => a.check === "clearance-waiting");
    hold(NOW - 3 * HOUR);
    syncWasteAlarms(config, store, NOW);
    const first = keys(NOW);
    expect(first).toHaveLength(1);
    // the level grows from 3 to 4 hours: the same fact, not a new wake
    syncWasteAlarms(config, store, NOW + HOUR);
    expect(keys(NOW + HOUR)).toEqual(first);
    // a new head: the wait starts over, so the old head's alarm closes and nothing is raised
    store.setRunLoop(
      "r1",
      { phase: "review", awaitingFlight: "sha2", prNumber: 7 } as unknown as RunLoop,
      NOW + 2 * HOUR,
    );
    syncWasteAlarms(config, store, NOW + 3 * HOUR);
    expect(open()).toEqual([]);
    // two hours on the new head: one new fact, then quiet as its level grows
    syncWasteAlarms(config, store, NOW + 4 * HOUR + 2 * MIN);
    const second = keys(NOW + 4 * HOUR + 2 * MIN);
    expect(second.filter((k) => !first.includes(k))).toHaveLength(1);
    syncWasteAlarms(config, store, NOW + 6 * HOUR);
    expect(keys(NOW + 6 * HOUR)).toEqual(second);
  });

  it("a resolved alarm on one head does not silence the next head", () => {
    hold(NOW - 6 * HOUR);
    syncWasteAlarms(config, store, NOW);
    const a1 = openWasteAlarms(store).find((a) => a.check === "clearance-waiting");
    if (a1 === undefined) throw new Error("no alarm");
    resolveWasteAlarm(store, a1.id, NOW, "b");
    store.setRunLoop(
      "r1",
      { phase: "review", awaitingFlight: "sha2", prNumber: 7 } as unknown as RunLoop,
      NOW + MIN,
    );
    for (let t = NOW + 2 * MIN; t <= NOW + 3 * HOUR; t += 10 * MIN)
      syncWasteAlarms(config, store, t);
    expect(openWasteAlarms(store).filter((a) => a.check === "clearance-waiting")).toHaveLength(1);
  });
});
