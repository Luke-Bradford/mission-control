import type { ProfileStep, ReviewDepth } from "./profiles.ts";
import type { ConfigSeatMode, CrewEffort, CrewMode, CrewRole, LoopKind } from "./runtime.ts";
import type {
  AccountId,
  AgentId,
  CliAccountStatus,
  NotificationPreferences,
  RepoId,
  RunDigest,
  RunPr,
  RunStatus,
  SubagentInfo,
  TicketState,
} from "./types.ts";

/** One template profile as `/api/config` shows it. */
export interface ConfigProfile {
  name: string;
  labels: string[];
  steps: (ProfileStep & { agents?: string[] })[];
  nodes?: ProfileStep[];
  trigger?: string;
  budget?: number | null;
  orchestrationOnly?: boolean;
  planRequired: boolean;
  reviewer: { role: string; depth: ReviewDepth };
  tries: number;
  rounds: number;
}

/** Per-agent numbers in the Overview (no route serves it now). Token counts are totals of all four kinds. */
export interface AgentNumbers {
  agentId: AgentId;
  runs24h: number;
  runs14d: number;
  /** Finished runs in 14d by outcome; running/unknown runs are in neither. */
  ok14d: number;
  failed14d: number;
  tokens24h: number;
  tokens14d: number;
  /** API-equivalent; null when no run in the window reported a cost. */
  costUsd24h: number | null;
  costUsd14d: number | null;
  /** Summed wall time of runs (clipped to the window), minutes. */
  busyMinutes14d: number;
  /** The live CLI session of the loop, when one is matched; null otherwise. */
  session: { id: string; startedAt: number; status: "busy" | "idle" | null } | null;
}

/** The KPI strip and per-agent numbers (no route serves it now). */
export interface Overview {
  agents: AgentNumbers[];
  /** Board items per state across all repos (done = done and updated in the last 7 days, as on Boards). */
  tickets: Record<TicketState, number>;
  /** Board items that moved to done in the last 24h / 14d (by their last update). */
  closed24h: number;
  closed14d: number;
  tokens24h: number;
  costUsd24h: number | null;
}

export type ActivityKind =
  | "run-start"
  | "run-end"
  | "escalation"
  | "collector"
  | "state"
  | "pr-opened"
  | "pr-merged"
  | "board"
  | "loop"
  | "push"
  | "check"
  | "commit"
  | "lock"
  | "guard";

/** One `/api/activity` row, newest first. Derived from runs, escalations and collector health. */
export interface ActivityEvent {
  /** Exact source run when known; absent for events without a run. */
  runId?: string;
  at: number;
  /** Agent id, repo id or collector name. */
  who: string;
  kind: ActivityKind;
  text: string;
  /** `repo#123` when the event is about a ticket; for run events the run's resolved ticket. */
  ref: string | null;
  url: string | null;
  /** run events only */
  status: RunStatus | null;
  /** The PRs the run published (run events; `[]` otherwise). */
  prs: RunPr[];
  /** The run's one-line summary (run events), else null. */
  summary: string | null;
}

/** A hand-off (catalogue §2.1.3 Messages): `who` sent `text` to `to`. Each is a seat id, COMMS_CAPCOM or COMMS_MC. */
export interface CommsEvent extends Omit<ActivityEvent, "kind"> {
  kind: "comms";
  to: string;
}

/** One `/api/activity` row. */
export type ActivityRow = ActivityEvent | CommsEvent;

/** One agent's totals for one day (`YYYY-MM-DD` in the operator's timezone). */
export interface MetricsDay {
  day: string;
  agentId: AgentId;
  runs: number;
  ok: number;
  failed: number;
  tokens: number;
  /** API-equivalent; null when no run that day reported a cost. */
  costUsd: number | null;
  busyMinutes: number;
}

/** The last 14 days, oldest first (no route serves it now). */
export interface Metrics {
  days: string[];
  agents: AgentId[];
  perAgentDay: MetricsDay[];
  /** Board items moved to done per day and repo. */
  closedPerDay: { day: string; repoId: RepoId; count: number }[];
}

/** `/api/config`: the loaded config, read-only, never including the password hash. */
export interface ConfigView {
  operator: { id: string; timezone: string };
  /**
   * The GitHub login the hub acts as (the authenticated `gh` user). The server always sets it, null
   * when the read fails; optional only until the web fixtures carry it.
   */
  githubLogin?: string | null;
  accounts: {
    id: AccountId;
    vendor: "claude" | "codex";
    alertAt: number;
    stopAt: number;
    binding?: "machine";
    canCheck?: boolean;
    signInHint?: string;
    status?: CliAccountStatus;
  }[];
  notificationPreferences?: NotificationPreferences;
  repos: {
    id: RepoId;
    github: string;
    project: number;
    statusMap: Record<string, TicketState>;
    /** null: unset in the file (the GitHub collector then uses its default, `needs-design`). */
    needsYouLabels: string[] | null;
    /** Commands that count as a full suite: they take the test lock. */
    fullSuite: string[];
  }[];
  loops: {
    id: AgentId;
    repoId: RepoId;
    kind: "ta-loop" | "studio-loop";
    accountId: AccountId;
    stateDir: string;
    logsDir: string | null;
    worktree: string;
    launchdLabel: string;
  }[];
  poll: { usageMinutes: number; githubSeconds: number };
  /** null: no `crew` section in the file. */
  crew: {
    worktrees: string;
    /** Every role a seat may hold: the built-ins and `crew.roles`, by name. */
    roles?: {
      name: string;
      prompt: string;
      model: string;
      mode: CrewMode;
      loop: LoopKind;
      tools: string[];
      here: string;
    }[];
    sessions: {
      id: string;
      repoId: RepoId;
      checkout: string;
      branch?: string | null;
      managedCheckout?: boolean;
      seats: {
        id: AgentId;
        focus?: string | null;
        displayCallSign?: string | null;
        role: CrewRole;
        mode: CrewMode;
        loop?: LoopKind;
        accountId: AccountId;
        model: string;
        area: string[];
        /** Removed from config.yaml, kept until free: it takes no new work. */
        retiring?: boolean;
        /** Codex model validation has not succeeded yet. */
        unavailable?: string;
      }[];
    }[];
  } | null;
  /** Template profiles, read per request; absent when the server has no profiles path. */
  profiles?: {
    /** The profiles file, or BUILTIN_PROFILES_SOURCE when none exists. */
    source: string;
    version?: string;
    /** Why the file cannot be loaded; null when it can. `list` is then empty. */
    error: string | null;
    list: ConfigProfile[];
  };
}

/** A seat as config.yaml says it (what Setup edits). */
export interface SeatInput {
  id: string;
  role: string;
  accountId: string;
  model: string;
  effort?: CrewEffort;
  mode?: ConfigSeatMode;
  area: string[];
}

/** A seat change from config.yaml that waits for something. */
export interface PendingSeatChange {
  sessionId: string;
  seatId: string;
  change: "add" | "edit" | "remove";
  reason: string;
}

/** `GET /api/crew/changes`: what the last read of config.yaml says against what runs. */
export interface CrewChanges {
  /** config.yaml's seats, as last loaded. */
  sessions: { id: string; seats: SeatInput[] }[];
  pending: PendingSeatChange[];
  /** Changed on disk, applies after a restart: `loops`, `crew.deny_read`, … */
  restartNeeded: string[];
  /** Why the last read failed. */
  error: string | null;
  checkedAt: number | null;
}

/** `POST /api/config/reload`. */
export interface ReloadResult extends CrewChanges {
  applied: string[];
}

/** One issue in full, read live from GitHub for the board's detail pane. */
export interface TicketView {
  author?: string | null;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  /** Plain text as written on GitHub, cut at 20 000 characters (`bodyTruncated`). */
  body: string;
  /** True when the collector cut `body`. */
  bodyTruncated: boolean;
  /** The body's length in characters (code points) before the cut; the collector always sets it. */
  bodyLength?: number;
  labels: string[];
  milestone: string | null;
  /** `repoId`: the configured repo the item lives in (it may differ from the issue's), else null. */
  subIssues: { number: number; title: string; state: "open" | "closed"; repoId: RepoId | null }[];
  pullRequests: {
    number: number;
    title: string;
    url: string;
    state: "open" | "closed" | "merged";
    repoId: RepoId | null;
  }[];
}

/** One series per configured agent, in config order. */
export interface AgentSeries {
  agentId: AgentId;
  points: number[];
}

/**
 * `GET /api/telemetry?range=`. "Today" is since local midnight in the operator's timezone; a run
 * that started before midnight counts pro rata to its wall time inside today. Tokens are
 * input + output unless named otherwise.
 */
export interface Telemetry {
  /** The range's crew runs by loop step, pro rata like `tokensByTicket`; all three steps are sent. */
  tokensByStep?: {
    step: "plan" | "build" | "review";
    tokens: number;
    costUsd: number | null;
    runs: number;
  }[];
  /** Today since local midnight: seat questions the operator answered, and the runs they stopped. */
  capcom?: {
    answered: number;
    medianMs: number | null;
    p90Ms: number | null;
    stopped: number;
    longest: { agentId: AgentId; ms: number } | null;
    agentWaitMs: number;
  };
  today: {
    /** Commits today by the scoped agents. */
    commits?: number;
    tokens: number;
    /** Cache-read tokens today, pro rata like `tokens`. */
    cacheRead: number;
    /** API-equivalent; null when no run today reported a cost. */
    costUsd: number | null;
    toolCalls: number;
    turns: number;
    /** Crew rows Running now. */
    working: number;
    /** Configured loops. */
    agents: number;
    /** PRs merged in the last 7 days. */
    merged7d: number;
  };
  /** FLOW_DAYS local days, oldest first, zeros kept. */
  throughput: { day: string; merged: number }[];
  /** Start of work to Done; `excluded` = done issues with no start. */
  cycleTime: {
    rows: { size: string; medianDays: number | null; tickets: number }[];
    excluded: number;
  };
  /** Over FLOW_DAYS of merged PRs whose first-push CI is known; null when there are none. */
  quality: {
    /** Over the PRs `reviewRoundsPerPr` covers: blocking + minor findings per PR; null when none. */
    retroFindingsPerPr?: number | null;
    /** Of those PRs, the ones a reported review sent back (blocking > 0). */
    sentBackPrs?: number;
    /** Median time a `ready` or `review` note waited for the operator, over FLOW_DAYS; null when none. */
    humanReviewWaitMs?: number | null;
    ciGreenFirstPushPct: number | null;
    prs: number;
    /** Mean review rounds per merged PR (over FLOW_DAYS) that has a reported review; null when none. */
    reviewRoundsPerPr?: number | null;
    /** % of those PRs whose round 1 review had no blocking findings; null when none. */
    firstPassReviewPct?: number | null;
    /** The merged PRs with a reported review: what the two figures above cover. */
    reviewedPrs?: number;
    /** Mean commits per finished, looped, non-review crew run started over FLOW_DAYS; null when none. */
    commitsPerRun?: number | null;
  };
  /** TELEMETRY_POINTS points over the range, tokens per minute. */
  tokensPerMinute: AgentSeries[];
  /** The last LIVE_MINUTES minutes, oldest first, from the digests' minute buckets. */
  liveMinutes: AgentSeries[];
  /** % of today so far. The four measured shares plus unknown sum to 100. */
  utilisation: {
    agentId: AgentId;
    working: number;
    waiting: number;
    /** Blocked, parked or stalled. */
    blocked?: number;
    /** History without recorded state evidence; never assumed working or idle. */
    unknown?: number;
    idle: number;
  }[];
  /** The latest run's per-turn usage. */
  turnUsage: { agentId: AgentId; turns: RunDigest["turnUsage"] }[];
  toolLatency: {
    tool: string;
    calls: number;
    p50Ms: number | null;
    p95Ms: number | null;
    slowest?: { detail: string | null; agentId: AgentId; durationMs: number } | null;
    failed: number;
  }[];
  subagents: (SubagentInfo & { agentId: AgentId })[];
  quota: { accountId: AccountId; window: "5h" | "7d"; points: { at: number; pct: number }[] }[];
  machine: { at: number; cpuPct: number | null; memPct: number | null }[];
  tokensByTicket: { ticket: string; tokens: number; costUsd: number | null }[];
  totals: {
    agentId: AgentId;
    accountId: AccountId;
    model: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheHitPct: number | null;
    additions?: number | null;
    deletions?: number | null;
    turns: number;
    toolCalls: number;
    costUsd: number | null;
  }[];
}

export interface TestLockRun {
  runId: string;
  seatId: string;
  command: string;
  /** When it joined the line; startedAt when it took the lock at once. */
  queuedAt: number;
  startedAt: number;
  /** Null while held. */
  endedAt: number | null;
  outcome: "done" | "freed" | null;
  ticket: string | null;
}

export interface TestLockEntryView {
  runId: string;
  seatId: string;
  command: string;
  since: number;
  /** "{repoId} full suite" when command is one of the seat's repo's full_suite entries, else the command. */
  label: string;
}

/** `GET /api/test-lock`, with labels. */
export interface TestLockView {
  holder: (TestLockEntryView & { usualMs: number | null }) | null;
  waiting: TestLockEntryView[];
}

export interface TestLockHistory {
  /** Holds started in the last 7 days (TELEMETRY_RANGES["7d"]), newest first. */
  runs: TestLockRun[];
  /** Holds started since local midnight (operator timezone) and their time in line. */
  today: { runs: number; waitMs: number };
  /** Median length per command, once it has three done holds. */
  usualMs: Record<string, number>;
}
