import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WasteCheck, WasteFinding } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wasteAlarmRows } from "../src/code-health/waste-rows.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const HOUR = 3_600_000;

describe("Audit Do next: waste alarm rows", () => {
  let root: string;
  let store: Store;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-waste-rows-"));
    store = new Store(join(root, "fixture.sqlite"));
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const finding = (check: WasteCheck, over: Partial<WasteFinding> = {}): WasteFinding => ({
    check,
    subject: "sample#1",
    repoId: "sample",
    ticket: "sample#1",
    seatId: null,
    runId: null,
    level: 4,
    evidence: `evidence for ${check}`,
    ...over,
  });
  const open = (f: WasteFinding, at = NOW - HOUR) => store.waste.insertAlarm(f, at);

  it("projects each of the six alarm families with scope, evidence, measure, threshold, owner and state", () => {
    open(finding("cost-without-output", { level: 4, runId: "r1" }));
    open(
      finding("coordination-overhead", {
        subject: "flight-1",
        ticket: null,
        seatId: "flight-1",
        level: 31,
      }),
    );
    open(finding("ticket-churn", { subject: "sample:day", ticket: null, level: 6 }));
    open(finding("runs-per-ticket", { subject: "sample#2", ticket: "sample#2", level: 5 }));
    open(
      finding("failed-review-rounds", {
        subject: "sample#9",
        ticket: "sample#3",
        runId: "r9",
        level: 2,
      }),
    );
    open(
      finding("clearance-waiting", { subject: "r4@abc", runId: "r4", seatId: "dev-1", level: 30 }),
    );
    const rows = wasteAlarmRows(store, "sample", NOW);
    expect(rows.map((r) => r.check).sort()).toEqual(
      [
        "clearance-waiting",
        "coordination-overhead",
        "cost-without-output",
        "failed-review-rounds",
        "runs-per-ticket",
        "ticket-churn",
      ].sort(),
    );
    for (const row of rows) {
      expect(row.evidence).toBe(`evidence for ${row.check}`);
      expect(row.threshold.length).toBeGreaterThan(0);
      expect(row.owner).toBe("FLIGHT");
      expect(row.state).toBe("open");
      expect(row.title.length).toBeGreaterThan(0);
    }
    const cost = rows.find((r) => r.check === "cost-without-output");
    expect(cost?.measure).toEqual({ value: 4, unit: "x the median cost of its size" });
    expect(rows.find((r) => r.check === "coordination-overhead")?.measure).toEqual({
      value: 31,
      unit: "USD FLIGHT spent in a day",
    });
  });

  it("keeps only open alarms of the repo asked for, and the clearance wait only from a day", () => {
    open(finding("runs-per-ticket", { repoId: "other", subject: "other#1", ticket: "other#1" }));
    open(finding("clearance-waiting", { subject: "r5@a", level: 3 }));
    expect(wasteAlarmRows(store, "sample", NOW)).toEqual([]);
  });

  it("gives one row per alarm cause, and the same identity when it recurs", () => {
    const a = open(finding("runs-per-ticket", { level: 4 }));
    // a stray second open alarm for the same cause still gives one row, the worse one
    open(finding("runs-per-ticket", { level: 6, evidence: "worse" }), NOW - 1);
    const rows = wasteAlarmRows(store, "sample", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.measure.value).toBe(6);
    const id = rows[0]?.id;
    // cleared: leaves the open rows
    for (const alarm of store.waste.alarms("WHERE closed_at IS NULL"))
      store.waste.closeAlarm(alarm.id, NOW);
    expect(a).toBeGreaterThan(0);
    expect(wasteAlarmRows(store, "sample", NOW)).toEqual([]);
    // recurrence: a new alarm for the same cause returns as the same identity
    open(finding("runs-per-ticket", { level: 5 }), NOW);
    expect(wasteAlarmRows(store, "sample", NOW).map((r) => r.id)).toEqual([id]);
    const live = store.waste.alarms("WHERE closed_at IS NULL")[0];
    expect(store.waste.resolveAlarm(live?.id ?? 0, NOW, "basis")).toBe(true);
    expect(wasteAlarmRows(store, "sample", NOW)).toEqual([]);
  });

  it("shows an unrecorded cost as unknown, never zero", () => {
    open(finding("cost-without-output", { level: 4 }));
    open(
      finding("coordination-overhead", {
        subject: "flight-1",
        ticket: null,
        seatId: "flight-1",
        level: 31,
      }),
    );
    open(finding("runs-per-ticket", { subject: "sample#2", ticket: "sample#2" }));
    const rows = wasteAlarmRows(store, "sample", NOW);
    const cost = (check: string) => rows.find((r) => r.check === check)?.costUsd;
    expect(cost("cost-without-output")).toBeNull();
    expect(cost("runs-per-ticket")).toBeNull();
    // FLIGHT's dollars are the alarm's own figure
    expect(cost("coordination-overhead")).toBe(31);
  });

  it("names what a ticket-churn alarm counts by its cause", () => {
    open(finding("ticket-churn", { subject: "sample#4:restarted", ticket: "sample#4", level: 2 }));
    open(finding("ticket-churn", { subject: "sample#5:split", ticket: "sample#5", level: 1 }));
    open(finding("ticket-churn", { subject: "sample:day", ticket: null, level: 6 }));
    const unit = (id: string) =>
      wasteAlarmRows(store, "sample", NOW).find((r) => r.id === id)?.measure.unit;
    expect(unit("ticket-churn:sample#4:restarted")).toBe("runs since it was parked");
    expect(unit("ticket-churn:sample#5:split")).toBe("ticket that reads as split work");
    expect(unit("ticket-churn:sample:day")).toBe("tickets opened in a day");
  });

  it("takes ticket, run and seat from the alarm's own record", () => {
    open(
      finding("clearance-waiting", {
        subject: "r4@abc",
        ticket: "sample#7",
        runId: "r4",
        seatId: "dev-1",
        level: 30,
      }),
    );
    open(finding("ticket-churn", { subject: "sample:day", ticket: null, level: 6 }));
    const rows = wasteAlarmRows(store, "sample", NOW);
    expect(rows.find((r) => r.check === "clearance-waiting")?.scope).toEqual({
      repoId: "sample",
      ticket: "sample#7",
      runId: "r4",
      seatId: "dev-1",
    });
    expect(rows.find((r) => r.check === "ticket-churn")?.scope).toEqual({
      repoId: "sample",
      ticket: null,
      runId: null,
      seatId: null,
    });
  });
});
