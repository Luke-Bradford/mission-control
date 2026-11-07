import {
  BUDGET_BRAKE_KEY,
  BUDGET_BRAKE_PCT,
  type BudgetBrakeReading,
  budgetBrakeAlertText,
  projectAtReset,
  type UsageSample,
} from "@mc/core";
import type { CcConfig } from "./config.ts";
import type { Store } from "./store.ts";

const WEEK_MS = 7 * 24 * 3600e3;

export interface WeeklyProjection {
  resetAt: number;
  samples: UsageSample[];
  /** Percent of the weekly quota used at reset if the 24h pace holds; null with too few readings. */
  projected: number | null;
}

/**
 * An account's 7d window projected to its reset, from the current window's samples only. The one
 * projection: the Overview's Tokens panel (limitRows) and the budget brake both read it here.
 */
export function weeklyProjection(store: Store, accountId: string): WeeklyProjection | null {
  const latest = store.latestUsage(accountId, "7d");
  if (latest === null) return null;
  const samples = store.usage(accountId, "7d", latest.resetAt - WEEK_MS);
  return {
    resetAt: latest.resetAt,
    samples,
    projected: projectAtReset(samples, latest.resetAt),
  };
}

/** The account's brake, or null: its weekly projection passes 100% and the week has not reset. */
export function budgetBrake(
  config: CcConfig,
  store: Store,
  accountId: string,
  at: number,
): BudgetBrakeReading | null {
  if (!config.accounts.some((a) => a.id === accountId)) return null;
  const week = weeklyProjection(store, accountId);
  if (week === null || week.projected === null) return null;
  if (week.resetAt <= at || week.projected <= BUDGET_BRAKE_PCT) return null;
  return { accountId, projected: week.projected, resetAt: week.resetAt };
}

/** Every braked account. */
export function budgetBrakes(config: CcConfig, store: Store, at: number): BudgetBrakeReading[] {
  return config.accounts.flatMap((a) => budgetBrake(config, store, a.id, at) ?? []);
}

/**
 * Keeps the one hub alert in step with the brake: raised while any account is braked (reworded
 * when its numbers move), cleared when none is. Returns whether the note changed.
 */
export function syncBudgetBrake(config: CcConfig, store: Store, at: number): boolean {
  const brakes = budgetBrakes(config, store, at);
  const open = store.notes().find((n) => n.key === BUDGET_BRAKE_KEY);
  if (brakes.length === 0) {
    if (open === undefined) return false;
    store.clearNote(BUDGET_BRAKE_KEY, at);
    return true;
  }
  const text = budgetBrakeAlertText(brakes, config.operator.timezone);
  if (open?.text === text) return false;
  store.refreshNote({
    key: BUDGET_BRAKE_KEY,
    kind: "flag",
    runId: null,
    seatId: null,
    repoId: null,
    text,
    at: open?.at ?? at,
  });
  return true;
}
