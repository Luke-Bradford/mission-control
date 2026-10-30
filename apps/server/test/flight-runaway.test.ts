import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLIGHT_HOUR_MS,
  FLIGHT_RUNAWAY,
  FLIGHT_RUNAWAY_NOTE_KEY,
  FLIGHT_RUNAWAY_SETTING,
  RUNAWAY_LIFTED_DECISION,
  runawaySameReason,
  runawayWritesReason,
} from "@mc/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import {
  isReadCall,
  liftRunaway,
  recordWrite,
  runawayReason,
  runawayTrip,
  type WriteEvent,
  watchRunaway,
  writeTarget,
} from "../src/flight/runaway.ts";
import { Store } from "../src/store.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

let store: Store;
let bus: ChangeBus;
beforeEach(() => {
  store = new Store(join(mkdtempSync(join(tmpdir(), "mc-flight-runaway-")), "mc.sqlite"));
  bus = new ChangeBus();
});

const events = (n: number, over: (i: number) => Partial<WriteEvent> = () => ({})): WriteEvent[] =>
  Array.from({ length: n }, (_, i) => ({
    at: NOW - 1000,
    action: "end_run",
    target: "k",
    ...over(i),
  }));
const write = (n: number, over: (i: number) => Partial<WriteEvent> = () => ({})) => {
  for (const e of events(n, over)) recordWrite(store, e);
};

describe("runawayReason", () => {
  it("is quiet for a busy but varied hour", () => {
    expect(
      runawayReason(
        events(200, (i) => ({ target: `k${i}` })),
        NOW,
      ),
    ).toBeNull();
  });

  it("trips on more than 200 write events in an hour, whatever the tool", () => {
    expect(
      runawayReason(
        events(201, (i) => ({ action: `t${i % 7}`, target: `k${i}`, at: NOW - i * 10_000 })),
        NOW,
      ),
    ).toBe(runawayWritesReason(201));
  });

  it("trips on the same action on the same target 5 times in 30 minutes", () => {
    expect(runawayReason(events(4), NOW)).toBeNull();
    expect(runawayReason(events(5), NOW)).toBe(runawaySameReason("end_run", "k", 5));
  });

  it("does not trip on five spread over more than 30 minutes, or on other targets or actions", () => {
    expect(
      runawayReason(
        events(5, (i) => ({ at: NOW - i * 10 * MIN })),
        NOW,
      ),
    ).toBeNull();
    expect(
      runawayReason(
        events(5, (i) => ({ target: `k${i}` })),
        NOW,
      ),
    ).toBeNull();
    expect(
      runawayReason(
        events(5, (i) => ({ action: i % 2 ? "end_run" : "sync_main" })),
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores events older than an hour", () => {
    expect(
      runawayReason(
        events(250, (i) => ({ target: `k${i}`, at: NOW - FLIGHT_HOUR_MS - 1 - i })),
        NOW,
      ),
    ).toBeNull();
  });
});

describe("writeTarget", () => {
  it("is the arguments without the basis, in a stable order", () => {
    expect(writeTarget("end_run", { runId: "r-1", basis: "one" })).toBe(
      writeTarget("end_run", { basis: "two", runId: "r-1" }),
    );
    expect(writeTarget("message_seat", { seat: "g", text: "a" })).not.toBe(
      writeTarget("message_seat", { seat: "g", text: "b" }),
    );
    expect(writeTarget("end_run", undefined)).toBe("{}");
  });

  it("is the ticket moved for a queue reorder, whatever it moved above", () => {
    const a = { action: "queue-reorder", seat: "g", move: "mc#2", above: "mc#1", basis: "b" };
    expect(writeTarget("promote", a)).toBe("mc#2");
    expect(writeTarget("promote", { ...a, above: "mc#9", seat: "i" })).toBe("mc#2");
  });
});

describe("isReadCall", () => {
  it("counts read tools, focus reads and nothing else as reads", () => {
    expect(isReadCall("read_pr", {})).toBe(true);
    expect(isReadCall("message_seat", { seat: "g", read_focus: true })).toBe(true);
    expect(isReadCall("message_seat", { seat: "g", text: "hi" })).toBe(false);
    expect(isReadCall("screenshot_hud", { page: "/" })).toBe(false);
  });
});

describe("bookkeeping", () => {
  it("counts toward the hourly total but never trips the repeat rule", () => {
    for (const action of ["track", "untrack", "log_decision", "update_brief", "remember", "forget"])
      expect(
        runawayReason(
          events(9, () => ({ action })),
          NOW,
        ),
      ).toBeNull();
    expect(
      runawayReason(
        events(201, (i) => ({ action: "track", target: `k${i}` })),
        NOW,
      ),
    ).toBe(runawayWritesReason(201));
  });

  it("does not exempt other tools", () => {
    expect(
      runawayReason(
        events(5, () => ({ action: "message_seat" })),
        NOW,
      ),
    ).toBe(runawaySameReason("message_seat", "k", 5));
  });
});

describe("the breaker", () => {
  it("does nothing while FLIGHT works normally", () => {
    write(4);
    watchRunaway(store, bus, NOW);
    expect(runawayTrip(store)).toBeNull();
    expect(store.notes()).toEqual([]);
  });

  it("trips once on 5 identical writes: stores the trip, logs it and raises one operator flag", () => {
    const seen: string[] = [];
    bus.subscribe((t) => seen.push(t));
    write(FLIGHT_RUNAWAY.sameActionLimit);
    watchRunaway(store, bus, NOW);
    watchRunaway(store, bus, NOW + 1);
    expect(runawayTrip(store)).toEqual({ at: NOW, reason: runawaySameReason("end_run", "k", 5) });
    const flags = store.notes().filter((n) => n.key === FLIGHT_RUNAWAY_NOTE_KEY);
    expect(flags).toMatchObject([{ kind: "flag", repoId: null, runId: null }]);
    expect(flags[0]?.text).toContain(runawaySameReason("end_run", "k", 5));
    expect(store.flightDecisions(0, 20).filter((d) => d.kind === "hub")).toHaveLength(1);
    expect(seen).toContain("attention");
  });

  it("treats an unreadable stored trip as tripped", () => {
    store.setSetting(FLIGHT_RUNAWAY_SETTING, "not json");
    expect(runawayTrip(store)).not.toBeNull();
  });

  it("lifts only when tripped, clearing the flag and logging the lift", () => {
    expect(liftRunaway(store, bus, NOW)).toBe(false);
    write(5);
    watchRunaway(store, bus, NOW);
    expect(liftRunaway(store, bus, NOW + 5)).toBe(true);
    expect(runawayTrip(store)).toBeNull();
    expect(store.notes().some((n) => n.key === FLIGHT_RUNAWAY_NOTE_KEY)).toBe(false);
    expect(store.flightDecisions(0, 20).filter((d) => d.kind === "hub")[0]).toMatchObject({
      decision: RUNAWAY_LIFTED_DECISION,
    });
  });

  it("stays clear after a lift: the old history does not trip it again", () => {
    write(5);
    watchRunaway(store, bus, NOW);
    expect(liftRunaway(store, bus, NOW + 1)).toBe(true);
    recordWrite(store, { at: NOW + 2, action: "end_run", target: "r-9" });
    watchRunaway(store, bus, NOW + 2);
    expect(runawayTrip(store)).toBeNull();
    expect(store.notes()).toEqual([]);
    // a fresh loop after the lift trips it again
    write(5, () => ({ at: NOW + 3 }));
    watchRunaway(store, bus, NOW + 3);
    expect(runawayTrip(store)).not.toBeNull();
  });
});
