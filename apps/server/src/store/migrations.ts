import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { COMMS_NOTICE, FLIGHT_WAKE_STORED_BYTES, inferTicket, TITLE_MARKERS } from "@mc/core";
import { compactFlightWake } from "./rows.ts";

type Row = Record<string, SQLInputValue>;

/** `PRAGMA user_version` once the usage_samples dedupe and its unique index are in place. */
const USAGE_DEDUPE_VERSION = 1;
export const DIGEST_CONTEXT_WINDOW_SQL =
  "CASE WHEN json_valid(digest) THEN json_extract(digest, '$.contextWindow') END";

/** Tables an older release made and this one does not use; an existing database drops them. */
const RETIRED_TABLES = [
  "run_handoffs",
  "ticket_waits",
  "holds",
  "run_reads",
  "run_rereads",
  // the code-health, Map, token-audit and bug-escape features
  "map_cache",
  "escaped_defects",
  "bug_escapes",
  "bug_escape_tries",
  "run_token_audit",
  "run_token_calls",
  "controller_messages",
  "controller_files",
  "code_health_file_memberships",
  "code_health_file_sizes",
  "code_health_git_sources",
  "code_health_merged_reviews",
  "code_health_overview",
  "code_health_recommendation_requests",
  "code_health_recommendations",
  "code_health_revisions",
  "code_health_size_snapshots",
  "code_health_size_sources",
  "code_health_test_attempts",
  "code_health_test_qa",
  "code_health_test_reports",
];

/** Runs `fn` in a transaction; `writeLock` takes the write lock first (BEGIN IMMEDIATE). */
export type Transaction = (fn: () => void, writeLock?: boolean) => void;

/** Upgrades a database made by an older release to the current shape; run once after SCHEMA. */
export function migrate(db: DatabaseSync, transaction: Transaction): void {
  new Migrations(db, transaction).migrate();
}

class Migrations {
  private readonly db: DatabaseSync;
  private readonly transaction: Transaction;

  constructor(db: DatabaseSync, transaction: Transaction) {
    this.db = db;
    this.transaction = transaction;
  }

  private getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
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
  private whenColumnPresent(table: string, column: string, fn: () => void): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((c) => c.name === column)) fn();
  }

  private addColumn(table: string, column: string, type: string): void {
    this.whenColumnMissing(table, column, () =>
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`),
    );
  }

  /** Columns added after the first release; each runs once, on a database that lacks it. */
  migrate(): void {
    // the forecast brake's Needs-you note is gone with the brake
    if (
      this.db.prepare("SELECT 1 FROM attention_notes WHERE key = 'budget-brake'").get() !==
      undefined
    )
      this.db.prepare("DELETE FROM attention_notes WHERE key = 'budget-brake'").run();
    // Whether a PR comes from a fork: a run never follows a fork's head (#2099).
    this.addColumn("pull_requests", "is_cross_repository", "INTEGER");
    // A commit a run only follows, such as someone else's on top of its push (#2099).
    this.addColumn("run_commits", "followed", "INTEGER NOT NULL DEFAULT 0");
    // a hold kept past its calls (a suite left running in the background) survives a restart
    this.addColumn("test_lock_holds", "pinned", "INTEGER NOT NULL DEFAULT 0");
    // Token audit call times (#1646): audits stored before this have none until re-read.
    this.addColumn("flight_decisions", "order_id", "INTEGER");
    this.addColumn("flight_decisions", "wake_id", "TEXT");
    this.addColumn("flight_wakes", "wake_id", "TEXT");
    // the wake no longer records what rode along or was handled at once
    for (const column of ["rode", "immediate"])
      this.whenColumnPresent("flight_wakes", column, () =>
        this.db.exec(`ALTER TABLE flight_wakes DROP COLUMN ${column}`),
      );
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
    this.addColumn("flow_issues", "title", "TEXT");
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
    // Migration only: a run's old park and set-aside records fold into one `hold` (#2071), so a
    // database that skipped the release that folded them keeps its parks. Nothing else reads the
    // old keys. Both go, so a second open finds nothing to change (and takes no write lock); the
    // indexes on the old paths go with them. The rows are read again inside the write-locked
    // transaction.
    const unfolded = `SELECT id, loop FROM runs
           WHERE json_type(loop, '$.parked') IS NOT NULL OR json_type(loop, '$.aside') IS NOT NULL`;
    if (this.db.prepare(`${unfolded} LIMIT 1`).get() !== undefined) {
      this.transaction(() => {
        const rows = this.db.prepare(unfolded).all() as { id: string; loop: string }[];
        const set = this.db.prepare("UPDATE runs SET loop = ? WHERE id = ?");
        for (const r of rows) {
          const loop = JSON.parse(r.loop) as Record<string, unknown>;
          const parked = loop.parked as
            | { kind?: string; reason?: string; ended?: boolean }
            | null
            | undefined;
          const aside = loop.aside as
            | { worktree?: string; wake?: boolean; ask?: number }
            | null
            | undefined;
          delete loop.parked;
          delete loop.aside;
          loop.hold =
            parked == null && aside == null
              ? null
              : {
                  kind: parked?.kind ?? null,
                  reason: parked?.reason ?? null,
                  ended: parked?.ended ?? false,
                  worktree: aside?.worktree ?? null,
                  wake: aside?.wake ?? false,
                  ...(aside?.ask !== undefined ? { ask: aside.ask } : {}),
                };
          set.run(JSON.stringify(loop), r.id);
        }
      }, true);
    }
    this.db.exec(
      "DROP INDEX IF EXISTS runs_loop_aside; DROP INDEX IF EXISTS runs_agent_aside_worktree;",
    );
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS loop_events_run ON loop_events(run_id);
      CREATE INDEX IF NOT EXISTS reviews_run ON reviews(run_id);
      CREATE INDEX IF NOT EXISTS reviews_repo_pr ON reviews(repo_id, pr_number, state);
      CREATE INDEX IF NOT EXISTS board_moves_run ON board_moves(run_id);
      CREATE INDEX IF NOT EXISTS flight_decisions_target_kind ON flight_decisions(target_run_id, kind);
      CREATE INDEX IF NOT EXISTS flight_decisions_ref ON flight_decisions(ref, at);
      CREATE INDEX IF NOT EXISTS ci_runs_pr ON ci_runs(repo_id, pr_number);
      CREATE INDEX IF NOT EXISTS runs_review ON runs(review_id);
      CREATE INDEX IF NOT EXISTS runs_repo_branch ON runs(repo_id, branch);
      CREATE INDEX IF NOT EXISTS runs_repo_ticket ON runs(repo_id, ticket);
      CREATE INDEX IF NOT EXISTS runs_ended ON runs(ended_at);
      CREATE INDEX IF NOT EXISTS runs_folded ON runs(folded, started_at);
      CREATE INDEX IF NOT EXISTS runs_loop_off_seat ON runs(ended_at, json_extract(loop, '$.hold.worktree'), started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_loop_merging ON runs(ended_at, json_extract(loop, '$.merging'), started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_merging_started ON runs(json_extract(loop, '$.merging'), started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_agent_off_seat_worktree ON runs(agent_id, json_extract(loop, '$.hold.worktree'));
      CREATE INDEX IF NOT EXISTS runs_ended_started ON runs(ended_at, started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_loop_pr_number ON runs(json_extract(loop, '$.prNumber'));
      CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
      CREATE INDEX IF NOT EXISTS runs_agent_recent ON runs(agent_id, started_at DESC, seq DESC, id);
      CREATE INDEX IF NOT EXISTS run_digests_context_window ON run_digests(run_id, ${DIGEST_CONTEXT_WINDOW_SQL});
      CREATE INDEX IF NOT EXISTS attention_notes_open ON attention_notes(cleared_at, at, key);
      CREATE INDEX IF NOT EXISTS attention_notes_run_open ON attention_notes(run_id, cleared_at, key);
      CREATE INDEX IF NOT EXISTS pull_requests_ticket ON pull_requests(ticket, updated_at DESC);
      CREATE INDEX IF NOT EXISTS pull_requests_branch ON pull_requests(repo_id, branch, number DESC);
      CREATE INDEX IF NOT EXISTS reviews_ended ON reviews(ended_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS attention_episodes_cleared ON attention_episodes(cleared_at);
      CREATE INDEX IF NOT EXISTS drafts_state_created ON drafts(state, created_at);
      CREATE INDEX IF NOT EXISTS crew_errors_acked_at ON crew_errors(acked, at);
      CREATE INDEX IF NOT EXISTS pr_history_at ON pr_history(merged_at);
      CREATE INDEX IF NOT EXISTS review_tests_review ON review_tests(review_id);
      CREATE INDEX IF NOT EXISTS seat_questions_answered ON seat_questions(answered_at);
      CREATE INDEX IF NOT EXISTS seat_questions_run_time ON seat_questions(run_id, at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS flight_decisions_question_answer ON flight_decisions(question_id, kind, at DESC, id DESC);
    `);
    // 0 / null: stored before the card ids were read; the next GitHub poll fills them.
    this.addColumn("board_items", "created_at", "INTEGER NOT NULL DEFAULT 0");
    // When the seat's last turn ended; the engine's quiet-seat check reads it.
    this.addColumn("seat_sessions", "last_turn_ended_at", "INTEGER");
    this.addColumn("comms", "item_key", "TEXT");
    // A Needs-you item's conversation reads by item (itemThread).
    this.db.exec("CREATE INDEX IF NOT EXISTS comms_item_key ON comms(item_key, at, id)");
    // A note's unbroken run walks its episodes by key (noteRunStart).
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS attention_episodes_key ON attention_episodes(key, at)",
    );
    this.addColumn("seat_sessions", "last_turn_started_at", "INTEGER");
    this.addColumn("seat_sessions", "error_since", "INTEGER");
    // Turns in a row that ended with no new commit; the resume line reads it.
    this.addColumn("seat_sessions", "quiet_turns", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("seat_sessions", "vendor", "TEXT NOT NULL DEFAULT 'claude'");
    this.addColumn("seat_sessions", "stop_by", "TEXT");
    this.addColumn("seat_sessions", "stop_reason", "TEXT");
    this.addColumn("seat_sessions", "stop_at", "INTEGER");
    this.addColumn("board_items", "item_id", "TEXT");
    this.addColumn("board_items", "project_id", "TEXT");
    // When FLIGHT passed the question to the operator (it stays open until they answer).
    this.addColumn("seat_questions", "passed_at", "INTEGER");
    // When the operator set the question aside with Not now; it stays open, out of Needs you.
    this.addColumn("seat_questions", "aside_at", "INTEGER");
    // When the operator dismissed the note from Needs you; a re-raised note is shown again.
    this.addColumn("attention_notes", "dismissed_at", "INTEGER");
    // A PR snapshot's `polledAt` is `read_at` (our clock, written with every upsert); there is no
    // separate column. `mergeable` UNKNOWN means GitHub has not computed it yet: poll again.
    this.addColumn("decision_defaults", "target", "TEXT");
    this.addColumn("decision_defaults", "answer", "TEXT");
    this.addColumn("decision_defaults", "delivered_at", "INTEGER");
    this.addColumn("decision_defaults", "binding", "TEXT");
    this.addColumn("decision_defaults", "delivery_state", "TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumn("decision_defaults", "delivery_note", "TEXT");
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
    this.addColumn("reviews", "install_note", "TEXT");
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
    // Swap, memory pressure and agent and test-run memory for the Telemetry Machine tab, extracted
    // the same way. A sample that lacks a field leaves its column null.
    this.whenColumnMissing("machine_samples", "swap_pct", () => {
      for (const col of ["swap_pct", "pressure_pct", "agent_gb", "test_gb"]) {
        this.db.exec(`ALTER TABLE machine_samples ADD COLUMN ${col} REAL`);
      }
      this.db.exec(
        `UPDATE machine_samples SET
           swap_pct = CASE WHEN json_extract(sample, '$.swapTotalBytes') > 0
             THEN json_extract(sample, '$.swapUsedBytes') * 100.0
               / json_extract(sample, '$.swapTotalBytes') END,
           pressure_pct = 100 - json_extract(sample, '$.memoryPressureFreePct'),
           agent_gb = json_extract(sample, '$.agents.rssBytes') / 1073741824.0,
           test_gb = json_extract(sample, '$.testRun.rssBytes') / 1073741824.0`,
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
      "TEXT CHECK (label IS NULL OR label IN ('question','handoff','blocker','none'))",
    );
    this.addColumn("comms", "ref", "TEXT");
    this.addColumn("comms", "reply_to", "INTEGER");
    this.addColumn("comms", "target_run_id", "TEXT");
    // The hub stamps a seat's message with the run that sent it and that run's newest open PR.
    this.addColumn("comms", "from_run_id", "TEXT");
    this.addColumn("comms", "pr", "INTEGER");
    // Set when waking the recipient failed, so an identical retry wakes them instead of being skipped.
    this.addColumn("comms", "wake_failed_at", "INTEGER");
    this.addColumn("comms", "delivered_at", "INTEGER");
    this.addColumn("question_choices", "chosen_by", "TEXT");
    // Who sent it, set by the hub; NULL on rows stored before this column.
    this.addColumn("comms", "sender_kind", "TEXT");
    // `notice` on a line the hub wrote; NULL on any other message.
    this.addColumn("comms", "kind", "TEXT");
    // An up-to-date reader must not take a write lock merely to open the store.
    if (
      this.db
        .prepare("SELECT 1 FROM comms WHERE sender_kind = ? AND kind IS NULL LIMIT 1")
        .get("hub")
    )
      this.db
        .prepare("UPDATE comms SET kind = ? WHERE sender_kind = ? AND kind IS NULL")
        .run(COMMS_NOTICE, "hub");
    this.migrateCommsLabels();
    // the old code-health triggers on kept tables write into a retired table: drop them first
    for (const { name } of this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'code\\_health\\_%' ESCAPE '\\'",
      )
      .all() as { name: string }[])
      this.db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
    for (const table of RETIRED_TABLES) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS comms_target_run ON comms(target_run_id, at, id);
      CREATE INDEX IF NOT EXISTS comms_ticket ON comms(ticket, at, id);
      CREATE INDEX IF NOT EXISTS comms_ref ON comms(ref, at, id);
      CREATE INDEX IF NOT EXISTS comms_ticket_count_refs ON comms(ticket, ref, from_id);
      -- Preserve reference totals when retention removes bodies. Null flags avoid sentinel collisions.
      CREATE TABLE IF NOT EXISTS comms_ticket_archived_counts (
        ticket TEXT NOT NULL, ref TEXT NOT NULL, from_id TEXT NOT NULL,
        ticket_null INTEGER NOT NULL, ref_null INTEGER NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (ticket, ref, from_id, ticket_null, ref_null)
      );
      CREATE TRIGGER IF NOT EXISTS comms_archive_ticket_count BEFORE DELETE ON comms
      WHEN OLD.ticket IS NOT NULL OR OLD.ref IS NOT NULL
      BEGIN
        INSERT INTO comms_ticket_archived_counts (ticket, ref, from_id, ticket_null, ref_null, count)
        VALUES (COALESCE(OLD.ticket, ''), COALESCE(OLD.ref, ''), OLD.from_id,
          OLD.ticket IS NULL, OLD.ref IS NULL, 1)
        ON CONFLICT(ticket, ref, from_id, ticket_null, ref_null)
        DO UPDATE SET count = comms_ticket_archived_counts.count + 1;
      END;
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

  /** Adds the explicit `none` label to databases created before Comms recorded it. */
  private migrateCommsLabels(): void {
    const schema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comms'")
      .get() as { sql?: string } | undefined;
    if (schema?.sql?.includes("'none'")) {
      if (this.db.prepare("SELECT 1 FROM comms WHERE label IS NULL LIMIT 1").get())
        this.db.prepare("UPDATE comms SET label = 'none' WHERE label IS NULL").run();
      return;
    }
    this.transaction(() => {
      this.db.exec(`
        ALTER TABLE comms RENAME TO comms_before_none_label;
        CREATE TABLE comms (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, from_id TEXT NOT NULL,
          to_id TEXT NOT NULL, ticket TEXT, text TEXT NOT NULL,
          label TEXT NOT NULL CHECK (label IN ('question','handoff','blocker','none')),
          ref TEXT, reply_to INTEGER, target_run_id TEXT, from_run_id TEXT, pr INTEGER,
          wake_failed_at INTEGER, delivered_at INTEGER, sender_kind TEXT, item_key TEXT
        );
        INSERT INTO comms (id, at, from_id, to_id, ticket, text, label, ref, reply_to,
          target_run_id, from_run_id, pr, wake_failed_at, delivered_at, sender_kind, item_key)
        SELECT id, at, from_id, to_id, ticket, text, COALESCE(label, 'none'), ref, reply_to,
          target_run_id, from_run_id, pr, wake_failed_at, delivered_at, sender_kind, item_key
        FROM comms_before_none_label;
        DROP TABLE comms_before_none_label;
        CREATE INDEX comms_at ON comms(at);
        CREATE INDEX comms_from_id ON comms(from_id, id);
        CREATE INDEX comms_to_id ON comms(to_id, id);
      `);
    }, true);
  }
}
