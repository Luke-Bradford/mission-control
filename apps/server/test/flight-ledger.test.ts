import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLIGHT_LEDGER_INDEX_MAX,
  FLIGHT_LEDGER_KEEP_MS,
  FLIGHT_METRICS_DAY_MS,
  type FlightLedgerEntry,
  FOR_THE_CONTROLLER,
  NEW_LOOP,
  orderLedger,
  type PullRequestView,
  type Run,
  wakeKey,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { flightMetrics, flightSummary } from "../src/flight/ledger.ts";
import { flightState } from "../src/flight/state.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const MIN = 60_000;
const config: CcConfig = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/none",
    maxSeats: 2,
    sessions: [
      {
        id: "s1",
        repoId: "mc",
        checkout: "/tmp/none/clone",
        seats: [
          { id: "flight-1", role: "FLIGHT", accountId: "main", model: "opus", area: [] },
          { id: "guido-1", role: "GUIDO", accountId: "main", model: "opus", area: [] },
        ],
      },
    ],
  },
};
const entry = (key: string, over: Partial<FlightLedgerEntry> = {}): FlightLedgerEntry => ({
  key,
  kind: "work",
  title: key,
  status: "active",
  next: null,
  owner: null,
  waitsOn: null,
  due: null,
  refs: [],
  priority: null,
  createdAt: NOW,
  updatedAt: NOW,
  outcome: null,
  basis: "ticket",
  ...over,
});
const run = (id: string, agentId: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId,
  repoId: "mc",
  seq: 1,
  startedAt: NOW - MIN,
  endedAt: null,
  status: "running",
  sessionId: null,
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
const pr = (number: number, over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "mc",
  number,
  title: `PR ${number}`,
  url: "",
  branch: `issue-${number}`,
  ticket: `mc#${number}`,
  state: "merged",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW - 3 * FLIGHT_METRICS_DAY_MS,
  updatedAt: NOW,
  mergedAt: NOW - MIN,
  headSha: null,
  mergeable: null,
  ...over,
});
let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flight-ledger-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("flightMetrics", () => {
  it("computes daily and live metrics from hub data", () => {
    const mergedAt = NOW - MIN;
    store.upsertPullRequests(
      "mc",
      [
        pr(1),
        pr(2),
        pr(3, { mergedAt: NOW - 2 * FLIGHT_METRICS_DAY_MS }),
        pr(4, { state: "open", mergedAt: null, createdAt: NOW, ci: "pending" }),
      ],
      NOW,
    );
    store.replaceFlow(
      "mc",
      [1, 2].map((number) => ({
        repoId: "mc",
        number,
        size: "M",
        startAt: mergedAt - number * 60 * MIN,
        doneAt: mergedAt,
      })),
      [],
    );
    store.upsertRun(
      run("dev", "guido-1", {
        costUsd: 1.25,
        tokens: { input: 10, output: 20, cacheRead: 30, cacheCreate: 40 },
        loop: {
          ...NEW_LOOP,
          phase: "parked",
          parked: { kind: "ci", reason: "CI failed 3 times", ended: false },
        },
      }),
    );
    store.upsertRun(
      run("flight", "flight-1", { startedAt: NOW - 2 * FLIGHT_METRICS_DAY_MS, costUsd: 0.5 }),
    );
    store.upsertRun(
      run("old", "guido-1", {
        startedAt: NOW - 2 * FLIGHT_METRICS_DAY_MS,
        costUsd: 10,
      }),
    );
    store.upsertRun(
      run("boundary", "guido-1", {
        startedAt: NOW - 2 * FLIGHT_METRICS_DAY_MS,
        endedAt: NOW - FLIGHT_METRICS_DAY_MS,
        costUsd: 5,
      }),
    );
    store.upsertRun(
      run("past", "guido-1", {
        startedAt: NOW - 2 * FLIGHT_METRICS_DAY_MS,
        endedAt: NOW - FLIGHT_METRICS_DAY_MS - 1,
        costUsd: 30,
      }),
    );
    store.upsertRun(run("other", "guido-1", { repoId: "other", costUsd: 20 }));
    store.addLoopEvent("dev:fail", "dev", "CI failed on abc1234", NOW);
    store.addLoopEvent("dev:rerun:sha", "dev", "CI failed on abc1234; re-ran lint", NOW);
    store.addLoopEvent("dev:park", "dev", "parked: CI failed 3 times", NOW);
    store.addLoopEvent("other:fail", "other", "CI failed on abc1234", NOW);
    for (const n of [1, 2])
      store.claimLine(wakeKey("flight", n), {
        runId: "flight",
        seatId: "flight-1",
        origin: "engine",
        text: "wake",
        at: NOW,
      });
    store.claimLine(wakeKey("flight", 0), {
      runId: "flight",
      seatId: "flight-1",
      origin: "engine",
      text: "old wake",
      at: NOW - 2 * FLIGHT_METRICS_DAY_MS,
    });
    store.addFlightDecision({
      at: NOW,
      kind: "note",
      seatId: "flight-1",
      targetRunId: null,
      ref: null,
      questionId: null,
      about: "Missing power",
      decision: `${FOR_THE_CONTROLLER} update`,
      basis: "operator",
    });
    const runLookup = vi.spyOn(store, "run");
    const claimsLookup = vi.spyOn(store, "claimedKeys");
    expect(flightMetrics(config, store, NOW)).toEqual({
      since: NOW - FLIGHT_METRICS_DAY_MS,
      merged: 2,
      opened: 1,
      inReview: 1,
      inCi: 1,
      ciFailures: 3,
      reruns: 1,
      parks: { day: 1, live: [{ kind: "ci", n: 1 }] },
      seats: [
        { seat: "guido-1", tokens: 100, costUsd: 16.25 },
        { seat: "flight-1", tokens: 0, costUsd: 0.5 },
      ],
      flight: { wakes: 2, costUsd: 0.5 },
      readyToMergedMin: 90,
      forTheController: 1,
    });
    expect(runLookup).not.toHaveBeenCalled();
    expect(claimsLookup.mock.calls).toEqual([["flight"]]);
  });

  it.each([
    ["ruling-rerun:sha", "FLIGHT re-ran the failed CI jobs on sha", 1, 0],
    ["ruling-rerun:sha:failed", "CI failed again on the re-run of sha", 0, 1],
    ["ruling-rerun:sha:passed", "CI passed on the re-run of sha; FLIGHT accepted the ruling", 0, 0],
    ["rerun:sha", "CI failed on sha; no run could be re-run", 0, 1],
    ["rerun:sha", "CI failed on sha; re-ran lint", 1, 1],
  ])("counts rerun activity %s (%s)", (key, text, reruns, ciFailures) => {
    const id = "dev:with:colons";
    store.upsertRun(run(id, "guido-1"));
    store.addLoopEvent(`${id}:${key}`, id, text, NOW);
    expect(flightMetrics(config, store, NOW)).toMatchObject({ reruns, ciFailures });
  });

  it("returns zeros without a session", () => {
    expect(flightMetrics({ ...config, crew: undefined }, store, NOW)).toMatchObject({
      merged: 0,
      seats: [],
      flight: { wakes: 0, costUsd: 0 },
      readyToMergedMin: null,
    });
  });
});

describe("ledger storage and summaries", () => {
  it("reports open entries omitted from the digest index", () => {
    expect(flightState({ config, store, busy: [], now: NOW }).ledgerMore).toBe(0);
    for (let n = 0; n < FLIGHT_LEDGER_INDEX_MAX + 3; n++) {
      store.putFlightLedgerEntry("s1", entry(`w${n}`), 0);
    }
    store.putFlightLedgerEntry("s1", entry("done", { status: "done" }), 0);
    store.putFlightLedgerEntry("s1", entry("dropped", { status: "dropped" }), 0);
    store.putFlightLedgerEntry("s2", entry("other"), 0);
    const state = flightState({ config, store, busy: [], now: NOW });
    expect(state.ledger).toHaveLength(FLIGHT_LEDGER_INDEX_MAX);
    expect(state.ledgerMore).toBe(3);
  });
  it("prunes only this session's closed entries older than the retention boundary", () => {
    const before = NOW - FLIGHT_LEDGER_KEEP_MS;
    store.putFlightLedgerEntry(
      "s1",
      entry("old-done", { status: "done", updatedAt: before - 1 }),
      0,
    );
    store.putFlightLedgerEntry(
      "s1",
      entry("old-dropped", { status: "dropped", updatedAt: before - 1 }),
      0,
    );
    store.putFlightLedgerEntry("s1", entry("old-open", { updatedAt: before - 1 }), 0);
    store.putFlightLedgerEntry("s1", entry("boundary", { status: "done", updatedAt: before }), 0);
    store.putFlightLedgerEntry("s2", entry("other", { status: "done", updatedAt: before - 1 }), 0);
    store.putFlightLedgerEntry("s1", entry("new"), before);
    expect(store.flightLedger("s1").map((e) => e.key)).toEqual(["boundary", "new", "old-open"]);
    expect(store.flightLedger("s2")).toHaveLength(1);
  });

  it("orders by kind, open state, priority, age and key without mutating the input", () => {
    const entries = [
      entry("watch", { kind: "watch", priority: "P0" }),
      entry("done", { status: "done", priority: "P0" }),
      entry("null"),
      entry("b", { priority: "P1" }),
      entry("a", { priority: "P1" }),
      entry("old", { priority: "P1", createdAt: NOW - MIN }),
    ];
    expect(orderLedger(entries).map((e) => e.key)).toEqual([
      "old",
      "a",
      "b",
      "null",
      "done",
      "watch",
    ]);
    expect(entries[0]?.key).toBe("watch");
  });

  it("combines pending plans and commitments by due time with undated entries last", () => {
    store.putFlightLedgerEntry("s1", entry("undated", { kind: "commitment" }), 0);
    store.putFlightLedgerEntry(
      "s1",
      entry("commitment", { kind: "commitment", due: NOW + MIN }),
      0,
    );
    store.setFlightPlans(
      "s1",
      {
        upsert: [
          {
            id: "plan",
            kind: "report",
            target: "crew",
            label: "x".repeat(100),
            status: "pending",
            dueAt: NOW,
          },
          {
            id: "cancelled",
            kind: "report",
            target: "crew",
            label: "Cancelled",
            status: "cancelled",
            dueAt: NOW - MIN,
          },
        ],
      },
      NOW,
    );
    const next = flightSummary(config, store, NOW).next;
    expect(next.map((e) => e.key)).toEqual(["plan", "commitment", "undated"]);
    expect(next[0]).toMatchObject({ kind: "plan", ageMin: 0 });
    expect(next[0]?.title).toHaveLength(80);
  });
});
