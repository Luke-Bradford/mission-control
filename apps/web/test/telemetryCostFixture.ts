import { LIVE_MINUTES, TELEMETRY_POINTS, type Telemetry } from "@mc/core";
import { HOUR, MIN, NOW } from "./fixtures.ts";
import { crewTelemetry, crewTelemetryApi, SEATS } from "./telemetryCrewFixture.ts";

/** A wave per seat, so the stacked layers rise and fall and differ in size. */
const wave = (n: number, seat: number): number[] =>
  Array.from({ length: n }, (_, i) =>
    Math.round(
      2000 +
        (seat === 0 ? 9000 : 0) / (1 + seat) +
        (1500 * Math.sin(i / 7 + seat) * (11 - seat)) / 11,
    ),
  );

/** Eleven seats' usage, a dozen tickets, three steps and two quota windows: the Cost and tokens tab at full load. */
export function costTelemetry(): Telemetry {
  const base = crewTelemetry();
  return {
    ...base,
    tokensPerMinute: SEATS.map((agentId, s) => ({ agentId, points: wave(TELEMETRY_POINTS, s) })),
    liveMinutes: SEATS.map((agentId, s) => ({ agentId, points: wave(LIVE_MINUTES, s) })),
    quota: [
      {
        accountId: "claude-main",
        window: "5h",
        points: [
          { at: NOW - 5 * HOUR, pct: 12 },
          { at: NOW - MIN, pct: 42 },
        ],
      },
      {
        accountId: "claude-main",
        window: "7d",
        points: [
          { at: NOW - 20 * HOUR, pct: 60 },
          { at: NOW - MIN, pct: 78 },
        ],
      },
    ],
    tokensByStep: [
      { step: "plan", tokens: 4_200_000, costUsd: 3.1, runs: 14 },
      { step: "build", tokens: 26_000_000, costUsd: 16.8, runs: 31 },
      { step: "review", tokens: 8_000_000, costUsd: null, runs: 22 },
    ],
    tokensByTicket: Array.from({ length: 12 }, (_, i) => ({
      ticket: `mission-control#${1900 + i}`,
      tokens: 4_000_000 - i * 250_000,
      costUsd: i === 9 ? null : 6.4 - i * 0.4,
      totalCostUsd: i < 4 ? 18 + i : null,
    })),
    totals: SEATS.slice(0, 11).map((agentId, i) => ({
      agentId,
      accountId: "claude-main",
      model: i % 3 === 0 ? "opus" : "sonnet",
      input: 900_000 - i * 40_000,
      output: 210_000 - i * 9000,
      cacheRead: 7_000_000,
      cacheHitPct: 87,
      turns: 60 - i,
      toolCalls: 900 - i * 20,
      additions: 400 - i * 10,
      deletions: 90,
      costUsd: i === 4 ? null : 3.2 - i * 0.1,
    })),
    today: { ...base.today, cacheRead: 250_000_000 },
  };
}

export const costTelemetryApi = (): Record<string, unknown> => {
  const api = crewTelemetryApi();
  const data = costTelemetry();
  for (const r of ["1h", "6h", "24h", "7d"]) api[`/api/telemetry?range=${r}`] = data;
  api["/api/limits"] = [
    {
      accountId: "claude-main",
      window: "5h",
      used: 42,
      resetAt: NOW + 100 * MIN,
      alertAt: 80,
      stopAt: 95,
      stale: false,
      source: "usage",
      sampledAt: NOW - MIN,
      fullAt: null,
      paceReady: true,
    },
    {
      accountId: "claude-main",
      window: "7d",
      used: 78,
      resetAt: NOW + 52 * HOUR,
      alertAt: 80,
      stopAt: 95,
      stale: false,
      source: "usage",
      sampledAt: NOW - MIN,
      fullAt: null,
      projected: 84,
      stopForecast: null,
    },
  ];
  return api;
};
