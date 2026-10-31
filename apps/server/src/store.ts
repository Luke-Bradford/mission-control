import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type {
  ItemChatMessage,
  ItemDiscussion,
  PersonMessage,
  PersonSource,
  PromptSection,
  PromptSectionCost,
  PromptWakeCost,
} from "@mc/core";
import {
  type AccountId,
  type AgentId,
  type AttentionBrief,
  type AttentionKind,
  AUDIT_BASELINE_DAYS,
  AUDIT_CHANGE_WINDOW_MS,
  AUDIT_PR_OUTLIER_LINES,
  AUDIT_REFUSAL_SPIKE,
  AUDIT_SPEND_OUTLIER_FACTOR,
  type AuditChange,
  type AuditMetrics,
  type AuditOveruseFacts,
  type AuditPrSize,
  type AuditRunKind,
  type AuditTokenOveruse,
  type AuditView,
  BLOCKING_SEVERITIES,
  type BoardItem,
  type BriefOption,
  type ChosenProfile,
  type CiRunView,
  COMMS_CAPCOM,
  COMMS_CHATTER_ROUNDS,
  COMMS_CHATTER_WINDOW_MS,
  COMMS_CREW,
  COMMS_MC,
  COMMS_TEXT_MAX,
  type CommsLabel,
  type CommsReaction,
  type CommsReactionKind,
  classifyOveruse,
  commsCutMarker,
  DECISION_DEFAULT_WAIT_MS,
  type DefectRefs,
  type DefectVia,
  type DoneWhenEntry,
  type Escalation,
  estimateTokens,
  type FindingResolution,
  type FLIGHT_HEADLINE,
  FLIGHT_INCOMING_LIMIT,
  FLIGHT_LEDGER_OPEN,
  FLIGHT_MEMORY_FULL,
  FLIGHT_MEMORY_TOPICS_MAX,
  FLIGHT_PLAN_LIMIT,
  FLIGHT_RETROSPECTIVE_SETTING,
  FLIGHT_SIGNALS_SETTING,
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
  type FlightPlanInput,
  type FlightPlanOperation,
  type FlightWakeRecord,
  type FlightWatchEntry,
  type FlightWatchOperation,
  type FlowIssue,
  type FlowPr,
  GUARD_HITS_LIMIT,
  GUARD_RULES,
  type GuardHit,
  type GuardRule,
  groupOveruse,
  type HealthRow,
  type HudColumn,
  type HudState,
  inferTicket,
  isBugLabelled,
  type LoopEvent,
  type LoopKind,
  linkEscapedDefect,
  type MachineSample,
  type MergedPrFacts,
  memoryTopicKey,
  overusePrevention,
  PROMPT_BYTES_PER_TOKEN,
  PROMPT_SECTIONS,
  type PrCheck,
  type PrFileInput,
  type ProfileOverride,
  type PrTestsView,
  type PrTitle,
  type PullRequestView,
  prCarries,
  QA_RETENTION_DAYS,
  type QaFindingView,
  type QaFlowView,
  type QaReviewRoundView,
  type ReadRecord,
  type ReplyDraft,
  type RepoGoal,
  type RepoId,
  type ReportedTest,
  type ReviewCheck,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewRow,
  type ReviewState,
  type ReviewVerdict,
  type Run,
  type RunDigest,
  type RunLoop,
  type RunStatus,
  reviewTimings,
  reworkRatios,
  type SeatSessionRow,
  type SeatState,
  type StoredFinding,
  type StrayKind,
  type Telemetry,
  type TestLockRun,
  TICKET_SIZES,
  TITLE_MARKERS,
  type TokenUsage,
  testsTouched,
  tokenBaselines,
  type UsageSample,
  validateMemoryNote,
  wakeKeyPrefix,
} from "@mc/core";

export const COMMS_RETENTION_DAYS = 90;
export const FLIGHT_DECISIONS_RETENTION_DAYS = 90;
export const HISTORY_BATCH_ROWS = 500;
export const HISTORY_SWEEP_MAX_BATCHES = 10;
export const LIVE_COMMS_LIMIT = 5_000;
export const LIVE_LOOP_EVENTS_LIMIT = 5_000;
export const OPERATIONAL_RETENTION_DAYS = 90;
export const AUDIT_RETENTION_DAYS = 365;

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
-- Map snapshot parts that never change for their key (a commit's tree and imports, a merge's files).
CREATE TABLE IF NOT EXISTS map_cache (
  kind TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (kind, scope, key)
);
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
-- A merged PR outlives the bounded live PR cache used by the board.
CREATE TABLE IF NOT EXISTS pr_history (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, merged_at INTEGER NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (repo_id, number)
);
CREATE INDEX IF NOT EXISTS pr_history_merged ON pr_history(repo_id, merged_at);
-- A PR's diff files as GitHub read them (first PR_FILES_MAX); the tests-per-PR count and the
-- file route of escaped defects read them.
CREATE TABLE IF NOT EXISTS pr_files (
  repo_id TEXT NOT NULL, pr_number INTEGER NOT NULL, path TEXT NOT NULL, change_type TEXT NOT NULL,
  PRIMARY KEY (repo_id, pr_number, path)
);
-- A bug filed after a PR merged that names it, a commit of it or a file only it changed. Kept
-- after the card leaves the board; seat and model are the PR branch's author run.
CREATE TABLE IF NOT EXISTS escaped_defects (
  repo_id TEXT NOT NULL, issue_number INTEGER NOT NULL, pr_number INTEGER NOT NULL,
  via TEXT NOT NULL, filed_at INTEGER NOT NULL, merged_at INTEGER NOT NULL, seat TEXT, model TEXT,
  PRIMARY KEY (repo_id, issue_number, pr_number)
);
CREATE INDEX IF NOT EXISTS escaped_defects_merged ON escaped_defects(merged_at);
CREATE TABLE IF NOT EXISTS retrospectives (
  repo_id TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, report TEXT NOT NULL,
  PRIMARY KEY (repo_id, day)
);
CREATE TABLE IF NOT EXISTS prompt_versions (
  hash TEXT PRIMARY KEY, path TEXT NOT NULL, first_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_sections (
  run_id TEXT NOT NULL, wake INTEGER NOT NULL, section TEXT NOT NULL,
  bytes INTEGER NOT NULL, tokens INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (run_id, wake, section)
);
CREATE INDEX IF NOT EXISTS prompt_sections_at ON prompt_sections(at);
CREATE TABLE IF NOT EXISTS flow_issues (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, size TEXT, start_at INTEGER,
  done_at INTEGER, PRIMARY KEY (repo_id, number)
);
CREATE TABLE IF NOT EXISTS flow_prs (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, merged_at INTEGER NOT NULL, first_push_ci TEXT,
  PRIMARY KEY (repo_id, number)
);
CREATE TABLE IF NOT EXISTS file_offsets (path TEXT PRIMARY KEY, offset INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS collector_status (
  collector TEXT PRIMARY KEY, ok INTEGER NOT NULL, error TEXT, at INTEGER NOT NULL,
  last_ok_at INTEGER, failing_since INTEGER
);
CREATE TABLE IF NOT EXISTS machine_samples (at INTEGER PRIMARY KEY, sample TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Acknowledged attention items. absent_since: when the key was first missing from the current
-- items (null while present); the ack is dropped once it has been absent for ACK_ABSENT_MS.
CREATE TABLE IF NOT EXISTS acks (key TEXT PRIMARY KEY, at INTEGER NOT NULL, absent_since INTEGER);
CREATE TABLE IF NOT EXISTS decision_defaults (
  key TEXT NOT NULL, brief_at INTEGER NOT NULL, option_id TEXT, label TEXT NOT NULL,
  due_at INTEGER NOT NULL, applied_at INTEGER NOT NULL, target TEXT, answer TEXT,
  delivered_at INTEGER, PRIMARY KEY (key, brief_at)
);
-- Status moves of a run's card (pending, then done or failed); the Activity page's board rows.
CREATE TABLE IF NOT EXISTS board_moves (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, repo_id TEXT NOT NULL, issue INTEGER NOT NULL,
  board_column TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS board_moves_at ON board_moves(at);
-- What a run's seat reported (append-only); the loop's reconciler reads the latest.
CREATE TABLE IF NOT EXISTS run_evidence (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, note TEXT NOT NULL, at INTEGER NOT NULL,
  tests TEXT NOT NULL DEFAULT '[]', tests_added TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS run_evidence_run ON run_evidence(run_id);
-- The ticket's Done-when lines as they stood when a run started; a report must answer each one.
CREATE TABLE IF NOT EXISTS run_done_when (
  run_id TEXT NOT NULL, pos INTEGER NOT NULL, line TEXT NOT NULL, PRIMARY KEY (run_id, pos)
);
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
  scenario TEXT NOT NULL, fix TEXT NOT NULL, category TEXT, state TEXT NOT NULL, UNIQUE (review_id, pos)
);
CREATE TABLE IF NOT EXISTS review_checks (
  review_id INTEGER NOT NULL, check_id TEXT NOT NULL, result TEXT NOT NULL, note TEXT,
  PRIMARY KEY (review_id, check_id)
);
CREATE TABLE IF NOT EXISTS review_tests (
  id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL, command TEXT NOT NULL, file TEXT,
  passed INTEGER NOT NULL, failed INTEGER NOT NULL, skipped INTEGER NOT NULL, duration INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS review_resolutions (
  review_id INTEGER NOT NULL, prior_review_id INTEGER NOT NULL, finding_pos INTEGER NOT NULL,
  outcome TEXT NOT NULL, PRIMARY KEY (review_id, prior_review_id, finding_pos)
);
-- One row per check run of a PR head, kept as the hub polled it: updated in place as it concludes.
CREATE TABLE IF NOT EXISTS ci_runs (
  repo_id TEXT NOT NULL, run_key TEXT NOT NULL, sha TEXT NOT NULL, name TEXT NOT NULL,
  attempt INTEGER NOT NULL, pr_number INTEGER NOT NULL, workflow TEXT, state TEXT NOT NULL,
  conclusion TEXT NOT NULL, url TEXT, first_seen_at INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, run_key)
);
CREATE INDEX IF NOT EXISTS ci_runs_at ON ci_runs(at);
-- A repo's milestones as GitHub last answered, replaced whole on each read.
CREATE TABLE IF NOT EXISTS milestones (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
  due_on INTEGER, open INTEGER NOT NULL, closed INTEGER NOT NULL, PRIMARY KEY (repo_id, number)
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
-- Each run's latest whole read of a large file, and what its refused re-reads saved (guard.ts rereadVerdict).
CREATE TABLE IF NOT EXISTS run_reads (
  run_id TEXT NOT NULL, agent_id TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
  compactions INTEGER NOT NULL, tool_use_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (run_id, agent_id, path)
);
CREATE TABLE IF NOT EXISTS run_rereads (
  run_id TEXT PRIMARY KEY, count INTEGER NOT NULL, tokens_saved INTEGER NOT NULL
);
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
-- A seat's ask_flight questions; answered_at is set by a message to the seat, or the run's end.
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
-- One row per hold, retained for QA_RETENTION_DAYS. outcome: pass or fail from the Post hook event.
CREATE TABLE IF NOT EXISTS test_lock_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seat_id TEXT NOT NULL,
  command TEXT NOT NULL, queued_at INTEGER NOT NULL, started_at INTEGER NOT NULL,
  ended_at INTEGER, outcome TEXT
);
CREATE INDEX IF NOT EXISTS test_lock_runs_started ON test_lock_runs(started_at);
-- A configured check a seat ran in its clone, on the head it ran against (the push gate reads it).
CREATE TABLE IF NOT EXISTS check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, command TEXT NOT NULL,
  invoked_command TEXT, head_sha TEXT NOT NULL, ok INTEGER NOT NULL, exit_code INTEGER, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS check_runs_run ON check_runs(run_id, command, head_sha);
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
-- One row per FLIGHT wake: the run it woke and the fact categories that woke it.
CREATE TABLE IF NOT EXISTS flight_wakes (
  run_id TEXT NOT NULL, at INTEGER NOT NULL, reasons TEXT NOT NULL, PRIMARY KEY (run_id, at)
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

const DAY_MS = 86_400_000;

/** The median of the values, or null when there are none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

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

/** A seat's open `ask_flight` question. */
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
  const dir = crewDirPath(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Where `crewDir` is, without making it. */
export function crewDirPath(dbPath: string): string {
  return join(dirname(dbPath), "crew");
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
  crewDir(dbPath);
  return crewKeeperDirPath(dbPath, runId);
}

/** Where `crewKeeperDir` is, without making `crew/`. */
export function crewKeeperDirPath(dbPath: string, runId: string): string {
  const hex = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return join(crewDirPath(dbPath), `k-${hex}`);
}

/** Codex thread storage survives replacement of the run's keeper. */
export function crewCodexDir(dbPath: string, runId: string): string {
  const hex = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return join(crewDir(dbPath), `codex-${hex}`);
}

export const CREW_CODEX_DIR = /^codex-[0-9a-f]{12}$/;

/**
 * A Claude run's skills plugin folder (`--plugin-dir`), built by the hub from the repo's commit. It
 * sits in the data dir, which the seat's sandbox cannot write, and is removed with the run's files.
 */
export function crewSkillsDir(dbPath: string, runId: string): string {
  const hex = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return join(crewDir(dbPath), `skills-${hex}`);
}

export const CREW_SKILLS_DIR = /^skills-[0-9a-f]{12}$/;

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
  column: HudColumn;
  state: BoardMoveState;
  detail: string | null;
  at: number;
}

/** How much of a link's newest message `commsLinkCounts` returns (the graph's hover preview). */
const COMMS_LINK_PREVIEW = 200;
/** One direction of a Comms link over a window, with its newest message. */
export interface CommsLinkCount {
  from: string;
  to: string;
  count: number;
  lastId: string;
  lastAt: number;
  lastText: string;
  tokens: number;
}

/** Who a seat line is from. */
/** A hand-off between agents; `from` and `to` are seat ids, COMMS_CAPCOM or COMMS_MC. */
export interface CommsRow {
  id: string;
  at: number;
  from: string;
  to: string;
  ticket: string | null;
  text: string;
  label: CommsLabel | null;
  ref: string | null;
  replyTo: string | null;
  mentions: string[];
}
/** A slice of stored Comms: the crew channel, one pair, everything a seat sent or got, or its inbox. */
export type CommsReadScope =
  | { crew: true }
  | { pair: readonly [string, string] }
  | { agent: string }
  | { inbox: string };
export interface NewCommsRow {
  at: number;
  from: string;
  to: string;
  ticket: string | null;
  text: string;
  label?: CommsLabel | null;
  ref?: string | null;
  replyTo?: string | null;
  targetRunId?: string | null;
  mentions?: readonly string[];
}

/** A FLIGHT settlement of a stale Comms question or blocker. */
export interface CommsSettlement {
  messageId: string;
  settledBy: string;
  reason: string;
  at: number;
}

function cutCommsText(text: string): string {
  const chars = Array.from(text);
  return chars.length > COMMS_TEXT_MAX
    ? `${chars.slice(0, COMMS_TEXT_MAX).join("")}${commsCutMarker(COMMS_TEXT_MAX, chars.length)}`
    : text;
}

/** Parse the sole external representation of a stored Comms message ID. */
export function commsMessageNumber(id: string): number | null {
  const match = /^comms:(\d+)$/.exec(id);
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
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
  tests: ReportedTest[];
  testsAdded: { file: string; failedOnBase: boolean }[];
  /** The author's answer to each of the ticket's Done-when lines; empty for an older report. */
  doneWhen: DoneWhenEntry[];
}

const evidenceOf = (r: Row): Evidence => ({
  id: r.id as number,
  runId: r.run_id as string,
  note: r.note as string,
  at: r.at as number,
  tests: JSON.parse(r.tests as string) as ReportedTest[],
  testsAdded: JSON.parse(r.tests_added as string) as Evidence["testsAdded"],
  doneWhen: JSON.parse(r.done_when as string) as DoneWhenEntry[],
});

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
  "blocked" | "review" | "ready" | "flag" | "ratelimit" | "question" | "approval"
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
  ...(r.account_id == null ? {} : { accountId: r.account_id as AccountId }),
  ...(r.effort == null ? {} : { effort: r.effort as string }),
  ...(r.loop_kind == null ? {} : { loopKind: r.loop_kind as LoopKind }),
  ...(r.prompt_hash == null ? {} : { promptHash: r.prompt_hash as string }),
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
  lastTurnStartedAt: (r.last_turn_started_at as number | null | undefined) ?? null,
  quietTurns: (r.quiet_turns as number | null | undefined) ?? 0,
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
  private readonly rawDb: DatabaseSync;
  /** Statements used by read-heavy views stay prepared for this Store's lifetime. */
  private readonly statements = new Map<string, StatementSync>();

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.rawDb.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** `busyTimeoutMs` is shortened only by tests that hold a lock on purpose. */
  /** The database file. */
  readonly path: string;

  constructor(path: string, busyTimeoutMs = BUSY_TIMEOUT_MS) {
    this.path = path;
    // Wait up to the timeout for another writer's lock instead of failing at once.
    this.rawDb = new DatabaseSync(path, { timeout: busyTimeoutMs });
    // Store has many small methods. Cache every SQL text here so callers cannot accidentally
    // prepare the same statement on each HUD build.
    this.db = new Proxy(this.rawDb, {
      get: (target, property) => {
        if (property === "prepare") return (sql: string) => this.statement(sql);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
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
    this.backfillAuditHistory();
  }

  /** One-time-safe reconstruction from sources that already survived retention. */
  private backfillAuditHistory(): void {
    this.transaction(() => {
      const merged = this.pullRequestRows(
        this.db.prepare("SELECT * FROM pull_requests WHERE merged_at IS NOT NULL").all() as Row[],
      );
      const addPr = this.db.prepare(
        "INSERT OR IGNORE INTO pr_history (repo_id, number, merged_at, record) VALUES (?, ?, ?, ?)",
      );
      for (const pr of merged) addPr.run(pr.repoId, pr.number, pr.mergedAt, JSON.stringify(pr));
      const saved = this.db
        .prepare("SELECT key, value FROM settings WHERE key GLOB ?")
        .all(`${FLIGHT_RETROSPECTIVE_SETTING}:*`) as { key: string; value: string }[];
      const addReport = this.db.prepare(
        "INSERT OR IGNORE INTO retrospectives (repo_id, day, at, report) VALUES (?, ?, ?, ?)",
      );
      for (const row of saved) {
        try {
          const value = JSON.parse(row.value) as { day?: unknown; report?: { at?: unknown } };
          const repoId = row.key.slice(`${FLIGHT_RETROSPECTIVE_SETTING}:`.length);
          if (typeof value.day === "string" && typeof value.report?.at === "number")
            addReport.run(repoId, value.day, value.report.at, JSON.stringify(value.report));
        } catch {
          // A malformed settings value must not prevent the hub from opening.
        }
      }
    });
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
    this.statements.clear();
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
    // Flow now retains open work for the cumulative-flow chart. SQLite cannot drop NOT NULL in
    // place, so reconstruct databases created before open rows were recorded.
    const flowDone = this.db.prepare("PRAGMA table_info(flow_issues)").all() as Row[];
    if (flowDone.find((column) => column.name === "done_at")?.notnull === 1) {
      this.transaction(() => {
        const current = this.db.prepare("PRAGMA table_info(flow_issues)").all() as Row[];
        if (current.find((column) => column.name === "done_at")?.notnull !== 1) return;
        this.db.exec(`
          ALTER TABLE flow_issues RENAME TO flow_issues_before_open_work;
          CREATE TABLE flow_issues (
            repo_id TEXT NOT NULL, number INTEGER NOT NULL, size TEXT, start_at INTEGER,
            done_at INTEGER, PRIMARY KEY (repo_id, number)
          );
          INSERT INTO flow_issues (repo_id, number, size, start_at, done_at)
            SELECT repo_id, number, size, start_at, done_at FROM flow_issues_before_open_work;
          DROP TABLE flow_issues_before_open_work;
        `);
      }, true);
    }
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
    // When a failing collector began failing; a row failing at upgrade takes its next poll's time.
    this.addColumn("collector_status", "failing_since", "INTEGER");
    this.whenColumnMissing("check_runs", "invoked_command", () => {
      this.db.exec("ALTER TABLE check_runs ADD COLUMN invoked_command TEXT");
      this.db.exec("UPDATE check_runs SET invoked_command = command WHERE invoked_command IS NULL");
    });
    this.addColumn("check_runs", "exit_code", "INTEGER");
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
    // What the issue body waits on (`{ issues, prs }` JSON), null for none; the next poll fills it.
    this.addColumn("board_items", "after_deps", "TEXT");
    // What a bug card's body names (`{ prs, shas, paths }` JSON), null for none.
    this.addColumn("board_items", "defect_refs", "TEXT");
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
      ["account_id", "TEXT"],
      ["effort", "TEXT"],
      ["prompt_hash", "TEXT"],
      // The seat's loop kind at the start; `upsertRun` keeps the first value.
      ["loop_kind", "TEXT"],
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
      CREATE INDEX IF NOT EXISTS runs_loop_aside ON runs(ended_at, json_extract(loop, '$.aside'), started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_loop_merging ON runs(ended_at, json_extract(loop, '$.merging'), started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_merging_started ON runs(json_extract(loop, '$.merging'), started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_agent_aside_worktree ON runs(agent_id, json_extract(loop, '$.aside.worktree'));
      CREATE INDEX IF NOT EXISTS runs_ended_started ON runs(ended_at, started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_loop_pr_number ON runs(json_extract(loop, '$.prNumber'));
      CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
      CREATE INDEX IF NOT EXISTS attention_notes_open ON attention_notes(cleared_at, at, key);
      CREATE INDEX IF NOT EXISTS attention_notes_run_open ON attention_notes(run_id, cleared_at, key);
      CREATE INDEX IF NOT EXISTS pull_requests_ticket ON pull_requests(ticket, updated_at DESC);
      CREATE INDEX IF NOT EXISTS reviews_ended ON reviews(ended_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS attention_episodes_cleared ON attention_episodes(cleared_at);
      CREATE INDEX IF NOT EXISTS drafts_state_created ON drafts(state, created_at);
      CREATE INDEX IF NOT EXISTS crew_errors_acked_at ON crew_errors(acked, at);
      CREATE INDEX IF NOT EXISTS pr_history_at ON pr_history(merged_at);
      CREATE INDEX IF NOT EXISTS review_tests_review ON review_tests(review_id);
      CREATE INDEX IF NOT EXISTS seat_questions_answered ON seat_questions(answered_at);
    `);
    // 0 / null: stored before the card ids were read; the next GitHub poll fills them.
    this.addColumn("board_items", "created_at", "INTEGER NOT NULL DEFAULT 0");
    // When the seat's last turn ended; the engine's quiet-seat check reads it.
    this.addColumn("seat_sessions", "last_turn_ended_at", "INTEGER");
    this.addColumn("seat_sessions", "last_turn_started_at", "INTEGER");
    this.addColumn("seat_sessions", "error_since", "INTEGER");
    // Turns in a row that ended with no new commit; the resume line reads it.
    this.addColumn("seat_sessions", "quiet_turns", "INTEGER NOT NULL DEFAULT 0");
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
    this.addColumn("decision_defaults", "target", "TEXT");
    this.addColumn("decision_defaults", "answer", "TEXT");
    this.addColumn("decision_defaults", "delivered_at", "INTEGER");
    this.addColumn("pull_requests", "head_sha", "TEXT");
    this.addColumn("pull_requests", "merge_commit_sha", "TEXT");
    this.addColumn("pull_requests", "mergeable", "TEXT");
    // Who opened the PR and who is assigned: a PR run by another hub's login is that lane's.
    this.addColumn("pull_requests", "author", "TEXT");
    this.addColumn("pull_requests", "assignees", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("pull_requests", "checks", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("run_evidence", "tests", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("run_evidence", "tests_added", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("run_evidence", "done_when", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("reviews", "changed_since", "TEXT");
    this.addColumn("review_findings", "late", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("review_findings", "category", "TEXT");
    this.addColumn("review_findings", "resolution", "TEXT");
    this.addColumn("review_findings", "resolved_review_id", "INTEGER");
    // Old PRs keep []: followPrs falls back to their ticket, even without another GitHub poll.
    this.addColumn("pull_requests", "closing_issues", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("pull_requests", "additions", "INTEGER");
    this.addColumn("pull_requests", "deletions", "INTEGER");
    this.addColumn("pull_requests", "changed_files", "INTEGER");
    // The branch the PR merges into: another open PR's branch means it is stacked on that PR.
    this.addColumn("pull_requests", "base", "TEXT");
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
    // Stored Comms v2 is deliberately additive: hubs can open databases written by older hubs.
    this.addColumn(
      "comms",
      "label",
      "TEXT CHECK (label IS NULL OR label IN ('question','handoff','blocker'))",
    );
    this.addColumn("comms", "ref", "TEXT");
    this.addColumn("comms", "reply_to", "INTEGER");
    this.addColumn("comms", "target_run_id", "TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS comms_target_run ON comms(target_run_id, at, id);
      CREATE INDEX IF NOT EXISTS comms_ticket ON comms(ticket, at, id);
      CREATE INDEX IF NOT EXISTS comms_ref ON comms(ref, at, id);
      CREATE INDEX IF NOT EXISTS comms_reply_to ON comms(reply_to);
      CREATE TABLE IF NOT EXISTS comms_mentions (
        message_id INTEGER NOT NULL, mentioned_id TEXT NOT NULL, seen_at INTEGER,
        PRIMARY KEY (message_id, mentioned_id)
      );
      CREATE INDEX IF NOT EXISTS comms_mentions_target ON comms_mentions(mentioned_id, seen_at, message_id);
      CREATE TABLE IF NOT EXISTS comms_reactions (
        message_id INTEGER NOT NULL, actor_id TEXT NOT NULL, reaction TEXT NOT NULL
          CHECK (reaction IN ('seen','on_it','done','cant')),
        reason TEXT, at INTEGER NOT NULL,
        CHECK ((reaction = 'cant' AND length(trim(reason)) BETWEEN 1 AND 80)
          OR (reaction != 'cant' AND reason IS NULL)),
        PRIMARY KEY (message_id, actor_id)
      );
      CREATE INDEX IF NOT EXISTS comms_reactions_message ON comms_reactions(message_id);
      CREATE TABLE IF NOT EXISTS comms_settlements (
        message_id INTEGER PRIMARY KEY, settled_by TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comms_pins (
        message_id INTEGER PRIMARY KEY, pinned_by TEXT NOT NULL, pinned_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comms_inbox_reads (
        seat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
        PRIMARY KEY (seat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS comms_inbox_reads_message ON comms_inbox_reads(message_id);
      CREATE TRIGGER IF NOT EXISTS comms_reactions_valid_insert
      BEFORE INSERT ON comms_reactions
      WHEN (NEW.reaction = 'cant' AND (NEW.reason IS NULL OR length(trim(NEW.reason)) NOT BETWEEN 1 AND 80))
        OR (NEW.reaction != 'cant' AND NEW.reason IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'invalid Comms reaction reason'); END;
      CREATE TRIGGER IF NOT EXISTS comms_reactions_valid_update
      BEFORE UPDATE OF reaction, reason ON comms_reactions
      WHEN (NEW.reaction = 'cant' AND (NEW.reason IS NULL OR length(trim(NEW.reason)) NOT BETWEEN 1 AND 80))
        OR (NEW.reaction != 'cant' AND NEW.reason IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'invalid Comms reaction reason'); END;
    `);
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
           ticket_title, review_id, cli_version, profile, profile_hash, plan, vendor, latest_plan,
           account_id, effort, prompt_hash, loop_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_id = excluded.agent_id, repo_id = excluded.repo_id, seq = excluded.seq,
           started_at = excluded.started_at, ended_at = excluded.ended_at, status = excluded.status,
           session_id = excluded.session_id, model = excluded.model, branch = excluded.branch,
           ticket = excluded.ticket, cost_usd = excluded.cost_usd, tokens = excluded.tokens,
           transcript_path = excluded.transcript_path, prs = excluded.prs,
           summary = excluded.summary, folded = MAX(folded, excluded.folded),
           ticket_title = COALESCE(excluded.ticket_title, ticket_title),
           cli_version = COALESCE(excluded.cli_version, cli_version),
           latest_plan = COALESCE(excluded.latest_plan, latest_plan),
           account_id = COALESCE(account_id, excluded.account_id),
           effort = COALESCE(effort, excluded.effort),
           prompt_hash = COALESCE(prompt_hash, excluded.prompt_hash),
           loop_kind = COALESCE(loop_kind, excluded.loop_kind)`,
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
        r.accountId ?? null,
        r.effort ?? null,
        r.promptHash ?? null,
        r.loopKind ?? null,
      );
  }

  /**
   * Gives runs stored before `loop_kind` existed the loop kind of their seat as configured now, so
   * a seat removed later still shows as a build seat in Audit. A run that has one keeps it.
   * Returns how many rows it set.
   */
  backfillRunLoopKinds(kinds: ReadonlyMap<string, LoopKind>): number {
    const set = this.db.prepare(
      "UPDATE runs SET loop_kind = ? WHERE agent_id = ? AND loop_kind IS NULL AND review_id IS NULL",
    );
    let n = 0;
    for (const [agentId, kind] of kinds) n += Number(set.run(kind, agentId).changes);
    return n;
  }

  /** Completes immutable launch metadata once the generated prompt file exists. */
  setRunPromptVersion(runId: string, hash: string, path: string, at: number): void {
    this.db
      .prepare("UPDATE runs SET prompt_hash = COALESCE(prompt_hash, ?) WHERE id = ?")
      .run(hash, runId);
    this.db
      .prepare("INSERT OR IGNORE INTO prompt_versions (hash, path, first_seen) VALUES (?, ?, ?)")
      .run(hash, path, at);
  }

  /** What one prompt took, by section; a wake recorded twice keeps its first rows. */
  recordPromptSections(
    runId: string,
    wake: number,
    at: number,
    sections: readonly PromptSectionCost[],
  ): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO prompt_sections (run_id, wake, section, bytes, tokens, at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const s of sections) insert.run(runId, wake, s.section, s.bytes, s.tokens, at);
  }

  /** Adds tool-result bytes to the run's latest wake (wake 0 when none is recorded). */
  addToolResultBytes(runId: string, bytes: number, at: number): void {
    const last = this.db
      .prepare(
        `SELECT wake, MIN(at) AS at FROM prompt_sections WHERE run_id = ?
         AND wake = (SELECT MAX(wake) FROM prompt_sections WHERE run_id = ?)`,
      )
      .get(runId, runId) as { wake: number | null; at: number | null };
    const wake = last.wake ?? 0;
    const section: PromptSection = "tool_results";
    this.db
      .prepare(
        `INSERT INTO prompt_sections (run_id, wake, section, bytes, tokens, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, wake, section) DO UPDATE SET bytes = bytes + excluded.bytes,
           tokens = CAST(ROUND((bytes + excluded.bytes) / ${PROMPT_BYTES_PER_TOKEN}.0) AS INTEGER)`,
      )
      .run(runId, wake, section, bytes, estimateTokens(bytes), last.at ?? at);
  }

  private wakesOf(
    rows: {
      run_id: string;
      wake: number;
      section: PromptSection;
      bytes: number;
      tokens: number;
      at: number;
    }[],
  ): PromptWakeCost[] {
    const wakes = new Map<string, PromptWakeCost>();
    for (const r of rows) {
      const key = `${r.run_id}\0${r.wake}`;
      let w = wakes.get(key);
      if (w === undefined) {
        w = { runId: r.run_id, wake: r.wake, at: r.at, sections: [] };
        wakes.set(key, w);
      }
      w.at = Math.min(w.at, r.at);
      w.sections.push({ section: r.section, bytes: r.bytes, tokens: r.tokens });
    }
    for (const w of wakes.values()) {
      w.sections.sort(
        (a, b) => PROMPT_SECTIONS.indexOf(a.section) - PROMPT_SECTIONS.indexOf(b.section),
      );
    }
    return [...wakes.values()];
  }

  /** A run's prompts by section, oldest first. */
  promptWakes(runId: string): PromptWakeCost[] {
    return this.wakesOf(
      this.db
        .prepare("SELECT * FROM prompt_sections WHERE run_id = ? ORDER BY wake")
        .all(runId) as never,
    );
  }

  /** An agent's prompts since `since`, newest first, at most `limit` wakes. */
  agentPromptWakes(agentId: string, since: number, limit: number): PromptWakeCost[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM prompt_sections p JOIN runs r ON r.id = p.run_id
         WHERE r.agent_id = ? AND p.at >= ?`,
      )
      .all(agentId, since) as never;
    return this.wakesOf(rows)
      .sort((a, b) => b.at - a.at || b.wake - a.wake)
      .slice(0, limit);
  }

  /** Records a running Codex CLI's version without allowing a stale launch to revive its run. */
  setRunCliVersionIfLive(runId: string, cliVersion: string): boolean {
    return (
      this.db
        .prepare("UPDATE runs SET cli_version = ? WHERE id = ? AND ended_at IS NULL")
        .run(cliVersion, runId).changes === 1
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
    const rows = this.statement(
      "SELECT * FROM runs WHERE agent_id = ? ORDER BY started_at DESC, seq DESC LIMIT ?",
    ).all(agentId, limit) as Row[];
    return rows.map(toRun);
  }

  /** Recent runs for many HUD rows, ranked in SQLite so the runs table is read once. */
  runsForAgents(
    agentIds: readonly AgentId[],
    limit: number,
    heldRunIds: readonly string[] = [],
  ): Map<AgentId, Run[]> {
    const out = new Map<AgentId, Run[]>();
    if (agentIds.length === 0) return out;
    for (const agentId of agentIds) out.set(agentId, []);
    const held = [...new Set(heldRunIds)];
    const rows = this.statement(
      `SELECT * FROM (
         SELECT runs.*, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY started_at DESC, seq DESC) AS row_number
         FROM runs WHERE agent_id IN (${agentIds.map(() => "?").join(", ")})${held.length > 0 ? ` OR id IN (${held.map(() => "?").join(", ")})` : ""}
       ) WHERE row_number <= ?${held.length > 0 ? ` OR id IN (${held.map(() => "?").join(", ")})` : ""}`,
    ).all(...agentIds, ...held, limit, ...held) as Row[];
    for (const run of rows.map(toRun)) {
      const runs = out.get(run.agentId) ?? [];
      runs.push(run);
      out.set(run.agentId, runs);
    }
    return out;
  }

  /** Set-aside runs retain their unmerged map scope after a seat takes another ticket. */
  mapAsideRuns(agentId: AgentId): Run[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM runs WHERE agent_id = ? AND json_extract(loop, '$.aside.worktree') > ''",
        )
        .all(agentId) as Row[]
    ).map(toRun);
  }

  /** Runs still open or ended at or after `since`, across seats and repos. */
  runsActiveSince(since: number): Run[] {
    const rows = this.db
      .prepare(`SELECT * FROM (
        SELECT * FROM runs INDEXED BY runs_ended_started WHERE ended_at IS NULL
        UNION ALL
        SELECT * FROM runs INDEXED BY runs_ended_started WHERE ended_at >= ?
      ) ORDER BY started_at, seq`)
      .all(since) as Row[];
    return rows.map(toRun);
  }

  /** Every recorded run on a branch; review ordering needs merged predecessors too. */
  runsOnBranch(repoId: RepoId, branch: string): Run[] {
    return (
      this.db
        .prepare("SELECT * FROM runs WHERE repo_id = ? AND branch = ? ORDER BY started_at, seq")
        .all(repoId, branch) as Row[]
    ).map(toRun);
  }

  /** Outstanding runs and ended runs with recorded PR merge steps for the away digest. */
  runsForAwayDigest(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM runs WHERE ended_at IS NULL
           UNION ALL
           SELECT * FROM runs INDEXED BY runs_merging_started
             WHERE json_extract(loop, '$.merging') > '' AND ended_at IS NOT NULL
         ) ORDER BY started_at, seq`,
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
        `SELECT * FROM (
           SELECT * FROM runs WHERE loop IS NOT NULL AND ended_at IS NULL
           UNION ALL
           SELECT * FROM runs INDEXED BY runs_ended_started WHERE loop IS NOT NULL AND ended_at >= ?
             AND (json_extract(loop, '$.phase') != 'done'
               OR json_extract(loop, '$.merging') > '')
         ) ORDER BY started_at, seq`,
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

  /**
   * True while crew work stands at the machine guard or has just passed it: a queued ticket, a
   * queued review, or a ticket run (a review's included) that has not ended and is not set aside.
   */
  hasPendingStart(): boolean {
    const found = (sql: string, ...params: string[]): boolean =>
      this.db.prepare(sql).get(...params) !== undefined;
    return (
      found("SELECT 1 FROM queues WHERE taken_at IS NULL LIMIT 1") ||
      found("SELECT 1 FROM reviews WHERE state = ? LIMIT 1", "queued") ||
      found(
        "SELECT 1 FROM runs WHERE ended_at IS NULL AND ticket IS NOT NULL AND (loop IS NULL OR json_extract(loop, '$.aside') IS NULL) LIMIT 1",
      )
    );
  }

  /** True while a run has not ended and is not set aside (waiting on a review, CI or a merge). */
  hasActiveRun(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM runs WHERE ended_at IS NULL AND (loop IS NULL OR json_extract(loop, '$.aside') IS NULL) LIMIT 1",
        )
        .get() !== undefined
    );
  }

  /**
   * The newest run (ended or not, not a review) on `branch`, which owns that branch's ticket:
   * `agentId`'s own run first, any seat's otherwise.
   */
  latestRunOnBranch(repoId: RepoId, branch: string, agentId?: AgentId): Run | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE repo_id = ? AND branch = ? AND review_id IS NULL
         ORDER BY (agent_id = ?) DESC, started_at DESC, id DESC LIMIT 1`,
      )
      .get(repoId, branch, agentId ?? "") as Row | undefined;
    return row ? toRun(row) : null;
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

  mapCacheGet(kind: string, scope: string, key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM map_cache WHERE kind = ? AND scope = ? AND key = ?")
      .get(kind, scope, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Stores a map cache row; `exclusive` drops the kind and scope's other rows (superseded keys). */
  mapCachePut(kind: string, scope: string, key: string, value: string, exclusive: boolean): void {
    this.transaction(() => {
      if (exclusive)
        this.db
          .prepare("DELETE FROM map_cache WHERE kind = ? AND scope = ? AND key <> ?")
          .run(kind, scope, key);
      this.db
        .prepare(
          `INSERT INTO map_cache (kind, scope, key, value) VALUES (?, ?, ?, ?)
           ON CONFLICT(kind, scope, key) DO UPDATE SET value = excluded.value`,
        )
        .run(kind, scope, key, value);
    });
  }

  digest(runId: string): RunDigest | null {
    const row = this.db.prepare("SELECT digest FROM run_digests WHERE run_id = ?").get(runId) as
      | { digest: string }
      | undefined;
    if (!row) return null;
    return this.withRereads(parseDigest(row.digest), this.rereads([runId]).get(runId));
  }

  private withRereads(d: RunDigest, r: RunDigest["rereads"]): RunDigest {
    return r ? { ...d, rereads: r } : d;
  }

  /** Refused re-reads per run (those with any): how many, and the tokens they are estimated to have saved. */
  private rereads(runIds: string[]): Map<string, NonNullable<RunDigest["rereads"]>> {
    const out = new Map<string, NonNullable<RunDigest["rereads"]>>();
    for (let i = 0; i < runIds.length; i += DIGEST_BATCH) {
      const ids = runIds.slice(i, i + DIGEST_BATCH);
      const rows = this.statement(
        `SELECT run_id, count, tokens_saved FROM run_rereads WHERE run_id IN (${ids.map(() => "?").join(", ")})`,
      ).all(...ids) as { run_id: string; count: number; tokens_saved: number }[];
      for (const r of rows) out.set(r.run_id, { count: r.count, tokensSaved: r.tokens_saved });
    }
    return out;
  }

  /** The run's earlier whole read of `path` by `agentId` ('' is the seat), if it made one. */
  runRead(runId: string, agentId: string, path: string): ReadRecord | undefined {
    const r = this.db
      .prepare(
        "SELECT size, mtime_ms, compactions, tool_use_id, at FROM run_reads WHERE run_id = ? AND agent_id = ? AND path = ?",
      )
      .get(runId, agentId, path) as
      | { size: number; mtime_ms: number; compactions: number; tool_use_id: string; at: number }
      | undefined;
    return (
      r && {
        size: r.size,
        mtimeMs: r.mtime_ms,
        compactions: r.compactions,
        toolUseId: r.tool_use_id,
        at: r.at,
      }
    );
  }

  /** Remembers the run's whole read of `path`, replacing an earlier one. */
  setRunRead(runId: string, agentId: string, path: string, r: ReadRecord): void {
    this.db
      .prepare(
        `INSERT INTO run_reads (run_id, agent_id, path, size, mtime_ms, compactions, tool_use_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, agent_id, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
           compactions = excluded.compactions, tool_use_id = excluded.tool_use_id, at = excluded.at`,
      )
      .run(runId, agentId, path, r.size, r.mtimeMs, r.compactions, r.toolUseId, r.at);
  }

  /** Forgets the whole read made by tool call `toolUseId`, as when that call failed. */
  forgetRunRead(runId: string, toolUseId: string): void {
    this.db
      .prepare("DELETE FROM run_reads WHERE run_id = ? AND tool_use_id = ?")
      .run(runId, toolUseId);
  }

  /** Counts one refused re-read that saved about `tokens`. */
  addReread(runId: string, tokens: number): void {
    this.db
      .prepare(
        `INSERT INTO run_rereads (run_id, count, tokens_saved) VALUES (?, 1, ?)
         ON CONFLICT(run_id) DO UPDATE SET count = count + 1, tokens_saved = tokens_saved + excluded.tokens_saved`,
      )
      .run(runId, tokens);
  }

  digests(runIds: string[]): Map<string, RunDigest> {
    const out = new Map<string, RunDigest>();
    for (let i = 0; i < runIds.length; i += DIGEST_BATCH) {
      const ids = runIds.slice(i, i + DIGEST_BATCH);
      const rows = this.statement(
        `SELECT run_id, digest FROM run_digests WHERE run_id IN (${ids.map(() => "?").join(", ")})`,
      ).all(...ids) as { run_id: string; digest: string }[];
      for (const r of rows) out.set(r.run_id, parseDigest(r.digest));
    }
    for (const [id, r] of this.rereads(runIds)) {
      const d = out.get(id);
      if (d) out.set(id, this.withRereads(d, r));
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
      column: r.board_column as HudColumn,
      state: r.state as BoardMoveState,
      detail: r.detail as string | null,
      at: r.at as number,
    };
  }

  /** Each agent's state after its latest recorded change. */
  latestAgentStates(): Map<AgentId, HudState> {
    const rows = this.statement(
      `SELECT agent_id, to_state FROM agent_events e
         WHERE at = (SELECT MAX(at) FROM agent_events WHERE agent_id = e.agent_id)`,
    ).all() as Row[];
    return new Map(rows.map((r) => [r.agent_id as AgentId, r.to_state as HudState]));
  }

  private historyNextTable = 0;
  private operationalHistoryNextTable = 0;

  /** Retain live work; expiry starts at completion, with bounded transactions and sweep cost. */
  async pruneHistory(now: number): Promise<void> {
    const day = 24 * 60 * 60_000;
    this.db.prepare("DELETE FROM ci_runs WHERE at < ?").run(now - QA_RETENTION_DAYS * day);
    this.db
      .prepare("DELETE FROM escaped_defects WHERE merged_at < ?")
      .run(now - QA_RETENTION_DAYS * day);
    this.db
      .prepare(
        `DELETE FROM pr_files WHERE NOT EXISTS (
           SELECT 1 FROM pull_requests p WHERE p.repo_id = pr_files.repo_id AND p.number = pr_files.pr_number)
         AND NOT EXISTS (
           SELECT 1 FROM pr_history h WHERE h.repo_id = pr_files.repo_id AND h.number = pr_files.pr_number
             AND h.merged_at >= ?)`,
      )
      .run(now - QA_RETENTION_DAYS * day);
    let batches = 0;
    // These rows are operational traces, not durable Audit and QA records. One bounded batch per
    // table keeps an upgrade's first maintenance pass within the same sweep budget as run history.
    const operationalTables = [
      ["attention_notes", "cleared_at IS NOT NULL AND cleared_at < ?", OPERATIONAL_RETENTION_DAYS],
      [
        "attention_episodes",
        "cleared_at IS NOT NULL AND cleared_at < ?",
        OPERATIONAL_RETENTION_DAYS,
      ],
      [
        "board_moves",
        `at < ? AND state IN ('done', 'failed') AND EXISTS (
          SELECT 1 FROM runs r WHERE r.id = board_moves.run_id AND r.ended_at IS NOT NULL)`,
        OPERATIONAL_RETENTION_DAYS,
      ],
      ["guard_hits", "at < ?", OPERATIONAL_RETENTION_DAYS],
      ["hub_events", "at < ?", OPERATIONAL_RETENTION_DAYS],
      ["flight_wakes", "at < ?", OPERATIONAL_RETENTION_DAYS],
      ["seat_questions", "answered_at IS NOT NULL AND answered_at < ?", OPERATIONAL_RETENTION_DAYS],
      ["drafts", "created_at < ? AND state != 'pending'", OPERATIONAL_RETENTION_DAYS],
      ["crew_errors", "acked = 1 AND at < ?", OPERATIONAL_RETENTION_DAYS],
      [
        "briefs",
        `at < ? AND NOT (
          id = (SELECT MAX(current.id) FROM briefs current WHERE current.key = briefs.key)
          AND EXISTS (SELECT 1 FROM attention_notes n WHERE n.key = briefs.key AND n.cleared_at IS NULL)
        )`,
        OPERATIONAL_RETENTION_DAYS,
      ],
      [
        "reviews",
        `ended_at IS NOT NULL AND ended_at < ? AND state IN ('reported', 'failed', 'superseded')
         AND NOT (state = 'reported' AND EXISTS (
           SELECT 1 FROM pull_requests p
           WHERE p.repo_id = reviews.repo_id AND p.number = reviews.pr_number AND p.state = 'open'
         ))`,
        AUDIT_RETENTION_DAYS,
      ],
      [
        "runs",
        `ended_at IS NOT NULL AND ended_at < ? AND NOT EXISTS (
          SELECT 1 FROM reviews v WHERE v.author_run_id = runs.id OR v.run_id = runs.id
        )`,
        AUDIT_RETENTION_DAYS,
      ],
      ["pr_history", "merged_at < ?", AUDIT_RETENTION_DAYS],
    ] as const;
    const operationalIndex = this.operationalHistoryNextTable % operationalTables.length;
    const [table, condition, retentionDays] = operationalTables[operationalIndex];
    this.operationalHistoryNextTable = (operationalIndex + 1) % operationalTables.length;
    if (batches < HISTORY_SWEEP_MAX_BATCHES) {
      const ids = this.db
        .prepare(`SELECT rowid AS id FROM ${table} WHERE ${condition} ORDER BY rowid LIMIT ?`)
        .all(now - retentionDays * day, HISTORY_BATCH_ROWS) as { id: number }[];
      if (ids.length > 0) {
        this.transaction(() => {
          if (table === "reviews") {
            const marks = ids.map(() => "?").join(",");
            this.db
              .prepare(`DELETE FROM review_checks WHERE review_id IN (${marks})`)
              .run(...ids.map(({ id }) => id));
            this.db
              .prepare(`DELETE FROM review_tests WHERE review_id IN (${marks})`)
              .run(...ids.map(({ id }) => id));
            this.db
              .prepare(`DELETE FROM review_resolutions WHERE review_id IN (${marks})`)
              .run(...ids.map(({ id }) => id));
            this.db
              .prepare(`DELETE FROM review_findings WHERE review_id IN (${marks})`)
              .run(...ids.map(({ id }) => id));
          }
          if (table === "runs") {
            const marks = ids.map(() => "?").join(",");
            const runIds = this.db
              .prepare(`SELECT id FROM runs WHERE rowid IN (${marks})`)
              .all(...ids.map(({ id }) => id)) as { id: string }[];
            const values = runIds.map(({ id }) => id);
            if (values.length > 0) {
              const runMarks = values.map(() => "?").join(",");
              for (const child of [
                "run_commits",
                "run_pushes",
                "run_attempts",
                "run_digests",
                "run_reads",
                "run_rereads",
              ])
                this.db
                  .prepare(`DELETE FROM ${child} WHERE run_id IN (${runMarks})`)
                  .run(...values);
            }
          }
          this.db
            .prepare(`DELETE FROM ${table} WHERE rowid IN (${ids.map(() => "?").join(",")})`)
            .run(...ids.map(({ id }) => id));
        });
        batches++;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
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
      ["check_runs", 30, ""],
      ["review_findings", QA_RETENTION_DAYS, ""],
      ["comms", COMMS_RETENTION_DAYS, ""],
      ["flight_decisions", FLIGHT_DECISIONS_RETENTION_DAYS, ""],
    ] as const;
    const start = this.historyNextTable;
    for (let offset = 0; offset < tables.length; offset++) {
      const index = (start + offset) % tables.length;
      const [table, days, extra] = tables[index];
      // Let other tables go first next time if this table consumes the sweep budget.
      this.historyNextTable = (index + 1) % tables.length;
      const findings = table === "review_findings";
      const condition =
        table === "comms" || table === "flight_decisions"
          ? "at < ?"
          : findings
            ? `EXISTS (SELECT 1 FROM reviews v WHERE v.id = review_findings.review_id
            AND v.ended_at < ? AND v.state IN ('reported', 'failed', 'superseded')
            AND (v.run_id IS NULL OR EXISTS
              (SELECT 1 FROM runs r WHERE r.id = v.run_id AND ${endedRun})))
          AND EXISTS (SELECT 1 FROM runs r
            WHERE r.id = review_findings.author_run_id AND r.ended_at < ? AND ${endedRun})
          AND NOT (review_findings.resolution IS NULL AND EXISTS (
            SELECT 1 FROM reviews v JOIN pull_requests p
              ON p.repo_id = v.repo_id AND p.number = v.pr_number
            WHERE v.id = review_findings.review_id AND p.state = 'open'
          ))`
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
          if (table === "comms") {
            const marks = ids.map(() => "?").join(",");
            const values = ids.map(({ id }) => id);
            this.db
              .prepare(`DELETE FROM comms_mentions WHERE message_id IN (${marks})`)
              .run(...values);
            this.db
              .prepare(`DELETE FROM comms_reactions WHERE message_id IN (${marks})`)
              .run(...values);
            this.db
              .prepare(`DELETE FROM comms_settlements WHERE message_id IN (${marks})`)
              .run(...values);
            this.db.prepare(`DELETE FROM comms_pins WHERE message_id IN (${marks})`).run(...values);
          }
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
           closed, priority_source, created_at, item_id, project_id, assignees, author, after_deps,
           defect_refs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, issue_number) DO UPDATE SET title = excluded.title,
           status = excluded.status, state = excluded.state, labels = excluded.labels,
           priority = excluded.priority, updated_at = excluded.updated_at, url = excluded.url,
           stage = excluded.stage, owner = excluded.owner, parent = excluded.parent,
           sub_done = excluded.sub_done, sub_total = excluded.sub_total,
           blocked_by = excluded.blocked_by, milestone = excluded.milestone,
           size = excluded.size, closed = excluded.closed,
           priority_source = excluded.priority_source, created_at = excluded.created_at,
           item_id = excluded.item_id, project_id = excluded.project_id,
           assignees = excluded.assignees, author = excluded.author,
           after_deps = excluded.after_deps, defect_refs = excluded.defect_refs`,
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
          i.after && (i.after.issues.length > 0 || i.after.prs.length > 0)
            ? JSON.stringify(i.after)
            : null,
          i.defectRefs ? JSON.stringify(i.defectRefs) : null,
        );
      }
      this.captureEscapedDefects(repoId);
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
      ...(typeof r.after_deps === "string"
        ? { after: JSON.parse(r.after_deps) as NonNullable<BoardItem["after"]> }
        : {}),
      ...(typeof r.defect_refs === "string"
        ? { defectRefs: JSON.parse(r.defect_refs) as DefectRefs }
        : {}),
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
      const kept = this.namedPullRequests(repoId);
      const del = this.db.prepare("DELETE FROM pull_requests WHERE repo_id = ? AND number = ?");
      for (const [number, at] of readAtOf) {
        if (!seen.has(number) && !kept.has(number) && at < readAt) del.run(repoId, number);
      }
      this.writePullRequests(
        repoId,
        prs.filter((p) => (readAtOf.get(p.number) ?? 0) <= readAt),
        readAt,
      );
    });
  }

  /**
   * The PRs an open card waits on by name (`After PR N`) or through the issue they carry
   * (`Depends on`): the sweep keeps them, or the wait would flicker each time it dropped one.
   */
  private namedPullRequests(repoId: RepoId): Set<number> {
    const open = this.board(repoId).filter((c) => !c.closed);
    const issues = new Set(open.flatMap((c) => c.after?.issues ?? []));
    const named = new Set(open.flatMap((c) => c.after?.prs ?? []));
    if (issues.size === 0) return named;
    for (const p of this.pullRequests(repoId)) {
      if ([...issues].some((n) => prCarries(p, repoId, n))) named.add(p.number);
    }
    return named;
  }

  private writePullRequests(repoId: RepoId, prs: PullRequestView[], readAt: number): void {
    const ins = this.db.prepare(
      `INSERT INTO pull_requests (repo_id, number, title, url, branch, ticket, state, is_draft,
         review, ci, created_at, updated_at, merged_at, read_at, head_sha, mergeable, author,
         assignees, checks, closing_issues, merge_commit_sha, additions, deletions, changed_files,
         base)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, number) DO UPDATE SET title = excluded.title, url = excluded.url,
         branch = excluded.branch, ticket = excluded.ticket, state = excluded.state,
         is_draft = excluded.is_draft, review = excluded.review, ci = excluded.ci,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         merged_at = excluded.merged_at, read_at = excluded.read_at,
         head_sha = excluded.head_sha, mergeable = excluded.mergeable, author = excluded.author,
         assignees = excluded.assignees, checks = excluded.checks,
         closing_issues = excluded.closing_issues, merge_commit_sha = excluded.merge_commit_sha,
         additions = excluded.additions, deletions = excluded.deletions,
         changed_files = excluded.changed_files, base = excluded.base, stale = 0`,
    );
    const deleteFiles = this.db.prepare("DELETE FROM pr_files WHERE repo_id = ? AND pr_number = ?");
    const addFile = this.db.prepare(
      "INSERT OR REPLACE INTO pr_files (repo_id, pr_number, path, change_type) VALUES (?, ?, ?, ?)",
    );
    const addHistory = this.db.prepare(
      "INSERT OR IGNORE INTO pr_history (repo_id, number, merged_at, record) VALUES (?, ?, ?, ?)",
    );
    const fillHistorySizes = this.db.prepare(
      `UPDATE pr_history SET record = json_set(record,
         '$.additions', COALESCE(json_extract(record, '$.additions'), ?),
         '$.deletions', COALESCE(json_extract(record, '$.deletions'), ?),
         '$.changedFiles', COALESCE(json_extract(record, '$.changedFiles'), ?))
       WHERE repo_id = ? AND number = ? AND (
         (json_extract(record, '$.additions') IS NULL AND ? IS NOT NULL) OR
         (json_extract(record, '$.deletions') IS NULL AND ? IS NOT NULL) OR
         (json_extract(record, '$.changedFiles') IS NULL AND ? IS NOT NULL))`,
    );
    const addCiRun = this.db.prepare(
      `INSERT INTO ci_runs (repo_id, run_key, sha, name, attempt, pr_number, workflow, state,
         conclusion, url, first_seen_at, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, run_key) DO UPDATE SET pr_number = excluded.pr_number,
         workflow = excluded.workflow, state = excluded.state, conclusion = excluded.conclusion,
         url = excluded.url, at = excluded.at`,
    );
    for (const p of prs) {
      if (p.headSha)
        for (const c of p.checks ?? [])
          addCiRun.run(
            repoId,
            // a check run is its GraphQL id; a status (or a row stored without one) is told apart
            // by what names it on this commit
            c.id !== undefined
              ? `run:${c.id}`
              : [c.kind, p.headSha, c.workflow ?? "", c.name, c.attempt ?? 0].join(":"),
            p.headSha,
            c.name,
            c.attempt ?? 0,
            p.number,
            c.workflow ?? null,
            c.state,
            c.conclusion,
            c.url,
            readAt,
            readAt,
          );
      const runs = this.db
        .prepare(
          `SELECT id FROM runs INDEXED BY runs_loop_pr_number
             WHERE json_extract(loop, '$.prNumber') = ?
           UNION
           SELECT author_run_id FROM reviews WHERE repo_id = ? AND pr_number = ?`,
        )
        .all(p.number, repoId, p.number) as Row[];
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
      if (p.files !== undefined) {
        deleteFiles.run(repoId, p.number);
        for (const f of p.files) addFile.run(repoId, p.number, f.path, f.changeType);
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
        p.additions ?? null,
        p.deletions ?? null,
        p.changedFiles ?? null,
        p.base ?? null,
      );
      if (p.mergedAt !== null) {
        const { files: _files, escapedDefects: _defects, ...record } = p;
        addHistory.run(repoId, p.number, p.mergedAt, JSON.stringify(record));
        const additions = p.additions ?? null;
        const deletions = p.deletions ?? null;
        const changedFiles = p.changedFiles ?? null;
        fillHistorySizes.run(
          additions,
          deletions,
          changedFiles,
          repoId,
          p.number,
          additions,
          deletions,
          changedFiles,
        );
      }
    }
    this.captureEscapedDefects(repoId);
  }

  /**
   * Records each bug card against the PRs merged within QA_RETENTION_DAYS before it was filed that
   * it names (see linkEscapedDefect). Rerun on every board and PR write, so a bug read before its
   * PR's diff still links on the next poll; a recorded link is never rewritten.
   */
  private captureEscapedDefects(repoId: RepoId): void {
    const bugs = (
      this.db
        .prepare(
          "SELECT issue_number, labels, created_at, defect_refs FROM board_items WHERE repo_id = ? AND defect_refs IS NOT NULL",
        )
        .all(repoId) as Row[]
    ).filter((b) => isBugLabelled(JSON.parse(b.labels as string) as string[]));
    if (bugs.length === 0) return;
    const newest = Math.max(...bugs.map((b) => b.created_at as number));
    const oldest = Math.min(...bugs.map((b) => b.created_at as number));
    const merged = this.db
      .prepare(
        `SELECT h.number, h.merged_at, json_extract(h.record, '$.branch') AS branch,
           COALESCE(p.head_sha, json_extract(h.record, '$.headSha')) AS head_sha,
           COALESCE(p.merge_commit_sha, json_extract(h.record, '$.mergeCommitSha')) AS merge_sha
         FROM pr_history h LEFT JOIN pull_requests p ON p.repo_id = h.repo_id AND p.number = h.number
         WHERE h.repo_id = ? AND h.merged_at >= ? AND h.merged_at <= ?`,
      )
      .all(repoId, oldest - QA_RETENTION_DAYS * DAY_MS, newest) as Row[];
    if (merged.length === 0) return;
    const filesOf = this.db.prepare(
      "SELECT path FROM pr_files WHERE repo_id = ? AND pr_number = ?",
    );
    const commitsOf = this.db.prepare(
      "SELECT sha FROM run_commits WHERE repo_id = ? AND branch = ?",
    );
    const facts = new Map<number, MergedPrFacts & { branch: string }>();
    for (const m of merged) {
      const branch = (m.branch as string | null) ?? "";
      facts.set(m.number as number, {
        number: m.number as number,
        mergedAt: m.merged_at as number,
        branch,
        shas: [
          ...[m.head_sha, m.merge_sha].filter((x): x is string => typeof x === "string"),
          ...(commitsOf.all(repoId, branch) as Row[]).map((c) => c.sha as string),
        ],
        files: (filesOf.all(repoId, m.number) as Row[]).map((f) => f.path as string),
      });
    }
    const authorOf = this.db.prepare(
      `SELECT agent_id, model FROM runs WHERE repo_id = ? AND branch = ? AND id NOT IN (
         SELECT run_id FROM reviews WHERE run_id IS NOT NULL) ORDER BY started_at DESC LIMIT 1`,
    );
    const add = this.db.prepare(
      `INSERT OR IGNORE INTO escaped_defects
         (repo_id, issue_number, pr_number, via, filed_at, merged_at, seat, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of bugs) {
      const filedAt = b.created_at as number;
      const window = [...facts.values()].filter(
        (f) => f.mergedAt >= filedAt - QA_RETENTION_DAYS * DAY_MS,
      );
      const refs = JSON.parse(b.defect_refs as string) as DefectRefs;
      for (const link of linkEscapedDefect({ createdAt: filedAt, refs }, window)) {
        const f = facts.get(link.prNumber);
        if (f === undefined) continue;
        const author = authorOf.get(repoId, f.branch) as Row | undefined;
        add.run(
          repoId,
          b.issue_number as number,
          f.number,
          link.via,
          filedAt,
          f.mergedAt,
          (author?.agent_id as string | undefined) ?? null,
          (author?.model as string | undefined) ?? null,
        );
      }
    }
  }

  /**
   * The QA board's workflow figures for work that ended or merged at or after `since`: escaped
   * defects, review wait and time per head, rework ratio per seat and model, tests per PR.
   */
  qaFlow(since: number): Omit<QaFlowView, "days" | "since" | "metrics"> {
    const escapedDefects = (
      this.db
        .prepare(
          "SELECT * FROM escaped_defects WHERE merged_at >= ? ORDER BY filed_at DESC, issue_number DESC, pr_number",
        )
        .all(since) as Row[]
    ).map((r) => ({
      repoId: r.repo_id as string,
      issueNumber: r.issue_number as number,
      prNumber: r.pr_number as number,
      via: r.via as DefectVia,
      filedAt: r.filed_at as number,
      mergedAt: r.merged_at as number,
      seat: r.seat as string | null,
      model: r.model as string | null,
    }));
    const reviews = this.db
      .prepare(
        `SELECT v.id, v.repo_id, v.pr_number, v.sha, v.created_at, v.started_at, v.ended_at,
           v.blocking, r.agent_id, r.model FROM reviews v LEFT JOIN runs r ON r.id = v.author_run_id
         WHERE v.state = 'reported' AND v.ended_at >= ? ORDER BY v.ended_at DESC, v.id DESC`,
      )
      .all(since) as Row[];
    const timings = reviewTimings(
      reviews.map((v) => ({
        reviewId: v.id as number,
        createdAt: v.created_at as number,
        startedAt: v.started_at as number | null,
        endedAt: v.ended_at as number | null,
      })),
    );
    const reviewOf = new Map(reviews.map((v) => [v.id as number, v]));
    const heads = timings.heads.map((h) => {
      const v = reviewOf.get(h.reviewId);
      return {
        ...h,
        repoId: v?.repo_id as string,
        prNumber: v?.pr_number as number,
        sha: v?.sha as string,
      };
    });
    const files = this.db
      .prepare(
        `SELECT h.repo_id, h.number, h.merged_at, f.path, f.change_type FROM pr_history h
         JOIN pr_files f ON f.repo_id = h.repo_id AND f.pr_number = h.number
         WHERE h.merged_at >= ? ORDER BY h.merged_at DESC, h.repo_id, h.number`,
      )
      .all(since) as Row[];
    const byPr = new Map<string, PrTestsView & { files: PrFileInput[] }>();
    for (const f of files) {
      const key = `${f.repo_id}#${f.number}`;
      const row = byPr.get(key) ?? {
        repoId: f.repo_id as string,
        prNumber: f.number as number,
        mergedAt: f.merged_at as number,
        added: 0,
        changed: 0,
        files: [],
      };
      row.files.push({ path: f.path as string, changeType: f.change_type as string });
      byPr.set(key, row);
    }
    return {
      escapedDefects,
      reviewTimings: { ...timings, heads },
      rework: reworkRatios(
        reviews.map((v) => ({
          seat: (v.agent_id as string | null) ?? "unknown",
          model: (v.model as string | null) ?? "unknown",
          blocking: v.blocking as number,
        })),
      ),
      testsPerPr: [...byPr.values()].map(({ files: diff, ...pr }) => ({
        ...pr,
        ...testsTouched(diff),
      })),
    };
  }

  /** Merged PR snapshots are immutable once any size fields missing at migration are filled. */
  prHistory(repoId: RepoId, since = 0, until = Number.MAX_SAFE_INTEGER): PullRequestView[] {
    return (
      this.db
        .prepare(
          "SELECT record FROM pr_history WHERE repo_id = ? AND merged_at >= ? AND merged_at <= ? ORDER BY merged_at DESC",
        )
        .all(repoId, since, until) as { record: string }[]
    ).map((r) => JSON.parse(r.record) as PullRequestView);
  }

  recordRetrospective(repoId: RepoId, day: string, at: number, report: unknown): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO retrospectives (repo_id, day, at, report) VALUES (?, ?, ?, ?)",
      )
      .run(repoId, day, at, JSON.stringify(report));
  }

  retrospectives(repoId: RepoId, since = 0, until = Number.MAX_SAFE_INTEGER): unknown[] {
    return (
      this.db
        .prepare(
          "SELECT report FROM retrospectives WHERE repo_id = ? AND at >= ? AND at <= ? ORDER BY at DESC",
        )
        .all(repoId, since, until) as { report: string }[]
    ).map((r) => JSON.parse(r.report));
  }

  /** Range-bounded, durable audit aggregates.  Inputs are timestamps already validated at HTTP. */
  audit(
    since: number,
    until: number,
    kinds: ReadonlyMap<string, AuditRunKind> = new Map(),
  ): AuditView {
    const rows = (sql: string, ...args: SQLInputValue[]) =>
      this.db.prepare(sql).all(...args) as Row[];
    const prs = this.auditPrSizes(since, until);
    const spend = rows(
      `SELECT id AS runId, agent_id AS agentId, ticket, cost_usd AS costUsd FROM runs
       WHERE started_at >= ? AND started_at <= ? AND cost_usd IS NOT NULL
       ORDER BY cost_usd DESC, id`,
      since,
      until,
    ) as unknown as AuditView["spendOutliers"];
    const medianSpend = median(spend.map((r) => r.costUsd));
    return {
      range: { since, until },
      longRunners: (
        rows(
          `SELECT id AS runId, agent_id AS agentId, ticket, started_at AS startedAt, ended_at AS endedAt,
            EXISTS (SELECT 1 FROM seat_sessions s WHERE s.run_id = runs.id) AS held,
            COALESCE(ended_at, ?) - started_at AS durationMs FROM runs
           WHERE started_at <= ? AND COALESCE(ended_at, ?) >= ? ORDER BY durationMs DESC LIMIT 100`,
          until,
          until,
          until,
          since,
        ) as unknown as (Omit<AuditView["longRunners"][number], "kind" | "actionable"> & {
          agentId: string;
          held: number;
        })[]
      ).map(({ held, ...r }) => {
        const kind = kinds.get(r.agentId) ?? null;
        const actionable =
          kind !== "observed" && kind !== "watch" && (r.endedAt !== null || held === 1);
        return { ...r, kind, actionable };
      }),
      deathLoops: rows(
        `SELECT a.run_id AS runId, (SELECT agent_id FROM runs WHERE id = a.run_id) AS agentId,
          COUNT(*) AS parks FROM run_attempts a
         WHERE a.kind = 'loop' AND a.at >= ? AND a.at <= ?
           AND json_extract(a.data, '$.parked') IS NOT NULL GROUP BY a.run_id ORDER BY parks DESC`,
        since,
        until,
      ) as unknown as AuditView["deathLoops"],
      reworkRounds: rows(
        `SELECT author_run_id AS runId, (SELECT agent_id FROM runs WHERE id = author_run_id) AS agentId,
          MAX(0, MAX(round) - 1) AS rounds, MAX(round) AS maxRound FROM reviews
         WHERE state = 'reported' AND ended_at >= ? AND ended_at <= ?
         GROUP BY author_run_id ORDER BY rounds DESC, runId`,
        since,
        until,
      ) as unknown as AuditView["reworkRounds"],
      reviewRounds: {
        prs: rows(
          `SELECT rounds, COUNT(*) AS count FROM (
             SELECT MAX(round) AS rounds FROM reviews
             WHERE state = 'reported' AND ended_at >= ? AND ended_at <= ?
             GROUP BY author_run_id, pr_number
           ) GROUP BY rounds ORDER BY rounds`,
          since,
          until,
        ) as unknown as { rounds: number; count: number }[],
        late: rows(
          `SELECT v.seat_id AS seatId, r.model AS model, COUNT(*) AS findings, SUM(f.late) AS late
           FROM review_findings f JOIN reviews v ON v.id = f.review_id
           LEFT JOIN runs r ON r.id = v.run_id
           WHERE v.state = 'reported' AND v.ended_at >= ? AND v.ended_at <= ?
             AND f.severity IN (${BLOCKING_SEVERITIES.map(() => "?").join(", ")})
           GROUP BY v.seat_id, r.model ORDER BY late DESC, v.seat_id, r.model`,
          since,
          until,
          ...BLOCKING_SEVERITIES,
        ) as unknown as { seatId: string; model: string | null; findings: number; late: number }[],
      },
      refusalsByRule: rows(
        `SELECT rule, COUNT(*) AS count FROM guard_hits WHERE at >= ? AND at <= ? GROUP BY rule ORDER BY count DESC, rule`,
        since,
        until,
      ) as unknown as AuditView["refusalsByRule"],
      refusals: rows(
        `SELECT agent_id AS agentId, run_id AS runId, rule, COUNT(*) AS count FROM guard_hits
         WHERE at >= ? AND at <= ? GROUP BY agent_id, run_id, rule
         ORDER BY count DESC, agent_id, run_id, rule`,
        since,
        until,
      ) as unknown as AuditView["refusals"],
      refusalSpikes: rows(
        `SELECT agent_id AS agentId, (at / ${DAY_MS}) * ${DAY_MS} AS day, COUNT(*) AS count
         FROM guard_hits WHERE at >= ? AND at <= ? GROUP BY agent_id, day HAVING count >= ?
         ORDER BY count DESC, day, agent_id`,
        since,
        until,
        AUDIT_REFUSAL_SPIKE,
      ) as unknown as AuditView["refusalSpikes"],
      spendOutliers:
        medianSpend === null
          ? []
          : spend.filter(
              (r) => r.costUsd > 0 && r.costUsd >= medianSpend * AUDIT_SPEND_OUTLIER_FACTOR,
            ),
      questions: (rows(
        `SELECT COUNT(*) AS asked, COALESCE(SUM(answered_at IS NOT NULL), 0) AS answered,
          AVG(CASE WHEN answered_at IS NULL THEN NULL ELSE answered_at - at END) AS answerMs
         FROM seat_questions WHERE at >= ? AND at <= ?`,
        since,
        until,
      )[0] ?? { asked: 0, answered: 0, answerMs: null }) as unknown as AuditView["questions"],
      costPerMergedTicket: rows(
        `WITH merged_tickets AS (
           SELECT DISTINCT repo_id, json_extract(record, '$.ticket') AS ticket FROM pr_history
           WHERE merged_at >= ? AND merged_at <= ?
         ) SELECT t.ticket, SUM(r.cost_usd) AS costUsd FROM merged_tickets t
         LEFT JOIN runs r ON r.repo_id = t.repo_id AND r.ticket = t.ticket
         GROUP BY t.repo_id, t.ticket ORDER BY t.ticket`,
        since,
        until,
      ) as unknown as AuditView["costPerMergedTicket"],
      modelPromptTimeline: rows(
        `SELECT started_at AS at, model, account_id AS accountId, effort, prompt_hash AS promptHash
         FROM runs WHERE started_at >= ? AND started_at <= ? ORDER BY started_at`,
        since,
        until,
      ) as unknown as AuditView["modelPromptTimeline"],
      prSizes: {
        prs,
        outliers: prs.filter((p) => p.additions + p.deletions >= AUDIT_PR_OUTLIER_LINES),
      },
      chatter: this.commsChatter(since, until),
      flakes: this.auditFlakes(since, until),
      changes: this.auditChanges(since, until),
      tokenOveruse: this.auditTokenOveruse(since, until, kinds),
      surgeonProposals: [],
    };
  }

  /** Merged PRs in range that have a recorded size, largest first. */
  private auditPrSizes(since: number, until: number): AuditPrSize[] {
    const sized: AuditPrSize[] = [];
    for (const row of this.db
      .prepare("SELECT repo_id, record FROM pr_history WHERE merged_at >= ? AND merged_at <= ?")
      .all(since, until) as { repo_id: string; record: string }[]) {
      const pr = JSON.parse(row.record) as PullRequestView;
      if (pr.additions == null || pr.deletions == null || pr.changedFiles == null) continue;
      sized.push({
        repoId: row.repo_id,
        number: pr.number,
        ticket: pr.ticket,
        mergedAt: pr.mergedAt ?? 0,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
      });
    }
    return sized.sort(
      (a, b) =>
        b.additions + b.deletions - (a.additions + a.deletions) ||
        a.repoId.localeCompare(b.repoId) ||
        a.number - b.number,
    );
  }

  /** Failed-then-passed-on-same-head observations FLIGHT kept per repo, grouped by check. */
  private auditFlakes(since: number, until: number): AuditView["flakes"] {
    const byKey = new Map<string, { count: number; lastAt: number }>();
    const prefix = `${FLIGHT_SIGNALS_SETTING}:`;
    const stored = this.db
      .prepare("SELECT value FROM settings WHERE substr(key, 1, ?) = ?")
      .all(prefix.length, prefix) as { value: string }[];
    for (const { value } of stored) {
      let flakes: Record<string, { key?: unknown; at?: unknown }> = {};
      try {
        flakes = JSON.parse(value)?.flakes ?? {};
      } catch {}
      for (const flake of Object.values(flakes ?? {})) {
        if (typeof flake?.key !== "string" || typeof flake.at !== "number") continue;
        if (flake.at < since || flake.at > until) continue;
        const entry = byKey.get(flake.key) ?? { count: 0, lastAt: 0 };
        entry.count += 1;
        entry.lastAt = Math.max(entry.lastAt, flake.at);
        byKey.set(flake.key, entry);
      }
    }
    return [...byKey]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  /** Each seat's first run on a new prompt or model in range, with metrics either side of it. */
  private auditChanges(since: number, until: number): AuditChange[] {
    const runs = this.db
      .prepare(
        `SELECT agent_id, started_at, model, prompt_hash FROM runs
         WHERE started_at <= ? ORDER BY agent_id, started_at, id`,
      )
      .all(until) as {
      agent_id: string;
      started_at: number;
      model: string | null;
      prompt_hash: string | null;
    }[];
    const changes: AuditChange[] = [];
    const previous = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
      const last = previous.get(run.agent_id);
      previous.set(run.agent_id, run);
      if (!last || run.started_at < since) continue;
      for (const [kind, from, to] of [
        ["prompt", last.prompt_hash, run.prompt_hash],
        ["model", last.model, run.model],
      ] as const) {
        if (to === null || to === from) continue;
        const windowMs = Math.min(
          AUDIT_CHANGE_WINDOW_MS,
          run.started_at - since,
          until - run.started_at,
        );
        changes.push({
          kind,
          agentId: run.agent_id,
          at: run.started_at,
          from,
          to,
          windowMs,
          before: this.auditMetrics(run.started_at - windowMs, run.started_at - 1),
          after: this.auditMetrics(run.started_at, run.started_at + windowMs - 1),
        });
      }
    }
    return changes.sort((a, b) => a.at - b.at || a.agentId.localeCompare(b.agentId));
  }

  /**
   * Runs started in range whose input + output tokens pass their size's expected use (see
   * `tokenBaselines`, built from build runs of the last `AUDIT_BASELINE_DAYS` days), largest first.
   * Only runs of agents `kinds` marks as build count: watch, plan and review seats and observed
   * loops have other shapes of use.
   * A finding only: it reads the run, never changes it.
   */
  private auditTokenOveruse(
    since: number,
    until: number,
    kinds: ReadonlyMap<string, AuditRunKind>,
  ): AuditView["tokenOveruse"] {
    const runRows = (sql: string, ...args: SQLInputValue[]) =>
      this.db.prepare(sql).all(...args) as Row[];
    // the board's Size of the run's ticket ("repo#12" is repo, issue 12)
    const from = `FROM runs r LEFT JOIN board_items b
         ON b.repo_id = r.repo_id AND r.ticket = b.repo_id || '#' || b.issue_number
       WHERE r.review_id IS NULL AND r.tokens IS NOT NULL`;
    // the loop kind stored at the run's start; a seat since removed still counts, and a row from
    // before it was stored falls back to the seat's kind now
    const isBuild = (r: Row): boolean => (r.loopKind ?? kinds.get(r.agentId as string)) === "build";
    const usage = (r: Row): TokenUsage => JSON.parse(r.tokens as string) as TokenUsage;
    const baselines = tokenBaselines(
      runRows(
        `SELECT r.agent_id AS agentId, r.loop_kind AS loopKind, b.size AS size, r.tokens AS tokens ${from}
           AND r.ended_at IS NOT NULL AND r.started_at >= ? AND r.started_at <= ?`,
        until - AUDIT_BASELINE_DAYS * DAY_MS,
        until,
      )
        .filter(isBuild)
        .map((r) => ({
          size: r.size as string | null,
          tokens: usage(r).input + usage(r).output,
        })),
    );
    const blocking = BLOCKING_SEVERITIES.map(() => "?").join(", ");
    const runs: AuditTokenOveruse[] = [];
    for (const r of runRows(
      `SELECT r.id AS id, r.agent_id AS agentId, r.ticket AS ticket, r.started_at AS startedAt,
         r.ended_at AS endedAt, r.loop_kind AS loopKind, r.tokens AS tokens, b.size AS size ${from}
         AND r.started_at >= ? AND r.started_at <= ? ORDER BY r.started_at DESC`,
      since,
      until,
    )) {
      if (!isBuild(r)) continue;
      const tokens = usage(r);
      const total = tokens.input + tokens.output;
      const size = r.size as string | null;
      const expected = baselines.expected(size);
      if (total <= expected) continue;
      const id = r.id as string;
      const rounds = this.db
        .prepare("SELECT COUNT(*) AS n FROM reviews WHERE author_run_id = ? AND state = 'reported'")
        .get(id) as { n: number };
      const byCategory: AuditOveruseFacts["blockingByCategory"] = {};
      let blockingTotal = 0;
      for (const f of this.db
        .prepare(
          `SELECT COALESCE(category, 'uncategorised') AS category, COUNT(*) AS n FROM review_findings
           WHERE author_run_id = ? AND severity IN (${blocking}) GROUP BY category`,
        )
        .all(id, ...BLOCKING_SEVERITIES) as { category: keyof typeof byCategory; n: number }[]) {
        byCategory[f.category] = f.n;
        blockingTotal += f.n;
      }
      const digest = this.db
        .prepare(
          "SELECT json_extract(digest, '$.turns') AS turns FROM run_digests WHERE run_id = ?",
        )
        .get(id) as { turns: number | null } | undefined;
      const facts: AuditOveruseFacts = {
        size,
        reviewRounds: rounds.n,
        blocking: blockingTotal,
        blockingByCategory: byCategory,
        turns: digest?.turns ?? null,
      };
      const cause = classifyOveruse(facts);
      runs.push({
        runId: id,
        agentId: r.agentId as string,
        ticket: r.ticket as string | null,
        startedAt: r.startedAt as number,
        ended: r.endedAt !== null,
        tokens: total,
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheCreate: tokens.cacheCreate,
        expected,
        ...facts,
        cause,
        prevention: overusePrevention(cause),
      });
    }
    runs.sort((a, b) => b.tokens - a.tokens || a.runId.localeCompare(b.runId));
    return {
      runs,
      groups: groupOveruse(runs),
      expected: [...TICKET_SIZES, null].map((size) => ({
        size,
        tokens: baselines.expected(size),
        measured: baselines.bySize.has(size ?? ""),
      })),
    };
  }

  /** Crew-wide metrics over one window, both ends inclusive. */
  private auditMetrics(from: number, to: number): AuditMetrics {
    const merged = this.db
      .prepare("SELECT COUNT(*) AS n FROM pr_history WHERE merged_at >= ? AND merged_at <= ?")
      .get(from, to) as { n: number };
    const reviews = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(blocking > 0), 0) AS failed FROM reviews
         WHERE state = 'reported' AND ended_at >= ? AND ended_at <= ?`,
      )
      .get(from, to) as { n: number; failed: number };
    const costs = this.db
      .prepare(
        `WITH merged_tickets AS (
           SELECT DISTINCT repo_id, json_extract(record, '$.ticket') AS ticket FROM pr_history
           WHERE merged_at >= ? AND merged_at <= ?
         ) SELECT SUM(r.cost_usd) AS costUsd FROM merged_tickets t
         JOIN runs r ON r.repo_id = t.repo_id AND r.ticket = t.ticket
         GROUP BY t.repo_id, t.ticket HAVING costUsd IS NOT NULL`,
      )
      .all(from, to) as { costUsd: number }[];
    const rework = this.db
      .prepare(
        `SELECT COALESCE(SUM(rounds), 0) AS n FROM (
           SELECT MAX(0, MAX(round) - 1) AS rounds FROM reviews
           WHERE state = 'reported' AND ended_at >= ? AND ended_at <= ? GROUP BY author_run_id)`,
      )
      .get(from, to) as { n: number };
    return {
      merged: merged.n,
      reviewFailRate: reviews.n === 0 ? null : reviews.failed / reviews.n,
      medianCostPerMergedTicket: median(costs.map((c) => c.costUsd)),
      reworkRounds: rework.n,
    };
  }

  pullRequests(repoId: RepoId): PullRequestView[] {
    const rows = this.statement(
      "SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY number DESC",
    ).all(repoId) as Row[];
    return this.pullRequestRows(rows);
  }

  /** The repo's open PRs and those updated at or after `since` (all of them when null), newest number first. */
  pullRequestsSince(repoId: RepoId, since: number | null): PullRequestView[] {
    const rows =
      since === null
        ? (this.statement("SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY number DESC").all(
            repoId,
          ) as Row[])
        : (this.statement(
            "SELECT * FROM pull_requests WHERE repo_id = ? AND (state = 'open' OR updated_at >= ? OR merged_at >= ?) ORDER BY number DESC",
          ).all(repoId, since, since) as Row[]);
    return this.pullRequestRows(rows);
  }

  /** The stored PRs among `numbers`, as number and title, lowest number first; never parses a row's checks. */
  pullRequestTitles(repoId: RepoId, numbers: readonly number[]): PrTitle[] {
    if (numbers.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT number, title FROM pull_requests WHERE repo_id = ? AND number IN (${numbers.map(() => "?").join(", ")}) ORDER BY number ASC`,
      )
      .all(repoId, ...numbers) as { number: number; title: string }[];
    return rows.map((r) => ({ number: r.number, title: r.title }));
  }

  pullRequest(repoId: RepoId, number: number): PullRequestView | null {
    const row = this.statement("SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?").get(
      repoId,
      number,
    ) as Row | undefined;
    return row === undefined ? null : (this.pullRequestRows([row])[0] ?? null);
  }

  /** Pull requests for configured repos, indexed after one table read for the HUD. */
  pullRequestsForRepos(repoIds: readonly RepoId[]): Map<RepoId, PullRequestView[]> {
    const out = new Map<RepoId, PullRequestView[]>();
    if (repoIds.length === 0) return out;
    const rows = this.statement(
      `SELECT * FROM pull_requests WHERE repo_id IN (${repoIds.map(() => "?").join(", ")}) ORDER BY number DESC`,
    ).all(...repoIds) as Row[];
    for (const pr of this.pullRequestRows(rows)) {
      const prs = out.get(pr.repoId) ?? [];
      prs.push(pr);
      out.set(pr.repoId, prs);
    }
    return out;
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
    const defects = new Map<string, NonNullable<PullRequestView["escapedDefects"]>>();
    for (const d of this.statement(
      "SELECT repo_id, pr_number, issue_number, via, filed_at FROM escaped_defects ORDER BY filed_at",
    ).all() as Row[]) {
      const key = `${d.repo_id}#${d.pr_number}`;
      defects.set(key, [
        ...(defects.get(key) ?? []),
        {
          issueNumber: d.issue_number as number,
          via: d.via as DefectVia,
          filedAt: d.filed_at as number,
        },
      ]);
    }
    return rows.map((r) => ({
      ...(defects.has(`${r.repo_id}#${r.number}`)
        ? { escapedDefects: defects.get(`${r.repo_id}#${r.number}`) }
        : {}),
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
      ...(r.additions == null ? {} : { additions: r.additions as number }),
      ...(r.deletions == null ? {} : { deletions: r.deletions as number }),
      ...(r.changed_files == null ? {} : { changedFiles: r.changed_files as number }),
      ...(r.base == null ? {} : { base: r.base as string }),
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

  /** Replaces the repo's finished and open flow rows. */
  replaceFlow(repoId: RepoId, issues: FlowIssue[], prs: FlowPr[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM flow_issues WHERE repo_id = ?").run(repoId);
      this.db.prepare("DELETE FROM flow_prs WHERE repo_id = ?").run(repoId);
      const insIssue = this.db.prepare(
        "INSERT INTO flow_issues (repo_id, number, size, start_at, done_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const i of issues) insIssue.run(repoId, i.number, i.size, i.startAt, i.doneAt);
      const insPr = this.db.prepare(
        "INSERT INTO flow_prs (repo_id, number, merged_at, first_push_ci) VALUES (?, ?, ?, ?)",
      );
      for (const p of prs) insPr.run(repoId, p.number, p.mergedAt, p.firstPushCi);
    });
  }

  /** Issues done at or after `sinceMs`, plus every open flow issue, oldest first. */
  flowIssues(sinceMs: number): FlowIssue[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM flow_issues
         WHERE done_at >= ? OR done_at IS NULL
         ORDER BY COALESCE(done_at, start_at, 0) ASC, repo_id, number`,
      )
      .all(sinceMs) as Row[];
    return rows.map((r) => ({
      repoId: r.repo_id as string,
      number: r.number as number,
      size: r.size as string | null,
      startAt: r.start_at as number | null,
      doneAt: r.done_at as number | null,
    }));
  }

  /** The first recorded crew run for a ticket, including one before a telemetry chart's range. */
  ticketStartedAt(ticket: string): number | null {
    const row = this.db
      .prepare("SELECT MIN(started_at) AS at FROM runs WHERE ticket = ?")
      .get(ticket) as { at: number | null };
    return row.at;
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

  claimDecisionDefault(
    d: {
      key: string;
      briefAt: number;
      optionId: string | null;
      label: string;
      dueAt: number;
      target: string | null;
      answer: string;
    },
    message: NewCommsRow,
    at: number,
  ): boolean {
    let claimed = false;
    this.transaction(() => {
      const r = this.db
        .prepare(
          `INSERT OR IGNORE INTO decision_defaults (key, brief_at, option_id, label, due_at, applied_at, target, answer, delivered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          d.key,
          d.briefAt,
          d.optionId,
          d.label,
          d.dueAt,
          at,
          d.target,
          d.answer,
          d.target === null ? at : null,
        );
      if (r.changes === 0) return;
      this.insertComms(message, cutCommsText(message.text), null);
      this.db
        .prepare(
          `INSERT INTO acks (key, at, absent_since) VALUES (?, ?, NULL)
           ON CONFLICT(key) DO UPDATE SET at = excluded.at`,
        )
        .run(d.key, at);
      claimed = true;
    }, true);
    return claimed;
  }

  pendingDecisionDeliveries(): { key: string; briefAt: number; target: string; answer: string }[] {
    return (
      this.db
        .prepare(`SELECT key, brief_at, target, answer FROM decision_defaults
      WHERE delivered_at IS NULL AND target IS NOT NULL ORDER BY applied_at, key`)
        .all() as Row[]
    ).map((r) => ({
      key: r.key as string,
      briefAt: r.brief_at as number,
      target: r.target as string,
      answer: r.answer as string,
    }));
  }

  markDecisionDeliveryDone(key: string, briefAt: number, at: number): void {
    this.db
      .prepare("UPDATE decision_defaults SET delivered_at = ? WHERE key = ? AND brief_at = ?")
      .run(at, key, briefAt);
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

  /** Keep a Priority approval's durable state and visible note together across a restart. */
  saveQueueReorder(key: string, value: string, at: number, note?: NoteInput, clear?: string): void {
    this.transaction(() => {
      this.setSetting(key, value);
      if (note) this.raiseNote(note);
      if (clear) this.clearNote(clear, at);
    });
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
        `INSERT INTO collector_status (collector, ok, error, at, last_ok_at, failing_since)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(collector) DO UPDATE SET ok = excluded.ok, error = excluded.error,
           at = excluded.at, last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at),
           failing_since = CASE WHEN excluded.ok = 1 THEN NULL
             ELSE COALESCE(collector_status.failing_since, excluded.at) END`,
      )
      .run(collector, ok ? 1 : 0, error, at, ok ? at : null, ok ? null : at);
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
      failingSince: (r.failing_since as number | null) ?? null,
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
  addEvidence(
    runId: string,
    note: string,
    at: number,
    details: {
      tests?: ReportedTest[];
      testsAdded?: { file: string; failedOnBase: boolean }[];
      doneWhen?: DoneWhenEntry[];
    } = {},
  ): number {
    const r = this.db
      .prepare(
        "INSERT INTO run_evidence (run_id, note, at, tests, tests_added, done_when) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        note,
        at,
        JSON.stringify(details.tests ?? []),
        JSON.stringify(details.testsAdded ?? []),
        JSON.stringify(details.doneWhen ?? []),
      );
    this.clearNoReportNotes(runId, at);
    return Number(r.lastInsertRowid);
  }

  latestEvidence(runId: string): Evidence | null {
    const r = this.db
      .prepare("SELECT * FROM run_evidence WHERE run_id = ? ORDER BY id DESC LIMIT 1")
      .get(runId) as Row | undefined;
    return r ? evidenceOf(r) : null;
  }

  /** Records the ticket's Done-when lines for a run, replacing any recorded before (none: no rule). */
  setRunDoneWhen(runId: string, lines: readonly string[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM run_done_when WHERE run_id = ?").run(runId);
      const insert = this.db.prepare(
        "INSERT INTO run_done_when (run_id, pos, line) VALUES (?, ?, ?)",
      );
      lines.forEach((line, pos) => {
        insert.run(runId, pos, line);
      });
    }, true);
  }

  /** The run's recorded Done-when lines in ticket order; empty when none were recorded. */
  runDoneWhen(runId: string): string[] {
    return (
      this.db
        .prepare("SELECT line FROM run_done_when WHERE run_id = ? ORDER BY pos")
        .all(runId) as Row[]
    ).map((r) => r.line as string);
  }

  /** Every note the run's seat reported, oldest first. */
  evidenceNotes(runId: string): Evidence[] {
    const rows = this.db
      .prepare("SELECT * FROM run_evidence WHERE run_id = ? ORDER BY id")
      .all(runId) as Row[];
    return rows.map(evidenceOf);
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
    r: {
      verdict: ReviewVerdict;
      summary: string;
      findings: ReviewFinding[];
      checked?: ReviewCheck[];
      tests?: ReportedTest[];
      resolutions?: FindingResolution[];
      at: number;
    },
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
      const row = this.db
        .prepare("SELECT author_run_id, round, changed_since FROM reviews WHERE id = ?")
        .get(reviewId) as Row;
      const author = row.author_run_id as string;
      // late: a later round's finding on a file the author did not touch since the last review
      const changed =
        (row.round as number) >= 2 && row.changed_since !== null
          ? new Set(JSON.parse(row.changed_since as string) as string[])
          : null;
      // a finding the reviewer holds from the last round was raised then, so it is carried, not late
      const heldFile = this.db.prepare(
        "SELECT file FROM review_findings WHERE review_id = ? AND pos = ?",
      );
      const held = new Set<string>();
      for (const x of r.resolutions ?? []) {
        if (x.outcome !== "held") continue;
        const file = (heldFile.get(x.findingRef.reviewId, x.findingRef.pos) as Row | undefined)
          ?.file;
        if (typeof file === "string") held.add(file);
      }
      const insert = this.db.prepare(
        `INSERT INTO review_findings (review_id, author_run_id, pos, severity, file, line, summary,
           scenario, fix, category, state, late)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          f.category ?? null,
          isBlocking(f) ? "open" : "logged",
          changed !== null && !changed.has(f.file) && !held.has(f.file) ? 1 : 0,
        );
      });
      const insertCheck = this.db.prepare(
        "INSERT INTO review_checks (review_id, check_id, result, note) VALUES (?, ?, ?, ?)",
      );
      for (const check of r.checked ?? [])
        insertCheck.run(reviewId, check.check, check.result, check.note ?? null);
      const insertTest = this.db.prepare(
        `INSERT INTO review_tests (review_id, command, file, passed, failed, skipped, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const test of r.tests ?? [])
        insertTest.run(
          reviewId,
          test.command,
          test.file ?? null,
          test.passed,
          test.failed,
          test.skipped,
          test.duration,
        );
      const insertResolution = this.db.prepare(
        `INSERT INTO review_resolutions (review_id, prior_review_id, finding_pos, outcome)
         VALUES (?, ?, ?, ?)`,
      );
      const resolve = this.db.prepare(
        `UPDATE review_findings SET resolution = ?, resolved_review_id = ?
         WHERE review_id = ? AND pos = ? AND resolution IS NULL`,
      );
      for (const resolution of r.resolutions ?? []) {
        insertResolution.run(
          reviewId,
          resolution.findingRef.reviewId,
          resolution.findingRef.pos,
          resolution.outcome,
        );
        resolve.run(
          resolution.outcome,
          reviewId,
          resolution.findingRef.reviewId,
          resolution.findingRef.pos,
        );
      }
      // A round that reports nothing to fix accepts the author's work: the blocking findings of the
      // earlier rounds that RETRO did not name were fixed.
      if (blocking === 0) {
        this.db
          .prepare(
            `UPDATE review_findings SET resolution = 'fixed', resolved_review_id = ?
             WHERE state = 'open' AND resolution IS NULL AND review_id IN (
               SELECT p.id FROM reviews p, reviews c
               WHERE c.id = ? AND p.author_run_id = c.author_run_id AND p.epoch = c.epoch
                 AND p.round < c.round)`,
          )
          .run(reviewId, reviewId);
      }
      this.appendAttempt(author, "review", r.at, {
        ...this.review(reviewId),
        findings: r.findings,
      });
      this.clearNoReportNotes(runId, r.at);
      recorded = true;
    }, true);
    return recorded;
  }

  /** The files the author changed since the previous reviewed sha, for tagging late findings. */
  setReviewChangedSince(reviewId: number, files: readonly string[]): void {
    this.db
      .prepare("UPDATE reviews SET changed_since = ? WHERE id = ?")
      .run(JSON.stringify(files), reviewId);
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
      category: (r.category as StoredFinding["category"]) ?? undefined,
      state: r.state as StoredFinding["state"],
      late: r.late === 1,
      resolution: (r.resolution as StoredFinding["resolution"]) ?? undefined,
      resolvedReviewId: (r.resolved_review_id as number | null) ?? undefined,
    }));
  }

  /**
   * Findings of reviews in the requested window, plus unresolved findings on PRs still open now.
   * The latter protects an open card from losing its blocking review evidence as it ages.
   */
  qaFindings(since: number): QaFindingView[] {
    const rows = this.db
      .prepare(
        `SELECT f.*, v.repo_id, v.pr_number, v.round, v.ended_at FROM review_findings f
         JOIN reviews v ON v.id = f.review_id
         WHERE v.ended_at >= ? OR (f.resolution IS NULL AND EXISTS (
           SELECT 1 FROM pull_requests p
           WHERE p.repo_id = v.repo_id AND p.number = v.pr_number AND p.state = 'open'
         ))
         ORDER BY v.ended_at DESC, f.review_id DESC, f.pos`,
      )
      .all(since) as Row[];
    return rows.map((r) => ({
      reviewId: r.review_id as number,
      authorRunId: r.author_run_id as string,
      repoId: r.repo_id as string,
      prNumber: r.pr_number as number,
      round: r.round as number,
      reviewEndedAt: r.ended_at as number | null,
      pos: r.pos as number,
      severity: r.severity as string,
      category: r.category as string | null,
      file: r.file as string,
      line: r.line as number,
      summary: r.summary as string,
      resolution: r.resolution as string | null,
      resolvedReviewId: r.resolved_review_id as number | null,
    }));
  }

  /** Completed review rounds in the requested window, plus the full history of open PRs. */
  qaReviewRounds(since: number): QaReviewRoundView[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reviews v
         WHERE v.state = 'reported' AND v.ended_at IS NOT NULL AND (v.ended_at >= ? OR EXISTS (
           SELECT 1 FROM pull_requests p
           WHERE p.repo_id = v.repo_id AND p.number = v.pr_number AND p.state = 'open'
         ))
         ORDER BY v.ended_at DESC, v.id DESC`,
      )
      .all(since) as Row[];
    return rows.map((r) => ({
      reviewId: r.id as number,
      authorRunId: r.author_run_id as string,
      repoId: r.repo_id as string,
      prNumber: r.pr_number as number,
      round: r.round as number,
      sha: r.sha as string,
      verdict: JSON.parse(r.verdict as string) as QaReviewRoundView["verdict"],
      blocking: r.blocking as number,
      minor: r.minor as number,
      endedAt: r.ended_at as number,
    }));
  }

  reviewChecks(reviewId: number): ReviewCheck[] {
    return (
      this.db
        .prepare(
          "SELECT check_id, result, note FROM review_checks WHERE review_id = ? ORDER BY check_id",
        )
        .all(reviewId) as Row[]
    ).map((r) => ({
      check: r.check_id as ReviewCheck["check"],
      result: r.result as ReviewCheck["result"],
      ...(r.note === null ? {} : { note: r.note as string }),
    }));
  }

  reviewTests(reviewId: number): (Omit<ReportedTest, "file"> & { file: string | null })[] {
    return (
      this.db
        .prepare(
          "SELECT command, file, passed, failed, skipped, duration FROM review_tests WHERE review_id = ? ORDER BY id",
        )
        .all(reviewId) as Row[]
    ).map((r) => ({
      command: r.command as string,
      file: r.file as string | null,
      passed: r.passed as number,
      failed: r.failed as number,
      skipped: r.skipped as number,
      duration: r.duration as number,
    }));
  }

  reviewResolutions(
    reviewId: number,
  ): { reviewId: number; pos: number; outcome: FindingResolution["outcome"] }[] {
    return (
      this.db
        .prepare(
          "SELECT prior_review_id, finding_pos, outcome FROM review_resolutions WHERE review_id = ? ORDER BY prior_review_id, finding_pos",
        )
        .all(reviewId) as Row[]
    ).map((r) => ({
      reviewId: r.prior_review_id as number,
      pos: r.finding_pos as number,
      outcome: r.outcome as FindingResolution["outcome"],
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
    if (this.statement("SELECT 1 FROM loop_events WHERE key = ?").get(`${run.id}:plan`))
      return true;
    return (
      this.statement(
        `SELECT 1 FROM runs r JOIN loop_events e ON e.key = r.id || ':plan'
           WHERE r.repo_id = ? AND r.ticket = ? LIMIT 1`,
      ).get(run.repoId, run.ticket) !== undefined
    );
  }

  /** The run's loop events, oldest first. */
  loopEventsOfRun(runId: string): LoopEvent[] {
    const rows = this.statement("SELECT * FROM loop_events WHERE run_id = ? ORDER BY at, key").all(
      runId,
    ) as Row[];
    return rows.map((r) => ({
      key: r.key as string,
      runId: r.run_id as string,
      text: r.text as string,
      at: r.at as number,
    }));
  }

  /** Records a hand-off whole up to COMMS_TEXT_MAX, then marks the stored copy's cut. */
  addComms(row: NewCommsRow, rate?: { since: number; limit: number }): CommsRow | null {
    const text = cutCommsText(row.text);
    const replyTo =
      row.replyTo === undefined || row.replyTo === null ? null : commsMessageNumber(row.replyTo);
    if (row.replyTo !== undefined && row.replyTo !== null && replyTo === null)
      throw new Error("Invalid Comms message ID.");
    let id: number | null = null;
    this.transaction(() => {
      if (rate !== undefined) {
        const count = this.db
          .prepare("SELECT COUNT(*) AS n FROM comms WHERE from_id = ? AND at >= ?")
          .get(row.from, rate.since) as { n: number };
        if (count.n >= rate.limit) return;
      }
      id = this.insertComms(row, text, replyTo);
      this.raiseChatterNote(row);
    }, true);
    return id === null ? null : this.commsMessage(`comms:${id}`);
  }

  /** Opens one durable FLIGHT-facing note when a pair first crosses the rolling chatter limit. */
  private raiseChatterNote(row: NewCommsRow): void {
    if (
      row.ticket === null ||
      row.to === COMMS_CAPCOM ||
      row.to === COMMS_CREW ||
      row.to === COMMS_MC ||
      row.from === COMMS_CAPCOM ||
      row.from === COMMS_CREW ||
      row.from === COMMS_MC ||
      row.from === row.to
    )
      return;
    const pair = row.from < row.to ? [row.from, row.to] : [row.to, row.from];
    const crossed = this.commsChatter(row.at - COMMS_CHATTER_WINDOW_MS, row.at).some(
      (item) => item.ticket === row.ticket && item.from === pair[0] && item.to === pair[1],
    );
    if (!crossed) return;
    this.raiseNote({
      key: `chatter:${row.ticket}:${pair[0]}:${pair[1]}`,
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: row.ticket.slice(0, row.ticket.lastIndexOf("#")),
      text: `${pair[0]} and ${pair[1]} exceeded ${COMMS_CHATTER_ROUNDS} rounds on ${row.ticket}.`,
      at: row.at,
    });
  }

  private insertComms(row: NewCommsRow, text: string, replyTo: number | null): number {
    const inserted = this.db
      .prepare(
        "INSERT INTO comms (at, from_id, to_id, ticket, text, label, ref, reply_to, target_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.at,
        row.from,
        row.to,
        row.ticket,
        text,
        row.label ?? null,
        row.ref ?? null,
        replyTo,
        row.targetRunId ?? null,
      );
    const id = Number(inserted.lastInsertRowid);
    const mention = this.db.prepare(
      "INSERT OR IGNORE INTO comms_mentions (message_id, mentioned_id) VALUES (?, ?)",
    );
    for (const target of row.mentions ?? []) mention.run(id, target);
    return id;
  }

  private commsRow(r: Row): CommsRow {
    const id = Number(r.id);
    const mentions = this.db
      .prepare("SELECT mentioned_id FROM comms_mentions WHERE message_id = ? ORDER BY mentioned_id")
      .all(id)
      .map((m) => m.mentioned_id as string);
    return {
      id: `comms:${id}`,
      at: r.at as number,
      from: r.from_id as string,
      to: r.to_id as string,
      ticket: r.ticket as string | null,
      text: r.text as string,
      label: r.label as CommsLabel | null,
      ref: r.ref as string | null,
      replyTo: r.reply_to == null ? null : `comms:${r.reply_to}`,
      mentions,
    };
  }

  commsMessage(id: string): CommsRow | null {
    const n = commsMessageNumber(id);
    if (n === null) return null;
    return this.commsMessageByNumber(n);
  }

  private commsMessageByNumber(id: number): CommsRow | null {
    const row = this.db.prepare("SELECT * FROM comms WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? null : this.commsRow(row);
  }

  addCommsReaction(
    messageId: string,
    actor: string,
    reaction: CommsReactionKind,
    reason: string | undefined,
    at: number,
  ): CommsReaction | null {
    const id = commsMessageNumber(messageId);
    if (id === null) return null;
    const message = this.commsMessageByNumber(id);
    if (message === null) return null;
    this.db
      .prepare(`INSERT INTO comms_reactions (message_id, actor_id, reaction, reason, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(message_id, actor_id) DO UPDATE SET reaction=excluded.reaction, reason=excluded.reason, at=excluded.at`)
      .run(id, actor, reaction, reason ?? null, at);
    return { messageId: message.id, actor, reaction, reason: reason ?? null, at };
  }

  setCommsPinned(messageId: string, pinned: boolean, actor: string, at: number): boolean {
    const id = commsMessageNumber(messageId);
    if (id === null) return false;
    const message = this.commsMessageByNumber(id);
    if (message === null) return false;
    if (pinned)
      this.db
        .prepare(
          "INSERT INTO comms_pins (message_id, pinned_by, pinned_at) VALUES (?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET pinned_by=excluded.pinned_by, pinned_at=excluded.pinned_at",
        )
        .run(id, actor, at);
    else this.db.prepare("DELETE FROM comms_pins WHERE message_id = ?").run(id);
    return true;
  }

  commsPins(): CommsRow[] {
    return (
      this.db
        .prepare(
          "SELECT c.* FROM comms c JOIN comms_pins p ON p.message_id=c.id ORDER BY p.pinned_at DESC",
        )
        .all() as Row[]
    ).map((r) => this.commsRow(r));
  }
  commsReactions(messageId: string): CommsReaction[] {
    const id = commsMessageNumber(messageId);
    if (id === null) return [];
    return this.db
      .prepare(
        "SELECT actor_id, reaction, reason, at FROM comms_reactions WHERE message_id=? ORDER BY at,actor_id",
      )
      .all(id)
      .map((r) => ({
        messageId: `comms:${id}`,
        actor: r.actor_id as string,
        reaction: r.reaction as CommsReactionKind,
        reason: r.reason as string | null,
        at: r.at as number,
      }));
  }
  commsSettlement(messageId: string): CommsSettlement | null {
    const id = commsMessageNumber(messageId);
    if (id === null) return null;
    const row = this.db
      .prepare("SELECT settled_by, reason, at FROM comms_settlements WHERE message_id=?")
      .get(id) as Row | undefined;
    return row === undefined
      ? null
      : {
          messageId,
          settledBy: row.settled_by as string,
          reason: row.reason as string,
          at: row.at as number,
        };
  }
  settleCommsItem(messageId: string, settledBy: string, reason: string, at: number): boolean {
    const id = commsMessageNumber(messageId);
    if (id === null || this.commsMessageByNumber(id) === null) return false;
    this.db
      .prepare(
        "INSERT INTO comms_settlements (message_id, settled_by, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING",
      )
      .run(id, settledBy, reason, at);
    return true;
  }
  commsMentions(target: string): CommsRow[] {
    return (
      this.db
        .prepare(
          "SELECT c.* FROM comms c JOIN comms_mentions m ON m.message_id=c.id WHERE m.mentioned_id=? ORDER BY c.at DESC,c.id DESC",
        )
        .all(target) as Row[]
    ).map((r) => this.commsRow(r));
  }
  markCommsMentionsSeen(target: string, ids: string[], at: number): void {
    const q = this.db.prepare(
      "UPDATE comms_mentions SET seen_at=? WHERE mentioned_id=? AND message_id=?",
    );
    for (const id of ids) {
      const number = commsMessageNumber(id);
      if (number !== null) q.run(at, target, number);
    }
  }
  commsMentionSeen(target: string, id: string): boolean {
    const number = commsMessageNumber(id);
    if (number === null) return false;
    return (
      (
        this.db
          .prepare("SELECT seen_at FROM comms_mentions WHERE mentioned_id=? AND message_id=?")
          .get(target, number) as { seen_at: number | null } | undefined
      )?.seen_at !== null
    );
  }
  commsForCrew(): CommsRow[] {
    return this.commsForWhere("to_id = 'crew'");
  }
  /** Seat-side reads include only general Comms and rows targeted at its live run. */
  commsForCrewRun(runId: string): CommsRow[] {
    return this.commsForRunWhere(runId, "to_id = 'crew'");
  }
  commsForAgent(id: string, contact?: string): CommsRow[] {
    return contact === undefined
      ? this.commsForWhere("from_id=? OR to_id=?", id, id)
      : this.commsForPair(id, contact);
  }
  commsForAgentRun(id: string, runId: string): CommsRow[] {
    return this.commsForRunWhere(runId, "from_id=? OR to_id=?", id, id);
  }
  commsInbox(id: string): CommsRow[] {
    return this.commsForWhere(
      `id IN (
        SELECT id FROM comms WHERE to_id=?
        UNION
        SELECT message_id FROM comms_mentions WHERE mentioned_id=?
        UNION
        SELECT reply.id FROM comms reply JOIN comms original ON reply.reply_to=original.id WHERE original.from_id=?
        UNION
        SELECT message_id FROM comms_pins
      )`,
      id,
      id,
      id,
    );
  }
  commsInboxRun(id: string, runId: string): CommsRow[] {
    return this.commsForWhere(
      `(
        (target_run_id IS NULL OR target_run_id = ?)
        AND id IN (
        SELECT id FROM comms WHERE to_id=?
        UNION
        SELECT message_id FROM comms_mentions WHERE mentioned_id=?
        UNION
        SELECT reply.id FROM comms reply JOIN comms original ON reply.reply_to=original.id WHERE original.from_id=?
        )
      ) OR id IN (SELECT message_id FROM comms_pins)`,
      runId,
      id,
      id,
      id,
    );
  }
  commsForPair(a: string, b: string): CommsRow[] {
    return this.commsForWhere("(from_id=? AND to_id=?) OR (from_id=? AND to_id=?)", a, b, b, a);
  }
  private commsScopeWhere(scope: CommsReadScope): { where: string; args: SQLInputValue[] } {
    if ("crew" in scope) return { where: "to_id = 'crew'", args: [] };
    if ("pair" in scope) {
      const [a, b] = scope.pair;
      return { where: "((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))", args: [a, b, b, a] };
    }
    if ("agent" in scope)
      return { where: "(from_id=? OR to_id=?)", args: [scope.agent, scope.agent] };
    const id = scope.inbox;
    return {
      where: `id IN (
        SELECT id FROM comms WHERE to_id=?
        UNION
        SELECT message_id FROM comms_mentions WHERE mentioned_id=?
        UNION
        SELECT reply.id FROM comms reply JOIN comms original ON reply.reply_to=original.id WHERE original.from_id=?
        UNION
        SELECT message_id FROM comms_pins
      )`,
      args: [id, id, id],
    };
  }
  /**
   * The newest `limit` messages of a scope, oldest first, strictly older than `before` when given.
   * `hasMore` says older ones remain, so the HUD can offer "load older".
   */
  commsPage(
    scope: CommsReadScope,
    limit: number,
    before?: string,
  ): { rows: CommsRow[]; hasMore: boolean } {
    const { where, args } = this.commsScopeWhere(scope);
    const beforeId = before === undefined ? null : commsMessageNumber(before);
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM comms WHERE ${where}${
            beforeId === null ? "" : " AND (at, id) < (SELECT at, id FROM comms WHERE id = ?)"
          } ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(...args, ...(beforeId === null ? [] : [beforeId]), limit + 1) as Row[]
    ).map((r) => this.commsRow(r));
    const hasMore = rows.length > limit;
    return { rows: rows.slice(0, limit).reverse(), hasMore };
  }
  /** How many messages a scope holds, and how many of them come after the read cursor. */
  commsCounts(scope: CommsReadScope, cursor: string | null): { count: number; unread: number } {
    const { where, args } = this.commsScopeWhere(scope);
    const offset = cursor === null ? 0 : (commsMessageNumber(cursor) ?? 0);
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(id > ?), 0) AS unread FROM comms WHERE ${where}`,
      )
      .get(offset, ...args) as { count: number; unread: number };
    return { count: r.count, unread: r.unread };
  }
  /** Everyone `id` has exchanged messages with, in first-contact order. */
  commsContactIds(id: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END AS contact
          FROM comms WHERE from_id=? OR to_id=? GROUP BY contact ORDER BY MIN(id)`,
        )
        .all(id, id, id) as { contact: string }[]
    ).map((r) => r.contact);
  }
  commsForRefs(refs: string[]): CommsRow[] {
    if (!refs.length) return [];
    return this.commsForWhere(`ref IN (${refs.map(() => "?").join(",")})`, ...refs);
  }
  commsForTicket(
    ref: string,
    ticketContext?: string,
  ): {
    ref: string;
    linkedPr: string | null;
    repoId: string | null;
    rows: CommsRow[];
  } {
    const prNumber = ref.startsWith("PR ") ? Number(ref.slice(3)) : null;
    let issueNumber = ref.startsWith("#") ? Number(ref.slice(1)) : null;
    const qualified = ticketContext?.match(/^(.+)#(\d+)$/);
    // A #n link may only carry its own ticket. PR links keep their PR number and use the ticket
    // solely as repository context.
    const scopedTicket =
      qualified && (issueNumber === null || Number(qualified[2]) === issueNumber)
        ? ticketContext
        : undefined;
    const scopedRepoId = scopedTicket === undefined ? undefined : (qualified?.[1] as string);
    let linkedPr: string | null = null;
    let linkedRows: { number: number; repoId: string; ticket: string | null }[] = [];
    if (prNumber !== null) {
      linkedRows = this.db
        .prepare(
          `SELECT number, repo_id, ticket FROM pull_requests WHERE number=?${
            scopedRepoId === undefined ? "" : " AND repo_id=?"
          } ORDER BY updated_at DESC`,
        )
        .all(prNumber, ...(scopedRepoId === undefined ? [] : [scopedRepoId]))
        .map((row) => ({
          number: row.number as number,
          repoId: row.repo_id as string,
          ticket: row.ticket as string | null,
        }));
      const row = linkedRows[0];
      const match = row?.ticket?.match(/#(\d+)$/);
      issueNumber = match === null || match === undefined ? null : Number(match[1]);
      linkedPr = `PR ${prNumber}`;
    } else if (issueNumber !== null) {
      linkedRows = this.db
        .prepare(
          scopedRepoId === undefined
            ? "SELECT number, repo_id, ticket FROM pull_requests WHERE ticket GLOB ? ORDER BY updated_at DESC"
            : "SELECT number, repo_id, ticket FROM pull_requests WHERE ticket=? AND repo_id=? ORDER BY updated_at DESC",
        )
        .all(
          ...(scopedRepoId === undefined
            ? [`*#${issueNumber}`]
            : [scopedTicket as string, scopedRepoId]),
        )
        .map((row) => ({
          number: row.number as number,
          repoId: row.repo_id as string,
          ticket: row.ticket as string | null,
        }));
      linkedPr = linkedRows[0] === undefined ? null : `PR ${linkedRows[0].number}`;
    }
    const resolvedRef = issueNumber === null ? ref : `#${issueNumber}`;
    const refs = linkedPr === null ? [resolvedRef] : [resolvedRef, linkedPr];
    const predicates = [`ref IN (${refs.map(() => "?").join(",")})`, "text LIKE ?"];
    const args: SQLInputValue[] = [...refs, `%${resolvedRef}%`];
    if (linkedPr !== null) {
      predicates.push("text LIKE ?");
      args.push(`%${linkedPr}%`);
    }
    const ticketPredicate =
      scopedTicket === undefined
        ? ""
        : prNumber === null
          ? " AND ticket=?"
          : " AND substr(ticket, 1, length(?))=?";
    const ticketArgs: SQLInputValue[] =
      scopedTicket === undefined
        ? []
        : prNumber === null
          ? [scopedTicket]
          : [`${scopedRepoId}#`, `${scopedRepoId}#`];
    const rows = this.commsForWhere(
      `(${predicates.join(" OR ")})${ticketPredicate}`,
      ...args,
      ...ticketArgs,
    ).filter((row) => {
      if (refs.includes(row.ref ?? "")) return true;
      return refs.some((candidate) =>
        new RegExp(`(^|[^A-Za-z0-9])${candidate.replace("#", "\\#")}(?=$|[^A-Za-z0-9])`).test(
          row.text,
        ),
      );
    });
    const repoIds = new Set<string>();
    const repoFor = (ticket: string | null): string | null => {
      const match = ticket?.match(/^(.+)#(\d+)$/);
      return match?.[2] === String(issueNumber) ? (match[1] ?? null) : null;
    };
    // A clicked hub-set ticket is authoritative. Otherwise the linked PR's repo wins; without
    // either, only rows explicitly tagged with this ref count. A mere text mention never attributes.
    if (scopedRepoId !== undefined) repoIds.add(scopedRepoId);
    else for (const row of linkedRows) repoIds.add(row.repoId);
    if (repoIds.size === 0) {
      for (const row of rows) {
        if (!refs.includes(row.ref ?? "")) continue;
        const repoId = repoFor(row.ticket);
        if (repoId !== null) repoIds.add(repoId);
      }
    }
    return {
      ref: resolvedRef,
      linkedPr,
      repoId: repoIds.size === 1 ? [...repoIds][0] : null,
      rows,
    };
  }
  commsLinkedPr(ref: string): string | null {
    const ticket = Number(ref.replace(/^(?:#|PR )/, ""));
    const row = this.db
      .prepare("SELECT number FROM pull_requests WHERE ticket=? ORDER BY number DESC LIMIT 1")
      .get(ticket) as { number: number } | undefined;
    return row === undefined ? null : `PR ${row.number}`;
  }
  private commsForWhere(where: string, ...args: SQLInputValue[]): CommsRow[] {
    return (
      this.db.prepare(`SELECT * FROM comms WHERE ${where} ORDER BY at,id`).all(...args) as Row[]
    ).map((r) => this.commsRow(r));
  }
  private commsForRunWhere(runId: string, where: string, ...args: SQLInputValue[]): CommsRow[] {
    return this.commsForWhere(
      `(${where}) AND (target_run_id IS NULL OR target_run_id = ?)`,
      ...args,
      runId,
    );
  }
  /**
   * Direct-link counts since `since`, each with its newest message (id, time and the first
   * COMMS_LINK_PREVIEW characters) so the Comms graph can show it and spot a new one.
   */
  commsLinkCounts(since: number, until = Date.now()): CommsLinkCount[] {
    const rows = this.db
      .prepare(
        `SELECT c.from_id AS 'from', c.to_id AS 'to', g.count AS count, c.id AS lastId,
          c.at AS lastAt, substr(c.text, 1, ?) AS lastText
        FROM (SELECT from_id, to_id, COUNT(*) AS count, MAX(id) AS last FROM comms WHERE at>=?
          GROUP BY from_id,to_id) g
        JOIN comms c ON c.id = g.last
        ORDER BY c.from_id, c.to_id`,
      )
      .all(COMMS_LINK_PREVIEW, since) as Row[];
    return rows.map((r) => ({
      from: r.from as string,
      to: r.to as string,
      count: r.count as number,
      lastId: `comms:${r.lastId as number}`,
      lastAt: r.lastAt as number,
      lastText: r.lastText as string,
      tokens: this.commsTokenTotal(r.from as string, r.to as string, null, since, until),
    }));
  }
  /** Hourly direct-link counts for the Comms Traffic chart. */
  commsHourlyLinkCounts(
    since: number,
  ): { hour: number; from: string; to: string; count: number }[] {
    return this.db
      .prepare(
        "SELECT (at / 3600000) * 3600000 AS hour, from_id AS 'from', to_id AS 'to', COUNT(*) AS count FROM comms WHERE at>=? GROUP BY hour, from_id, to_id ORDER BY hour, from_id, to_id",
      )
      .all(since) as { hour: number; from: string; to: string; count: number }[];
  }
  /** Back-and-forth pairs on one ticket; a round needs a message in each direction. */
  commsChatter(
    since: number,
    until = Number.MAX_SAFE_INTEGER,
    flightId?: string,
  ): {
    from: string;
    to: string;
    ticket: string;
    rounds: number;
    tokens: number;
    flightSteppedInAt: number | null;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT "from", "to", ticket, first_at, last_at,
          CASE WHEN forward_count < reverse_count THEN forward_count ELSE reverse_count END AS rounds
        FROM (
          SELECT CASE WHEN from_id < to_id THEN from_id ELSE to_id END AS 'from',
            CASE WHEN from_id < to_id THEN to_id ELSE from_id END AS 'to', ticket,
            SUM(CASE WHEN from_id < to_id THEN 1 ELSE 0 END) AS forward_count,
            SUM(CASE WHEN from_id > to_id THEN 1 ELSE 0 END) AS reverse_count,
            MIN(at) AS first_at, MAX(at) AS last_at
          FROM comms
          WHERE at >= ? AND at <= ? AND ticket IS NOT NULL
            AND from_id NOT IN (?, ?, ?) AND to_id NOT IN (?, ?, ?) AND from_id != to_id
          GROUP BY ticket, CASE WHEN from_id < to_id THEN from_id ELSE to_id END,
            CASE WHEN from_id < to_id THEN to_id ELSE from_id END
        )
        WHERE CASE WHEN forward_count < reverse_count THEN forward_count ELSE reverse_count END > ?
        ORDER BY rounds DESC, ticket, "from", "to"`,
      )
      .all(
        since,
        until,
        COMMS_CAPCOM,
        COMMS_MC,
        COMMS_CREW,
        COMMS_CAPCOM,
        COMMS_MC,
        COMMS_CREW,
        COMMS_CHATTER_ROUNDS,
      ) as Row[];
    return rows.map((row) => {
      const from = row.from as string;
      const to = row.to as string;
      const ticket = row.ticket as string;
      const thresholdAt = this.chatterThresholdAt(from, to, ticket, since, until);
      return {
        from,
        to,
        ticket,
        rounds: row.rounds as number,
        tokens: this.commsTokenTotal(
          from,
          to,
          ticket,
          row.first_at as number,
          row.last_at as number,
        ),
        flightSteppedInAt:
          flightId === undefined || thresholdAt === null
            ? null
            : ((
                this.db
                  .prepare(
                    "SELECT MIN(at) AS at FROM comms WHERE from_id = ? AND to_id IN (?, ?) AND ticket = ? AND at >= ? AND at <= ?",
                  )
                  .get(flightId, from, to, ticket, thresholdAt, until) as { at: number | null }
              ).at ?? null),
      };
    });
  }

  /** The message which first completes the over-limit reciprocal exchange in this rolling window. */
  private chatterThresholdAt(
    from: string,
    to: string,
    ticket: string,
    since: number,
    until: number,
  ): number | null {
    const messages = this.db
      .prepare(
        `SELECT at, from_id FROM comms WHERE ticket = ? AND at >= ? AND at <= ?
         AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) ORDER BY at, id`,
      )
      .all(ticket, since, until, from, to, to, from) as { at: number; from_id: string }[];
    let forward = 0;
    let reverse = 0;
    for (const message of messages) {
      if (message.from_id === from) forward++;
      else reverse++;
      if (Math.min(forward, reverse) > COMMS_CHATTER_ROUNDS) return message.at;
    }
    return null;
  }

  /** Tokens consumed by either end's runs overlapping a Comms link's observed window. */
  private commsTokenTotal(
    from: string,
    to: string,
    ticket: string | null,
    since: number,
    until: number,
  ): number {
    const rows = this.db
      .prepare(
        `SELECT tokens FROM runs WHERE agent_id IN (?, ?) AND started_at <= ?
         AND (ended_at IS NULL OR ended_at >= ?)${ticket === null ? "" : " AND ticket = ?"}`,
      )
      .all(
        ...(ticket === null ? [from, to, until, since] : [from, to, until, since, ticket]),
      ) as Row[];
    return rows.reduce((total, row) => {
      if (row.tokens === null) return total;
      const tokens = JSON.parse(row.tokens as string) as TokenUsage;
      return total + tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
    }, 0);
  }

  /** Labelled direct questions and blockers still awaiting their addressee's reply or reaction. */
  openCommsItems(): (CommsRow & { label: "question" | "blocker" })[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM comms c
         WHERE c.label IN ('question', 'blocker') AND c.to_id != ?
           AND NOT EXISTS (
             SELECT 1 FROM comms_reactions r WHERE r.message_id = c.id AND r.actor_id = c.to_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM comms reply
             WHERE reply.reply_to = c.id AND reply.from_id = c.to_id
           )
           AND NOT EXISTS (SELECT 1 FROM comms_settlements s WHERE s.message_id = c.id)
         ORDER BY c.at ASC, c.id ASC`,
      )
      .all(COMMS_CREW) as Row[];
    return rows.map((row) => this.commsRow(row) as CommsRow & { label: "question" | "blocker" });
  }
  markCommsScopeRead(scope: string, messageId: string): void {
    const id = commsMessageNumber(messageId);
    if (id === null) return;
    this.db
      .prepare(
        `INSERT INTO comms_reads(thread_id,source_id,offset,block) VALUES (?, 'comms', ?, 0) ON CONFLICT(thread_id,source_id) DO UPDATE SET offset=MAX(offset,excluded.offset)`,
      )
      .run(scope, id);
  }
  commsScopeCursor(scope: string): string | null {
    const r = this.db
      .prepare("SELECT offset FROM comms_reads WHERE thread_id=? AND source_id='comms'")
      .get(scope) as { offset: number } | undefined;
    return r ? `comms:${r.offset}` : null;
  }
  /** Seat delivery receipts, deliberately separate from the operator's UI cursor. */
  commsInboxRead(seatId: string, messageId: string): boolean {
    const id = commsMessageNumber(messageId);
    if (id === null) return false;
    return (
      this.db
        .prepare("SELECT 1 FROM comms_inbox_reads WHERE seat_id=? AND message_id=?")
        .get(seatId, id) !== undefined
    );
  }
  markCommsInboxRead(seatId: string, messageIds: readonly string[]): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO comms_inbox_reads(seat_id,message_id) VALUES (?,?)",
    );
    this.transaction(() => {
      for (const messageId of messageIds) {
        const id = commsMessageNumber(messageId);
        if (id !== null) insert.run(seatId, id);
      }
    }, true);
  }

  /** The hand-offs at or after `since`, oldest first. */
  comms(since: number, targetRunId?: string): CommsRow[] {
    const rows = this.db
      .prepare(
        targetRunId === undefined
          ? `SELECT * FROM (
               SELECT * FROM comms WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?
             ) ORDER BY at, id`
          : `SELECT * FROM (
               SELECT * FROM (
                 SELECT * FROM comms WHERE at >= ? AND target_run_id IS NULL
                 UNION ALL
                 SELECT * FROM comms WHERE at >= ? AND target_run_id = ?
               ) ORDER BY at DESC, id DESC LIMIT ?
             ) ORDER BY at, id`,
      )
      .all(
        since,
        ...(targetRunId === undefined ? [] : [since, targetRunId]),
        LIVE_COMMS_LIMIT,
      ) as Row[];
    // Activity's long-standing feed deliberately remains its compact legacy shape. New Comms
    // readers use the scoped methods above, which include metadata and related rows.
    return rows.map((r) => ({
      at: r.at as number,
      from: r.from_id as string,
      to: r.to_id as string,
      ticket: r.ticket as string | null,
      text: r.text as string,
    })) as CommsRow[];
  }

  /** How many hand-offs `from` sent `to` at or after `since`. */
  commsCountTo(from: string, to: string, since: number): number {
    const r = this.statement(
      "SELECT COUNT(*) AS n FROM comms WHERE from_id = ? AND to_id = ? AND at >= ?",
    ).get(from, to, since) as { n: number };
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
    return rows.reverse().map((r) => this.commsRow(r));
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
        ? this.db
            .prepare(`SELECT * FROM (
              SELECT * FROM loop_events WHERE at >= ? ORDER BY at DESC, key DESC LIMIT ?
            ) ORDER BY at, key`)
            .all(since, LIVE_LOOP_EVENTS_LIMIT)
        : this.db
            .prepare(`SELECT * FROM (
              SELECT e.* FROM loop_events e JOIN runs r ON r.id = e.run_id
              WHERE e.at >= ? AND r.repo_id = ? ORDER BY e.at DESC, e.key DESC LIMIT ?
            ) ORDER BY at, key`)
            .all(since, repoId, LIVE_LOOP_EVENTS_LIMIT)
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

  /** Updates one open operator item in place, keeping its key and history. */
  refreshNote(n: NoteInput): void {
    this.db
      .prepare(
        `INSERT INTO attention_notes (key, kind, run_id, seat_id, repo_id, text, at, cleared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, run_id = excluded.run_id,
           seat_id = excluded.seat_id, repo_id = excluded.repo_id, text = excluded.text,
           at = excluded.at, cleared_at = NULL, dismissed_at = NULL`,
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

  /** Seat sessions for the configured HUD rows, indexed after one table read. */
  seatSessions(seatIds: readonly AgentId[]): Map<AgentId, SeatSessionRow> {
    const out = new Map<AgentId, SeatSessionRow>();
    if (seatIds.length === 0) return out;
    const rows = this.statement(
      `SELECT * FROM seat_sessions WHERE seat_id IN (${seatIds.map(() => "?").join(", ")})`,
    ).all(...seatIds) as Row[];
    for (const row of rows) {
      const seat = seatRow(row);
      out.set(seat.seatId, seat);
    }
    return out;
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
             ELSE excluded.updated_at END,
           quiet_turns = CASE WHEN seat_sessions.run_id IS excluded.run_id THEN seat_sessions.quiet_turns ELSE 0 END`,
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

  /**
   * Records that the seat's turn ended at `at`; null: no turn of the seat's current run has. A turn
   * that made no commit since the one before it adds to the seat's quiet turns; a commit clears them.
   */
  setSeatTurnEnded(seatId: string, at: number | null): void {
    const row = this.db
      .prepare("SELECT run_id, last_turn_ended_at FROM seat_sessions WHERE seat_id = ?")
      .get(seatId) as { run_id: string | null; last_turn_ended_at: number | null } | undefined;
    const newest = row?.run_id ? this.newestRunCommit(row.run_id) : null;
    const committed = newest !== null && newest.at > (row?.last_turn_ended_at ?? 0);
    this.db
      .prepare(
        "UPDATE seat_sessions SET last_turn_ended_at = ?, quiet_turns = CASE WHEN ? THEN 0 ELSE quiet_turns + 1 END WHERE seat_id = ?",
      )
      .run(at, at === null || committed ? 1 : 0, seatId);
  }

  /** Records that the seat started a turn at `at`. */
  setSeatTurnStarted(seatId: string, at: number): void {
    this.db
      .prepare("UPDATE seat_sessions SET last_turn_started_at = ? WHERE seat_id = ?")
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

  /** A configured check ran to its end on `headSha`: `ok` when the command exited successfully. */
  addCheckRun(c: {
    runId: string;
    command: string;
    invokedCommand?: string;
    headSha: string;
    ok: boolean;
    exitCode?: number | null;
    at: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO check_runs (run_id, command, invoked_command, head_sha, ok, exit_code, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        c.runId,
        c.command,
        c.invokedCommand ?? c.command,
        c.headSha,
        c.ok ? 1 : 0,
        c.exitCode ?? null,
        c.at,
      );
  }

  /** The newest run of `command` by this run on exactly `headSha`, or null if there is none. */
  latestCheckRun(
    runId: string,
    command: string,
    headSha: string,
  ): {
    headSha: string;
    invokedCommand: string;
    ok: boolean;
    exitCode: number | null;
    at: number;
  } | null {
    const r = this.db
      .prepare(
        `SELECT head_sha, invoked_command, ok, exit_code, at FROM check_runs
         WHERE run_id = ? AND command = ? AND head_sha = ?
         ORDER BY at DESC, id DESC LIMIT 1`,
      )
      .get(runId, command, headSha) as Row | undefined;
    return r === undefined
      ? null
      : {
          headSha: r.head_sha as string,
          invokedCommand: (r.invoked_command as string | null) ?? command,
          ok: r.ok === 1,
          exitCode: (r.exit_code as number | null) ?? null,
          at: r.at as number,
        };
  }

  /** The newest result this run recorded for `command`, regardless of commit. */
  newestCheckRun(
    runId: string,
    command: string,
  ): {
    headSha: string;
    invokedCommand: string;
    ok: boolean;
    exitCode: number | null;
    at: number;
  } | null {
    const r = this.db
      .prepare(
        `SELECT head_sha, invoked_command, ok, exit_code, at FROM check_runs WHERE run_id = ? AND command = ?
         ORDER BY at DESC, id DESC LIMIT 1`,
      )
      .get(runId, command) as Row | undefined;
    return r === undefined
      ? null
      : {
          headSha: r.head_sha as string,
          invokedCommand: (r.invoked_command as string | null) ?? command,
          ok: r.ok === 1,
          exitCode: (r.exit_code as number | null) ?? null,
          at: r.at as number,
        };
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
    this.db
      .prepare("DELETE FROM test_lock_runs WHERE started_at < ?")
      .run(h.since - QA_RETENTION_DAYS * 86400000);
  }

  /**
   * One held call ended. `failed` is the Post hook event (PostToolUseFailure): the hold's outcome is
   * `fail` when any of its calls failed, else `pass`; with no event (undefined) it is `done`.
   */
  deleteLockHold(runId: string, toolUseId: string, at = Date.now(), failed?: boolean): void {
    this.db
      .prepare("DELETE FROM test_lock_holds WHERE run_id = ? AND tool_use_id = ?")
      .run(runId, toolUseId);
    if (failed === true) {
      this.db
        .prepare("UPDATE test_lock_runs SET outcome = 'fail' WHERE run_id = ? AND ended_at IS NULL")
        .run(runId);
    }
    this.db
      .prepare(`UPDATE test_lock_runs SET ended_at = ?,
        outcome = CASE WHEN outcome = 'fail' THEN 'fail' WHEN ? IS NULL THEN 'done' ELSE 'pass' END
      WHERE run_id = ? AND ended_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM test_lock_holds WHERE run_id = ?
      )`)
      .run(at, failed === undefined ? null : 1, runId, runId);
  }

  /** Every held call of the run. */
  deleteLockHolds(runId: string, at = Date.now()): void {
    this.db.prepare("DELETE FROM test_lock_holds WHERE run_id = ?").run(runId);
    this.db
      .prepare(
        "UPDATE test_lock_runs SET ended_at = ?, outcome = CASE WHEN outcome = 'fail' THEN 'fail' ELSE 'freed' END WHERE run_id = ? AND ended_at IS NULL",
      )
      .run(at, runId);
  }

  /** Holds of the test lock started or ended since `since`, newest first, with their run's ticket. */
  lockRuns(since: number): TestLockRun[] {
    const rows = this.db
      .prepare(`SELECT h.*, r.ticket FROM test_lock_runs h
      LEFT JOIN runs r ON r.id = h.run_id WHERE h.started_at >= ? OR h.ended_at >= ?
      ORDER BY h.started_at DESC, h.id DESC`)
      .all(since, since) as Row[];
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

  /** Check runs last read since `since`, newest first. */
  ciRuns(since: number): CiRunView[] {
    const rows = this.db
      .prepare("SELECT * FROM ci_runs WHERE at >= ? ORDER BY at DESC, name, attempt DESC")
      .all(since) as Row[];
    return rows.map((r) => ({
      repoId: r.repo_id as string,
      prNumber: r.pr_number as number,
      sha: r.sha as string,
      workflow: r.workflow as string | null,
      name: r.name as string,
      attempt: r.attempt as number,
      state: r.state as CiRunView["state"],
      conclusion: r.conclusion as string,
      url: r.url as string | null,
      firstSeenAt: r.first_seen_at as number,
      at: r.at as number,
    }));
  }

  /** The repo's milestones, from the last full read. */
  replaceMilestones(repoId: RepoId, goals: RepoGoal[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM milestones WHERE repo_id = ?").run(repoId);
      const ins = this.db.prepare(
        `INSERT INTO milestones (repo_id, number, title, state, due_on, open, closed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const g of goals) ins.run(repoId, g.number, g.title, g.state, g.dueOn, g.open, g.closed);
    });
  }

  milestones(repoId?: RepoId): RepoGoal[] {
    const rows = (
      repoId === undefined
        ? this.db.prepare("SELECT * FROM milestones ORDER BY repo_id, number").all()
        : this.db.prepare("SELECT * FROM milestones WHERE repo_id = ? ORDER BY number").all(repoId)
    ) as Row[];
    return rows.map((r) => ({
      repoId: r.repo_id as RepoId,
      number: r.number as number,
      title: r.title as string,
      state: r.state as RepoGoal["state"],
      dueOn: r.due_on as number | null,
      open: r.open as number,
      closed: r.closed as number,
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
    const r = this.statement("SELECT sha, at FROM run_pushes WHERE run_id = ?").get(runId) as
      | { sha: string; at: number }
      | undefined;
    return r ? { sha: r.sha, at: r.at } : null;
  }

  /** Records strays; one already there (same session and path) takes the new seat, kind and time. */
  addStrays(strays: Omit<Stray, "key">[]): void {
    this.transaction(() => {
      const ins = this.db.prepare(
        // `at` stays first-seen: a retry of the same stray is not a new one (its ack holds)
        `INSERT INTO strays (key, session_id, path, agent_id, kind, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET agent_id = excluded.agent_id, kind = excluded.kind`,
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

  /** When the seat asked its questions, answered or not (ask_flight mirrors each to Comms). */
  questionTimes(agentId: AgentId): Set<number> {
    const rows = this.db
      .prepare("SELECT at FROM seat_questions WHERE agent_id = ?")
      .all(agentId) as { at: number }[];
    return new Set(rows.map((r) => r.at));
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
   * Hands a passed, still open question back to FLIGHT (#758): FLIGHT kept it, or it was passed
   * without a brief before #758. True only when it was passed.
   */
  unpassQuestion(id: number): boolean {
    const r = this.db
      .prepare(
        "UPDATE seat_questions SET passed_at = NULL WHERE id = ? AND answered_at IS NULL AND passed_at IS NOT NULL",
      )
      .run(id);
    return Number(r.changes) > 0;
  }

  /** Marks one open question answered at `at`. */
  answerQuestion(id: number, at: number): void {
    this.db
      .prepare("UPDATE seat_questions SET answered_at = ? WHERE id = ? AND answered_at IS NULL")
      .run(at, id);
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

  /** Stores a FLIGHT wake on the run it woke, with the fact categories that caused it. */
  addFlightWake(runId: string, at: number, reasons: string[]): void {
    this.db
      .prepare("INSERT OR REPLACE INTO flight_wakes (run_id, at, reasons) VALUES (?, ?, ?)")
      .run(runId, at, JSON.stringify(reasons));
  }

  /** FLIGHT's wakes at or after `since`, oldest first. */
  flightWakes(since: number): FlightWakeRecord[] {
    const rows = this.db
      .prepare("SELECT run_id, at, reasons FROM flight_wakes WHERE at >= ? ORDER BY at, run_id")
      .all(since) as { run_id: string; at: number; reasons: string }[];
    return rows.map((r) => ({
      runId: r.run_id,
      at: r.at,
      reasons: JSON.parse(r.reasons) as string[],
    }));
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
  addBrief(b: AttentionBrief & { key: string; defaultEligible?: boolean }): number {
    let id = 0;
    this.transaction(() => {
      const {
        key,
        context,
        recommendation,
        options,
        basis,
        at,
        defaultEligible = true,
        ...structured
      } = b;
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
      // A rebrief with the same ask (for the same reader) keeps when that ask began; a new or
      // changed ask begins at its own `at`, so it carries no askAt.
      delete structured.askAt;
      const last = this.db
        .prepare("SELECT at, structured FROM briefs WHERE key = ? ORDER BY id DESC LIMIT 1")
        .get(key) as { at: number; structured: string | null } | undefined;
      const prior: AttentionBrief | null = last?.structured ? JSON.parse(last.structured) : null;
      if (last !== undefined && prior?.ask === structured.ask && prior?.for === structured.for)
        structured.askAt = prior?.askAt ?? last.at;
      delete structured.defaultAt;
      if (defaultEligible && structured.for !== "flight" && structured.recommendedOptionId) {
        const kept = structured.askAt !== undefined ? prior?.defaultAt : undefined;
        // The wait starts when a default is first stamped, never at an older ask's time: an ask
        // briefed before defaults existed must not come due the moment it is briefed again.
        structured.defaultAt = kept ?? at + DECISION_DEFAULT_WAIT_MS;
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

  /** Whether the key was ever briefed for the operator (a brief with no reader predates routing). */
  operatorBriefed(key: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM briefs WHERE key = ? AND (structured IS NULL OR json_extract(structured, '$.for') IS NOT 'flight') LIMIT 1",
        )
        .get(key) !== undefined
    );
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
