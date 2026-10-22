import { describe, expect, it } from "vitest";
import { sampleClaude } from "../src/collectors/usage-claude.ts";
import { sampleCodex } from "../src/collectors/usage-codex.ts";

const NOW = 1_792_000_000_000;
const FUTURE_S = NOW / 1000 + 3600;
const FUTURE_MS = FUTURE_S * 1000;
const boom = () => Promise.reject(new Error("boom"));

const oauth = {
  five_hour: { utilization: 48, resets_at: new Date(FUTURE_MS).toISOString() },
  seven_day: { utilization: 45.5, resets_at: new Date(FUTURE_MS + 1000).toISOString() },
};
const tx = (
  over: Partial<{ window: "5h" | "7d"; utilization: number; resetsAt: number; at: number }> = {},
) => ({
  window: "5h" as const,
  utilization: 7,
  resetsAt: FUTURE_MS,
  at: NOW - 60_000,
  ...over,
});

describe("sampleClaude", () => {
  it("maps the OAuth response to 5h and 7d samples (percent, ISO -> ms)", async () => {
    const r = await sampleClaude(
      "a",
      { fetchUsage: async () => oauth, latestTranscriptLimits: () => [] },
      NOW,
    );
    expect(r).toEqual([
      { accountId: "a", window: "5h", at: NOW, pct: 48, resetAt: FUTURE_MS, source: "oauth-usage" },
      {
        accountId: "a",
        window: "7d",
        at: NOW,
        pct: 45.5,
        resetAt: FUTURE_MS + 1000,
        source: "oauth-usage",
      },
    ]);
  });

  it("falls back to the transcript when the primary throws, keeping the sample's own at", async () => {
    const r = await sampleClaude(
      "a",
      {
        fetchUsage: boom,
        latestTranscriptLimits: () => [
          tx({ utilization: 7 }),
          tx({ window: "7d", utilization: 45 }),
        ],
      },
      NOW,
    );
    expect(r.map((s) => [s.window, s.pct, s.source, s.at])).toEqual([
      ["5h", 7, "transcript", NOW - 60_000],
      ["7d", 45, "transcript", NOW - 60_000],
    ]);
  });

  it("uses the latest transcript entry per window", async () => {
    const r = await sampleClaude(
      "a",
      {
        fetchUsage: boom,
        latestTranscriptLimits: () => [
          tx({ utilization: 5, at: NOW - 5000 }),
          tx({ utilization: 9, at: NOW - 1000 }),
        ],
      },
      NOW,
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.pct).toBe(9);
  });

  it("falls through on a null or missing window, per window", async () => {
    const r = await sampleClaude(
      "a",
      {
        fetchUsage: async () => ({ five_hour: oauth.five_hour, seven_day: null }),
        latestTranscriptLimits: () => [tx({ window: "7d", utilization: 45 })],
      },
      NOW,
    );
    expect(r.map((s) => [s.window, s.source])).toEqual([
      ["5h", "oauth-usage"],
      ["7d", "transcript"],
    ]);
  });

  it("stores a single valid window on its own", async () => {
    const r = await sampleClaude(
      "a",
      {
        fetchUsage: async () => ({ five_hour: oauth.five_hour }),
        latestTranscriptLimits: () => [],
      },
      NOW,
    );
    expect(r.map((s) => s.window)).toEqual(["5h"]);
  });

  it("discards stale samples (older than maxAgeMs, default 60 min)", async () => {
    const stale = tx({ at: NOW - 61 * 60_000 });
    expect(
      await sampleClaude("a", { fetchUsage: boom, latestTranscriptLimits: () => [stale] }, NOW),
    ).toEqual([]);
    const ok = tx({ at: NOW - 59 * 60_000 });
    expect(
      await sampleClaude("a", { fetchUsage: boom, latestTranscriptLimits: () => [ok] }, NOW),
    ).toHaveLength(1);
    expect(
      await sampleClaude(
        "a",
        { fetchUsage: boom, latestTranscriptLimits: () => [ok], maxAgeMs: 1000 },
        NOW,
      ),
    ).toEqual([]);
  });

  it("discards samples whose reset is already in the past", async () => {
    const r = await sampleClaude(
      "a",
      { fetchUsage: boom, latestTranscriptLimits: () => [tx({ resetsAt: NOW - 1 })] },
      NOW,
    );
    expect(r).toEqual([]);
  });

  it("returns [] and reports errors when every source fails; never throws", async () => {
    const errors: unknown[] = [];
    const r = await sampleClaude(
      "a",
      {
        fetchUsage: boom,
        latestTranscriptLimits: () => {
          throw new Error("disk");
        },
        onError: (_src, e) => errors.push(e),
      },
      NOW,
    );
    expect(r).toEqual([]);
    expect(errors).toHaveLength(2);
  });
});

const appServer = {
  rateLimits: {
    primary: { usedPercent: 14.5, windowDurationMins: 10080, resetsAt: FUTURE_S },
    secondary: { usedPercent: 4, windowDurationMins: 300, resetsAt: FUTURE_S + 1 },
  },
};

describe("sampleCodex", () => {
  it("identifies windows by duration, not by primary/secondary position", async () => {
    const r = await sampleCodex(
      "c",
      { appServer: async () => appServer, latestRollout: () => null },
      NOW,
    );
    expect(r).toEqual([
      {
        accountId: "c",
        window: "5h",
        at: NOW,
        pct: 4,
        resetAt: FUTURE_MS + 1000,
        source: "app-server",
      },
      {
        accountId: "c",
        window: "7d",
        at: NOW,
        pct: 14.5,
        resetAt: FUTURE_MS,
        source: "app-server",
      },
    ]);
  });

  it("ignores an unknown window duration and warns", async () => {
    const warns: string[] = [];
    const r = await sampleCodex(
      "c",
      {
        appServer: async () => ({
          rateLimits: {
            primary: { usedPercent: 3, windowDurationMins: 0, resetsAt: FUTURE_S },
            secondary: null,
          },
        }),
        latestRollout: () => null,
        onWarn: (m) => warns.push(m),
      },
      NOW,
    );
    expect(r).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("0");
  });

  it("falls back to the rollout (snake_case) when app-server throws", async () => {
    const r = await sampleCodex(
      "c",
      {
        appServer: boom,
        latestRollout: () => ({
          at: NOW - 120_000,
          rate_limits: {
            primary: { used_percent: 14, window_minutes: 10080, resets_at: FUTURE_S },
            secondary: null,
          },
        }),
      },
      NOW,
    );
    expect(r).toEqual([
      {
        accountId: "c",
        window: "7d",
        at: NOW - 120_000,
        pct: 14,
        resetAt: FUTURE_MS,
        source: "rollout",
      },
    ]);
  });

  it("falls back when app-server yields no valid windows", async () => {
    const r = await sampleCodex(
      "c",
      {
        appServer: async () => ({ rateLimits: { primary: null, secondary: null } }),
        latestRollout: () => ({
          at: NOW,
          rate_limits: { primary: { used_percent: 1, window_minutes: 300, resets_at: FUTURE_S } },
        }),
      },
      NOW,
    );
    expect(r.map((s) => [s.window, s.source])).toEqual([["5h", "rollout"]]);
  });

  it("discards stale and already-reset rollout samples", async () => {
    const mk = (at: number, resets: number) => ({
      at,
      rate_limits: { primary: { used_percent: 1, window_minutes: 300, resets_at: resets } },
    });
    expect(
      await sampleCodex(
        "c",
        { appServer: boom, latestRollout: () => mk(NOW - 3 * 3600e3, FUTURE_S) },
        NOW,
      ),
    ).toEqual([]);
    expect(
      await sampleCodex(
        "c",
        { appServer: boom, latestRollout: () => mk(NOW, NOW / 1000 - 1) },
        NOW,
      ),
    ).toEqual([]);
  });

  it("returns [] when everything fails", async () => {
    const r = await sampleCodex(
      "c",
      {
        appServer: boom,
        latestRollout: () => {
          throw new Error("x");
        },
      },
      NOW,
    );
    expect(r).toEqual([]);
  });
});
