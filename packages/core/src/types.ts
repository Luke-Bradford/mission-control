import type { Owner, Stage } from "./board.ts";
import type { CrewPause } from "./crew-pause.ts";
import type { CatchUpKind, FlightNotTriagingCause } from "./flight.ts";
import type { FlightPowers } from "./guard.ts";
import type { AttentionKind, AttentionOwner, HudColumn, HudState } from "./hud.ts";
import type { ProfileStepPhase, RunProfile } from "./profiles.ts";
import type { ReviewStatus } from "./review.ts";
import type { CrewMode, CrewRole, CrewVendor, LoopKind, SeatState } from "./runtime.ts";

export type RepoId = string;
export type AgentId = string;
export type AccountId = string;
export type AgentState = "working" | "waiting-agent" | "waiting-you" | "idle" | "error";
export type TicketState = "planned" | "in progress" | "review" | "blocked" | "done";
export type RunStatus = "running" | "ok" | "failed" | "blocked" | "unknown";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/** Recorded usage; missing token measurements stay null. */
export interface RunUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreate: number | null;
  costUsd: number | null;
  model: string | null;
  turns: number | null;
  durationMs: number;
}

/** The CLI's last word when a run ended without an accepted report. */
export interface NoReport {
  code: number | null;
  signal: string | null;
  stopReason: string | null;
  resultSubtype: string | null;
  terminalReason: string | null;
  apiErrorStatus: number | null;
  isError: boolean | null;
  error: string | null;
  /** Completed turns in the run (result frames), not the CLI's per-result num_turns. */
  turns: number | null;
  tokens: TokenUsage | null;
  lastAssistantText: string | null;
  lastStderr: string | null;
}

/** The plan the ticket had when the run started, or its Size waiver. */
/**
 * Where a build run's plan came from: the latest recorded report_plan for its ticket (which may
 * predate a hand edit of the plan), a plan on the ticket the hub never recorded (by and at null),
 * or the Size that let it start without one. Planner and review runs carry none.
 */
export type RunPlan =
  | { by: AgentId; at: number; ref: string }
  | { by: null; at: null; ref: string }
  | { skipped: `Size ${string}` };

export interface Run {
  /** Absent on legacy callers; stored as Claude by default. */
  vendor?: CrewVendor;
  /** Latest execution plan text from the seat, separate from the ticket plan snapshot. */
  latestPlan?: string;
  id: string;
  agentId: AgentId;
  repoId: RepoId;
  seq: number;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
  sessionId: string | null;
  model: string | null;
  branch: string | null;
  ticket: string | null;
  /**
   * The ticket's title when the run started (a crew run has it for the brief). Null or absent on a
   * run that never had one, and on rows from before it was stored; `/api/agents/:id/runs` always
   * sends it, as string or null.
   */
  ticketTitle?: string | null;
  /** The review this run performs (7b-1); absent or null on every other run. */
  reviewId?: number | null;
  costUsd: number | null;
  tokens: TokenUsage | null;
  transcriptPath: string;
  /** PRs the run published (`repo` = `owner/name` as the transcript gives it), first-seen order. */
  prs: { repo: string; number: number }[];
  /** The first sentences of the run's latest result text, DONE skipped (see workSummary), else null. */
  summary: string | null;
  /** The first loop's state; absent or null on a run no loop drives. */
  loop?: RunLoop | null;
  /** The template profile the run started with, as it was then; absent on a run without one. */
  profile?: RunProfile | null;
  /** Snapshotted at creation; absent on older runs or when no plan or Size waiver applies. */
  plan?: RunPlan;
  /** The `claude` CLI version the run started on; absent on a run that did not record it. */
  cliVersion?: string | null;
  /** Immutable launch binding, absent on runs stored before audit capture. */
  accountId?: AccountId | null;
  /** Immutable launch effort, absent when the CLI used its default. */
  effort?: string | null;
  /** The loop kind of the seat that started the run, kept so Audit still knows it after the seat is gone; absent on older runs. */
  loopKind?: LoopKind | null;
  /** SHA-256 of the role brief, generated preamble, and first step prompt. */
  promptHash?: string | null;
  /** Who ended the run; null while it runs, and on rows from before it was recorded. */
  endedBy?: "operator" | "engine" | "exit" | null;
  /** Absent until a session ends without its loop's report. */
  noReport?: NoReport | null;
}

export type LoopPhase = "working" | "ci" | "review" | "parked" | "done";

/** The steps after a PR is ready, in the order the engine does them; `done` holds those finished. */
export type MergeStep =
  | "ready"
  | "merge"
  | "close"
  | "file-minor"
  | "delete-remote"
  | "delete-local";

/**
 * FLIGHT's re-run of the failed Actions jobs on a ruled sha: the runs it re-ran (with the attempt
 * each was on before), and what they came to.
 */
export interface CiRerun {
  sha: string;
  runs: { id: number; attempt: number }[];
  outcome: "pending" | "passed" | "failed";
}

/** What the first loop's reconciler keeps per run, as JSON on the run's row. */
export interface RunLoop {
  /** Computed from the checked diff; FLIGHT copies this exact key and evidence path. */
  awayBugDecision?: { headSha: string; about: string; testPaths: string[] } | null;
  awaitingFlight?: string | null;
  flightClearedSha?: string | null;
  /** One extra author rework round FLIGHT may grant after the review-round cap, per head. */
  flightReworks?: Record<string, number>;
  phase: LoopPhase;
  reportedEvidenceId: number;
  prNumber: number | null;
  pushStartedAt: number | null;
  /** The commit `pushStartedAt` was started for: a new commit in `ci` starts the clock again. */
  pushFor: string | null;
  /** When the operator last un-parked the run; the CI clocks run from the later of this and the push. */
  unparkedAt: number | null;
  ciFails: number;
  ciFailedSha: string | null;
  /** The failed sha whose excerpt was claimed. */
  relayedSha: string | null;
  transient: number;
  lastRefusal: string | null;
  epoch: number;
  budgetExtra: number;
  parked: { kind: string; reason: string; ended: boolean } | null;
  /** Hard-rule files in the pushed sha's diff. */
  touches: {
    sha: string;
    paths: string[];
    flightPowers?: FlightPowers;
    hardRulesHash?: string;
  } | null;
  /** `<phase>:<epoch>` whose card move is done. */
  cardFor: string | null;
  /** CAPCOM waived the review findings on this sha (un-park of a review park). */
  reviewWaivedSha?: string | null;
  /** A no-commit response to this blocking review; RETRO must judge it in a fresh round. */
  reviewReplyTo?: number | null;
  /** The passing review whose Minor list the PR body carries, and how many it listed. */
  prBody?: { reviewId: number; minor: number } | null;
  /** Off its seat while in review; `wake`: rework or a park is due, so it goes back first. */
  aside?: { worktree: string; wake: boolean } | null;
  /**
   * The engine's reads for the pushed sha: origin's default-branch tip, whether it is an ancestor
   * of `sha`, whether every commit in `sha --not mainSha` is in run_commits, and the changed
   * paths outside the seat's area or protected.
   */
  gate?: {
    area?: string[];
    sha: string;
    mainSha: string;
    missionControlChanged?: boolean;
    containsMain: boolean;
    hubOnly: boolean;
    strays: string[];
    /** The PR changes the HUD, so a passing RETRO design check is required before readiness. */
    webChanged?: boolean;
  } | null;
  /** The tech-debt issue filed from this run's merged PR. */
  minorIssueNumber?: number;
  /** Saved before issue creation; an interrupted write must be reconciled before retrying. */
  minorIssueCreation?: { prNumber: number };
  /** The merge under way for `sha`, and the steps of it already done. */
  merging?: { sha: string; done: MergeStep[] } | null;
  /** Merging main into the branch conflicted: the markers are in the worktree, and the seat resolves them. */
  mainMerge?: { mainSha: string; files: string[] } | null;
  /**
   * The one re-run of a failed CI on `sha`: when it was asked for, and the Actions runs it re-ran.
   * `flaked`: the re-run passed, so the failure is recorded as a flake.
   */
  rerun?: {
    sha: string;
    at: number;
    runs: { id: number; name: string }[];
    flaked?: boolean;
  } | null;
  /**
   * The hub's conflict-free merges of main made `to` from `from` (each merge's first parent the
   * one before) and left the PR's own diff as it was at `from`: `to` goes by `from`'s review.
   */
  carry?: { from: string; to: string } | null;
  /**
   * FLIGHT's one re-run of the failed jobs on `ciFailedSha`, for a ruling it was asked to settle
   * (not `rerun`, the hub's own re-run of a first failure).
   */
  rulingRerun?: CiRerun | null;
  /**
   * The ticket's `## Controller check` hold: the sha the run parked on and the phase it left, set
   * when the engine parks the merge; `pass` once the operator's verdict on that sha is recorded.
   */
  /** The ticket listed a controller check once: a pass is needed even if the heading goes. */
  controllerCheckRequired?: boolean;
  /** A line due to the author once it is back on its seat (a controller check's fail note); cleared when claimed. */
  pendingLine?: { key: string; text: string } | null;
  controllerCheck?: { sha: string; from: LoopPhase; pass: boolean } | null;
  /**
   * A hold on the run's merge by FLIGHT or the controller (CAPCOM): the engine does not merge
   * while it stands. `from` is the phase the run left when it parked on the hold.
   */
  mergeHold?: { by: "FLIGHT" | "CAPCOM"; reason: string; at: number; from?: LoopPhase } | null;
}

/** One `loop_events` row. */
export interface LoopEvent {
  key: string;
  runId: string;
  text: string;
  at: number;
}

/** One try at a step of a looped run, oldest first. */
export interface LoopTry {
  trigger?: string;
  /** Failures charged by Mission Control, separate from the number of executions. */
  failures?: number;
  usage?: TokenUsage | null;
  models?: string[];
  durationMs?: number | null;
  /** Measured input + output tokens; null when usage was not recorded. */
  tokens?: number | null;
  step: Exclude<LoopPhase, "parked">;
  /** Rework after a review's blocking findings; shown as "fix" on the review step. */
  fix: boolean;
  /** 1-based among this step's tries of the same kind (fix or not). */
  n: number;
  startedAt: number;
  /** null while the try is open. */
  endedAt: number | null;
  outcome: "running" | "waiting" | "pass" | "fail" | "parked" | "stopped";
  /** Why it failed, parked or stopped; else null. */
  reason: string | null;
}

/** `GET /api/runs/:id/loop`. */
export interface RunLoopView {
  runId: string;
  /** The run's own timing, retained even after it leaves an agent's recent-runs list. */
  startedAt?: number;
  /** null while the run is still running. */
  endedAt?: number | null;
  /** The CI and rework caps selected when this run started. */
  limits?: { tries: number; rounds: number };
  /** Full diagnostics for the operator's single-run view only. */
  noReport?: NoReport | null;
  usage?: RunUsage;
  loop: RunLoop | null;
  events: LoopEvent[];
  tries: LoopTry[];
  /** 1 + the fix lines sent in the loop's epoch, at most REVIEW_ROUNDS. null without a loop. */
  round: number | null;
  /** null until the HUD and enforcement use the same token measure. */
  budget: number | null;
  /** reviewStatusOf for the pushed sha in the loop's epoch, else null. */
  review: ReviewStatus | null;
}

/** A run's PR joined to the stored PR row; title/state/ticket null when the row is unknown. */
export interface RunPr {
  repoId: RepoId;
  number: number;
  title: string | null;
  url: string;
  state: PullRequestView["state"] | null;
  ticket: string | null;
  /** Set while FLIGHT or the controller holds this PR's merge: who holds it, and why. */
  hold?: { by: "FLIGHT" | "CAPCOM"; reason: string };
}

/** A run in a list; full assistant text stays on the individual run record. */
export type RunSummary = Omit<Run, "noReport"> & {
  noReport?: Omit<NoReport, "lastAssistantText"> | null;
};

/** `GET /api/agents/:id/runs` row: the run with its PRs joined and its ticket resolved. */
export type RunView = Omit<RunSummary, "prs" | "ticket"> & {
  prs: RunPr[];
  usage?: RunUsage;
  /** The run's own ticket, else the first of its PRs' tickets (see runTicket). */
  ticket: string | null;
  /** The title stored with the run, else the board's title for its ticket; null when neither is known. */
  ticketTitle?: string | null;
};

export interface UsageSample {
  accountId: AccountId;
  window: "5h" | "7d";
  at: number;
  pct: number;
  resetAt: number;
  source: string;
}

export interface AutonomyQuestion {
  question: string;
  recommendation: string;
  reasoning_quote: string;
  effort_sunk: string;
  default_if_ignored: string;
  answers: string[];
}

export interface Escalation {
  id: string;
  repoId: RepoId;
  issueNumber: number;
  title: string;
  kind: "operator-decision" | "loop-blocked" | "mvp-ready" | "autonomy-question";
  /**
   * What made the issue an escalation: `title` = an `[operator-decision]` / `[loop-blocked]` /
   * `[mvp-ready]` title marker (the loop is waiting on the operator); `label` = only a needs-you
   * label (listed in Needs you, but never sets an agent's state).
   */
  source: "title" | "label";
  openedAt: number;
  url: string;
  question: AutonomyQuestion | null;
}

export interface BoardItem {
  author?: string | null;
  repoId: RepoId;
  issueNumber: number;
  title: string;
  status: string;
  state: TicketState;
  labels: string[];
  /**
   * Logins assigned to the issue; a hub claims a ticket by assigning its own. The poll and the
   * store always set it; absent means none (a card built by hand, as the web's fixtures do).
   */
  assignees?: string[];
  priority: string | null;
  updatedAt: number;
  url: string;
  stage: Stage | null;
  owner: Owner | null;
  /** Parent issue number in the same repo, else null. */
  parent: number | null;
  /** Null when the issue has no sub-issues. */
  subIssues: { done: number; total: number } | null;
  /** `ref` is `repo#number`; closed blockers are kept and flagged. */
  blockedBy: { ref: string; closed: boolean }[];
  /**
   * What the issue body says it waits on: issues on `Depends on` lines, PRs on `After PR` lines.
   * Absent means none (a card stored before the field, or built by hand).
   */
  after?: { issues: number[]; prs: number[] };
  milestone: string | null;
  /** The project's single-select `Size` field; null when the project has none or the item has no value. */
  size: string | null;
  /** The issue's own state on GitHub; the project's Status can disagree with it. */
  closed: boolean;
  /** Where `priority` came from: the project's Priority field, a `p0`-`p3` label, or nothing. */
  prioritySource: "field" | "label" | null;
  /** When the issue was opened on GitHub. */
  createdAt: number;
  /** The issue's item id in the project (for Status moves); null on a row stored before it. */
  itemId: string | null;
  /** The project's node id; null on a row stored before it. */
  projectId: string | null;
}

/** A check run or a commit status on a PR's head commit. */
export interface PrCheck {
  id?: string; // a check run's GraphQL node id, stable across polls; absent for a status
  workflow?: string; // Actions workflow name, shared with the engine’s flake notes
  name: string; // a check run's name, or a status's context
  kind: "check" | "status";
  state: "passing" | "failing" | "pending";
  conclusion: string; // a check run's conclusion (its status until done); a status's state
  attempt: number | null; // the Actions run attempt; null for a status or a non-Actions run
  url: string | null;
}

/** A check as a PR list shows it: the name and state, not the run's ids and links. */
export type PrCheckSummary = Pick<PrCheck, "name" | "kind" | "state" | "attempt">;

/** A PR as a list sends it by default: every field, with the checks cut to `PrCheckSummary`. */
export type PullRequestListRow = Omit<PullRequestView, "checks"> & { checks?: PrCheckSummary[] };

/**
 * A PR as `?shape=summary` sends it: what a list shows (number, title, state, head, checks rollup,
 * review state), nothing that grows with the PR. The full row is the PR's own route.
 */
export type PullRequestSummary = Pick<
  PullRequestView,
  | "repoId"
  | "number"
  | "title"
  | "url"
  | "branch"
  | "headSha"
  | "ticket"
  | "state"
  | "isDraft"
  | "review"
  | "ci"
  | "createdAt"
  | "updatedAt"
  | "mergedAt"
>;

export interface PullRequestView {
  repoId: RepoId;
  number: number;
  title: string;
  url: string;
  branch: string;
  /** The branch the PR merges into; another open PR's branch means it is stacked on that PR. Absent before it was read. */
  base?: string | null;
  /** `repo#number`, from the branch first, else the first closing reference; null when neither names one. */
  ticket: string | null;
  state: "open" | "closed" | "merged";
  /** Issues in this repo the PR closes; absent on rows stored before closing references. */
  closingIssues?: number[];
  isDraft: boolean;
  review: "approved" | "changes" | "requested" | null;
  ci: "passing" | "failing" | "pending" | null;
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
  /** Merge commit SHA; absent on PRs collected before merge commit metadata. */
  mergeCommitSha?: string | null;
  /** The head commit's sha; null when GitHub gave none or the row was stored before it. */
  headSha: string | null;
  /** UNKNOWN: GitHub has not computed it yet, so poll again. When it was read is the row's `read_at`. */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  /** The PR author's login; absent or null when GitHub gave none or the row was stored before it. */
  author?: string | null;
  /** Logins assigned to the PR; absent means none. */
  assignees?: string[];
  /** The head commit's checks by name; absent on a row stored before them. */
  checks?: PrCheck[];
  /** PR size as reported by GitHub; absent on rows collected before audit capture. */
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
}

/** One issue that reached Done: when work started (see collectors/flow.ts) and when it finished. */
export interface FlowIssue {
  repoId: RepoId;
  number: number;
  size: string | null;
  /** First move into Ready / In progress / In review / Ready for QA; null when it never had one. */
  startAt: number | null;
  doneAt: number | null;
}

/** One merged PR and the CI state of its earliest commit that has a check rollup. */
export interface FlowPr {
  repoId: RepoId;
  number: number;
  mergedAt: number;
  firstPushCi: "passing" | "failing" | "pending" | null;
}

/** A repo milestone: its due date and how many of its issues are open and closed. */
export interface RepoGoal {
  repoId: RepoId;
  number: number;
  title: string;
  state: "open" | "closed";
  dueOn: number | null;
  open: number;
  closed: number;
}

/**
 * A studio loop's driver stopped itself (quota, MAX_FIRES, no progress), not the operator's signal.
 * `reason` is the driver's STOP text, whole. `quota` is set for a 7-day quota stop; `resumesAt` is
 * the quota window's reset time when the driver logged one.
 */
export interface DriverStop {
  reason: string;
  at: number;
  quota: { usedPct: number | null; stopPct: number | null } | null;
  resumesAt: number | null;
}

export interface AgentView {
  id: AgentId;
  repoId: RepoId;
  /** Observed loop, or a crew seat Mission Control runs itself. */
  kind: "loop" | "crew";
  loopKind: "ta-loop" | "studio-loop" | "crew";
  /** Crew only; null for a loop. */
  role: CrewRole | null;
  mode: CrewMode | null;
  /** Crew writers' globs; [] for a loop. */
  area: string[];
  /** Crew: the seat's model from config; null for a loop. */
  model: string | null;
  /** Crew: the config session id; null for a loop. */
  sessionId: string | null;
  accountId: AccountId;
  state: AgentState;
  stateSince: number;
  currentRun: RunSummary | null;
  paused: boolean;
  sourceError: string | null;
  /** The loop's own latest STOP note (studio loop), e.g. `stopped: quota ...`; display only. */
  note: string | null;
  /** The driver's own stop, until its next fire; null for a TA loop or when not stopped. */
  stop: DriverStop | null;
  /** Latest run: the later of its newest transcript event and the transcript file's mtime. */
  lastOutputAt: number | null;
}

/** A subagent (`local_agent` task) started by a run. */
export interface SubagentInfo {
  taskId: string;
  type: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
}

/** One item in the agent's own task list, replayed from its stream. */
export interface LiveTask {
  id: string;
  text: string;
  status: "done" | "in_progress" | "pending";
}

/**
 * Per-run facts folded from the transcript, stored apart from the run row. Usage-derived numbers
 * count each message id once. Top-level frames only: toolCalls, turns, contextTokens, liveTool,
 * turnUsage.
 */
export interface RunDigest {
  tasks?: LiveTask[];
  /** Timestamped message usage, retained for attempt attribution (not run totals). */
  attemptUsage?: {
    id: string;
    at: number | null;
    tokens: number;
    usage?: TokenUsage;
    model?: string | null;
  }[];
  /** Committed lines; missing or null means unmeasured, including binary counts. */
  additions?: number | null;
  deletions?: number | null;
  /** Tool starts in the last hour; absent on older stored digests. */
  toolStarts?: number[];
  toolCalls: number;
  turns: number;
  /** Newest timestamp on any frame, subagents included. */
  lastEventAt: number | null;
  model: string | null;
  contextTokens: number | null;
  /** From the latest `result` line; null while a run has none yet. */
  contextWindow: number | null;
  /**
   * The tool in flight. `detail` is what it touches (Bash: the command's first line; Read, Edit,
   * Write: the path, relative to the run's cwd; Grep, Glob: the pattern; an mc tool: its name
   * without the prefix), else null; absent on a digest stored before it existed.
   */
  liveTool: { name: string; since: number; detail?: string | null } | null;
  /**
   * The first sentence of the newest top-level assistant text block (thinking never counts), else
   * null; absent on a digest stored before it existed.
   */
  lastText?: string | null;
  /** Every frame's tool calls by name; `durationsMs` keeps the last 50. */
  tools: Record<
    string,
    {
      calls: number;
      failed: number;
      durationsMs: number[];
      /** Maximum timed call, retained independently of the bounded duration samples. */
      slowest?: { detail: string | null; durationMs: number } | null;
    }
  >;
  subagents: SubagentInfo[];
  /** `[minute start (epoch ms), input + output tokens]` for the two hours up to lastEventAt. */
  minuteTokens: [number, number][];
  /** One per top-level message, the last 60. */
  turnUsage: { input: number; output: number; cacheRead: number }[];
  /**
   * Tasks in flight, any `task_type` (`local_bash`, `local_agent`, …), oldest first: opened by
   * `task_started`, closed by `task_notification` or a `task_updated` with a final status. A
   * digest persisted before this field existed reads as none (the store fills it in).
   */
  background: { taskId: string; description: string; type: string }[];
  /** Top-level `compact_boundary` lines seen; a digest persisted before this field reads 0. */
  compactions: number;
  /**
   * The run's input + output + cacheRead + cacheCreate tokens at its latest `result` line that had
   * a numeric `total_cost_usd`; null before one. Absent on a digest stored before it existed.
   */
  costTokens?: number | null;
  /**
   * Reply speed over the top-level messages whose ask and last frame are both known: output tokens
   * per second, and the mean ask-to-last-frame time; null when there are none. Absent on a digest
   * stored before it existed. `firstTokenMs` is mean request-to-first-content latency,
   * measured only when both timestamps exist.
   */
  speed?: { tokensPerSec: number | null; turnMs: number | null; firstTokenMs?: number | null };
  /**
   * Whole-file re-reads of a large unchanged file the guard refused this run, and the tokens that
   * saved (the file's size at about 4 bytes a token). Absent when there are none.
   */
  rereads?: { count: number; tokensSaved: number };
}

export type StreamKind = "op" | "msg" | "think" | "tool" | "sys";

export interface StreamEvent {
  /**
   * Stable across reads of a growing transcript: `{byte offset of its line}:{block index}` (a tool
   * event takes its call's). Clients key rows on it.
   */
  id: string;
  at: number | null;
  kind: StreamKind;
  text: string;
  tool?: {
    name: string;
    input: string;
    result: string | null;
    ms: number | null;
    error: boolean;
    status?: string;
    exitCode?: number | null;
  };
}

/** A bounded Comms thread snapshot. IDs survive folds and reloads; undated messages stay null. */
export interface CommsThreadMessage {
  id: string;
  at: number | null;
  from: string;
  to: string;
  ticket: string | null;
  text: string;
  tagged: boolean;
  direct: boolean;
  seen: boolean;
}

/** `GET /api/agents/:id/stream`: the latest run's events, oldest first. */
export interface AgentStream {
  tasks?: LiveTask[];
  runId: string | null;
  events: StreamEvent[];
  /** The scan stopped at its byte cap before reaching `limit` events. */
  truncated: boolean;
  /** Older events remain: ask again with `?before=` the first event's id. Absent when no read happened. */
  hasMore?: boolean;
  lastOutputAt: number | null;
  /** Why there are no events (`no runs yet`, `transcript not found`), else null. */
  reason: string | null;
}

/**
 * `GET /api/agents/:id/files`: what the loop's worktree changed, from read-only git. `committed`
 * = on the branch since it left `origin/HEAD`; `uncommitted` = against HEAD; `untracked` = new
 * files git does not ignore. A path is listed once, in its latest state. `add`/`del` are null for
 * a binary file and for an untracked one.
 */
export interface ChangedFiles {
  files: {
    path: string;
    add: number | null;
    del: number | null;
    state: "committed" | "uncommitted" | "untracked";
    /** Latest branch commit affecting this file; null for uncommitted/untracked files. */
    commitSha?: string | null;
  }[];
  /** Why the list is partial (no `origin/HEAD`, a part git could not read, the cap), else null. */
  note: string | null;
  /** The commit (HEAD) the whole list was read at; null when git could not name it, and for a seat. */
  sha: string | null;
}

/**
 * `GET /api/agents/:id/files/diff?path=`: one listed file's diff, from read-only git (`committed`:
 * from the merge base with `origin/HEAD` to HEAD; `uncommitted`: against HEAD) or, for an untracked
 * file, its contents as added lines. Cleaned and cut at DIFF_MAX_CHARS (`truncated`); a binary
 * file has empty `text`.
 */
export interface FileDiff {
  path: string;
  text: string;
  truncated: boolean;
  binary: boolean;
  /** The commit the diff was taken against: the one the file list named. */
  sha: string | null;
}

interface LimitRowBase {
  accountId: AccountId;
  used: number;
  resetAt: number;
  alertAt: number;
  stopAt: number;
  stale: boolean;
  source: string;
  /** When the latest sample (the one `used` comes from) was taken, UTC ms. */
  sampledAt: number;
  /** The Claude usage collector's next rate-limit retry, UTC ms. Omitted when not backing off. */
  nextTryAt?: number;
}

/**
 * One `/api/limits` row. Projection applies to 7d windows only; a 5h row shows `used` + `resetAt`
 * and a `fullAt`. `fullAt`: when the window reaches 100% at its current pace (null when it will
 * not before the reset); the 7d pace is `pace24h`, the 5h pace `pace5h`. A 5h row's `paceReady` is
 * false when the server had too few samples to compute that pace (so a null `fullAt` means "too
 * little history", not "not filling"). Optional because older hubs omit it; the web treats a
 * missing value as ready.
 */
export type LimitRow =
  | (LimitRowBase & {
      window: "7d";
      projected: number | null;
      stopForecast: number | null;
      fullAt: number | null;
    })
  | (LimitRowBase & {
      window: "5h";
      projected: null;
      stopForecast: null;
      fullAt: number | null;
      paceReady?: boolean;
    });

/** What changed, for SSE subscribers (`event: changed`): the web client refetches that topic. */
export type Topic =
  | "agents"
  | "limits"
  | "boards"
  | "escalations"
  | "health"
  | "machine"
  | "attention"
  | "settings"
  | "config"
  | "guard"
  | "flight";

/**
 * One machine reading. null = not measured yet (the first sample has no CPU delta) or failed with
 * no earlier value; the UI shows `—`.
 */
export interface MachineSample {
  at: number;
  cpuPct: number | null;
  cores: number;
  memUsedBytes: number | null;
  memTotalBytes: number;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  /** macOS `sysctl vm.swapusage`; null when not measured. */
  swapUsedBytes?: number | null;
  swapTotalBytes?: number | null;
  /** macOS `memory_pressure` system-wide free percentage; null when not measured. */
  memoryPressureFreePct?: number | null;
  /** One-minute load average; null when not measured. */
  load1?: number | null;
  /** Bounded highest-RSS process rows, sampled for a machine-capacity alert. */
  topConsumers?: { pid: number; command: string; rssBytes: number; cpuPct: number }[];
  /** The `claude` and `codex` processes on this machine (editor sessions included). */
  agents: { count: number; rssBytes: number; cpuPct: number } | null;
  /** The test-lock holder's command and every process under it; null when the lock is free. Optional: older stored samples lack it. */
  testRun?: { count: number; rssBytes: number; cpuPct: number } | null;
}

/** `/api/machine`: the latest sample, with the crew's seat capacity for the Machine panel's agents row. */
export interface MachineView {
  latest: MachineSample | null;
  /** Null when starts are permitted; otherwise the machine-capacity admission reason. */
  warning: string | null;
  /** `crew.max_seats`. */
  maxSeats: number;
  /** Configured crew seats, over all sessions. */
  seats: number;
  /** The most seats in any one session. */
  perSessionMax: number;
  transcripts: TranscriptFootprint | null;
}

export interface TranscriptFootprint {
  totalBytes: number;
  seats: { seatId: string; bytes: number; files: number }[];
  oldestAt: number | null;
}

/** One `/api/repos` row: a configured repo, without its status map. */
export interface RepoView {
  id: RepoId;
  /** `owner/name` */
  github: string;
  /** GitHub Projects (v2) number. */
  project: number;
  /** The Project's address as GitHub reports it (`ProjectV2.url`); null or absent until the hub has read the board. */
  projectUrl?: string | null;
}

/** `POST /api/repos`: a repo to append to config.yaml (written as its snake_case fields). */
export interface NewRepo {
  id: RepoId;
  /** `owner/name` */
  github: string;
  /** GitHub Projects (v2) number. */
  project: number;
  /** Project Status option name → board column. */
  statusMap: Record<string, TicketState>;
  /** Labels that mark an open issue as needing the operator; absent: the collector's default. */
  needsYouLabels?: string[];
}

/** One `/api/health` row: a collector's latest status. */
export interface HealthRow {
  collector: string;
  ok: boolean;
  /** The failure (ok=false), or a note (ok=true), or null. */
  error: string | null;
  /** When this status was recorded, UTC ms. */
  at: number;
  /** When the collector last succeeded, UTC ms; null if it never has. Kept through failures. */
  lastOkAt: number | null;
  /** When its current run of failures began, UTC ms; null while it succeeds. */
  failingSince?: number | null;
  /** The `engine:ticks` row only: the last engine ticks, oldest first. */
  ticks?: EngineTick[];
}

/**
 * Where a crew row's latest run is in its loop, as the HUD shows it. The server
 * writes `text` (`working` → `Working on {ref}`; `ci` → `CI on {sha7}`; `review` →
 * `In review · PR #{n}`; `parked` → `Blocked: {reason}`); the web shows it as given.
 */
export interface CrewLoop {
  phase: LoopPhase;
  text: string;
  prNumber: number | null;
  /** The park reason while `phase` is `parked`, else null. */
  parked: string | null;
  /** The name of the run's template profile; absent on a run without one. */
  profile?: string;
  /** The profile's step for the phase; null when parked, done or no step has the phase. */
  step?: string | null;
  /** The run's profile steps in order, as Setup › Loops lists them; absent on a run without one. */
  steps?: { name: string; phase: ProfileStepPhase | null }[];
  /** A planner's plan landed for the run's ticket (a `{runId}:plan` loop event); absent without a profile. */
  planned?: boolean;
  /** The current step's try and its limit (ci: CI tries; review: review rounds), else null. */
  tries?: { n: number; max: number; failures?: number; runs?: number } | null;
  /** What the run waits on (runWait in apps/server/src/hud.ts), else null. */
  wait?: LoopWait | null;
  /** When `wait` is "seat" and the seat is on another ticket: "rework waiting on GUIDO-1 (behind #12)". */
  waitText?: string | null;
}

/** What a looped run waits on; null: nothing (its seat is on it, or it is done). */
export type LoopWait = "ci" | "retro" | "main" | "operator" | "lock" | "seat";

/** One ticket in a writer seat's queue. */
export interface CrewQueueItem {
  /** `repo#number`. */
  ref: string;
  issue: number;
  /** 1 is the next the seat takes. */
  pos: number;
}

/** A run its seat has set aside (in review, off the seat). */
export interface CrewAsideRun {
  runId: string;
  /** Resolved as the row's `ticket` is (`repo#n`), else null. */
  ticket: string | null;
  ticketTitle: string | null;
  loop: CrewLoop;
  events?: CrewEvent[];
  stateSince?: number;
}

/** Recorded progress, oldest first; no synthetic ticks for idle time. */
export interface CrewEvent {
  kind: "commit" | "push" | "test" | "pr-opened" | "review" | "park" | "message";
  at: number;
}

/** One `/api/crew` row: a configured loop as the HUD shows it. */
export interface CrewRow {
  crewPause?: CrewPause | null;
  /** Current run events from the last two hours; absent on older servers. */
  events?: CrewEvent[];
  focus?: string | null;
  displayCallSign?: string | null;
  id: AgentId;
  repoId: RepoId;
  /** Position in config order (the agent's colour). */
  index: number;
  hudState: HudState;
  stateSince: number;
  accountId: AccountId;
  /** Observed loop, or a crew seat Mission Control runs itself. */
  kind: "loop" | "crew";
  loopKind: "ta-loop" | "studio-loop" | "crew";
  /** Crew only; null for a loop. */
  role: CrewRole | null;
  mode: CrewMode | null;
  /** Crew writers' globs; [] for a loop. */
  area: string[];
  /** Crew: the seat's model from config; null for a loop. */
  model: string | null;
  /** Crew: the config session id; null for a loop. */
  sessionId: string | null;
  /** Crew: the `claude --version` read at the server and the seat's configured effort; null for a loop. */
  cli: { version: string | null; effort: string | null };
  /** The open PR on the latest run's branch (in the seat's repo), else null. */
  review: {
    prNumber: number;
    state: "draft" | "open" | "changes" | "approved";
    /** The review seat reviewing this PR now (queued, starting or running), else null. */
    reviewing?: AgentId | null;
  } | null;
  /** A scratch seat's live review, else null. */
  reviewing?: { prNumber: number; sha: string; ref: string | null } | null;
  paused: boolean;
  note: string | null;
  stop: DriverStop | null;
  sourceError: string | null;
  /** The latest run's resolved ticket (`repo#number`, see RunView), else null. */
  ticket: string | null;
  /** The board row title of `ticket`, else null. */
  ticketTitle: string | null;
  /** The latest run's loop; null when no loop drives it (always null until the engine lands). */
  loop: CrewLoop | null;
  /** Crew: the seat's set-aside runs other than `run`, oldest first; [] for a loop row. */
  asideRuns?: CrewAsideRun[];
  /** A writer seat's queued tickets, without the one it holds; [] for other rows. */
  queue?: CrewQueueItem[];
  /**
   * Crew seat parked: CAPCOM messages since its latest seat update; 0 otherwise. A patch while
   * parked (e.g. a new reason) resets this window, so earlier queued messages are not counted.
   */
  queuedMessages?: number;
  /** The latest run. */
  run: {
    id: string;
    seq: number;
    startedAt: number;
    endedAt: number | null;
    status: RunStatus;
    model: string | null;
    branch: string | null;
    tokens: TokenUsage | null;
    costUsd: number | null;
    /**
     * Crew rows, while the run is running: `costUsd` carried over the tokens since its last
     * `result` line, else priced at an earlier run's rate; null when no rate is known.
     */
    costEstimateUsd?: number | null;
  } | null;
  /** The latest run's commits and guard refusals (crew rows); null for a loop or without a run. */
  work?: { commits: number; denials: number } | null;
  /** The latest run's PRs; empty without a run. */
  prs: RunPr[];
  /** The latest run's summary, else null. */
  summary: string | null;
  /** The latest run's digest. */
  digest: RunDigest | null;
  /** The latest digest's context window, else the newest earlier run's digest that has one. */
  contextWindow: number | null;
  lastOutputAt: number | null;
}

/** `GET /api/crew`. */
export interface Crew {
  rows: CrewRow[];
  /** Earliest run start since local midnight (operator timezone) across loops, for the MET clock. */
  firstRunToday: number | null;
}

/** The digest fields the Overview reads: activity, the tool in flight, context. */
export type CrewSummaryDigest = Pick<
  RunDigest,
  | "lastEventAt"
  | "minuteTokens"
  | "liveTool"
  | "lastText"
  | "background"
  | "contextTokens"
  | "contextWindow"
  | "compactions"
>;

/** A crew row as the Overview reads it: state, ticket, loop step, tokens and cost, without the event timelines or the whole digest. */
export type CrewSummaryRow = Omit<CrewRow, "events" | "digest" | "asideRuns"> & {
  digest: CrewSummaryDigest | null;
  asideRuns?: Omit<CrewAsideRun, "events">[];
};

/** `GET /api/crew?shape=summary`. */
export interface CrewSummary {
  rows: CrewSummaryRow[];
  firstRunToday: number | null;
}

/** Catch-up text is evidence to display, never instructions to execute. */
export interface BriefCatchUp {
  kind: CatchUpKind;
  line: string;
  story: string[];
  aware: string[];
}

export interface BriefCheck {
  source: string;
  finding: string;
}

export interface BriefReference {
  label: string;
  /** Read-only navigation, never a posting target. */
  url?: string;
}

export interface PersonSource {
  kind: "github" | "teams";
  messageId: string;
  /** Opaque identity of the exact source content that was assessed. */
  revision: string;
}

export interface PersonMessage {
  disposition?: "needs-you" | "digest";
  triagedVersion?: string;
  source: PersonSource;
  teams?: {
    kind: "chat" | "channel";
    id: string;
    teamId?: string;
    name: string;
    messageId: string;
    threadId?: string;
  };
  author: string | null;
  at: number;
  text: string;
  url: string;
}

export interface SuggestedReply {
  id: string;
  label: string;
  text: string;
  /** Assigned by the server; generation never approves this draft. */
  draftId?: number;
}

export interface PersonBrief {
  source: PersonSource;
  history?: PersonMessage[];
  assessment?: string[];
  take?: string;
  related?: BriefReference[];
  decisionKey?: string;
  replies?: SuggestedReply[];
}

/** Correlates item chat without changing how messages are delivered or executed. */
export interface ItemDiscussion {
  id: string;
  itemKey: string;
  version: string;
  messages: ItemChatMessage[];
}

export interface ItemChatMessage {
  id: string;
  itemKey: string;
  correlationId: string;
  replyTo?: string;
  role: "operator" | "flight";
  text: string;
  at: number;
}

/** One answer FLIGHT suggests for an item that is a choice. */
export interface BriefOption {
  id?: string;
  description?: string;
  label: string;
  answer: string;
}

/** FLIGHT's brief on a Needs-you item: what it is, what FLIGHT recommends, and the options. */
export interface AttentionBrief {
  /** Missing on briefs written before triage routing was introduced. */
  for?: "operator" | "flight";
  original?: string;
  assessment?: string;
  did?: { action: string; refs: string[] }[];
  ask?: string;
  /** When this ask was first briefed, on a rebrief with the same ask; absent: it began at `at`. */
  askAt?: number;
  /** Stored at briefing time; its absence means this brief predates decision defaults. */
  defaultAt?: number;
  catchUp?: BriefCatchUp;
  checked?: BriefCheck[];
  recommendedOptionId?: string;
  person?: PersonBrief;
  context: string;
  recommendation: string;
  options: BriefOption[];
  basis: string;
  at: number;
}

export interface AttentionItem {
  hold?: AttentionHold;
  holdReleased?: string;
  /** When that hold was released; FLIGHT's brief older than this is stale. */
  holdReleasedAt?: number;
  key: string;
  kind: AttentionKind;
  agentId: AgentId | null;
  repoId: RepoId | null;
  text: string;
  /** The live tool of a stall, so the client renders `{m:ss} in {tool}` without parsing text. */
  tool: string | null;
  /** A stray's file and crew session; null for other kinds. */
  path?: string | null;
  sessionId?: string | null;
  /** Sort time; 0 for an undated Comms item (see messageAt). */
  at: number;
  /** Original Comms timestamp, including null when the transcript supplied none. */
  messageAt?: number | null;
  url: string | null;
  escalationId: string | null;
  /** The ticket (`repo#n`) this is about: an escalation's own id, a PR's ticket; null otherwise. */
  ticket: string | null;
  /**
   * Who has to act. The server always sets it; Needs you counts only `operator`. Optional here
   * until every client that builds an item sets it.
   */
  owner?: AttentionOwner;
  /** FLIGHT's brief, once it has written one. */
  brief?: AttentionBrief;
  flightTriage?: "waiting" | "handling" | "missed" | "down";
  triageDueAt?: number;
  /** When a recommended option applies; absent means no automatic default. */
  defaultDueAt?: number;
  /**
   * Only on the one FLIGHT_NOT_TRIAGING_KEY item: why FLIGHT is not triaging, the keys of the items
   * waiting on it (FLIGHT's, listed under this one, oldest first) and when the oldest was raised.
   */
  notTriaging?: { cause: FlightNotTriagingCause; keys: string[]; since: number | null };
  acked: boolean;
}

export interface AwaySettings {
  on: boolean;
  until: string;
  may: { pickUp: boolean; research: boolean; check: boolean; status: boolean; safePr: boolean };
}

/** GitHub requests per hour polling a repo's board costs, as upper bounds. */
export interface GithubBudget {
  boardPerHour: number;
  sweepPerHour: number;
  flowPerHour: number;
  totalPerHour: number;
}

/** `GET /api/repos/profiles`: how a configured repo's board differs, from config and stored rows only. */
export interface RepoProfile {
  id: RepoId;
  github: string;
  project: number;
  /** The Project's address as GitHub reports it (`ProjectV2.url`); null or absent until the hub has read the board. */
  projectUrl?: string | null;
  statuses: { status: string; state: TicketState; column: HudColumn; items: number }[];
  missingColumns: HudColumn[];
  /** Stored board items by where their priority came from. */
  priority: { field: number; label: number; none: number };
  budget: GithubBudget;
  loops: AgentId[];
}

/** `POST /api/repos/preview`: what adding a repo would mean, read live from GitHub. */
export interface RepoPreview {
  github: string;
  project: number;
  /** GitHub's default branch, checked against the checkout before it is configured. */
  defaultBranch: string;
  projectTitle: string;
  items: number;
  fields: { name: string; options: string[] }[];
  statusOptions: string[];
  proposedStatusMap: Record<string, TicketState>;
  columns: { status: string; column: HudColumn }[];
  missingColumns: HudColumn[];
  priority: "field" | "labels" | "none";
  budget: GithubBudget;
  /** Total requests per hour of the configured repos. */
  budgetNow: number;
  /** Always empty for a new repo: loops are added in config. */
  loops: AgentId[];
}

/** One seat's live session; `runId` is null when no run is active. `reason` shows in the doing line. */
export interface SeatSessionRow {
  /** Absent on legacy callers; stored as Claude by default. */
  vendor?: CrewVendor;
  seatId: string;
  runId: string | null;
  cliSessionId: string | null;
  state: SeatState;
  reason: string | null;
  worktree: string | null;
  updatedAt: number;
  /** Start of the current error, preserved across seat updates until recovery. */
  errorSince?: number;
  /** When the seat's last turn ended; `setSeatSession` never writes it. Absent on a row not read. */
  lastTurnEndedAt?: number | null;
  /** When the seat's current (or most recent) turn started. */
  lastTurnStartedAt?: number | null;
}

/** A crew session's context window, from its `get_context_usage` control request. */
export interface ContextUsage {
  categories: { name: string; tokens: number }[];
  /** Tokens in use, as the CLI counts them. */
  total: number;
  /** The model's context window in tokens; null when the CLI does not say. */
  window: number | null;
}

/** `GET /api/version`: the hub's checkout against origin/main, and whether Update may run. */
export interface VersionInfo {
  /** The SHA the hub started on: the code running ("" when it cannot be read). */
  sha: string;
  /** Commits on origin/main that `sha` lacks; null when origin/main cannot be read. */
  behind: number | null;
  /** When `git fetch origin main` last succeeded; null before the first. */
  checkedAt: number | null;
  canUpdate: boolean;
  /** Why Update is refused; null when it may run. */
  reason: string | null;
}

/** `GET /api/update/log`: the last update's commands and output; null before any update. */
export interface UpdateLog {
  text: string | null;
}

/** Provider CLI status in the same binding used by usage collection. */
export interface CliAccountStatus {
  accountId: AccountId;
  provider: "claude" | "codex";
  binding: "machine" | "profile";
  identity: string | null;
  plan: string | null;
  status: "logged-in" | "not-logged-in" | "unknown";
  checkedAt: number;
  /** Fixed safe failure text, never CLI output. */
  detail: string | null;
}

/**
 * What notifies the operator. `asks` (an item FLIGHT has briefed for the operator), `flightDown`
 * (FLIGHT could not be kept running, is parked or at an account's stop line, or is silent mid-turn)
 * and `awayDigest` (only in away mode, which the operator switches on) are on by default; the rest
 * are opt-in, so the operator is not taught to babysit (roadmap item 7).
 */
export type NotificationCategory =
  | "asks"
  | "flightDown"
  | "people"
  | "decisions"
  | "stalls"
  | "prs"
  | "capcom"
  | "awayDigest"
  | "quota";

/** Notify me about, on every signed-in device (catalogue §2.7.6). */
export interface NotificationPreferences {
  enabled?: boolean;
  categories: Record<NotificationCategory, boolean>;
  quietHours: {
    start: string;
    end: string;
    timezone: string;
    stallsBypass: boolean;
  };
  softChime: boolean;
}

export interface NotificationEvent {
  test?: boolean;
  softChime?: boolean;
  id: string;
  category: NotificationCategory;
  at: number;
  text: string;
}

/** `GET /api/overview/timeline`: the last hour, in crew order. */
export interface OverviewTimeline {
  from: number;
  to: number;
  lanes: {
    agentId: string;
    spans: { kind: "turn" | "checks" | "lock" | "review"; from: number; to: number | null }[];
    ticks: number[];
  }[];
}

/** Live Overview figures; minute series end at the last complete minute, oldest first. */
export interface OverviewSummary {
  at: number;
  kpis: {
    tokensPerMin: { now: number; series: number[] };
    /** Minute spend buckets, using the same attribution as perHour. */
    spendToday: { usd: number; perHour: number[]; series?: number[] };
    /**
     * Distinct tickets in building, checks, review or merging at each minute end; `count` is the
     * registry's In progress (`MetricsView.inProgress`). Merged and cycle time are registry figures
     * served by `GET /api/metrics`.
     */
    inFlight: { count: number; oldestAt: number | null; series?: number[] };
    /** Rolling 24-hour pass percentage at each minute end; null without outcomes. */
    ciPassRate24h: { pct: number | null; runs: number; redNow: number; series?: (number | null)[] };
    /**
     * The operator's whole inbox (one per key, never narrowed by the session filter), and its
     * episodes open at each minute end, including retained resolved episodes.
     */
    needsYou: { count: number; overHour: number; series?: number[] };
  };
  pipeline: PipelineStage[];
  /** Missing minute samples are null, rather than zero utilization. */
  machine: {
    cpu: (number | null)[];
    mem: (number | null)[];
    diskFreeGb: number | null;
    /** Mean free disk space in GB per minute, in the same units as diskFreeGb. */
    disk?: (number | null)[];
  };
}

export interface PipelineStage {
  stage: "ready" | "building" | "checks" | "review" | "merging" | "merged";
  count: number;
  oldestAt: number | null;
  cards: PipelineCard[];
}

export interface PipelineCard {
  repoId: string;
  ticket: number;
  title: string;
  pr: number | null;
  ci: ("pass" | "fail" | "pending")[];
  since: number;
  who: string | null;
}

export type AttentionHoldCondition =
  | { readonly kind: "date"; readonly at: number }
  | { readonly kind: "ticket"; readonly ticket: string }
  | { readonly kind: "crew" }
  | { readonly kind: "manual" };

/** Conditions only FLIGHT files (with `brief_item`'s hold): a PR's CI reaching a state, or another item resolving. */
export type AttentionWaitCondition =
  | { readonly kind: "ci"; readonly pr: string; readonly state: "passing" | "failing" }
  | { readonly kind: "item"; readonly key: string };

export interface AttentionHold {
  reason: string;
  condition: AttentionHoldCondition | AttentionWaitCondition;
  by: string;
  at: number;
  releasedAt?: number;
}

/** One finished engine tick, as `/api/health` serves it. */
export interface EngineTick {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** The steps it was still on when it passed its interval; null for a tick that stayed within it. */
  overranOn: string[] | null;
}
