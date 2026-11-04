/**
 * The fictional crew's answers for every page but the Overview: Comms, Telemetry, Audit, Setup,
 * the Board, the Map, FLIGHT and QA. All of it is invented: no token, real path or real account.
 * `demoSeed()` (overviewDensityFixtures.ts) joins these to the Overview's answers.
 */
import {
  type AuditView,
  type CommsMessage,
  type FlightPrFlowRow,
  type FlightPrFlowView,
  LIVE_MINUTES,
  type MapSnapshot,
  type PipelineStage,
  TELEMETRY_POINTS,
  type Telemetry,
} from "@mc/core";
import { shiftTimes } from "../src/demo/shift.ts";
import { codeHealthBrowserApi } from "./codeHealthBrowserFixtures.ts";
import { codeRiskFixture } from "./codeRiskFixtures.ts";
import { boardItem, HOUR, MIN, NOW, prView } from "./fixtures.ts";
import { prFlowFixture } from "./prFlowFixture.ts";
import { qaAcceptanceFixture } from "./qaAcceptanceFixture.ts";
import { qaHistoryApi, qaHistorySavedReport } from "./qaHistoryFixture.ts";
import { testHealthFixture } from "./testHealthFixtures.ts";

export const DEMO_REPO = "shop-app";
export const DEMO_REPOS = [DEMO_REPO, "site-builder"] as const;

/** The seats, in the order the crew table lists them. */
export const SEAT_IDS = [
  "flight-1",
  ...Array.from({ length: 10 }, (_, i) => `dev-${i + 1}`),
] as const;

export interface DemoTicket {
  n: number;
  title: string;
  /** Overview pipeline stage. */
  stage: "ready" | "building" | "checks" | "review" | "merged";
  /** The seat working it, when one is. */
  seat: string | null;
}

/** The pipeline's tickets: the seats' own work first, then what waits and what has shipped. */
export const DEMO_TICKETS: readonly DemoTicket[] = [
  { n: 101, title: "Cache the quote total at checkout", stage: "building", seat: "dev-1" },
  { n: 102, title: "Retry failed payment webhooks", stage: "building", seat: "dev-2" },
  { n: 103, title: "Paginate the order history", stage: "building", seat: "dev-3" },
  { n: 104, title: "Fix the address form on narrow screens", stage: "building", seat: "dev-4" },
  { n: 105, title: "Add stock badges to product cards", stage: "building", seat: "dev-5" },
  { n: 106, title: "Speed up the search index rebuild", stage: "building", seat: "dev-6" },
  { n: 107, title: "Export orders as CSV", stage: "checks", seat: "dev-7" },
  { n: 108, title: "Show delivery estimates in the cart", stage: "review", seat: "dev-9" },
  { n: 109, title: "Localise the receipt email", stage: "building", seat: "dev-8" },
  { n: 110, title: "Reduce image weight on the home page", stage: "building", seat: "dev-10" },
  { n: 201, title: "Audit the coupon rules", stage: "ready", seat: null },
  { n: 202, title: "Dark mode for the admin screens", stage: "ready", seat: null },
  { n: 251, title: "Remember the shipping choice", stage: "merged", seat: null },
  { n: 252, title: "Stop double-charging on retry", stage: "merged", seat: null },
  { n: 253, title: "Faster category filters", stage: "merged", seat: null },
  { n: 254, title: "Fix the broken wishlist link", stage: "merged", seat: null },
];

const PIPELINE_ORDER: readonly PipelineStage["stage"][] = [
  "ready",
  "building",
  "checks",
  "review",
  "merging",
  "merged",
];

/** The Overview's pipeline, counted from the ticket list. */
export function pipelineStages(tickets: readonly DemoTicket[]): PipelineStage[] {
  return PIPELINE_ORDER.map((name) => {
    const here = tickets.filter((t) => t.stage === name);
    return {
      stage: name,
      count: here.length,
      oldestAt: here.length ? NOW - 40 * MIN : null,
      cards: here.slice(0, 8).map((t, i) => ({
        repoId: DEMO_REPO,
        ticket: t.n,
        title: t.title,
        pr: null,
        ci: [],
        since: NOW - (10 + i * 4) * MIN,
        who: t.seat ?? "",
      })),
    };
  });
}

const COLUMN_STATUS: Record<DemoTicket["stage"], string> = {
  ready: "Ready",
  building: "In progress",
  checks: "In review",
  review: "In review",
  merged: "Done",
};

export const boardColumnOf = (stage: DemoTicket["stage"]): string => COLUMN_STATUS[stage];

export function boardItems(tickets: readonly DemoTicket[] = DEMO_TICKETS) {
  return tickets.map((t, i) =>
    boardItem({
      repoId: DEMO_REPO,
      issueNumber: t.n,
      title: t.title,
      status: COLUMN_STATUS[t.stage],
      state:
        t.stage === "merged"
          ? "done"
          : t.stage === "ready"
            ? "planned"
            : t.stage === "building"
              ? "in progress"
              : "review",
      closed: t.stage === "merged",
      labels: [],
      priority: i % 3 === 0 ? "P0" : "P1",
      size: (["S", "M", "L"] as const)[i % 3] ?? "M",
      updatedAt: NOW - (i + 1) * 7 * MIN,
      createdAt: NOW - (i + 3) * 5 * HOUR,
      url: `https://github.com/octo-org/shop-app/issues/${t.n}`,
    }),
  );
}

/** Every ticket's PR number, so a ticket that moves during the scene still has its reads. */
export const allPrs = (tickets: readonly DemoTicket[]) =>
  tickets.filter((t) => t.stage !== "ready").map((t) => ({ number: t.n + 1000 }));

/** Tickets still being built that already have a PR open. */
const BUILDING_WITH_PR: ReadonlySet<number> = new Set([103, 105, 106]);

export function openPrs(tickets: readonly DemoTicket[] = DEMO_TICKETS) {
  return tickets
    .filter(
      (t) =>
        t.stage === "checks" ||
        t.stage === "review" ||
        (t.stage === "building" && BUILDING_WITH_PR.has(t.n)),
    )
    .map((t) =>
      prView({
        repoId: DEMO_REPO,
        number: t.n + 1000,
        title: t.title,
        ticket: `${DEMO_REPO}#${t.n}`,
        state: "open",
        url: `https://github.com/octo-org/shop-app/pull/${t.n + 1000}`,
        updatedAt: NOW - 3 * MIN,
      }),
    );
}

// ---- Comms ---------------------------------------------------------------------------------

const SPEAKERS = SEAT_IDS.filter((id) => id !== "dev-9");
const LINES = [
  "Starting on the checkout cache: reading the quote module first.",
  "The webhook retry needs a backoff. Proposing three tries, then park.",
  "Tests pass locally; pushing the branch now.",
  "Which pagination size does the order page want? Twenty or fifty?",
  "Twenty. Keep the page size in one constant.",
  "Review found one Important item on the address form; fixing it.",
  "CI is green on the stock badges. Ready for review.",
  "I am parked on the search index: waiting for the test lock.",
  "Merged the shipping-choice change. Moving to the next ticket.",
  "Handing the receipt email to review; strings are in the locale file.",
];

export function commsMessage(
  i: number,
  at: number,
  over: Partial<CommsMessage> = {},
): CommsMessage {
  const from = SPEAKERS[i % SPEAKERS.length] ?? "dev-1";
  return {
    id: `comms:${i}`,
    at,
    from,
    to: "crew",
    text: LINES[i % LINES.length] ?? "",
    ticket: null,
    label: null,
    ref: null,
    replyTo: null,
    mentions: [],
    reactions: [],
    pinned: false,
    operator: false,
    ...over,
  };
}

export const crewMessages = (count = 40): CommsMessage[] =>
  Array.from({ length: count }, (_, i) => commsMessage(i + 1, NOW - (count - i) * 3 * MIN));

export const flightMessages = (): CommsMessage[] => [
  commsMessage(1001, NOW - 20 * MIN, {
    from: "CAPCOM",
    to: "flight-1",
    text: "How is the checkout work going?",
    operator: true,
  }),
  commsMessage(1002, NOW - 18 * MIN, {
    from: "flight-1",
    to: "CAPCOM",
    text: "Three tickets are building, one is in review and one is blocked on the address form. Nothing needs you yet.",
  }),
  commsMessage(1003, NOW - 6 * MIN, {
    from: "flight-1",
    to: "CAPCOM",
    text: "dev-4 is asking which breakpoint the address form should use. It is in Needs you.",
  }),
];

/** Who talks to whom: a ring of working seats, each pair with a running count. */
export function commsLinks() {
  const talkers = SEAT_IDS.filter((id) => id !== "dev-9");
  return talkers
    .flatMap((from, i) => [
      {
        from,
        to: talkers[(i + 1) % talkers.length] as string,
        count: 4 + ((i * 3) % 7),
        tokens: 900 + i * 130,
      },
      { from, to: "flight-1", count: 2 + (i % 4), tokens: 400 + i * 60 },
    ])
    .filter((link) => link.from !== link.to)
    .concat([
      { from: "CAPCOM", to: "flight-1", count: 5, tokens: 700 },
      { from: "flight-1", to: "CAPCOM", count: 6, tokens: 1500 },
    ]);
}

/** A seat's contacts, counted from the same links the graph draws. */
export function contactsOf(id: string) {
  const counts = new Map<string, number>();
  for (const link of commsLinks()) {
    if (link.from === id) counts.set(link.to, (counts.get(link.to) ?? 0) + link.count);
    else if (link.to === id) counts.set(link.from, (counts.get(link.from) ?? 0) + link.count);
  }
  return [...counts].map(([other, count]) => ({ id: other, lastMessage: null, count, unread: 0 }));
}

function commsApi(): Record<string, unknown> {
  const crew = crewMessages();
  const flight = flightMessages();
  return {
    "/api/comms/crew": { messages: crew, hasEarlier: false, unread: 0 },
    "/api/comms/crew?history=1": { messages: crew, hasEarlier: false, unread: 0 },
    "/api/comms/flight": { messages: flight, cursor: "comms:1003", unread: 0 },
    "/api/comms/mentions": { mentions: [] },
    "/api/comms/pins": { messages: [] },
    "/api/comms/links": { links: commsLinks() },
    // Traffic is hour by hour from the clock, so source.ts builds it on each read.
    "/api/comms/metrics": {
      from: NOW - 24 * HOUR,
      to: NOW,
      p95BySeat: SEAT_IDS.filter((id) => id !== "dev-9").map((seatId, i) => ({
        seatId,
        p95: 220 + i * 35,
        n: 12 + i * 3,
      })),
    },
    "/api/comms/chatter": { pairs: [] },
    ...Object.fromEntries(
      SEAT_IDS.flatMap((id) => {
        const mine = crew.filter((m) => m.from === id).slice(-8);
        const body = {
          messages: mine,
          inbox: [],
          contacts: contactsOf(id),
          unread: 0,
          inboxUnread: 0,
          directUnread: 0,
        };
        return [
          [`/api/comms/agents/${id}`, body],
          [`/api/comms/agents/${id}?summary=1`, body],
          [`/api/comms/${id}`, { messages: mine }],
        ];
      }),
    ),
  };
}

// ---- Telemetry and Audit -------------------------------------------------------------------

const wave = (n: number, base: number, swing: number): number[] =>
  Array.from({ length: n }, (_, i) => Math.round(base + swing * Math.sin(i / 4)));

export function telemetryView(): Telemetry {
  const ids = SEAT_IDS.slice(0, 6);
  const states = ["running", "running", "waiting", "running", "idle"] as const;
  const day = (back: number) => new Date(NOW - back * 24 * HOUR).toISOString().slice(0, 10);
  return {
    series: {
      stateSpans: ids.flatMap((agentId, i) =>
        Array.from({ length: 5 }, (_, k) => ({
          agentId,
          state: states[(k + i) % states.length] ?? "running",
          startedAt: NOW - (5 - k) * HOUR,
          endedAt: NOW - (4 - k) * HOUR,
        })),
      ),
      quota: [
        {
          accountId: "claude-main",
          window: "5h" as const,
          alertAt: 85,
          stopAt: 95,
          points: Array.from({ length: 12 }, (_, k) => ({
            at: NOW - (12 - k) * 25 * MIN,
            pct: 8 + k * 3,
          })),
          burn: Array.from({ length: 12 }, (_, k) => ({
            at: NOW - (12 - k) * 25 * MIN,
            spendPct: 3,
          })),
          projectedExhaustionAt: NOW + 6 * HOUR,
          resets: [],
        },
        {
          accountId: "codex-main",
          window: "7d" as const,
          alertAt: 70,
          stopAt: 80,
          points: Array.from({ length: 12 }, (_, k) => ({
            at: NOW - (12 - k) * 25 * MIN,
            pct: 5 + k,
          })),
          burn: Array.from({ length: 12 }, (_, k) => ({
            at: NOW - (12 - k) * 25 * MIN,
            spendPct: 1,
          })),
          projectedExhaustionAt: null,
          resets: [],
        },
      ],
      tickets: DEMO_TICKETS.map((t, i) => ({
        ticket: `${DEMO_REPO}#${t.n}`,
        readyAt: NOW - (30 + i * 3) * HOUR,
        startedAt: NOW - (28 + i * 3) * HOUR,
        mergedAt: t.stage === "merged" ? NOW - (i + 1) * HOUR : null,
        doneAt: t.stage === "merged" ? NOW - (i + 1) * HOUR : null,
      })),
      throughput: Array.from({ length: 14 }, (_, k) => ({
        at: NOW - (14 - k) * 24 * HOUR,
        merged: 2 + (k % 5),
      })),
      quality: Array.from({ length: 14 }, (_, k) => ({
        at: NOW - (14 - k) * 24 * HOUR,
        ciGreenFirstPushPct: 80 + (k % 6) * 3,
        reviewRoundsPerPr: 1.2 + (k % 4) / 10,
        firstPassReviewPct: 60 + (k % 5) * 5,
      })),
      annotations: [
        {
          at: NOW - 8 * HOUR,
          kind: "hub-update" as const,
          cause: "Hub updated to the latest build.",
        },
      ],
    },
    capcom: {
      answered: 9,
      medianMs: 6 * MIN,
      p90Ms: 18 * MIN,
      stopped: 1,
      longest: { agentId: "dev-4", ms: 31 * MIN },
      agentWaitMs: 54 * MIN,
    },
    today: {
      commits: 31,
      tokens: 2_840_000,
      cacheRead: 41_000_000,
      costUsd: 24.31,
      toolCalls: 1480,
      turns: 312,
      working: 8,
      agents: 11,
    },
    throughput: Array.from({ length: 14 }, (_, i) => ({ day: day(13 - i), merged: 2 + (i % 5) })),
    cycleTime: {
      rows: [
        { size: "XS", p50Ms: 2 * HOUR, p85Ms: 4 * HOUR, tickets: 6 },
        { size: "S", p50Ms: 5 * HOUR, p85Ms: 9 * HOUR, tickets: 12 },
        { size: "M", p50Ms: 11 * HOUR, p85Ms: 20 * HOUR, tickets: 7 },
        { size: "L", p50Ms: 26 * HOUR, p85Ms: 40 * HOUR, tickets: 2 },
        { size: "XL", p50Ms: null, p85Ms: null, tickets: 0 },
        { size: "none", p50Ms: 8 * HOUR, p85Ms: 14 * HOUR, tickets: 3 },
      ],
      excluded: 1,
    },
    quality: {
      ciGreenFirstPushPct: 88,
      prs: 27,
      retroFindingsPerPr: 1.8,
      sentBackPrs: 6,
      humanReviewWaitMs: 22 * MIN,
      reviewRoundsPerPr: 1.4,
      firstPassReviewPct: 64,
      reviewedPrs: 24,
      commitsPerRun: 3.2,
    },
    tokensPerMinute: ids.map((agentId, i) => ({
      agentId,
      points: wave(TELEMETRY_POINTS, 900 + i * 120, 400),
    })),
    liveMinutes: ids.map((agentId, i) => ({
      agentId,
      points: wave(LIVE_MINUTES, 800 + i * 90, 300),
    })),
    utilisation: ids.map((agentId, i) => ({
      agentId,
      working: 55 + i * 4,
      waiting: 10,
      blocked: i === 4 ? 12 : 0,
      idle: 35 - i * 4 - (i === 4 ? 12 : 0),
    })),
    turnUsage: ids.map((agentId) => ({
      agentId,
      turns: Array.from({ length: 8 }, (_, i) => ({
        input: 300 + i * 20,
        output: 200 + i * 35,
        cacheRead: 9000 + i * 500,
      })),
    })),
    toolLatency: [
      { tool: "Bash", calls: 412, p50Ms: 2800, p95Ms: 41_000, failed: 9 },
      { tool: "Read", calls: 811, p50Ms: 100, p95Ms: 400, failed: 0 },
      { tool: "Edit", calls: 266, p50Ms: 180, p95Ms: 900, failed: 2 },
    ],
    subagents: [
      {
        agentId: "dev-1",
        taskId: "t1",
        type: "Explore",
        description: "Find the quote cache",
        status: "completed",
        tokens: 41_000,
        toolUses: 12,
        durationMs: 65_000,
      },
    ],
    quota: [
      {
        accountId: "claude-main",
        window: "5h",
        points: [
          { at: NOW - 5 * HOUR, pct: 10 },
          { at: NOW - 2 * HOUR, pct: 30 },
          { at: NOW - MIN, pct: 41 },
        ],
      },
      {
        accountId: "codex-main",
        window: "7d",
        points: [
          { at: NOW - 4 * HOUR, pct: 8 },
          { at: NOW - MIN, pct: 12 },
        ],
      },
    ],
    machine: Array.from({ length: 12 }, (_, i) => ({
      at: NOW - (12 - i) * 15 * MIN,
      cpuPct: 28 + (i % 5) * 4,
      memPct: 31 + (i % 3),
    })),
    tokensByTicket: DEMO_TICKETS.slice(0, 8).map((t, i) => ({
      ticket: `${DEMO_REPO}#${t.n}`,
      tokens: 300_000 - i * 25_000,
      costUsd: 3.2 - i * 0.3,
    })),
    tokensByStep: [
      { step: "plan", tokens: 400_000, costUsd: 3.1, runs: 9 },
      { step: "build", tokens: 2_100_000, costUsd: 17.4, runs: 31 },
      { step: "review", tokens: 340_000, costUsd: 3.8, runs: 12 },
    ],
    totals: ids.map((agentId, i) => ({
      agentId,
      accountId: "claude-main",
      model: "fixture-model",
      input: 12_000 + i * 900,
      output: 3_400 + i * 200,
      cacheRead: 1_200_000,
      cacheHitPct: 96,
      turns: 40 + i,
      toolCalls: 500 + i * 20,
      additions: 42,
      deletions: 7,
      costUsd: 2.4 + i * 0.1,
    })),
  };
}

export function auditView(): AuditView {
  return {
    range: { since: NOW - 7 * 24 * HOUR, until: NOW },
    longRunners: [
      {
        runId: "fixture-run-3",
        agentId: "dev-3",
        ticket: `${DEMO_REPO}#103`,
        startedAt: NOW - 5 * HOUR,
        endedAt: null,
        kind: "observed",
        actionable: true,
        durationMs: 5 * HOUR,
      },
    ],
    deathLoops: [],
    reworkRounds: [{ runId: "fixture-run-9", agentId: "dev-9", rounds: 2, maxRound: 2 }],
    refusalsByRule: [{ rule: "protected-path", count: 3 }],
    refusals: [{ agentId: "dev-4", runId: "fixture-run-4", rule: "protected-path", count: 3 }],
    refusalSpikes: [],
    spendOutliers: [],
    questions: { asked: 9, answered: 8, answerMs: 12 * MIN },
    costPerMergedTicket: DEMO_TICKETS.filter((t) => t.stage === "merged").map((t, i) => ({
      ticket: `${DEMO_REPO}#${t.n}`,
      costUsd: 2.1 + i * 0.4,
    })),
    modelPromptTimeline: [],
    prSizes: { prs: [], outliers: [] },
    chatter: [],
    flakes: [],
    changes: [],
    surgeonProposals: [],
  } as AuditView;
}

const accountModels = (accountId: string) => ({
  accountId,
  models: [{ model: "fixture-model", efforts: ["low", "high"] }],
});

const awayDigest = () => ({
  active: false,
  groups: [
    { kind: "needYouNow", items: [] },
    { kind: "safePrsReady", items: [] },
    { kind: "draftsToWalkThrough", items: [] },
    { kind: "failures", items: [] },
    { kind: "flightDecisions", items: [] },
    { kind: "messagesDrafted", items: [] },
  ],
});

// ---- Setup, FLIGHT and QA ----------------------------------------------------------------------

/** Per-seat reads a seat's page makes on its Queue and Files tabs. */
function seatApi(): Record<string, unknown> {
  return Object.fromEntries(
    SEAT_IDS.flatMap((id) => {
      const focus = "Finish the ticket in hand, then take the next Ready one.";
      return [
        [`/api/seats/${id}/focus`, { focus, effectiveFocus: focus, focusInstructionId: null }],
        [
          `/api/seats/${id}/instructions?limit=1`,
          {
            active: [],
            history: [],
            nextCursor: null,
            effectiveFocus: focus,
            focusInstructionId: null,
          },
        ],
        [
          `/api/seats/${id}/instructions?limit=50`,
          {
            active: [],
            history: [],
            nextCursor: null,
            effectiveFocus: focus,
            focusInstructionId: null,
          },
        ],
        [
          `/api/agents/${id}/files`,
          {
            files: mapFiles()
              .slice(0, 3)
              .map((f, i) => ({
                path: f.path,
                add: 12 + i * 5,
                del: 2 + i,
                state: i === 2 ? "uncommitted" : "committed",
                commitSha: i === 2 ? null : "a".repeat(40),
              })),
            note: null,
            sha: null,
          },
        ],
      ];
    }),
  );
}

function setupApi(): Record<string, unknown> {
  return {
    "/api/crew/changes": {
      sessions: [],
      pending: [],
      restartNeeded: [],
      error: null,
      checkedAt: NOW,
    },
    "/api/version": { sha: "demo000", branch: "main", behind: 0, checkedAt: NOW, dirty: false },
    "/api/health": [],
    "/api/sources/teams": {
      enabled: false,
      selected: [],
      note: "Teams is not used in Demo.",
      retryAt: null,
    },
    "/api/sources/teams/selection": { selected: [] },
    "/api/away/digest": awayDigest(),
    "/api/notification-preferences": {
      enabled: true,
      softChime: false,
      categories: {},
      quietHours: { start: "22:00", end: "07:00", timezone: "UTC" },
    },
    "/api/guard/hits?days=7": { hits: [], counts: {} },
    "/api/test-lock/history": { runs: [], today: { runs: 0, waitMs: 0 }, usualMs: {} },
    "/api/repos/profiles": [],
    "/api/update/log": {
      text: "Checking for updates\nAlready up to date at demo000.\nNothing to do.",
    },
    "/api/accounts/status": [],
    "/api/accounts/models": ["claude-main", "codex-main"].map((accountId) =>
      accountModels(accountId),
    ),
    ...Object.fromEntries(
      ["claude-main", "codex-main"].map((id) => [
        `/api/accounts/${id}/models`,
        {
          accountId: id,
          models: [{ id: "fixture-model", efforts: ["low", "high"] }],
          checkedAt: NOW,
          error: null,
        },
      ]),
    ),
  };
}

/** The QA queue: the open PRs, newest first. */
export function qaQueue(tickets: readonly DemoTicket[]) {
  const sha = "a".repeat(40);
  return {
    prs: openPrs(tickets).map((pr, i) => ({
      repoId: DEMO_REPO,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      branch: `feature/${pr.number - 1000}-demo`,
      ticket: pr.ticket,
      state: "open",
      isDraft: false,
      review: i === 0 ? "approved" : "none",
      ci: i === 0 ? "passing" : "pending",
      createdAt: NOW - (i + 2) * HOUR,
      updatedAt: NOW - 5 * MIN,
      mergedAt: null,
      headSha: sha,
      mergeable: "MERGEABLE",
      ...(i === 0 ? { uat: { sha, since: NOW - 40 * MIN } } : {}),
    })),
    flightId: "flight-1",
  };
}

/**
 * The saved-evidence reads for each open PR, copied from the QA fixture. That fixture reads the
 * clock when it loads, so it is moved onto `NOW` first, like the rest of the seed.
 */
function qaPrApi(tickets: readonly DemoTicket[]): Record<string, unknown> {
  const clock = Date.now();
  const fixture = shiftTimes(qaAcceptanceFixture(1), clock, NOW - clock);
  const out: Record<string, unknown> = {};
  for (const pr of allPrs(tickets)) {
    for (const [path, value] of Object.entries(fixture)) {
      if (path === "/api/qa/queue") continue;
      const own = (text: string) =>
        text
          .replaceAll('"mission-control"', `"${DEMO_REPO}"`)
          .replaceAll("mission-control/", `${DEMO_REPO}/`)
          .replaceAll("1011", String(pr.number));
      out[own(path)] = JSON.parse(own(JSON.stringify(value)));
    }
    out[`/api/qa-reports?repoId=${DEMO_REPO}&prNumber=${pr.number}`] = { reports: [] };
    out[`/api/qa-reports?repoId=${DEMO_REPO}&prNumber=${pr.number}&headSha=${"a".repeat(40)}`] = {
      reports: [],
    };
  }
  return out;
}

/** What GitHub says of each ticket, read live for the Board's detail pane. */
function ticketItems(tickets: readonly DemoTicket[]): Record<string, unknown> {
  return Object.fromEntries(
    tickets.map((t) => [
      `/api/boards/${DEMO_REPO}/items/${t.n}`,
      {
        number: t.n,
        title: t.title,
        url: `https://github.com/octo-org/shop-app/issues/${t.n}`,
        state: t.stage === "merged" ? "closed" : "open",
        body: `${t.title}.\n\nDone when the change is reviewed and merged.`,
        bodyTruncated: false,
        labels: [],
        milestone: null,
        subIssues: [],
        pullRequests: [],
      },
    ]),
  );
}

/** What FLIGHT remembers of each repo. */
function memoryApi(): Record<string, unknown> {
  const note = (topic: string, kind: string, body: string, ago: number) => ({
    repoId: DEMO_REPO,
    topic,
    kind,
    body,
    source: "crew retrospective",
    author: "flight",
    updatedAt: NOW - ago,
  });
  return {
    [`/api/flight/memory?repo=${DEMO_REPO}`]: {
      notes: [
        note(
          "checkout cache",
          "lesson",
          "Cache invalidation on the quote total needs the cart version in the key.",
          3 * HOUR,
        ),
        note(
          "webhook retries",
          "playbook",
          "Three tries with backoff, then park the run and tell the operator.",
          26 * HOUR,
        ),
        note(
          "test lock",
          "crew",
          "Full-suite runs queue on one lock; build in small steps meanwhile.",
          50 * HOUR,
        ),
      ],
    },
    "/api/flight/memory?repo=site-builder": { notes: [] },
  };
}

/** The files each open PR changes, for the Map's PR focus. */
function prFiles(tickets: readonly DemoTicket[]): Record<string, unknown> {
  const tree = mapFiles();
  return Object.fromEntries(
    allPrs(tickets).map((pr, i) => [
      `/api/repos/${DEMO_REPO}/prs/${pr.number}/files`,
      { files: [0, 1, 2].map((k) => tree[(i * 5 + k * 7) % tree.length]?.path ?? "") },
    ]),
  );
}

function flightApi(): Record<string, unknown> {
  return {
    "/api/flight/orders?limit=1": { active: [], history: [], nextCursor: null },
    "/api/flight/instructions": { seats: [] },
    "/api/drafts": [],
    "/api/drafts/history": [],
    "/api/attention/held": [],
    "/api/flight/incoming": { entries: [] },
    "/api/flight/schedule": { entries: [] },
    "/api/flight/ledger?status=open": {
      session: "demo",
      entries: [],
      more: false,
      nextOffset: null,
    },
    "/api/flight/ledger?status=all": {
      session: "demo",
      entries: [],
      more: false,
      nextOffset: null,
    },
  };
}

// ---- The Map ---------------------------------------------------------------------------------

const MAP_DIRS = ["app", "api", "cart", "checkout", "orders", "search", "shared", "email"];

export function mapFiles(count = 60): { path: string; lines: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const dir = MAP_DIRS[i % MAP_DIRS.length] ?? "app";
    return {
      path: `src/${dir}/module-${Math.floor(i / MAP_DIRS.length) + 1}.ts`,
      lines: 40 + ((i * 37) % 260),
    };
  });
}

export function mapSnapshot(
  seatIds: readonly string[],
  tickets: readonly DemoTicket[],
): MapSnapshot {
  const tree = mapFiles();
  const mine = tickets.filter((t) => t.seat && seatIds.includes(t.seat));
  return {
    repoId: DEMO_REPO,
    tree,
    imports: tree.slice(1).map((f, i) => ({ from: f.path, to: tree[i % 8]?.path ?? f.path })),
    hist: { since: NOW - 30 * 24 * HOUR, prCount: 0, fixCount: 0, files: {}, coupling: [] },
    rules: { areas: { "area:app": ["src/**"] }, hardRules: [] },
    seats: mine.map((t, i) => ({
      seat: t.seat as string,
      state: "running",
      since: NOW - (10 + i) * MIN,
      ticket: t.n,
      title: t.title,
      branches: [`feature/${t.n}-demo`],
      area: ["src/**"],
      changedOn: [`feature/${t.n}-demo`],
      nowTicket: null,
      tickets: { [`feature/${t.n}-demo`]: t.n },
      calls: [],
      scope: {
        read: [tree[i * 3]?.path ?? "", tree[i * 3 + 1]?.path ?? ""],
        modified: [{ file: tree[i * 3 + 2]?.path ?? "", add: 10 + i, rem: 2, source: "churn" }],
      },
      recent: [{ file: tree[i * 3]?.path ?? "", at: NOW - 5 * MIN }],
      context: { total: 84_000, window: 400_000 },
      badges: { questions: [], failures: [], review: null, tests: null, ci: null, waiting: null },
    })),
    findings: [],
    conflicts: [],
    conflictsUnchecked: [],
    seq: 0,
  };
}

/** Everything but the Overview's own answers; the keys are request paths. */
export function demoPageAnswers(
  tickets: readonly DemoTicket[] = DEMO_TICKETS,
): Record<string, unknown> {
  const telemetry = telemetryView();
  const clock = Date.now();
  const ownRepo = (text: string, repo = DEMO_REPO) =>
    text
      .replaceAll("repo=sample", `repo=${repo}`)
      .replaceAll('"repoId":"sample"', `"repoId":"${repo}"`);
  const base = {
    ...codeHealthBrowserApi(NOW),
    ...codeRiskFixture(NOW).api,
    ...testHealthFixture(NOW).api,
  };
  const health = Object.fromEntries(
    DEMO_REPOS.flatMap((repo) =>
      Object.entries(base)
        .filter(([path]) => path.startsWith("/api/code-health"))
        .map(([path, value]) => [
          ownRepo(path, repo),
          JSON.parse(ownRepo(JSON.stringify(value), repo)),
        ]),
    ),
  );
  // The history fixture is written for other repos; Demo's are its own.
  const history = JSON.parse(
    JSON.stringify(shiftTimes(qaHistoryApi(3), clock, NOW - clock))
      .replaceAll("mission-control", DEMO_REPO)
      .replaceAll('{"id":"sample"}', '{"id":"site-builder"}'),
  ) as Record<string, unknown>;
  for (const i of [0, 2]) {
    const report = JSON.parse(
      JSON.stringify(shiftTimes(qaHistorySavedReport(i), clock, NOW - clock)).replaceAll(
        "mission-control",
        DEMO_REPO,
      ),
    );
    const path = `/api/qa-reports?repoId=${DEMO_REPO}&prNumber=${report.prNumber}`;
    history[path] = { reports: [report] };
    history[`${path}&headSha=${report.headSha}`] = { reports: [report] };
  }
  return {
    ...health,
    ...history,
    ...memoryApi(),
    ...seatApi(),
    ...prFiles(tickets),
    ...commsApi(),
    ...setupApi(),
    ...flightApi(),
    ...qaPrApi(tickets),
    ...ticketItems(tickets),
    "/api/qa/queue": qaQueue(tickets),
    "/api/audit?range=7d": auditView(),
    "/api/audit?range=24h": auditView(),
    "/api/audit?range=30d": auditView(),
    ...Object.fromEntries(
      ["1h", "6h", "24h", "7d", "30d"].map((r) => [`/api/telemetry?range=${r}`, telemetry]),
    ),
    [`/api/boards/${DEMO_REPO}`]: boardItems(tickets),
    "/api/boards/site-builder": [],
    [`/api/repos/${DEMO_REPO}/prs?linked=1&shape=summary`]: openPrs(tickets),
    [`/api/repos/${DEMO_REPO}/prs`]: openPrs(tickets),
    [`/api/repos/${DEMO_REPO}/map`]: mapSnapshot(
      SEAT_IDS.filter((id) => id !== "flight-1"),
      tickets,
    ),
  };
}

/** The PR flow table, from the same tickets and seats as the rest of the crew. */
export function prFlowView(tickets: readonly DemoTicket[] = DEMO_TICKETS): FlightPrFlowView {
  const base = prFlowFixture(0);
  const stageOf: Record<DemoTicket["stage"], FlightPrFlowRow["stage"]> = {
    ready: "building",
    building: "building",
    checks: "CI",
    review: "review",
    merged: "merge",
  };
  const rows: FlightPrFlowRow[] = openPrs(tickets).map((pr, i) => {
    const t = tickets.find((x) => `${DEMO_REPO}#${x.n}` === pr.ticket) as DemoTicket;
    const seat = t.seat ?? "dev-1";
    return {
      pr: pr.number,
      ticket: `${DEMO_REPO}#${t.n}`,
      title: t.title,
      owner: seat,
      ownerKind: "seat",
      seatId: seat,
      stage: stageOf[t.stage],
      stageSince: NOW - (i + 1) * 9 * MIN,
      ownerSince: NOW - (i + 1) * 9 * MIN,
      openSince: NOW - (i + 2) * 40 * MIN,
      waitsOn:
        t.stage === "checks" ? ["CI to finish"] : t.stage === "review" ? ["review by dev-9"] : [],
      blocks: i === 0 ? [`${DEMO_REPO}#104`] : [],
      lastAction: "pushed",
      lastActor: seat,
      lastActionAt: NOW - 4 * MIN,
    };
  });
  return {
    generatedAt: NOW,
    repos: [
      {
        ...(base.repos[0] as FlightPrFlowView["repos"][number]),
        repoId: DEMO_REPO,
        generatedAt: NOW,
        unowned: 0,
        rows,
      },
    ],
  };
}

/** What Mission Control knows of one ticket: the page for it, from the ticket's place in the pipeline. */
export function ticketHistory(t: DemoTicket, at = NOW) {
  const merged = t.stage === "merged";
  const sha = "a".repeat(40);
  const runId = `demo-run-${t.seat ?? t.n}`;
  return {
    repoId: DEMO_REPO,
    number: t.n,
    url: `https://github.com/octo-org/shop-app/issues/${t.n}`,
    title: t.title,
    state: merged ? "closed" : "open",
    status: COLUMN_STATUS[t.stage],
    priority: "P1",
    size: "M",
    labels: [],
    outcome: t.title,
    doneWhen: [],
    body: t.title,
    bodyTruncated: false,
    githubError: null,
    runs:
      t.seat || merged
        ? [
            {
              id: runId,
              seat: t.seat ?? "dev-1",
              status: merged ? "ok" : "running",
              phase: merged ? "done" : "build",
              startedAt: at - 3 * HOUR,
              endedAt: merged ? at - 20 * MIN : null,
              tokens: { input: 12_000, output: 3_400, cacheRead: 1_200_000, cacheCreate: 40_000 },
              costUsd: 2.47,
            },
          ]
        : [],
    prs:
      t.stage === "ready"
        ? []
        : [
            {
              number: t.n + 1000,
              title: t.title,
              url: `https://github.com/octo-org/shop-app/pull/${t.n + 1000}`,
              branch: `feature/${t.n}-demo`,
              state: merged ? "merged" : "open",
              isDraft: false,
              headSha: sha,
              createdAt: at - 2 * HOUR,
              mergedAt: merged ? at - 20 * MIN : null,
              rounds: [],
              ci: [
                {
                  sha,
                  at: at - 30 * MIN,
                  checks: [{ name: "test", conclusion: "success", state: "passing", url: null }],
                },
              ],
            },
          ],
    timeline:
      t.stage === "ready"
        ? []
        : [
            {
              key: `c:${t.n}`,
              at: at - 6 * MIN,
              kind: "comms",
              id: `comms:${t.n}`,
              from: t.seat ?? "flight-1",
              to: "crew",
              label: null,
              text: merged
                ? "Merged. Moving to the next ticket."
                : "Tests pass locally; pushing the branch now.",
            },
            {
              key: `r:${t.n}`,
              at: at - 3 * HOUR,
              kind: "run",
              runId,
              seat: t.seat ?? "dev-1",
              status: merged ? "ok" : "running",
              phase: merged ? "done" : "build",
            },
          ],
    nextBefore: null,
  };
}

/** The roles Demo's seats hold, spread so the Comms graph can place them apart. */
export const SEAT_ROLES: Record<string, string> = {
  "flight-1": "FLIGHT",
  "dev-1": "GUIDO",
  "dev-2": "GUIDO",
  "dev-3": "GUIDO",
  "dev-4": "INCO",
  "dev-5": "INCO",
  "dev-6": "INCO",
  "dev-7": "FAO",
  "dev-8": "FAO",
  "dev-9": "RETRO",
  "dev-10": "GUIDO",
};
