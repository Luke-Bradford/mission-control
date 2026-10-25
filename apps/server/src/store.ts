import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ItemChatMessage, ItemDiscussion, PersonMessage, PersonSource } from "@mc/core";
import {
  type AccountId,
  type AgentId,
  type AttentionBrief,
  type AttentionKind,
  BLOCKING_SEVERITIES,
  type BoardItem,
  type BriefOption,
  type ChosenProfile,
  COMMS_CAPCOM,
  COMMS_TEXT_MAX,
  commsCutMarker,
  type Escalation,
  type FLIGHT_HEADLINE,
  FLIGHT_INCOMING_LIMIT,
  FLIGHT_LEDGER_OPEN,
  FLIGHT_MEMORY_FULL,
  FLIGHT_MEMORY_TOPICS_MAX,
  FLIGHT_PLAN_LIMIT,
  FLIGHT_WAKE_HEAD,
  FLIGHT_WAKE_STORED_BYTES,
  FLIGHT_WATCH_LIMIT,
  type FlightArrivalDisposition,
  type FlightBriefSectionKey,
  type FlightDecision,
  type FlightDecisionKind,
  type FlightLedgerEntry,
  type FlightMemoryNote,
  type FlightMemoryTitle,
  type FlightMoveColumn,
  type FlightPlanInput,
  type FlightPlanOperation,
  type FlightWatchEntry,
  type FlightWatchOperation,
  type FlowIssue,
  type FlowPr,
  GUARD_HITS_LIMIT,
  GUARD_RULES,
  type GuardHit,
  type GuardRule,
  type HealthRow,
  type HudState,
  inferTicket,
  type LoopEvent,
  type MachineSample,
  type MoveColumn,
  memoryTopicKey,
  type PrCheck,
  type ProfileOverride,
  type PullRequestView,
  type ReplyDraft,
  type RepoId,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewRow,
  type ReviewState,
  type ReviewVerdict,
  type Run,
  type RunDigest,
  type RunLoop,
  type RunStatus,
  type SeatSessionRow,
  type SeatState,
  type StoredFinding,
  type StrayKind,
  type Telemetry,
  type TestLockRun,
  TITLE_MARKERS,
  type TokenUsage,
  type UsageSample,
  validateMemoryNote,
  wakeKeyPrefix,
} from "@mc/core";

export const HISTORY_BATCH_ROWS = 500;
export const HISTORY_SWEEP_MAX_BATCHES = 10;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, repo_id TEXT NOT NULL, seq INTEGER NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, session_id TEXT,
  model TEXT, branch TEXT, ticket TEXT, cost_usd REAL, tokens TEXT, transcript_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, started_at);
-- Kept apart from runs so run queries stay small; written on its own change check.
CREATE TABLE IF NOT EXISTS run_digests (run_id TEXT PRIMARY KEY, digest TEXT NOT NULL);
-- HUD state changes that matter (#26 B14): into or out of a notable state.
CREATE TABLE IF NOT EXISTS agent_events (
  agent_id TEXT NOT NULL, at INTEGER NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL,
  text TEXT NOT NULL, PRIMARY KEY (agent_id, at)
);
CREATE TABLE IF NOT EXISTS usage_samples (
  account_id TEXT NOT NULL, window TEXT NOT NULL, at INTEGER NOT NULL, pct REAL NOT NULL,
  reset_at INTEGER NOT NULL, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_lookup ON usage_samples(account_id, window, at);
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, issue_number INTEGER NOT NULL, title TEXT NOT NULL,
  kind TEXT NOT NULL, opened_at INTEGER NOT NULL, url TEXT NOT NULL, question TEXT,
  source TEXT NOT NULL DEFAULT 'label'
);
CREATE TABLE IF NOT EXISTS board_items (
  repo_id TEXT NOT NULL, issue_number INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  state TEXT NOT NULL, labels TEXT NOT NULL, priority TEXT, updated_at INTEGER NOT NULL,
  url TEXT NOT NULL, stage TEXT, owner TEXT, parent INTEGER, sub_done INTEGER, sub_total INTEGER,
  blocked_by TEXT NOT NULL DEFAULT '[]', milestone TEXT, PRIMARY KEY (repo_id, issue_number)
);
CREATE TABLE IF NOT EXISTS pull_requests (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  branch TEXT NOT NULL, ticket TEXT, state TEXT NOT NULL, is_draft INTEGER NOT NULL,
  review TEXT, ci TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, merged_at INTEGER,
  PRIMARY KEY (repo_id, number)
);
CREATE TABLE IF NOT EXISTS flow_issues (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, size TEXT, start_at INTEGER,
  done_at INTEGER NOT NULL, PRIMARY KEY (repo_id, number)
);
CREATE TABLE IF NOT EXISTS flow_prs (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, merged_at INTEGER NOT NULL, first_push_ci TEXT,
  PRIMARY KEY (repo_id, number)
);
CREATE TABLE IF NOT EXISTS file_offsets (path TEXT PRIMARY KEY, offset INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS collector_status (
  collector TEXT PRIMARY KEY, ok INTEGER NOT NULL, error TEXT, at INTEGER NOT NULL,
  last_ok_at INTEGER
);
CREATE TABLE IF NOT EXISTS machine_samples (at INTEGER PRIMARY KEY, sample TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Acknowledged attention items. absent_since: when the key was first missing from the current
-- items (null while present); the ack is dropped once it has been absent for ACK_ABSENT_MS.
CREATE TABLE IF NOT EXISTS acks (key TEXT PRIMARY KEY, at INTEGER NOT NULL, absent_since INTEGER);
-- Status moves of a run's card (pending, then done or failed); the Activity page's board rows.
CREATE TABLE IF NOT EXISTS board_moves (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, repo_id TEXT NOT NULL, issue INTEGER NOT NULL,
  board_column TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS board_moves_at ON board_moves(at);
-- What a run's seat reported (append-only); the loop's reconciler reads the latest.
CREATE TABLE IF NOT EXISTS run_evidence (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, note TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_evidence_run ON run_evidence(run_id);
-- One review of a run's pushed sha (7b-1); attempt counts the tries of one sha within a loop epoch.
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY, author_run_id TEXT NOT NULL, repo_id TEXT NOT NULL, seat_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL, sha TEXT NOT NULL, epoch INTEGER NOT NULL, attempt INTEGER NOT NULL,
  round INTEGER NOT NULL, state TEXT NOT NULL, run_id TEXT, verdict TEXT, summary TEXT,
  blocking INTEGER NOT NULL DEFAULT 0, minor INTEGER NOT NULL DEFAULT 0, failure TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
  UNIQUE (author_run_id, sha, epoch, attempt)
);
CREATE INDEX IF NOT EXISTS reviews_state ON reviews(state, created_at);
CREATE TABLE IF NOT EXISTS review_findings (
  id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL, author_run_id TEXT NOT NULL, pos INTEGER NOT NULL,
  severity TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, summary TEXT NOT NULL,
  scenario TEXT NOT NULL, fix TEXT NOT NULL, state TEXT NOT NULL, UNIQUE (review_id, pos)
);
-- Lines sent to a seat, one row per key: a claimed key is never sent twice.
CREATE TABLE IF NOT EXISTS seat_lines (
  key TEXT PRIMARY KEY, run_id TEXT NOT NULL, seat_id TEXT NOT NULL, origin TEXT NOT NULL,
  text TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS seat_lines_run ON seat_lines(run_id);
-- The Activity page's loop rows; the key makes a re-emitted event land once.
CREATE TABLE IF NOT EXISTS loop_events (
  key TEXT PRIMARY KEY, run_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS loop_events_at ON loop_events(at);
-- Hand-offs between agents (Activity › Messages): who told whom what, about which ticket.
CREATE TABLE IF NOT EXISTS comms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, from_id TEXT NOT NULL,
  to_id TEXT NOT NULL, ticket TEXT, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comms_at ON comms(at);
CREATE INDEX IF NOT EXISTS comms_from_id ON comms(from_id, id);
CREATE INDEX IF NOT EXISTS comms_to_id ON comms(to_id, id);
CREATE TABLE IF NOT EXISTS comms_reads (
  thread_id TEXT NOT NULL, source_id TEXT NOT NULL, offset INTEGER NOT NULL, block INTEGER NOT NULL,
  PRIMARY KEY (thread_id, source_id)
);
-- The Activity page's hub rows (an automatic update); the primary key keeps a line landing once.
CREATE TABLE IF NOT EXISTS hub_events (
  at INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (at, text)
);
-- A seat's next issues; taken_at is set while a seat holds the head and has not started its run.
CREATE TABLE IF NOT EXISTS queues (
  seat_id TEXT NOT NULL, pos INTEGER NOT NULL, repo_id TEXT NOT NULL, issue INTEGER NOT NULL,
  taken_at INTEGER, PRIMARY KEY (seat_id, pos)
);
-- Needs-you notes the engine raises; cleared_at is set once the cause is gone, dismissed_at when the operator dismissed it (reset when it is raised again).
CREATE TABLE IF NOT EXISTS attention_notes (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT, seat_id TEXT, repo_id TEXT,
  text TEXT NOT NULL, at INTEGER NOT NULL, cleared_at INTEGER, dismissed_at INTEGER
);
-- Preserve every note episode, including the history available on upgrade.
CREATE TABLE IF NOT EXISTS attention_episodes (
  key TEXT NOT NULL, kind TEXT NOT NULL, seat_id TEXT, at INTEGER NOT NULL,
  cleared_at INTEGER
);
CREATE TRIGGER IF NOT EXISTS attention_episode_open AFTER INSERT ON attention_notes BEGIN
  INSERT INTO attention_episodes VALUES (NEW.key, NEW.kind, NEW.seat_id, NEW.at, NEW.cleared_at);
END;
CREATE TRIGGER IF NOT EXISTS attention_episode_reopen AFTER UPDATE ON attention_notes
WHEN OLD.cleared_at IS NOT NULL AND NEW.cleared_at IS NULL BEGIN
  INSERT INTO attention_episodes VALUES (NEW.key, NEW.kind, NEW.seat_id, NEW.at, NULL);
END;
CREATE TRIGGER IF NOT EXISTS attention_episode_close AFTER UPDATE ON attention_notes
WHEN OLD.cleared_at IS NULL AND NEW.cleared_at IS NOT NULL BEGIN
  UPDATE attention_episodes SET cleared_at = NEW.cleared_at WHERE key = OLD.key AND cleared_at IS NULL;
END;
-- One row per crew seat (phase 2a); run_id is null when no run is active.
CREATE TABLE IF NOT EXISTS seat_sessions (
  seat_id TEXT PRIMARY KEY, run_id TEXT, cli_session_id TEXT, state TEXT NOT NULL, reason TEXT,
  worktree TEXT, updated_at INTEGER NOT NULL
);
-- Tool calls the guard refused (phase 2b). text: the rule's text plus program and subcommand.
CREATE TABLE IF NOT EXISTS guard_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, run_id TEXT, rule TEXT NOT NULL,
  text TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guard_hits_at ON guard_hits(at);
-- Commits the mc commit tool made (phase 2b): the only commits a push may send.
CREATE TABLE IF NOT EXISTS run_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, repo_id TEXT NOT NULL,
  branch TEXT NOT NULL, sha TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (run_id, sha)
);
CREATE TABLE IF NOT EXISTS commit_lines (
  sha TEXT PRIMARY KEY, additions INTEGER, deletions INTEGER
);
CREATE INDEX IF NOT EXISTS run_commits_first ON run_commits(repo_id, sha, at, id);
CREATE INDEX IF NOT EXISTS run_commits_branch ON run_commits(repo_id, branch);
CREATE INDEX IF NOT EXISTS run_commits_at ON run_commits(at);
-- Append-only observations for a run and its linked review runs.
CREATE TABLE IF NOT EXISTS run_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL,
  at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_attempts_run ON run_attempts(run_id, id);
-- The sha a run last pushed to its branch, or found origin already at (phase 2b): draft_pr needs
-- it to be the branch's tip.
CREATE TABLE IF NOT EXISTS run_pushes (run_id TEXT PRIMARY KEY, sha TEXT NOT NULL, at INTEGER NOT NULL);
-- Paths a refused commit had outside the seat's area (Needs you). key: strayKey(session, path).
CREATE TABLE IF NOT EXISTS strays (
  key TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, agent_id TEXT NOT NULL,
  kind TEXT NOT NULL, at INTEGER NOT NULL
);
-- A seat's ask_operator questions; answered_at is set by a message to the seat, or the run's end.
CREATE TABLE IF NOT EXISTS seat_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, run_id TEXT NOT NULL,
  text TEXT NOT NULL, at INTEGER NOT NULL, answered_at INTEGER
);
-- Failures of the mc tools that the operator is told of (Needs you, until acked).
CREATE TABLE IF NOT EXISTS crew_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, run_id TEXT, text TEXT NOT NULL,
  at INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0
);
-- What the FLIGHT seat decided, with its basis ("Decided without you").
CREATE TABLE IF NOT EXISTS flight_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, seat_id TEXT,
  target_run_id TEXT, ref TEXT, question_id INTEGER, about TEXT NOT NULL, decision TEXT NOT NULL,
  basis TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS flight_decisions_at ON flight_decisions(at);
-- The test lock's held calls (one row per tool call of the holding run), so a restart restores them.
CREATE TABLE IF NOT EXISTS test_lock_holds (
  run_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, seat_id TEXT NOT NULL, command TEXT NOT NULL,
  since INTEGER NOT NULL, PRIMARY KEY (run_id, tool_use_id)
);
-- One row per hold, retained for eight days.
CREATE TABLE IF NOT EXISTS test_lock_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seat_id TEXT NOT NULL,
  command TEXT NOT NULL, queued_at INTEGER NOT NULL, started_at INTEGER NOT NULL,
  ended_at INTEGER, outcome TEXT
);
CREATE INDEX IF NOT EXISTS test_lock_runs_started ON test_lock_runs(started_at);
-- The last keeper line the hub acted on, per run: the next hub replays from here.
CREATE TABLE IF NOT EXISTS keeper_cursors (
  run_id TEXT PRIMARY KEY, spawn TEXT NOT NULL, line INTEGER NOT NULL, rate_limited_until INTEGER
);
-- FLIGHT's briefs on Needs-you items (the newest row per key shows); options is JSON.
CREATE TABLE IF NOT EXISTS briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, context TEXT NOT NULL,
  recommendation TEXT NOT NULL, options TEXT NOT NULL, basis TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS item_discussions (
  id TEXT PRIMARY KEY, item_key TEXT NOT NULL, version TEXT NOT NULL, messages TEXT NOT NULL, sent TEXT NOT NULL DEFAULT '[]',
  UNIQUE(item_key, version)
);
CREATE INDEX IF NOT EXISTS briefs_key ON briefs(key);
CREATE INDEX IF NOT EXISTS briefs_at ON briefs(at);
-- The template profile FLIGHT or the planner chose for a ticket, with the reason; the latest wins.
CREATE TABLE IF NOT EXISTS profile_overrides (
  repo_id TEXT NOT NULL, issue INTEGER NOT NULL, profile TEXT NOT NULL, reason TEXT NOT NULL,
  by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (repo_id, issue)
);
-- Cards FLIGHT holds in Backlog behind an open PR; released_at is set when the card is promoted again.
CREATE TABLE IF NOT EXISTS holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, waits_on INTEGER NOT NULL,
  basis TEXT NOT NULL, at INTEGER NOT NULL, released_at INTEGER, seen INTEGER NOT NULL DEFAULT 0,
  told_state TEXT
);
CREATE INDEX IF NOT EXISTS holds_ref ON holds(ref);
-- FLIGHT's living brief: one row per crew session and section.
CREATE TABLE IF NOT EXISTS flight_brief (
  session_id TEXT NOT NULL, section TEXT NOT NULL, text TEXT NOT NULL,
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (session_id, section)
);
CREATE TABLE IF NOT EXISTS flight_memory (
  repo_id TEXT NOT NULL, topic TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
  source TEXT NOT NULL, author TEXT NOT NULL, topic_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (repo_id, topic_key)
);
CREATE TABLE IF NOT EXISTS flight_ledger (
  session_id TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  updated_at INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY(session_id, key)
);
CREATE TABLE IF NOT EXISTS flight_watch (
  session_id TEXT NOT NULL, id TEXT NOT NULL, entry TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE IF NOT EXISTS flight_plans (
  session_id TEXT NOT NULL, id TEXT NOT NULL, entry TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE IF NOT EXISTS flight_incoming (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, arrival_id TEXT NOT NULL, version TEXT NOT NULL,
  at INTEGER NOT NULL, entry TEXT NOT NULL, UNIQUE (source, arrival_id, version)
);
-- The operator's GitHub notification threads (read-only copy); handled_* closes a thread here.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, subject_type TEXT NOT NULL, title TEXT NOT NULL,
  number INTEGER, reason TEXT NOT NULL, url TEXT NOT NULL, author TEXT, snippet TEXT,
  updated_at INTEGER NOT NULL, last_read_at INTEGER, unread INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL, handled_at INTEGER, handled_how TEXT, handled_through INTEGER
);
-- Worktree paths a crew start is making (worktree add, then the install); one still here at the
-- next start was left half-made, and is removed and made again.
CREATE TABLE IF NOT EXISTS checkouts_pending (path TEXT PRIMARY KEY, at INTEGER NOT NULL);

`;

type Row = Record<string, SQLInputValue>;

/** One notification thread, as stored. */
export interface NotificationRow {
  id: string;
  repoId: RepoId;
  subjectType: string;
  title: string;
  number: number | null;
  reason: string;
  url: string;
  author: string | null;
  snippet: string | null;
  updatedAt: number;
  lastReadAt: number | null;
  unread: boolean;
  firstSeenAt: number;
  handledAt: number | null;
  handledHow: "marked" | "read" | "replied" | "copied" | "flight" | null;
  message?: PersonMessage;
  history?: PersonMessage[];
  /** The `updatedAt` that was handled: a thread updated after it is open again. */
  handledThrough: number | null;
}

/** What a GitHub read gives for a thread: the stored row less the bookkeeping the store owns. */
export type NotificationRead = Omit<
  NotificationRow,
  "unread" | "firstSeenAt" | "handledAt" | "handledHow" | "handledThrough"
>;

const notificationRow = (r: Row): NotificationRow => ({
  ...(r.source_content ? JSON.parse(r.source_content as string) : {}),
  id: r.id as string,
  repoId: r.repo_id as string,
  subjectType: r.subject_type as string,
  title: r.title as string,
  number: r.number as number | null,
  reason: r.reason as string,
  url: r.url as string,
  author: r.author as string | null,
  snippet: r.snippet as string | null,
  updatedAt: r.updated_at as number,
  lastReadAt: r.last_read_at as number | null,
  unread: r.unread === 1,
  firstSeenAt: r.first_seen_at as number,
  handledAt: r.handled_at as number | null,
  handledHow: r.handled_how as NotificationRow["handledHow"],
  handledThrough: r.handled_through as number | null,
});

/** One section of FLIGHT's brief, as stored. */
export interface FlightBriefRow {
  sessionId: string;
  section: FlightBriefSectionKey | typeof FLIGHT_HEADLINE;
  text: string;
  updatedAt: number;
  updatedBy: string;
}

/** A card FLIGHT holds in Backlog behind an open PR. */
export interface Hold {
  ref: string;
  waitsOn: number;
  basis: string;
  at: number;
  releasedAt: number | null;
  /** The stored board has shown the card in Backlog since the hold; until then a Ready card is just stale. */
  seen: boolean;
  /** The PR state FLIGHT was last woken for on this hold, or null. */
  toldState: string | null;
}

/** One path a refused commit had outside the seat's area. */
export interface Stray {
  key: string;
  sessionId: string;
  path: string;
  /** The seat whose commit had it. */
  agentId: AgentId;
  kind: StrayKind;
  at: number;
}

/** A seat's open `ask_operator` question. */
export interface SeatQuestion {
  id: number;
  agentId: AgentId;
  runId: string;
  text: string;
  at: number;
  /** When FLIGHT passed it to the operator, else null. */
  passedAt: number | null;
}

/** An mc tool failure the operator is told of. */
export interface CrewError {
  id: number;
  agentId: AgentId;
  runId: string | null;
  text: string;
  at: number;
}

/** `stray:` + the first 16 hex characters of SHA-256 of `session\0path`: one item per path. */
export function strayKey(sessionId: string, path: string): string {
  return `stray:${createHash("sha256").update(`${sessionId}\0${path}`).digest("hex").slice(0, 16)}`;
}

/** Memory in use as a percentage of the total; null when unmeasured or the total is unknown. */
const memPct = (s: MachineSample): number | null =>
  s.memUsedBytes !== null && s.memTotalBytes > 0 ? (s.memUsedBytes / s.memTotalBytes) * 100 : null;

/** The seat states that still hold a run: the supervisor reattaches these after a restart. */
export const ACTIVE_SEAT_STATES: readonly SeatState[] = ["idle", "starting", "running", "parked"];

/** `{dir of the DB}/crew/`: every crew run's files. Created with mode 0700. */
export function crewDir(dbPath: string): string {
  const dir = join(dirname(dbPath), "crew");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A crew run's transcript: `{dir of the DB}/crew/{runId}.jsonl`. */
export function crewTranscriptPath(dbPath: string, runId: string): string {
  return join(crewDir(dbPath), `${runId}.jsonl`);
}

/** A crew run's system prompt file (role brief + the repo's CLAUDE.md), beside its transcript. */
export function crewPromptPath(dbPath: string, runId: string): string {
  return join(dirname(crewTranscriptPath(dbPath, runId)), `${runId}.prompt.md`);
}

/**
 * A crew run's token file, beside its transcript: what the guard hook reads its token from. The
 * supervisor writes it at 0600 for the run's process and removes it when that process exits; the
 * sandbox read-denies the whole directory.
 */
/** One held call of the test lock, as stored. */
export interface LockHoldRow {
  /** When the call joined the line; `since` when absent. Not a column of `test_lock_holds`. */
  queuedAt?: number;
  runId: string;
  toolUseId: string;
  seatId: string;
  command: string;
  since: number;
}

export function crewTokenPath(dbPath: string, runId: string): string {
  return join(dirname(crewTranscriptPath(dbPath, runId)), `${runId}.token`);
}

/** A crew run's `--mcp-config` file (it holds the token too): written and removed with it. */
export function crewMcpPath(dbPath: string, runId: string): string {
  return join(dirname(crewTranscriptPath(dbPath, runId)), `${runId}.mcp.json`);
}

/** A draft PR's body file (`pr-<uuid>.md` in `{DB dir}/crew/`), which `gh pr create` reads. */
export const CREW_PR_BODY_FILE =
  /^pr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/;

/** A new, unique path for a draft PR's body file; the tool removes it once gh has read it. */
export function crewPrBodyPath(dbPath: string): string {
  return join(crewDir(dbPath), `pr-${randomUUID()}.md`);
}

/** A crew run's keeper folder: `{dir of the DB}/crew/k-<12 hex of sha256(runId)>`, short for its socket path. */
export function crewKeeperDir(dbPath: string, runId: string): string {
  const hex = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return join(crewDir(dbPath), `k-${hex}`);
}

/** Codex thread storage survives replacement of the run's keeper. */
export function crewCodexDir(dbPath: string, runId: string): string {
  const hex = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return join(crewDir(dbPath), `codex-${hex}`);
}

export const CREW_CODEX_DIR = /^codex-[0-9a-f]{12}$/;

/** A keeper folder's name in `{DB dir}/crew/`. */
export const CREW_KEEPER_DIR = /^k-[0-9a-f]{12}$/;

/** What the hub has acted on of a run's keeper: the lines of keeper `spawn` below `line`. */
export interface KeeperCursor {
  runId: string;
  spawn: string;
  line: number;
  rateLimitedUntil: number | null;
}

export const BUSY_TIMEOUT_MS = 5000;
/** `PRAGMA user_version` once the usage_samples dedupe and its unique index are in place. */
const USAGE_DEDUPE_VERSION = 1;
/** Per-minute machine samples older than this (before the newest one) are deleted. */
export const MACHINE_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** An ack whose key has been absent from the attention items for longer than this is deleted. */
export const ACK_ABSENT_MS = 7 * 24 * 60 * 60_000;
/**
 * A stored digest; one persisted before `background` existed has none in flight, one before
 * `compactions` existed has none counted, one before `lastText` existed has no text.
 */
const parseDigest = (json: string): RunDigest => {
  const d = { background: [], compactions: 0, lastText: null, ...JSON.parse(json) } as RunDigest;
  // One before the live tool's `detail` existed names it with nothing.
  return d.liveTool ? { ...d, liveTool: { detail: null, ...d.liveTool } } : d;
};

/**
 * The per-repo tables the GitHub collector rewrites, each with its key: the order in which
 * `changed()` reads a repo's rows, so a reordered but equal answer is not a change.
 */
const REPO_TABLES = {
  board_items: "issue_number",
  escalations: "id",
  pull_requests: "number",
} as const;
type RepoTable = keyof typeof REPO_TABLES;

export type BoardMoveState = "pending" | "done" | "failed";

/** One Status move of a run's card; `detail` is why it failed. */
export interface BoardMove {
  id: number;
  runId: string;
  repoId: RepoId;
  issue: number;
  column: MoveColumn | FlightMoveColumn;
  state: BoardMoveState;
  detail: string | null;
  at: number;
}

/** Who a seat line is from. */
/** A hand-off between agents; `from` and `to` are seat ids, COMMS_CAPCOM or COMMS_MC. */
export interface CommsRow {
  at: number;
  from: string;
  to: string;
  ticket: string | null;
  text: string;
}

export const THREAD_COMMS_LIMIT = 500;

/** The source and position of a stable Comms/transcript message ID. */
export function commsPosition(
  id: string,
): { source: string; offset: number; block: number } | null {
  const match = /^(comms):(\d+)$|^(stream:.+):(\d+):(\d+)$/.exec(id);
  if (!match) return null;
  const offset = Number(match[2] ?? match[4]);
  const block = Number(match[5] ?? 0);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(block)) return null;
  const source = match[1] ?? match[3];
  return source === undefined ? null : { source, offset, block };
}

export type SeatLineOrigin = "operator" | "engine";

/** A line sent to a seat; its key is what makes sending it once-only. */
export interface SeatLine {
  runId: string;
  seatId: string;
  origin: SeatLineOrigin;
  text: string;
  at: number;
}

/** What a run's seat reported. */
export interface Evidence {
  id: number;
  runId: string;
  note: string;
  at: number;
}

/** One issue in a seat's queue; `takenAt` is set while the seat holds it. */
export interface QueueRow {
  seatId: string;
  pos: number;
  repoId: RepoId;
  issue: number;
  takenAt: number | null;
}

/** The attention kinds the engine raises as notes. */
export type NoteKind = Extract<
  AttentionKind,
  "blocked" | "review" | "ready" | "flag" | "ratelimit" | "question"
>;

export interface NoteInput {
  key: string;
  kind: NoteKind;
  runId: string | null;
  seatId: string | null;
  repoId: RepoId | null;
  text: string;
  at: number;
}

export interface AttentionNote extends NoteInput {
  clearedAt: number | null;
  /** When the operator dismissed it from Needs you, else null. */
  dismissedAt: number | null;
}

/** One recorded HUD state change of an agent. */
export interface AgentEvent {
  agentId: AgentId;
  at: number;
  from: HudState;
  to: HudState;
  text: string;
}

/** A run still open (no end) this long before a query's end is an abandoned row, not live work. */
export const MAX_OPEN_RUN_AGE_MS = 30 * 24 * 60 * 60_000;

/** Run ids per `digests()` query (well under SQLite's bound-parameter limit). */
const DIGEST_BATCH = 500;

const toSample = (r: Row): UsageSample => ({
  accountId: r.account_id as string,
  window: r.window as "5h" | "7d",
  at: r.at as number,
  pct: r.pct as number,
  resetAt: r.reset_at as number,
  source: r.source as string,
});

/** A run's stored plan fact; a value that won't parse is dropped rather than failing every run read. */
function parsePlan(raw: string): { plan?: Run["plan"] } {
  try {
    const plan = JSON.parse(raw) as Run["plan"];
    return plan !== null && typeof plan === "object" ? { plan } : {};
  } catch {
    return {};
  }
}

const toRun = (r: Row): Run => ({
  ...(r.vendor === "codex" ? { vendor: "codex" as const } : {}),
  ...(r.latest_plan == null ? {} : { latestPlan: r.latest_plan as string }),
  // Absent, not null, on a row from before the ticket's title was stored.
  ...(r.ticket_title === null || r.ticket_title === undefined
    ? {}
    : { ticketTitle: r.ticket_title as string }),
  // Absent, not null, on a run that did not record its CLI version.
  ...(r.cli_version === null || r.cli_version === undefined
    ? {}
    : { cliVersion: r.cli_version as string }),
  // Absent, not null, on a run no loop drives or that has no recorded ender.
  ...(r.loop === null || r.loop === undefined
    ? {}
    : { loop: JSON.parse(r.loop as string) as RunLoop }),
  ...(r.plan == null ? {} : parsePlan(r.plan as string)),
  // Absent, not null, on a run that started without a profile.
  ...(r.profile === null || r.profile === undefined
    ? {}
    : {
        profile: {
          ...(JSON.parse(r.profile as string) as ChosenProfile),
          hash: r.profile_hash as string,
        },
      }),
  ...(r.ended_by === null || r.ended_by === undefined
    ? {}
    : { endedBy: r.ended_by as NonNullable<Run["endedBy"]> }),
  ...(r.no_report == null
    ? {}
    : { noReport: JSON.parse(r.no_report as string) as Run["noReport"] }),
  id: r.id as string,
  agentId: r.agent_id as string,
  repoId: r.repo_id as string,
  seq: r.seq as number,
  startedAt: r.started_at as number,
  endedAt: r.ended_at as number | null,
  status: r.status as Run["status"],
  sessionId: r.session_id as string | null,
  model: r.model as string | null,
  branch: r.branch as string | null,
  ticket: r.ticket as string | null,
  costUsd: r.cost_usd as number | null,
  tokens: r.tokens === null ? null : (JSON.parse(r.tokens as string) as TokenUsage),
  transcriptPath: r.transcript_path as string,
  prs: JSON.parse(r.prs as string) as Run["prs"],
  summary: r.summary as string | null,
  reviewId: (r.review_id ?? null) as number | null,
});

const toReview = (r: Row): ReviewRow => ({
  id: r.id as number,
  authorRunId: r.author_run_id as string,
  repoId: r.repo_id as string,
  seatId: r.seat_id as string,
  prNumber: r.pr_number as number,
  sha: r.sha as string,
  epoch: r.epoch as number,
  attempt: r.attempt as number,
  round: r.round as number,
  state: r.state as ReviewState,
  runId: r.run_id as string | null,
  verdict: r.verdict === null ? null : (JSON.parse(r.verdict as string) as ReviewVerdict),
  summary: r.summary as string | null,
  blocking: r.blocking as number,
  minor: r.minor as number,
  failure: r.failure as string | null,
  createdAt: r.created_at as number,
  startedAt: r.started_at as number | null,
  endedAt: r.ended_at as number | null,
});

const toGuardHit = (r: Row): GuardHit => ({
  id: r.id as number,
  agentId: r.agent_id as string,
  runId: r.run_id as string | null,
  rule: r.rule as GuardRule,
  text: r.text as string,
  at: r.at as number,
});

const queueRow = (r: Row): QueueRow => ({
  seatId: r.seat_id as string,
  pos: r.pos as number,
  repoId: r.repo_id as string,
  issue: r.issue as number,
  takenAt: r.taken_at as number | null,
});

const toQuestion = (r: Row): SeatQuestion => ({
  id: r.id as number,
  agentId: r.agent_id as string,
  runId: r.run_id as string,
  text: r.text as string,
  at: r.at as number,
  passedAt: r.passed_at as number | null,
});

const seatRow = (r: Row): SeatSessionRow => ({
  ...(r.vendor === "codex" ? { vendor: "codex" as const } : {}),
  seatId: r.seat_id as string,
  runId: r.run_id as string | null,
  cliSessionId: r.cli_session_id as string | null,
  state: r.state as SeatState,
  reason: r.reason as string | null,
  worktree: r.worktree as string | null,
  updatedAt: r.updated_at as number,
  lastTurnEndedAt: (r.last_turn_ended_at as number | null | undefined) ?? null,
  ...(r.state === "error" ? { errorSince: (r.error_since ?? r.updated_at) as number } : {}),
});

/** The sha256 identifies a wake, nothing more: the hub keeps no past wake JSON to retrieve. */
function compactFlightWake(text: string): string {
  const json = text.slice(text.lastIndexOf("\n") + 1);
  const suffix = `\nsha256:${createHash("sha256").update(json).digest("hex")}`;
  const limit = FLIGHT_WAKE_STORED_BYTES - Buffer.byteLength(suffix);
  let header = "";
  let bytes = 0;
  for (const char of text.split("\n", 1)[0] ?? "") {
    bytes += Buffer.byteLength(char);
    if (bytes > limit) break;
    header += char;
  }
  return header + suffix;
}

export class Store {
  private readonly db: DatabaseSync;

  /** `busyTimeoutMs` is shortened only by tests that hold a lock on purpose. */
  /** The database file. */
  readonly path: string;

  constructor(path: string, busyTimeoutMs = BUSY_TIMEOUT_MS) {
    this.path = path;
    // Wait up to the timeout for another writer's lock instead of failing at once.
    this.db = new DatabaseSync(path, { timeout: busyTimeoutMs });
    this.db.exec("PRAGMA journal_mode = WAL");
    const hasEpisodes = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'attention_episodes'")
      .get();
    this.db.exec(SCHEMA);
    if (!hasEpisodes)
      this.db.exec(
        "INSERT OR IGNORE INTO attention_episodes SELECT key, kind, seat_id, at, cleared_at FROM attention_notes",
      );
    this.migrate();
  }

  markCheckoutPending(path: string, at: number): void {
    this.db
      .prepare(
        "INSERT INTO checkouts_pending (path, at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET at = excluded.at",
      )
      .run(path, at);
  }

  checkoutPending(path: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM checkouts_pending WHERE path = ?").get(path) !== undefined
    );
  }

  clearCheckoutPending(path: string): void {
    this.db.prepare("DELETE FROM checkouts_pending WHERE path = ?").run(path);
  }

  /** Cache token for local writes and commits made by another SQLite connection. */
  readVersion(): string {
    return `${this.db.prepare("SELECT total_changes() AS n").get()?.n}:${this.db.prepare("PRAGMA data_version").get()?.data_version}`;
  }

  private closed = false;

  /** Closes the database; the store is unusable after. Closing again does nothing. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private hasColumn(table: string, column: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    return cols.some((c) => c.name === column);
  }

  /**
   * Runs `fn` if `table` lacks `column`. The check is made again inside a write-locked transaction
   * so a second process opening the same file waits, then finds the column added and skips it,
   * rather than failing on a duplicate ALTER.
   */
  private whenColumnMissing(table: string, column: string, fn: () => void): void {
    if (this.hasColumn(table, column)) return;
    this.transaction(() => {
      if (!this.hasColumn(table, column)) fn();
    }, true);
  }

  /** Adds `column` to `table` when it is missing. */
  private addColumn(table: string, column: string, type: string): void {
    this.whenColumnMissing(table, column, () =>
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`),
    );
  }

  /** Columns added after the first release; each runs once, on a database that lacks it. */
  private migrate(): void {
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS flight_memory_key ON flight_memory(repo_id, topic_key)",
    );
    if (this.getSetting("flight-wake-compact-v1") === null) {
      this.transaction(() => {
        if (this.getSetting("flight-wake-compact-v1") !== null) return;
        const rows = this.db
          .prepare(
            "SELECT key, text FROM seat_lines WHERE key LIKE 'flight:wake:%' AND length(CAST(text AS BLOB)) > ?",
          )
          .all(FLIGHT_WAKE_STORED_BYTES) as { key: string; text: string }[];
        const update = this.db.prepare("UPDATE seat_lines SET text = ? WHERE key = ?");
        for (const row of rows) update.run(compactFlightWake(row.text), row.key);
        this.setSetting("flight-wake-compact-v1", "1");
      }, true);
    }
    // Discard the old later-state fallback starts; the next flow collection reads Ready history.
    if (this.getSetting("flow-ready-start-v1") === null) {
      this.transaction(() => {
        if (this.getSetting("flow-ready-start-v1") !== null) return;
        this.db.exec("DELETE FROM flow_issues");
        this.setSetting("flow-ready-start-v1", "1");
      }, true);
    }
    this.addColumn("notifications", "source_content", "TEXT");
    this.addColumn("briefs", "structured", "TEXT");
    this.addColumn("drafts", "source", "TEXT");
    this.addColumn("drafts", "metadata", "TEXT");
    this.addColumn("drafts", "completed_at", "INTEGER");
    // An ok row last succeeded when it was recorded; a failing row's last success is unknown.
    this.whenColumnMissing("collector_status", "last_ok_at", () => {
      this.db.exec("ALTER TABLE collector_status ADD COLUMN last_ok_at INTEGER");
      this.db.exec("UPDATE collector_status SET last_ok_at = at WHERE ok = 1");
    });
    // A re-polled fallback reading has the same key every time: keep one row per reading. Once per
    // database (`PRAGMA user_version`); the unique index keeps it true afterwards. An up-to-date
    // database takes no write lock; one that is behind re-checks once it holds it.
    const userVersion = (): number =>
      (this.db.prepare("PRAGMA user_version").get() as Row).user_version as number;
    if (userVersion() < USAGE_DEDUPE_VERSION) {
      this.transaction(() => {
        if (userVersion() >= USAGE_DEDUPE_VERSION) return;
        this.db.exec(
          `DELETE FROM usage_samples WHERE rowid NOT IN (
             SELECT MIN(rowid) FROM usage_samples GROUP BY account_id, window, at, source
           )`,
        );
        this.db.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS usage_unique ON usage_samples(account_id, window, at, source)",
        );
        this.db.exec(`PRAGMA user_version = ${USAGE_DEDUPE_VERSION}`);
      }, true);
    }
    // Board columns added with the Stage/Owner/hierarchy fields; the next GitHub poll fills them.
    const boardColumns: [string, string][] = [
      ["author", "TEXT"],
      ["stage", "TEXT"],
      ["owner", "TEXT"],
      ["parent", "INTEGER"],
      ["sub_done", "INTEGER"],
      ["sub_total", "INTEGER"],
      ["blocked_by", "TEXT NOT NULL DEFAULT '[]'"],
      ["milestone", "TEXT"],
      ["size", "TEXT"],
      ["closed", "INTEGER NOT NULL DEFAULT 0"],
      ["priority_source", "TEXT"],
    ];
    for (const [column, type] of boardColumns) this.addColumn("board_items", column, type);
    // Logins assigned to the card's issue (a JSON list); the next GitHub poll fills it.
    this.addColumn("board_items", "assignees", "TEXT NOT NULL DEFAULT '[]'");
    // What a run was about (#26 A3). `folded`: the transcript of the ended run has been folded
    // into the row, so the backfill can skip it.
    const runColumns: [string, string][] = [
      ["vendor", "TEXT NOT NULL DEFAULT 'claude'"],
      ["latest_plan", "TEXT"],
      ["prs", "TEXT NOT NULL DEFAULT '[]'"],
      ["summary", "TEXT"],
      ["folded", "INTEGER NOT NULL DEFAULT 0"],
      // The first loop's state (JSON) and who ended the run; `upsertRun` never writes them.
      ["loop", "TEXT"],
      ["ended_by", "TEXT"],
      ["no_report", "TEXT"],
      // The ticket's title as the run started with it; null on rows from before it was stored.
      ["ticket_title", "TEXT"],
      // The review a run performs (7b-1); `upsertRun` never rewrites it.
      ["review_id", "INTEGER"],
      // The `claude` CLI version the run started on; null on rows from before it was recorded.
      ["cli_version", "TEXT"],
      // The template profile the run started with (JSON of profile and route) and its hash;
      // `upsertRun` writes them on a new row only.
      ["profile", "TEXT"],
      ["profile_hash", "TEXT"],
      // The plan at run creation; later transcript folds never rewrite it.
      ["plan", "TEXT"],
    ];
    for (const [column, type] of runColumns) this.addColumn("runs", column, type);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS loop_events_run ON loop_events(run_id);
      CREATE INDEX IF NOT EXISTS reviews_run ON reviews(run_id);
      CREATE INDEX IF NOT EXISTS reviews_repo_pr ON reviews(repo_id, pr_number, state);
      CREATE INDEX IF NOT EXISTS board_moves_run ON board_moves(run_id);
      CREATE INDEX IF NOT EXISTS flight_decisions_target_kind ON flight_decisions(target_run_id, kind);
      CREATE INDEX IF NOT EXISTS runs_review ON runs(review_id);
      CREATE INDEX IF NOT EXISTS runs_repo_branch ON runs(repo_id, branch);
      CREATE INDEX IF NOT EXISTS runs_repo_ticket ON runs(repo_id, ticket);
      CREATE INDEX IF NOT EXISTS runs_ended ON runs(ended_at);
      CREATE INDEX IF NOT EXISTS runs_folded ON runs(folded, started_at);
      CREATE INDEX IF NOT EXISTS seat_questions_answered ON seat_questions(answered_at);
    `);
    // 0 / null: stored before the card ids were read; the next GitHub poll fills them.
    this.addColumn("board_items", "created_at", "INTEGER NOT NULL DEFAULT 0");
    // When the seat's last turn ended; the engine's quiet-seat check reads it.
    this.addColumn("seat_sessions", "last_turn_ended_at", "INTEGER");
    this.addColumn("seat_sessions", "error_since", "INTEGER");
    this.addColumn("seat_sessions", "vendor", "TEXT NOT NULL DEFAULT 'claude'");
    this.addColumn("board_items", "item_id", "TEXT");
    this.addColumn("board_items", "project_id", "TEXT");
    // When FLIGHT passed the question to the operator (it stays open until they answer).
    this.addColumn("seat_questions", "passed_at", "INTEGER");
    // When the operator dismissed the note from Needs you; a re-raised note is shown again.
    this.addColumn("attention_notes", "dismissed_at", "INTEGER");
    // A PR snapshot's `polledAt` is `read_at` (our clock, written with every upsert); there is no
    // separate column. `mergeable` UNKNOWN means GitHub has not computed it yet: poll again.
    this.addColumn("holds", "told_state", "TEXT");
    this.addColumn("pull_requests", "head_sha", "TEXT");
    this.addColumn("pull_requests", "merge_commit_sha", "TEXT");
    this.addColumn("pull_requests", "mergeable", "TEXT");
    // Who opened the PR and who is assigned: a PR run by another hub's login is that lane's.
    this.addColumn("pull_requests", "author", "TEXT");
    this.addColumn("pull_requests", "assignees", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("pull_requests", "checks", "TEXT NOT NULL DEFAULT '[]'");
    // Old PRs keep []: followPrs falls back to their ticket, even without another GitHub poll.
    this.addColumn("pull_requests", "closing_issues", "TEXT NOT NULL DEFAULT '[]'");
    // On every start: a row whose branch names a ticket the pattern did not know when the row was
    // stored (`docs/` branches) gets it now. A row's ticket is never replaced.
    this.transaction(() => {
      const rows = this.db
        .prepare("SELECT id, repo_id, branch FROM runs WHERE branch IS NOT NULL AND ticket IS NULL")
        .all() as { id: string; repo_id: string; branch: string }[];
      const set = this.db.prepare("UPDATE runs SET ticket = ? WHERE id = ?");
      for (const r of rows) {
        const ticket = inferTicket(r.branch, r.repo_id);
        if (ticket !== null) set.run(ticket, r.id);
      }
    });
    // When we read the row from GitHub, by our own clock (GitHub's updatedAt does not move when a
    // PR's CI finishes). 0: stored before it existed, older than any read.
    this.addColumn("pull_requests", "read_at", "INTEGER NOT NULL DEFAULT 0");
    // 1 while the latest poll failed to read the repo's PRs: the row is the last good read.
    this.addColumn("pull_requests", "stale", "INTEGER NOT NULL DEFAULT 0");
    // Machine samples' CPU and memory shares, extracted once so the telemetry ranges average
    // columns rather than parsing every sample's JSON.
    this.whenColumnMissing("machine_samples", "cpu_pct", () => {
      this.db.exec("ALTER TABLE machine_samples ADD COLUMN cpu_pct REAL");
      this.db.exec("ALTER TABLE machine_samples ADD COLUMN mem_pct REAL");
      // The same arithmetic as memPct, so a backfilled row equals a freshly stored one.
      this.db.exec(
        `UPDATE machine_samples SET
           cpu_pct = json_extract(sample, '$.cpuPct'),
           mem_pct = CASE WHEN json_extract(sample, '$.memTotalBytes') > 0
             THEN json_extract(sample, '$.memUsedBytes') * 1.0
               / json_extract(sample, '$.memTotalBytes') * 100 END`,
      );
    });
    // Rows from before `source`: a title marker (as the GitHub collector matches it) means
    // `title`. The next GitHub poll rewrites every row anyway.
    this.whenColumnMissing("escalations", "source", () => {
      this.db.exec("ALTER TABLE escalations ADD COLUMN source TEXT NOT NULL DEFAULT 'label'");
      this.db.exec(
        `UPDATE escalations SET source = 'title' WHERE ${TITLE_MARKERS.map(
          (m) => `ltrim(title) LIKE '[${m}]%'`,
        ).join(" OR ")}`,
      );
    });
  }

  /** Runs `fn` in a transaction; `writeLock` takes the write lock first (BEGIN IMMEDIATE). */
  private transaction(fn: () => void, writeLock = false): void {
    this.db.exec(writeLock ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * A repo's rows in `table`, as one string (two reads are equal when no row changed). A pull
   * request's `read_at` is bookkeeping, not data: a re-read of the same answer is no change.
   */
  private repoRows(table: RepoTable, repoId: RepoId): string {
    const rows = this.db
      .prepare(`SELECT * FROM ${table} WHERE repo_id = ? ORDER BY ${REPO_TABLES[table]}`)
      .all(repoId)
      .map(({ read_at: _readAt, ...data }) => data);
    return JSON.stringify(rows);
  }

  /** Runs `write` in one transaction; true when it changed any of the repo's rows in `table`. */
  private changed(table: RepoTable, repoId: RepoId, write: () => void): boolean {
    let changed = false;
    this.transaction(() => {
      const before = this.repoRows(table, repoId);
      write();
      changed = this.repoRows(table, repoId) !== before;
    });
    return changed;
  }

  /** Ordered snapshots: later observations never rewrite an earlier attempt. */
  runAttempts(
    runId: string,
  ): { id: number; runId: string; kind: string; at: number; data: Record<string, unknown> }[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM run_attempts WHERE run_id = ? OR run_id IN (SELECT run_id FROM reviews WHERE author_run_id = ?) ORDER BY id",
        )
        .all(runId, runId) as Row[]
    ).map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      kind: r.kind as string,
      at: r.at as number,
      data: JSON.parse(r.data as string) as Record<string, unknown>,
    }));
  }

  private appendAttempt(runId: string, kind: string, at: number, data: object): void {
    const encoded = JSON.stringify(data);
    const previous = this.db
      .prepare(
        "SELECT data, at FROM run_attempts WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
      )
      .get(runId, kind) as Row | undefined;
    // Wait completions are events: equal durations at different times are distinct waits.
    if (previous?.data === encoded && (kind !== "wait-end" || previous.at === at)) return;
    this.db
      .prepare("INSERT INTO run_attempts (run_id, kind, at, data) VALUES (?, ?, ?, ?)")
      .run(runId, kind, at, encoded);
  }

  /**
   * `folded`: the caller folded the run's transcript into `r`. The row is marked folded once that
   * happens to an ended run, and the mark is never cleared. A new row takes `r.loop`; an existing
   * row's loop is never rewritten here (`setRunLoop`).
   */
  upsertRun(r: Run, folded = false): void {
    this.appendAttempt(r.id, "run", r.endedAt ?? r.startedAt, {
      model: r.model,
      profile: r.profile ?? null,
      reviewId: r.reviewId ?? null,
      tokens: r.tokens,
      costUsd: r.costUsd,
      status: r.status,
    });
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, repo_id, seq, started_at, ended_at, status, session_id,
           model, branch, ticket, cost_usd, tokens, transcript_path, prs, summary, folded, loop,
           ticket_title, review_id, cli_version, profile, profile_hash, plan, vendor, latest_plan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_id = excluded.agent_id, repo_id = excluded.repo_id, seq = excluded.seq,
           started_at = excluded.started_at, ended_at = excluded.ended_at, status = excluded.status,
           session_id = excluded.session_id, model = excluded.model, branch = excluded.branch,
           ticket = excluded.ticket, cost_usd = excluded.cost_usd, tokens = excluded.tokens,
           transcript_path = excluded.transcript_path, prs = excluded.prs,
           summary = excluded.summary, folded = MAX(folded, excluded.folded),
           ticket_title = COALESCE(excluded.ticket_title, ticket_title),
           cli_version = COALESCE(excluded.cli_version, cli_version),
           latest_plan = COALESCE(excluded.latest_plan, latest_plan)`,
      )
      .run(
        r.id,
        r.agentId,
        r.repoId,
        r.seq,
        r.startedAt,
        r.endedAt,
        r.status,
        r.sessionId,
        r.model,
        r.branch,
        r.ticket,
        r.costUsd,
        r.tokens === null ? null : JSON.stringify(r.tokens),
        r.transcriptPath,
        JSON.stringify(r.prs),
        r.summary,
        folded && r.endedAt !== null ? 1 : 0,
        r.loop === null || r.loop === undefined ? null : JSON.stringify(r.loop),
        r.ticketTitle ?? null,
        r.reviewId ?? null,
        r.cliVersion ?? null,
        r.profile ? JSON.stringify({ profile: r.profile.profile, route: r.profile.route }) : null,
        r.profile?.hash ?? null,
        r.plan === undefined ? null : JSON.stringify(r.plan),
        r.vendor ?? "claude",
        r.latestPlan ?? null,
      );
  }

  /** Records the template profile chosen for a ticket; a later choice replaces it. */
  setProfileOverride(repoId: RepoId, issue: number, o: ProfileOverride, at: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO profile_overrides (repo_id, issue, profile, reason, by, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(repoId, issue, o.profile, o.reason, o.by, at);
  }

  profileOverride(repoId: RepoId, issue: number): ProfileOverride | null {
    const r = this.db
      .prepare("SELECT profile, reason, by FROM profile_overrides WHERE repo_id = ? AND issue = ?")
      .get(repoId, issue) as Row | undefined;
    return r
      ? {
          profile: r.profile as string,
          reason: r.reason as string,
          by: r.by as ProfileOverride["by"],
        }
      : null;
  }

  run(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  runs(agentId: AgentId, limit: number): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY started_at DESC, seq DESC LIMIT ?")
      .all(agentId, limit) as Row[];
    return rows.map(toRun);
  }

  /** Runs still open or ended at or after `since`, across seats and repos. */
  runsActiveSince(since: number): Run[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM runs WHERE ended_at IS NULL OR ended_at >= ? ORDER BY started_at, seq",
      )
      .all(since) as Row[];
    return rows.map(toRun);
  }

  /** Outstanding runs and ended runs with recorded PR merge steps for the away digest. */
  runsForAwayDigest(): Run[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM runs WHERE ended_at IS NULL OR json_extract(loop, '$.merging') IS NOT NULL ORDER BY started_at, seq",
      )
      .all() as Row[];
    return rows.map(toRun);
  }

  /**
   * The run the HUD shows for an agent: the one its seat holds when that is set and not ended
   * (a run woken from aside can be older than a run that ended meanwhile), else the newest.
   */
  seatRun(agentId: AgentId): Run | undefined {
    const heldId = this.seatSession(agentId)?.runId ?? null;
    if (heldId !== null) {
      const held = this.run(heldId);
      if (held !== null && held.endedAt === null && held.agentId === agentId) return held;
    }
    return this.runs(agentId, 1)[0];
  }

  /**
   * The runs a loop drives that may still need the engine: every one not yet ended, and those
   * that ended at or after `endedSince` with a loop that is not done, or is done with merge steps
   * recorded (the last of them may be owed). Oldest first.
   */
  loopRuns(endedSince: number): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE loop IS NOT NULL
           AND (ended_at IS NULL
             OR (ended_at >= ? AND (json_extract(loop, '$.phase') != 'done'
               OR json_extract(loop, '$.merging') IS NOT NULL)))
         ORDER BY started_at, seq`,
      )
      .all(endedSince) as Row[];
    return rows.map(toRun);
  }

  /** The runs that have not ended and are off their seat in review, oldest first. */
  asideRuns(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE ended_at IS NULL AND loop IS NOT NULL
           AND json_extract(loop, '$.aside') IS NOT NULL
         ORDER BY started_at, seq`,
      )
      .all() as Row[];
    return rows.map(toRun);
  }

  /** The tickets (`repo#n`) of the runs that have not ended. */
  activeTickets(): Set<string> {
    const rows = this.db
      .prepare(
        "SELECT ticket FROM runs WHERE ended_at IS NULL AND ticket IS NOT NULL AND review_id IS NULL",
      )
      .all() as Row[];
    return new Set(rows.map((r) => r.ticket as string));
  }

  /** Whether this hub has a run (ended or not) on `branch`. */
  hasRunOnBranch(repoId: RepoId, branch: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM runs WHERE repo_id = ? AND branch = ? AND review_id IS NULL LIMIT 1",
        )
        .get(repoId, branch) !== undefined
    );
  }

  /** Every run on the ticket, ended ones too; review runs do not count. */
  runsOnTicket(repoId: RepoId, ticket: string): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE repo_id = ? AND ticket = ? AND review_id IS NULL")
      .all(repoId, ticket) as Row[];
    return rows.map(toRun);
  }

  /** Whether a run is still going on the ticket (`repo#number`); a review run does not count. */
  hasLiveRunOnTicket(repoId: RepoId, ticket: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM runs WHERE repo_id = ? AND ticket = ? AND status = 'running'
             AND ended_at IS NULL AND review_id IS NULL LIMIT 1`,
        )
        .get(repoId, ticket) !== undefined
    );
  }

  /** Whether another run on the same ticket started after this one. */
  hasNewerRunOnTicket(run: Run): boolean {
    if (run.ticket === null) return false;
    return (
      this.db
        .prepare(
          `SELECT 1 FROM runs WHERE repo_id = ? AND ticket = ? AND started_at > ? AND id != ?
             AND review_id IS NULL`,
        )
        .get(run.repoId, run.ticket, run.startedAt, run.id) !== undefined
    );
  }

  /**
   * Every agent's runs that overlap [sinceMs, untilMs): started before `untilMs` and ended after
   * `sinceMs`, or with no end. A run with no end counts as lasting until now only while `running`,
   * and only when it started within MAX_OPEN_RUN_AGE_MS of `untilMs` (older ones are abandoned
   * rows; a run left `running` for longer than that also drops out of `pruneFoldState`'s keep-set);
   * otherwise (`unknown`) it lasts an instant and overlaps only if it started at or after
   * `sinceMs`. Newest first.
   */
  runsOverlapping(sinceMs: number, untilMs: number): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE started_at < ?
           AND (ended_at > ?
             OR (ended_at IS NULL AND status = ? AND started_at > ?)
             OR (ended_at IS NULL AND started_at >= ?))
         ORDER BY started_at DESC, seq DESC`,
      )
      .all(
        untilMs,
        sinceMs,
        "running" satisfies RunStatus,
        untilMs - MAX_OPEN_RUN_AGE_MS,
        sinceMs,
      ) as Row[];
    return rows.map(toRun);
  }

  /**
   * Ended runs started before `startedBefore` whose transcript has not been folded, newest first
   * (the backfill's queue).
   */
  runsToFold(limit: number, startedBefore: number): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE folded = 0 AND ended_at IS NOT NULL AND started_at < ?
         ORDER BY started_at DESC, seq DESC LIMIT ?`,
      )
      .all(startedBefore, limit) as Row[];
    return rows.map(toRun);
  }

  /**
   * Ended runs of `agentIds`, newest first, strictly after `after` in that order (null: from the
   * newest); the summary rewrite's queue. Ordered by start, then id.
   */
  endedRunsPage(
    agentIds: string[],
    after: { startedAt: number; id: string } | null,
    limit: number,
  ): Run[] {
    if (agentIds.length === 0) return [];
    const agents = agentIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE ended_at IS NOT NULL AND agent_id IN (${agents})
           AND (? IS NULL OR started_at < ? OR (started_at = ? AND id < ?))
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(
        ...agentIds,
        after === null ? null : 1,
        after?.startedAt ?? 0,
        after?.startedAt ?? 0,
        after?.id ?? "",
        limit,
      ) as Row[];
    return rows.map(toRun);
  }

  /**
   * Runs of `agentIds` with a ticket and no stored title, newest first, strictly after `after` in
   * that order (null: from the newest); the title fill's queue.
   */
  untitledRunsPage(
    agentIds: string[],
    after: { startedAt: number; id: string } | null,
    limit: number,
  ): Run[] {
    if (agentIds.length === 0) return [];
    const agents = agentIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE ticket IS NOT NULL AND ticket_title IS NULL
           AND agent_id IN (${agents})
           AND (? IS NULL OR started_at < ? OR (started_at = ? AND id < ?))
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(
        ...agentIds,
        after === null ? null : 1,
        after?.startedAt ?? 0,
        after?.startedAt ?? 0,
        after?.id ?? "",
        limit,
      ) as Row[];
    return rows.map(toRun);
  }

  /** Sets the title of every run of `ticket` in `repoId` that has none; returns how many it set. */
  setTicketTitle(repoId: string, ticket: string, title: string): number {
    const r = this.db
      .prepare(
        "UPDATE runs SET ticket_title = ? WHERE repo_id = ? AND ticket = ? AND ticket_title IS NULL",
      )
      .run(title, repoId, ticket);
    return Number(r.changes);
  }

  /** Rewrites only a run's summary (nothing else on its row). */
  setRunSummary(runId: string, summary: string): void {
    this.db.prepare("UPDATE runs SET summary = ? WHERE id = ?").run(summary, runId);
  }

  /** How many runs `runsToFold` has left before `startedBefore`. */
  countToFold(startedBefore: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE folded = 0 AND ended_at IS NOT NULL AND started_at < ?",
      )
      .get(startedBefore) as { n: number };
    return row.n;
  }

  setDigest(runId: string, d: RunDigest): void {
    this.db
      .prepare(
        `INSERT INTO run_digests (run_id, digest) VALUES (?, ?)
         ON CONFLICT(run_id) DO UPDATE SET digest = excluded.digest`,
      )
      .run(runId, JSON.stringify(d));
  }

  digest(runId: string): RunDigest | null {
    const row = this.db.prepare("SELECT digest FROM run_digests WHERE run_id = ?").get(runId) as
      | { digest: string }
      | undefined;
    return row ? parseDigest(row.digest) : null;
  }

  digests(runIds: string[]): Map<string, RunDigest> {
    const out = new Map<string, RunDigest>();
    for (let i = 0; i < runIds.length; i += DIGEST_BATCH) {
      const ids = runIds.slice(i, i + DIGEST_BATCH);
      const rows = this.db
        .prepare(
          `SELECT run_id, digest FROM run_digests WHERE run_id IN (${ids.map(() => "?").join(", ")})`,
        )
        .all(...ids) as { run_id: string; digest: string }[];
      for (const r of rows) out.set(r.run_id, parseDigest(r.digest));
    }
    return out;
  }

  /** Deletes the digests of runs that started before `olderThan` (the runs stay). */
  pruneDigests(olderThan: number): void {
    this.db
      .prepare("DELETE FROM run_digests WHERE run_id IN (SELECT id FROM runs WHERE started_at < ?)")
      .run(olderThan);
  }

  /** Records a state change; a second change of one agent in the same millisecond is dropped. */
  addAgentEvent(e: AgentEvent): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO agent_events (agent_id, at, from_state, to_state, text) VALUES (?, ?, ?, ?, ?)",
      )
      .run(e.agentId, e.at, e.from, e.to, e.text);
  }

  /** State changes at or after `since`, oldest first. */
  agentEvents(since: number): AgentEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_events WHERE at >= ? ORDER BY at, agent_id")
      .all(since) as Row[];
    return rows.map((r) => ({
      agentId: r.agent_id as AgentId,
      at: r.at as number,
      from: r.from_state as HudState,
      to: r.to_state as HudState,
      text: r.text as string,
    }));
  }

  /** Timeline sources include work already in progress at the window's left edge. */
  timelineSources(from: number, to: number) {
    const events = this.db
      .prepare(`SELECT agent_id, at, from_state, to_state FROM agent_events e WHERE at <= ?
      AND (at >= ? OR at = (SELECT MAX(at) FROM agent_events
        WHERE agent_id = e.agent_id AND at < ?)) ORDER BY at, agent_id`)
      .all(to, from, from) as Row[];
    const runs = this.db
      .prepare(`SELECT * FROM runs WHERE started_at <= ?
      AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at, seq`)
      .all(to, from) as Row[];
    const holds = this.db
      .prepare(`SELECT seat_id, started_at, ended_at FROM test_lock_runs
      WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`)
      .all(to, from) as { seat_id: string; started_at: number; ended_at: number | null }[];
    const reviews = this.db
      .prepare(`SELECT * FROM reviews WHERE started_at <= ?
      AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at, id`)
      .all(to, from) as Row[];
    return {
      events: events.map(
        (r): Omit<AgentEvent, "text"> => ({
          agentId: r.agent_id as string,
          at: r.at as number,
          from: r.from_state as HudState,
          to: r.to_state as HudState,
        }),
      ),
      runs: runs.map(toRun),
      holds: holds.map((r) => ({ agentId: r.seat_id, from: r.started_at, to: r.ended_at })),
      reviews: reviews.map(toReview),
    };
  }

  /** Recent state changes plus the state carried into the window, for each scoped seat. */
  overviewAgentEvents(agentIds: readonly string[], since: number, until: number): AgentEvent[] {
    const query = this.db.prepare(`SELECT * FROM agent_events
      WHERE agent_id = ? AND at >= COALESCE(
        (SELECT MAX(at) FROM agent_events WHERE agent_id = ? AND at < ?), ?)
        AND at <= ? ORDER BY at`);
    return agentIds.flatMap((id) =>
      (query.all(id, id, since, since, until) as Row[]).map((r) => ({
        agentId: id,
        at: r.at as number,
        from: r.from_state as HudState,
        to: r.to_state as HudState,
        text: r.text as string,
      })),
    );
  }

  latestMachineSample(until: number): MachineSample | null {
    const row = this.db
      .prepare("SELECT sample FROM machine_samples WHERE at <= ? ORDER BY at DESC LIMIT 1")
      .get(until) as { sample: string } | undefined;
    return row ? (JSON.parse(row.sample) as MachineSample) : null;
  }

  /** Records a card move; returns its id. */
  addBoardMove(m: Omit<BoardMove, "id">): number {
    const r = this.db
      .prepare(
        `INSERT INTO board_moves (run_id, repo_id, issue, board_column, state, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.runId, m.repoId, m.issue, m.column, m.state, m.detail, m.at);
    return Number(r.lastInsertRowid);
  }

  /** Settles a pending move as done or failed. */
  finishBoardMove(id: number, state: "done" | "failed", detail: string | null, at: number): void {
    this.db
      .prepare("UPDATE board_moves SET state = ?, detail = ?, at = ? WHERE id = ?")
      .run(state, detail, at, id);
  }

  /** The moves settled at or after `since` (a pending one is not yet news), oldest first. */
  boardMoves(since: number): BoardMove[] {
    const rows = this.db
      .prepare("SELECT * FROM board_moves WHERE at >= ? AND state != 'pending' ORDER BY at, id")
      .all(since) as Row[];
    return rows.map((r) => this.boardMoveOf(r));
  }

  /** Every move of the run's card, oldest first, pending ones too. */
  boardMovesOfRun(runId: string): BoardMove[] {
    const rows = this.db
      .prepare("SELECT * FROM board_moves WHERE run_id = ? ORDER BY id")
      .all(runId) as Row[];
    return rows.map((r) => this.boardMoveOf(r));
  }

  private boardMoveOf(r: Row): BoardMove {
    return {
      id: r.id as number,
      runId: r.run_id as string,
      repoId: r.repo_id as RepoId,
      issue: r.issue as number,
      column: r.board_column as MoveColumn | FlightMoveColumn,
      state: r.state as BoardMoveState,
      detail: r.detail as string | null,
      at: r.at as number,
    };
  }

  /** Each agent's state after its latest recorded change. */
  latestAgentStates(): Map<AgentId, HudState> {
    const rows = this.db
      .prepare(
        `SELECT agent_id, to_state FROM agent_events e
         WHERE at = (SELECT MAX(at) FROM agent_events WHERE agent_id = e.agent_id)`,
      )
      .all() as Row[];
    return new Map(rows.map((r) => [r.agent_id as AgentId, r.to_state as HudState]));
  }

  private historyNextTable = 0;

  /** Retain live work; expiry starts at completion, with bounded transactions and sweep cost. */
  async pruneHistory(now: number): Promise<void> {
    const day = 24 * 60 * 60_000;
    const endedRun = `r.ended_at IS NOT NULL
      AND COALESCE(json_extract(r.loop, '$.phase'), '') != 'parked'
      AND json_extract(r.loop, '$.aside') IS NULL
      AND NOT EXISTS (SELECT 1 FROM reviews v
        WHERE (v.author_run_id = r.id OR v.run_id = r.id)
          AND (v.ended_at IS NULL OR v.state IN ('queued', 'starting', 'running')))`;
    // Engine lines are claim keys. All runs remain, so their plan events remain too.
    const tables = [
      ["seat_lines", 7, "AND origin != 'engine'"],
      ["loop_events", 30, "AND key NOT LIKE '%:plan'"],
      ["run_evidence", 30, ""],
      ["review_findings", 30, ""],
    ] as const;
    let batches = 0;
    const start = this.historyNextTable;
    for (let offset = 0; offset < tables.length; offset++) {
      const index = (start + offset) % tables.length;
      const [table, days, extra] = tables[index];
      // Let other tables go first next time if this table consumes the sweep budget.
      this.historyNextTable = (index + 1) % tables.length;
      const findings = table === "review_findings";
      const condition = findings
        ? `EXISTS (SELECT 1 FROM reviews v WHERE v.id = review_findings.review_id
            AND v.ended_at < ? AND v.state IN ('reported', 'failed', 'superseded')
            AND (v.run_id IS NULL OR EXISTS
              (SELECT 1 FROM runs r WHERE r.id = v.run_id AND ${endedRun})))
          AND EXISTS (SELECT 1 FROM runs r
            WHERE r.id = review_findings.author_run_id AND r.ended_at < ? AND ${endedRun})`
        : `EXISTS (SELECT 1 FROM runs r WHERE r.id = ${table}.run_id
            AND r.ended_at < ? AND ${endedRun}) ${extra}`;
      const select = this.db.prepare(
        `SELECT rowid AS id FROM ${table} WHERE rowid > ? AND ${condition}
         ORDER BY rowid LIMIT ?`,
      );
      let lastId = 0;
      while (batches < HISTORY_SWEEP_MAX_BATCHES) {
        let ids: { id: number }[] = [];
        const cutoff = now - days * day;
        // A finding ages from both its review's end and its author run's end.
        const cutoffs = findings ? [cutoff, cutoff] : [cutoff];
        this.transaction(() => {
          ids = select.all(lastId, ...cutoffs, HISTORY_BATCH_ROWS) as { id: number }[];
          if (ids.length === 0) return;
          this.db
            .prepare(`DELETE FROM ${table} WHERE rowid IN (${ids.map(() => "?").join(",")})`)
            .run(...ids.map(({ id }) => id));
        });
        if (ids.length === 0) break;
        lastId = ids[ids.length - 1].id;
        batches++;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (batches === HISTORY_SWEEP_MAX_BATCHES) break;
    }
  }

  /** Deletes the state changes recorded before `olderThan`. */
  pruneAgentEvents(olderThan: number): void {
    this.db.prepare("DELETE FROM agent_events WHERE at < ?").run(olderThan);
  }

  addUsage(s: UsageSample): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO usage_samples (account_id, window, at, pct, reset_at, source) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(s.accountId, s.window, s.at, s.pct, s.resetAt, s.source);
  }

  usage(accountId: AccountId, window: "5h" | "7d", sinceMs: number): UsageSample[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM usage_samples WHERE account_id = ? AND window = ? AND at >= ? ORDER BY at ASC",
      )
      .all(accountId, window, sinceMs) as Row[];
    return rows.map(toSample);
  }

  /** The newest sample for an account and window, or null when there is none. */
  latestUsage(accountId: AccountId, window: "5h" | "7d"): UsageSample | null {
    const row = this.db
      .prepare(
        "SELECT * FROM usage_samples WHERE account_id = ? AND window = ? ORDER BY at DESC LIMIT 1",
      )
      .get(accountId, window) as Row | undefined;
    return row ? toSample(row) : null;
  }

  /** True when any stored row changed. */
  replaceEscalations(repoId: RepoId, e: Escalation[]): boolean {
    return this.changed("escalations", repoId, () => {
      this.db.prepare("DELETE FROM escalations WHERE repo_id = ?").run(repoId);
      const ins = this.db.prepare(
        `INSERT INTO escalations (id, repo_id, issue_number, title, kind, source, opened_at, url, question)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id, issue_number = excluded.issue_number,
           title = excluded.title, kind = excluded.kind, source = excluded.source,
           opened_at = excluded.opened_at, url = excluded.url, question = excluded.question`,
      );
      for (const x of e) {
        ins.run(
          x.id,
          repoId,
          x.issueNumber,
          x.title,
          x.kind,
          x.source,
          x.openedAt,
          x.url,
          x.question === null ? null : JSON.stringify(x.question),
        );
      }
    });
  }

  escalations(): Escalation[] {
    const rows = this.db
      .prepare("SELECT * FROM escalations ORDER BY opened_at ASC, id ASC")
      .all() as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      repoId: r.repo_id as string,
      issueNumber: r.issue_number as number,
      title: r.title as string,
      kind: r.kind as Escalation["kind"],
      source: r.source === "title" ? "title" : "label",
      openedAt: r.opened_at as number,
      url: r.url as string,
      question:
        r.question === null ? null : (JSON.parse(r.question as string) as Escalation["question"]),
    }));
  }

  /** True when any stored row changed. */
  replaceBoard(repoId: RepoId, items: BoardItem[]): boolean {
    return this.changed("board_items", repoId, () => {
      this.db.prepare("DELETE FROM board_items WHERE repo_id = ?").run(repoId);
      const ins = this.db.prepare(
        `INSERT INTO board_items (repo_id, issue_number, title, status, state, labels, priority,
           updated_at, url, stage, owner, parent, sub_done, sub_total, blocked_by, milestone, size,
           closed, priority_source, created_at, item_id, project_id, assignees, author)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, issue_number) DO UPDATE SET title = excluded.title,
           status = excluded.status, state = excluded.state, labels = excluded.labels,
           priority = excluded.priority, updated_at = excluded.updated_at, url = excluded.url,
           stage = excluded.stage, owner = excluded.owner, parent = excluded.parent,
           sub_done = excluded.sub_done, sub_total = excluded.sub_total,
           blocked_by = excluded.blocked_by, milestone = excluded.milestone,
           size = excluded.size, closed = excluded.closed,
           priority_source = excluded.priority_source, created_at = excluded.created_at,
           item_id = excluded.item_id, project_id = excluded.project_id,
           assignees = excluded.assignees, author = excluded.author`,
      );
      for (const i of items) {
        ins.run(
          repoId,
          i.issueNumber,
          i.title,
          i.status,
          i.state,
          JSON.stringify(i.labels),
          i.priority,
          i.updatedAt,
          i.url,
          i.stage,
          i.owner,
          i.parent,
          i.subIssues?.done ?? null,
          i.subIssues?.total ?? null,
          JSON.stringify(i.blockedBy),
          i.milestone,
          i.size,
          i.closed ? 1 : 0,
          i.prioritySource,
          i.createdAt,
          i.itemId,
          i.projectId,
          JSON.stringify(i.assignees ?? []),
          i.author ?? null,
        );
      }
    });
  }

  board(repoId: RepoId): BoardItem[] {
    const rows = this.db
      .prepare("SELECT * FROM board_items WHERE repo_id = ? ORDER BY issue_number ASC")
      .all(repoId) as Row[];
    return rows.map((r) => ({
      repoId: r.repo_id as string,
      issueNumber: r.issue_number as number,
      title: r.title as string,
      status: r.status as string,
      state: r.state as BoardItem["state"],
      labels: JSON.parse(r.labels as string) as string[],
      assignees: JSON.parse(r.assignees as string) as string[],
      ...(typeof r.author === "string" ? { author: r.author } : {}),
      priority: r.priority as string | null,
      updatedAt: r.updated_at as number,
      url: r.url as string,
      stage: r.stage as BoardItem["stage"],
      owner: r.owner as BoardItem["owner"],
      parent: r.parent as number | null,
      subIssues:
        r.sub_total === null ? null : { done: r.sub_done as number, total: r.sub_total as number },
      blockedBy: JSON.parse(r.blocked_by as string) as BoardItem["blockedBy"],
      milestone: r.milestone as string | null,
      size: r.size as string | null,
      closed: r.closed === 1,
      prioritySource: r.priority_source as BoardItem["prioritySource"],
      createdAt: r.created_at as number,
      itemId: r.item_id as string | null,
      projectId: r.project_id as string | null,
    }));
  }

  /**
   * Merges `prs` into the repo's rows (insert or update by number); nothing is deleted. True when
   * any stored row changed. `readAt` is when GitHub was read (our clock).
   */
  upsertPullRequests(repoId: RepoId, prs: PullRequestView[], readAt: number): boolean {
    return this.changed("pull_requests", repoId, () => this.writePullRequests(repoId, prs, readAt));
  }

  /** Replaces the repo's rows with `prs`. True when any stored row changed. */
  replacePullRequests(repoId: RepoId, prs: PullRequestView[], readAt: number): boolean {
    return this.changed("pull_requests", repoId, () => {
      this.db.prepare("DELETE FROM pull_requests WHERE repo_id = ?").run(repoId);
      this.writePullRequests(repoId, prs, readAt);
    });
  }

  /**
   * Replaces the repo's rows with a sweep's read, which began at `readAt` (our clock). A stored
   * row read after that (a poll got there while the sweep was still paging) is newer than the
   * sweep's copy and is kept, as is a row the sweep did not see that was read at or after it; GitHub's
   * `updatedAt` cannot tell, as it does not move when a PR's CI finishes. True when any stored
   * row changed.
   */
  sweepPullRequests(repoId: RepoId, prs: PullRequestView[], readAt: number): boolean {
    return this.changed("pull_requests", repoId, () => {
      const readAtOf = new Map(
        (
          this.db
            .prepare("SELECT number, read_at FROM pull_requests WHERE repo_id = ?")
            .all(repoId) as { number: number; read_at: number }[]
        ).map((r) => [r.number, r.read_at]),
      );
      const seen = new Set(prs.map((p) => p.number));
      const del = this.db.prepare("DELETE FROM pull_requests WHERE repo_id = ? AND number = ?");
      for (const [number, at] of readAtOf) {
        if (!seen.has(number) && at < readAt) del.run(repoId, number);
      }
      this.writePullRequests(
        repoId,
        prs.filter((p) => (readAtOf.get(p.number) ?? 0) <= readAt),
        readAt,
      );
    });
  }

  private writePullRequests(repoId: RepoId, prs: PullRequestView[], readAt: number): void {
    const ins = this.db.prepare(
      `INSERT INTO pull_requests (repo_id, number, title, url, branch, ticket, state, is_draft,
         review, ci, created_at, updated_at, merged_at, read_at, head_sha, mergeable, author,
         assignees, checks, closing_issues, merge_commit_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, number) DO UPDATE SET title = excluded.title, url = excluded.url,
         branch = excluded.branch, ticket = excluded.ticket, state = excluded.state,
         is_draft = excluded.is_draft, review = excluded.review, ci = excluded.ci,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         merged_at = excluded.merged_at, read_at = excluded.read_at,
         head_sha = excluded.head_sha, mergeable = excluded.mergeable, author = excluded.author,
         assignees = excluded.assignees, checks = excluded.checks,
         closing_issues = excluded.closing_issues, merge_commit_sha = excluded.merge_commit_sha, stale = 0`,
    );
    for (const p of prs) {
      const runs = this.db
        .prepare(
          "SELECT id FROM runs WHERE repo_id = ? AND (json_extract(loop, '$.prNumber') = ? OR id IN (SELECT author_run_id FROM reviews WHERE repo_id = ? AND pr_number = ?))",
        )
        .all(repoId, p.number, repoId, p.number) as Row[];
      for (const run of runs) {
        this.appendAttempt(run.id as string, "ci", readAt, {
          sha: p.headSha,
          state: p.ci,
          checks: p.checks ?? [],
        });
        if (p.mergedAt !== null)
          this.appendAttempt(run.id as string, "merge", p.mergedAt, {
            sha: p.headSha,
            mergeCommitSha: p.mergeCommitSha ?? null,
          });
      }
      ins.run(
        repoId,
        p.number,
        p.title,
        p.url,
        p.branch,
        p.ticket,
        p.state,
        p.isDraft ? 1 : 0,
        p.review,
        p.ci,
        p.createdAt,
        p.updatedAt,
        p.mergedAt,
        readAt,
        p.headSha,
        p.mergeable,
        p.author ?? null,
        JSON.stringify(p.assignees ?? []),
        JSON.stringify(p.checks ?? []),
        JSON.stringify(p.closingIssues ?? []),
        p.mergeCommitSha ?? null,
      );
    }
  }

  pullRequests(repoId: RepoId): PullRequestView[] {
    const rows = this.db
      .prepare("SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY number DESC")
      .all(repoId) as Row[];
    return this.pullRequestRows(rows);
  }

  overviewPullRequests(repoId: RepoId, since: number): PullRequestView[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM pull_requests WHERE repo_id = ? AND (state = 'open' OR merged_at >= ?) ORDER BY number DESC",
      )
      .all(repoId, since) as Row[];
    return this.pullRequestRows(rows);
  }

  /** Latest successful move into Ready, including moves before today's window. */
  overviewReadyMoves(repoId: RepoId): Map<number, number> {
    const rows = this.db
      .prepare(
        "SELECT issue, MAX(at) AS at FROM board_moves WHERE repo_id = ? AND board_column = 'Ready' AND state = 'done' GROUP BY issue",
      )
      .all(repoId) as { issue: number; at: number }[];
    return new Map(rows.map((r) => [r.issue, r.at]));
  }

  private pullRequestRows(rows: Row[]): PullRequestView[] {
    return rows.map((r) => ({
      repoId: r.repo_id as string,
      number: r.number as number,
      title: r.title as string,
      url: r.url as string,
      branch: r.branch as string,
      ticket: r.ticket as string | null,
      state: r.state as PullRequestView["state"],
      isDraft: r.is_draft === 1,
      review: r.review as PullRequestView["review"],
      ci: r.ci as PullRequestView["ci"],
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      mergedAt: r.merged_at as number | null,
      headSha: r.head_sha as string | null,
      mergeCommitSha: r.merge_commit_sha as string | null,
      mergeable: r.mergeable as PullRequestView["mergeable"],
      author: (r.author as string | null) ?? null,
      assignees: JSON.parse(r.assignees as string) as string[],
      checks: JSON.parse(r.checks as string) as PrCheck[],
      closingIssues: JSON.parse(r.closing_issues as string) as number[],
    }));
  }

  /** Marks the repo's stored PRs stale: a poll could not read them, so each row is its last good read. */
  markPullRequestsStale(repoId: RepoId): void {
    this.db.prepare("UPDATE pull_requests SET stale = 1 WHERE repo_id = ?").run(repoId);
  }

  /** The numbers of the repo's PRs whose latest read failed. */
  stalePullRequests(repoId: RepoId): Set<number> {
    const rows = this.db
      .prepare("SELECT number FROM pull_requests WHERE repo_id = ? AND stale = 1")
      .all(repoId) as { number: number }[];
    return new Set(rows.map((r) => r.number));
  }

  /** When the poll last read the PR (our clock), else null. */
  pullRequestReadAt(repoId: RepoId, number: number): number | null {
    const r = this.db
      .prepare("SELECT read_at FROM pull_requests WHERE repo_id = ? AND number = ?")
      .get(repoId, number) as { read_at: number } | undefined;
    return r ? r.read_at : null;
  }

  /** Replaces the repo's flow rows; an issue without a `doneAt` is not stored. */
  replaceFlow(repoId: RepoId, issues: FlowIssue[], prs: FlowPr[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM flow_issues WHERE repo_id = ?").run(repoId);
      this.db.prepare("DELETE FROM flow_prs WHERE repo_id = ?").run(repoId);
      const insIssue = this.db.prepare(
        "INSERT INTO flow_issues (repo_id, number, size, start_at, done_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const i of issues) {
        if (i.doneAt !== null) insIssue.run(repoId, i.number, i.size, i.startAt, i.doneAt);
      }
      const insPr = this.db.prepare(
        "INSERT INTO flow_prs (repo_id, number, merged_at, first_push_ci) VALUES (?, ?, ?, ?)",
      );
      for (const p of prs) insPr.run(repoId, p.number, p.mergedAt, p.firstPushCi);
    });
  }

  /** Issues done at or after `sinceMs`, across repos, oldest first. */
  flowIssues(sinceMs: number): FlowIssue[] {
    const rows = this.db
      .prepare("SELECT * FROM flow_issues WHERE done_at >= ? ORDER BY done_at ASC, repo_id, number")
      .all(sinceMs) as Row[];
    return rows.map((r) => ({
      repoId: r.repo_id as string,
      number: r.number as number,
      size: r.size as string | null,
      startAt: r.start_at as number | null,
      doneAt: r.done_at as number,
    }));
  }

  /** Latest successful Ready move before each merge, falling back to the collected flow start. */
  readyToMergedMinutes(repoId: RepoId, since: number): number[] {
    const rows = this.db
      .prepare(`
      SELECT p.merged_at, COALESCE(MAX(m.at), f.start_at) AS ready_at
      FROM pull_requests p
      LEFT JOIN board_moves m ON p.ticket = m.repo_id || '#' || m.issue
        AND m.board_column = 'Ready' AND m.state = 'done' AND m.at <= p.merged_at
      LEFT JOIN flow_issues f ON p.ticket = f.repo_id || '#' || f.number
      WHERE p.repo_id = ? AND p.state = 'merged' AND p.merged_at >= ?
      GROUP BY p.number, p.merged_at, f.start_at
      HAVING ready_at IS NOT NULL AND ready_at <= p.merged_at
    `)
      .all(repoId, since) as { merged_at: number; ready_at: number }[];
    return rows.map((r) => (r.merged_at - r.ready_at) / 60_000);
  }

  /** PRs merged at or after `sinceMs`, across repos, oldest first. */
  flowPrs(sinceMs: number): FlowPr[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM flow_prs WHERE merged_at >= ? ORDER BY merged_at ASC, repo_id, number",
      )
      .all(sinceMs) as Row[];
    return rows.map((r) => ({
      repoId: r.repo_id as string,
      number: r.number as number,
      mergedAt: r.merged_at as number,
      firstPushCi: r.first_push_ci as FlowPr["firstPushCi"],
    }));
  }

  /** Stores one machine sample and deletes those older than `MACHINE_RETENTION_MS` before it. */
  addMachineSample(s: MachineSample): void {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO machine_samples (at, sample, cpu_pct, mem_pct) VALUES (?, ?, ?, ?)",
        )
        .run(s.at, JSON.stringify(s), s.cpuPct, memPct(s));
      this.db.prepare("DELETE FROM machine_samples WHERE at < ?").run(s.at - MACHINE_RETENTION_MS);
    });
  }

  /** Stored machine samples with `at >= sinceMs`, oldest first. */
  machineSamples(sinceMs: number): MachineSample[] {
    const rows = this.db
      .prepare("SELECT sample FROM machine_samples WHERE at >= ? ORDER BY at ASC")
      .all(sinceMs) as { sample: string }[];
    return rows.map((r) => JSON.parse(r.sample) as MachineSample);
  }

  /**
   * Machine samples in [sinceMs, untilMs] averaged into at most `points` buckets of `bucketMs`
   * counted from `sinceMs` (the last bucket takes any remainder), oldest first. `at` is the
   * bucket's latest sample; a mean is null when no sample in the bucket measured it. The
   * aggregation runs in SQL over the cpu_pct and mem_pct columns, so a 7-day range returns
   * `points` rows and parses no JSON.
   */
  machineBuckets(
    sinceMs: number,
    untilMs: number,
    bucketMs: number,
    points: number,
  ): Telemetry["machine"] {
    const rows = this.db
      .prepare(
        `SELECT MAX(at) AS at, AVG(cpu_pct) AS cpu, AVG(mem_pct) AS mem FROM machine_samples
         WHERE at >= ? AND at <= ?
         GROUP BY MIN(?, CAST((at - ?) / ? AS INTEGER)) ORDER BY 1 ASC`,
      )
      .all(sinceMs, untilMs, points - 1, sinceMs, bucketMs) as {
      at: number;
      cpu: number | null;
      mem: number | null;
    }[];
    return rows.map((r) => ({ at: r.at, cpuPct: r.cpu, memPct: r.mem }));
  }

  /** Acknowledges attention item keys at `at` (a re-ack moves the time; absence is kept). */
  ack(keys: string[], at: number): void {
    this.transaction(() => {
      const ins = this.db.prepare(
        `INSERT INTO acks (key, at, absent_since) VALUES (?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET at = excluded.at`,
      );
      for (const k of keys) ins.run(k, at);
    });
  }

  /** Every ack: key → when it was acknowledged. */
  acks(): Map<string, number> {
    const rows = this.db.prepare("SELECT key, at FROM acks").all() as { key: string; at: number }[];
    return new Map(rows.map((r) => [r.key, r.at]));
  }

  /**
   * `present`: the keys of every current attention item. Present keys lose their absence, newly
   * absent ones are marked absent since `now`, and acks absent since before `now - ACK_ABSENT_MS`
   * are deleted. An ack's own age never matters. Called by the scheduler, never from a GET.
   */
  sweepAcks(present: Set<string>, now: number): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT key, absent_since FROM acks").all() as {
        key: string;
        absent_since: number | null;
      }[];
      const clear = this.db.prepare("UPDATE acks SET absent_since = NULL WHERE key = ?");
      const mark = this.db.prepare("UPDATE acks SET absent_since = ? WHERE key = ?");
      const del = this.db.prepare("DELETE FROM acks WHERE key = ?");
      for (const r of rows) {
        if (present.has(r.key)) {
          if (r.absent_since !== null) clear.run(r.key);
        } else if (r.absent_since === null) {
          mark.run(now, r.key);
        } else if (r.absent_since < now - ACK_ABSENT_MS) {
          del.run(r.key);
        }
      }
    });
  }

  /**
   * Merges the unread threads `rows` into the table: a new row is first seen `now`; an existing one
   * is unread again, keeping `first_seen_at` and its handled fields. `complete` (`rows` is the whole
   * unread list): every other unread row is read on GitHub, and closes as `read` if it was open.
   * With a source, completeness applies only to that source. True when any row changed.
   */
  upsertNotifications(
    rows: NotificationRead[],
    complete: boolean,
    now: number,
    source?: "github" | "teams",
  ): boolean {
    let changed = false;
    this.transaction(() => {
      const before = this.notificationsJson();
      const ins = this.db.prepare(
        `INSERT INTO notifications (id, repo_id, subject_type, title, number, reason, url, author,
           snippet, updated_at, last_read_at, unread, first_seen_at, source_content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id,
           subject_type = excluded.subject_type, title = excluded.title, number = excluded.number,
           reason = excluded.reason, url = excluded.url, author = excluded.author,
           snippet = excluded.snippet, updated_at = excluded.updated_at,
           last_read_at = excluded.last_read_at, unread = 1, source_content = excluded.source_content`,
      );
      for (const n of rows) {
        ins.run(
          n.id,
          n.repoId,
          n.subjectType,
          n.title,
          n.number,
          n.reason,
          n.url,
          n.author,
          n.snippet,
          n.updatedAt,
          n.lastReadAt,
          now,
          JSON.stringify({ message: n.message, history: n.history }),
        );
      }
      if (complete) {
        const seen = new Set(rows.map((n) => n.id));
        const close = this.db.prepare(
          `UPDATE notifications SET unread = 0,
             handled_at = CASE WHEN handled_through IS NULL OR updated_at > handled_through THEN ? ELSE handled_at END,
             handled_how = CASE WHEN handled_through IS NULL OR updated_at > handled_through THEN 'read' ELSE handled_how END,
             handled_through = CASE WHEN handled_through IS NULL OR updated_at > handled_through THEN updated_at ELSE handled_through END
           WHERE id = ?`,
        );
        const unread = this.db.prepare("SELECT id FROM notifications WHERE unread = 1").all() as {
          id: string;
        }[];
        for (const { id } of unread)
          if (
            !seen.has(id) &&
            (source === undefined ||
              (this.notification(id)?.message?.source.kind ?? "github") === source)
          )
            close.run(now, id);
      }
      changed = this.notificationsJson() !== before;
    });
    return changed;
  }

  private notificationsJson(): string {
    return JSON.stringify(this.db.prepare("SELECT * FROM notifications ORDER BY id").all());
  }

  /** Every stored thread, newest first. */
  notifications(): NotificationRow[] {
    const rows = this.db
      .prepare("SELECT * FROM notifications ORDER BY updated_at DESC, id DESC")
      .all() as Row[];
    return rows.map(notificationRow);
  }

  notification(id: string): NotificationRow | null {
    const r = this.db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r === undefined ? null : notificationRow(r);
  }

  /**
   * Closes the thread as handled at `at`, when it is open and still at `updatedAt` (a newer comment
   * is never hidden by an old key). `handled_through` records the version handled, so a comment
   * that lands before `at` but after `updatedAt` still reopens it. True when it did.
   */
  markNotificationHandled(
    id: string,
    updatedAt: number,
    how: Exclude<NotificationRow["handledHow"], null>,
    at: number,
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE notifications SET handled_at = ?, handled_how = ?, handled_through = ?
         WHERE id = ? AND updated_at = ? AND unread = 1
           AND (handled_through IS NULL OR updated_at > handled_through)`,
      )
      .run(at, how, updatedAt, id, updatedAt);
    return Number(r.changes) > 0;
  }

  /**
   * Deletes the threads closed before `before` that GitHub no longer lists as unread. A thread
   * handled here but still unread on GitHub stays, or the next read would bring it back.
   */
  pruneNotifications(before: number): void {
    this.db
      .prepare(
        `DELETE FROM notifications
         WHERE unread = 0 AND handled_at IS NOT NULL AND handled_at < ? AND updated_at <= handled_through`,
      )
      .run(before);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  pruneCollaborators(before: number): void {
    this.db
      .prepare(`DELETE FROM settings WHERE key LIKE 'collaborator:%'
      AND CASE WHEN json_valid(value) THEN coalesce(json_extract(value, '$.at'), 0) < ? ELSE 1 END`)
      .run(before);
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  getOffset(path: string): number {
    const row = this.db.prepare("SELECT offset FROM file_offsets WHERE path = ?").get(path) as
      | { offset: number }
      | undefined;
    return row?.offset ?? 0;
  }

  setOffset(path: string, offset: number): void {
    this.db
      .prepare(
        "INSERT INTO file_offsets (path, offset) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset",
      )
      .run(path, offset);
  }

  /** Records a collector's status; `last_ok_at` moves on success and is kept through failures. */
  setStatus(collector: string, ok: boolean, error: string | null): void {
    const at = Date.now();
    this.db
      .prepare(
        `INSERT INTO collector_status (collector, ok, error, at, last_ok_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(collector) DO UPDATE SET ok = excluded.ok, error = excluded.error,
           at = excluded.at, last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at)`,
      )
      .run(collector, ok ? 1 : 0, error, at, ok ? at : null);
  }

  status(): HealthRow[] {
    const rows = this.db
      .prepare("SELECT * FROM collector_status ORDER BY collector ASC")
      .all() as Row[];
    return rows.map((r) => ({
      collector: r.collector as string,
      ok: r.ok === 1,
      error: r.error as string | null,
      at: r.at as number,
      lastOkAt: r.last_ok_at as number | null,
    }));
  }

  /** Sets the run's loop state (null clears it). */
  setRunLoop(runId: string, loop: RunLoop | null, at = Date.now()): void {
    const previous = this.run(runId)?.loop;
    if (JSON.stringify(previous) !== JSON.stringify(loop)) {
      this.appendAttempt(runId, "loop", at, loop ?? { phase: null });
      if (
        previous &&
        (previous.phase === "ci" || previous.phase === "review" || previous.awaitingFlight)
      ) {
        if (previous.phase !== loop?.phase || previous.awaitingFlight !== loop?.awaitingFlight) {
          const start = this.db
            .prepare(
              "SELECT at FROM run_attempts WHERE run_id = ? AND kind = 'wait' ORDER BY id DESC LIMIT 1",
            )
            .get(runId) as Row | undefined;
          this.appendAttempt(runId, "wait-end", at, {
            on: previous.awaitingFlight ?? previous.phase,
            durationMs: start ? Math.max(0, at - (start.at as number)) : null,
          });
        }
      }
      if (
        loop &&
        (loop.phase === "ci" || loop.phase === "review" || loop.awaitingFlight) &&
        (previous?.phase !== loop.phase || previous?.awaitingFlight !== loop.awaitingFlight)
      ) {
        this.appendAttempt(runId, "wait", at, { on: loop.awaitingFlight ?? loop.phase, since: at });
      }
    }
    this.db
      .prepare("UPDATE runs SET loop = ? WHERE id = ?")
      .run(loop === null ? null : JSON.stringify(loop), runId);
    if (loop?.phase === "done") this.clearNoReportNotes(runId, at, true);
  }

  /** Ends the run: when, with what status, and who ended it. */
  setRunEnded(
    runId: string,
    at: number,
    status: RunStatus,
    endedBy: NonNullable<Run["endedBy"]>,
  ): void {
    this.db
      .prepare("UPDATE runs SET ended_at = ?, status = ?, ended_by = ? WHERE id = ?")
      .run(at, status, endedBy, runId);
  }

  /** Exit diagnostics are controller-owned; transcript upserts never overwrite them. */
  recordNoReport(runId: string, record: NonNullable<Run["noReport"]>, note: NoteInput): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE runs SET no_report = ? WHERE id = ?")
        .run(JSON.stringify(record), runId);
      this.raiseNote(note);
    });
  }

  /** A report resolves earlier failures on this ticket; done resolves the whole ticket. */
  private clearNoReportNotes(runId: string, at: number, done = false): void {
    this.db
      .prepare(`
      UPDATE attention_notes SET cleared_at = ?
      WHERE cleared_at IS NULL AND key IN (
        SELECT 'no_report:' || old.id FROM runs old JOIN runs fresh ON fresh.id = ?
        WHERE old.id = fresh.id OR (
          old.repo_id = fresh.repo_id AND old.ticket = fresh.ticket
          AND (? OR old.started_at <= fresh.started_at)
        )
      )
    `)
      .run(at, runId, done ? 1 : 0);
  }

  /** Appends a note the run's seat reported; returns its id. */
  addEvidence(runId: string, note: string, at: number): number {
    const r = this.db
      .prepare("INSERT INTO run_evidence (run_id, note, at) VALUES (?, ?, ?)")
      .run(runId, note, at);
    this.clearNoReportNotes(runId, at);
    return Number(r.lastInsertRowid);
  }

  latestEvidence(runId: string): Evidence | null {
    const r = this.db
      .prepare("SELECT * FROM run_evidence WHERE run_id = ? ORDER BY id DESC LIMIT 1")
      .get(runId) as Row | undefined;
    return r
      ? {
          id: r.id as number,
          runId: r.run_id as string,
          note: r.note as string,
          at: r.at as number,
        }
      : null;
  }

  /** Every note the run's seat reported, oldest first. */
  evidenceNotes(runId: string): Evidence[] {
    const rows = this.db
      .prepare("SELECT * FROM run_evidence WHERE run_id = ? ORDER BY id")
      .all(runId) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      note: r.note as string,
      at: r.at as number,
    }));
  }

  /** Queues a review; its id, or null when the (run, sha, epoch, attempt) key already exists. */
  requestReview(r: ReviewRequest): number | null {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO reviews (author_run_id, repo_id, seat_id, pr_number, sha, epoch,
           attempt, round, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(r.authorRunId, r.repoId, r.seatId, r.prNumber, r.sha, r.epoch, r.attempt, r.round, r.at);
    if (res.changes === 1)
      this.appendAttempt(r.authorRunId, "review", r.at, {
        ...r,
        id: Number(res.lastInsertRowid),
        state: "queued",
      });
    return res.changes === 1 ? Number(res.lastInsertRowid) : null;
  }

  review(id: number): ReviewRow | null {
    const row = this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as Row | undefined;
    return row ? toReview(row) : null;
  }

  reviewsOfRun(authorRunId: string): ReviewRow[] {
    const rows = this.db
      .prepare("SELECT * FROM reviews WHERE author_run_id = ? ORDER BY id")
      .all(authorRunId) as Row[];
    return rows.map(toReview);
  }

  /** The latest review of a PR that has reported, else null. */
  latestReportedReview(repoId: string, prNumber: number): ReviewRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM reviews WHERE repo_id = ? AND pr_number = ? AND state = 'reported'
         ORDER BY ended_at DESC, id DESC LIMIT 1`,
      )
      .get(repoId, prNumber) as Row | undefined;
    return row ? toReview(row) : null;
  }

  /** The review the run (a review run) performs, else null. */
  reviewOfRun(reviewRunId: string): ReviewRow | null {
    const row = this.db.prepare("SELECT * FROM reviews WHERE run_id = ?").get(reviewRunId) as
      | Row
      | undefined;
    return row ? toReview(row) : null;
  }

  reviewsIn(
    states: readonly ReviewState[],
    window?: { repo: string; since: number; until: number },
  ): ReviewRow[] {
    if (states.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM reviews WHERE state IN (${states.map(() => "?").join(", ")})
         ${window ? "AND repo_id = ? AND ended_at >= ? AND ended_at <= ?" : ""}
         ORDER BY created_at, id`,
      )
      .all(...states, ...(window ? [window.repo, window.since, window.until] : [])) as Row[];
    return rows.map(toReview);
  }

  /** Moves a review from one of `from` to `to`; true only when exactly one row changed. */
  setReviewState(
    id: number,
    from: readonly ReviewState[],
    to: ReviewState,
    patch: { at: number; runId?: string; failure?: string },
  ): boolean {
    if (from.length === 0) return false;
    const ended = {
      sql: "ended_at = ?, failure = COALESCE(?, failure)",
      args: [patch.at, patch.failure ?? null],
    };
    const sets: Record<ReviewState, { sql: string; args: SQLInputValue[] }> = {
      queued: { sql: "started_at = NULL", args: [] },
      starting: { sql: "started_at = ?", args: [patch.at] },
      running: {
        sql: "run_id = ?, started_at = COALESCE(started_at, ?)",
        args: [patch.runId ?? null, patch.at],
      },
      reported: ended,
      failed: ended,
      superseded: ended,
    };
    const set = sets[to];
    const r = this.db
      .prepare(
        `UPDATE reviews SET state = ?, ${set.sql}
         WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})`,
      )
      .run(to, ...set.args, id, ...from);
    if (r.changes === 1) {
      const review = this.review(id);
      if (review) this.appendAttempt(review.authorRunId, "review", patch.at, review);
    }
    return r.changes === 1;
  }

  /**
   * Records the review run's findings and verdict, once: only a `running` review tied to `runId`
   * takes them. False (and nothing written) otherwise.
   */
  recordFindings(
    reviewId: number,
    runId: string,
    r: { verdict: ReviewVerdict; summary: string; findings: ReviewFinding[]; at: number },
  ): boolean {
    const isBlocking = (f: ReviewFinding) => BLOCKING_SEVERITIES.includes(f.severity);
    const blocking = r.findings.filter(isBlocking).length;
    let recorded = false;
    this.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE reviews SET state = 'reported', verdict = ?, summary = ?, blocking = ?, minor = ?,
             ended_at = ?
           WHERE id = ? AND state = 'running' AND run_id = ?`,
        )
        .run(
          JSON.stringify(r.verdict),
          r.summary,
          blocking,
          r.findings.length - blocking,
          r.at,
          reviewId,
          runId,
        );
      if (res.changes !== 1) return;
      const author = (
        this.db.prepare("SELECT author_run_id FROM reviews WHERE id = ?").get(reviewId) as Row
      ).author_run_id as string;
      const insert = this.db.prepare(
        `INSERT INTO review_findings (review_id, author_run_id, pos, severity, file, line, summary,
           scenario, fix, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      r.findings.forEach((f, pos) => {
        insert.run(
          reviewId,
          author,
          pos,
          f.severity,
          f.file,
          f.line,
          f.summary,
          f.scenario,
          f.fix,
          isBlocking(f) ? "open" : "logged",
        );
      });
      this.appendAttempt(author, "review", r.at, {
        ...this.review(reviewId),
        findings: r.findings,
      });
      this.clearNoReportNotes(runId, r.at);
      recorded = true;
    }, true);
    return recorded;
  }

  findingsOf(reviewId: number): StoredFinding[] {
    const rows = this.db
      .prepare("SELECT * FROM review_findings WHERE review_id = ? ORDER BY pos")
      .all(reviewId) as Row[];
    return rows.map((r) => ({
      pos: r.pos as number,
      severity: r.severity as StoredFinding["severity"],
      file: r.file as string,
      line: r.line as number,
      summary: r.summary as string,
      scenario: r.scenario as string,
      fix: r.fix as string,
      state: r.state as StoredFinding["state"],
    }));
  }

  /** The run that performs the review, else null. */
  runOfReview(reviewId: number): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE review_id = ?").get(reviewId) as
      | Row
      | undefined;
    return row ? toRun(row) : null;
  }

  /** Reviews whose run has not ended although the review no longer needs it. */
  reviewsWithLiveRun(): ReviewRow[] {
    const rows = this.db
      .prepare(
        `SELECT reviews.* FROM reviews JOIN runs ON runs.id = reviews.run_id
         WHERE runs.ended_at IS NULL AND reviews.state NOT IN ('starting', 'running')
         ORDER BY reviews.id`,
      )
      .all() as Row[];
    return rows.map(toReview);
  }

  evidenceCount(runId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM run_evidence WHERE run_id = ?")
      .get(runId) as { n: number };
    return r.n;
  }

  /** Records a line under `key`; false (and nothing written) when the key is already there. */
  claimLine(key: string, line: SeatLine): boolean {
    let text = line.text;
    if (
      line.origin === "engine" &&
      key.startsWith(wakeKeyPrefix(line.runId)) &&
      text.startsWith(FLIGHT_WAKE_HEAD)
    ) {
      text = compactFlightWake(text);
    }
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO seat_lines (key, run_id, seat_id, origin, text, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(key, line.runId, line.seatId, line.origin, text, line.at);
    return r.changes === 1;
  }

  /** Frees a key, so its line can be claimed (and sent) again. */
  dropLine(key: string): void {
    this.db.prepare("DELETE FROM seat_lines WHERE key = ?").run(key);
  }

  /** The run's claimed line keys, each with the time it was claimed. */
  claimedKeys(runId: string): Record<string, number> {
    const rows = this.db.prepare("SELECT key, at FROM seat_lines WHERE run_id = ?").all(runId) as {
      key: string;
      at: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.at]));
  }

  /** When the engine last sent the run a line, else null. */
  lastEngineLineAt(runId: string): number | null {
    const r = this.db
      .prepare("SELECT MAX(at) AS at FROM seat_lines WHERE run_id = ? AND origin = ?")
      .get(runId, "engine" satisfies SeatLineOrigin) as { at: number | null };
    return r.at;
  }

  /** Records a loop event; false when its key is already recorded. */
  addLoopEvent(key: string, runId: string, text: string, at: number): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO loop_events (key, run_id, text, at) VALUES (?, ?, ?, ?)")
      .run(key, runId, text, at);
    if (r.changes === 1 && key === `${runId}:plan`) this.clearNoReportNotes(runId, at);
    return r.changes === 1;
  }

  /** The latest report_plan record for a ticket, attributed to the reporting run's seat. */
  ticketPlan(repoId: RepoId, ref: string): { by: AgentId; at: number; ref: string } | null {
    const row = this.db
      .prepare(
        `SELECT r.agent_id, e.at FROM loop_events e JOIN runs r ON r.id = e.run_id
         WHERE e.key = r.id || ':plan' AND r.repo_id = ? AND r.ticket = ?
         ORDER BY e.at DESC, e.key DESC LIMIT 1`,
      )
      .get(repoId, ref) as Row | undefined;
    return row ? { by: row.agent_id as AgentId, at: row.at as number, ref } : null;
  }

  /** Whether a `:plan` loop event exists for the run or any run on the same repo and ticket. */
  planLanded(run: Run): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM loop_events e JOIN runs r ON r.id = e.run_id
           WHERE e.key = ? OR (e.key LIKE '%:plan' AND r.repo_id = ? AND r.ticket = ?) LIMIT 1`,
        )
        .get(`${run.id}:plan`, run.repoId, run.ticket) !== undefined
    );
  }

  /** The run's loop events, oldest first. */
  loopEventsOfRun(runId: string): LoopEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM loop_events WHERE run_id = ? ORDER BY at, key")
      .all(runId) as Row[];
    return rows.map((r) => ({
      key: r.key as string,
      runId: r.run_id as string,
      text: r.text as string,
      at: r.at as number,
    }));
  }

  /** Records a hand-off whole up to COMMS_TEXT_MAX, then marks the stored copy's cut. */
  addComms(row: CommsRow): void {
    const chars = Array.from(row.text);
    const text =
      chars.length > COMMS_TEXT_MAX
        ? `${chars.slice(0, COMMS_TEXT_MAX).join("")}${commsCutMarker(COMMS_TEXT_MAX, chars.length)}`
        : row.text;
    this.db
      .prepare("INSERT INTO comms (at, from_id, to_id, ticket, text) VALUES (?, ?, ?, ?, ?)")
      .run(row.at, row.from, row.to, row.ticket, text);
  }

  /** The hand-offs at or after `since`, oldest first. */
  comms(since: number): CommsRow[] {
    const rows = this.db
      .prepare("SELECT * FROM comms WHERE at >= ? ORDER BY at, id")
      .all(since) as Row[];
    return rows.map((r) => ({
      at: r.at as number,
      from: r.from_id as string,
      to: r.to_id as string,
      ticket: r.ticket as string | null,
      text: r.text as string,
    }));
  }

  /** How many hand-offs `from` sent `to` at or after `since`. */
  commsCountTo(from: string, to: string, since: number): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM comms WHERE from_id = ? AND to_id = ? AND at >= ?")
      .get(from, to, since) as { n: number };
    return r.n;
  }

  /** Stable stored message IDs for one thread, in insertion order. */
  threadComms(id: string, after = 0): (CommsRow & { id: string })[] {
    const rows = this.db
      .prepare(`SELECT * FROM comms WHERE id IN (
          SELECT id FROM (SELECT id FROM comms WHERE from_id = ? AND id > ? ORDER BY id DESC LIMIT ?)
          UNION
          SELECT id FROM (SELECT id FROM comms WHERE to_id = ? AND id > ? ORDER BY id DESC LIMIT ?)
        ) ORDER BY id DESC LIMIT ?`)
      .all(
        id,
        after,
        THREAD_COMMS_LIMIT,
        id,
        after,
        THREAD_COMMS_LIMIT,
        THREAD_COMMS_LIMIT,
      ) as Row[];
    return rows.reverse().map((r) => ({
      id: `comms:${r.id}`,
      at: r.at as number,
      from: r.from_id as string,
      to: r.to_id as string,
      ticket: r.ticket as string | null,
      text: r.text as string,
    }));
  }

  /** Prompt metadata remains available even after its body has been read. */
  threadPrompt(id: string): { id: string; at: number } | undefined {
    const row = this.db
      .prepare(
        "SELECT id, at FROM comms WHERE from_id = ? AND to_id = ? ORDER BY at DESC, id DESC LIMIT 1",
      )
      .get(COMMS_CAPCOM, id) as { id: number; at: number } | undefined;
    return row && { id: `comms:${row.id}`, at: row.at };
  }

  /** Progress evidence does not need message bodies. */
  commsEvidence(since: number): Pick<CommsRow, "at" | "from" | "ticket">[] {
    return this.db
      .prepare('SELECT at, from_id AS "from", ticket FROM comms WHERE at >= ? ORDER BY at, id')
      .all(since) as Pick<CommsRow, "at" | "from" | "ticket">[];
  }

  threadReadCursors(id: string): Map<string, { offset: number; block: number }> {
    const rows = this.db.prepare("SELECT * FROM comms_reads WHERE thread_id = ?").all(id) as Row[];
    return new Map(
      rows.map((r) => [
        r.source_id as string,
        { offset: r.offset as number, block: r.block as number },
      ]),
    );
  }

  /** Validates ownership without re-reading a transcript window that may have moved on. */
  threadOwnsMessage(id: string, messageId: string): boolean {
    const position = commsPosition(messageId);
    if (!position) return false;
    if (position.source === "comms") {
      return (
        this.db
          .prepare("SELECT 1 FROM comms WHERE id = ? AND (from_id = ? OR to_id = ?)")
          .get(position.offset, id, id) !== undefined
      );
    }
    return this.run(position.source.slice("stream:".length))?.agentId === id;
  }

  /** Advance only through the opened snapshot, atomically; stale reads never move backwards. */
  markThreadRead(id: string, messageIds: string[]): void {
    this.transaction(() => {
      const update =
        this.db.prepare(`INSERT INTO comms_reads (thread_id, source_id, offset, block) VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id, source_id) DO UPDATE SET offset = excluded.offset, block = excluded.block
        WHERE excluded.offset > comms_reads.offset OR (excluded.offset = comms_reads.offset AND excluded.block > comms_reads.block)`);
      for (const messageId of messageIds) {
        const p = commsPosition(messageId);
        if (p) update.run(id, p.source, p.offset, p.block);
      }
    });
  }

  /** Records a hub event (a line on the Activity page). */
  addHubEvent(text: string, at: number): void {
    this.db.prepare("INSERT OR IGNORE INTO hub_events (at, text) VALUES (?, ?)").run(at, text);
  }

  /** The hub events at or after `since`, oldest first. */
  hubEvents(since: number): { at: number; text: string }[] {
    const rows = this.db
      .prepare("SELECT at, text FROM hub_events WHERE at >= ? ORDER BY at")
      .all(since) as Row[];
    return rows.map((r) => ({ at: r.at as number, text: r.text as string }));
  }

  /** The loop events at or after `since`, oldest first, optionally scoped to a repo. */
  loopEvents(since: number, repoId?: RepoId): LoopEvent[] {
    const rows = (
      repoId === undefined
        ? this.db.prepare("SELECT * FROM loop_events WHERE at >= ? ORDER BY at, key").all(since)
        : this.db
            .prepare(`SELECT e.* FROM loop_events e JOIN runs r ON r.id = e.run_id
          WHERE e.at >= ? AND r.repo_id = ? ORDER BY e.at, e.key`)
            .all(since, repoId)
    ) as Row[];
    return rows.map((r) => ({
      key: r.key as string,
      runId: r.run_id as string,
      text: r.text as string,
      at: r.at as number,
    }));
  }

  /**
   * Replaces the seat's untaken items with `items`, in order, after any taken row. An issue the
   * seat already holds, or that another seat has queued, is skipped.
   */
  replaceQueue(seatId: string, items: { repoId: RepoId; issue: number }[]): void {
    this.replaceQueues([{ seatId, items }]);
  }

  /**
   * One transaction: deletes every listed seat's untaken rows, then queues each seat's items as
   * `replaceQueue` does (after its taken row; skipping an issue it holds or any other seat has
   * queued).
   */
  replaceQueues(queues: { seatId: string; items: { repoId: RepoId; issue: number }[] }[]): void {
    this.transaction(() => {
      const del = this.db.prepare("DELETE FROM queues WHERE seat_id = ? AND taken_at IS NULL");
      for (const q of queues) del.run(q.seatId);
      const queuedElsewhere = this.db.prepare(
        "SELECT 1 FROM queues WHERE repo_id = ? AND issue = ? AND seat_id != ?",
      );
      const ins = this.db.prepare(
        "INSERT INTO queues (seat_id, pos, repo_id, issue, taken_at) VALUES (?, ?, ?, ?, NULL)",
      );
      for (const { seatId, items } of queues) {
        const kept = this.queue(seatId);
        const held = new Set(kept.map((q) => `${q.repoId}#${q.issue}`));
        let pos = kept.reduce((max, q) => Math.max(max, q.pos), -1) + 1;
        for (const i of items) {
          const ref = `${i.repoId}#${i.issue}`;
          if (held.has(ref) || queuedElsewhere.get(i.repoId, i.issue, seatId)) continue;
          held.add(ref);
          ins.run(seatId, pos++, i.repoId, i.issue);
        }
      }
    }, true);
  }

  /** The seat's queue in order, taken row first. */
  queue(seatId: string): QueueRow[] {
    const rows = this.db
      .prepare("SELECT * FROM queues WHERE seat_id = ? ORDER BY pos")
      .all(seatId) as Row[];
    return rows.map(queueRow);
  }

  /**
   * Takes the head of the seat's queue, stamped `at`; null when the queue is empty or the seat
   * already holds a row. Under the write lock, so two processes are granted one between them.
   * `between` is a test seam: it runs after the head is read and before it is stamped.
   */
  takeQueued(seatId: string, at: number, between?: () => void): QueueRow | null {
    let taken: QueueRow | null = null;
    this.transaction(() => {
      const held = this.db
        .prepare("SELECT 1 FROM queues WHERE seat_id = ? AND taken_at IS NOT NULL")
        .get(seatId);
      if (held) return;
      const head = this.db
        .prepare("SELECT * FROM queues WHERE seat_id = ? ORDER BY pos LIMIT 1")
        .get(seatId) as Row | undefined;
      if (!head) return;
      between?.();
      this.db
        .prepare("UPDATE queues SET taken_at = ? WHERE seat_id = ? AND pos = ?")
        .run(at, seatId, head.pos as number);
      taken = { ...queueRow(head), takenAt: at };
    }, true);
    return taken;
  }

  /** Gives a taken row back to the queue. */
  untake(seatId: string, repoId: RepoId, issue: number): void {
    this.db
      .prepare("UPDATE queues SET taken_at = NULL WHERE seat_id = ? AND repo_id = ? AND issue = ?")
      .run(seatId, repoId, issue);
  }

  dropQueued(seatId: string, repoId: RepoId, issue: number): void {
    this.db
      .prepare("DELETE FROM queues WHERE seat_id = ? AND repo_id = ? AND issue = ?")
      .run(seatId, repoId, issue);
  }

  /** Rows taken before `before` (a take whose run never began), oldest first. */
  staleTakes(before: number): QueueRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM queues WHERE taken_at IS NOT NULL AND taken_at < ? ORDER BY taken_at, seat_id",
      )
      .all(before) as Row[];
    return rows.map(queueRow);
  }

  /**
   * Opens the note. One already open is left as it is; a cleared one is re-opened with the new
   * text and time. A re-opened note is no longer dismissed.
   */
  raiseNote(n: NoteInput): void {
    this.db
      .prepare(
        `INSERT INTO attention_notes (key, kind, run_id, seat_id, repo_id, text, at, cleared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, run_id = excluded.run_id,
           seat_id = excluded.seat_id, repo_id = excluded.repo_id, text = excluded.text,
           at = excluded.at, cleared_at = NULL, dismissed_at = NULL
         WHERE attention_notes.cleared_at IS NOT NULL`,
      )
      .run(n.key, n.kind, n.runId, n.seatId, n.repoId, n.text, n.at);
  }

  clearNote(key: string, at: number): void {
    this.db
      .prepare("UPDATE attention_notes SET cleared_at = ? WHERE key = ? AND cleared_at IS NULL")
      .run(at, key);
  }

  clearNotesFor(runId: string, at: number): void {
    this.db
      .prepare("UPDATE attention_notes SET cleared_at = ? WHERE run_id = ? AND cleared_at IS NULL")
      .run(at, runId);
  }

  /** Dismisses an open note of any kind from Needs you; false when there is no such note. */
  dismissNote(key: string, at: number): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE attention_notes SET dismissed_at = ? WHERE key = ? AND cleared_at IS NULL",
          )
          .run(at, key).changes,
      ) > 0
    );
  }

  /** The open notes, oldest first. */
  notes(): AttentionNote[] {
    const rows = this.db
      .prepare("SELECT * FROM attention_notes WHERE cleared_at IS NULL ORDER BY at, key")
      .all() as Row[];
    return rows.map((r) => ({
      key: r.key as string,
      kind: r.kind as NoteKind,
      runId: r.run_id as string | null,
      seatId: r.seat_id as string | null,
      repoId: r.repo_id as string | null,
      text: r.text as string,
      at: r.at as number,
      clearedAt: null,
      dismissedAt: (r.dismissed_at as number | null) ?? null,
    }));
  }

  /** Historical waits, including cleared notes; only the named seat's evidence counts. */
  telemetryNoteIntervals(
    seatId: string,
    since: number,
    now: number,
    kinds: string[],
  ): [number, number][] {
    const rows = this.db
      .prepare(
        "SELECT at, cleared_at, kind FROM attention_episodes WHERE seat_id = ? AND at < ? AND (cleared_at IS NULL OR cleared_at > ?) ORDER BY at",
      )
      .all(seatId, now, since) as Row[];
    return rows
      .filter((r) => kinds.includes(r.kind as string))
      .map((r) => [
        Math.max(since, r.at as number),
        Math.min(now, (r.cleared_at as number | null) ?? now),
      ]);
  }

  openNoteKeys(runId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT key FROM attention_notes WHERE run_id = ? AND cleared_at IS NULL ORDER BY key",
      )
      .all(runId) as { key: string }[];
    return rows.map((r) => r.key);
  }

  seatSession(seatId: string): SeatSessionRow | null {
    const r = this.db.prepare("SELECT * FROM seat_sessions WHERE seat_id = ?").get(seatId) as
      | Row
      | undefined;
    return r ? seatRow(r) : null;
  }

  setSeatSession(row: SeatSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO seat_sessions (seat_id, run_id, cli_session_id, state, reason, worktree, updated_at, error_since, vendor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(seat_id) DO UPDATE SET run_id = excluded.run_id,
           cli_session_id = excluded.cli_session_id, state = excluded.state, vendor = excluded.vendor,
           reason = excluded.reason, worktree = excluded.worktree, updated_at = excluded.updated_at,
           error_since = CASE WHEN excluded.state != 'error' THEN NULL
             WHEN seat_sessions.state = 'error' THEN COALESCE(seat_sessions.error_since, seat_sessions.updated_at)
             ELSE excluded.updated_at END`,
      )
      .run(
        row.seatId,
        row.runId,
        row.cliSessionId,
        row.state,
        row.reason,
        row.worktree,
        row.updatedAt,
        row.state === "error" ? row.updatedAt : null,
        row.vendor ?? "claude",
      );
  }

  /** Records that the seat's turn ended at `at`; null: no turn of the seat's current run has. */
  setSeatTurnEnded(seatId: string, at: number | null): void {
    this.db
      .prepare("UPDATE seat_sessions SET last_turn_ended_at = ? WHERE seat_id = ?")
      .run(at, seatId);
  }

  /** Commits since `since`, per agent, joined to their runs. */
  commitsSince(since: number): { agentId: AgentId; n: number }[] {
    const rows = this.db
      .prepare(`SELECT r.agent_id, COUNT(*) AS n FROM run_commits c
      JOIN runs r ON r.id = c.run_id WHERE c.at >= ? GROUP BY r.agent_id ORDER BY r.agent_id`)
      .all(since) as Row[];
    return rows.map((r) => ({ agentId: r.agent_id as string, n: r.n as number }));
  }

  /** How long each cleared attention note of `kinds` raised since `since` stood open. */
  noteWaits(kinds: string[], since: number): number[] {
    if (kinds.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT cleared_at - at AS wait FROM attention_notes
      WHERE kind IN (${kinds.map(() => "?").join(",")}) AND at >= ? AND cleared_at IS NOT NULL
      ORDER BY at, key`)
      .all(...kinds, since) as Row[];
    return rows.map((r) => r.wait as number);
  }

  /**
   * Seat questions answered since `since` by the operator: a CAPCOM message to the seat up to 5 s
   * after the answer. FLIGHT's answers and questions a run's end closed have none.
   */
  operatorAnswers(since: number): { agentId: AgentId; at: number; answeredAt: number }[] {
    const rows = this.db
      .prepare(`SELECT q.agent_id, q.at, q.answered_at FROM seat_questions q
      WHERE q.answered_at >= ? AND EXISTS (SELECT 1 FROM comms c
        WHERE c.from_id = ? AND c.to_id = q.agent_id
        AND c.at BETWEEN q.answered_at AND q.answered_at + 5000)
      ORDER BY q.answered_at, q.id`)
      .all(since, COMMS_CAPCOM) as Row[];
    return rows.map((r) => ({
      agentId: r.agent_id as string,
      at: r.at as number,
      answeredAt: r.answered_at as number,
    }));
  }

  /** Runs the operator ended since `since`; FLIGHT's `end_run` also ends as `operator`, so its runs are left out. */
  operatorStops(since: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs r
      WHERE r.ended_at >= ? AND r.ended_by = 'operator' AND NOT EXISTS (
        SELECT 1 FROM flight_decisions d WHERE d.target_run_id = r.id AND d.kind = 'end'
      )`)
      .get(since) as Row;
    return row.n as number;
  }

  addLockHold(h: LockHoldRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO test_lock_holds (run_id, tool_use_id, seat_id, command, since)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(h.runId, h.toolUseId, h.seatId, h.command, h.since);
    this.db
      .prepare(`INSERT INTO test_lock_runs (run_id, seat_id, command, queued_at, started_at)
      SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM test_lock_runs WHERE run_id = ? AND ended_at IS NULL
      )`)
      .run(h.runId, h.seatId, h.command, h.queuedAt ?? h.since, h.since, h.runId);
    this.db.prepare("DELETE FROM test_lock_runs WHERE started_at < ?").run(h.since - 8 * 86400000);
  }

  deleteLockHold(runId: string, toolUseId: string, at = Date.now()): void {
    this.db
      .prepare("DELETE FROM test_lock_holds WHERE run_id = ? AND tool_use_id = ?")
      .run(runId, toolUseId);
    this.db
      .prepare(`UPDATE test_lock_runs SET ended_at = ?, outcome = 'done'
      WHERE run_id = ? AND ended_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM test_lock_holds WHERE run_id = ?
      )`)
      .run(at, runId, runId);
  }

  /** Every held call of the run. */
  deleteLockHolds(runId: string, at = Date.now()): void {
    this.db.prepare("DELETE FROM test_lock_holds WHERE run_id = ?").run(runId);
    this.db
      .prepare(
        "UPDATE test_lock_runs SET ended_at = ?, outcome = 'freed' WHERE run_id = ? AND ended_at IS NULL",
      )
      .run(at, runId);
  }

  /** Holds of the test lock started since `since`, newest first, with their run's ticket. */
  lockRuns(since: number): TestLockRun[] {
    const rows = this.db
      .prepare(`SELECT h.*, r.ticket FROM test_lock_runs h
      LEFT JOIN runs r ON r.id = h.run_id WHERE h.started_at >= ?
      ORDER BY h.started_at DESC, h.id DESC`)
      .all(since) as Row[];
    return rows.map((r) => ({
      runId: r.run_id as string,
      seatId: r.seat_id as string,
      command: r.command as string,
      queuedAt: r.queued_at as number,
      startedAt: r.started_at as number,
      endedAt: r.ended_at as number | null,
      outcome: r.outcome as TestLockRun["outcome"],
      ticket: r.ticket as string | null,
    }));
  }

  setKeeperCursor(c: KeeperCursor): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO keeper_cursors (run_id, spawn, line, rate_limited_until)
         VALUES (?, ?, ?, ?)`,
      )
      .run(c.runId, c.spawn, c.line, c.rateLimitedUntil);
  }

  keeperCursor(runId: string): KeeperCursor | null {
    const r = this.db.prepare("SELECT * FROM keeper_cursors WHERE run_id = ?").get(runId) as
      | Row
      | undefined;
    if (r === undefined) return null;
    return {
      runId,
      spawn: r.spawn as string,
      line: r.line as number,
      rateLimitedUntil: r.rate_limited_until as number | null,
    };
  }

  deleteKeeperCursor(runId: string): void {
    this.db.prepare("DELETE FROM keeper_cursors WHERE run_id = ?").run(runId);
  }

  lockHolds(): LockHoldRow[] {
    const rows = this.db
      .prepare("SELECT * FROM test_lock_holds ORDER BY since, run_id, tool_use_id")
      .all() as Row[];
    return rows.map((r) => ({
      runId: r.run_id as string,
      toolUseId: r.tool_use_id as string,
      seatId: r.seat_id as string,
      command: r.command as string,
      since: r.since as number,
    }));
  }

  /** Sessions that hold a run and are not stopped or in error. */
  activeSeatSessions(): SeatSessionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM seat_sessions WHERE run_id IS NOT NULL ORDER BY seat_id ASC")
      .all() as Row[];
    return rows.map(seatRow).filter((r) => ACTIVE_SEAT_STATES.includes(r.state));
  }

  /** Unended runs a seat row names (any seat state), with the row's worktree; by seat id. */
  liveSeatRuns(): { seatId: string; worktree: string | null; run: Run }[] {
    const rows = this.db
      .prepare(
        `SELECT s.seat_id, s.worktree, s.run_id FROM seat_sessions s JOIN runs r ON r.id = s.run_id
         WHERE r.ended_at IS NULL ORDER BY s.seat_id ASC`,
      )
      .all() as { seat_id: string; worktree: string | null; run_id: string }[];
    const out: { seatId: string; worktree: string | null; run: Run }[] = [];
    for (const r of rows) {
      const run = this.run(r.run_id);
      if (run !== null) out.push({ seatId: r.seat_id, worktree: r.worktree, run });
    }
    return out;
  }

  /** Records one refusal; returns its id. */
  addGuardHit(h: Omit<GuardHit, "id">): number {
    const r = this.db
      .prepare("INSERT INTO guard_hits (agent_id, run_id, rule, text, at) VALUES (?, ?, ?, ?, ?)")
      .run(h.agentId, h.runId, h.rule, h.text, h.at);
    return Number(r.lastInsertRowid);
  }

  /** Hits at or after `sinceMs`, newest first; at most `limit` of them. */
  guardHits(sinceMs: number, limit = GUARD_HITS_LIMIT): GuardHit[] {
    const rows = this.db
      .prepare("SELECT * FROM guard_hits WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(sinceMs, limit) as Row[];
    return rows.map(toGuardHit);
  }

  /** How many refusals a run has had. */
  guardHitCount(runId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM guard_hits WHERE run_id = ?")
      .get(runId) as { n: number };
    return r.n;
  }

  /** Hits at or after `sinceMs` per rule; every rule is present, 0 when it has none. */
  guardHitCounts(sinceMs: number): Record<GuardRule, number> {
    const counts = Object.fromEntries(Object.keys(GUARD_RULES).map((k) => [k, 0])) as Record<
      GuardRule,
      number
    >;
    const rows = this.db
      .prepare("SELECT rule, COUNT(*) AS n FROM guard_hits WHERE at >= ? GROUP BY rule")
      .all(sinceMs) as { rule: string; n: number }[];
    for (const r of rows) if (Object.hasOwn(counts, r.rule)) counts[r.rule as GuardRule] = r.n;
    return counts;
  }

  /** Records a commit the commit tool made for a run (once per run and sha). */
  addRunCommit(c: {
    runId: string;
    repoId: RepoId;
    branch: string;
    sha: string;
    at: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO run_commits (run_id, repo_id, branch, sha, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, sha) DO NOTHING`,
      )
      .run(c.runId, c.repoId, c.branch, c.sha, c.at);
  }

  commitLines(sha: string): { additions: number | null; deletions: number | null } | null {
    return (
      (this.db.prepare("SELECT additions, deletions FROM commit_lines WHERE sha = ?").get(sha) as
        | { additions: number | null; deletions: number | null }
        | undefined) ?? null
    );
  }

  setCommitLines(
    sha: string,
    counts: { additions: number | null; deletions: number | null },
  ): void {
    this.db
      .prepare("INSERT OR IGNORE INTO commit_lines VALUES (?, ?, ?)")
      .run(sha, counts.additions, counts.deletions);
  }

  /** First record of each repo/commit in the window; a later retry never recounts it. */
  telemetryCommits(
    since: number,
    now: number,
  ): { runId: string; repoId: string; sha: string; at: number }[] {
    const rows = this.db
      .prepare(
        `SELECT c.run_id, c.repo_id, c.sha, c.at FROM run_commits c
         WHERE c.at >= ? AND c.at <= ? AND c.id = (
           SELECT first.id FROM run_commits first
           WHERE first.repo_id = c.repo_id AND first.sha = c.sha ORDER BY first.at, first.id LIMIT 1
         ) ORDER BY c.at, c.id`,
      )
      .all(since, now) as Row[];
    return rows.map((r) => ({
      runId: r.run_id as string,
      repoId: r.repo_id as string,
      sha: r.sha as string,
      at: r.at as number,
    }));
  }

  /** The commits the commit tool made for a run, in the order it made them. */
  runCommits(runId: string): string[] {
    const rows = this.db
      .prepare("SELECT sha FROM run_commits WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as { sha: string }[];
    return rows.map((r) => r.sha);
  }

  /** The commits the commit tool made at or after `since`, oldest first, with their run's agent and ticket. */
  runCommitsSince(
    since: number,
  ): { runId: string; agentId: AgentId; sha: string; at: number; ticket: string | null }[] {
    const rows = this.db
      .prepare(`SELECT c.run_id, r.agent_id, c.sha, c.at, r.ticket FROM run_commits c
      JOIN runs r ON r.id = c.run_id WHERE c.at >= ? ORDER BY c.at, c.id`)
      .all(since) as Row[];
    return rows.map((r) => ({
      runId: r.run_id as string,
      agentId: r.agent_id as AgentId,
      sha: r.sha as string,
      at: r.at as number,
      ticket: r.ticket as string | null,
    }));
  }

  /** The run's newest commit and when the commit tool made it, else null. */
  newestRunCommit(runId: string): { sha: string; at: number } | null {
    const r = this.db
      .prepare("SELECT sha, at FROM run_commits WHERE run_id = ? ORDER BY id DESC LIMIT 1")
      .get(runId) as { sha: string; at: number } | undefined;
    return r ? { sha: r.sha, at: r.at } : null;
  }

  /**
   * Every commit any run made on `branch`: a later run on the same ticket reuses the branch, and
   * the earlier run's unpushed commits still count as the hub's.
   */
  branchCommits(repoId: RepoId, branch: string): Set<string> {
    const rows = this.db
      .prepare("SELECT sha FROM run_commits WHERE repo_id = ? AND branch = ?")
      .all(repoId, branch) as { sha: string }[];
    return new Set(rows.map((r) => r.sha));
  }

  /** The first and last commit recorded on `branch` (by id), or null. */
  branchCommitSpan(repoId: RepoId, branch: string): { first: string; last: string } | null {
    const first = this.db
      .prepare(
        "SELECT sha FROM run_commits WHERE repo_id = ? AND branch = ? ORDER BY id ASC LIMIT 1",
      )
      .get(repoId, branch) as { sha: string } | undefined;
    const last = this.db
      .prepare(
        "SELECT sha FROM run_commits WHERE repo_id = ? AND branch = ? ORDER BY id DESC LIMIT 1",
      )
      .get(repoId, branch) as { sha: string } | undefined;
    return first === undefined || last === undefined ? null : { first: first.sha, last: last.sha };
  }

  /** Records that a run's branch is on origin at `sha` (replacing an earlier push of the run). */
  setRunPush(p: { runId: string; sha: string; at: number }): void {
    this.appendAttempt(p.runId, "push", p.at, { sha: p.sha });
    this.db
      .prepare(
        `INSERT INTO run_pushes (run_id, sha, at) VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET sha = excluded.sha, at = excluded.at`,
      )
      .run(p.runId, p.sha, p.at);
  }

  /** The run's last push, or null when it has not pushed. */
  runPush(runId: string): { sha: string; at: number } | null {
    const r = this.db.prepare("SELECT sha, at FROM run_pushes WHERE run_id = ?").get(runId) as
      | { sha: string; at: number }
      | undefined;
    return r ? { sha: r.sha, at: r.at } : null;
  }

  /** Records strays; one already there (same session and path) takes the new seat, kind and time. */
  addStrays(strays: Omit<Stray, "key">[]): void {
    this.transaction(() => {
      const ins = this.db.prepare(
        `INSERT INTO strays (key, session_id, path, agent_id, kind, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET agent_id = excluded.agent_id, kind = excluded.kind,
           at = excluded.at`,
      );
      for (const x of strays) {
        ins.run(strayKey(x.sessionId, x.path), x.sessionId, x.path, x.agentId, x.kind, x.at);
      }
    });
  }

  /** Every stray, oldest first (then by path). */
  strays(): Stray[] {
    const rows = this.db.prepare("SELECT * FROM strays ORDER BY at ASC, path ASC").all() as Row[];
    return rows.map((r) => ({
      key: r.key as string,
      sessionId: r.session_id as string,
      path: r.path as string,
      agentId: r.agent_id as string,
      kind: r.kind as StrayKind,
      at: r.at as number,
    }));
  }

  /** Drops the session's strays on `paths` (reverted, or the run that made them ended). */
  clearStrays(sessionId: string, paths: readonly string[]): void {
    this.transaction(() => {
      const del = this.db.prepare("DELETE FROM strays WHERE key = ?");
      for (const p of paths) del.run(strayKey(sessionId, p));
    });
  }

  /** Records a seat's question; returns its id. */
  addQuestion(q: Omit<SeatQuestion, "id" | "passedAt">): number {
    const r = this.db
      .prepare("INSERT INTO seat_questions (agent_id, run_id, text, at) VALUES (?, ?, ?, ?)")
      .run(q.agentId, q.runId, q.text, q.at);
    return Number(r.lastInsertRowid);
  }

  /** Questions not yet answered, oldest first. */
  openQuestions(): SeatQuestion[] {
    const rows = this.db
      .prepare("SELECT * FROM seat_questions WHERE answered_at IS NULL ORDER BY id ASC")
      .all() as Row[];
    return rows.map(toQuestion);
  }

  /** The seat's questions open at any time in [from, to), oldest first. */
  questionsOverlapping(
    agentId: AgentId,
    from: number,
    to: number,
  ): { at: number; answeredAt: number | null }[] {
    const rows = this.db
      .prepare(
        `SELECT at, answered_at FROM seat_questions
         WHERE agent_id = ? AND at < ? AND (answered_at IS NULL OR answered_at > ?) ORDER BY id`,
      )
      .all(agentId, to, from) as Row[];
    return rows.map((r) => ({ at: r.at as number, answeredAt: r.answered_at as number | null }));
  }

  /** One question by id, answered or not; null when there is none. */
  question(id: number): (SeatQuestion & { answeredAt: number | null }) | null {
    const r = this.db.prepare("SELECT * FROM seat_questions WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r ? { ...toQuestion(r), answeredAt: r.answered_at as number | null } : null;
  }

  /** Marks an open question passed to the operator; true only when it was open and not yet passed. */
  passQuestion(id: number, at: number): boolean {
    const r = this.db
      .prepare(
        "UPDATE seat_questions SET passed_at = ? WHERE id = ? AND answered_at IS NULL AND passed_at IS NULL",
      )
      .run(at, id);
    return Number(r.changes) > 0;
  }

  /**
   * Marks every open question of the seat answered at `at`; with `unpassedOnly`, leaves the ones
   * passed to the operator open.
   */
  answerQuestions(agentId: AgentId, at: number, unpassedOnly = false): void {
    this.db
      .prepare(
        `UPDATE seat_questions SET answered_at = ? WHERE agent_id = ? AND answered_at IS NULL${
          unpassedOnly ? " AND passed_at IS NULL" : ""
        }`,
      )
      .run(at, agentId);
  }

  /** Records an mc tool failure for the operator; returns its id. */
  addCrewError(e: Omit<CrewError, "id">): number {
    const r = this.db
      .prepare("INSERT INTO crew_errors (agent_id, run_id, text, at) VALUES (?, ?, ?, ?)")
      .run(e.agentId, e.runId, e.text, e.at);
    return Number(r.lastInsertRowid);
  }

  /** Crew errors not yet acked, oldest first. */
  crewErrors(): CrewError[] {
    const rows = this.db
      .prepare("SELECT * FROM crew_errors WHERE acked = 0 ORDER BY id ASC")
      .all() as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      agentId: r.agent_id as string,
      runId: r.run_id as string | null,
      text: r.text as string,
      at: r.at as number,
    }));
  }

  ackCrewError(id: number): void {
    this.db.prepare("UPDATE crew_errors SET acked = 1 WHERE id = ?").run(id);
  }

  addDraft(
    target: string,
    kind: ReplyDraft["kind"],
    text: string,
    at: number,
    metadata?: Pick<ReplyDraft, "to" | "via" | "where" | "context">,
  ): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO drafts (target, kind, text, created_at, metadata) VALUES (?, ?, ?, ?, ?)",
        )
        .run(target, kind, text, at, metadata ? JSON.stringify(metadata) : null).lastInsertRowid,
    );
  }

  addSourceDraft(
    target: string,
    kind: ReplyDraft["kind"],
    text: string,
    at: number,
    source: { itemKey: string; replyId: string; source: PersonSource },
    metadata?: Pick<ReplyDraft, "to" | "via" | "where" | "context">,
  ): number {
    const id = this.addDraft(target, kind, text, at, metadata);
    this.db.prepare("UPDATE drafts SET source = ? WHERE id = ?").run(JSON.stringify(source), id);
    return id;
  }

  draftSource(
    id: number,
  ): { itemKey: string; replyId: string; source: PersonSource; state: string } | null {
    const row = this.db.prepare("SELECT source, state FROM drafts WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row?.source ? { ...JSON.parse(row.source as string), state: row.state as string } : null;
  }

  drafts(includeDone = false): ReplyDraft[] {
    return this.readDrafts(includeDone ? "all" : "pending");
  }

  draft(id: number): ReplyDraft | undefined {
    return this.readDrafts(id)[0];
  }

  draftHistory(): ReplyDraft[] {
    return this.readDrafts("history");
  }

  private readDrafts(selection: "pending" | "all" | "history" | number): ReplyDraft[] {
    const rows = this.db
      .prepare(
        `SELECT id, target, kind, text, created_at AS createdAt, state, metadata, completed_at AS completedAt
       FROM drafts ${
         typeof selection === "number"
           ? "WHERE id = ?"
           : selection === "history"
             ? "WHERE state != 'pending' ORDER BY COALESCE(completed_at, created_at) DESC, id DESC LIMIT 100"
             : selection === "all"
               ? `WHERE state = 'pending' OR id IN (
               SELECT id FROM drafts WHERE state != 'pending'
               ORDER BY created_at DESC, id DESC LIMIT 100
             ) ORDER BY created_at DESC, id DESC`
               : "WHERE state = 'pending' ORDER BY created_at, id"
       }`,
      )
      .all(...(typeof selection === "number" ? [selection] : [])) as Row[];
    return rows.map(({ metadata, completedAt, ...r }) => ({
      ...r,
      to: r.target,
      via: "GitHub",
      where: r.target,
      ...(metadata ? JSON.parse(metadata as string) : {}),
      ...(completedAt === null ? {} : { completedAt }),
    })) as ReplyDraft[];
  }

  finishDraft(
    id: number,
    state: "posted" | "copied" | "discarded",
    text?: string,
    at = Date.now(),
  ): void {
    this.db
      .prepare(
        "UPDATE drafts SET state = ?, text = COALESCE(?, text), completed_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(state, text ?? null, at, id);
  }

  setFlightPlans(session: string, operation: FlightPlanOperation, at: number): void {
    const write = this.prepareFlightPlans(session, operation, at);
    this.transaction(write);
  }

  private prepareFlightPlans(
    session: string,
    operation: FlightPlanOperation,
    at: number,
  ): () => void {
    const plans = new Map(this.flightPlans(session).map((p) => [p.id, p]));
    for (const entry of operation.upsert ?? []) {
      if (entry.status === "completed" && !entry.detail?.trim())
        throw new Error("Completion needs an observed outcome.");
      plans.set(entry.id, { ...entry, createdAt: plans.get(entry.id)?.createdAt ?? at });
    }
    if ([...plans.values()].filter((p) => p.status === "pending").length > FLIGHT_PLAN_LIMIT)
      throw new Error("Too many planned entries.");
    const finished = [...plans.values()]
      .filter((p) => p.status !== "pending")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const entry of finished.slice(0, Math.max(0, plans.size - FLIGHT_PLAN_LIMIT)))
      plans.delete(entry.id);
    return () => {
      this.db.prepare("DELETE FROM flight_plans WHERE session_id = ?").run(session);
      for (const entry of plans.values())
        this.db
          .prepare("INSERT INTO flight_plans (session_id, id, entry) VALUES (?, ?, ?)")
          .run(session, entry.id, JSON.stringify(entry));
    };
  }

  flightPlans(session: string): (FlightPlanInput & { createdAt: number })[] {
    return (
      this.db
        .prepare("SELECT entry FROM flight_plans WHERE session_id = ? ORDER BY id")
        .all(session) as Row[]
    ).map((r) => JSON.parse(r.entry as string) as FlightPlanInput & { createdAt: number });
  }

  setFlightWatch(session: string, operation: FlightWatchOperation, at: number): void {
    const write = this.prepareFlightWatch(session, operation, at);
    this.transaction(write);
  }

  private prepareFlightWatch(
    session: string,
    operation: FlightWatchOperation,
    at: number,
  ): () => void {
    const watch = new Map(this.flightWatch(session).map((entry) => [entry.id, entry]));
    for (const id of operation.remove ?? []) watch.delete(id);
    for (const entry of operation.upsert ?? []) watch.set(entry.id, { ...entry, updatedAt: at });
    if (watch.size > FLIGHT_WATCH_LIMIT) throw new Error("Too many watch entries.");
    return () => {
      this.db.prepare("DELETE FROM flight_watch WHERE session_id = ?").run(session);
      for (const entry of watch.values())
        this.db
          .prepare("INSERT INTO flight_watch (session_id, id, entry) VALUES (?, ?, ?)")
          .run(session, entry.id, JSON.stringify(entry));
    };
  }

  /** Validate the whole update before writing any part of it. */
  updateFlightBrief(
    section: Omit<FlightBriefRow, "section" | "text"> &
      Partial<Pick<FlightBriefRow, "section" | "text">>,
    planned?: FlightPlanOperation,
    watch?: FlightWatchOperation,
    arrival?: Omit<FlightArrivalDisposition, "id" | "repoId" | "sourceRef">,
  ): void {
    const plansWrite = planned
      ? this.prepareFlightPlans(section.sessionId, planned, section.updatedAt)
      : undefined;
    const watchWrite = watch
      ? this.prepareFlightWatch(section.sessionId, watch, section.updatedAt)
      : undefined;
    this.transaction(() => {
      plansWrite?.();
      watchWrite?.();
      if (arrival) this.writeFlightArrival(arrival);
      if (section.section !== undefined && section.text !== undefined)
        this.setFlightBriefSection({ ...section, section: section.section, text: section.text });
    });
  }

  flightWatch(session: string): FlightWatchEntry[] {
    return (
      this.db
        .prepare("SELECT entry FROM flight_watch WHERE session_id = ? ORDER BY id")
        .all(session) as Row[]
    ).map((r) => JSON.parse(r.entry as string) as FlightWatchEntry);
  }

  recordFlightArrival(entry: Omit<FlightArrivalDisposition, "id" | "repoId" | "sourceRef">): void {
    this.transaction(() => this.writeFlightArrival(entry));
  }

  private writeFlightArrival(
    entry: Omit<FlightArrivalDisposition, "id" | "repoId" | "sourceRef">,
  ): void {
    const id = JSON.stringify([entry.source, entry.arrivalId, entry.version]);
    const notification = entry.source === "Board" ? null : this.notification(entry.arrivalId);
    const board =
      entry.source === "Board"
        ? this.board(entry.arrivalId.split("#")[0] ?? "").find(
            (c) => `${c.repoId}#${c.issueNumber}` === entry.arrivalId,
          )
        : undefined;
    const repoId = notification?.repoId || board?.repoId || null;
    const kind =
      entry.source === "Teams"
        ? "teams"
        : notification?.subjectType === "PullRequest"
          ? "github-pr"
          : "github-issue";
    const url = notification?.message?.url ?? notification?.url ?? board?.url;
    let sourceRef: FlightArrivalDisposition["sourceRef"] = null;
    if (url) {
      try {
        const parsed = new URL(url);
        if (
          parsed.origin ===
            (kind === "teams" ? "https://teams.microsoft.com" : "https://github.com") &&
          !parsed.username &&
          !parsed.password
        )
          sourceRef = { kind, url };
      } catch {
        /* Invalid source URLs are never offered as links. */
      }
    }
    const previous = this.db.prepare("SELECT entry FROM flight_incoming WHERE id = ?").get(id) as
      | Row
      | undefined;
    const saved = previous
      ? (JSON.parse(previous.entry as string) as FlightArrivalDisposition)
      : null;
    if (saved?.outcome === entry.outcome && saved.detail === entry.detail) return;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO flight_incoming (id, source, arrival_id, version, at, entry) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        entry.source,
        entry.arrivalId,
        entry.version,
        entry.at,
        JSON.stringify({
          ...entry,
          id,
          repoId: saved ? (saved.repoId ?? null) : repoId,
          sourceRef: saved ? (saved.sourceRef ?? null) : sourceRef,
        }),
      );
    this.db
      .prepare(
        "DELETE FROM flight_incoming WHERE id NOT IN (SELECT id FROM flight_incoming ORDER BY at DESC, id DESC LIMIT ?)",
      )
      .run(FLIGHT_INCOMING_LIMIT);
  }

  flightIncoming(): FlightArrivalDisposition[] {
    return (
      this.db
        .prepare("SELECT entry FROM flight_incoming ORDER BY at DESC, id DESC LIMIT ?")
        .all(FLIGHT_INCOMING_LIMIT) as Row[]
    ).map((r) => {
      const entry = JSON.parse(r.entry as string) as FlightArrivalDisposition;
      return { ...entry, repoId: entry.repoId ?? null, sourceRef: entry.sourceRef ?? null };
    });
  }

  /** Records one of FLIGHT's decisions; returns its id. */
  addFlightDecision(d: Omit<FlightDecision, "id">): number {
    const r = this.db
      .prepare(
        `INSERT INTO flight_decisions
           (at, kind, seat_id, target_run_id, ref, question_id, about, decision, basis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.at,
        d.kind,
        d.seatId,
        d.targetRunId,
        d.ref,
        d.questionId,
        d.about,
        d.decision,
        d.basis,
      );
    return Number(r.lastInsertRowid);
  }

  /** FLIGHT's decisions at or after `since`, newest first. */
  flightDecisions(since: number, limit: number): FlightDecision[] {
    const rows = this.db
      .prepare("SELECT * FROM flight_decisions WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(since, limit) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      at: r.at as number,
      kind: r.kind as FlightDecisionKind,
      seatId: r.seat_id as string | null,
      targetRunId: r.target_run_id as string | null,
      ref: r.ref as string | null,
      questionId: r.question_id as number | null,
      about: r.about as string,
      decision: r.decision as string,
      basis: r.basis as string,
    }));
  }

  /** Replaces one section of a session's brief. */
  setFlightBriefSection(r: FlightBriefRow): void {
    this.db
      .prepare(
        `INSERT INTO flight_brief (session_id, section, text, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, section) DO UPDATE SET
           text = excluded.text, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(r.sessionId, r.section, r.text, r.updatedAt, r.updatedBy);
  }

  /** Lasting notes for one repo, in topic order. */
  flightMemory(repo: string): FlightMemoryNote[] {
    return (
      this.db
        .prepare("SELECT * FROM flight_memory WHERE repo_id = ? ORDER BY topic")
        .all(repo) as Row[]
    ).map((r) => ({
      repoId: r.repo_id as string,
      topic: r.topic as string,
      kind: r.kind as FlightMemoryNote["kind"],
      body: r.body as string,
      source: r.source as string,
      author: r.author as FlightMemoryNote["author"],
      updatedAt: r.updated_at as number,
    }));
  }

  /** The state index never reads note bodies. */
  flightMemoryTitles(repo: string): FlightMemoryTitle[] {
    return (
      this.db
        .prepare(
          "SELECT topic, kind, updated_at, author FROM flight_memory WHERE repo_id = ? ORDER BY topic",
        )
        .all(repo) as Row[]
    ).map((r) => ({
      topic: r.topic as string,
      kind: r.kind as FlightMemoryTitle["kind"],
      updatedAt: r.updated_at as number,
      author: r.author as FlightMemoryTitle["author"],
    }));
  }

  putFlightMemory(note: FlightMemoryNote): void {
    const parsed = validateMemoryNote(note);
    const key = memoryTopicKey(parsed.topic);
    this.transaction(() => {
      const exists = this.db
        .prepare("SELECT 1 FROM flight_memory WHERE repo_id = ? AND topic_key = ?")
        .get(note.repoId, key);
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM flight_memory WHERE repo_id = ?")
        .get(note.repoId) as { n: number };
      if (!exists && count.n >= FLIGHT_MEMORY_TOPICS_MAX) throw new Error(FLIGHT_MEMORY_FULL);
      this.db
        .prepare(`INSERT INTO flight_memory (repo_id, topic, topic_key, kind, body, source, author, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_id, topic_key) DO UPDATE SET
        topic = excluded.topic, kind = excluded.kind, body = excluded.body, source = excluded.source,
        author = excluded.author, updated_at = excluded.updated_at`)
        .run(
          note.repoId,
          parsed.topic,
          key,
          parsed.kind,
          parsed.body,
          parsed.source,
          parsed.author,
          note.updatedAt,
        );
    });
  }

  deleteFlightMemory(repo: string, topic: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM flight_memory WHERE repo_id = ? AND topic_key = ?")
        .run(repo, memoryTopicKey(topic)).changes > 0
    );
  }

  /** The full ledger for one crew session, including retained closed entries. */
  flightLedger(session: string): FlightLedgerEntry[] {
    return (
      this.db
        .prepare("SELECT entry FROM flight_ledger WHERE session_id = ? ORDER BY key")
        .all(session) as { entry: string }[]
    ).map((r) => JSON.parse(r.entry) as FlightLedgerEntry);
  }

  /** Save an entry and prune old closed entries across all sessions, in one transaction. */
  putFlightLedgerEntry(session: string, entry: FlightLedgerEntry, pruneBefore: number): void {
    this.transaction(() => {
      this.db
        .prepare(`INSERT INTO flight_ledger (session_id, key, kind, status, updated_at, entry)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET
        kind = excluded.kind, status = excluded.status, updated_at = excluded.updated_at, entry = excluded.entry`)
        .run(session, entry.key, entry.kind, entry.status, entry.updatedAt, JSON.stringify(entry));
      this.db
        .prepare(`DELETE FROM flight_ledger WHERE updated_at < ?
        AND status NOT IN (${FLIGHT_LEDGER_OPEN.map(() => "?").join(", ")})`)
        .run(pruneBefore, ...FLIGHT_LEDGER_OPEN);
    });
  }

  /** The stored sections of a session's brief. */
  flightBrief(sessionId: string): FlightBriefRow[] {
    const rows = this.db
      .prepare("SELECT * FROM flight_brief WHERE session_id = ? ORDER BY section")
      .all(sessionId) as Row[];
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      section: r.section as FlightBriefRow["section"],
      text: r.text as string,
      updatedAt: r.updated_at as number,
      updatedBy: r.updated_by as string,
    }));
  }

  /** A stable, bounded thread for one exact version of an item. */
  ensureDiscussion(
    itemKey: string,
    version: string,
    opening?: { text: string; at: number },
  ): ItemDiscussion {
    const id = randomUUID();
    const messages: ItemChatMessage[] = opening
      ? [
          {
            id: `${id}:opening`,
            itemKey,
            correlationId: id,
            role: "flight",
            text: opening.text,
            at: opening.at,
          },
        ]
      : [];
    this.db
      .prepare(
        `INSERT OR IGNORE INTO item_discussions (id, item_key, version, messages) VALUES (?, ?, ?, ?)`,
      )
      .run(id, itemKey, version, JSON.stringify(messages));
    const row = this.db
      .prepare("SELECT id FROM item_discussions WHERE item_key = ? AND version = ?")
      .get(itemKey, version) as Row;
    return this.discussion(itemKey, row.id as string) as ItemDiscussion;
  }

  discussion(itemKey: string, id: string): ItemDiscussion | null {
    const row = this.db
      .prepare("SELECT * FROM item_discussions WHERE item_key = ? AND id = ?")
      .get(itemKey, id) as Row | undefined;
    return row
      ? {
          id,
          itemKey,
          version: row.version as string,
          messages: JSON.parse(row.messages as string) as ItemChatMessage[],
        }
      : null;
  }

  private discussionById(id: string): ItemDiscussion | null {
    const row = this.db.prepare("SELECT item_key FROM item_discussions WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? this.discussion(row.item_key as string, id) : null;
  }

  private saveDiscussion(thread: ItemDiscussion): void {
    this.db
      .prepare("UPDATE item_discussions SET messages = ? WHERE id = ?")
      .run(JSON.stringify(thread.messages.slice(-100)), thread.id);
  }

  askDiscussion(id: string, messageId: string, text: string, at: number): boolean {
    const thread = this.discussionById(id);
    if (!thread) throw new Error("Unknown discussion.");
    const prior = thread.messages.find((m) => m.id === messageId);
    if (prior) {
      if (prior.role !== "operator" || prior.text !== text)
        throw new Error("Message id already used.");
      return false;
    }
    thread.messages.push({
      id: messageId,
      itemKey: thread.itemKey,
      correlationId: id,
      role: "operator",
      text,
      at,
    });
    this.saveDiscussion(thread);
    return true;
  }

  replyDiscussion(
    id: string,
    replyTo: string,
    messageId: string,
    text: string,
    at: number,
  ): boolean {
    const thread = this.discussionById(id);
    if (!thread?.messages.some((m) => m.id === replyTo && m.role === "operator")) return false;
    const prior = thread.messages.find((m) => m.id === messageId || m.replyTo === replyTo);
    if (prior) return prior.id === messageId && prior.replyTo === replyTo && prior.text === text;
    thread.messages.push({
      id: messageId,
      itemKey: thread.itemKey,
      correlationId: id,
      replyTo,
      role: "flight",
      text,
      at,
    });
    this.saveDiscussion(thread);
    return true;
  }

  discussionSent(id: string, messageId: string): boolean {
    const row = this.db.prepare("SELECT sent FROM item_discussions WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? (JSON.parse(row.sent as string) as string[]).includes(messageId) : false;
  }

  markDiscussionSent(id: string, messageId: string): void {
    const row = this.db.prepare("SELECT sent FROM item_discussions WHERE id = ?").get(id) as Row;
    const sent = JSON.parse(row.sent as string) as string[];
    this.db
      .prepare("UPDATE item_discussions SET sent = ? WHERE id = ?")
      .run(JSON.stringify([...new Set([...sent, messageId])].slice(-100)), id);
  }

  pendingDiscussions(): ItemDiscussion[] {
    const rows = this.db
      .prepare(`
        SELECT d.item_key, d.id,
          (SELECT MIN(json_extract(q.value, '$.at'))
           FROM json_each(d.messages) AS q
           WHERE json_extract(q.value, '$.role') = 'operator'
             AND NOT EXISTS (
               SELECT 1 FROM json_each(d.messages) AS r
               WHERE json_extract(r.value, '$.replyTo') = json_extract(q.value, '$.id')
             )) AS waiting_since
        FROM item_discussions AS d
        WHERE waiting_since IS NOT NULL
        ORDER BY waiting_since ASC, d.rowid ASC
        LIMIT 100
      `)
      .all() as Row[];
    return rows.map((r) => this.discussion(r.item_key as string, r.id as string) as ItemDiscussion);
  }

  /** Stores FLIGHT's brief on an attention key; returns its id. */
  addBrief(b: AttentionBrief & { key: string }): number {
    let id = 0;
    this.transaction(() => {
      const { key, context, recommendation, options, basis, at, ...structured } = b;
      if (structured.person) {
        const thread = /^person:(\d+):(\d+)$/.exec(key);
        const n = thread ? this.notification(thread[1] as string) : null;
        if (
          !n ||
          n.updatedAt !== Number(thread?.[2]) ||
          !n.unread ||
          (n.handledThrough !== null && n.updatedAt <= n.handledThrough) ||
          !n.message ||
          JSON.stringify(n.message.source) !== JSON.stringify(structured.person.source)
        ) {
          throw new Error("Source changed; refresh the item before drafting.");
        }
        const source = n.message.source;
        structured.person = {
          ...structured.person,
          history: n.history,
          replies: structured.person.replies?.map(({ draftId: _ignored, ...r }) => ({
            ...r,
            ...(structured.person?.source.kind === "github" && n.number !== null
              ? {
                  draftId: this.addSourceDraft(
                    `${n.repoId}#${n.number}`,
                    n.subjectType === "PullRequest" ? "pr" : "issue",
                    r.text,
                    at,
                    { itemKey: key, replyId: r.id, source },
                    {
                      ...(n.author === null ? {} : { to: n.author }),
                      via: "GitHub",
                      where: `${n.repoId}#${n.number}`,
                      context: n.title,
                    },
                  ),
                }
              : {}),
          })),
        };
      }
      const r = this.db
        .prepare(`INSERT INTO briefs (key, context, recommendation, options, basis, at, structured)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          key,
          context,
          recommendation,
          JSON.stringify(options),
          basis,
          at,
          JSON.stringify(structured),
        );
      id = Number(r.lastInsertRowid);
    });
    return id;
  }

  /** The newest brief on each attention key. */
  briefs(): Map<string, AttentionBrief> {
    const rows = this.db
      .prepare("SELECT * FROM briefs WHERE id IN (SELECT MAX(id) FROM briefs GROUP BY key)")
      .all() as Row[];
    return new Map(
      rows
        .filter((r) => {
          const person = r.structured
            ? (JSON.parse(r.structured as string) as AttentionBrief).person
            : undefined;
          if (!person) return true;
          const thread = /^person:(\d+):(\d+)$/.exec(r.key as string);
          const n = thread ? this.notification(thread[1] as string) : null;
          return (
            n?.updatedAt === Number(thread?.[2]) &&
            JSON.stringify(n?.message?.source) === JSON.stringify(person.source)
          );
        })
        .map((r) => [
          r.key as string,
          {
            ...(r.structured ? JSON.parse(r.structured as string) : {}),
            context: r.context as string,
            recommendation: r.recommendation as string,
            options: JSON.parse(r.options as string) as BriefOption[],
            basis: r.basis as string,
            at: r.at as number,
          },
        ]),
    );
  }

  /** Holds a card in Backlog behind PR `waitsOn`; an earlier open hold on the card is replaced. */
  addHold(h: { ref: string; waitsOn: number; basis: string; at: number }): void {
    this.releaseHold(h.ref, h.at);
    this.db
      .prepare("INSERT INTO holds (ref, waits_on, basis, at) VALUES (?, ?, ?, ?)")
      .run(h.ref, h.waitsOn, h.basis, h.at);
  }

  /** Releases the card's open hold, if it has one. */
  releaseHold(ref: string, at: number): void {
    this.db
      .prepare("UPDATE holds SET released_at = ? WHERE ref = ? AND released_at IS NULL")
      .run(at, ref);
  }

  /** The holds not yet released, oldest first. */
  activeHolds(): Hold[] {
    const rows = this.db
      .prepare("SELECT * FROM holds WHERE released_at IS NULL ORDER BY at, id")
      .all() as Row[];
    return rows.map((r) => ({
      ref: r.ref as string,
      waitsOn: r.waits_on as number,
      basis: r.basis as string,
      at: r.at as number,
      releasedAt: r.released_at as number | null,
      seen: r.seen === 1,
      toldState: (r.told_state as string | null) ?? null,
    }));
  }

  /** The board has shown the card's open hold in Backlog. */
  markHoldSeen(ref: string): void {
    this.db.prepare("UPDATE holds SET seen = 1 WHERE ref = ? AND released_at IS NULL").run(ref);
  }

  /** FLIGHT has been told the card's open hold waits on a PR in `state`. */
  markHoldTold(ref: string, state: string): void {
    this.db
      .prepare("UPDATE holds SET told_state = ? WHERE ref = ? AND released_at IS NULL")
      .run(state, ref);
  }

  /** How many briefs were written at or after `since`. */
  countBriefs(since: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM briefs WHERE at >= ?").get(since) as {
      n: number;
    };
    return row.n;
  }

  /** How many decisions of these kinds since `since`, optionally for one seat, ref or run. */
  countFlightDecisions(q: {
    kinds: readonly FlightDecisionKind[];
    since: number;
    seatId?: string;
    ref?: string;
    targetRunId?: string;
  }): number {
    if (q.kinds.length === 0) return 0;
    const where = [`kind IN (${q.kinds.map(() => "?").join(", ")})`, "at >= ?"];
    const args: SQLInputValue[] = [...q.kinds, q.since];
    if (q.seatId !== undefined) {
      where.push("seat_id = ?");
      args.push(q.seatId);
    }
    if (q.ref !== undefined) {
      where.push("ref = ?");
      args.push(q.ref);
    }
    if (q.targetRunId !== undefined) {
      where.push("target_run_id = ?");
      args.push(q.targetRunId);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM flight_decisions WHERE ${where.join(" AND ")}`)
      .get(...args) as { n: number };
    return row.n;
  }
}
