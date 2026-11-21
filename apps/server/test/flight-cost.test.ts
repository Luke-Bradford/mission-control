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
import { recordSeatCall } from "../src/flight/signals.ts";
import { onlySettled, urgentChange } from "../src/flight/state.ts";
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

  it("reads the last week alone as weekShare, apart from the blended share", () => {
    const early = NOW - 10 * DAY;
    store.upsertRun(run("r-f1", "flight-1", 40, { startedAt: early - DAY, endedAt: early + DAY }));
    store.upsertRun(run("r-g1", "guido-1", 60, { startedAt: early - DAY, endedAt: early + DAY }));
    usage("r-f1", [[early, 100]]);
    store.upsertRun(
      run("r-f2", "flight-1", 10, { startedAt: NOW - 3 * DAY, endedAt: NOW - 1 * DAY }),
    );
    store.upsertRun(
      run("r-g2", "guido-1", 40, { startedAt: NOW - 3 * DAY, endedAt: NOW - 1 * DAY }),
    );
    usage("r-f2", [[NOW - 2 * DAY, 100]]);
    const cost = flightWakeCost(store, NOW, "flight-1", new Set(["flight-1", "guido-1"]));
    expect(cost.share).toBeCloseTo(50 / 150);
    expect(cost.weekShare).toBeCloseTo(0.2);
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

describe("how long FLIGHT took to see a blocker", () => {
  it("ends the wait at FLIGHT's first message after it when that comes before the next wake", () => {
    store.upsertRun(run("r-f", "flight-1", 5));
    usage("r-f", [[NOW - 60 * MIN + 10_000, 10]]);
    store.addFlightWake("r-f", NOW - 20 * MIN, ["q"]);
    store.addComms({
      at: NOW - 60 * MIN,
      from: "guido-1",
      to: "flight-1",
      ticket: null,
      text: "x",
      label: "blocker",
    });
    expect(flightWakeWaits(store, NOW, "flight-1").blockerMedianMs).toBe(10_000);
  });

  it("counts a seat's call to FLIGHT as a blocker", () => {
    store.addFlightWake("r-f", NOW - 30 * MIN, ["signals"]);
    recordSeatCall(store, "mc", {
      seat: "guido-1",
      ref: null,
      reason: "stuck",
      at: NOW - 40 * MIN,
    });
    expect(flightWakeWaits(store, NOW, "flight-1", "mc").blockerMedianMs).toBe(10 * MIN);
  });
});

describe("seat calls older than a week", () => {
  it("still count in the wait figures", () => {
    const at = NOW - 8 * DAY;
    store.addFlightWake("r-f", at + 60_000, ["signals"]);
    recordSeatCall(store, "mc", { seat: "guido-1", ref: null, reason: "stuck", at });
    expect(flightWakeWaits(store, NOW, "flight-1", "mc").blockerMedianMs).toBe(60_000);
  });
});

describe("the handover threshold", () => {
  it("is 150K tokens", () => {
    expect(FLIGHT_CONTEXT_ROTATE_TOKENS).toBe(150_000);
  });
});

describe("failures wait for the gap; messages and questions do not", () => {
  const facts = (o: Record<string, unknown[]>) => JSON.stringify(o);
  it("treats an operator message, a question, an instruction or a plan as urgent", () => {
    for (const o of [
      { operator: ["12"] },
      { owed: ["3"] },
      { q: [3] },
      { instructions: ["2"] },
      { planned: [["p1"]] },
      { retrospective: ["2026-10-24"] },
    ] as Record<string, unknown[]>[])
      expect(urgentChange(facts({}), facts(o))).toBe(true);
  });
  it("waits for the gap on a failure, a blocker or a signal", () => {
    for (const o of [
      { triage: ["mc#1:new"] },
      { signals: ["main_red:abc"] },
      { breaker: ["tripped"] },
      { items: ["comms-open:5"] },
      { parked: ["guido-1:mc#1:review-failed"] },
      { stopped: ["guido-1"] },
    ] as Record<string, unknown[]>[])
      expect(urgentChange(facts({}), facts(o))).toBe(false);
  });
  it("does not call an answered question or a message already known a new one", () => {
    expect(urgentChange(facts({ q: [3] }), facts({ q: [] }))).toBe(false);
    expect(urgentChange(facts({ operator: ["12"] }), facts({ operator: ["12"] }))).toBe(false);
  });
  it("does not call a lifted breaker settled", () => {
    expect(onlySettled(facts({ breaker: ["x"] }), facts({ breaker: [] }))).toBe(false);
    expect(onlySettled(facts({ q: [3] }), facts({ q: [] }))).toBe(true);
  });
  it("has a gap of thirty minutes, so failures wake FLIGHT twice an hour at most", () => {
    expect(FLIGHT_BATCH_MS).toBe(30 * MIN);
  });
});
