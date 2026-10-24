import type { AccountId, UsageSample } from "@mc/core";
import type { TranscriptFacts } from "../streamjson.ts";
import {
  collect,
  DEFAULT_MAX_AGE_MS,
  isObj,
  WINDOWS,
  type Window,
  type WindowReading,
} from "./usage-common.ts";

export const OAUTH_USAGE_SOURCE = "oauth-usage";
export const USAGE_BACKOFF_CAP_MS = 4 * 60 * 60_000;
export const USAGE_BACKOFF_FACTOR = 2;
export const USAGE_BACKOFF_SETTING = "usage_backoff:claude";
export const USAGE_RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;
/** Away starts require readings no older than six hours. */
export const USAGE_STALE_MAX_MS = 6 * 60 * 60_000;
/** A rate-limited read is a note while a reading younger than this exists. */
export const USAGE_RATE_LIMIT_MAX_AGE_MS = 24 * 60 * 60_000;

export interface ClaudeUsageDeps {
  /** GET /api/oauth/usage response body (parsed JSON). Throws on any failure. */
  fetchUsage: () => Promise<unknown>;
  /** Rate-limit readings from the newest transcript with a `rate_limit_event` (pct 0-100, ms). */
  latestTranscriptLimits: () => TranscriptFacts["rateLimits"];
  /** Staleness bound; default 60 min (2x the 30-min poll). */
  maxAgeMs?: number;
  onError?: (source: string, err: unknown) => void;
}

const OAUTH_KEYS: Record<Window, string> = { "5h": "five_hour", "7d": "seven_day" };

/** `utilization` is already a percent and `resets_at` an ISO string. Missing/null windows are skipped. */
function fromOauth(body: unknown, now: number): WindowReading[] {
  if (!isObj(body)) throw new Error("oauth usage: unexpected response shape");
  const out: WindowReading[] = [];
  for (const window of WINDOWS) {
    const w = body[OAUTH_KEYS[window]];
    if (!isObj(w) || typeof w.utilization !== "number" || typeof w.resets_at !== "string") continue;
    const resetAt = Date.parse(w.resets_at);
    if (Number.isNaN(resetAt)) continue;
    out.push({ window, pct: w.utilization, resetAt, at: now });
  }
  return out;
}

/** Latest entry per window wins (entries are in file order). */
function fromTranscript(limits: TranscriptFacts["rateLimits"]): WindowReading[] {
  const last = new Map<Window, WindowReading>();
  for (const l of limits) {
    last.set(l.window, { window: l.window, pct: l.utilization, resetAt: l.resetsAt, at: l.at });
  }
  return [...last.values()];
}

/** OAuth usage endpoint, then transcript fallback, per window. Returns [] (never throws) if both fail. */
export async function sampleClaude(
  acct: AccountId,
  deps: ClaudeUsageDeps,
  now: number,
): Promise<UsageSample[]> {
  return collect(
    acct,
    [
      { name: OAUTH_USAGE_SOURCE, read: async () => fromOauth(await deps.fetchUsage(), now) },
      { name: "transcript", read: () => fromTranscript(deps.latestTranscriptLimits()) },
    ],
    now,
    deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    deps.onError,
  );
}
