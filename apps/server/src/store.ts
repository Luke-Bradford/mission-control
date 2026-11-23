import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type {
  AttentionMaterials,
  BriefChoiceReceipt,
  PersonSource,
  PromptSection,
  PromptSectionCost,
  PromptWakeCost,
  QaHistoryEntry,
  QaReport,
  TicketQuestion,
  TokenCall,
  TokenSourceAdd,
} from "@mc/core";
import {
  type AccountId,
  type AdviceStep,
  type AgentId,
  ASKING_RUN_ENDED_REASON,
  type AttentionBrief,
  AUDIT_BASELINE_DAYS,
  AUDIT_CHANGE_WINDOW_MS,
  AUDIT_FINDING_FILES,
  AUDIT_PR_OUTLIER_LINES,
  AUDIT_REFUSAL_SPIKE,
  AUDIT_SPEND_OUTLIER_FACTOR,
  AUDIT_TOOL_WINDOW_MS,
  type AuditChange,
  type AuditItem,
  type AuditMetrics,
  type AuditOveruseFacts,
  type AuditPrSize,
  type AuditRunKind,
  type AuditThresholds,
  type AuditTokenOveruse,
  type AuditView,
  BLOCKING_SEVERITIES,
  type BoardItem,
  type BriefOption,
  type CiRunView,
  COMMS_CAPCOM,
  COMMS_OPEN_PREFIX,
  type CommsReaction,
  type CommsReactionKind,
  classifyOveruse,
  DECISION_DEFAULT_WAIT_MS,
  type DoneWhenEntry,
  type Escalation,
  estimateTokens,
  type FindingResolution,
  FLIGHT_INCOMING_LIMIT,
  FLIGHT_RETROSPECTIVE_SETTING,
  FLIGHT_SIGNALS_SETTING,
  type FlightArrivalDisposition,
  type FlightDecision,
  type FlightDecisionKind,
  type FlightLedgerEntry,
  type FlightMemoryNote,
  type FlightMemoryTitle,
  type FlightMovedPointer,
  type FlightPlanInput,
  type FlightPlanOperation,
  type FlightPointerKind,
  type FlightWakeRecord,
  type FlightWatchEntry,
  type FlightWatchOperation,
  type FlowColumnMove,
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
  isGeneratedFile,
  type LoopEvent,
  type LoopKind,
  type MachineSample,
  type ModelAdvice,
  type ModelTableData,
  OLDER_FINDINGS_MAX,
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
  type QuestionClosure,
  type ReplyDraft,
  type RepoGoal,
  type RepoId,
  type ReportedTest,
  type ReviewCheck,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewRow,
  type ReviewShotView,
  type ReviewState,
  type ReviewVerdict,
  type Run,
  type RunDigest,
  type RunLoop,
  type RunStatus,
  reviewTimings,
  reworkRatios,
  type SeatSessionRow,
  SILENCE_WATCHED_EVENTS,
  type SilenceWatchedEventKind,
  type StoredFinding,
  type Telemetry,
  type TestLockRun,
  TICKET_SIZES,
  type TokenUsage,
  testsTouched,
  tokenBaselines,
  type UsageSample,
} from "@mc/core";
import { BoundedMap } from "./bounded.ts";
import { StandingInstructions } from "./instructions/standing.ts";
import { parseJson, rethrowJson } from "./json.ts";
import { qaNativeIdentity } from "./qa/history-key.ts";
import { externalReviewKey } from "./review/external-key.ts";
import { openOlderFindings } from "./review/older-findings.ts";
import * as attention from "./store/attention.ts";
import {
  auditEventLastSeen,
  auditItems,
  recordAuditEvent,
  recordAuditItem,
  recordSilenceAlarm,
} from "./store/audit.ts";
import { CommsQueries, cutCommsText } from "./store/comms.ts";
import { flightQueries } from "./store/flight.ts";
import { DIGEST_CONTEXT_WINDOW_SQL, migrate } from "./store/migrations.ts";
import { modelTableData } from "./store/model-table.ts";
import * as reviewsStore from "./store/reviews.ts";
import {
  evidenceOf,
  toBoardItem,
  toCiRun,
  toEscalation,
  toGuardHit,
  toReview,
  toRun,
} from "./store/rows.ts";
import { runQueries } from "./store/runs.ts";
import { SCHEMA } from "./store/schema.ts";
import { seatQueries } from "./store/seats.ts";
import { ticketPlanQueries } from "./store/ticket-plans.ts";
import {
  ACK_ABSENT_MS,
  type AgentEvent,
  type AttentionNote,
  AUDIT_RETENTION_DAYS,
  type BoardMove,
  type BoardMoveState,
  BUSY_TIMEOUT_MS,
  COMMS_RETENTION_DAYS,
  type CommsLinkCount,
  type CommsReadScope,
  type CommsRow,
  type CommsSettlement,
  type Evidence,
  type FinancialRun,
  FLIGHT_DECISIONS_RETENTION_DAYS,
  type FlightBriefRow,
  HISTORY_BATCH_ROWS,
  HISTORY_SWEEP_MAX_BATCHES,
  type KeeperCursor,
  LIVE_LOOP_EVENTS_LIMIT,
  type LockHoldRow,
  MACHINE_RETENTION_MS,
  type NewCommsRow,
  type NoteInput,
  type NotificationRead,
  type NotificationRow,
  OPERATIONAL_RETENTION_DAYS,
  type QuestionChoiceRow,
  type QueueRow,
  type SeatLine,
  type SeatQuestion,
  VACUUM_MIN_FREE_BYTES,
  VACUUM_MIN_FREE_SHARE,
} from "./store/types.ts";
import { usageQueries } from "./store/usage.ts";
import { wasteQueries } from "./store/waste.ts";
import {
  auditThresholds,
  messageImprovements,
  toolImprovements,
} from "./telemetry/audit-improvements.ts";
import { specBounces } from "./telemetry/spec-bounces.ts";

/** Prepared statements kept per Store: the views use a fixed set of texts, so this is a ceiling only. */
const STATEMENTS_MAX = 256;

export * from "./store/types.ts";

/** FLIGHT's answers to seats' questions, and the questions it passed on, outlive the 90-day log. */
const COMMS_QUESTION_THREAD_SQL =
  "COALESCE(label, '') = 'question' OR COALESCE(reply_to, -1) IN (SELECT q.id FROM comms q WHERE q.label = 'question')";
const DECISION_KINDS_KEPT_SQL = "'answer', 'pass'";

type Row = Record<string, SQLInputValue>;

/** Set once the audit-history backfill has run: merges are recorded as they happen, so it never repeats. */
const AUDIT_BACKFILL_SETTING = "audit_history_backfilled";
const DAY_MS = 86_400_000;
const SILENCE_CLOCK = "silence";
const SILENCE_SEAT_START_CLOCK = "silence-seat-start";

/** The median of the values, or null when there are none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const notificationRow = (r: Row): NotificationRow => ({
  ...(r.source_content ? parseJson<object>(r.source_content, {}) : {}),
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

/** Memory in use as a percentage of the total; null when unmeasured or the total is unknown. */
const memPct = (s: MachineSample): number | null =>
  s.memUsedBytes !== null && s.memTotalBytes > 0 ? (s.memUsedBytes / s.memTotalBytes) * 100 : null;

const GIB = 1024 ** 3;

/** Two decimals keep the served series short; null stays null. */
const round2 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100);

/** Swap in use as a percentage of the swap file; null when unmeasured or there is no swap file. */
const swapPct = (s: MachineSample): number | null =>
  s.swapUsedBytes != null && s.swapTotalBytes != null && s.swapTotalBytes > 0
    ? (s.swapUsedBytes / s.swapTotalBytes) * 100
    : null;

/** 100 minus the free percentage `memory_pressure` reports; null when unmeasured. */
const pressurePct = (s: MachineSample): number | null =>
  s.memoryPressureFreePct == null ? null : 100 - s.memoryPressureFreePct;

/**
 * A stored digest; one persisted before `background` existed has none in flight, one before
 * `compactions` existed has none counted, one before `lastText` existed has no text.
 */
const parseDigest = (json: string): RunDigest => {
  const d = {
    background: [],
    compactions: 0,
    lastText: null,
    ...parseJson<object>(json, {}),
  } as unknown as RunDigest;
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

/** Run ids per `digests()` query (well under SQLite's bound-parameter limit). */
const DIGEST_BATCH = 500;

/** The `sessions` of a stored audit: set only when the run had a fresh session. */

const _toTokenCall = (r: Row): TokenCall => ({
  at: (r.at as number | null) ?? null,
  context: r.context as number,
  cacheRead: r.cache_read as number,
  cacheWrite: r.cache_write as number,
  output: r.output as number,
  added: parseJson<TokenSourceAdd[]>(r.added, []),
});

/** How many of a repo's latest merged PRs feed a job's p90 run time. */
const CI_P90_PRS = 40;
/** A job needs this many timed runs before its p90 stands in for the fixed limit. */
const CI_P90_MIN_SAMPLES = 5;

const CLOSED_ASKS_RECONCILED_SETTING = "comms.closed-asks-reconciled";

export class Store {
  private readonly db: DatabaseSync;
  private readonly rawDb: DatabaseSync;
  /** Statements used by read-heavy views stay prepared for this Store's lifetime. */
  private readonly statements = new BoundedMap<string, StatementSync>(STATEMENTS_MAX);

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
  readonly instructions: StandingInstructions;

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
    migrate(this.db, (fn, writeLock) => this.transaction(fn, writeLock));
    this.instructions = new StandingInstructions(this.db);
    this.backfillAuditHistory();
    this.reconcileClosedAsks();
    this.pruneRunAttempts(Date.now());
    this.compact();
  }

  /** Once: settles the open asks about work the hub's records show closed (see CommsQueries). */
  private reconcileClosedAsks(): void {
    if (this.getSetting(CLOSED_ASKS_RECONCILED_SETTING) !== null) return;
    this.commsStore.reconcileAsksOfClosedTickets(Date.now());
    this.setSetting(CLOSED_ASKS_RECONCILED_SETTING, "1");
  }

  /**
   * Compacts the file once when a large share of it is free pages (a first retention pass frees
   * many). Runs at open, before the hub listens, so nothing waits on it.
   */
  private compact(): void {
    if (this.path === ":memory:") return;
    const n = (pragma: string) =>
      Number((this.db.prepare(`PRAGMA ${pragma}`).get() as Row)[pragma]);
    const free = n("freelist_count") * n("page_size");
    if (
      free >= VACUUM_MIN_FREE_BYTES &&
      free >= n("page_count") * n("page_size") * VACUUM_MIN_FREE_SHARE
    )
      this.db.exec("VACUUM");
  }

  /** Deletes run_attempts past retention (store/runs.ts); returns the rows deleted. */
  pruneRunAttempts(now: number): number {
    return this.runQ.pruneAttempts(now);
  }

  /** One-time-safe reconstruction from sources that already survived retention. */
  private backfillAuditHistory(): void {
    if (this.getSetting(AUDIT_BACKFILL_SETTING) !== null) return;
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
          const value = parseJson<unknown>(row.value, undefined, rethrowJson) as {
            day?: unknown;
            report?: { at?: unknown };
          };
          const repoId = row.key.slice(`${FLIGHT_RETROSPECTIVE_SETTING}:`.length);
          if (typeof value.day === "string" && typeof value.report?.at === "number")
            addReport.run(repoId, value.day, value.report.at, JSON.stringify(value.report));
        } catch {
          // A malformed settings value must not prevent the hub from opening.
        }
      }
      this.setSetting(AUDIT_BACKFILL_SETTING, "1");
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

  /** Status rewrites that changed only a time, which `readVersion` does not count. */
  private timestampOnlyWrites = 0;

  /** Cache token for local writes and commits made by another SQLite connection. */
  readVersion(): string {
    return `${Number(this.db.prepare("SELECT total_changes() AS n").get()?.n) - this.timestampOnlyWrites}:${this.db.prepare("PRAGMA data_version").get()?.data_version}`;
  }

  private closed = false;

  /** Closes the database; the store is unusable after. Closing again does nothing. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
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
    return this.runQ.runAttempts(runId);
  }

  private usageQueriesCache: ReturnType<typeof usageQueries> | undefined;

  /** The usage sample and controller usage queries (store/usage.ts). */
  private get usageQ(): ReturnType<typeof usageQueries> {
    this.usageQueriesCache ??= usageQueries(this.db);
    return this.usageQueriesCache;
  }

  private runQueriesCache: ReturnType<typeof runQueries> | undefined;

  /** The run and attempt queries (store/runs.ts), over the same connection and statement cache. */
  private get runQ(): ReturnType<typeof runQueries> {
    this.runQueriesCache ??= runQueries(this.db, (sql) => this.statement(sql));
    return this.runQueriesCache;
  }

  /** The queries over the Comms tables (store/comms.ts); the Comms methods below delegate to it. */
  private get commsStore(): CommsQueries {
    return new CommsQueries(this.db, {
      transaction: (fn, writeLock) => this.transaction(fn, writeLock),
      statement: (sql) => this.statement(sql),
      run: (id) => this.run(id),
      raiseNote: (n) => this.raiseNote(n),
    });
  }

  private insertComms(row: NewCommsRow, text: string, replyTo: number | null): number {
    return this.commsStore.insertComms(row, text, replyTo);
  }

  private flightQueriesCache: ReturnType<typeof flightQueries> | undefined;

  /** The queries over FLIGHT's own tables (store/flight.ts); the FLIGHT methods below delegate to it. */
  private get flightQ(): ReturnType<typeof flightQueries> {
    this.flightQueriesCache ??= flightQueries(
      this.db,
      (fn) => this.transaction(fn),
      (sql) => this.statement(sql),
    );
    return this.flightQueriesCache;
  }

  private seatQueriesCache: ReturnType<typeof seatQueries> | undefined;

  /** The queries over the seat tables (store/seats.ts); the seat methods below delegate to it. */
  private get seatQ(): ReturnType<typeof seatQueries> {
    this.seatQueriesCache ??= seatQueries(
      this.db,
      (fn, writeLock) => this.transaction(fn, writeLock),
      (sql) => this.statement(sql),
    );
    return this.seatQueriesCache;
  }

  /** The ticket plans and their sign-off (store/ticket-plans.ts). */
  get plans(): ReturnType<typeof ticketPlanQueries> {
    return ticketPlanQueries(this.db);
  }

  /** The spend report's and the retrospective's queries (spend/waste.ts). */
  get waste(): ReturnType<typeof wasteQueries> {
    return wasteQueries(this.db);
  }

  private appendAttempt(runId: string, kind: string, at: number, data: object): void {
    this.runQ.appendAttempt(runId, kind, at, data);
  }

  /**
   * `folded`: the caller folded the run's transcript into `r`. The row is marked folded once that
   * happens to an ended run, and the mark is never cleared. A new row takes `r.loop`; an existing
   * row's loop is never rewritten here (`setRunLoop`).
   */
  upsertRun(r: Run, folded = false): void {
    this.runQ.upsertRun(r, folded);
  }

  /**
   * Gives runs stored before `loop_kind` existed the loop kind of their seat as configured now, so
   * a seat removed later still shows as a build seat in Audit. A run that has one keeps it.
   * Returns how many rows it set.
   */
  backfillRunLoopKinds(kinds: ReadonlyMap<string, LoopKind>): number {
    return this.runQ.backfillRunLoopKinds(kinds);
  }

  /** A prepared first brief may be replaced at final delivery, only while its exact hash still matches. */
  setRunPromptVersion(
    runId: string,
    hash: string,
    path: string,
    at: number,
    preparedHash?: string,
  ): void {
    if (preparedHash === undefined) {
      this.db
        .prepare("UPDATE runs SET prompt_hash = COALESCE(prompt_hash, ?) WHERE id = ?")
        .run(hash, runId);
    } else {
      const changed = this.db
        .prepare(
          `UPDATE runs SET prompt_hash = ? WHERE id = ? AND prompt_hash = ?
           AND NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)`,
        )
        .run(hash, runId, preparedHash, `instruction.delivered:${runId}`);
      if (changed.changes !== 1)
        throw new Error("Prepared prompt identity changed before delivery");
    }
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

  /** Records one finished mc tool call. */
  recordToolCall(c: {
    at: number;
    runId: string;
    tool: string;
    written: number;
    returned: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO mcp_tool_calls (at, run_id, tool, written, returned) VALUES (?, ?, ?, ?, ?)",
      )
      .run(c.at, c.runId, c.tool, c.written, c.returned);
  }

  /** Calls and characters (sent plus returned) per mc tool, for calls made in `[from, to]`. */
  toolUsage(from: number, to: number): Map<string, { calls: number; chars: number }> {
    return new Map(
      (
        this.db
          .prepare(
            `SELECT tool, COUNT(*) AS calls, SUM(written + returned) AS chars FROM mcp_tool_calls
             WHERE at >= ? AND at <= ? GROUP BY tool`,
          )
          .all(from, to) as { tool: string; calls: number; chars: number }[]
      ).map((r) => [r.tool, { calls: r.calls, chars: r.chars }]),
    );
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

  /** Only the latest prompt for the Agent summary; history stays on demand. */
  latestPromptWake(runId: string): PromptWakeCost | null {
    const rows = this.db
      .prepare(`SELECT * FROM prompt_sections WHERE run_id = ?
      AND wake = (SELECT MAX(wake) FROM prompt_sections WHERE run_id = ?)`)
      .all(runId, runId);
    return this.wakesOf(rows as never)[0] ?? null;
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
    return this.runQ.setRunCliVersionIfLive(runId, cliVersion);
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

  /** Records the model and effort recommended for a ticket's step; a later write replaces it. */
  setModelAdvice(repoId: RepoId, issue: number, a: ModelAdvice): void {
    this.db
      .prepare(
        `INSERT INTO model_advice (repo_id, issue, step, model, effort, reason, by, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, issue, step) DO UPDATE SET model = excluded.model,
           effort = excluded.effort, reason = excluded.reason, by = excluded.by, at = excluded.at`,
      )
      .run(repoId, issue, a.step, a.model, a.effort, a.reason, a.by, a.at);
    if (a.by === "step-up")
      this.db
        .prepare("INSERT INTO model_step_ups (repo_id, issue, at) VALUES (?, ?, ?)")
        .run(repoId, issue, a.at);
  }

  modelAdvice(repoId: RepoId, issue: number, step: AdviceStep): ModelAdvice | null {
    const r = this.db
      .prepare(
        "SELECT model, effort, reason, by, at FROM model_advice WHERE repo_id = ? AND issue = ? AND step = ?",
      )
      .get(repoId, issue, step) as Row | undefined;
    return r
      ? {
          step,
          model: r.model as string | null,
          effort: r.effort as string | null,
          reason: r.reason as string,
          by: r.by as ModelAdvice["by"],
          at: r.at as number,
        }
      : null;
  }

  /** The runs and seat changes behind Audit's model table, for a window of `since` to `until`. */
  modelTableData(since: number, until: number): ModelTableData {
    return modelTableData(this.db, since, until);
  }

  run(id: string): Run | null {
    return this.runQ.run(id);
  }

  /** When the seat started its first run after `after`, or null when it has not. */
  nextRunStart(agentId: AgentId, after: number): number | null {
    const row = this.db
      .prepare("SELECT MIN(started_at) AS at FROM runs WHERE agent_id = ? AND started_at > ?")
      .get(agentId, after) as { at: number | null };
    return row.at;
  }

  runs(agentId: AgentId, limit: number): Run[] {
    return this.runQ.runs(agentId, limit);
  }

  /** Indexed recent-run bounds for each HUD agent, with older held runs retained. */
  runsForAgents(
    agentIds: readonly AgentId[],
    limit: number,
    heldRunIds: readonly string[] = [],
  ): Map<AgentId, Run[]> {
    return this.runQ.runsForAgents(agentIds, limit, heldRunIds);
  }

  /** The branches this hub's own work runs (not review runs) worked on in a repo, ended or not. */
  runBranches(repoId: RepoId): Set<string> {
    return this.runQ.runBranches(repoId);
  }

  /** Runs still open or ended at or after `since`, across seats and repos. */
  runsActiveSince(since: number): Run[] {
    return this.runQ.runsActiveSince(since);
  }

  /** Complete author bindings for flow reads, plus active runs needed for seat queue order. */
  prFlowRuns(
    repoId: RepoId,
    prs: readonly Pick<PullRequestView, "number" | "branch" | "ticket">[],
  ): Run[] {
    return this.runQ.prFlowRuns(repoId, prs);
  }

  /** Every recorded run on a branch; review ordering needs merged predecessors too. */
  runsOnBranch(repoId: RepoId, branch: string): Run[] {
    return this.runQ.runsOnBranch(repoId, branch);
  }

  /**
   * The merge hold on the branch's latest build run, ended or not. A hold outlives its run until
   * someone releases it. Only the latest run counts.
   */
  branchMergeHold(repoId: RepoId, branch: string): NonNullable<Run["loop"]>["mergeHold"] | null {
    return this.runQ.branchMergeHold(repoId, branch);
  }

  /**
   * Distinct tickets that a run by one of `seatIds` first started on since `since`. Review runs,
   * observed loops' runs and tickets already started before `since` (then handed on) do not count.
   */
  ticketsStartedSince(since: number, seatIds: readonly string[]): number {
    return this.runQ.ticketsStartedSince(since, seatIds);
  }

  /** Outstanding runs and ended runs with recorded PR merge steps for the away digest. */
  runsForAwayDigest(): Run[] {
    return this.runQ.runsForAwayDigest();
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
    return this.runQ.loopRuns(endedSince);
  }

  /** Ended runs still carrying a merge hold or a parked state, oldest first. */
  endedRunsWithHoldOrPark(): Run[] {
    return this.runQ.endedRunsWithHoldOrPark();
  }

  /** Live acceptance metadata never needs to decode ended loop history. */
  activeLoopRuns(repoId: RepoId): Run[] {
    return this.runQ.activeLoopRuns(repoId);
  }

  /** The runs that have not ended and are off their seat in review, oldest first. */
  offSeatRuns(): Run[] {
    return this.runQ.offSeatRuns();
  }

  /** The tickets (`repo#n`) of the runs that have not ended. */
  activeTickets(): Set<string> {
    return this.runQ.activeTickets();
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
        "SELECT 1 FROM runs WHERE ended_at IS NULL AND ticket IS NOT NULL AND (loop IS NULL OR json_extract(loop, '$.hold.worktree') IS NULL) LIMIT 1",
      )
    );
  }

  /** True while a run has not ended and is not set aside (waiting on a review, CI or a merge). */
  /**
   * True when one of these agents has an open run that is not set aside and started at or after
   * `since`: a run left open for longer is a dead row, not work in progress.
   */
  hasActiveRunOf(agentIds: readonly string[], since: number): boolean {
    return this.runQ.hasActiveRunOf(agentIds, since);
  }

  hasActiveRun(): boolean {
    return this.runQ.hasActiveRun();
  }

  /**
   * The newest run (ended or not, not a review) on `branch`, which owns that branch's ticket:
   * `agentId`'s own run first, any seat's otherwise.
   */
  latestRunOnBranch(repoId: RepoId, branch: string, agentId?: AgentId): Run | null {
    return this.runQ.latestRunOnBranch(repoId, branch, agentId);
  }

  /** Whether this hub has a run (ended or not) on `branch`. */
  hasRunOnBranch(repoId: RepoId, branch: string): boolean {
    return this.runQ.hasRunOnBranch(repoId, branch);
  }

  /** Every run on the ticket, ended ones too; review runs do not count. */
  runsOnTicket(repoId: RepoId, ticket: string): Run[] {
    return this.runQ.runsOnTicket(repoId, ticket);
  }

  /** Whether a run is still going on the ticket (`repo#number`); a review run does not count. */
  hasLiveRunOnTicket(repoId: RepoId, ticket: string): boolean {
    return this.runQ.hasLiveRunOnTicket(repoId, ticket);
  }

  /** Whether another run on the same ticket started after this one. */
  hasNewerRunOnTicket(run: Run): boolean {
    return this.runQ.hasNewerRunOnTicket(run);
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
    return this.runQ.runsOverlapping(sinceMs, untilMs);
  }

  private overlappingRuns(columns: string, sinceMs: number, untilMs: number): Row[] {
    return this.runQ.overlappingRuns(columns, sinceMs, untilMs);
  }

  /**
   * The run and attempt-usage fields FLIGHT's cost and wait figures read, for `agentIds`' runs
   * overlapping [since, until) (same rule and order as `runsOverlapping`). Reads only the scalar
   * columns and each digest's usage timestamps and tokens, never the whole digest or run row.
   */
  financialRuns(sinceMs: number, untilMs: number, agentIds: ReadonlySet<string>): FinancialRun[] {
    const runs = this.overlappingRuns(
      "id, agent_id, started_at, ended_at, status, cost_usd",
      sinceMs,
      untilMs,
    )
      .filter((r) => agentIds.has(r.agent_id as string))
      .map(
        (r): FinancialRun => ({
          id: r.id as string,
          agentId: r.agent_id as string,
          startedAt: r.started_at as number,
          endedAt: r.ended_at as number | null,
          status: r.status as Run["status"],
          costUsd: r.cost_usd as number | null,
          attemptUsage: [],
        }),
      );
    const byId = new Map(runs.map((r) => [r.id, r]));
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += DIGEST_BATCH) {
      const batch = ids.slice(i, i + DIGEST_BATCH);
      const rows = this.statement(
        `SELECT run_id, json_extract(digest, '$.attemptUsage') AS usage
         FROM run_digests WHERE run_id IN (${batch.map(() => "?").join(", ")})`,
      ).all(...batch) as { run_id: string; usage: string | null }[];
      for (const r of rows) {
        if (r.usage === null) continue;
        const run = byId.get(r.run_id);
        if (run === undefined) continue;
        for (const u of parseJson<{ at: number | null; tokens: number }[]>(r.usage, []))
          run.attemptUsage.push({ at: u.at, tokens: u.tokens });
      }
    }
    return runs;
  }

  /**
   * Ended runs started before `startedBefore` whose transcript has not been folded, newest first
   * (the backfill's queue).
   */
  runsToFold(limit: number, startedBefore: number): Run[] {
    return this.runQ.runsToFold(limit, startedBefore);
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
    return this.runQ.endedRunsPage(agentIds, after, limit);
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
    return this.runQ.untitledRunsPage(agentIds, after, limit);
  }

  /** Sets the title of every run of `ticket` in `repoId` that has none; returns how many it set. */
  setTicketTitle(repoId: string, ticket: string, title: string): number {
    return this.runQ.setTicketTitle(repoId, ticket, title);
  }

  /** Rewrites only a run's summary (nothing else on its row). */
  setRunSummary(runId: string, summary: string): void {
    this.runQ.setRunSummary(runId, summary);
  }

  /** How many runs `runsToFold` has left before `startedBefore`. */
  countToFold(startedBefore: number): number {
    return this.runQ.countToFold(startedBefore);
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
    if (!row) return null;
    return parseDigest(row.digest);
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
    return out;
  }

  /** Historical window provenance for crew rows, without decoding old event and token arrays. */
  digestContextWindows(runIds: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = 0; i < runIds.length; i += DIGEST_BATCH) {
      const ids = runIds.slice(i, i + DIGEST_BATCH);
      const rows = this.statement(`SELECT run_id, ${DIGEST_CONTEXT_WINDOW_SQL} AS context_window
        FROM run_digests INDEXED BY run_digests_context_window
        WHERE run_id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as {
        run_id: string;
        context_window: number | null;
      }[];
      for (const row of rows)
        if (row.context_window !== null) out.set(row.run_id, row.context_window);
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
    return row ? parseJson<MachineSample | null>(row.sample, null) : null;
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

  /**
   * Settled-done moves at or after `since`, plus each card's latest done move before it (what a
   * card's column was at `since`), oldest first.
   */
  doneBoardMovesFrom(since: number): BoardMove[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.run_id, m.repo_id, m.issue, m.board_column, m.state, m.detail, m.at
           FROM board_moves m
           JOIN (SELECT repo_id, issue, MAX(at) AS at FROM board_moves
                  WHERE state = 'done' AND at < ? GROUP BY repo_id, issue) last
             ON m.repo_id = last.repo_id AND m.issue = last.issue AND m.at = last.at
          WHERE m.state = 'done'
         UNION ALL
         SELECT id, run_id, repo_id, issue, board_column, state, detail, at
           FROM board_moves WHERE state = 'done' AND at >= ?
         ORDER BY at, id`,
      )
      .all(since, since) as Row[];
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
    this.pruneRunAttempts(now);
    // refreshes the planner's statistics for the tables whose size changed; cheap when none did
    this.db.exec("PRAGMA optimize");
    this.db.prepare("DELETE FROM ci_runs WHERE at < ?").run(now - QA_RETENTION_DAYS * day);
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
      // A seat's question to FLIGHT and FLIGHT's answer to it are kept as long as a run.
      ["seat_questions", "answered_at IS NOT NULL AND answered_at < ?", AUDIT_RETENTION_DAYS],
      ["flight_decisions", `at < ? AND kind IN (${DECISION_KINDS_KEPT_SQL})`, AUDIT_RETENTION_DAYS],
      ["mcp_tool_calls", "at < ?", OPERATIONAL_RETENTION_DAYS],
      ["question_choices", "chosen_at < ?", AUDIT_RETENTION_DAYS],
      // a question message and the replies to it outlive the 90-day message log
      ["comms", `at < ? AND (${COMMS_QUESTION_THREAD_SQL})`, AUDIT_RETENTION_DAYS],
      ["question_closures", "at < ?", OPERATIONAL_RETENTION_DAYS],
      ["drafts", "created_at < ? AND state != 'pending'", OPERATIONAL_RETENTION_DAYS],
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
          if (table === "comms") {
            const marks = ids.map(() => "?").join(",");
            for (const child of [
              "comms_mentions",
              "comms_reactions",
              "comms_settlements",
              "comms_pins",
            ])
              this.db
                .prepare(`DELETE FROM ${child} WHERE message_id IN (${marks})`)
                .run(...ids.map(({ id }) => id));
          }
          if (table === "reviews") {
            const marks = ids.map(() => "?").join(",");
            this.db
              .prepare(`DELETE FROM review_checks WHERE review_id IN (${marks})`)
              .run(...ids.map(({ id }) => id));
            this.db
              .prepare(`DELETE FROM review_tests WHERE review_id IN (${marks})`)
              .run(...ids.map(({ id }) => id));
            this.db
              .prepare(`DELETE FROM review_shots WHERE review_id IN (${marks})`)
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
              for (const child of ["run_commits", "run_pushes", "run_attempts", "run_digests"])
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
      AND json_extract(r.loop, '$.hold.worktree') IS NULL
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
        table === "comms"
          ? `at < ? AND NOT (${COMMS_QUESTION_THREAD_SQL})`
          : table === "flight_decisions"
            ? `at < ? AND kind NOT IN (${DECISION_KINDS_KEPT_SQL})`
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
    this.usageQ.addUsage(s);
  }

  usage(accountId: AccountId, window: "5h" | "7d", sinceMs: number): UsageSample[] {
    return this.usageQ.usage(accountId, window, sinceMs);
  }

  /** The newest sample for an account and window, or null when there is none. */
  latestUsage(accountId: AccountId, window: "5h" | "7d"): UsageSample | null {
    return this.usageQ.latestUsage(accountId, window);
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
    return rows.map(toEscalation);
  }

  /** Indexed canonical source lookup; freshness reads never mutate the escalation set. */
  escalation(id: string): Escalation | null {
    const row = this.db.prepare("SELECT * FROM escalations WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toEscalation(row) : null;
  }

  /**
   * Makes the repo's cards match `items`, writing only the cards that changed and deleting only
   * those that left the board. True when any stored row changed.
   */
  replaceBoard(repoId: RepoId, items: BoardItem[]): boolean {
    let changed = false;
    this.transaction(() => {
      this.boardViews.delete(repoId);
      this.commsStore.settleAsksOfClosedWork(Date.now());
      const before = new Map(
        (
          this.db
            .prepare("SELECT issue_number, status, closed FROM board_items WHERE repo_id = ?")
            .all(repoId) as Row[]
        ).map((r) => [r.issue_number as number, r]),
      );
      const columns = `title, status, state, labels, priority, updated_at, url, stage, owner, parent,
           sub_done, sub_total, blocked_by, milestone, size, closed, priority_source, created_at,
           item_id, project_id, assignees, author, after_deps, defect_refs`;
      const names = columns.split(",").map((c) => c.trim());
      const ins = this.statement(
        `INSERT INTO board_items (repo_id, issue_number, ${columns})
         VALUES (?, ?, ${names.map(() => "?").join(", ")})
         ON CONFLICT(repo_id, issue_number) DO UPDATE SET
           ${names.map((c) => `${c} = excluded.${c}`).join(", ")}
         WHERE (${names.map((c) => `${c} IS NOT excluded.${c}`).join(" OR ")})`,
      );
      const seen = new Set<number>();
      for (const i of items) {
        seen.add(i.issueNumber);
        const old = before.get(i.issueNumber);
        const written = ins.run(
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
        if (Number(written.changes) > 0) changed = true;
        if (old !== undefined && (old.status !== i.status || Boolean(old.closed) !== i.closed))
          this.markFlightPointers(
            "ticket",
            `${repoId}#${i.issueNumber}`,
            i.closed ? "closed" : `moved to ${i.status}`,
            Date.now(),
          );
      }
      const del = this.statement("DELETE FROM board_items WHERE repo_id = ? AND issue_number = ?");
      for (const n of before.keys()) {
        if (seen.has(n)) continue;
        del.run(repoId, n);
        changed = true;
      }
    });
    return changed;
  }

  board(repoId: RepoId): BoardItem[] {
    const rows = this.db
      .prepare("SELECT * FROM board_items WHERE repo_id = ? ORDER BY issue_number ASC")
      .all(repoId) as Row[];
    return rows.map(toBoardItem);
  }

  /**
   * The board for a caller that only reads it: the same cards as `board`, read once and kept
   * (frozen) until the board is replaced or another connection commits, so a page that reads the
   * board every few seconds does not rebuild every card each time.
   */
  boardView(repoId: RepoId): readonly Readonly<BoardItem>[] {
    const version = String(this.db.prepare("PRAGMA data_version").get()?.data_version);
    const kept = this.boardViews.get(repoId);
    if (kept && kept.version === version) return kept.cards;
    const cards = this.board(repoId).map((card) => Object.freeze(card));
    Object.freeze(cards);
    this.boardViews.set(repoId, { version, cards });
    return cards;
  }
  private boardViews = new Map<
    RepoId,
    { version: string; cards: readonly Readonly<BoardItem>[] }
  >();

  /** The card a `<repo>#<number>` reference names, else null. */
  boardCardOf(ref: string): BoardItem | null {
    const at = ref.lastIndexOf("#");
    const number = /^[1-9]\d*$/.test(ref.slice(at + 1)) ? Number(ref.slice(at + 1)) : 0;
    return at < 0 || number === 0 ? null : this.boardItem(ref.slice(0, at), number);
  }

  /** One board card from the last read, else null. */
  boardItem(repoId: RepoId, issueNumber: number): BoardItem | null {
    const row = this.db
      .prepare("SELECT * FROM board_items WHERE repo_id = ? AND issue_number = ?")
      .get(repoId, issueNumber) as Row | undefined;
    return row === undefined ? null : toBoardItem(row);
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
      this.commsStore.settleAsksOfClosedWork(readAt);
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
      this.commsStore.settleAsksOfClosedWork(readAt);
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

  /** Marks the ledger pointers on a PR whose state, head, CI, review or draft flag differ from the stored row. */
  private markMovedPullRequest(repoId: RepoId, p: PullRequestView, at: number): void {
    const old = this.db
      .prepare(
        "SELECT state, head_sha, ci, review, is_draft FROM pull_requests WHERE repo_id = ? AND number = ?",
      )
      .get(repoId, p.number) as Row | undefined;
    const change =
      old === undefined
        ? "opened"
        : old.state !== p.state
          ? p.state
          : (old.head_sha ?? null) !== (p.headSha ?? null)
            ? "new commit"
            : old.ci !== p.ci
              ? `CI ${p.ci}`
              : (old.review ?? null) !== (p.review ?? null)
                ? `review ${p.review ?? "cleared"}`
                : Boolean(old.is_draft) !== p.isDraft
                  ? p.isDraft
                    ? "back to draft"
                    : "ready for review"
                  : null;
    if (change !== null) this.markFlightPointers("pr", `${repoId}#${p.number}`, change, at);
  }

  private writePullRequests(repoId: RepoId, prs: PullRequestView[], readAt: number): void {
    const ins = this.db.prepare(
      `INSERT INTO pull_requests (repo_id, number, title, url, branch, ticket, state, is_draft,
         review, ci, created_at, updated_at, merged_at, read_at, head_sha, mergeable, author,
         assignees, checks, closing_issues, merge_commit_sha, additions, deletions, changed_files,
         base, is_cross_repository)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, number) DO UPDATE SET title = excluded.title, url = excluded.url,
         branch = excluded.branch, ticket = excluded.ticket, state = excluded.state,
         is_draft = excluded.is_draft, review = excluded.review, ci = excluded.ci,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         merged_at = excluded.merged_at, read_at = excluded.read_at,
         head_sha = excluded.head_sha, mergeable = excluded.mergeable, author = excluded.author,
         assignees = excluded.assignees, checks = excluded.checks,
         closing_issues = excluded.closing_issues, merge_commit_sha = excluded.merge_commit_sha,
         additions = excluded.additions, deletions = excluded.deletions,
         changed_files = excluded.changed_files, base = excluded.base,
         is_cross_repository = excluded.is_cross_repository, stale = 0`,
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
      const old = this.db
        .prepare("SELECT state FROM pull_requests WHERE repo_id = ? AND number = ?")
        .get(repoId, p.number) as Row | undefined;
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
      for (const check of p.checks ?? [])
        if (check.completedAt != null)
          this.recordSilenceEvent("ci-result-observed", check.completedAt);
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
      this.markMovedPullRequest(repoId, p, readAt);
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
        p.isCrossRepository == null ? null : p.isCrossRepository ? 1 : 0,
      );
      if (
        p.state === "merged" &&
        old?.state !== "merged" &&
        this.db
          .prepare(
            "SELECT 1 FROM reviews WHERE repo_id = ? AND pr_number = ? AND verdict IS NOT NULL",
          )
          .get(repoId, p.number) !== undefined
      )
        this.recordSilenceEvent("merged-pr-review-recorded", p.mergedAt ?? readAt);
      if (p.mergedAt !== null) {
        const { files: _files, ...record } = p;
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
  }

  /**
   * The QA board's workflow figures for work that ended or merged at or after `since`: review wait and time per head, rework ratio per seat and model, tests per PR.
   */
  qaFlow(since: number): Omit<QaFlowView, "days" | "since" | "metrics"> {
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
    )
      .map((r) => parseJson<PullRequestView | null>(r.record, null))
      .filter((p): p is PullRequestView => p !== null);
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
    ).flatMap((r) => {
      const v = parseJson<unknown>(r.report, null);
      return v === null ? [] : [v];
    });
  }

  /**
   * Range-bounded, durable audit aggregates.  Inputs are timestamps already validated at HTTP.
   * One section is built per step, and a step is a pause point, so a caller can let the event loop
   * run between sections (`auditStepped`); `audit` runs them all at once.
   */
  *auditSteps(
    since: number,
    until: number,
    kinds: ReadonlyMap<string, AuditRunKind> = new Map(),
    thresholds?: Partial<AuditThresholds>,
  ): Generator<void, AuditView> {
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
    let chatterRows: ReturnType<Store["commsChatter"]> | undefined;
    const chatter = () => (chatterRows ??= this.commsChatter(since, until));
    const parts: { [K in keyof AuditView]: () => AuditView[K] } = {
      range: () => ({ since, until }),
      longRunners: () =>
        (
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
      deathLoops: () =>
        rows(
          `SELECT a.run_id AS runId, (SELECT agent_id FROM runs WHERE id = a.run_id) AS agentId,
          COUNT(*) AS parks FROM run_attempts a
         WHERE a.kind = 'loop' AND a.at >= ? AND a.at <= ?
           AND json_extract(a.data, '$.hold.kind') IS NOT NULL GROUP BY a.run_id ORDER BY parks DESC`,
          since,
          until,
        ) as unknown as AuditView["deathLoops"],
      reworkRounds: () =>
        rows(
          `SELECT author_run_id AS runId, (SELECT agent_id FROM runs WHERE id = author_run_id) AS agentId,
          MAX(0, MAX(round) - 1) AS rounds, MAX(round) AS maxRound FROM reviews
         WHERE state = 'reported' AND ended_at >= ? AND ended_at <= ?
         GROUP BY author_run_id ORDER BY rounds DESC, runId`,
          since,
          until,
        ) as unknown as AuditView["reworkRounds"],
      reviewRounds: () => ({
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
      }),
      refusalsByRule: () =>
        rows(
          `SELECT rule, COUNT(*) AS count FROM guard_hits WHERE at >= ? AND at <= ? GROUP BY rule ORDER BY count DESC, rule`,
          since,
          until,
        ) as unknown as AuditView["refusalsByRule"],
      refusals: () =>
        rows(
          `SELECT agent_id AS agentId, run_id AS runId, rule, COUNT(*) AS count FROM guard_hits
         WHERE at >= ? AND at <= ? GROUP BY agent_id, run_id, rule
         ORDER BY count DESC, agent_id, run_id, rule`,
          since,
          until,
        ) as unknown as AuditView["refusals"],
      refusalSpikes: () =>
        rows(
          `SELECT agent_id AS agentId, (at / ${DAY_MS}) * ${DAY_MS} AS day, COUNT(*) AS count
         FROM guard_hits WHERE at >= ? AND at <= ? GROUP BY agent_id, day HAVING count >= ?
         ORDER BY count DESC, day, agent_id`,
          since,
          until,
          AUDIT_REFUSAL_SPIKE,
        ) as unknown as AuditView["refusalSpikes"],
      spendOutliers: () =>
        medianSpend === null
          ? []
          : spend.filter(
              (r) => r.costUsd > 0 && r.costUsd >= medianSpend * AUDIT_SPEND_OUTLIER_FACTOR,
            ),
      questions: () =>
        (rows(
          `SELECT COUNT(*) AS asked, COALESCE(SUM(answered_at IS NOT NULL), 0) AS answered,
          AVG(CASE WHEN answered_at IS NULL THEN NULL ELSE answered_at - at END) AS answerMs
         FROM seat_questions WHERE at >= ? AND at <= ?`,
          since,
          until,
        )[0] ?? { asked: 0, answered: 0, answerMs: null }) as unknown as AuditView["questions"],
      costPerMergedTicket: () =>
        rows(
          `WITH merged_tickets AS (
           SELECT DISTINCT repo_id, json_extract(record, '$.ticket') AS ticket FROM pr_history
           WHERE merged_at >= ? AND merged_at <= ?
         ) SELECT t.ticket, SUM(r.cost_usd) AS costUsd FROM merged_tickets t
         LEFT JOIN runs r ON r.repo_id = t.repo_id AND r.ticket = t.ticket
         GROUP BY t.repo_id, t.ticket ORDER BY t.ticket`,
          since,
          until,
        ) as unknown as AuditView["costPerMergedTicket"],
      modelPromptTimeline: () =>
        rows(
          `SELECT started_at AS at, model, account_id AS accountId, effort, prompt_hash AS promptHash
         FROM runs WHERE started_at >= ? AND started_at <= ? ORDER BY started_at`,
          since,
          until,
        ) as unknown as AuditView["modelPromptTimeline"],
      prSizes: () => ({
        prs,
        outliers: prs.filter((p) => p.additions + p.deletions >= AUDIT_PR_OUTLIER_LINES),
      }),
      mergedPerDay: () =>
        rows(
          `SELECT (merged_at / ${DAY_MS}) * ${DAY_MS} AS day, COUNT(*) AS merged,
           SUM(top IS NULL) AS noReview, COALESCE(SUM(top <= 1), 0) AS round1, COALESCE(SUM(top = 2), 0) AS round2,
           COALESCE(SUM(top >= 3), 0) AS round3
         FROM (SELECT h.merged_at AS merged_at,
             (SELECT MAX(v.round) FROM reviews v WHERE v.repo_id = h.repo_id
               AND v.pr_number = h.number AND v.state = 'reported') AS top
           FROM pr_history h WHERE h.merged_at >= ? AND h.merged_at <= ?)
         GROUP BY day ORDER BY day`,
          since,
          until,
        ) as unknown as NonNullable<AuditView["mergedPerDay"]>,
      findingFiles: () => this.auditFindingFiles(since, until),
      chatter: () => chatter(),
      flakes: () => this.auditFlakes(since, until),
      changes: () => this.auditChanges(since, until),
      tokenOveruse: () => this.auditTokenOveruse(since, until, kinds),
      items: () => this.auditItems(since, until),
      bugEscapes: () => [],
      improvements: () => [
        ...toolImprovements(this.toolUsage(until - AUDIT_TOOL_WINDOW_MS, until), until),
        ...messageImprovements(this.db, since, until, auditThresholds(thresholds), chatter()),
      ],
      specBounces: () => specBounces(this.db, since, until),
      surgeonProposals: () => [],
    };
    const out: Partial<AuditView> = {};
    for (const key of Object.keys(parts) as (keyof AuditView)[]) {
      (out as Record<string, unknown>)[key] = (parts[key] as () => unknown)();
      yield;
    }
    return out as AuditView;
  }

  /** `auditSteps` run to the end in one go. */
  audit(...args: Parameters<Store["auditSteps"]>): AuditView {
    const steps = this.auditSteps(...args);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** `auditSteps` with the event loop let run between sections, so a long read never freezes the hub. */
  async auditStepped(...args: Parameters<Store["auditSteps"]>): Promise<AuditView> {
    const steps = this.auditSteps(...args);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  /**
   * Records an Audit item once per kind and subject; its tier comes from the kind (unknown kinds
   * are Go-ahead). A repeat leaves the item as it was, except that an open item may become done.
   */
  recordAuditItem(i: {
    kind: string;
    subject: string;
    state: AuditItem["state"];
    detail: string;
    at: number;
  }): void {
    recordAuditItem(this.db, i);
  }

  /** Records a successful occurrence of a routine event watched by Audit. */
  recordSilenceEvent(kind: SilenceWatchedEventKind, at: number): void {
    const before = auditEventLastSeen(this.db, kind);
    recordAuditEvent(this.db, kind, at);
    // Re-reporting the same observation must not move its quiet-time marker.
    if (before !== at && auditEventLastSeen(this.db, kind) === at)
      this.setSetting(
        `silence-quiet-at-seen:${kind}`,
        JSON.stringify({
          lastSeenAt: at,
          quietTotal: this.silenceQuietTotal(this.silenceClock(kind)),
        }),
      );
  }

  /** When a watched event last succeeded, or null if it never has. */
  silenceEventLastSeen(kind: SilenceWatchedEventKind): number | null {
    return auditEventLastSeen(this.db, kind);
  }

  /**
   * Opens alarms for routine events that stopped, and clears resumed ones. A quiet period (the crew
   * paused, stopped on its budget, or no seat working a ticket) leaves every alarm as it was.
   */
  checkSilenceAlarms(
    at: number,
    quiet: {
      crewPaused: boolean;
      budgetStopped: boolean;
      noSeatRan: boolean;
      readyWorkForIdleSeat?: boolean;
    },
  ): void {
    const active = !(quiet.crewPaused || quiet.budgetStopped || quiet.noSeatRan);
    const quietTotal = this.advanceSilenceQuietTime(SILENCE_CLOCK, at, !active);
    const seatStartQuietTotal = this.advanceSilenceQuietTime(
      SILENCE_SEAT_START_CLOCK,
      at,
      !active || quiet.readyWorkForIdleSeat !== true,
    );
    for (const event of SILENCE_WATCHED_EVENTS) {
      const lastSeenAt = auditEventLastSeen(this.db, event.kind);
      if (lastSeenAt === null) continue;
      const total = event.kind === "seat-run-started" ? seatStartQuietTotal : quietTotal;
      const quietAtSeen = this.silenceQuietAtSeen(event.kind, lastSeenAt, total);
      const silent = at - lastSeenAt - (total - quietAtSeen) > event.gapMs;
      // Opening needs a live crew (and, for seat starts, Ready work an idle seat could take); a resumed event always clears its own alarm.
      const canOpen =
        active && (event.kind !== "seat-run-started" || quiet.readyWorkForIdleSeat === true);
      if (silent && !canOpen) continue;
      const detail = silent
        ? `${event.label} went silent after ${new Date(lastSeenAt).toISOString()}; normal gap ${Math.round(event.gapMs / 3_600_000)} hours.`
        : `${event.label} resumed at ${new Date(lastSeenAt).toISOString()}; normal gap ${Math.round(event.gapMs / 3_600_000)} hours.`;
      if (silent) recordSilenceAlarm(this.db, event.kind, "open", detail, at);
      else recordSilenceAlarm(this.db, event.kind, "done", detail, at);
    }
  }

  /** The clock that excludes quiet intervals for a watched event. */
  private silenceClock(kind: SilenceWatchedEventKind): string {
    return kind === "seat-run-started" ? SILENCE_SEAT_START_CLOCK : SILENCE_CLOCK;
  }

  /** Advances a quiet-time total, assigning each interval to the preceding tick's state. */
  private advanceSilenceQuietTime(clock: string, at: number, quiet: boolean): number {
    const lastTick = Number(this.getSetting(`${clock}-last-tick`));
    const lastQuiet = this.getSetting(`${clock}-last-quiet`) === "true";
    let total = this.silenceQuietTotal(clock);
    if (Number.isFinite(lastTick) && lastQuiet && at > lastTick) total += at - lastTick;
    this.setSetting(`${clock}-last-tick`, String(at));
    this.setSetting(`${clock}-last-quiet`, String(quiet));
    this.setSetting(`${clock}-quiet-total`, String(total));
    return total;
  }

  private silenceQuietTotal(clock: string): number {
    const total = Number(this.getSetting(`${clock}-quiet-total`));
    return Number.isFinite(total) ? total : 0;
  }

  /** The quiet-time total in force when the event's current observation was made. */
  private silenceQuietAtSeen(
    kind: SilenceWatchedEventKind,
    lastSeenAt: number,
    total: number,
  ): number {
    const key = `silence-quiet-at-seen:${kind}`;
    try {
      const seen = parseJson<unknown>(this.getSetting(key) ?? "null", undefined, rethrowJson) as {
        lastSeenAt?: unknown;
        quietTotal?: unknown;
      } | null;
      if (seen?.lastSeenAt === lastSeenAt && typeof seen.quietTotal === "number")
        return seen.quietTotal;
    } catch {
      // A damaged cursor should start measuring from this check, not stop Audit.
    }
    this.setSetting(key, JSON.stringify({ lastSeenAt, quietTotal: total }));
    return total;
  }

  /** Items recorded in range, newest first. */
  private auditItems(since: number, until: number): AuditItem[] {
    return auditItems(this.db, since, until);
  }

  /** Merged PRs in range that have a recorded size, largest first. */
  private auditPrSizes(since: number, until: number): AuditPrSize[] {
    const sized: AuditPrSize[] = [];
    for (const row of this.db
      .prepare("SELECT repo_id, record FROM pr_history WHERE merged_at >= ? AND merged_at <= ?")
      .all(since, until) as { repo_id: string; record: string }[]) {
      const pr = parseJson<PullRequestView | null>(row.record, null);
      if (!pr) continue;
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
        flakes = parseJson<{ flakes?: typeof flakes }>(value, {}).flakes ?? {};
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
    type ChangeRun = {
      agent_id: string;
      started_at: number;
      model: string | null;
      prompt_hash: string | null;
    };
    const runs = this.db
      .prepare(
        `SELECT agent_id, started_at, model, prompt_hash FROM runs
         WHERE started_at >= ? AND started_at <= ? ORDER BY agent_id, started_at, id`,
      )
      .all(since, until) as ChangeRun[];
    // each seat's last run before the range is what its first run in range changed from
    const lastBefore = this.db.prepare(
      `SELECT agent_id, started_at, model, prompt_hash FROM runs
       WHERE agent_id = ? AND started_at < ? ORDER BY started_at DESC, id DESC LIMIT 1`,
    );
    const seats = [...new Set(runs.map((r) => r.agent_id))];
    const history = runs.slice();
    for (const agent of seats) {
      const before = lastBefore.get(agent, since) as ChangeRun | undefined;
      if (before) history.push(before);
    }
    history.sort((a, b) => a.agent_id.localeCompare(b.agent_id) || a.started_at - b.started_at);
    const changes: AuditChange[] = [];
    const previous = new Map<string, ChangeRun>();
    const metrics = this.auditMetricsReader(since - AUDIT_CHANGE_WINDOW_MS, until);
    for (const run of history) {
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
          before: metrics(run.started_at - windowMs, run.started_at - 1),
          after: metrics(run.started_at, run.started_at + windowMs - 1),
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
         ON b.repo_id = r.repo_id
           AND b.issue_number = CAST(substr(r.ticket, length(r.repo_id) + 2) AS INTEGER)
           AND r.ticket = b.repo_id || '#' || b.issue_number
       WHERE r.review_id IS NULL AND r.tokens IS NOT NULL`;
    // the loop kind stored at the run's start; a seat since removed still counts, and a row from
    // before it was stored falls back to the seat's kind now
    const isBuild = (r: Row): boolean => (r.loopKind ?? kinds.get(r.agentId as string)) === "build";
    const usage = (r: Row): TokenUsage => parseJson<TokenUsage>(r.tokens, {} as TokenUsage);
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

  /**
   * The metrics of any window inside `[low, high]`, worked out from one read of the merged PRs,
   * reported reviews and per-ticket costs in that span, so a long list of changes does not run
   * a handful of queries per change.
   */
  private auditMetricsReader(
    low: number,
    high: number,
  ): (from: number, to: number) => AuditMetrics {
    const merged = (
      this.db
        .prepare(
          `SELECT merged_at AS at, repo_id AS repoId, json_extract(record, '$.ticket') AS ticket
           FROM pr_history WHERE merged_at >= ? AND merged_at <= ? ORDER BY merged_at`,
        )
        .all(low, high) as { at: number; repoId: string; ticket: string | null }[]
    ).filter((m) => m.at !== null);
    const reviews = this.db
      .prepare(
        `SELECT ended_at AS at, blocking > 0 AS failed, author_run_id AS authorRunId, round
         FROM reviews WHERE state = 'reported' AND ended_at >= ? AND ended_at <= ? ORDER BY ended_at`,
      )
      .all(low, high) as { at: number; failed: number; authorRunId: string; round: number }[];
    const cost = new Map<string, number>();
    for (const c of this.db
      .prepare(
        `SELECT repo_id AS repoId, ticket, SUM(cost_usd) AS costUsd FROM runs
         WHERE ticket IS NOT NULL GROUP BY repo_id, ticket HAVING costUsd IS NOT NULL`,
      )
      .all() as { repoId: string; ticket: string; costUsd: number }[])
      cost.set(`${c.repoId}\0${c.ticket}`, c.costUsd);
    // First index whose time is at or after `t`.
    const lower = (rows: readonly { at: number }[], t: number): number => {
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((rows[mid] as { at: number }).at < t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    return (from, to) => {
      const prs = merged.slice(lower(merged, from), lower(merged, to + 1));
      const reviewed = reviews.slice(lower(reviews, from), lower(reviews, to + 1));
      const costs = new Set<string>();
      for (const m of prs) {
        const key = `${m.repoId}\0${m.ticket}`;
        if (m.ticket !== null && cost.has(key)) costs.add(key);
      }
      const topRound = new Map<string, number>();
      for (const r of reviewed)
        topRound.set(r.authorRunId, Math.max(topRound.get(r.authorRunId) ?? r.round, r.round));
      let rework = 0;
      for (const top of topRound.values()) rework += Math.max(0, top - 1);
      return {
        merged: prs.length,
        reviewFailRate:
          reviewed.length === 0
            ? null
            : reviewed.reduce((n, r) => n + (r.failed ? 1 : 0), 0) / reviewed.length,
        medianCostPerMergedTicket: median([...costs].map((k) => cost.get(k) as number)),
        reworkRounds: rework,
      };
    };
  }

  pullRequests(repoId: RepoId): PullRequestView[] {
    const rows = this.statement(
      "SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY number DESC",
    ).all(repoId) as Row[];
    return this.pullRequestRows(rows);
  }

  /** Branches from durable merged-PR history, retained after the live PR cache drops them. */
  mergedPullRequestBranches(repoId: RepoId): string[] {
    return (
      this.statement(
        `SELECT DISTINCT json_extract(record, '$.branch') AS branch FROM pr_history
         WHERE repo_id = ? AND json_extract(record, '$.branch') IS NOT NULL`,
      ).all(repoId) as { branch: string }[]
    ).map((row) => row.branch);
  }

  /**
   * The p90 run time (ms) of each CI check run in the repo, by name, over its last merged PRs
   * that kept check timings; a name with fewer than CI_P90_MIN_SAMPLES runs is left out.
   */
  ciCheckP90Ms(repoId: RepoId): Record<string, number> {
    const rows = this.statement(
      "SELECT checks FROM pull_requests WHERE repo_id = ? AND state = 'merged' ORDER BY merged_at DESC LIMIT ?",
    ).all(repoId, CI_P90_PRS) as Row[];
    const byName = new Map<string, number[]>();
    for (const r of rows) {
      for (const c of parseJson<PrCheck[]>(r.checks, [])) {
        if (c.kind !== "check" || c.state !== "passing") continue;
        if (c.startedAt === undefined || c.completedAt === undefined) continue;
        const ms = c.completedAt - c.startedAt;
        if (ms <= 0) continue;
        byName.set(c.name, [...(byName.get(c.name) ?? []), ms]);
      }
    }
    const out: Record<string, number> = {};
    for (const [name, xs] of byName) {
      if (xs.length < CI_P90_MIN_SAMPLES) continue;
      xs.sort((a, b) => a - b);
      out[name] = xs[Math.min(xs.length - 1, Math.ceil(xs.length * 0.9) - 1)] as number;
    }
    return out;
  }

  /** The newest PR of a branch, as its number and state: one narrow row. */
  pullRequestOfBranch(
    repoId: RepoId,
    branch: string,
    createdSince?: number,
  ): { number: number; state: PullRequestView["state"] } | null {
    const statement = this.statement(
      createdSince === undefined
        ? "SELECT number, state FROM pull_requests WHERE repo_id = ? AND branch = ? ORDER BY number DESC LIMIT 1"
        : "SELECT number, state FROM pull_requests WHERE repo_id = ? AND branch = ? AND created_at >= ? ORDER BY number DESC LIMIT 1",
    );
    const row = statement.get(
      repoId,
      branch,
      ...(createdSince === undefined ? [] : [createdSince]),
    ) as { number: number; state: PullRequestView["state"] } | undefined;
    return row ?? null;
  }

  /** A pinned link needs no historical checks, review metadata or escaped-defect hydration. */
  pullRequestLink(
    repoId: RepoId,
    ref: { number: number } | { ticket: string },
  ): Pick<PullRequestView, "repoId" | "number" | "title" | "url"> | null {
    const row =
      "number" in ref
        ? this.statement(
            "SELECT number, title, url FROM pull_requests WHERE repo_id = ? AND number = ?",
          ).get(repoId, ref.number)
        : this.statement(
            "SELECT number, title, url FROM pull_requests WHERE repo_id = ? AND ticket = ? AND state = 'open' ORDER BY number DESC LIMIT 1",
          ).get(repoId, ref.ticket);
    return row === undefined
      ? null
      : { repoId, ...(row as { number: number; title: string; url: string }) };
  }

  /** The queue needs only open PRs, without decoding historical checks and bodies. */
  openPullRequests(repoId: RepoId): PullRequestView[] {
    const rows = this.statement(
      "SELECT * FROM pull_requests WHERE repo_id = ? AND state = 'open' ORDER BY created_at, number",
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

  /** The repo's cached PRs that belong to the ticket (`repo#number`), newest number first. */
  pullRequestsOnTicket(repoId: RepoId, ticket: string): PullRequestView[] {
    const rows = this.statement(
      "SELECT * FROM pull_requests WHERE ticket = ? AND repo_id = ? ORDER BY number DESC",
    ).all(ticket, repoId) as Row[];
    return this.pullRequestRows(rows);
  }

  /** PRs that name this ticket directly or in closingIssues, without decoding unrelated histories. */
  pullRequestsClosingTicket(repoId: RepoId, issue: number): PullRequestView[] {
    const rows = this.statement(`SELECT * FROM pull_requests WHERE repo_id = ?
      AND (ticket = ? OR EXISTS (SELECT 1 FROM json_each(closing_issues) WHERE value = ?))
      ORDER BY number DESC`).all(repoId, `${repoId}#${issue}`, issue) as Row[];
    return this.pullRequestRows(rows);
  }

  /** Every review of a PR, oldest first. */
  reviewsOfPr(repoId: RepoId, prNumber: number): ReviewRow[] {
    return reviewsStore.reviewsOfPr(this.db, repoId, prNumber);
  }

  /** Every check run read for a PR's heads, newest first. */
  ciRunsOfPr(repoId: RepoId, prNumber: number): CiRunView[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM ci_runs WHERE repo_id = ? AND pr_number = ? ORDER BY at DESC, name, attempt DESC",
      )
      .all(repoId, prNumber) as Row[];
    return rows.map(toCiRun);
  }

  /**
   * The newest `limit` comms messages that name the ticket: by its qualified `repo#n` (set by the
   * hub), by the short `#n` a seat's or the operator's message carries, or by `PR n` for one of its
   * PRs. Short forms carry no repo, so the caller keeps only those that belong to this one.
   */
  commsOnTicket(
    ticket: string,
    shortRef: string,
    prRefs: readonly string[],
    limit: number,
  ): CommsRow[] {
    return this.commsStore.commsOnTicket(ticket, shortRef, prRefs, limit);
  }

  /** Counts retained and retired reference metadata; never reads text or limits by time. */
  commsTicketReferenceCounts(): {
    ticket: string | null;
    ref: string | null;
    from: string;
    count: number;
  }[] {
    return this.commsStore.commsTicketReferenceCounts();
  }

  /** Lightweight links for referenced PR numbers, without parsing unrelated checks or history. */
  commsPrTicketLinks(
    numbers: readonly number[],
  ): { repoId: string; number: number; ticket: string | null; closingIssues: number[] }[] {
    const rows: Row[] = [];
    const unique = [...new Set(numbers)];
    for (let start = 0; start < unique.length; start += 400) {
      const batch = unique.slice(start, start + 400);
      rows.push(
        ...(this.statement(`SELECT repo_id, number, ticket, closing_issues FROM pull_requests
        WHERE number IN (${batch.map(() => "?").join(",")})`).all(...batch) as Row[]),
      );
    }
    return rows.map((r) => ({
      repoId: r.repo_id as string,
      number: r.number as number,
      ticket: r.ticket as string | null,
      closingIssues: parseJson<number[]>(r.closing_issues, []),
    }));
  }

  /** A separate indexed question page; ending a run alone does not provide answer text. */
  ticketQuestions(
    repoId: string,
    ticket: string,
    limit: number,
    before: { at: number; id: number } | null = null,
  ): TicketQuestion[] {
    const rows =
      this.statement(`SELECT q.*, d.decision AS answer, d.at AS answer_at, d.basis AS answer_basis,
        (SELECT x.item_key FROM comms x WHERE x.item_key = 'ask:' || q.id LIMIT 1)
          AS discussion_key
      FROM seat_questions q JOIN runs r ON r.id = q.run_id
      LEFT JOIN flight_decisions d ON d.id = (SELECT a.id FROM flight_decisions a
        WHERE a.question_id = q.id AND a.kind = 'answer' ORDER BY a.at DESC, a.id DESC LIMIT 1)
      WHERE r.repo_id = ? AND r.ticket = ?
      ${before === null ? "" : "AND (q.at < ? OR (q.at = ? AND q.id < ?))"}
      ORDER BY q.at DESC, q.id DESC LIMIT ?`).all(
        repoId,
        ticket,
        ...(before === null ? [] : [before.at, before.at, before.id]),
        limit,
      ) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      seat: r.agent_id as string,
      text: r.text as string,
      discussionKey: r.discussion_key as string | null,
      at: r.at as number,
      passedAt: r.passed_at as number | null,
      asideAt: r.aside_at as number | null,
      closedAt: r.answered_at as number | null,
      answer: r.answer as string | null,
      answerAt: r.answer_at as number | null,
      answerBasis: r.answer_basis as string | null,
    }));
  }

  /** The newest `limit` FLIGHT decisions that name the ticket by ref or target one of its runs. */
  flightDecisionsOnTicket(ref: string, runIds: readonly string[], limit: number): FlightDecision[] {
    return this.flightQ.flightDecisionsOnTicket(ref, runIds, limit);
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

  /** The HUD retains every open PR and the historical PRs its displayed runs actually name. */
  openAndReferencedPullRequests(
    repoIds: readonly RepoId[],
    referenced: readonly Pick<PullRequestView, "repoId" | "number">[],
  ): Map<RepoId, PullRequestView[]> {
    const out = new Map<RepoId, PullRequestView[]>(repoIds.map((repoId) => [repoId, []]));
    if (repoIds.length === 0) return out;
    const rows = this.statement(`WITH referenced AS (
      SELECT json_extract(value, '$.repoId') AS repo_id, json_extract(value, '$.number') AS number
      FROM json_each(?)
    ) SELECT p.* FROM pull_requests p
      WHERE p.repo_id IN (${repoIds.map(() => "?").join(", ")})
      AND (p.state = 'open' OR (p.repo_id, p.number) IN (
        SELECT repo_id, number FROM referenced
      )) ORDER BY p.number DESC`).all(JSON.stringify(referenced), ...repoIds) as Row[];
    for (const pr of this.pullRequestRows(rows)) out.get(pr.repoId)?.push(pr);
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
      assignees: parseJson<string[]>(r.assignees, []),
      checks: parseJson<PrCheck[]>(r.checks, []),
      closingIssues: parseJson<number[]>(r.closing_issues, []),
      ...(r.is_cross_repository == null ? {} : { isCrossRepository: r.is_cross_repository === 1 }),
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
  replaceFlow(
    repoId: RepoId,
    issues: FlowIssue[],
    prs: FlowPr[],
    moves: FlowColumnMove[] = [],
  ): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM flow_issues WHERE repo_id = ?").run(repoId);
      this.db.prepare("DELETE FROM flow_column_moves WHERE repo_id = ?").run(repoId);
      this.db.prepare("DELETE FROM flow_prs WHERE repo_id = ?").run(repoId);
      const insIssue = this.db.prepare(
        "INSERT INTO flow_issues (repo_id, number, size, start_at, done_at, title) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const i of issues)
        insIssue.run(repoId, i.number, i.size, i.startAt, i.doneAt, i.title ?? null);
      const insMove = this.db.prepare(
        "INSERT INTO flow_column_moves (repo_id, number, at, column) VALUES (?, ?, ?, ?)",
      );
      for (const m of moves) insMove.run(repoId, m.number, m.at, m.column);
      const insPr = this.db.prepare(
        "INSERT INTO flow_prs (repo_id, number, merged_at, first_push_ci) VALUES (?, ?, ?, ?)",
      );
      for (const p of prs) insPr.run(repoId, p.number, p.mergedAt, p.firstPushCi);
    });
  }

  /** Every observed flow-column move, oldest first, for local telemetry reads. */
  flowColumnMoves(): FlowColumnMove[] {
    const rows = this.db
      .prepare("SELECT * FROM flow_column_moves ORDER BY at ASC, repo_id, number, id")
      .all() as Row[];
    return rows.map((r) => ({
      repoId: r.repo_id as string,
      number: r.number as number,
      at: r.at as number,
      column: r.column as FlowColumnMove["column"],
    }));
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
      title: r.title as string | null,
    }));
  }

  /** The first recorded crew run for a ticket, including one before a telemetry chart's range. */
  ticketStartedAt(ticket: string): number | null {
    return this.runQ.ticketStartedAt(ticket);
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
          `INSERT OR REPLACE INTO machine_samples
             (at, sample, cpu_pct, mem_pct, swap_pct, pressure_pct, agent_gb, test_gb)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          s.at,
          JSON.stringify(s),
          s.cpuPct,
          memPct(s),
          swapPct(s),
          pressurePct(s),
          s.agents ? s.agents.rssBytes / GIB : null,
          s.testRun ? s.testRun.rssBytes / GIB : null,
        );
      this.db.prepare("DELETE FROM machine_samples WHERE at < ?").run(s.at - MACHINE_RETENTION_MS);
    });
  }

  /** Stored machine samples with `at >= sinceMs`, oldest first. */
  machineSamples(sinceMs: number): MachineSample[] {
    const rows = this.db
      .prepare("SELECT sample FROM machine_samples WHERE at >= ? ORDER BY at ASC")
      .all(sinceMs) as { sample: string }[];
    return rows.flatMap((r) => {
      const s = parseJson<MachineSample | null>(r.sample, null);
      return s ? [s] : [];
    });
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
        `SELECT MAX(at) AS at, AVG(cpu_pct) AS cpu, AVG(mem_pct) AS mem, AVG(swap_pct) AS swap,
                AVG(pressure_pct) AS pressure, AVG(agent_gb) AS agent, AVG(test_gb) AS test
         FROM machine_samples
         WHERE at >= ? AND at <= ?
         GROUP BY MIN(?, CAST((at - ?) / ? AS INTEGER)) ORDER BY 1 ASC`,
      )
      .all(sinceMs, untilMs, points - 1, sinceMs, bucketMs) as {
      at: number;
      cpu: number | null;
      mem: number | null;
      swap: number | null;
      pressure: number | null;
      agent: number | null;
      test: number | null;
    }[];
    return rows.map((r) => ({
      at: r.at,
      cpuPct: r.cpu,
      memPct: r.mem,
      swapPct: round2(r.swap),
      pressurePct: round2(r.pressure),
      agentGb: round2(r.agent),
      testRunGb: round2(r.test),
    }));
  }

  /** Acknowledges attention item keys at `at` (a re-ack moves the time; absence is kept). */
  ack(keys: string[], at: number): void {
    this.transaction(() => {
      const briefs = this.briefs();
      const ins = this.db.prepare(
        `INSERT INTO acks (key, at, absent_since) VALUES (?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET at = excluded.at`,
      );
      for (const k of keys) {
        ins.run(k, at);
        const epoch = briefs.get(k)?.binding?.epoch;
        if (epoch) {
          this.setSetting(`brief-ack:${k}`, epoch);
          this.setSetting(`brief-default-cancel:${epoch}`, String(at));
        }
      }
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
      choice?: { epoch: string; requestKey: string; fingerprint: string; record: string };
      binding?: string;
    },
    message: NewCommsRow,
    at: number,
  ): boolean {
    let claimed = false;
    this.transaction(() => {
      if (d.choice && this.getSetting(`brief-choice:${d.choice.epoch}`)) return;
      const r = this.db
        .prepare(
          `INSERT OR IGNORE INTO decision_defaults (key, brief_at, option_id, label, due_at, applied_at, target, answer, delivered_at, binding, delivery_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          d.binding ?? null,
          d.binding ? "pending" : "legacy",
        );
      if (r.changes === 0) return;
      if (d.choice) {
        this.setSetting(`brief-choice:${d.choice.epoch}`, d.choice.record);
        this.setSetting(d.choice.requestKey, d.choice.fingerprint);
        this.setSetting(`${d.choice.requestKey}:epoch`, d.choice.epoch);
        this.setSetting(`brief-ack:${d.key}`, d.choice.epoch);
      }
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

  /** One local choice per semantic epoch, serialized across Store handles by SQLite. */
  claimBriefChoice(
    epoch: string,
    requestKey: string,
    fingerprint: string,
    record: string,
  ): boolean {
    let claimed = false;
    this.transaction(() => {
      if (this.getSetting(`brief-choice:${epoch}`)) return;
      const prior = this.getSetting(requestKey);
      if (prior && prior !== fingerprint) return;
      this.setSetting(requestKey, fingerprint);
      this.setSetting(`${requestKey}:epoch`, epoch);
      this.setSetting(`brief-choice:${epoch}`, record);
      claimed = true;
    }, true);
    return claimed;
  }

  /** A confirmed authentication refusal performed no action and cannot consume the operator's decision. */
  refuseBriefChoice(epoch: string, requestKey: string, fingerprint: string, record: string): void {
    this.transaction(() => {
      const raw = this.getSetting(`brief-choice:${epoch}`);
      if (!raw || parseJson<{ fingerprint?: string }>(raw, {}).fingerprint !== fingerprint) return;
      this.setSetting(`${requestKey}:receipt`, record);
      this.setSetting(`brief-last-choice:${epoch}`, record);
      this.deleteSetting(`brief-choice:${epoch}`);
    }, true);
  }

  pendingDecisionDeliveries(): {
    key: string;
    briefAt: number;
    target: string;
    answer: string;
    binding?: string;
  }[] {
    return (
      this.db
        .prepare(`SELECT key, brief_at, target, answer, binding FROM decision_defaults d
      WHERE delivered_at IS NULL AND target IS NOT NULL AND delivery_state = 'pending'
        AND NOT EXISTS (SELECT 1 FROM question_closures c WHERE c.key = d.key AND c.kind = 'cleared' AND c.at >= d.applied_at)
      ORDER BY applied_at, key`)
        .all() as Row[]
    ).map((r) => ({
      key: r.key as string,
      briefAt: r.brief_at as number,
      target: r.target as string,
      answer: r.answer as string,
      ...(r.binding === null ? {} : { binding: r.binding as string }),
    }));
  }

  markDecisionDeliveryDone(key: string, briefAt: number, at: number): void {
    this.db
      .prepare(
        "UPDATE decision_defaults SET delivered_at = ?, delivery_state = 'delivered' WHERE key = ? AND brief_at = ?",
      )
      .run(at, key, briefAt);
  }

  stopDecisionDelivery(
    key: string,
    briefAt: number,
    state: "canceled" | "unknown",
    reason: string,
  ): void {
    this.db
      .prepare(
        "UPDATE decision_defaults SET delivery_state = ?, delivery_note = ? WHERE key = ? AND brief_at = ? AND delivered_at IS NULL",
      )
      .run(state, reason, key, briefAt);
  }

  briefChoice(epoch: string): BriefChoiceReceipt | null {
    const raw =
      this.getSetting(`brief-choice:${epoch}`) ?? this.getSetting(`brief-last-choice:${epoch}`);
    if (!raw) return null;
    try {
      return parseJson<{ receipt?: BriefChoiceReceipt }>(raw, {}).receipt ?? null;
    } catch {
      return null;
    }
  }

  /** Retained delivery outcomes include legacy/unverifiable rows; none is silently rebound. */
  decisionDeliveryState(
    key: string,
    briefAt: number,
  ): { state: string; deliveredAt: number | null; note: string | null } | null {
    const row = this.db
      .prepare(
        "SELECT delivery_state, delivered_at, delivery_note FROM decision_defaults WHERE key = ? AND brief_at = ?",
      )
      .get(key, briefAt) as Row | undefined;
    return row
      ? {
          state: row.delivery_state as string,
          deliveredAt: row.delivered_at as number | null,
          note: row.delivery_note as string | null,
        }
      : null;
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
        "INSERT INTO file_offsets (path, offset) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset WHERE file_offsets.offset != excluded.offset",
      )
      .run(path, offset);
  }

  /** Records a collector's status; `last_ok_at` moves on success and is kept through failures. */
  setStatus(collector: string, ok: boolean, error: string | null): void {
    const at = Date.now();
    // The same result again moves only its time. That is no news to a view built from the store:
    // `readVersion` leaves it out, so a tick that found nothing new does not drop every view.
    const kept = this.db
      .prepare("SELECT ok, error FROM collector_status WHERE collector = ?")
      .get(collector) as { ok: number; error: string | null } | undefined;
    if (kept !== undefined && kept.ok === (ok ? 1 : 0) && kept.error === error)
      this.timestampOnlyWrites++;
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
    this.runQ.setRunLoop(runId, loop, at);
    if (loop?.phase === "done") this.clearNoReportNotes(runId, at, true);
  }

  /** Ends the run: when, with what status, and who ended it. */
  setRunEnded(
    runId: string,
    at: number,
    status: RunStatus,
    endedBy: NonNullable<Run["endedBy"]>,
  ): void {
    this.runQ.setRunEnded(runId, at, status, endedBy);
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
        // Archived reports outlive reviews. Allocate above both tables so history pruning cannot
        // reuse an archived review's identity. The allocation and insertion are one SQLite write.
        `INSERT OR IGNORE INTO reviews (id, author_run_id, repo_id, seat_id, pr_number, sha, epoch,
           attempt, round, state, created_at)
         SELECT MAX(last_id) + 1, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?
         FROM (SELECT COALESCE(MAX(id), 0) AS last_id FROM reviews
           UNION ALL SELECT COALESCE(MAX(native_review_id), 0) FROM qa_reports)`,
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
    return reviewsStore.review(this.db, id);
  }

  /** Moves a queued review to another review seat; true only when it was still queued. */
  moveQueuedReview(id: number, seatId: string, at: number): boolean {
    return reviewsStore.moveQueuedReview(
      this.db,
      (write) => this.transaction(write),
      id,
      seatId,
      at,
    );
  }

  /** Whether FLIGHT assigned the queued review to its current seat. */
  reviewMoved(id: number): boolean {
    return reviewsStore.reviewMoved(this.db, id);
  }

  /** The first snapshot wins. No update method exists; later evidence creates a new report. */
  putQaReport(report: QaReport): boolean {
    return (
      this.db
        .prepare(`INSERT OR IGNORE INTO qa_reports
      (id, repo_id, pr_number, head_sha, registered_at, native_review_id, report)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          report.id,
          report.repoId,
          report.prNumber,
          report.headSha,
          report.registeredAt,
          report.nativeReviewId ?? null,
          JSON.stringify(report),
        ).changes === 1
    );
  }

  qaReport(id: string): QaReport | null {
    const row = this.db.prepare("SELECT report FROM qa_reports WHERE id = ?").get(id) as
      | Row
      | undefined;
    try {
      return row ? parseJson<QaReport | null>(row.report, null) : null;
    } catch {
      return null;
    }
  }

  /** Immutable display material for a Needs-you item; packets never alter its brief or choice. */
  putAttentionMaterials(packet: AttentionMaterials): boolean {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO attention_materials (id, item_key, packet) VALUES (?, ?, ?)",
        )
        .run(packet.id, packet.itemKey, JSON.stringify(packet)).changes > 0
    );
  }

  attentionMaterials(id: string): AttentionMaterials | null {
    const row = this.db.prepare("SELECT packet FROM attention_materials WHERE id = ?").get(id) as
      | { packet: string }
      | undefined;
    return row ? parseJson<AttentionMaterials | null>(row.packet, null) : null;
  }

  /** Every packet saved for one item, oldest first; the per-question image cap sums over them. */
  attentionMaterialsAllForItem(itemKey: string): AttentionMaterials[] {
    return (
      this.db
        .prepare(
          "SELECT packet FROM attention_materials WHERE item_key = ? ORDER BY json_extract(packet, '$.registeredAt') ASC, rowid ASC",
        )
        .all(itemKey) as { packet: string }[]
    ).flatMap((row) => {
      const p = parseJson<AttentionMaterials | null>(row.packet, null);
      return p ? [p] : [];
    });
  }

  qaReports(repoId: string, pr: number, headSha?: string): QaReport[] {
    const rows = this.db
      .prepare(`SELECT report FROM qa_reports WHERE repo_id = ? AND pr_number = ?
      ${headSha === undefined ? "" : "AND head_sha = ?"} ORDER BY registered_at DESC, id DESC LIMIT 100`)
      .all(repoId, pr, ...(headSha === undefined ? [] : [headSha])) as Row[];
    return rows.flatMap((row) => {
      try {
        return [parseJson<unknown>(row.report as string, undefined, rethrowJson) as QaReport];
      } catch {
        return [];
      }
    });
  }

  /** Lightweight union, paginated before detail/asset reads. Archived native rows appear once. */
  qaHistory(
    repoIds: readonly string[],
    limit: number,
    cursor?: { at: number; key: string },
  ): QaHistoryEntry[] {
    if (!repoIds.length) return [];
    const marks = repoIds.map(() => "?").join(",");
    // Select identities before parsing report JSON or reading child evidence. Work per page is bounded.
    const identities = this.db
      .prepare(`WITH history AS (
      SELECT 'r:' || id AS key, 'report' AS kind, id, registered_at AS recorded_at
        FROM qa_reports WHERE repo_id IN (${marks})
      UNION ALL
      SELECT 'n:' || v.id, 'native', v.id, COALESCE(v.ended_at, v.created_at)
        FROM reviews v WHERE v.repo_id IN (${marks})
        AND v.state IN ('reported', 'failed', 'superseded')
        AND NOT EXISTS (SELECT 1 FROM qa_reports q WHERE q.native_review_id = v.id
          AND q.repo_id = v.repo_id AND q.pr_number = v.pr_number AND q.head_sha = v.sha
          AND json_extract(q.report, '$.reviewer.id') = v.seat_id
          AND COALESCE(json_extract(q.report, '$.nativeRunId'), '') = COALESCE(v.run_id, ''))
    ) SELECT * FROM history ${cursor ? "WHERE recorded_at < ? OR (recorded_at = ? AND key < ?)" : ""}
      ORDER BY recorded_at DESC, key DESC LIMIT ?`)
      .all(
        ...repoIds,
        ...repoIds,
        ...(cursor ? [cursor.at, cursor.at, cursor.key] : []),
        Math.max(1, Math.min(51, limit)),
      ) as Row[];
    const reportSummary =
      this.db.prepare(`      SELECT 'r:' || q.id AS key, 'report' AS kind, q.repo_id, q.pr_number, q.head_sha,
        json_extract(q.report, '$.prTitle') AS title, json_extract(q.report, '$.source') AS source,
        json_extract(q.report, '$.reviewer') AS reviewer,
        json_extract(q.report, '$.reviewedAt') AS reviewed_at,
        q.registered_at AS recorded_at, 'saved' AS state,
        json_extract(q.report, '$.verdict') AS verdict,
        json_extract(q.report, '$.completeness.state') AS evidence,
        CASE WHEN json_extract(q.report, '$.ci.source') = 'unavailable'
          OR json_extract(q.report, '$.ci.headSha') IS NOT q.head_sha
          OR COALESCE(json_array_length(q.report, '$.ci.checks'), 0) = 0 THEN 'unavailable'
          WHEN EXISTS (SELECT 1 FROM json_each(q.report, '$.ci.checks') c
            WHERE json_extract(c.value, '$.state') = 'failing') THEN 'failing'
          WHEN EXISTS (SELECT 1 FROM json_each(q.report, '$.ci.checks') c
            WHERE json_extract(c.value, '$.state') != 'passing') THEN 'pending'
          ELSE 'passing' END AS ci,
        json_extract(q.report, '$.visual.applicability') AS visual,
        COALESCE(json_array_length(q.report, '$.visual.pairs'), 0) AS pairs,
        COALESCE(json_array_length(q.report, '$.visual.screenshots'), 0) AS shots,
        json_extract(q.report, '$.permalink') AS permalink
      FROM qa_reports q WHERE q.id = ? AND json_valid(q.report)
`);
    const nativeSummary =
      this.db.prepare(`SELECT 'n:' || v.id AS key, 'native' AS kind, 'native' AS source,
      v.repo_id, v.pr_number, v.sha AS head_sha, v.id, v.author_run_id, v.created_at, v.seat_id, v.run_id, v.epoch, v.attempt, v.round,
      'Native review · round ' || v.round AS title,
      json_object('id', v.seat_id, 'label', v.seat_id) AS reviewer,
      CASE WHEN v.state = 'reported' THEN v.ended_at END AS reviewed_at,
      COALESCE(v.ended_at, v.created_at) AS recorded_at, v.state, v.verdict,
      'legacy' AS evidence, 'unavailable' AS ci, 'unknown' AS visual, 0 AS pairs,
      (SELECT COUNT(*) FROM review_shots s WHERE s.review_id = v.id) AS shots,
      '/qa?view=history&native=' || v.id AS permalink FROM reviews v WHERE v.id = ?`);
    const rows = identities.flatMap((identity) => {
      const row = (identity.kind === "report" ? reportSummary : nativeSummary).get(
        identity.id as SQLInputValue,
      ) as Row | undefined;
      return row ? [row] : [];
    });
    return rows.map((r) => ({
      key: r.key as string,
      kind: r.kind as QaHistoryEntry["kind"],
      source: r.source as QaHistoryEntry["source"],
      repoId: r.repo_id as string,
      prNumber: r.pr_number as number,
      headSha: r.head_sha as string,
      title: r.title as string,
      reviewer: parseJson<QaHistoryEntry["reviewer"]>(r.reviewer, null as never),
      reviewedAt: r.reviewed_at as number | null,
      recordedAt: r.recorded_at as number,
      state: r.state as string,
      verdict: r.verdict ? parseJson<QaHistoryEntry["verdict"]>(r.verdict, null as never) : null,
      evidence: r.evidence as QaHistoryEntry["evidence"],
      ci: r.ci as QaHistoryEntry["ci"],
      visual: r.visual as QaHistoryEntry["visual"],
      pairCount: r.pairs as number,
      screenshotCount: r.shots as number,
      permalink:
        r.kind === "native"
          ? `${r.permalink}&identity=${qaNativeIdentity({
              id: r.id as number,
              repoId: r.repo_id as string,
              prNumber: r.pr_number as number,
              sha: r.head_sha as string,
              seatId: r.seat_id as string,
              runId: r.run_id as string | null,
              authorRunId: r.author_run_id as string,
              createdAt: r.created_at as number,
              epoch: r.epoch as number,
              attempt: r.attempt as number,
              round: r.round as number,
            })}`
          : (r.permalink as string),
    }));
  }

  qaReportForReview(reviewId: number): QaReport | null {
    const row = this.db
      .prepare("SELECT id FROM qa_reports WHERE native_review_id = ?")
      .get(reviewId) as Row | undefined;
    return row ? this.qaReport(row.id as string) : null;
  }

  qaAssetReferenced(id: string, repoIds: readonly string[]): boolean {
    if (!repoIds.length) return false;
    return (
      this.db
        .prepare(`SELECT 1 FROM qa_reports WHERE repo_id IN (${repoIds.map(() => "?").join(",")})
      AND instr(report, ?) > 0 LIMIT 1`)
        .get(...repoIds, `/api/qa-report-assets/${id}`) !== undefined
    );
  }

  /** Open PRs as `repoId#number`: the work whose evidence and pictures the disk sweep keeps. */
  openPrKeys(): Set<string> {
    return new Set(
      (
        this.db
          .prepare("SELECT repo_id, number FROM pull_requests WHERE state = 'open'")
          .all() as Row[]
      ).map((r) => `${r.repo_id as string}#${r.number as number}`),
    );
  }

  /** The QA image ids (sha256) that a report of an open PR cites. */
  qaAssetIdsOfOpenPrs(): Set<string> {
    const ids = new Set<string>();
    const rows = this.db
      .prepare(
        `SELECT q.report FROM qa_reports q JOIN pull_requests p
           ON p.repo_id = q.repo_id AND p.number = q.pr_number AND p.state = 'open'`,
      )
      .all() as Row[];
    for (const r of rows)
      for (const m of (r.report as string).matchAll(/\/api\/qa-report-assets\/([0-9a-f]{64})/g))
        ids.add(m[1]);
    return ids;
  }

  /** The picture ids that packets of the given still-waiting questions cite. */
  attentionMaterialAssetIds(openItemKeys: ReadonlySet<string>): Set<string> {
    const ids = new Set<string>();
    const rows = this.db.prepare("SELECT item_key, packet FROM attention_materials").all() as Row[];
    for (const r of rows) {
      if (!openItemKeys.has(r.item_key as string)) continue;
      for (const m of (r.packet as string).matchAll(
        /\/api\/attention-material-assets\/([0-9a-f]{64})/g,
      ))
        ids.add(m[1]);
    }
    return ids;
  }

  /** The review screenshot ids of reviews of open PRs. */
  reviewShotIdsOfOpenPrs(): Set<string> {
    return new Set(
      (
        this.db
          .prepare(
            `SELECT s.shot_id FROM review_shots s JOIN reviews v ON v.id = s.review_id
               JOIN pull_requests p ON p.repo_id = v.repo_id AND p.number = v.pr_number AND p.state = 'open'`,
          )
          .all() as Row[]
      ).map((r) => r.shot_id as string),
    );
  }

  /** Every review of an external PR (author id `external-pr:...`) that has not been superseded. */
  externalReviewRows(): ReviewRow[] {
    return reviewsStore.externalReviewRows(this.db);
  }

  reviewsOfRun(authorRunId: string): ReviewRow[] {
    return reviewsStore.reviewsOfRun(this.db, authorRunId);
  }

  /** The latest review of a PR that has reported, else null. */
  latestReportedReview(repoId: string, prNumber: number): ReviewRow | null {
    return reviewsStore.latestReportedReview(this.db, repoId, prNumber);
  }

  /** The review the run (a review run) performs, else null. */
  reviewOfRun(reviewRunId: string): ReviewRow | null {
    return reviewsStore.reviewOfRun(this.db, reviewRunId);
  }

  reviewsIn(
    states: readonly ReviewState[],
    window?: { repo: string; since: number; until: number },
  ): ReviewRow[] {
    return reviewsStore.reviewsIn(this.db, states, window);
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
      qaReport?: QaReport;
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
        .prepare(
          "SELECT author_run_id, repo_id, pr_number, sha, epoch, round, changed_since FROM reviews WHERE id = ?",
        )
        .get(reviewId) as Row;
      const author = row.author_run_id as string;
      const repoId = row.repo_id as string;
      const prNumber = row.pr_number as number;
      const merged =
        (
          this.db
            .prepare("SELECT state FROM pull_requests WHERE repo_id = ? AND number = ?")
            .get(repoId, prNumber) as Row | undefined
        )?.state === "merged";
      // late: a later round's finding on a file the author did not touch since the last review
      const changed =
        (row.round as number) >= 2 && row.changed_since !== null
          ? new Set(parseJson<string[]>(row.changed_since, []))
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
        // An external review's subject is the PR, so it also accepts the crew run's findings on
        // earlier heads, but only those its brief listed: a review does not accept what it never saw.
        if (author === externalReviewKey(repoId, prNumber)) {
          const previous = this.reviewsOfRun(author)
            .filter((x) => x.id < reviewId && x.state === "reported")
            .at(-1);
          const resolveListed = this.db.prepare(
            `UPDATE review_findings SET resolution = 'fixed', resolved_review_id = ?
             WHERE review_id = ? AND pos = ? AND resolution IS NULL`,
          );
          for (const o of openOlderFindings(
            this,
            { id: reviewId, repoId, prNumber, sha: row.sha as string, authorRunId: author },
            previous?.id ?? null,
          ).slice(0, OLDER_FINDINGS_MAX))
            resolveListed.run(reviewId, o.reviewId, o.finding.pos);
        }
      }
      this.appendAttempt(author, "review", r.at, {
        ...this.review(reviewId),
        findings: r.findings,
      });
      this.clearNoReportNotes(runId, r.at);
      if (merged) this.recordSilenceEvent("merged-pr-review-recorded", r.at);
      if (r.qaReport && !this.putQaReport(r.qaReport))
        throw new Error("QA report snapshot already exists");
      recorded = true;
    }, true);
    return recorded;
  }

  /** The files the author changed since the previous reviewed sha, for tagging late findings. */
  setReviewChangedSince(reviewId: number, files: readonly string[]): void {
    reviewsStore.setReviewChangedSince(this.db, reviewId, files);
  }

  /** Why this review ran without an install ("reviewed, not installed"), kept with the review. */
  setReviewInstallNote(reviewId: number, note: string): void {
    reviewsStore.setReviewInstallNote(this.db, reviewId, note);
  }

  findingsOf(reviewId: number): StoredFinding[] {
    return reviewsStore.findingsOf(this.db, reviewId);
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

  /**
   * Files with blocking review findings in range, with how many merged PRs in range touched each
   * (the stored diff files). Generated files are left out. Most findings per touch first (files with no stored touch
   * last), cut at AUDIT_FINDING_FILES after ranking; `touches` is 0 where no stored diff names the file.
   */
  private auditFindingFiles(since: number, until: number): NonNullable<AuditView["findingFiles"]> {
    const marks = BLOCKING_SEVERITIES.map(() => "?").join(", ");
    const raised = this.db
      .prepare(
        `SELECT f.review_id AS review, f.file AS file, COUNT(*) AS n FROM review_findings f
         JOIN reviews v ON v.id = f.review_id
         WHERE v.state = 'reported' AND v.ended_at >= ? AND v.ended_at <= ?
           AND f.severity IN (${marks})
         GROUP BY f.review_id, f.file`,
      )
      .all(since, until, ...BLOCKING_SEVERITIES) as { review: number; file: string; n: number }[];
    // A finding the reviewer holds is listed again by the next round. That listing is the same
    // finding, so it is not counted twice: each held resolution takes one listing of its file from
    // the round that held it, provided the held finding was itself raised in range.
    const held = new Map<string, number>();
    for (const h of this.db
      .prepare(
        `SELECT x.review_id AS review, p.file AS file, COUNT(*) AS n FROM review_resolutions x
         JOIN review_findings p ON p.review_id = x.prior_review_id AND p.pos = x.finding_pos
         JOIN reviews pv ON pv.id = x.prior_review_id
         JOIN reviews v ON v.id = x.review_id
         WHERE x.outcome = 'held' AND v.state = 'reported' AND v.ended_at >= ? AND v.ended_at <= ?
           AND pv.state = 'reported' AND pv.ended_at >= ? AND pv.ended_at <= ?
         GROUP BY x.review_id, p.file`,
      )
      .all(since, until, since, until) as { review: number; file: string; n: number }[])
      held.set(`${h.review}\0${h.file}`, h.n);
    const findings = new Map<string, number>();
    for (const r of raised) {
      const carried = Math.min(held.get(`${r.review}\0${r.file}`) ?? 0, r.n);
      findings.set(r.file, (findings.get(r.file) ?? 0) + r.n - carried);
    }
    const touched = new Map(
      (
        this.db
          .prepare(
            `SELECT p.path AS file, COUNT(*) AS touches FROM pr_files p
             JOIN pr_history h ON h.repo_id = p.repo_id AND h.number = p.pr_number
             WHERE h.merged_at >= ? AND h.merged_at <= ? GROUP BY p.path`,
          )
          .all(since, until) as { file: string; touches: number }[]
      ).map((r) => [r.file, r.touches]),
    );
    // Ranked by findings per touch before the cut, so the cut keeps the top of that ranking; a file
    // with no stored touch has no ratio and follows those that do.
    return [...findings]
      .filter(([file]) => !isGeneratedFile(file))
      .map(([file, n]) => ({ file, findings: n, touches: touched.get(file) ?? 0 }))
      .filter((r) => r.findings > 0)
      .sort((a, b) => {
        if (a.touches > 0 !== b.touches > 0) return a.touches > 0 ? -1 : 1;
        const ratio = a.touches > 0 ? b.findings * a.touches - a.findings * b.touches : 0;
        return ratio || b.findings - a.findings || a.file.localeCompare(b.file);
      })
      .slice(0, AUDIT_FINDING_FILES);
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
      verdict: parseJson<QaReviewRoundView["verdict"]>(r.verdict, null as never),
      blocking: r.blocking as number,
      minor: r.minor as number,
      endedAt: r.ended_at as number,
      screenshots: reviewsStore.reviewShots(this.db, r.id as number),
    }));
  }

  /** Records a screenshot RETRO took on a review's preview; `shotId` names its stored PNG. */
  addReviewShot(
    reviewId: number,
    shot: { shotId: string; label: string; width: number; theme: ReviewShotView["theme"] },
    at: number,
  ): void {
    reviewsStore.addReviewShot(this.db, reviewId, shot, at);
  }

  /** The complete paths a PR changes, as GitHub's paged diff listing gave them. */
  prFilePaths(repoId: string, pr: number): string[] {
    return (
      this.db
        .prepare("SELECT path FROM pr_files WHERE repo_id = ? AND pr_number = ? ORDER BY path")
        .all(repoId, pr) as Row[]
    ).map((r) => r.path as string);
  }

  reviewShots(reviewId: number): ReviewShotView[] {
    return reviewsStore.reviewShots(this.db, reviewId);
  }

  reviewChecks(reviewId: number): ReviewCheck[] {
    return reviewsStore.reviewChecks(this.db, reviewId);
  }

  reviewTests(reviewId: number): (Omit<ReportedTest, "file"> & { file: string | null })[] {
    return reviewsStore.reviewTests(this.db, reviewId);
  }

  reviewResolutions(
    reviewId: number,
  ): { reviewId: number; pos: number; outcome: FindingResolution["outcome"] }[] {
    return reviewsStore.reviewResolutions(this.db, reviewId);
  }

  /** The run that performs the review, else null. */
  runOfReview(reviewId: number): Run | null {
    return this.runQ.runOfReview(reviewId);
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
    return this.seatQ.claimLine(key, line);
  }

  /** Frees a key, so its line can be claimed (and sent) again. */
  dropLine(key: string): void {
    this.seatQ.dropLine(key);
  }

  /** The run's claimed line keys, each with the time it was claimed. */
  claimedKeys(runId: string): Record<string, number> {
    return this.seatQ.claimedKeys(runId);
  }

  /** When the engine last sent the run a line, else null. */
  lastEngineLineAt(runId: string): number | null {
    return this.seatQ.lastEngineLineAt(runId);
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
  addComms(
    row: NewCommsRow,
    rate?: { since: number; limit: number },
    /** An identical message stored at or after this time is returned, flagged, not stored again. */
    repeatSince?: number,
    /** Server-resolved title for one internal context line accompanying an operator item send. */
    flightContextTitle?: string,
  ): (CommsRow & { repeat?: true }) | null {
    return this.commsStore.addComms(row, rate, repeatSince, flightContextTitle);
  }

  /** Records that the recipient took a message; the first time wins. */
  markCommsDelivered(id: string, at: number): void {
    this.commsStore.markCommsDelivered(id, at);
  }

  /**
   * Stores the choice unless this brief already has one. Returns the stored row and whether this
   * call made it, so a second click gets the first receipt.
   */
  claimChoice(c: QuestionChoiceRow): { row: QuestionChoiceRow; fresh: boolean } {
    return this.seatQ.claimChoice(c);
  }

  /** Names the message that carries a claimed choice's answer. */
  setChoiceMessage(key: string, briefAt: number, messageId: string): void {
    this.seatQ.setChoiceMessage(key, briefAt, messageId);
  }

  /**
   * Whether a Comms message is the hub-built answer to a choice. A reader that counts messages the
   * operator owes a reply to leaves these out: they answer, they do not ask.
   */
  isChoiceAnswer(messageId: string): boolean {
    return this.seatQ.isChoiceAnswer(messageId);
  }

  /** Drops a claim whose answer could not be sent. */
  releaseChoice(key: string, briefAt: number): void {
    this.seatQ.releaseChoice(key, briefAt);
  }

  /** The choice made on one brief of a key; null when none. */
  choice(key: string, briefAt: number): QuestionChoiceRow | null {
    return this.seatQ.choice(key, briefAt);
  }

  /** The newest choice on a key; null when none. */
  latestChoice(key: string): QuestionChoiceRow | null {
    return this.seatQ.latestChoice(key);
  }

  /** The choices made on a ticket, newest first. */
  choicesOnTicket(ticket: string, limit: number): QuestionChoiceRow[] {
    return this.seatQ.choicesOnTicket(ticket, limit);
  }

  markCommsWakeFailed(id: string, at: number): void {
    this.commsStore.markCommsWakeFailed(id, at);
  }
  clearCommsWakeFailed(id: string): void {
    this.commsStore.clearCommsWakeFailed(id);
  }
  commsWakeFailed(id: string): boolean {
    return this.commsStore.commsWakeFailed(id);
  }

  /** The run and PR the hub stamped on a message; nulls for a message it did not stamp. */
  commsStamp(id: string): { runId: string | null; pr: number | null } {
    return this.commsStore.commsStamp(id);
  }

  commsMessage(id: string): CommsRow | null {
    return this.commsStore.commsMessage(id);
  }

  /** Fixed delivery target, otherwise the sender's run that was open when it wrote the line. */
  commsRun(id: string, inferSender = true): Run | null {
    return this.commsStore.commsRun(id, inferSender);
  }

  addCommsReaction(
    messageId: string,
    actor: string,
    reaction: CommsReactionKind,
    reason: string | undefined,
    at: number,
  ): CommsReaction | null {
    return this.commsStore.addCommsReaction(messageId, actor, reaction, reason, at);
  }

  setCommsPinned(messageId: string, pinned: boolean, actor: string, at: number): boolean {
    return this.commsStore.setCommsPinned(messageId, pinned, actor, at);
  }

  commsPins(): CommsRow[] {
    return this.commsStore.commsPins();
  }
  commsReactionsFor(messageIds: readonly string[]): Map<string, CommsReaction[]> {
    return this.commsStore.commsReactionsFor(messageIds);
  }

  commsReactions(messageId: string): CommsReaction[] {
    return this.commsStore.commsReactions(messageId);
  }
  commsSettlement(messageId: string): CommsSettlement | null {
    return this.commsStore.commsSettlement(messageId);
  }
  settleCommsItem(messageId: string, settledBy: string, reason: string, at: number): boolean {
    return this.commsStore.settleCommsItem(messageId, settledBy, reason, at);
  }
  commsMentions(target: string): CommsRow[] {
    return this.commsStore.commsMentions(target);
  }
  markCommsMentionsSeen(target: string, ids: string[], at: number): void {
    this.commsStore.markCommsMentionsSeen(target, ids, at);
  }
  commsMentionSeen(target: string, id: string): boolean {
    return this.commsStore.commsMentionSeen(target, id);
  }
  commsForCrew(): CommsRow[] {
    return this.commsStore.commsForCrew();
  }
  /** Seat-side reads include only general Comms and rows targeted at its live run. */
  commsForCrewRun(runId: string): CommsRow[] {
    return this.commsStore.commsForCrewRun(runId);
  }
  commsForAgent(id: string, contact?: string): CommsRow[] {
    return this.commsStore.commsForAgent(id, contact);
  }
  commsForAgentRun(id: string, runId: string): CommsRow[] {
    return this.commsStore.commsForAgentRun(id, runId);
  }
  commsInbox(id: string): CommsRow[] {
    return this.commsStore.commsInbox(id);
  }
  commsInboxRun(id: string, runId: string): CommsRow[] {
    return this.commsStore.commsInboxRun(id, runId);
  }
  commsForPair(a: string, b: string): CommsRow[] {
    return this.commsStore.commsForPair(a, b);
  }

  /** Lightweight retained transcript sources; conversation paging is not limited to recent runs. */
  flightConversationRuns(
    agentId: string,
  ): Pick<Run, "id" | "startedAt" | "endedAt" | "transcriptPath" | "vendor" | "ticket">[] {
    return this.runQ.flightConversationRuns(agentId);
  }

  /** A choice is projected from its durable receipt, never inferred from its rendered text. */
  flightConversationStored(
    flightId: string,
    seats: readonly string[],
    limit: number,
    before?: { at: number; id: number },
    exactId?: string,
    hideNotices = false,
  ): (CommsRow & { choice?: { label: string } })[] {
    return this.commsStore.flightConversationStored(
      flightId,
      seats,
      limit,
      before,
      exactId,
      hideNotices,
    );
  }

  latestFlightStoredReplyAt(flightId: string): number | null {
    return this.commsStore.latestFlightStoredReplyAt(flightId);
  }

  flightOperatorMessageTimes(flightId: string): number[] {
    return this.commsStore.flightOperatorMessageTimes(flightId);
  }

  flightConversationUnread(
    flightId: string,
    seats: readonly string[],
    cursor: string | null,
    bound?: { at: number; source: string; offset: number },
  ): number {
    return this.commsStore.flightConversationUnread(flightId, seats, cursor, bound);
  }

  flightConversationStoredReadThrough(
    flightId: string,
    seats: readonly string[],
    bound: { at: number; source: string; offset: number },
  ): number | null {
    return this.commsStore.flightConversationStoredReadThrough(flightId, seats, bound);
  }
  /**
   * The newest `limit` messages of a scope, oldest first, strictly older than `before` when given.
   * `hasMore` says older ones remain, so the HUD can offer "load older".
   */
  commsPage(
    scope: CommsReadScope,
    limit: number,
    before?: string,
    recentSince?: number,
    hideNotices = false,
  ): { rows: CommsRow[]; hasMore: boolean } {
    return this.commsStore.commsPage(scope, limit, before, recentSince, hideNotices);
  }
  /** How many messages a scope holds, and how many of them come after the read cursor. */
  commsCounts(
    scope: CommsReadScope,
    cursor: string | null,
    recentSince?: number,
    hideNotices = false,
  ): { count: number; unread: number } {
    return this.commsStore.commsCounts(scope, cursor, recentSince, hideNotices);
  }
  /** Everyone `id` has exchanged messages with, in first-contact order. */
  commsContactIds(id: string): string[] {
    return this.commsStore.commsContactIds(id);
  }
  commsForRefs(refs: string[]): CommsRow[] {
    return this.commsStore.commsForRefs(refs);
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
    return this.commsStore.commsForTicket(ref, ticketContext);
  }
  /**
   * Direct-link counts since `since`, each with its newest message (id, time and the first
   * COMMS_LINK_PREVIEW characters) so the Comms graph can show it and spot a new one.
   */
  commsLinkCounts(since: number, until = Date.now()): CommsLinkCount[] {
    return this.commsStore.commsLinkCounts(since, until);
  }
  /** Hourly direct-link counts for the Comms Traffic chart. */
  commsHourlyLinkCounts(
    since: number,
  ): { hour: number; from: string; to: string; count: number }[] {
    return this.commsStore.commsHourlyLinkCounts(since);
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
    return this.commsStore.commsChatter(since, until, flightId);
  }

  /**
   * When a note's unbroken run began (its open run, or its last one once cleared): a note raised
   * again within a minute of clearing (a held Update re-raised as main moves) is the same item to
   * the operator, so its conversation stays; an earlier run's does not carry over. Read from the
   * episodes, since a refresh moves the note's own time forward. 0 for a key never raised.
   */
  noteRunStart(noteKey: string): number {
    return attention.noteRunStart(this.db, noteKey);
  }

  /** An item's conversation since its current run (`noteRunStart` for a note key, else all). */
  itemThreadNow(itemKey: string): (CommsRow & { choice?: string })[] {
    return this.itemThread(
      itemKey,
      itemKey.startsWith("note:") ? this.noteRunStart(itemKey.slice("note:".length)) : 0,
    );
  }

  /**
   * One Needs-you item's conversation since `since` (the item's own raising: a note key is reused),
   * oldest first: the messages sent from it and every reply in it (a reply inherits its message's
   * item). The hub's own context lines and notices stay out; a picked option carries its label.
   */
  itemThread(itemKey: string, since = 0, limit = 100): (CommsRow & { choice?: string })[] {
    return this.commsStore.itemThread(itemKey, since, limit);
  }

  /** Labelled direct questions and blockers still awaiting their addressee's reply or reaction. */
  openCommsItems(): (CommsRow & { label: "question" | "blocker" })[] {
    return this.commsStore.openCommsItems();
  }
  /** The newest `limit` messages with an id above `sinceId`, newest first; text cut to `textMax`. */
  commsFeed(
    sinceId: number,
    limit: number,
    textMax: number,
  ): Pick<CommsRow, "id" | "at" | "from" | "to" | "label" | "ref" | "text" | "senderKind">[] {
    return this.commsStore.commsFeed(sinceId, limit, textMax);
  }
  markCommsScopeRead(scope: string, messageId: string): void {
    this.commsStore.markCommsScopeRead(scope, messageId);
  }
  commsScopeCursor(scope: string): string | null {
    return this.commsStore.commsScopeCursor(scope);
  }
  /** Seat delivery receipts, deliberately separate from the operator's UI cursor. */
  commsInboxRead(seatId: string, messageId: string): boolean {
    return this.commsStore.commsInboxRead(seatId, messageId);
  }
  /** Ids of messages `from` sent `to` at or after `since` that `to` has not read, oldest first. */
  unreadCommsFrom(from: string, to: string, since: number): string[] {
    return this.commsStore.unreadCommsFrom(from, to, since);
  }
  /**
   * Ids of messages `from` sent `to` at or after `since` that `to` has read and not answered (no
   * message from `to` carries `replyTo` naming it, `to` has not reacted to it, and it is not
   * settled: the same closes an open Comms item), oldest first.
   */
  owedCommsFrom(from: string, to: string, since: number): string[] {
    return this.commsStore.owedCommsFrom(from, to, since);
  }
  markCommsInboxRead(seatId: string, messageIds: readonly string[], at = Date.now()): void {
    this.commsStore.markCommsInboxRead(seatId, messageIds, at);
  }

  /** The hand-offs at or after `since`, oldest first. */
  comms(since: number, targetRunId?: string): CommsRow[] {
    return this.commsStore.comms(since, targetRunId);
  }

  /** Messages to `to` at or after `since`, with their label: the times FLIGHT's callers began to wait. */
  commsTo(to: string, since: number): { at: number; from: string; label: string | null }[] {
    return this.commsStore.commsTo(to, since);
  }

  /** How many hand-offs `from` sent `to` at or after `since`. */
  commsCountTo(from: string, to: string, since: number): number {
    return this.commsStore.commsCountTo(from, to, since);
  }

  /** Stable stored message IDs for one thread, in insertion order. */
  threadComms(id: string, after = 0): (CommsRow & { id: string })[] {
    return this.commsStore.threadComms(id, after);
  }

  /** Prompt metadata remains available even after its body has been read. */
  threadPrompt(id: string): { id: string; at: number } | undefined {
    return this.commsStore.threadPrompt(id);
  }

  /** Progress evidence does not need message bodies. */
  commsEvidence(since: number): Pick<CommsRow, "at" | "from" | "ticket">[] {
    return this.commsStore.commsEvidence(since);
  }

  threadReadCursors(id: string): Map<string, { offset: number; block: number }> {
    return this.commsStore.threadReadCursors(id);
  }

  /** Validates ownership without re-reading a transcript window that may have moved on. */
  threadOwnsMessage(id: string, messageId: string): boolean {
    return this.commsStore.threadOwnsMessage(id, messageId);
  }

  /** Advance only through the opened snapshot, atomically; stale reads never move backwards. */
  markThreadRead(id: string, messageIds: string[]): void {
    this.commsStore.markThreadRead(id, messageIds);
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
    this.seatQ.replaceQueues(queues);
  }

  /** The seat's queue in order, taken row first. */
  queue(seatId: string): QueueRow[] {
    return this.seatQ.queue(seatId);
  }

  /**
   * Takes the head of the seat's queue, stamped `at`; null when the queue is empty or the seat
   * already holds a row. Under the write lock, so two processes are granted one between them.
   * `between` is a test seam: it runs after the head is read and before it is stamped.
   */
  takeQueued(seatId: string, at: number, between?: () => void): QueueRow | null {
    return this.seatQ.takeQueued(seatId, at, between);
  }

  /** Gives a taken row back to the queue. */
  untake(seatId: string, repoId: RepoId, issue: number): void {
    this.seatQ.untake(seatId, repoId, issue);
  }

  dropQueued(seatId: string, repoId: RepoId, issue: number): void {
    this.seatQ.dropQueued(seatId, repoId, issue);
  }

  /** Rows taken before `before` (a take whose run never began), oldest first. */
  staleTakes(before: number): QueueRow[] {
    return this.seatQ.staleTakes(before);
  }

  /**
   * Opens the note. One already open is left as it is; a cleared one is re-opened with the new
   * text and time. A re-opened note is no longer dismissed.
   */
  raiseNote(n: NoteInput): void {
    attention.raiseNote(this.db, n);
  }

  /** Updates one open operator item in place, keeping its key and history. */
  refreshNote(n: NoteInput): void {
    attention.refreshNote(this.db, n);
  }

  /** Refresh measured details without restarting or unacknowledging an open episode. */
  refreshNoteInEpisode(n: NoteInput): void {
    attention.refreshNoteInEpisode(this.db, n);
  }

  clearNote(key: string, at: number): void {
    attention.clearNote(this.db, key, at);
  }

  clearNotesFor(runId: string, at: number): void {
    attention.clearNotesFor(this.db, runId, at);
  }

  /** Dismisses an open note of any kind from Needs you; false when there is no such note. */
  dismissNote(key: string, at: number): boolean {
    return attention.dismissNote(this.db, key, at);
  }

  /** The open notes, oldest first. */
  notes(): AttentionNote[] {
    return attention.notes(this.db);
  }

  /** Historical waits, including cleared notes; only the named seat's evidence counts. */
  telemetryNoteIntervals(
    seatId: string,
    since: number,
    now: number,
    kinds: string[],
  ): [number, number][] {
    return attention.telemetryNoteIntervals(this.db, seatId, since, now, kinds);
  }

  /** Like telemetryNoteIntervals, each episode with the run its note belongs to. */
  telemetryNoteEpisodes(seatId: string, since: number, now: number, kinds: string[]) {
    return attention.telemetryNoteEpisodes(this.db, seatId, since, now, kinds);
  }

  openNoteKeys(runId: string): string[] {
    return attention.openNoteKeys(this.db, runId);
  }

  seatSession(seatId: string): SeatSessionRow | null {
    return this.seatQ.seatSession(seatId);
  }

  /** Seat sessions for the configured HUD rows, indexed after one table read. */
  seatSessions(seatIds: readonly AgentId[]): Map<AgentId, SeatSessionRow> {
    return this.seatQ.seatSessions(seatIds);
  }

  setSeatSession(row: SeatSessionRow): void {
    this.seatQ.setSeatSession(row);
  }

  /**
   * Records that the seat's turn ended at `at`; null: no turn of the seat's current run has. A turn
   * that made no commit since the one before it adds to the seat's quiet turns; a commit clears them.
   */
  setSeatTurnEnded(seatId: string, at: number | null): void {
    const row = this.db
      .prepare("SELECT run_id, last_turn_ended_at FROM seat_sessions WHERE seat_id = ?")
      .get(seatId) as { run_id: string | null; last_turn_ended_at: number | null } | undefined;
    const newest = row?.run_id ? this.newestAuthoredCommit(row.run_id) : null;
    const committed = newest !== null && newest.at > (row?.last_turn_ended_at ?? 0);
    this.db
      .prepare(
        "UPDATE seat_sessions SET last_turn_ended_at = ?, quiet_turns = CASE WHEN ? THEN 0 ELSE quiet_turns + 1 END WHERE seat_id = ?",
      )
      .run(at, at === null || committed ? 1 : 0, seatId);
  }

  /** Records that the seat started a turn at `at`. */
  setSeatTurnStarted(seatId: string, at: number): void {
    this.seatQ.setSeatTurnStarted(seatId, at);
  }

  /** Commits the crew authored since `since` (followed ones left out), per agent, joined to their runs. */
  commitsSince(since: number): { agentId: AgentId; n: number }[] {
    const rows = this.db
      .prepare(`SELECT r.agent_id, COUNT(*) AS n FROM run_commits c
      JOIN runs r ON r.id = c.run_id WHERE c.at >= ? AND c.followed = 0 GROUP BY r.agent_id ORDER BY r.agent_id`)
      .all(since) as Row[];
    return rows.map((r) => ({ agentId: r.agent_id as string, n: r.n as number }));
  }

  /** How long each cleared attention note of `kinds` raised since `since` stood open. */
  noteWaits(kinds: string[], since: number): number[] {
    return attention.noteWaits(this.db, kinds, since);
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

  qaCheckReceipts(
    runId: string,
    headSha: string,
  ): {
    command: string;
    ok: boolean | null;
    exitCode: number | null;
    at: number;
    evidence: string;
  }[] {
    const checks = (
      this.db
        .prepare(`SELECT invoked_command, ok, exit_code, at FROM check_runs
      WHERE run_id = ? AND head_sha = ? ORDER BY at DESC, id DESC LIMIT 100`)
        .all(runId, headSha) as Row[]
    ).map((row) => ({
      command: row.invoked_command as string,
      ok: row.ok === 1,
      exitCode: row.exit_code as number | null,
      at: row.at as number,
      evidence: `Hub check recorder observed command completion at exact head ${headSha}. Counts were not parsed.`,
    }));
    const locks =
      this.reviewOfRun(runId)?.sha === headSha
        ? (this.db
            .prepare(`SELECT command, started_at, ended_at, outcome
      FROM test_lock_runs WHERE run_id = ? AND ended_at IS NOT NULL AND outcome IN ('pass', 'fail', 'done')
      ORDER BY ended_at DESC, id DESC LIMIT 100`)
            .all(runId) as Row[])
        : [];
    return [
      ...checks,
      ...locks
        .filter((row) => !checks.some((check) => check.command === row.command))
        .map((row) => ({
          command: row.command as string,
          ok: null,
          exitCode: null,
          at: row.ended_at as number,
          evidence: `Hub observed this locked tool invocation in review run ${runId}, reviewing ${headSha}, from ${row.started_at} to ${row.ended_at} (tool ${row.outcome}). Numeric process exit, test counts and scratch source cleanliness were not recorded.`,
        })),
    ].slice(0, 100);
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
  /** The run's hold lasts until it ends: a restart restores it as such. */
  pinLockHolds(runId: string): void {
    this.db.prepare("UPDATE test_lock_holds SET pinned = 1 WHERE run_id = ?").run(runId);
  }

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
    return rows.map(toCiRun);
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
      ...(r.pinned === 1 ? { pinned: true } : {}),
    }));
  }

  /** Sessions that hold a run and are not stopped or in error. */
  activeSeatSessions(): SeatSessionRow[] {
    return this.seatQ.activeSeatSessions();
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

  /** How many refusals each of `runIds` has had, in one query; a run with none is absent. */
  guardHitCountsByRun(runIds: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>();
    const batchSize = 400;
    for (let start = 0; start < runIds.length; start += batchSize) {
      const batch = runIds.slice(start, start + batchSize);
      const rows = this.db
        .prepare(
          `SELECT run_id, COUNT(*) AS n FROM guard_hits
           WHERE run_id IN (${batch.map(() => "?").join(",")}) GROUP BY run_id`,
        )
        .all(...batch) as { run_id: string; n: number }[];
      for (const r of rows) counts.set(r.run_id, r.n);
    }
    return counts;
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
    /** Someone else's commit the run follows: not one Mission Control or the seat made. */
    followed?: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO run_commits (run_id, repo_id, branch, sha, at, followed) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, sha) DO NOTHING`,
      )
      .run(c.runId, c.repoId, c.branch, c.sha, c.at, c.followed === true ? 1 : 0);
  }

  commitLines(sha: string): { additions: number | null; deletions: number | null } | null {
    return (
      (this.db.prepare("SELECT additions, deletions FROM commit_lines WHERE sha = ?").get(sha) as
        | { additions: number | null; deletions: number | null }
        | undefined) ?? null
    );
  }

  /** Cached line counts for several commit hashes, read in one query. */
  commitLinesFor(
    shas: readonly string[],
  ): Map<string, { additions: number | null; deletions: number | null }> {
    const unique = [...new Set(shas)];
    if (unique.length === 0) return new Map();
    const marks = unique.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT sha, additions, deletions FROM commit_lines WHERE sha IN (${marks})`)
      .all(...unique) as { sha: string; additions: number | null; deletions: number | null }[];
    return new Map(
      rows.map((row) => [row.sha, { additions: row.additions, deletions: row.deletions }]),
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
         WHERE c.at >= ? AND c.at <= ? AND c.followed = 0 AND c.id = (
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

  /** Every commit the commit tool made on a branch, oldest first. */
  commitsOnBranch(repoId: RepoId, branch: string): { sha: string; at: number }[] {
    return (
      this.db
        .prepare(
          "SELECT sha, at FROM run_commits WHERE repo_id = ? AND branch = ? AND followed = 0 ORDER BY at, id",
        )
        .all(repoId, branch) as { sha: string; at: number }[]
    ).map((r) => ({ sha: r.sha, at: r.at }));
  }

  /** The newest `limit` messages `from` sent about one run, newest first. */
  commsFromToRun(from: string, runId: string, limit: number): CommsRow[] {
    return this.commsStore.commsFromToRun(from, runId, limit);
  }

  /** The commits the commit tool made for a run, in the order it made them. */
  runCommits(runId: string): string[] {
    const rows = this.db
      .prepare("SELECT sha FROM run_commits WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as { sha: string }[];
    return rows.map((r) => r.sha);
  }

  /** How many commits the run itself made (followed ones left out). */
  authoredCommitCount(runId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM run_commits WHERE run_id = ? AND followed = 0")
      .get(runId) as { n: number };
    return r.n;
  }

  /** The run's commits that someone else made and the run only follows (see `addRunCommit`). */
  followedCommits(runId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT sha FROM run_commits WHERE run_id = ? AND followed = 1")
      .all(runId) as { sha: string }[];
    return new Set(rows.map((r) => r.sha));
  }

  /** The commits the commit tool made at or after `since`, oldest first, with their run's agent and ticket. */
  runCommitsSince(
    since: number,
  ): { runId: string; agentId: AgentId; sha: string; at: number; ticket: string | null }[] {
    const rows = this.db
      .prepare(`SELECT c.run_id, r.agent_id, c.sha, c.at, r.ticket FROM run_commits c
      JOIN runs r ON r.id = c.run_id WHERE c.at >= ? AND c.followed = 0 ORDER BY c.at, c.id`)
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

  /** The run's newest commit that it made itself (followed ones left out), else null. */
  newestAuthoredCommit(runId: string): { sha: string; at: number } | null {
    const r = this.db
      .prepare(
        "SELECT sha, at FROM run_commits WHERE run_id = ? AND followed = 0 ORDER BY id DESC LIMIT 1",
      )
      .get(runId) as { sha: string; at: number } | undefined;
    return r ? { sha: r.sha, at: r.at } : null;
  }

  /**
   * Every commit any run made on `branch`: a later run on the same ticket reuses the branch, and
   * the earlier run's unpushed commits still count as the hub's.
   */
  branchCommits(repoId: RepoId, branch: string): Set<string> {
    const rows = this.db
      .prepare("SELECT sha FROM run_commits WHERE repo_id = ? AND branch = ? AND followed = 0")
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

  /**
   * The run takes someone else's commit on top of its push as its own push, in one transaction:
   * the commit (followed, so the merge gate still treats it as from outside the run), the push, a
   * loop event and a FLIGHT decision that records the hub took it in. Once per run and sha.
   */
  adoptFollowedHead(a: {
    runId: string;
    repoId: RepoId;
    branch: string;
    sha: string;
    at: number;
    ticket: string | null;
    eventKey: string;
    eventText: string;
  }): void {
    this.transaction(() => {
      this.addRunCommit({
        runId: a.runId,
        repoId: a.repoId,
        branch: a.branch,
        sha: a.sha,
        at: a.at,
        followed: true,
      });
      this.setRunPush({ runId: a.runId, sha: a.sha, at: a.at });
      if (!this.addLoopEvent(a.eventKey, a.runId, a.eventText, a.at)) return;
      this.addFlightDecision({
        at: a.at,
        kind: "settle",
        // the hub's own call: no seat made it
        seatId: null,
        targetRunId: a.runId,
        ref: a.ticket,
        questionId: null,
        about: "followed commit",
        decision: a.eventText,
        basis:
          "The commit was taken as the run's push, so it does not park the run as stuck; the merge gate still counts it as outside the run's own commits.",
      });
    });
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

  /** Records a seat's question; returns its id. */
  addQuestion(q: Omit<SeatQuestion, "id" | "passedAt" | "asideAt">): number {
    return this.seatQ.addQuestion(q);
  }

  /** When the seat asked its questions, answered or not (ask_flight mirrors each to Comms). */
  questionTimes(agentId: AgentId): Set<number> {
    return this.seatQ.questionTimes(agentId);
  }

  /**
   * The questions seats asked on a ticket that FLIGHT answered, with the answer it recorded,
   * newest first. Every run on the ticket starts with these, so a decision is not asked twice.
   */
  answeredQuestionsOn(
    ticket: string,
    limit: number,
  ): { id: number; question: string; answer: string; at: number }[] {
    const rows = this.db
      .prepare(
        `SELECT q.id, q.text AS question, d.decision AS answer, d.at AS at
         FROM seat_questions q
         JOIN runs r ON r.id = q.run_id
         JOIN flight_decisions d ON d.question_id = q.id AND d.kind = 'answer'
         WHERE r.ticket = ? AND (q.answered_at IS NOT NULL OR q.aside_at IS NOT NULL)
         ORDER BY d.at DESC, d.id DESC LIMIT ?`,
      )
      .all(ticket, limit) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      question: r.question as string,
      answer: r.answer as string,
      at: r.at as number,
    }));
  }

  /** Questions not yet answered and not set aside, oldest first: the ones that wait in Needs you. */
  openQuestions(): SeatQuestion[] {
    return this.seatQ.openQuestions();
  }

  /** Questions the operator set aside with Not now and nobody has answered, oldest first. */
  asideQuestions(): SeatQuestion[] {
    return this.seatQ.asideQuestions();
  }

  /** The seat's questions open at any time in [from, to), oldest first. */
  questionsOverlapping(
    agentId: AgentId,
    from: number,
    to: number,
  ): { at: number; answeredAt: number | null }[] {
    return this.seatQ.questionsOverlapping(agentId, from, to);
  }

  /** One question by id, answered or not; null when there is none. */
  question(id: number): (SeatQuestion & { answeredAt: number | null }) | null {
    return this.seatQ.question(id);
  }

  /** Sets an open question aside (Not now); true only when it was open and not yet set aside. */
  setQuestionAside(id: number, at: number): boolean {
    return this.seatQ.setQuestionAside(id, at);
  }

  /** Puts a set-aside question back in Needs you, for a Not now whose GitHub writes failed. */
  clearQuestionAside(id: number): boolean {
    return this.seatQ.clearQuestionAside(id);
  }

  /** Marks an open question passed to the operator; true only when it was open and not yet passed. */
  passQuestion(id: number, at: number): boolean {
    return this.seatQ.passQuestion(id, at);
  }

  /**
   * Hands a passed, still open question back to FLIGHT (#758): FLIGHT kept it, or it was passed
   * without a brief before #758. True only when it was passed.
   */
  unpassQuestion(id: number): boolean {
    return this.seatQ.unpassQuestion(id);
  }

  /** Marks one open question answered at `at`. */
  answerQuestion(id: number, at: number): void {
    this.seatQ.answerQuestion(id, at);
  }

  /**
   * Marks every open question of the seat answered at `at`; with `unpassedOnly`, leaves the ones
   * passed to the operator open.
   */
  answerQuestions(agentId: AgentId, at: number, unpassedOnly = false): void {
    this.seatQ.answerQuestions(agentId, at, unpassedOnly);
  }

  /**
   * Marks every open question of one run answered at `at`; with `unpassedOnly`, leaves the ones
   * passed to the operator open. Another run of the same seat keeps its own questions.
   */
  answerRunQuestions(runId: string, at: number, unpassedOnly = false): void {
    this.seatQ.answerRunQuestions(runId, at, unpassedOnly);
  }

  /**
   * Records that a question left Needs you without an answer. False, storing nothing, when this ask
   * was closed already. Closing an `ask:` key also answers its question, so the seat's run no
   * longer waits on it.
   */
  closeQuestion(c: QuestionClosure): boolean {
    return this.seatQ.closeQuestion(c);
  }

  /** Operator Clear closes the displayed source and records its closure in the same transaction. */
  clearAttention(c: QuestionClosure, notices: NewCommsRow[] = []): boolean {
    let stored = false;
    this.transaction(() => {
      stored = this.insertClosure(c);
      if (!stored) return;
      if (c.key.startsWith("note:")) this.dismissNote(c.key.slice("note:".length), c.at);
      else if (c.key.startsWith(COMMS_OPEN_PREFIX))
        this.settleCommsItem(c.key.slice(COMMS_OPEN_PREFIX.length), c.by, c.reason, c.at);
      this.db
        .prepare(`INSERT INTO acks (key, at, absent_since) VALUES (?, ?, NULL)
        ON CONFLICT(key) DO UPDATE SET at = excluded.at`)
        .run(c.key, c.at);
      for (const notice of notices) this.insertComms(notice, cutCommsText(notice.text), null);
    }, true);
    return stored;
  }

  /** Hide only FLIGHT's latest brief; retain its history and the underlying question or hold. */
  withdrawFlightBrief(key: string): boolean {
    let withdrawn = false;
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT id, structured FROM briefs WHERE key = ? ORDER BY id DESC LIMIT 1")
        .get(key) as Row | undefined;
      if (
        !row?.structured ||
        parseJson<Partial<AttentionBrief>>(row.structured, {}).by !== "flight"
      )
        return;
      this.setSetting(`withdrawn-brief:${key}`, String(row.id));
      withdrawn = true;
    }, true);
    return withdrawn;
  }

  /** `closeQuestion` without its own transaction, for a caller already in one. */
  private insertClosure(c: QuestionClosure): boolean {
    return this.seatQ.insertClosure(c);
  }

  /** The closure of one ask of a key; null when it was not closed without an answer. */
  questionClosure(key: string, askAt: number): QuestionClosure | null {
    return this.seatQ.questionClosure(key, askAt);
  }

  /**
   * The closures of items that stay in the attention list until routed away (not a seat's `ask:`
   * question, which leaves when answered), by key, newest first; read once per build.
   */
  closedItemKeys(): Map<string, QuestionClosure[]> {
    return this.seatQ.closedItemKeys();
  }

  /** The closures the operator had in Needs you since `since`, newest first. */
  questionClosures(since: number, limit: number): QuestionClosure[] {
    return this.seatQ.questionClosures(since, limit);
  }

  /** Whether FLIGHT's newest brief on the key is for the operator. */
  private briefedForOperator(key: string): boolean {
    const r = this.db
      .prepare("SELECT structured FROM briefs WHERE key = ? ORDER BY id DESC LIMIT 1")
      .get(key) as { structured: string | null } | undefined;
    return (
      r?.structured != null &&
      parseJson<Partial<AttentionBrief>>(r.structured, {}).for === "operator"
    );
  }

  private endQuestions(where: "run_id" | "agent_id", id: string, at: number): void {
    this.transaction(() => {
      for (const q of this.seatQ.openQuestionsOf(where, id)) {
        const key = `ask:${q.id}`;
        this.insertClosure({
          key,
          askAt: q.at,
          kind: "run-ended",
          reason: ASKING_RUN_ENDED_REASON,
          by: "hub",
          question: q.text,
          ticket: this.run(q.runId)?.ticket ?? null,
          operator: q.passedAt !== null && this.briefedForOperator(key),
          at,
        });
      }
    });
  }

  /** The asking run has ended: each of its open questions closes, with that reason. */
  endRunQuestions(runId: string, at: number): void {
    this.endQuestions("run_id", runId, at);
  }

  /** The seat has no run now: each of its open questions closes, with that reason. */
  endSeatQuestions(agentId: AgentId, at: number): void {
    this.endQuestions("agent_id", agentId, at);
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
    return row?.source
      ? {
          ...parseJson<{ itemKey: string; replyId: string; source: PersonSource }>(
            row.source,
            {} as never,
          ),
          state: row.state as string,
        }
      : null;
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
      ...parseJson<object>(metadata, {}),
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
    this.flightQ.setFlightPlans(session, operation, at);
  }

  private prepareFlightPlans(
    session: string,
    operation: FlightPlanOperation,
    at: number,
  ): () => void {
    return this.flightQ.prepareFlightPlans(session, operation, at);
  }

  /** Stores a FLIGHT wake on the run it woke, with the fact categories that caused it. */
  addFlightWake(runId: string, at: number, reasons: string[], wakeId?: string): void {
    this.flightQ.addFlightWake(runId, at, reasons, wakeId);
  }

  /** The id of the run's latest wake; null when it has none or none was given an id. */
  latestFlightWakeId(runId: string): string | null {
    return this.flightQ.latestFlightWakeId(runId);
  }

  /** FLIGHT's wakes at or after `since`, oldest first. */
  flightWakes(since: number): FlightWakeRecord[] {
    return this.flightQ.flightWakes(since);
  }

  flightPlans(session: string): (FlightPlanInput & { createdAt: number })[] {
    return this.flightQ.flightPlans(session);
  }

  setFlightWatch(session: string, operation: FlightWatchOperation, at: number): void {
    this.flightQ.setFlightWatch(session, operation, at);
  }

  private prepareFlightWatch(
    session: string,
    operation: FlightWatchOperation,
    at: number,
  ): () => void {
    return this.flightQ.prepareFlightWatch(session, operation, at);
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
    return this.flightQ.flightWatch(session);
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
      entry.source === "Board" ? (this.boardCardOf(entry.arrivalId) ?? undefined) : undefined;
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
      ? parseJson<FlightArrivalDisposition | null>(previous.entry, null)
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
    return this.flightQ.flightIncoming();
  }

  /**
   * Records the operator's answer to a set-aside question where every later run on its ticket reads
   * it (`answeredQuestionsOn`). A repeat for the same question replaces the earlier text.
   */
  recordSetAsideAnswer(d: {
    at: number;
    seatId: AgentId;
    questionId: number;
    ref: string;
    about: string;
    decision: string;
  }): void {
    this.flightQ.recordSetAsideAnswer(d);
  }

  /** Records one of FLIGHT's decisions; returns its id. */
  addFlightDecision(d: Omit<FlightDecision, "id">): number {
    return this.flightQ.addFlightDecision(d);
  }

  /** FLIGHT's decisions at or after `since`, newest first. */
  flightDecisions(since: number, limit: number): FlightDecision[] {
    return this.flightQ.flightDecisions(since, limit);
  }

  /** The decisions of one kind about one ticket, newest first. */
  flightDecisionsAbout(kind: FlightDecisionKind, ref: string): FlightDecision[] {
    return this.flightQ.flightDecisionsAbout(kind, ref);
  }

  /** Replaces one section of a session's brief. */
  setFlightBriefSection(r: FlightBriefRow): void {
    this.flightQ.setFlightBriefSection(r);
  }

  /** Lasting notes for one repo, in topic order. */
  flightMemory(repo: string): FlightMemoryNote[] {
    return this.flightQ.flightMemory(repo);
  }

  /** The state index never reads note bodies. */
  flightMemoryTitles(repo: string): FlightMemoryTitle[] {
    return this.flightQ.flightMemoryTitles(repo);
  }

  putFlightMemory(note: FlightMemoryNote): void {
    this.flightQ.putFlightMemory(note);
  }

  deleteFlightMemory(repo: string, topic: string): boolean {
    return this.flightQ.deleteFlightMemory(repo, topic);
  }

  /** The full ledger for one crew session, including retained closed entries. */
  flightLedger(session: string): FlightLedgerEntry[] {
    return this.flightQ.flightLedger(session);
  }

  /** Marks every pointer at `kind` and `target`, in any entry, as changed at `at`. */
  markFlightPointers(kind: FlightPointerKind, target: string, change: string, at: number): void {
    this.flightQ.markFlightPointers(kind, target, change, at);
  }

  /** The pointers of open entries whose target changed after FLIGHT last read them. */
  movedFlightPointers(session: string): FlightMovedPointer[] {
    return this.flightQ.movedFlightPointers(session);
  }

  /**
   * FLIGHT has read the pointers in `moved` at `at`. A pointer marked again since (another time or
   * text) stays unread; changes are ordered by a counter, not by `at`, whose clock is the poll's.
   */
  markFlightPointersRead(session: string, moved: readonly FlightMovedPointer[], at: number): void {
    this.flightQ.markFlightPointersRead(session, moved, at);
  }

  /** Save an entry and prune old closed entries across all sessions, in one transaction. */
  putFlightLedgerEntry(session: string, entry: FlightLedgerEntry, pruneBefore: number): void {
    this.flightQ.putFlightLedgerEntry(session, entry, pruneBefore);
  }

  /** The stored sections of a session's brief. */
  flightBrief(sessionId: string): FlightBriefRow[] {
    return this.flightQ.flightBrief(sessionId);
  }

  /** Stores FLIGHT's brief on an attention key; returns its id. */
  addBrief(b: AttentionBrief & { key: string; defaultEligible?: boolean }): number {
    let id = 0;
    this.transaction(() => {
      id = this.writeBrief(b);
    });
    return id;
  }

  /** Source handoff, audit and the prepared brief commit together or not at all. */
  addPreparedBrief(
    makeBrief: () => AttentionBrief & { key: string; defaultEligible?: boolean },
    handoff: () => void,
  ): number {
    let id = 0;
    this.transaction(() => {
      handoff();
      id = this.writeBrief(makeBrief());
    }, true);
    return id;
  }

  /** A hub-produced queue proposal and its validated brief become visible atomically. */
  addQueueReorderBrief(
    key: string,
    proposal: string,
    note: NoteInput,
    makeBrief: () => AttentionBrief,
  ): number {
    let id = 0;
    this.transaction(() => {
      this.setSetting(key, proposal);
      this.raiseNote(note);
      id = this.writeBrief({ ...makeBrief(), key: `note:${key}`, defaultEligible: false });
    }, true);
    return id;
  }

  private writeBrief(b: AttentionBrief & { key: string; defaultEligible?: boolean }): number {
    let id = 0;
    {
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
      // Read-model identities and receipts are derived, never producer-owned persisted content.
      delete structured.id;
      delete structured.state;
      delete structured.choice;
      // A rebrief with the same ask (for the same reader) keeps when that ask began; a new or
      // changed ask begins at its own `at`, so it carries no askAt.
      delete structured.askAt;
      const last = this.db
        .prepare("SELECT at, structured FROM briefs WHERE key = ? ORDER BY id DESC LIMIT 1")
        .get(key) as { at: number; structured: string | null } | undefined;
      const prior: AttentionBrief | null = last?.structured
        ? parseJson<AttentionBrief | null>(last.structured, null)
        : null;
      if (
        last !== undefined &&
        prior?.for === structured.for &&
        (structured.binding
          ? structured.binding.epoch === prior?.binding?.epoch
          : prior?.ask === structured.ask)
      )
        structured.askAt = prior?.askAt ?? last.at;
      // No timed default on a question to the operator (#1532): a brief never stores one.
      delete structured.defaultAt;
      const eligibleBinding = structured.binding?.actions.some(
        (action) => action.optionId === structured.recommendedOptionId && action.defaultable,
      );
      if (
        defaultEligible &&
        eligibleBinding &&
        !structured.decision?.whyOperator &&
        structured.for !== "flight" &&
        structured.recommendedOptionId
      ) {
        const kept =
          structured.binding?.epoch === prior?.binding?.epoch ? prior?.defaultAt : undefined;
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
      if (structured.binding && structured.binding.epochId === 0) {
        structured.binding = { ...structured.binding, epochId: id };
        this.db
          .prepare("UPDATE briefs SET structured = ? WHERE id = ?")
          .run(JSON.stringify(structured), id);
      }
    }
    return id;
  }

  /** The newest brief on each attention key. */
  briefs(): Map<string, AttentionBrief> {
    const rows = this.db
      .prepare(`SELECT b.* FROM briefs b WHERE b.id IN (SELECT MAX(id) FROM briefs GROUP BY key)
        AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = 'withdrawn-brief:' || b.key AND s.value = CAST(b.id AS TEXT))`)
      .all() as Row[];
    return new Map(
      rows
        .filter((r) => {
          const person = r.structured
            ? parseJson<Partial<AttentionBrief>>(r.structured, {}).person
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
            ...parseJson<object>(r.structured, {}),
            id: r.id as number,
            context: r.context as string,
            recommendation: r.recommendation as string,
            options: parseJson<BriefOption[]>(r.options, []),
            basis: r.basis as string,
            at: r.at as number,
          },
        ]),
    );
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
    return this.flightQ.countFlightDecisions(q);
  }
}
