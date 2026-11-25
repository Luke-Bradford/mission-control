import { AUDIT_FLIGHT_TOP } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markAuditShown } from "../src/audit/wake.ts";
import { flightState, pending, urgentChange, wakeFacts } from "../src/flight/state.ts";
import type { Store } from "../src/store.ts";
import { auditConfig, finding, NOW, newStore } from "./audit-fixtures.ts";

let store: Store;
beforeEach(() => {
  store = newStore();
});
afterEach(() => store.close());

const state = () => flightState({ config: auditConfig(), store, busy: [], now: NOW });

describe("FLIGHT's wake carries the AUDIT report", () => {
  it("holds the top 3 findings in rank order, wakes at once, and stops after it is told", () => {
    const before = wakeFacts(state());
    expect(state().audit).toBeUndefined();
    store.recordAuditReport({
      repoId: "mc",
      runId: "audit-1:r",
      at: NOW,
      verdict: "One of four build seats is working.",
      findings: [5, 3, 1, 4, 2].map((n) => finding(n)),
    });
    const s = state();
    expect(AUDIT_FLIGHT_TOP).toBe(3);
    expect(s.audit?.top.map((f) => f.rank)).toEqual([1, 2, 3]);
    expect(s.audit?.verdict).toContain("\nOne of four build seats is working.\n");
    expect(urgentChange(before, wakeFacts(s))).toBe(true);
    expect(pending(s)).toBe(true);
    markAuditShown(store, s);
    const after = state();
    expect(after.audit).toBeUndefined();
    expect(pending(after)).toBe(false);
    // a later report is told again
    store.recordAuditReport({
      repoId: "mc",
      runId: "audit-1:r2",
      at: NOW + 1,
      verdict: "v2",
      findings: [],
    });
    expect(state().audit?.verdict).toContain("\nv2\n");
  });
});
