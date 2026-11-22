import {
  AUDIT_EVERY_HOURS_DEFAULT,
  AWAY_SETTING,
  auditStartedKey,
  CREW_PAUSE_SETTING,
  DEFAULT_AWAY,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuditPack } from "../src/audit/pack.ts";
import { auditTick, nextAuditDueAt } from "../src/audit/timer.ts";
import type { Store } from "../src/store.ts";
import { auditConfig, finding, HOUR, NOW, newStore, runRow } from "./audit-fixtures.ts";

let store: Store;
const startAudit = vi.fn(async (_seat: string) => ({ runId: "audit-1:r" }));
const busy: { seatId: string; state: "running" }[] = [];
const endRunByEngine = vi.fn(async (_run: string) => {});
const tick = (now: number, config = auditConfig()) =>
  auditTick({ config, store, supervisor: { startAudit, busy: () => busy, endRunByEngine }, now });

beforeEach(() => {
  store = newStore();
  startAudit.mockClear();
  endRunByEngine.mockClear();
  busy.length = 0;
});
afterEach(() => store.close());

describe("the AUDIT seat's timer", () => {
  it("starts the seat on the first tick, not before 4 h, and again at 4 h", async () => {
    expect(AUDIT_EVERY_HOURS_DEFAULT).toBe(4);
    expect(await tick(NOW)).toEqual(["audit-1"]);
    expect(store.getSetting(auditStartedKey("audit-1"))).toBe(String(NOW));
    expect(await tick(NOW + 4 * HOUR - 60_000)).toEqual([]);
    expect(await tick(NOW + 4 * HOUR)).toEqual(["audit-1"]);
    expect(startAudit).toHaveBeenCalledTimes(2);
  });

  it("follows audit.report_every_hours", async () => {
    const config = auditConfig({ audit: { reportEveryHours: 1 } });
    await tick(NOW, config);
    expect(await tick(NOW + HOUR, config)).toEqual(["audit-1"]);
    expect(nextAuditDueAt(config, store, "mc")).toBe(NOW + 2 * HOUR);
  });

  it("waits a full interval after a start that fails", async () => {
    startAudit.mockRejectedValueOnce(new Error("no account"));
    expect(await tick(NOW)).toEqual([]);
    expect(await tick(NOW + HOUR)).toEqual([]);
    expect(startAudit).toHaveBeenCalledTimes(1);
  });

  it("does not start while the crew is paused, the seat is busy or it has a run", async () => {
    store.setSetting(
      CREW_PAUSE_SETTING,
      JSON.stringify({ seats: "all", reason: "operator pause", at: NOW, by: "operator" }),
    );
    expect(await tick(NOW)).toEqual([]);
    store.setSetting(CREW_PAUSE_SETTING, "");
    busy.push({ seatId: "audit-1", state: "running" });
    expect(await tick(NOW)).toEqual([]);
    busy.length = 0;
    store.upsertRun(runRow("audit-1:live", "audit-1"));
    store.setSeatSession({
      seatId: "audit-1",
      runId: "audit-1:live",
      cliSessionId: null,
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    expect(await tick(NOW)).toEqual([]);
    expect(startAudit).not.toHaveBeenCalled();
  });

  it("does not restart a seat the operator stopped", async () => {
    store.setSeatSession({
      seatId: "audit-1",
      runId: null,
      cliSessionId: null,
      state: "stopped",
      reason: null,
      worktree: null,
      updatedAt: NOW,
      stop: { by: "op", reason: null, at: NOW },
    });
    expect(await tick(NOW)).toEqual([]);
    expect(startAudit).not.toHaveBeenCalled();
  });

  it("ends a run that stayed open a whole interval without a report, and starts no run in that pass", async () => {
    store.upsertRun(runRow("audit-1:old", "audit-1", { startedAt: NOW - 5 * HOUR }));
    store.setSeatSession({
      seatId: "audit-1",
      runId: "audit-1:old",
      cliSessionId: null,
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    expect(await tick(NOW)).toEqual([]);
    expect(endRunByEngine).toHaveBeenCalledWith("audit-1:old");
    expect(startAudit).not.toHaveBeenCalled();
  });

  it("does not start while the operator is away and the account is at its reserve", async () => {
    store.setSetting(AWAY_SETTING, JSON.stringify({ ...DEFAULT_AWAY, on: true, until: "" }));
    store.addUsage({
      accountId: "main",
      window: "7d",
      at: NOW,
      pct: 99,
      resetAt: NOW + HOUR,
      source: "t",
    });
    expect(await tick(NOW)).toEqual([]);
    expect(startAudit).not.toHaveBeenCalled();
  });

  it("stores one report per run, and the next report's pack carries the last", () => {
    expect(
      store.recordAuditReport({
        repoId: "mc",
        runId: "r1",
        at: NOW,
        verdict: "v",
        findings: [finding(1)],
      }),
    ).toBe(true);
    expect(
      store.recordAuditReport({
        repoId: "mc",
        runId: "r1",
        at: NOW,
        verdict: "again",
        findings: [],
      }),
    ).toBe(false);
    expect(store.latestAuditReport("mc")?.verdict).toBe("v");
    const pack = JSON.parse(buildAuditPack({ config: auditConfig(), store, busy: [], now: NOW }));
    expect(pack.previous.findings).toEqual([{ rank: 1, area: "flow", problem: "problem 1" }]);
  });
});
