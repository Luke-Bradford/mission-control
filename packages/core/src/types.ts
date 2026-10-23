import type { Owner, Stage } from "./board.ts";
import type { CatchUpKind } from "./flight.ts";
import type { AttentionKind, AttentionOwner, HudColumn, HudState } from "./hud.ts";
import type { ProfileStepPhase, RunProfile } from "./profiles.ts";
import type { ReviewStatus } from "./review.ts";
import type { CrewMode, CrewRole, SeatState } from "./runtime.ts";

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

export interface Run {
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
  /** The `claude` CLI version the run started on; absent on a run that did not record it. */
  cliVersion?: string | null;
  /** Who ended the run; null while it runs, and on rows from before it was recorded. */
  endedBy?: "operator" | "engine" | "exit" | null;
}

export type LoopPhase = "working" | "ci" | "review" | "parked" | "done";

/** The steps after a PR is ready, in the order the engine does them; `done` holds those finished. */
export type MergeStep = "ready" | "merge" | "close" | "delete-remote" | "delete-local";

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
  touches: { sha: string; paths: string[] } | null;
  /** `<phase>:<epoch>` whose card move is done. */
  cardFor: string | null;
  /** CAPCOM waived the review findings on this sha (un-park of a review park). */
  reviewWaivedSha?: string | null;
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
    sha: string;
    mainSha: string;
    containsMain: boolean;
    hubOnly: boolean;
    strays: string[];
  } | null;
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
  loop: RunLoop | null;
  events: LoopEvent[];
  tries: LoopTry[];
  /** 1 + the fix lines sent in the loop's epoch, at most REVIEW_ROUNDS. null without a loop. */
  round: number | null;
  /** crew.runTokenBudget + loop.budgetExtra. null without a loop or a crew section. */
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
}

/** `GET /api/agents/:id/runs` row: the run with its PRs joined and its ticket resolved. */
export type RunView = Omit<Run, "prs" | "ticket"> & {
  prs: RunPr[];
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
  name: string; // a check run's name, or a status's context
  kind: "check" | "status";
  state: "passing" | "failing" | "pending";
  conclusion: string; // a check run's conclusion (its status until done); a status's state
  attempt: number | null; // the Actions run attempt; null for a status or a non-Actions run
  url: string | null;
}

export interface PullRequestView {
  repoId: RepoId;
  number: number;
  title: string;
  url: string;
  branch: string;
  /** `repo#number`, from the branch first, else the first closing reference; null when neither names one. */
  ticket: string | null;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  review: "approved" | "changes" | "requested" | null;
  ci: "passing" | "failing" | "pending" | null;
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
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

export interface RepoGoal {
  repoId: RepoId;
  title: string;
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
  currentRun: Run | null;
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
  attemptUsage?: { id: string; at: number | null; tokens: number }[];
  /** Committed lines; missing or null means unmeasured, including binary counts. */
  additions?: number | null;
  deletions?: number | null;
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
  /** `[minute start (epoch ms), input + output tokens]` for the hour up to lastEventAt. */
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
  tool?: { name: string; input: string; result: string | null; ms: number | null; error: boolean };
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
}

/**
 * One `/api/limits` row. Projection applies to 7d windows only; a 5h row shows `used` + `resetAt`
 * and a `fullAt`. `fullAt`: when the window reaches 100% at its current pace (null when it will
 * not before the reset); the 7d pace is `pace24h`, the 5h pace `pace5h`. A 5h row's `paceReady` is
 * false when the server had too few samples to compute that pace (so a null `fullAt` means "too
 * little history", not "not filling"). Optional only until the web reads it.
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
  /** The `claude` and `codex` processes on this machine (editor sessions included). */
  agents: { count: number; rssBytes: number; cpuPct: number } | null;
  /** The test-lock holder's command and every process under it; null when the lock is free. Optional: older stored samples lack it. */
  testRun?: { count: number; rssBytes: number; cpuPct: number } | null;
}

/** `/api/machine`: the latest sample, with the crew's seat capacity for the Machine panel's agents row. */
export interface MachineView {
  latest: MachineSample | null;
  /** `crew.max_seats`. */
  maxSeats: number;
  /** Configured crew seats, over all sessions. */
  seats: number;
  /** The most seats in any one session. */
  perSessionMax: number;
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
  tries?: { n: number; max: number } | null;
  /** What the run waits on (runWait in apps/server/src/hud.ts), else null. */
  wait?: LoopWait | null;
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
}

/** One `/api/crew` row: a configured loop as the HUD shows it. */
export interface CrewRow {
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
  seatId: string;
  runId: string | null;
  cliSessionId: string | null;
  state: SeatState;
  reason: string | null;
  worktree: string | null;
  updatedAt: number;
  /** When the seat's last turn ended; `setSeatSession` never writes it. Absent on a row not read. */
  lastTurnEndedAt?: number | null;
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

/** Provider CLI status in the same machine binding used by usage collection. */
export interface CliAccountStatus {
  accountId: AccountId;
  provider: "claude" | "codex";
  binding: "machine";
  identity: string | null;
  plan: string | null;
  status: "logged-in" | "not-logged-in" | "unknown";
  checkedAt: number;
  /** Fixed safe failure text, never CLI output. */
  detail: string | null;
}

export type NotificationCategory =
  | "people"
  | "decisions"
  | "stalls"
  | "prs"
  | "capcom"
  | "awayDigest"
  | "quota"
  | "agentMessages";

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
