import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUDGET_BRAKE_KEY, budgetBrakeText } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limitRows } from "../src/api.ts";
import { budgetBrake, syncBudgetBrake, weeklyProjection } from "../src/budget-brake.ts";
import type { CcConfig } from "../src/config.ts";
import { hubAlert } from "../src/hud.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const HOUR = 3600e3;
const RESET = NOW + 24 * HOUR;
const ACCOUNT = "claude-main";

let dir: string;
let store: Store;
const config = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [
    { id: ACCOUNT, vendor: "claude", alertAt: 80, stopAt: 95 },
    { id: "claude-quiet", vendor: "claude", alertAt: 80, stopAt: 95 },
  ],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
} as unknown as CcConfig;

/** Six hours of readings: `from` at NOW-6h, `to` now. At 40 → 60 the pace carries it to ~140%. */
const week = (accountId: string, from: number, to: number, resetAt = RESET) => {
  for (const [at, pct] of [
    [NOW - 6 * HOUR, from],
    [NOW, to],
  ] as const)
    store.addUsage({ accountId, window: "7d", at, resetAt, pct, source: "test" });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-brake-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("budgetBrake", () => {
  it("is on while the weekly projection passes 100% and says why", () => {
    week(ACCOUNT, 40, 60);
    const brake = budgetBrake(config, store, ACCOUNT, NOW);
    expect(brake?.accountId).toBe(ACCOUNT);
    expect(brake?.projected).toBeGreaterThan(100);
    expect(brake?.resetAt).toBe(RESET);
    expect(budgetBrakeText("GUIDO-1", brake as NonNullable<typeof brake>, "Europe/London")).toMatch(
      /budget brake is on.*claude-main.*14[0-9]%.*Sun 8 Nov 12:00/,
    );
  });

  it("never brakes an account set brake: false, whatever its projection", () => {
    week(ACCOUNT, 40, 60);
    const off = {
      ...config,
      accounts: config.accounts.map((a) => (a.id === ACCOUNT ? { ...a, brake: false } : a)),
    } as CcConfig;
    expect(budgetBrake(off, store, ACCOUNT, NOW)).toBeNull();
    expect(syncBudgetBrake(off, store, NOW)).toBe(false);
  });

  it("lifts when the projection falls back under 100%", () => {
    week(ACCOUNT, 40, 60);
    expect(budgetBrake(config, store, ACCOUNT, NOW)).not.toBeNull();
    week(ACCOUNT, 10, 10);
    store.addUsage({
      accountId: ACCOUNT,
      window: "7d",
      at: NOW + 1,
      resetAt: RESET,
      pct: 10,
      source: "test",
    });
    // the 24h pace now reads (10 - 40) < 0 at worst, so the projection is the current 10%
    expect(budgetBrake(config, store, ACCOUNT, NOW + 1)).toBeNull();
  });

  it("is off at exactly 100%, with too few readings, or for another account", () => {
    store.addUsage({
      accountId: ACCOUNT,
      window: "7d",
      at: NOW,
      resetAt: RESET,
      pct: 90,
      source: "t",
    });
    expect(budgetBrake(config, store, ACCOUNT, NOW)).toBeNull();
    week("claude-quiet", 10, 10);
    expect(budgetBrake(config, store, "claude-quiet", NOW)).toBeNull();
    expect(budgetBrake(config, store, "unknown", NOW)).toBeNull();
  });

  it("lifts by itself when the week resets", () => {
    week(ACCOUNT, 40, 60);
    expect(budgetBrake(config, store, ACCOUNT, RESET - 1)).not.toBeNull();
    expect(budgetBrake(config, store, ACCOUNT, RESET)).toBeNull();
  });

  it("reads the same projection as the Overview Tokens panel's rows", () => {
    week(ACCOUNT, 40, 60);
    const row = limitRows(config, store, NOW).find(
      (r) => r.accountId === ACCOUNT && r.window === "7d",
    );
    expect(row?.projected).not.toBeNull();
    expect(row?.projected).toBe(weeklyProjection(store, ACCOUNT)?.projected);
    expect(budgetBrake(config, store, ACCOUNT, NOW)?.projected).toBe(row?.projected);
  });
});

describe("syncBudgetBrake", () => {
  const open = () => store.notes().filter((n) => n.key === BUDGET_BRAKE_KEY);

  it("raises one hub alert while on, keeps it single, and clears when it lifts", () => {
    expect(syncBudgetBrake(config, store, NOW)).toBe(false);
    week(ACCOUNT, 40, 60);
    week("claude-quiet", 40, 60);
    expect(syncBudgetBrake(config, store, NOW)).toBe(true);
    expect(open()).toHaveLength(1);
    expect(open()[0]?.text).toMatch(
      /Budget brake is on.*claude-main.*claude-quiet.*FLIGHT keeps running/,
    );
    expect(hubAlert({ key: `note:${BUDGET_BRAKE_KEY}`, kind: "flag" }, store)).toBe(true);
    // same numbers: no change, still one
    expect(syncBudgetBrake(config, store, NOW + 60_000)).toBe(false);
    expect(open()).toHaveLength(1);
    expect(open()[0]?.at).toBe(NOW);
    // the week resets
    expect(syncBudgetBrake(config, store, RESET)).toBe(true);
    expect(open()).toHaveLength(0);
  });

  it("clears when the projection falls back under 100%", () => {
    week(ACCOUNT, 40, 60);
    syncBudgetBrake(config, store, NOW);
    expect(open()).toHaveLength(1);
    week(ACCOUNT, 10, 10);
    store.addUsage({
      accountId: ACCOUNT,
      window: "7d",
      at: NOW + 1,
      resetAt: RESET,
      pct: 10,
      source: "t",
    });
    expect(syncBudgetBrake(config, store, NOW + 1)).toBe(true);
    expect(open()).toHaveLength(0);
  });
});
