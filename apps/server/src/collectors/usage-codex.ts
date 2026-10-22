import type { AccountId, UsageSample } from "@mc/core";
import {
  collect,
  DEFAULT_MAX_AGE_MS,
  isObj,
  type Window,
  type WindowReading,
} from "./usage-common.ts";

export interface CodexUsageDeps {
  /** `account/rateLimits/read` result (camelCase: `{ rateLimits: { primary, secondary } }`). Throws on failure. */
  appServer: () => Promise<unknown>;
  /** `{ at, rate_limits }` from the newest rollout `token_count` (snake_case), or null. */
  latestRollout: () => unknown;
  maxAgeMs?: number;
  onError?: (source: string, err: unknown) => void;
  /** Called for a window whose length is neither 300 nor 10080 minutes. */
  onWarn?: (message: string) => void;
}

const WINDOW_BY_MINUTES = new Map<number, Window>([
  [300, "5h"],
  [10080, "7d"],
]);

const pick = (o: Record<string, unknown>, a: string, b: string): unknown => o[a] ?? o[b];

/**
 * Parse a rate-limits object in either the app-server (camelCase) or rollout (snake_case) shape.
 * `primary`/`secondary` are an unordered pair: windows are identified by their length alone.
 * Epoch seconds become ms. `at` is the sample time.
 */
function parseLimits(raw: unknown, at: number, onWarn?: (m: string) => void): WindowReading[] {
  if (!isObj(raw)) return [];
  const limits = raw.rateLimits ?? raw.rate_limits ?? raw;
  if (!isObj(limits)) return [];
  const out: WindowReading[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = limits[key];
    if (!isObj(w)) continue;
    const mins = pick(w, "windowDurationMins", "window_minutes");
    const used = pick(w, "usedPercent", "used_percent");
    const resets = pick(w, "resetsAt", "resets_at");
    const window = typeof mins === "number" ? WINDOW_BY_MINUTES.get(mins) : undefined;
    if (!window) {
      onWarn?.(`codex ${key} window ignored: unrecognised window length ${String(mins)}`);
      continue;
    }
    if (typeof used !== "number" || typeof resets !== "number") continue;
    if (out.some((r) => r.window === window)) continue;
    out.push({ window, pct: used, resetAt: resets * 1000, at });
  }
  return out;
}

/** `codex app-server` first, then the newest rollout. Returns [] (never throws) if both fail. */
export async function sampleCodex(
  acct: AccountId,
  deps: CodexUsageDeps,
  now: number,
): Promise<UsageSample[]> {
  return collect(
    acct,
    [
      {
        name: "app-server",
        read: async () => parseLimits(await deps.appServer(), now, deps.onWarn),
      },
      {
        name: "rollout",
        read: () => {
          const r = deps.latestRollout();
          const at = isObj(r) && typeof r.at === "number" ? r.at : Number.NaN;
          return parseLimits(r, at, deps.onWarn);
        },
      },
    ],
    now,
    deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    deps.onError,
  );
}
