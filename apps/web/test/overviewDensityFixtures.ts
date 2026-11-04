import type {
  ConfigView,
  CrewRow,
  OverviewSummary,
  OverviewTimeline,
  PipelineStage,
  RunDigest,
} from "@mc/core";
import { agentView } from "./agentV2Fixture.ts";
import {
  boardColumnOf,
  DEMO_REPO,
  DEMO_TICKETS,
  demoPageAnswers,
  pipelineStages,
  prFlowView,
} from "./demoSeedPages.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import {
  CONFIG,
  CREW_CONFIG,
  crewRow,
  item,
  limit5h,
  limit7d,
  METRICS_VIEW,
  MIN,
  NOW,
  OVERVIEW,
  seatRow,
} from "./fixtures.ts";
import { flightSummary } from "./flightSummaryFixture.ts";

export type OverviewScenario =
  | "default"
  | "mixed"
  | "empty"
  | "one"
  | "many"
  | "long"
  | "loading"
  | "error"
  | "stale"
  | "disconnected";

/** Complete reported evidence: a null digest must never be spread into a partial non-null one. */
export function observedContextDigest(
  contextTokens: number | null,
  contextWindow: number | null,
  minuteTokens: [number, number][] = [],
): RunDigest {
  return {
    toolCalls: 0,
    turns: 0,
    lastEventAt: NOW - MIN,
    model: "fixture-model",
    contextTokens,
    contextWindow,
    liveTool: null,
    tools: {},
    subagents: [],
    minuteTokens,
    turnUsage: [],
    background: [],
    compactions: 0,
  };
}
const tokenHistory = [
  12000, 14000, 18000, 16000, 22000, 25000, 29000, 34000, 31000, 28000, 30000, 32000, 33000, 34000,
  34000, 38000, 36000, 42000, 39000, 45000, 43000, 46000, 44000, 48600, 46000, 43000, 40000, 42000,
  40800, 41200,
];
const stateMinutes = [25, 8, 5, 12, 34, 16, 2, 7, 41, 18, 11];
const costHistory = [
  0.08, 0.11, 0.12, 0.09, 0.13, 0.16, 0.18, 0.21, 0.18, 0.15, 0.14, 0.12, 0, 0, 0.11, 0.14, 0.16,
  0.18, 0.2, 0.21, 0.19, 0.18, 0.16, 0.15, 0.13, 0.12, 0.11, 0.1, 0.09, 0.08,
];
const machineHistory = {
  cpu: [
    20,
    21,
    22,
    24,
    26,
    28,
    30,
    28,
    26,
    25,
    27,
    29,
    null,
    null,
    28,
    30,
    32,
    34,
    36,
    37,
    39,
    41,
    38,
    37,
    36,
    35,
    34,
    35,
    36,
    37,
  ],
  mem: [
    25,
    25,
    26,
    26,
    26,
    27,
    27,
    28,
    28,
    29,
    29,
    30,
    null,
    null,
    30,
    30,
    31,
    31,
    31,
    32,
    32,
    32,
    33,
    33,
    32,
    32,
    32,
    32,
    32,
    32,
  ],
  disk: [
    420,
    420,
    419,
    419,
    419,
    418,
    418,
    418,
    417,
    417,
    417,
    416,
    null,
    null,
    416,
    416,
    415,
    415,
    415,
    414,
    414,
    414,
    414,
    414,
    413,
    413,
    413,
    413,
    412,
    412,
  ],
};

/** Explicit fictional observations; all views use these same APIs and frozen clock. */
export function overviewDensityFixture(scenario: OverviewScenario = "default") {
  const count =
    scenario === "empty"
      ? 0
      : scenario === "one"
        ? 1
        : scenario === "many"
          ? 50
          : scenario === "mixed"
            ? 9
            : 11;
  const rows: CrewRow[] = Array.from({ length: count }, (_, index) =>
    seatRow({
      id: index === 0 ? "flight-1" : `dev-${index}`,
      index,
      sessionId: "demo",
      digest: observedContextDigest(
        84_000 + index * 2_000,
        index === 7 ? null : index % 3 === 0 ? 200_000 : 400_000,
        tokenHistory.map((tokens, minute) => [
          NOW - (30 - minute) * MIN,
          Math.floor(tokens / count) + (index === 0 ? tokens % count : 0),
        ]),
      ),
      stateSince: NOW - stateMinutes[index % stateMinutes.length]! * MIN,
      contextWindow: index === 7 ? null : index % 3 === 0 ? 200_000 : 400_000,
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
  if (scenario === "mixed")
    rows.push(
      ...["loop-alpha", "loop-beta"].map((id, index) =>
        crewRow({
          id,
          repoId: "site-builder",
          index: 9 + index,
          hudState: index ? "blocked" : "parked",
          run: null,
          note: index
            ? "Driver stopped: recorded usage limit."
            : "Waiting for a recorded check result.",
          digest: observedContextDigest(76000 + index * 4000, 200000),
          contextWindow: 200000,
          stateSince: NOW - (12 + index * 4) * MIN,
        }),
      ),
    );
  const config: ConfigView = {
    ...CREW_CONFIG,
    operator: { id: "operator", timezone: "UTC" },
    loops:
      scenario === "mixed"
        ? rows
            .filter((row) => row.kind === "loop")
            .map((row) => ({
              ...CONFIG.loops[0],
              id: row.id,
              repoId: row.repoId,
              kind: "ta-loop",
              accountId: "claude-main",
              stateDir: "/fixture/observed/state",
              logsDir: null,
              worktree: "/fixture/observed",
              launchdLabel: `fixture.observed.${row.id}`,
            }))
        : [],
    crew: {
      ...CREW_CONFIG.crew!,
      sessions: [
        {
          id: "demo",
          repoId: "shop-app",
          checkout: "/fixture/shop-app",
          seats: rows
            .filter((row) => row.kind === "crew")
            .map((row, index) => ({
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
      ? {
          ...OVERVIEW.kpis,
          tokensPerMin: { now: 41200, series: tokenHistory },
          spendToday: {
            usd: 24.31,
            perHour: Array.from({ length: 24 }, (_, hour) => (hour === 11 ? 24.31 : 0)),
            series: costHistory,
          },
          ciPassRate24h: {
            ...OVERVIEW.kpis.ciPassRate24h,
            runs: 25,
            redNow: 2,
            series: Array.from({ length: 30 }, (_, i) =>
              i === 12 || i === 13 ? null : [80, 88, 92][i % 3],
            ),
          },
          inFlight: {
            count: 5,
            oldestAt: NOW - 20 * MIN,
            series: Array.from({ length: 30 }, (_, i) => [3, 4, 5][i % 3]),
          },
          needsYou: {
            count: attention.length,
            overHour: 0,
            series: Array.from({ length: 30 }, (_, i) => [1, 2, 3][i % 3]),
          },
        }
      : {
          tokensPerMin: { now: 0, series: tokenHistory.map(() => 0) },
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
      cpu: count ? machineHistory.cpu : [],
      mem: count ? machineHistory.mem : [],
      diskFreeGb: 412,
      disk: count ? machineHistory.disk : [],
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
    ...Object.fromEntries(
      attention.flatMap((item) => {
        const thread = {
          id: `discussion:${item.key}`,
          itemKey: item.key,
          version: "fixture-v1",
          messages: [],
        };
        const path = `/api/attention/${encodeURIComponent(item.key)}/discussion`;
        return [
          [path, thread],
          [`${path}?id=${encodeURIComponent(thread.id)}`, thread],
        ];
      }),
    ),
    "/api/settings/crew-pause": null,
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
    "/api/overview?session=demo": summary,
    "/api/metrics?session=demo": {
      ...METRICS_VIEW,
      merged: { count: 6, loops: 0 },
      inProgress: { count: 5, oldestAt: NOW - 20 * MIN },
    },
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

/**
 * The busy crew Demo plays and the tests render: the Overview's "default" scenario with every seat
 * working, the pipeline built from one ticket list, and an answer for every other page. All of it
 * is fictional, fixed at `NOW`; Demo moves it to the present.
 */
export function demoSeed() {
  const base = overviewDensityFixture("default");
  const rows = base.rows.map((row, index): CrewRow => {
    const ticket = DEMO_TICKETS.find((t) => t.seat === row.id);
    const blocked = row.id === "dev-4";
    return {
      ...row,
      hudState: blocked ? "blocked" : "running",
      paused: false,
      stop: null,
      queuedReview: null,
      note: blocked ? "Waiting for the breakpoint decision." : null,
      role: row.id === "dev-9" ? "RETRO" : row.id === "flight-1" ? "FLIGHT" : "GUIDO",
      mode: row.id === "dev-9" ? "read-only" : "writer",
      ticket: ticket ? `${DEMO_REPO}#${ticket.n}` : null,
      ticketTitle: ticket?.title ?? null,
      run: {
        ...(seatRow().run as NonNullable<CrewRow["run"]>),
        id: `demo-run-${index}`,
        status: "running",
        endedAt: null,
      },
    };
  });
  const attention = base.attention.map((entry, i) => ({
    ...entry,
    ticket: i === 0 ? `${DEMO_REPO}#104` : entry.ticket,
    agentId: i === 0 ? "dev-4" : entry.agentId,
    text: [
      "Which breakpoint should the address form use: 600 or 720 pixels?",
      "Confirm the import scope for the order export.",
      "Choose the retry policy for failed payment webhooks.",
    ][i] as string,
  }));
  const summary: OverviewSummary = {
    ...base.summary,
    pipeline: pipelineStages(DEMO_TICKETS),
    kpis: {
      ...base.summary.kpis,
      inFlight: { ...base.summary.kpis.inFlight, count: 9 },
      needsYou: { ...base.summary.kpis.needsYou, count: attention.length },
    },
  };
  const api: Record<string, unknown> = {
    ...base.api,
    ...demoPageAnswers(),
    ...Object.fromEntries(
      rows.flatMap((row) => [
        [`/api/agents/${row.id}`, agentView(row)],
        [`/api/crew/${row.id}`, agentView(row).row],
      ]),
    ),
    "/api/crew?shape=summary": { rows, firstRunToday: NOW - 3 * 60 * MIN },
    "/api/attention": attention,
    "/api/overview": summary,
    "/api/overview?session=demo": summary,
    "/api/prs/flow": prFlowView(),
    "/api/flight/summary": flightSummary(),
    "/api/settings/away": {
      on: false,
      until: "",
      may: { pickUp: true, research: false, check: true, status: true, safePr: false },
    },
  };
  for (const t of DEMO_TICKETS)
    api[`/api/tickets/${DEMO_REPO}/${t.n}`] = {
      repoId: DEMO_REPO,
      number: t.n,
      url: `https://github.com/octo-org/shop-app/issues/${t.n}`,
      title: t.title,
      state: t.stage === "merged" ? "closed" : "open",
      status: boardColumnOf(t.stage),
      priority: "P1",
      size: "M",
      labels: [],
      outcome: t.title,
      doneWhen: [],
      body: t.title,
      bodyTruncated: false,
      githubError: null,
      runs: [],
      prs: [],
      timeline: [],
      nextBefore: null,
    };
  return { ...base, rows, attention, summary, api };
}
