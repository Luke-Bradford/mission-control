import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLIGHT_HOUR_MS,
  FLIGHT_RUNAWAY,
  FLIGHT_RUNAWAY_NOTE_KEY,
  FLIGHT_RUNAWAY_SETTING,
  type FlightDecision,
  RUNAWAY_LIFTED_DECISION,
  runawaySameReason,
  runawayWritesReason,
} from "@mc/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import { liftRunaway, runawayReason, runawayTrip, watchRunaway } from "../src/flight/runaway.ts";
import { Store } from "../src/store.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const decision = (over: Partial<FlightDecision> = {}): Omit<FlightDecision, "id"> => ({
  at: NOW - 1000,
  kind: "message",
  seatId: null,
  targetRunId: null,
  ref: null,
  questionId: null,
  about: "a",
  decision: "d",
  basis: "b",
  ...over,
});

let store: Store;
let bus: ChangeBus;
beforeEach(() => {
  store = new Store(join(mkdtempSync(join(tmpdir(), "mc-flight-runaway-")), "mc.sqlite"));
  bus = new ChangeBus();
});

describe("runawayReason", () => {
  const rows = (n: number, over: (i: number) => Partial<FlightDecision>): FlightDecision[] =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, ...decision(over(i)) }));

  it("is quiet for a busy but varied hour", () => {
    expect(
      runawayReason(
        rows(200, (i) => ({ about: `a${i}` })),
        NOW,
      ),
    ).toBeNull();
  });

  it("trips on more than 200 write decisions in an hour", () => {
    expect(
      runawayReason(
        rows(201, (i) => ({ about: `a${i}`, at: NOW - i * 10_000 })),
        NOW,
      ),
    ).toBe(runawayWritesReason(201));
  });

  it("counts briefs with the decisions", () => {
    expect(
      runawayReason(
        rows(150, (i) => ({ about: `a${i}` })),
        NOW,
        51,
      ),
    ).toBe(runawayWritesReason(201));
  });

  it("trips on the same action on the same target 5 times in 30 minutes", () => {
    expect(
      runawayReason(
        rows(4, () => ({ kind: "end", ref: "mc#7" })),
        NOW,
      ),
    ).toBeNull();
    expect(
      runawayReason(
        rows(5, () => ({ kind: "end", ref: "mc#7" })),
        NOW,
      ),
    ).toBe(runawaySameReason("end", "mc#7", 5));
  });

  it("does not trip on five spread over more than 30 minutes, or on different targets or actions", () => {
    expect(
      runawayReason(
        rows(5, (i) => ({ kind: "end", ref: "mc#7", at: NOW - i * 10 * MIN })),
        NOW,
      ),
    ).toBeNull();
    expect(
      runawayReason(
        rows(5, (i) => ({ kind: "end", ref: `mc#${i}` })),
        NOW,
      ),
    ).toBeNull();
    expect(
      runawayReason(
        rows(5, (i) => ({ kind: i % 2 ? "end" : "sync", ref: "mc#7" })),
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores its own hub rows and rows older than an hour", () => {
    expect(
      runawayReason(
        rows(9, () => ({ kind: "hub" })),
        NOW,
      ),
    ).toBeNull();
    expect(
      runawayReason(
        rows(250, (i) => ({ about: `a${i}`, at: NOW - FLIGHT_HOUR_MS - 1 - i })),
        NOW,
      ),
    ).toBeNull();
  });
});

describe("the breaker", () => {
  const writes = (n: number, over: Partial<FlightDecision> = {}) => {
    for (let i = 0; i < n; i++) store.addFlightDecision(decision(over));
  };

  it("does nothing while FLIGHT works normally", () => {
    writes(4, { kind: "end", ref: "mc#7" });
    watchRunaway(store, bus, NOW);
    expect(runawayTrip(store)).toBeNull();
    expect(store.notes()).toEqual([]);
  });

  it("trips once on 5 identical actions: stores the trip, logs it and raises one operator flag", () => {
    const seen: string[] = [];
    bus.subscribe((t) => seen.push(t));
    writes(FLIGHT_RUNAWAY.sameActionLimit, { kind: "end", ref: "mc#7" });
    watchRunaway(store, bus, NOW);
    watchRunaway(store, bus, NOW + 1);
    expect(runawayTrip(store)).toEqual({ at: NOW, reason: runawaySameReason("end", "mc#7", 5) });
    const flags = store.notes().filter((n) => n.key === FLIGHT_RUNAWAY_NOTE_KEY);
    expect(flags).toMatchObject([{ kind: "flag", repoId: null, runId: null }]);
    expect(flags[0]?.text).toContain(runawaySameReason("end", "mc#7", 5));
    expect(store.flightDecisions(0, 20).filter((d) => d.kind === "hub")).toHaveLength(1);
    expect(seen).toContain("attention");
  });

  it("treats an unreadable stored trip as tripped", () => {
    store.setSetting(FLIGHT_RUNAWAY_SETTING, "not json");
    expect(runawayTrip(store)).not.toBeNull();
  });

  it("lifts only when tripped, clearing the flag and logging the lift", () => {
    expect(liftRunaway(store, bus, NOW)).toBe(false);
    writes(5, { kind: "end", ref: "mc#7" });
    watchRunaway(store, bus, NOW);
    expect(liftRunaway(store, bus, NOW + 5)).toBe(true);
    expect(runawayTrip(store)).toBeNull();
    expect(store.notes().some((n) => n.key === FLIGHT_RUNAWAY_NOTE_KEY)).toBe(false);
    expect(store.flightDecisions(0, 20).filter((d) => d.kind === "hub")[0]).toMatchObject({
      decision: RUNAWAY_LIFTED_DECISION,
    });
  });
});
