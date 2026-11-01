import type { ProfileStep, ReviewDepth } from "./profiles-model.ts";
import type { ReportedTest, ReviewVerdict } from "./review.ts";
import type { ConfigSeatMode, CrewEffort } from "./runtime.ts";
import type { CrewMode, CrewRole, LoopKind } from "./runtime-model.ts";
import type {
  AccountId,
  AgentId,
  CliAccountStatus,
  NotificationPreferences,
  RepoGoal,
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
  budgetUsd?: number | null;
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
    /** An absolute Codex profile directory; never contains credentials itself. */
    cliProfile?: string;
    binding?: "machine" | "profile";
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
    /** The account selected for new seats; null lets the repo use the first available account. */
    defaultAccountId?: string | null;
    /** Advice supplied to FLIGHT when it works this repo. It is deliberately not an eligibility rule. */
    guidance?: {
      priority: string[];
      milestone: string[];
      labels: string[];
      labelMode: "any" | "all";
      avoid: string[];
      direction: string;
    };
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

/** Models a configured account may use. Codex entries come from its live model/list catalog. */
export interface AccountModelsView {
  accountId: AccountId;
  models: { model: string; efforts: string[] }[];
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
  /** When GitHub closed it (epoch ms, whole seconds); null while open or when unread. */
  closedAt?: number | null;
  /** Plain text as written on GitHub, cut at 20 000 characters (`bodyTruncated`). */
  body: string;
  /**
   * The ticket's controller-check section, found on the full body before it was cut; null when
   * it has none. Absent: the reader did not look (use `body`).
   */
  controllerCheck?: string | null;
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
  /** Raw, bounded observations for the Instrument charts. Missing observations are never made up. */
  series?: {
    /** State intervals are clipped to the requested range. A terminal span ends at its last observation, never request time. */
    stateSpans: {
      agentId: AgentId;
      state: "running" | "waiting" | "parked" | "idle";
      startedAt: number;
      endedAt: number;
    }[];
    /** Quota samples keep natural gaps; reset rows mark a newly observed provider reset window. */
    quota: {
      accountId: AccountId;
      window: "5h" | "7d";
      alertAt: number;
      stopAt: number;
      points: { at: number; pct: number }[];
      /** Percentage points consumed in each selected-range interval; interval starts match throughput. */
      burn?: { at: number; spendPct: number }[];
      /** Estimated time usage reaches 100% at the selected range's observed pace, or null without spend. */
      projectedExhaustionAt?: number | null;
      resets: { at: number; resetAt: number; cause: string }[];
    }[];
    /** The board and run facts used to plot a ticket's cycle in hours. Null means that fact was not observed. */
    tickets: {
      ticket: string;
      readyAt: number | null;
      startedAt: number | null;
      mergedAt: number | null;
      doneAt: number | null;
    }[];
    /** Range-bounded throughput buckets. `at` is the start of the bucket. */
    throughput?: { at: number; merged: number }[];
    /** Daily quality buckets. Missing observations remain null rather than becoming zero. */
    quality?: {
      at: number;
      ciGreenFirstPushPct: number | null;
      reviewRoundsPerPr: number | null;
      firstPassReviewPct: number | null;
    }[];
    annotations: {
      at: number;
      kind: "crew-paused" | "crew-resumed" | "hub-update" | "quota-reset";
      cause: string;
    }[];
  };
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
  };
  /** FLOW_DAYS local days, oldest first, zeros kept. Kept for the summary tile. */
  throughput: { day: string; merged: number }[];
  /**
   * Start of work to Done by size over FLOW_DAYS, p50 and p85 in ms (the registry's cycle time,
   * `METRICS.cycleTime`, broken down); `excluded` = done issues with no start.
   */
  cycleTime: {
    rows: { size: string; p50Ms: number | null; p85Ms: number | null; tickets: number }[];
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
  tokensByTicket: {
    ticket: string;
    tokens: number;
    /** Cost allocated to the selected range, pro rata for runs crossing its boundary. */
    costUsd: number | null;
    /** Full cost of all observed runs for a ticket merged in the selected range; null otherwise. */
    totalCostUsd?: number | null;
  }[];
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
  /** pass/fail: the full suite's Post hook event; done: a release with no event; freed: the run ended. */
  outcome: "pass" | "fail" | "done" | "freed" | null;
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
  /** Holds started in the requested days (7 by default, up to QA_RETENTION_DAYS), newest first. */
  runs: TestLockRun[];
  /** Holds started since local midnight (operator timezone) and their time in line. */
  today: { runs: number; waitMs: number };
  /** Median length per command, once it has three done holds. */
  usualMs: Record<string, number>;
}

/** One check run of a PR head, as the hub polled it. */
export interface CiRunView {
  repoId: string;
  prNumber: number;
  sha: string;
  workflow: string | null;
  name: string;
  /** The Actions run attempt; 0 for a status or a non-Actions run. */
  attempt: number;
  state: "passing" | "failing" | "pending";
  conclusion: string;
  url: string | null;
  /** When the hub first read it, and when it last read it. */
  firstSeenAt: number;
  at: number;
}

/** `GET /api/qa/ci-runs`. */
export interface CiRunsView {
  runs: CiRunView[];
}

/** A review finding with its category and how it ended, for the QA board. */
export interface QaFindingView {
  reviewId: number;
  authorRunId: string;
  repoId: string;
  prNumber: number;
  round: number;
  reviewEndedAt: number | null;
  pos: number;
  severity: string;
  category: string | null;
  file: string;
  line: number;
  summary: string;
  resolution: string | null;
  resolvedReviewId: number | null;
}

/** One screenshot RETRO took on a review's preview; `GET /api/qa/review-shots/:id` serves its PNG. */
export interface ReviewShotView {
  id: string;
  label: string;
  /** The viewport width in px. */
  width: number;
  theme: "dark" | "light";
  at: number;
}

/** One completed RETRO review round, including clean rounds with no findings. */
export interface QaReviewRoundView {
  reviewId: number;
  authorRunId: string;
  repoId: string;
  prNumber: number;
  round: number;
  sha: string;
  verdict: ReviewVerdict;
  blocking: number;
  minor: number;
  endedAt: number;
  /** The screenshots RETRO took on the PR's preview during this round, oldest first. */
  screenshots: ReviewShotView[];
}

/** `GET /api/qa/findings`. */
export interface QaFindingsView {
  findings: QaFindingView[];
  reviews: QaReviewRoundView[];
}

/** `GET /api/qa/milestones`. */
export interface MilestonesView {
  milestones: RepoGoal[];
}

/** A `## Done when` bullet of a ticket's body and whether its box is ticked. */
export interface DoneWhenItem {
  text: string;
  checked: boolean;
}

/** One run on a ticket, as the page lists it. */
export interface TicketRunView {
  id: string;
  seat: AgentId;
  status: RunStatus;
  /** The loop phase the run last reached; null for a run no loop drives. */
  phase: string | null;
  startedAt: number;
  endedAt: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number } | null;
  costUsd: number | null;
}

/** A finding of one review round, with how a later round ended it. */
export interface TicketFindingView {
  pos: number;
  severity: string;
  file: string;
  line: number;
  summary: string;
  scenario: string;
  fix: string;
  state: "open" | "logged";
  resolution: string | null;
  resolvedInReviewId: number | null;
}

/** One review round of a PR. */
export interface TicketReviewRound {
  reviewId: number;
  round: number;
  sha: string;
  state: string;
  verdict: ReviewVerdict | null;
  summary: string | null;
  blocking: number;
  minor: number;
  at: number;
  findings: TicketFindingView[];
}

/** One PR of a ticket with its review rounds and the checks of each head it has had. */
export interface TicketPrView {
  number: number;
  title: string;
  url: string;
  branch: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  headSha: string | null;
  createdAt: number;
  mergedAt: number | null;
  rounds: TicketReviewRound[];
  /** Each head's latest attempt of every check, newest head first. */
  ci: {
    sha: string;
    at: number;
    checks: { name: string; conclusion: string; state: CiRunView["state"]; url: string | null }[];
  }[];
}

/** One entry of the ticket's timeline; `key` is stable and orders entries that share a time. */
export type TicketEvent = { key: string; at: number } & (
  | { kind: "run"; runId: string; seat: AgentId; status: RunStatus; phase: string | null }
  | {
      kind: "review";
      prNumber: number;
      reviewId: number;
      round: number;
      state: string;
      blocking: number;
      minor: number;
    }
  | { kind: "ci"; prNumber: number; sha: string; passing: number; failing: number; pending: number }
  | {
      kind: "decision";
      id: number;
      decisionKind: string;
      about: string;
      decision: string;
      basis: string;
    }
  | { kind: "comms"; id: string; from: string; to: string; label: string | null; text: string }
);

/** `GET /api/tickets/:repoId/:number`: everything Mission Control knows about one ticket. */
export interface TicketHistory {
  repoId: RepoId;
  number: number;
  /** The GitHub issue URL. */
  url: string;
  title: string;
  state: "open" | "closed";
  status: string | null;
  priority: string | null;
  size: string | null;
  labels: string[];
  /** The body's `## Outcome` section; null when the body has none or GitHub was unreachable. */
  outcome: string | null;
  doneWhen: DoneWhenItem[];
  /** The body as written, cut by the collector; null when GitHub was unreachable. */
  body: string | null;
  bodyTruncated: boolean;
  /** Why the body is missing; null when GitHub answered. */
  githubError: string | null;
  runs: TicketRunView[];
  prs: TicketPrView[];
  /** Newest first; one page. */
  timeline: TicketEvent[];
  /** Pass as `before` for the next page; null on the last. */
  nextBefore: string | null;
}

/** One comms message on a PR's readiness card. */
export interface PrUatComms {
  id: string;
  at: number;
  from: string;
  to: string;
  label: string | null;
  text: string;
}

/** A blocking finding as one line: `file:line summary`. */
export interface PrUatFinding {
  severity: string;
  file: string;
  line: number;
  summary: string;
}

/**
 * One review round that ran on the PR. `result`: `clean` (nothing blocking), `resolved` (every
 * blocking finding has a resolution) or `open` (at least one blocking finding has none).
 */
export interface PrUatRound {
  round: number;
  /** PR-wide chronological review number; unlike the engine round it survives Send back. */
  sequence?: number;
  reviewId: number;
  at: number;
  sha: string;
  blocking: PrUatFinding[];
  /** The author seat's newest message between this round and the next, if any. */
  reply: { at: number; from: string; text: string } | null;
  /** The first commit the branch got between this round and the next, if any. */
  fixSha: string | null;
  result: "clean" | "resolved" | "open";
}

/** What the operator needs to accept one PR: its comms, rework story and how to try the branch. */
export interface PrUatView {
  /** The immutable PR head these details describe. */
  sha?: string | null;
  qaSummary?: string | null;
  files?: string[];
  tests?: ReportedTest[];
  testsAdded?: { file: string; failedOnBase: boolean }[];
  screenshots?: ReviewShotView[];
  flightId?: string | null;
  repoId: string;
  number: number;
  /** The newest comms that name the PR or its ticket, newest first. */
  comms: PrUatComms[];
  /** Review rounds, newest first. */
  rounds: PrUatRound[];
  tryIt: { branch: string; commands: string[]; previewUrl: string | null };
  /**
   * Whether the PR waits for the operator's acceptance, since when (the park's time) and the note
   * the operator last sent it back with; null where there is none.
   */
  uat: { waiting: boolean; since: number | null; note: string | null };
}
