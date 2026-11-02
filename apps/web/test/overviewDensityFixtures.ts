import type {
  ConfigView,
  CrewRow,
  OverviewSummary,
  OverviewTimeline,
  PipelineStage,
} from "@mc/core";
import { agentView } from "./agentV2Fixture.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import {
  CREW_CONFIG,
  item,
  limit5h,
  limit7d,
  METRICS_VIEW,
  MIN,
  NOW,
  OVERVIEW,
  seatRow,
} from "./fixtures.ts";

export type OverviewScenario =
  | "default"
  | "empty"
  | "one"
  | "many"
  | "long"
  | "loading"
  | "error"
  | "stale"
  | "disconnected";

/** Explicit fictional observations; all views use these same APIs and frozen clock. */
export function overviewDensityFixture(scenario: OverviewScenario = "default") {
  const count = scenario === "empty" ? 0 : scenario === "one" ? 1 : scenario === "many" ? 50 : 11;
  const rows: CrewRow[] = Array.from({ length: count }, (_, index) =>
    seatRow({
      id: index === 0 ? "flight-1" : `dev-${index}`,
      index,
      sessionId: "demo",
      hudState: index === 0 || index % 4 === 0 ? "idle" : "running",
      ticket: index ? `shop-app#${100 + index}` : null,
      ticketTitle:
        scenario === "long"
          ? "A long recorded scope and recovery condition that must remain available to the operator. ".repeat(
              5,
            )
          : `Recorded fixture work ${index}`,
      run: { ...seatRow().run!, id: `fixture-run-${index}` },
    }),
  );
  if (rows[4])
    Object.assign(rows[4], {
      hudState: "blocked",
      note:
        scenario === "long"
          ? "Protected path clearance needs a named owner and narrow approved scope. ".repeat(5)
          : "Protected path clearance is required before proceeding.",
    });
  if (rows[9])
    Object.assign(rows[9], {
      hudState: "stopped",
      role: "RETRO",
      mode: "read-only",
      paused: true,
      run: null,
      queuedReview: {
        repoId: "shop-app",
        prNumber: 208,
        sha: "a".repeat(40),
        ref: "shop-app#108",
        position: 1,
        reason: "Account paused; this current-head review is queued.",
      },
    });
  const config: ConfigView = {
    ...CREW_CONFIG,
    operator: { id: "operator", timezone: "UTC" },
    loops: [],
    crew: {
      ...CREW_CONFIG.crew!,
      sessions: [
        {
          id: "demo",
          repoId: "shop-app",
          checkout: "/fixture/shop-app",
          seats: rows.map((row, index) => ({
            id: row.id,
            role: index === 9 ? "RETRO" : "GUIDO",
            accountId: "claude-main",
            model: "fixture-model",
            mode: index === 9 ? "read-only" : "writer",
            area: [],
            loop: index === 0 ? "watch" : "build",
          })),
        },
      ],
    },
  };
  const attention = rows.slice(1, 4).map((row, index) =>
    item({
      key: `overview:${index}`,
      agentId: row.id,
      ticket: row.ticket,
      kind: index ? "question" : "decision",
      text:
        scenario === "long"
          ? "The current head needs a recorded recovery choice and a named next owner before this work can proceed. ".repeat(
              5,
            )
          : [
              "Confirm the rollback boundary for the current head.",
              "Clarify the import scope before continuing.",
              "Choose the recorded recovery policy.",
            ][index],
    }),
  );
  const stage = (name: PipelineStage["stage"], n: number, offset: number): PipelineStage => ({
    stage: name,
    count: n,
    oldestAt: n ? NOW - 20 * MIN : null,
    cards: Array.from({ length: Math.min(n, 8) }, (_, i) => ({
      repoId: "shop-app",
      ticket: offset + i,
      title:
        scenario === "long"
          ? "Long fictional pipeline title with an inspectable recovery condition. ".repeat(5)
          : `Recorded ticket ${offset + i}`,
      pr: null,
      ci: [],
      since: NOW - 20 * MIN,
      who: `dev-${i + 1}`,
    })),
  });
  const summary: OverviewSummary = {
    ...OVERVIEW,
    at: scenario === "stale" ? NOW - 5 * MIN : NOW,
    kpis: count
      ? OVERVIEW.kpis
      : {
          tokensPerMin: { now: 0, series: [0, 0, 0] },
          spendToday: { usd: 0, perHour: [0, 0] },
          inFlight: { count: 0, oldestAt: null },
          ciPassRate24h: { pct: null, runs: 0, redNow: 0 },
          needsYou: { count: 0, overHour: 0 },
        },
    pipeline: [
      stage("ready", count ? 2 : 0, 201),
      stage("building", count ? 3 : 0, 211),
      stage("checks", count ? 1 : 0, 221),
      stage("review", count ? 1 : 0, 231),
      stage("merging", 0, 241),
      stage("merged", count ? 4 : 0, 251),
    ],
    machine: {
      cpu: [20, 24, null, 31, 37],
      mem: [25, 26, null, 31, 32],
      diskFreeGb: 412,
      disk: [420, 418, null, 414, 412],
    },
  };
  const timeline: OverviewTimeline = {
    from: NOW - 60 * MIN,
    to: NOW,
    lanes: rows.map((row, i) => ({
      agentId: row.id,
      spans:
        count && i % 3 !== 0
          ? [
              {
                kind: i % 2 ? "turn" : "checks",
                from: NOW - (45 - (i % 8)) * MIN,
                to: NOW - (20 - (i % 5)) * MIN,
              },
            ]
          : [],
      ticks: count && i % 2 ? [NOW - 25 * MIN, NOW - 15 * MIN] : [],
    })),
  };
  const api = {
    ...desktopFixture().api,
    ...Object.fromEntries(
      rows.flatMap((row) => [
        [`/api/agents/${row.id}`, agentView(row)],
        [
          `/api/agents/${row.id}/stream?limit=20`,
          { runId: row.run?.id ?? null, events: [], tasks: [], more: false, truncated: false },
        ],
      ]),
    ),
    ...Object.fromEntries(
      summary.pipeline
        .flatMap((lane) => lane.cards)
        .map((card) => [
          `/api/tickets/${card.repoId}/${card.ticket}`,
          {
            repoId: card.repoId,
            number: card.ticket,
            url: `https://github.com/octo-org/shop-app/issues/${card.ticket}`,
            title: card.title,
            state: "open",
            status: "In progress",
            priority: "P1",
            size: "M",
            labels: [],
            outcome: card.title,
            doneWhen: [],
            body: card.title,
            bodyTruncated: false,
            githubError: null,
            runs: [],
            prs: [],
            timeline: [],
            nextBefore: null,
          },
        ]),
    ),
    "/api/crew/pause": null,
    "/api/config": config,
    "/api/crew?shape=summary": { rows, firstRunToday: NOW - 60 * MIN },
    "/api/attention": attention,
    "/api/metrics": {
      ...METRICS_VIEW,
      ...(count
        ? {}
        : {
            merged: { count: 0, loops: 0 },
            cycleTime: { p50Ms: null, p85Ms: null, n: 0, excluded: 0 },
            cost: { usd: 0 },
          }),
      inProgress: { count: count ? 5 : 0, oldestAt: count ? NOW - 20 * MIN : null },
    },
    "/api/overview": summary,
    "/api/overview/timeline": timeline,
    "/api/flight": {
      seat: count
        ? { id: "flight-1", call: "FLIGHT", model: "fixture-model", state: "idle", live: true }
        : null,
      decisions: [],
    },
    "/api/flight/brief": { session: "demo", sections: [], watch: [] },
    "/api/limits": count
      ? [
          limit5h({ used: 41 }),
          limit7d({ accountId: "claude-main", used: 63 }),
          limit7d({ accountId: "codex-main", used: 12 }),
        ]
      : [],
    "/api/machine": {
      latest: count
        ? {
            at: NOW,
            cpuPct: 37.4,
            cores: 16,
            memUsedBytes: 20.5 * 2 ** 30,
            memTotalBytes: 64 * 2 ** 30,
            swapUsedBytes: 0,
            diskFreeBytes: 412 * 2 ** 30,
            diskTotalBytes: 1000 * 2 ** 30,
            agents: { count: 3, rssBytes: 2 * 2 ** 30, cpuPct: 80 },
          }
        : null,
      warning: null,
      maxSeats: 12,
      seats: count,
      perSessionMax: 12,
    },
    "/api/activity": Array.from({ length: count ? 50 : 0 }, (_, i) => ({
      at: NOW - i * MIN,
      kind: "run-start",
      who: "dev-1",
      text: `Recorded fixture event ${i + 1}`,
      ref: null,
      url: null,
      prs: [],
      status: null,
      summary: null,
    })),
  };
  return { api, rows, config, attention, timeline, summary };
}
