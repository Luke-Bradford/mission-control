import type {
  AgentView,
  AttentionBrief,
  AttentionItem,
  BoardItem,
  ConfigView,
  CrewRow,
  Escalation,
  GithubRateState,
  LimitRow,
  PullRequestView,
  Run,
} from "@mc/core";

/** Sat 17 Oct 2026 12:00 UTC = 13:00 BST. */
export const NOW = Date.UTC(2026, 9, 17, 12, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function run(over: Partial<Run> = {}): Run {
  return {
    id: "r-12",
    agentId: "shop-app-ta",
    repoId: "shop-app",
    seq: 12,
    startedAt: NOW - 25 * MIN,
    endedAt: null,
    status: "running",
    sessionId: "s-1",
    model: "claude-opus-4-1",
    branch: "feature/3349-quote-cache",
    ticket: "shop-app#3349",
    costUsd: 2.4712,
    tokens: { input: 12_000, output: 3_400, cacheRead: 1_200_000, cacheCreate: 40_000 },
    transcriptPath: "/x/t.jsonl",
    prs: [],
    summary: null,
    ...over,
  };
}

export function agent(over: Partial<AgentView> = {}): AgentView {
  return {
    id: "shop-app-ta",
    repoId: "shop-app",
    kind: "loop",
    role: null,
    mode: null,
    area: [],
    model: null,
    sessionId: null,
    loopKind: "ta-loop",
    accountId: "claude-main",
    state: "working",
    stateSince: NOW - 25 * MIN,
    currentRun: run(),
    paused: false,
    sourceError: null,
    note: null,
    stop: null,
    lastOutputAt: NOW - MIN,
    ...over,
  };
}

export function limit7d(over: Partial<Extract<LimitRow, { window: "7d" }>> = {}): LimitRow {
  return {
    accountId: "codex-main",
    window: "7d",
    used: 69,
    projected: 103,
    stopForecast: null,
    fullAt: null,
    resetAt: NOW + 30 * HOUR,
    alertAt: 70,
    stopAt: 80,
    stale: false,
    source: "app-server",
    sampledAt: NOW - 5 * MIN,
    ...over,
  };
}

export function limit5h(over: Partial<Extract<LimitRow, { window: "5h" }>> = {}): LimitRow {
  return {
    accountId: "claude-main",
    window: "5h",
    used: 41,
    projected: null,
    stopForecast: null,
    fullAt: null,
    resetAt: NOW + 2 * HOUR,
    alertAt: 85,
    stopAt: 95,
    stale: false,
    source: "oauth",
    sampledAt: NOW - 5 * MIN,
    ...over,
  };
}

export function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    id: "shop-app#4001",
    repoId: "shop-app",
    issueNumber: 4001,
    title: "Choose a cache eviction policy",
    kind: "operator-decision",
    source: "title",
    openedAt: NOW - 3 * HOUR,
    url: "https://github.com/octo-org/shop-app/issues/4001",
    question: null,
    ...over,
  };
}

export function boardItem(over: Partial<BoardItem> = {}): BoardItem {
  return {
    repoId: "shop-app",
    issueNumber: 3349,
    title: "Quote cache",
    status: "In Progress",
    state: "in progress",
    labels: ["perf"],
    priority: "P1",
    updatedAt: NOW - 2 * HOUR,
    url: "https://github.com/octo-org/shop-app/issues/3349",
    stage: null,
    owner: null,
    parent: null,
    subIssues: null,
    blockedBy: [],
    milestone: null,
    size: null,
    closed: false,
    prioritySource: "field",
    createdAt: NOW - 72 * HOUR,
    itemId: null,
    projectId: null,
    ...over,
  };
}

export function crewRow(over: Partial<CrewRow> = {}): CrewRow {
  return {
    id: "shop-app-ta",
    repoId: "shop-app",
    index: 0,
    hudState: "running",
    stateSince: NOW - 25 * MIN,
    accountId: "claude-main",
    kind: "loop",
    role: null,
    mode: null,
    area: [],
    model: null,
    sessionId: null,
    loopKind: "ta-loop",
    paused: false,
    note: null,
    stop: null,
    sourceError: null,
    ticket: "shop-app#3349",
    ticketTitle: "Quote cache",
    loop: null,
    run: {
      id: "r-12",
      seq: 12,
      startedAt: NOW - 25 * MIN,
      endedAt: null,
      status: "running",
      model: "claude-opus-4-1",
      branch: "feature/3349-quote-cache",
      tokens: { input: 12_000, output: 3_400, cacheRead: 1_200_000, cacheCreate: 40_000 },
      costUsd: 2.4712,
    },
    prs: [],
    summary: null,
    digest: null,
    contextWindow: null,
    lastOutputAt: NOW - MIN,
    cli: { version: null, effort: null },
    review: null,
    ...over,
  };
}

export function item(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    key: "esc:shop-app#4001",
    kind: "decision",
    agentId: "shop-app-ta",
    repoId: "shop-app",
    text: "Choose a cache eviction policy",
    tool: null,
    at: NOW - 3 * HOUR,
    url: "https://github.com/octo-org/shop-app/issues/4001",
    escalationId: "shop-app#4001",
    ticket: "shop-app#4001",
    acked: false,
    owner: "operator",
    ...over,
  };
}

export function brief(over: Partial<AttentionBrief> = {}): AttentionBrief {
  return {
    context: "The dev seat asks which port to preview on.",
    recommendation: "Use 5174.",
    options: [
      { label: "5174", answer: "Use port 5174." },
      { label: "5180", answer: "Use port 5180." },
    ],
    basis: "read config",
    at: NOW,
    ...over,
  };
}

/** A crew seat's question to the operator. */
export const SEAT_Q = item({
  key: "ask:7",
  kind: "question",
  agentId: "mc-dev-1",
  escalationId: null,
  url: null,
  ticket: null,
  text: "Which port?",
  brief: brief(),
});

/** An item from a hub that predates `owner`. */
export function itemWithoutOwner(over: Partial<AttentionItem> = {}): AttentionItem {
  const { owner: _owner, ...rest } = item(over);
  return rest as AttentionItem;
}

export const CONFIG: ConfigView = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [
    { id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 },
    { id: "codex-main", vendor: "codex", alertAt: 70, stopAt: 80 },
  ],
  repos: [
    {
      id: "shop-app",
      github: "octo-org/shop-app",
      project: 2,
      statusMap: { Todo: "planned", "In Progress": "in progress", Done: "done" },
      needsYouLabels: ["needs-design"],
      fullSuite: ["pnpm test", "pnpm -s test"],
    },
    {
      id: "site-builder",
      github: "octo-org/site-builder",
      project: 3,
      statusMap: { Backlog: "planned" },
      needsYouLabels: null,
      fullSuite: [],
    },
  ],
  loops: [
    {
      id: "shop-app-ta",
      repoId: "shop-app",
      kind: "ta-loop",
      accountId: "claude-main",
      stateDir: "/u/.shop-app-autonomy/var/autonomy",
      logsDir: null,
      worktree: "/u/.shop-app-autonomy",
      launchdLabel: "com.shop-app.ta-loop",
    },
  ],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: null,
};

/** Empty sessions on both repos, with ids distinct from their repo ids. */
export const SESSION_CONFIG: ConfigView = {
  ...CONFIG,
  crew: {
    worktrees: "/mc/crew",
    roles: [],
    sessions: ["shop-app", "site-builder"].map((repoId) => ({
      id: `${repoId}-session`,
      repoId,
      checkout: `/mc/${repoId}`,
      seats: [],
    })),
  },
};

/** CONFIG plus one crew session on shop-app: GUIDO writes in apps/, RETRO is read-only. */
export const CREW_CONFIG: ConfigView = {
  ...CONFIG,
  crew: {
    worktrees: "/mc/crew",
    roles: [
      {
        name: "GUIDO",
        prompt: "g",
        model: "sonnet",
        mode: "writer",
        loop: "build",
        tools: [],
        here: "",
      },
      {
        name: "INCO",
        prompt: "i",
        model: "sonnet",
        mode: "writer",
        loop: "build",
        tools: [],
        here: "",
      },
      {
        name: "RETRO",
        prompt: "r",
        model: "opus",
        mode: "read-only",
        loop: "none",
        tools: [],
        here: "",
      },
    ],
    sessions: [
      {
        id: "s1",
        repoId: "shop-app",
        checkout: "/mc/clone",
        seats: [
          {
            id: "guido-1",
            role: "GUIDO",
            mode: "writer",
            accountId: "claude-main",
            model: "sonnet",
            area: ["apps/**"],
          },
          {
            id: "retro-1",
            role: "RETRO",
            mode: "read-only",
            accountId: "claude-main",
            model: "sonnet",
            area: [],
          },
        ],
      },
    ],
  },
};

/** A PR as `/api/repos/<repo>/prs?linked=1` serves it. */
export const prView = (over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "shop-app",
  number: 77,
  title: "Cache quotes",
  url: "https://github.com/octo-org/shop-app/pull/77",
  branch: "feature/77-cache",
  ticket: "shop-app#77",
  state: "open",
  isDraft: false,
  review: null,
  ci: null,
  createdAt: NOW,
  updatedAt: NOW,
  mergedAt: null,
  headSha: null,
  mergeable: null,
  ...over,
});

/** A crew seat's row; `run: null` and idle unless overridden. */
export function seatRow(over: Partial<CrewRow> = {}): CrewRow {
  return crewRow({
    id: "guido-1",
    kind: "crew",
    loopKind: "crew",
    role: "GUIDO",
    mode: "writer",
    area: ["apps/**"],
    model: "sonnet",
    sessionId: "s1",
    ...over,
  });
}

/** A crew seat stopped after its run ended (`ok`); `merged` gives the run a merged PR #75. */
export function stoppedSeat(over: Partial<CrewRow> & { merged?: boolean } = {}): CrewRow {
  const { merged = false, ...rest } = over;
  const live = crewRow().run as NonNullable<CrewRow["run"]>;
  return seatRow({
    hudState: "stopped",
    ticket: "mission-control#74",
    ticketTitle: "Dead collector fallback",
    run: { ...live, status: "ok", endedAt: NOW - MIN },
    prs: merged
      ? [
          {
            repoId: "shop-app",
            number: 75,
            title: "Fallback",
            url: "https://github.com/octo-org/shop-app/pull/75",
            state: "merged",
            ticket: "mission-control#74",
          },
        ]
      : [],
    ...rest,
  });
}

export const REPOS = [
  { id: "shop-app", github: "octo-org/shop-app", project: 2 },
  { id: "site-builder", github: "octo-org/site-builder", project: 3 },
];

/** A GitHub budget reading taken at NOW: 4750 left, a poll costs 7, resets at 15:00 BST. */
export const GITHUB_RATE: GithubRateState = {
  queries: {
    board: { cost: 3, limit: 5000, remaining: 4800, resetAt: NOW + 120 * MIN, at: NOW - MIN },
    escalations: { cost: 1, limit: 5000, remaining: 4750, resetAt: NOW + 120 * MIN, at: NOW },
  },
  pollCost: 7,
};
export const GITHUB_RATE_LINE = "GitHub API · 4750 left · 7 per poll · resets 15:00";
