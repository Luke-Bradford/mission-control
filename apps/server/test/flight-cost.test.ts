import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMS_CAPCOM,
  FLIGHT_BATCH_MS,
  FLIGHT_CONTEXT_ROTATE_TOKENS,
  type Run,
  type RunDigest,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flightWakeCost, flightWakeWaits } from "../src/flight/cost.ts";
import { routineOnly, unhandledReasons, wakeReasons } from "../src/flight/state.ts";
import { Store } from "../src/store.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = 1_793_000_000_000;

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-flight-cost-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (id: string, agentId: string, costUsd: number, over: Partial<Run> = {}): Run => ({
  id,
  agentId,
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 2 * DAY,
  endedAt: NOW - 1,
  status: "ok",
  sessionId: "cli",
  model: "opus",
  branch: null,
  ticket: null,
  costUsd,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
  ...over,
});
const usage = (runId: string, entries: [number, number][]) =>
  store.setDigest(runId, {
    attemptUsage: entries.map(([at, tokens], i) => ({ id: `m${i}`, at, tokens })),
  } as RunDigest);

describe("what FLIGHT costs, per day and per wake reason", () => {
  it("splits a run's cost over its wakes by tokens, and a wake's cost over its reasons", () => {
    store.upsertRun(run("r-f", "flight-1", 10));
    store.upsertRun(run("r-g", "guido-1", 40));
    const t1 = NOW - 30 * MIN;
    const t2 = NOW - 10 * MIN;
    store.addFlightWake("r-f", t1, ["items", "free"]);
    store.addFlightWake("r-f", t2, ["q"]);
    // 25% of the tokens before the first wake (the start brief), 25% after t1, 50% after t2
    usage("r-f", [
      [NOW - 40 * MIN, 100],
      [t1 + MIN, 100],
      [t2 + MIN, 200],
    ]);
    const cost = flightWakeCost(store, NOW, "flight-1", new Set(["flight-1", "guido-1"]));
    expect(cost.totalUsd).toBeCloseTo(10);
    expect(cost.crewUsd).toBeCloseTo(50);
    expect(cost.share).toBeCloseTo(0.2);
    const by = Object.fromEntries(cost.byReason.map((r) => [r.reason, r.usd]));
    expect(by).toMatchObject({ start: 2.5, q: 5 });
    expect(by.items).toBeCloseTo(1.25);
    expect(by.free).toBeCloseTo(1.25);
    expect(cost.byDay.reduce((n, d) => n + d.usd, 0)).toBeCloseTo(10);
    expect(cost.byReason.reduce((n, r) => n + r.usd, 0)).toBeCloseTo(10);
  });

  it("gives a share of null when the crew spent nothing", () => {
    expect(flightWakeCost(store, NOW, "flight-1", new Set(["flight-1"])).share).toBeNull();
  });
});

describe("how long an operator message or a blocker waits for a wake", () => {
  it("takes the median wait to the first wake after each, per day", () => {
    store.addFlightWake("r-f", NOW - 50 * MIN, ["q"]);
    store.addFlightWake("r-f", NOW - 20 * MIN, ["q"]);
    const send = (at: number, from: string, label: "blocker" | null = null) =>
      store.addComms({
        at,
        from,
        to: "flight-1",
        ticket: null,
        text: "x",
        ...(label ? { label } : {}),
      });
    send(NOW - 55 * MIN, COMMS_CAPCOM); // waits 5
    send(NOW - 45 * MIN, COMMS_CAPCOM); // waits 25
    send(NOW - 40 * MIN, COMMS_CAPCOM); // waits 20
    send(NOW - 30 * MIN, "guido-1", "blocker"); // waits 10
    send(NOW - 29 * MIN, "guido-1"); // neither
    const waits = flightWakeWaits(store, NOW, "flight-1");
    expect(waits.operatorMedianMs).toBe(20 * MIN);
    expect(waits.blockerMedianMs).toBe(10 * MIN);
    expect(waits.byDay.at(-1)).toMatchObject({ operatorN: 3, blockerN: 1 });
  });
});

describe("the handover threshold", () => {
  it("is 150K tokens", () => {
    expect(FLIGHT_CONTEXT_ROTATE_TOKENS).toBe(150_000);
  });
});

describe("routine wakes wait for the batch window", () => {
  const facts = (o: Record<string, unknown[]>) => JSON.stringify(o);
  it("treats a free seat or a PR item alone as routine", () => {
    expect(routineOnly(facts({}), facts({ free: ["guido-1"], t: ["mc#1"] }))).toBe(true);
    expect(routineOnly(facts({}), facts({ items: ["pr:mc#7:text"] }))).toBe(true);
  });
  it("never batches an operator message, a question, a blocker, a signal or the breaker", () => {
    for (const o of [
      { discussions: [[1, [2]]] },
      { q: [3] },
      { triage: ["mc#1:new"] },
      { signals: ["main_red:abc"] },
      { breaker: ["tripped"] },
      { items: ["comms-open:5"] },
      { parked: ["guido-1:mc#1:review-failed"] },
      { instructions: ["2"] },
    ])
      expect(routineOnly(facts({}), facts({ free: ["guido-1"], ...o }))).toBe(false);
  });
  it("is not routine when nothing changed", () => {
    expect(routineOnly(facts({ free: ["a"] }), facts({ free: ["a"] }))).toBe(false);
  });
  it("has a window of fifteen minutes", () => {
    expect(FLIGHT_BATCH_MS).toBe(15 * MIN);
  });
});

describe("wakes that ended in nothing are handled by a wait on their exact key", () => {
  const wait = (target: string, at: number) =>
    store.addFlightDecision({
      at,
      kind: "wait",
      seatId: null,
      targetRunId: null,
      ref: null,
      questionId: null,
      about: `${target}: waiting on a thing`,
      decision: "waiting until later",
      basis: "b",
    });
  it("a wait on a repeat_park key with spaces handles the signal", () => {
    const key = "mc#9:review failed on the same file";
    const facts = JSON.stringify({ signals: [`repeat_park:${key}`] });
    const reasons = wakeReasons("", facts);
    expect(unhandledReasons(store, reasons, NOW, new Set(reasons.map((r) => r.id)))).toHaveLength(
      1,
    );
    wait(key, NOW + MIN);
    expect(unhandledReasons(store, reasons, NOW, new Set(reasons.map((r) => r.id)))).toHaveLength(
      0,
    );
  });
  it("a wait on an item's full key handles its item_stale signal", () => {
    const item = "message:guido-1:stream:guido-1:20261105T020751Z:271748:0";
    const refs = [{ key: item, ticket: null }];
    const facts = JSON.stringify({
      signals: ["item_stale:message:guido-1:stream:guido-1:20261105T020751Z:271748"],
    });
    const reasons = wakeReasons("", facts, refs);
    wait(item, NOW + MIN);
    expect(unhandledReasons(store, reasons, NOW, new Set(reasons.map((r) => r.id)))).toHaveLength(
      0,
    );
  });
});
