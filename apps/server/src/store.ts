import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  type AccountId,
  type AgentId,
  type AttentionKind,
  BLOCKING_SEVERITIES,
  type BoardItem,
  type Escalation,
  type FlightDecision,
  type FlightDecisionKind,
  type FlightMoveColumn,
  type FlowIssue,
  type FlowPr,
  GUARD_HITS_LIMIT,
  GUARD_RULES,
  type GuardHit,
  type GuardRule,
  type HealthRow,
  type HudState,
  inferTicket,
  type MachineSample,
  type MoveColumn,
  type PullRequestView,
  type RepoGoal,
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
  TITLE_MARKERS,
  type TokenUsage,
  type UsageSample,
} from "@mc/core";

const SCHEMA = `
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
CREATE TABLE IF NOT EXISTS goals (
  repo_id TEXT PRIMARY KEY, title TEXT NOT NULL, due_on INTEGER, open INTEGER NOT NULL,
  closed INTEGER NOT NULL
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
CREATE INDEX IF NOT EXISTS run_commits_branch ON run_commits(repo_id, branch);
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
`;

type Row = Record<string, SQLInputValue>;

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
  goals: "repo_id",
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
export type SeatLineOrigin = "operator" | "engine";

/** A line sent to a seat; its key is what makes sending it once-only. */
export interface SeatLine {
  runId: string;
  seatId: string;
  origin: SeatLineOrigin;
  text: string;
  at: number;
}

/** One Activity `loop` row. */
export interface LoopEvent {
  key: string;
  runId: string;
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

const toRun = (r: Row): Run => ({
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
  ...(r.ended_by === null || r.ended_by === undefined
    ? {}
    : { endedBy: r.ended_by as NonNullable<Run["endedBy"]> }),
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
  seatId: r.seat_id as string,
  runId: r.run_id as string | null,
  cliSessionId: r.cli_session_id as string | null,
  state: r.state as SeatState,
  reason: r.reason as string | null,
  worktree: r.worktree as string | null,
  updatedAt: r.updated_at as number,
  lastTurnEndedAt: (r.last_turn_ended_at as number | null | undefined) ?? null,
});

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
    this.db.exec(SCHEMA);
    this.migrate();
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
      ["prs", "TEXT NOT NULL DEFAULT '[]'"],
      ["summary", "TEXT"],
      ["folded", "INTEGER NOT NULL DEFAULT 0"],
      // The first loop's state (JSON) and who ended the run; `upsertRun` never writes them.
      ["loop", "TEXT"],
      ["ended_by", "TEXT"],
      // The ticket's title as the run started with it; null on rows from before it was stored.
      ["ticket_title", "TEXT"],
      // The review a run performs (7b-1); `upsertRun` never rewrites it.
      ["review_id", "INTEGER"],
      // The `claude` CLI version the run started on; null on rows from before it was recorded.
      ["cli_version", "TEXT"],
    ];
    for (const [column, type] of runColumns) this.addColumn("runs", column, type);
    // 0 / null: stored before the card ids were read; the next GitHub poll fills them.
    this.addColumn("board_items", "created_at", "INTEGER NOT NULL DEFAULT 0");
    // When the seat's last turn ended; the engine's quiet-seat check reads it.
    this.addColumn("seat_sessions", "last_turn_ended_at", "INTEGER");
    this.addColumn("board_items", "item_id", "TEXT");
    this.addColumn("board_items", "project_id", "TEXT");
    // When FLIGHT passed the question to the operator (it stays open until they answer).
    this.addColumn("seat_questions", "passed_at", "INTEGER");
    // When the operator dismissed the note from Needs you; a re-raised note is shown again.
    this.addColumn("attention_notes", "dismissed_at", "INTEGER");
    // A PR snapshot's `polledAt` is `read_at` (our clock, written with every upsert); there is no
    // separate column. `mergeable` UNKNOWN means GitHub has not computed it yet: poll again.
    this.addColumn("pull_requests", "head_sha", "TEXT");
    this.addColumn("pull_requests", "mergeable", "TEXT");
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

  /**
   * `folded`: the caller folded the run's transcript into `r`. The row is marked folded once that
   * happens to an ended run, and the mark is never cleared. A new row takes `r.loop`; an existing
   * row's loop is never rewritten here (`setRunLoop`).
   */
  upsertRun(r: Run, folded = false): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, repo_id, seq, started_at, ended_at, status, session_id,
           model, branch, ticket, cost_usd, tokens, transcript_path, prs, summary, folded, loop,
           ticket_title, review_id, cli_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_id = excluded.agent_id, repo_id = excluded.repo_id, seq = excluded.seq,
           started_at = excluded.started_at, ended_at = excluded.ended_at, status = excluded.status,
           session_id = excluded.session_id, model = excluded.model, branch = excluded.branch,
           ticket = excluded.ticket, cost_usd = excluded.cost_usd, tokens = excluded.tokens,
           transcript_path = excluded.transcript_path, prs = excluded.prs,
           summary = excluded.summary, folded = MAX(folded, excluded.folded),
           ticket_title = COALESCE(excluded.ticket_title, ticket_title),
           cli_version = COALESCE(excluded.cli_version, cli_version)`,
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
      );
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
           closed, priority_source, created_at, item_id, project_id, assignees)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, issue_number) DO UPDATE SET title = excluded.title,
           status = excluded.status, state = excluded.state, labels = excluded.labels,
           priority = excluded.priority, updated_at = excluded.updated_at, url = excluded.url,
           stage = excluded.stage, owner = excluded.owner, parent = excluded.parent,
           sub_done = excluded.sub_done, sub_total = excluded.sub_total,
           blocked_by = excluded.blocked_by, milestone = excluded.milestone,
           size = excluded.size, closed = excluded.closed,
           priority_source = excluded.priority_source, created_at = excluded.created_at,
           item_id = excluded.item_id, project_id = excluded.project_id,
           assignees = excluded.assignees`,
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
        );
      }
    });
  }

  /** True when the stored row changed. */
  replaceGoal(repoId: RepoId, goal: RepoGoal | null): boolean {
    return this.changed("goals", repoId, () => {
      if (goal === null) {
        this.db.prepare("DELETE FROM goals WHERE repo_id = ?").run(repoId);
        return;
      }
      this.db
        .prepare(
          `INSERT INTO goals (repo_id, title, due_on, open, closed) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(repo_id) DO UPDATE SET title = excluded.title, due_on = excluded.due_on,
             open = excluded.open, closed = excluded.closed`,
        )
        .run(repoId, goal.title, goal.dueOn, goal.open, goal.closed);
    });
  }

  goal(repoId: RepoId): RepoGoal | null {
    const r = this.db.prepare("SELECT * FROM goals WHERE repo_id = ?").get(repoId) as
      | Row
      | undefined;
    return r
      ? {
          repoId: r.repo_id as string,
          title: r.title as string,
          dueOn: r.due_on as number | null,
          open: r.open as number,
          closed: r.closed as number,
        }
      : null;
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
         review, ci, created_at, updated_at, merged_at, read_at, head_sha, mergeable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, number) DO UPDATE SET title = excluded.title, url = excluded.url,
         branch = excluded.branch, ticket = excluded.ticket, state = excluded.state,
         is_draft = excluded.is_draft, review = excluded.review, ci = excluded.ci,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         merged_at = excluded.merged_at, read_at = excluded.read_at,
         head_sha = excluded.head_sha, mergeable = excluded.mergeable`,
    );
    for (const p of prs) {
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
      );
    }
  }

  pullRequests(repoId: RepoId): PullRequestView[] {
    const rows = this.db
      .prepare("SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY number DESC")
      .all(repoId) as Row[];
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
      mergeable: r.mergeable as PullRequestView["mergeable"],
    }));
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
  setRunLoop(runId: string, loop: RunLoop | null): void {
    this.db
      .prepare("UPDATE runs SET loop = ? WHERE id = ?")
      .run(loop === null ? null : JSON.stringify(loop), runId);
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

  /** Appends a note the run's seat reported; returns its id. */
  addEvidence(runId: string, note: string, at: number): number {
    const r = this.db
      .prepare("INSERT INTO run_evidence (run_id, note, at) VALUES (?, ?, ?)")
      .run(runId, note, at);
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

  /** The review the run (a review run) performs, else null. */
  reviewOfRun(reviewRunId: string): ReviewRow | null {
    const row = this.db.prepare("SELECT * FROM reviews WHERE run_id = ?").get(reviewRunId) as
      | Row
      | undefined;
    return row ? toReview(row) : null;
  }

  reviewsIn(states: readonly ReviewState[]): ReviewRow[] {
    if (states.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM reviews WHERE state IN (${states.map(() => "?").join(", ")})
         ORDER BY created_at, id`,
      )
      .all(...states) as Row[];
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
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO seat_lines (key, run_id, seat_id, origin, text, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(key, line.runId, line.seatId, line.origin, line.text, line.at);
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
    return r.changes === 1;
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

  /** The loop events at or after `since`, oldest first. */
  loopEvents(since: number): LoopEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM loop_events WHERE at >= ? ORDER BY at, key")
      .all(since) as Row[];
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

  /** Dismisses an open parked (`blocked`) note from Needs you; false when there is no such note. */
  dismissNote(key: string, at: number): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE attention_notes SET dismissed_at = ? WHERE key = ? AND kind = 'blocked' AND cleared_at IS NULL",
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
        `INSERT INTO seat_sessions (seat_id, run_id, cli_session_id, state, reason, worktree, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(seat_id) DO UPDATE SET run_id = excluded.run_id,
           cli_session_id = excluded.cli_session_id, state = excluded.state,
           reason = excluded.reason, worktree = excluded.worktree, updated_at = excluded.updated_at`,
      )
      .run(
        row.seatId,
        row.runId,
        row.cliSessionId,
        row.state,
        row.reason,
        row.worktree,
        row.updatedAt,
      );
  }

  /** Records that the seat's turn ended at `at`; null: no turn of the seat's current run has. */
  setSeatTurnEnded(seatId: string, at: number | null): void {
    this.db
      .prepare("UPDATE seat_sessions SET last_turn_ended_at = ? WHERE seat_id = ?")
      .run(at, seatId);
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

  /** The commits the commit tool made for a run, in the order it made them. */
  runCommits(runId: string): string[] {
    const rows = this.db
      .prepare("SELECT sha FROM run_commits WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as { sha: string }[];
    return rows.map((r) => r.sha);
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
