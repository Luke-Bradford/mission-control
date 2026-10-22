// Unused: moved to @mc/core (#115); delete when seats can delete files (see the crew issue).
/** The GitHub API budget as the Limits rows show it (Overview quota panel, Setup › Accounts). */
import {
  GITHUB_COLLECTOR_PREFIX,
  type GithubRateLimit,
  type GithubRateState,
  type HealthRow,
} from "@mc/core";
import { hhmm } from "./fmt.ts";

// Mirrors the server's literal in scheduler.ts; both move to @mc/core in a follow-up (#115).
export const GITHUB_SLOWED_PREFIX = "slowed:";

const NO_READING = "—";

/**
 * The GitHub row: what is left (the newest reading), what a poll costs, and when the budget
 * resets in `tz`. `—` stands for whatever is not known yet, an unset reset (`resetAt` 0) or one
 * already before `now`.
 */
export function formatGithubRate(state: GithubRateState | null, tz: string, now: number): string {
  let latest: GithubRateLimit | null = null;
  for (const rl of Object.values(state?.queries ?? {})) {
    if (!latest || rl.at >= latest.at) latest = rl;
  }
  if (!state || !latest) return `GitHub API · ${NO_READING}`;
  const cost = state.pollCost ?? NO_READING;
  // An unset reset (0) is in the past too.
  const resets = latest.resetAt >= now ? hhmm(latest.resetAt, tz) : NO_READING;
  return `GitHub API · ${latest.remaining} left · ${cost} per poll · resets ${resets}`;
}

/** The distinct `slowed: …` notes on the GitHub collectors' health rows. */
export function githubSlowedNotes(health: HealthRow[]): string[] {
  const notes = health
    .filter((h) => h.collector.startsWith(GITHUB_COLLECTOR_PREFIX))
    .flatMap((h) => (h.error ?? "").split("; "))
    .filter((n) => n.startsWith(GITHUB_SLOWED_PREFIX));
  return [...new Set(notes)];
}
