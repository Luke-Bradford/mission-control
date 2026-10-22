import { clockHm } from "./hud.ts";
import type { HealthRow, RepoId } from "./types.ts";

/** Collector-status names of the GitHub collector: `github:<repoId>` (see `/api/health`). */
export const GITHUB_COLLECTOR_PREFIX = "github:";
export const githubCollector = (repoId: RepoId): string => `${GITHUB_COLLECTOR_PREFIX}${repoId}`;

/** Issue-title markers (`[operator-decision]` etc.) that make an open issue an escalation of that kind. */
export const TITLE_MARKERS = ["operator-decision", "loop-blocked", "mvp-ready"] as const;
export type TitleMarker = (typeof TITLE_MARKERS)[number];
/** Matches a leading title marker; group 1 is the marker. */
export const TITLE_MARKER_RE = new RegExp(`^\\s*\\[(${TITLE_MARKERS.join("|")})\\]`);

/** Every GraphQL query the collectors send selects this, so each answer says what it cost. */
export const RATE_LIMIT_SELECTION = "rateLimit { cost limit remaining resetAt }";
/** Settings key the last rate-limit readings are kept under (see `GithubRateState`). */
export const GITHUB_RATE_SETTING = "github.rateLimits";
/** Below this share of the hourly budget the GitHub poll slows down. */
export const GITHUB_LOW_FRACTION = 0.1;
/** The slowed poll interval is at most this many times the configured one. */
export const GITHUB_BACKOFF_MAX = 8;

/** Issues per search page, and the pages one search reads (more results set `truncated`). */
export const SEARCH_PAGE_SIZE = 50;
export const SEARCH_MAX_PAGES = 5;
/** Comments per page when an issue's SD-32 marker is looked for newest-first, and the pages read. */
export const COMMENTS_PAGE_SIZE = 30;
export const COMMENTS_MAX_PAGES = 5;

/** One query's last `rateLimit` reading. `resetAt` (0: unknown) and `at` are UTC ms. */
export interface GithubRateLimit {
  cost: number;
  /** The token's own hourly budget as GitHub reports it. */
  limit: number;
  remaining: number;
  resetAt: number;
  at: number;
}

/** What the server keeps under GITHUB_RATE_SETTING and `/api/limits/github` returns. */
export interface GithubRateState {
  /** The last reading per query name. */
  queries: Record<string, GithubRateLimit>;
  /** Points the latest GitHub poll spent across all its queries; null before one finished. */
  pollCost: number | null;
}

/** A GitHub collector's health note starts with this while the poll is slowed for the rate limit. */
export const GITHUB_SLOWED_PREFIX = "slowed:";

const NO_READING = "—";

/**
 * The GitHub row: what is left (the newest reading), what a poll costs, and when the budget
 * resets in `tz`. `—` stands for whatever is not known yet; a reset before `now` (which
 * includes an unknown one, `resetAt <= 0`) is `resets —`, one exactly at `now` still shows its time.
 */
export function formatGithubRate(state: GithubRateState | null, tz: string, now: number): string {
  let latest: GithubRateLimit | null = null;
  for (const rl of Object.values(state?.queries ?? {})) {
    if (!latest || rl.at >= latest.at) latest = rl;
  }
  if (!state || !latest) return `GitHub API · ${NO_READING}`;
  const cost = state.pollCost ?? NO_READING;
  const reset = latest.resetAt < now ? NO_READING : clockHm(latest.resetAt, tz);
  return `GitHub API · ${latest.remaining} left · ${cost} per poll · resets ${reset}`;
}

/** The distinct `slowed: …` notes on the GitHub collectors' health rows. */
export function githubSlowedNotes(health: HealthRow[]): string[] {
  const notes = health
    .filter((h) => h.collector.startsWith(GITHUB_COLLECTOR_PREFIX))
    .flatMap((h) => (h.error ?? "").split("; "))
    .filter((n) => n.startsWith(GITHUB_SLOWED_PREFIX));
  return [...new Set(notes)];
}
