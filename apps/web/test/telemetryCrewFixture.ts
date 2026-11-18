import type { ConfigView, Telemetry } from "@mc/core";
import { CREW_CONFIG, crewRow, HOUR, MIN, NOW } from "./fixtures.ts";

/** Eleven seats and a loop's account: the crew the mockup draws, so the lanes are as full as it. */
export const SEATS = [
  "flight-1",
  "dev-1",
  "dev-2",
  "dev-3",
  "rev-1",
  "rev-2",
  "qa-1",
  "plan-1",
  "plan-2",
  "ops-1",
  "loop-1",
];

export const crewTelemetryConfig = (): ConfigView => {
  const session = CREW_CONFIG.crew?.sessions[0] as NonNullable<
    ConfigView["crew"]
  >["sessions"][number];
  return {
    ...CREW_CONFIG,
    operator: { id: "operator", timezone: "UTC" },
    loops: [],
    crew: {
      ...(CREW_CONFIG.crew as NonNullable<ConfigView["crew"]>),
      sessions: [
        {
          ...session,
          seats: SEATS.map((id) => ({
            id,
            role: "GUIDO",
            mode: "writer" as const,
            accountId: "claude-main",
            model: "sonnet",
            area: ["apps/**"],
          })),
        },
      ],
    },
  };
};

const STATES = ["running", "waiting", "idle", "parked"] as const;

/** A day of state spans per seat, deterministic. */
function spans(): NonNullable<Telemetry["series"]>["stateSpans"] {
  const out: NonNullable<Telemetry["series"]>["stateSpans"] = [];
  SEATS.forEach((agentId, s) => {
    let at = NOW - 24 * HOUR;
    let i = 0;
    while (at < NOW) {
      const len = (45 + ((s * 37 + i * 53) % 150)) * MIN;
      const state = STATES[(s + i * 3 + (i % 2)) % STATES.length] as (typeof STATES)[number];
      out.push({
        agentId,
        state: i % 5 === 4 ? "idle" : state === "parked" && i % 3 ? "running" : state,
        startedAt: at,
        endedAt: Math.min(NOW, at + len),
      });
      at += len;
      i += 1;
    }
  });
  return out;
}

export function crewTelemetry(rowsMany = 1): Telemetry {
  const toolRows = ["Read", "Edit", "Grep", "Bash", "test run", "WebFetch", "ls", "Task"].flatMap(
    (tool, i) =>
      Array.from({ length: rowsMany }, (_, k) => ({
        tool: rowsMany > 1 ? `${tool} ${k + 1}` : tool,
        calls: 5120 - i * 500,
        p50Ms: 38 + i * 60,
        p95Ms: 180 + i * 900,
        failed: i,
        slowest: { detail: `${tool} the largest file`, agentId: "dev-1", durationMs: 900 + i },
      })),
  );
  return {
    today: {
      tokens: 38_200_000,
      cacheRead: 0,
      costUsd: 24.31,
      toolCalls: 12_400,
      turns: 640,
      working: 9,
      agents: 11,
      commits: 31,
    },
    throughput: Array.from({ length: 14 }, (_, i) => ({
      day: `2026-10-${String(4 + i).padStart(2, "0")}`,
      merged: [3, 5, 6, 7, 8, 4, 2, 6, 8, 9, 7, 10, 6, 7][i] as number,
    })),
    cycleTime: { rows: [], excluded: 0 },
    quality: {
      ciGreenFirstPushPct: 86,
      prs: 40,
      firstPassReviewPct: 64,
      reviewedPrs: 30,
      reviewRoundsPerPr: 1.7,
    },
    capcom: {
      answered: 14,
      medianMs: 260_000,
      p90Ms: 19 * MIN,
      stopped: 2,
      longest: { agentId: "dev-2", ms: 38 * MIN },
      agentWaitMs: 72 * MIN,
    },
    tokensPerMinute: [],
    liveMinutes: [],
    utilisation: SEATS.map((agentId, s) => {
      const working = 38 + ((s * 13) % 40);
      const waiting = 4 + ((s * 5) % 12);
      const blocked = (s * 3) % 8;
      const rest = 100 - working - waiting - blocked;
      // seats that have parked time also have unaccounted time, so a bar draws both slices
      const unknown = blocked > 0 ? Math.min(8, rest) : 0;
      return { agentId, working, waiting, blocked, idle: rest - unknown, unknown };
    }),
    turnUsage: [],
    toolLatency: toolRows,
    subagents: Array.from({ length: 6 * rowsMany }, (_, i) => ({
      agentId: SEATS[1 + (i % 3)] as string,
      taskId: `t${i}`,
      type: "Explore",
      description: "Find where the retry is decided",
      status: "completed" as const,
      tokens: 182_000 + i,
      toolUses: 14,
      durationMs: 130_000 + i * 1000,
    })),
    quota: [],
    machine: [],
    tokensByTicket: [],
    totals: [],
    series: {
      stateSpans: spans(),
      quota: [
        {
          accountId: "claude-main",
          window: "5h",
          alertAt: 80,
          stopAt: 95,
          points: [{ at: NOW - MIN, pct: 42 }],
          resets: [{ at: NOW - HOUR, resetAt: NOW + 100 * MIN, cause: "provider" }],
        },
        {
          accountId: "claude-main",
          window: "7d",
          alertAt: 80,
          stopAt: 95,
          points: [{ at: NOW - MIN, pct: 78 }],
          resets: [{ at: NOW - HOUR, resetAt: NOW + 52 * HOUR, cause: "provider" }],
        },
      ],
      tickets: [],
      annotations: [],
    },
  };
}

export const crewTelemetryApi = (rowsMany = 1): Record<string, unknown> => {
  const data = crewTelemetry(rowsMany);
  const api: Record<string, unknown> = {
    "/api/config": crewTelemetryConfig(),
    "/api/crew?shape=summary": {
      rows: SEATS.map((id, index) =>
        crewRow({
          id,
          index,
          hudState: index === 9 ? "waiting" : index === 10 ? "parked" : "running",
          kind: "crew",
        }),
      ),
      firstRunToday: null,
    },
    "/api/machine": {
      latest: {
        at: NOW,
        cpuPct: 41,
        cores: 8,
        memUsedBytes: 4,
        memTotalBytes: 10,
        memoryPressureFreePct: 62,
        diskFreeBytes: null,
        diskTotalBytes: null,
        agents: null,
      },
      warning: null,
      maxSeats: 12,
      seats: 11,
      perSessionMax: 11,
      transcripts: null,
    },
  };
  for (const r of ["1h", "6h", "24h", "7d"]) api[`/api/telemetry?range=${r}`] = data;
  return api;
};
