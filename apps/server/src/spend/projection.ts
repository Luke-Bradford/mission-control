import { projectAtReset, type UsageSample } from "@mc/core";
import type { Store } from "../store.ts";

const WEEK_MS = 7 * 24 * 3600e3;

export interface WeeklyProjection {
  resetAt: number;
  samples: UsageSample[];
  /** Percent of the weekly quota used at reset if the 24h pace holds; null with too few readings. */
  projected: number | null;
}

/**
 * An account's 7d window projected to its reset, from the current window's samples only.
 * Information only (the Overview's Tokens panel): it never stops or delays a run. An account stops
 * at its real `stop_at` use alone.
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
