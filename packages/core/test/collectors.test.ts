import { describe, expect, it } from "vitest";
import {
  formatGithubRate,
  GITHUB_SLOWED_PREFIX,
  type GithubRateState,
  githubSlowedNotes,
  type HealthRow,
} from "../src/index.ts";

const RESET = Date.UTC(2026, 9, 21, 12, 10); // 13:10 in London (BST)
const state = (over: Partial<GithubRateState> = {}): GithubRateState => ({
  queries: {
    board: { cost: 3, limit: 5000, remaining: 4800, resetAt: RESET, at: RESET - 2000 },
    escalations: { cost: 1, limit: 5000, remaining: 4750, resetAt: RESET, at: RESET - 1000 },
  },
  pollCost: 7,
  ...over,
});

const NOW = RESET - 10 * 60_000; // ten minutes before the reset

describe("formatGithubRate", () => {
  it("names what is left (newest reading by at), the poll cost and the reset in the zone", () => {
    expect(formatGithubRate(state(), "Europe/London", NOW)).toBe(
      "GitHub API · 4750 left · 7 per poll · resets 13:10",
    );
    expect(formatGithubRate(state(), "UTC", NOW)).toContain("resets 12:10");
  });

  it("takes the newest reading whatever the order of the queries", () => {
    const s = state({
      queries: {
        a: { cost: 1, limit: 5000, remaining: 10, resetAt: RESET, at: RESET - 1 },
        b: { cost: 1, limit: 5000, remaining: 20, resetAt: RESET, at: RESET - 5 },
      },
    });
    expect(formatGithubRate(s, "UTC", NOW)).toContain("10 left");
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

  describe("the reset against now", () => {
    const one = (resetAt: number): GithubRateState =>
      state({ queries: { q: { cost: 1, limit: 5000, remaining: 9, resetAt, at: RESET } } });
    const text = (resetAt: number, now: number) => formatGithubRate(one(resetAt), "UTC", now);

    it("is resets — for an unknown reset (zero or less)", () => {
      expect(text(0, NOW)).toBe("GitHub API · 9 left · 7 per poll · resets —");
      expect(text(-1, NOW)).toBe("GitHub API · 9 left · 7 per poll · resets —");
    });

    it("is resets — for a reset before now", () => {
      expect(text(RESET, RESET + 1)).toBe("GitHub API · 9 left · 7 per poll · resets —");
    });

    it("still shows the time for a reset exactly at now", () => {
      expect(text(RESET, RESET)).toBe("GitHub API · 9 left · 7 per poll · resets 12:10");
    });
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
