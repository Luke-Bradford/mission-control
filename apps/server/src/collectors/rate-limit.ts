import {
  GITHUB_BACKOFF_MAX,
  GITHUB_LOW_FRACTION,
  GITHUB_POINTS_PER_HOUR,
  GITHUB_RATE_SETTING,
  type GithubRateLimit,
  type GithubRateState,
} from "@mc/core";
import type { Store } from "../store.ts";

const HOUR_MS = 60 * 60_000;

/** The queries one GitHub poll sends; their costs add up to the poll's cost. */
export const POLL_QUERIES: readonly string[] = ["Board", "Escalations", "PullRequests", "Comments"];

/** The operation name of a GraphQL document (`query Board(...)`), or "anonymous". */
export function queryName(query: string): string {
  return /\bquery\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
}

/**
 * `rateLimit { cost limit remaining resetAt }` from a response's `data`, or null when it carries
 * none. A missing `limit` reads as the standard hourly budget; a missing `resetAt` as 0 (unknown).
 */
export function parseRateLimit(data: unknown, at: number): GithubRateLimit | null {
  if (typeof data !== "object" || data === null) return null;
  const rl = (data as Record<string, unknown>).rateLimit;
  if (typeof rl !== "object" || rl === null) return null;
  const { cost, limit, remaining, resetAt } = rl as Record<string, unknown>;
  if (typeof cost !== "number" || typeof remaining !== "number") return null;
  const reset = typeof resetAt === "string" ? Date.parse(resetAt) : NaN;
  return {
    cost,
    limit: typeof limit === "number" && limit > 0 ? limit : GITHUB_POINTS_PER_HOUR,
    remaining,
    resetAt: Number.isNaN(reset) ? 0 : reset,
    at,
  };
}

/** An exhausted budget always backs off at least this long, whatever reset time GitHub names. */
export const EXHAUSTED_MIN_RESET_MS = 60_000;

/**
 * True when a failed HTTP answer is about the rate limit: a 429, or any status that says nothing
 * is left (`x-ratelimit-remaining: 0`) or when to retry (`retry-after`). A 403 for permissions,
 * SAML or a revoked token has neither.
 */
export const isRateLimitedResponse = (status: number, headers: Headers): boolean =>
  status === 429 || headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after");

/**
 * The reading an exhausted budget stands for (a rate-limited answer or a RATE_LIMITED error):
 * nothing left, resetting `retry-after` seconds on (a secondary limit), else at
 * `x-ratelimit-reset` (epoch seconds, never sooner than EXHAUSTED_MIN_RESET_MS on), else an hour on.
 */
export function exhaustedReading(headers: Headers, at: number): GithubRateLimit {
  const retry = Number(headers.get("retry-after"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  const limit = Number(headers.get("x-ratelimit-limit"));
  const resetAt =
    retry > 0
      ? at + retry * 1000
      : reset > 0
        ? Math.max(reset * 1000, at + EXHAUSTED_MIN_RESET_MS)
        : at + HOUR_MS;
  return {
    cost: 0,
    limit: limit > 0 ? limit : GITHUB_POINTS_PER_HOUR,
    remaining: 0,
    resetAt,
    at,
  };
}

/** True when a GraphQL `errors` entry says the rate limit is exhausted. */
export const isRateLimitedError = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as Record<string, unknown>).type === "RATE_LIMITED";

/** True when this reading is below the share of the token's own hourly budget the poll backs off at. */
export const isLow = (rl: GithubRateLimit): boolean =>
  rl.remaining < (rl.limit > 0 ? rl.limit : GITHUB_POINTS_PER_HOUR) * GITHUB_LOW_FRACTION;

/** The last reading per query name, kept in the store so `/api/limits/github` can show it. */
export class RateLimits {
  private queries: Record<string, GithubRateLimit> = {};
  private pollSpent = 0;
  private pollCost: number | null = null;
  /** The readings recorded since `startPoll`, in order: any job's, as the budget is account-wide. */
  private pollLog: GithubRateLimit[] = [];

  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
    const raw = store.getSetting(GITHUB_RATE_SETTING);
    if (raw === null) return;
    try {
      const saved = JSON.parse(raw) as GithubRateState;
      this.queries = saved.queries;
      this.pollCost = saved.pollCost;
    } catch {
      // an unreadable saved reading is just no reading
    }
  }

  record(query: string, rl: GithubRateLimit): void {
    this.queries[query] = rl;
    this.pollLog.push(rl);
    if (POLL_QUERIES.includes(query)) this.pollSpent += rl.cost;
    this.save();
  }

  /** Marks the start of a poll; pass the result to `endPoll`. */
  startPoll(): number {
    this.pollLog = [];
    return this.pollSpent;
  }

  /**
   * The reading that puts the poll that just ran in back-off: the first low one recorded since
   * `startPoll`, so a reading another job records mid-poll cannot replace it. Without a low one,
   * the newest reading.
   */
  pollCause(): GithubRateLimit | null {
    return this.pollLog.find(isLow) ?? this.latest();
  }

  endPoll(started: number): void {
    this.pollCost = this.pollSpent - started;
    this.save();
  }

  /** The newest reading of any query: `remaining` is account-wide, so the newest is the truth. */
  latest(): GithubRateLimit | null {
    let best: GithubRateLimit | null = null;
    for (const rl of Object.values(this.queries)) if (!best || rl.at >= best.at) best = rl;
    return best;
  }

  state(): GithubRateState {
    return { queries: { ...this.queries }, pollCost: this.pollCost };
  }

  private save(): void {
    try {
      this.store.setSetting(GITHUB_RATE_SETTING, JSON.stringify(this.state()));
    } catch {
      // a locked database must not fail a GitHub read
    }
  }
}

/**
 * The next poll interval factor: doubles while the last reading is low and its reset is ahead
 * (up to GITHUB_BACKOFF_MAX), back to 1 once it is not. A low reading with no known reset fails
 * closed: the longest back-off.
 */
export function nextBackoff(current: number, latest: GithubRateLimit | null, now: number): number {
  if (!latest || !isLow(latest)) return 1;
  if (latest.resetAt === 0) return GITHUB_BACKOFF_MAX;
  if (now >= latest.resetAt) return 1;
  return Math.min(GITHUB_BACKOFF_MAX, current * 2);
}
