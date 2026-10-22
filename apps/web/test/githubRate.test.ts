import type { GithubRateState, HealthRow } from "@mc/core";
import { describe, expect, it } from "vitest";
import { formatGithubRate, GITHUB_SLOWED_PREFIX, githubSlowedNotes } from "../src/githubRate.ts";

const NOW = Date.UTC(2026, 9, 21, 11, 0);
const RESET = Date.UTC(2026, 9, 21, 12, 10); // 13:10 in London (BST)
const state = (over: Partial<GithubRateState> = {}, resetAt = RESET): GithubRateState => ({
  queries: {
    board: { cost: 3, limit: 5000, remaining: 4800, resetAt, at: 1000 },
    escalations: { cost: 1, limit: 5000, remaining: 4750, resetAt, at: 2000 },
  },
  pollCost: 7,
  ...over,
});

describe("formatGithubRate", () => {
  it("names what is left (latest reading), the poll cost and the reset in the zone", () => {
    expect(formatGithubRate(state(), "Europe/London", NOW)).toBe(
      "GitHub API · 4750 left · 7 per poll · resets 13:10",
    );
    expect(formatGithubRate(state(), "Asia/Tokyo", NOW)).toBe(
      "GitHub API · 4750 left · 7 per poll · resets 21:10",
    );
  });

  it("is — with no reading", () => {
    expect(formatGithubRate(null, "Europe/London", NOW)).toBe("GitHub API · —");
    expect(formatGithubRate(state({ queries: {} }), "Europe/London", NOW)).toBe("GitHub API · —");
  });

  it("shows — for a poll cost not yet known", () => {
    expect(formatGithubRate(state({ pollCost: null }), "Europe/London", NOW)).toBe(
      "GitHub API · 4750 left · — per poll · resets 13:10",
    );
  });

  it("shows resets — for an unset reset (0 is not 01:00) and for one already past", () => {
    const line = "GitHub API · 4750 left · 7 per poll · resets —";
    expect(formatGithubRate(state({}, 0), "Europe/London", NOW)).toBe(line);
    expect(formatGithubRate(state({}, NOW - 1), "Europe/London", NOW)).toBe(line);
    expect(formatGithubRate(state({}, NOW), "Europe/London", NOW)).toBe(
      "GitHub API · 4750 left · 7 per poll · resets 12:00",
    );
  });
});

describe("githubSlowedNotes", () => {
  const row = (collector: string, error: string | null): HealthRow => ({
    collector,
    ok: true,
    error,
    at: 0,
    lastOkAt: 0,
  });

  it("collects the slowed notes of the GitHub collectors, once each", () => {
    const note = `${GITHUB_SLOWED_PREFIX} rate limit low (400 left, resets 13:10)`;
    expect(
      githubSlowedNotes([
        row("github:shop-app", `2 PRs skipped; ${note}`),
        row("github:studio", note),
        row("usage:claude-main", `${GITHUB_SLOWED_PREFIX} not github`),
        row("github:quiet", null),
      ]),
    ).toEqual([note]);
  });
});
