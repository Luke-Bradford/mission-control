import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { AgentId, LoopKind, PullRequestView, RepoId, Run, RunLoop, RunStatus } from "@mc/core";
import { parseJson } from "../json.ts";
import { toRun } from "./rows.ts";
import { MAX_OPEN_RUN_AGE_MS, RUN_ATTEMPTS_KEEP_MS, RUN_SNAPSHOT_KEEP_MS } from "./types.ts";

type Row = Record<string, SQLInputValue>;

/**
 * The queries over the `runs` and `run_attempts` tables. `statement` is the store's cache of
 * prepared statements, for the reads that run often.
 */
export function runQueries(db: DatabaseSync, statement: (sql: string) => StatementSync) {
  const q = {
    /** Ordered snapshots: later observations never rewrite an earlier attempt. */
    runAttempts(
      runId: string,
    ): { id: number; runId: string; kind: string; at: number; data: Record<string, unknown> }[] {
      return (
        db
          .prepare(
            "SELECT * FROM run_attempts WHERE run_id = ? OR run_id IN (SELECT run_id FROM reviews WHERE author_run_id = ?) ORDER BY id",
          )
          .all(runId, runId) as Row[]
      ).map((r) => ({
        id: r.id as number,
        runId: r.run_id as string,
        kind: r.kind as string,
        at: r.at as number,
        data: parseJson<Record<string, unknown>>(r.data, {}),
      }));
    },

    /**
     * Retention for run_attempts; returns the rows deleted. A `run` snapshot a later one of its run
     * supersedes goes after `RUN_SNAPSHOT_KEEP_MS` (every run keeps its final snapshot); any other
     * attempt but `loop` (the Audit death-loop list reads those) goes after `RUN_ATTEMPTS_KEEP_MS`.
     */
    pruneAttempts(now: number): number {
      const rules = [
        [
          `kind = 'run' AND at < ? AND id < (SELECT MAX(b.id) FROM run_attempts b
             WHERE b.run_id = run_attempts.run_id AND b.kind = 'run')`,
          now - RUN_SNAPSHOT_KEEP_MS,
        ],
        ["kind NOT IN ('loop', 'run') AND at < ?", now - RUN_ATTEMPTS_KEEP_MS],
      ] as const;
      let deleted = 0;
      for (const [where, cutoff] of rules) {
        for (;;) {
          // read first: a database with nothing to prune is not written, so opening it never waits
          // on another connection's write lock
          const ids = (
            db.prepare(`SELECT id FROM run_attempts WHERE ${where} LIMIT 5000`).all(cutoff) as {
              id: number;
            }[]
          ).map((r) => r.id);
          if (ids.length === 0) break;
          db.prepare(`DELETE FROM run_attempts WHERE id IN (${ids.map(() => "?").join(",")})`).run(
            ...ids,
          );
          deleted += ids.length;
        }
      }
      return deleted;
    },

    appendAttempt(runId: string, kind: string, at: number, data: object): void {
      const encoded = JSON.stringify(data);
      const previous = db
        .prepare(
          "SELECT data, at FROM run_attempts WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
        )
        .get(runId, kind) as Row | undefined;
      // Wait completions are events: equal durations at different times are distinct waits.
      if (previous?.data === encoded && (kind !== "wait-end" || previous.at === at)) return;
      db.prepare("INSERT INTO run_attempts (run_id, kind, at, data) VALUES (?, ?, ?, ?)").run(
        runId,
        kind,
        at,
        encoded,
      );
    },

    /**
     * `folded`: the caller folded the run's transcript into `r`. The row is marked folded once that
     * happens to an ended run, and the mark is never cleared. A new row takes `r.loop`; an existing
     * row's loop is never rewritten here (`setRunLoop`).
     */
    upsertRun(r: Run, folded = false): void {
      q.appendAttempt(r.id, "run", r.endedAt ?? r.startedAt, {
        model: r.model,
        profile: r.profile ?? null,
        reviewId: r.reviewId ?? null,
        tokens: r.tokens,
        costUsd: r.costUsd,
        status: r.status,
      });
      db.prepare(
        `INSERT INTO runs (id, agent_id, repo_id, seq, started_at, ended_at, status, session_id,
             model, branch, ticket, cost_usd, tokens, transcript_path, prs, summary, folded, loop,
             ticket_title, review_id, cli_version, profile, profile_hash, plan, vendor, latest_plan,
             account_id, effort, prompt_hash, loop_kind, advice)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
             loop_kind = COALESCE(loop_kind, excluded.loop_kind),
             advice = COALESCE(advice, excluded.advice)`,
      ).run(
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
        r.advice === undefined ? null : JSON.stringify(r.advice),
      );
    },

    /**
     * Gives runs stored before `loop_kind` existed the loop kind of their seat as configured now, so
     * a seat removed later still shows as a build seat in Audit. A run that has one keeps it.
     * Returns how many rows it set.
     */
    backfillRunLoopKinds(kinds: ReadonlyMap<string, LoopKind>): number {
      const set = db.prepare(
        "UPDATE runs SET loop_kind = ? WHERE agent_id = ? AND loop_kind IS NULL AND review_id IS NULL",
      );
      let n = 0;
      for (const [agentId, kind] of kinds) n += Number(set.run(kind, agentId).changes);
      return n;
    },

    /** Records a running Codex CLI's version without allowing a stale launch to revive its run. */
    setRunCliVersionIfLive(runId: string, cliVersion: string): boolean {
      return (
        db
          .prepare("UPDATE runs SET cli_version = ? WHERE id = ? AND ended_at IS NULL")
          .run(cliVersion, runId).changes === 1
      );
    },

    run(id: string): Run | null {
      const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
      return row ? toRun(row) : null;
    },

    runs(agentId: AgentId, limit: number): Run[] {
      const rows = statement(
        "SELECT * FROM runs WHERE agent_id = ? ORDER BY started_at DESC, seq DESC LIMIT ?",
      ).all(agentId, limit) as Row[];
      return rows.map(toRun);
    },

    /** Indexed recent-run bounds for each HUD agent, with older held runs retained. */
    runsForAgents(
      agentIds: readonly AgentId[],
      limit: number,
      heldRunIds: readonly string[] = [],
    ): Map<AgentId, Run[]> {
      const out = new Map<AgentId, Run[]>();
      if (agentIds.length === 0) return out;
      for (const agentId of agentIds) out.set(agentId, []);
      const seen = new Set<string>();
      const take = (row: Row) => {
        if (seen.has(row.id as string)) return;
        seen.add(row.id as string);
        const run = toRun(row);
        const runs = out.get(run.agentId) ?? [];
        runs.push(run);
        out.set(run.agentId, runs);
      };
      const recent = statement(`SELECT * FROM runs WHERE agent_id = ?
        ORDER BY started_at DESC, seq DESC
        LIMIT CASE WHEN ? > 0 THEN CAST(? AS INTEGER) ELSE 0 END`);
      for (const agentId of out.keys()) {
        for (const row of recent.all(agentId, limit, limit) as Row[]) take(row);
      }
      const held = [...new Set(heldRunIds)];
      if (held.length > 0)
        for (const row of statement(
          `SELECT * FROM runs WHERE id IN (${held.map(() => "?").join(", ")})
          ORDER BY agent_id, started_at DESC, seq DESC`,
        ).all(...held) as Row[])
          take(row);
      for (const runs of out.values())
        runs.sort((a, b) => b.startedAt - a.startedAt || b.seq - a.seq);
      return out;
    },

    /** The branches this hub's own work runs (not review runs) worked on in a repo, ended or not. */
    runBranches(repoId: RepoId): Set<string> {
      const rows = statement(
        "SELECT DISTINCT branch FROM runs WHERE repo_id = ? AND review_id IS NULL AND branch IS NOT NULL",
      ).all(repoId) as { branch: string }[];
      return new Set(rows.map((r) => r.branch));
    },

    /** Runs still open or ended at or after `since`, across seats and repos. */
    runsActiveSince(since: number): Run[] {
      const rows = db
        .prepare(`SELECT * FROM (
          SELECT * FROM runs INDEXED BY runs_ended_started WHERE ended_at IS NULL
          UNION ALL
          SELECT * FROM runs INDEXED BY runs_ended_started WHERE ended_at >= ?
        ) ORDER BY started_at, seq`)
        .all(since) as Row[];
      return rows.map(toRun);
    },

    /** Complete author bindings for flow reads, plus active runs needed for seat queue order. */
    prFlowRuns(
      repoId: RepoId,
      prs: readonly Pick<PullRequestView, "number" | "branch" | "ticket">[],
    ): Run[] {
      const numbers = JSON.stringify(prs.map((p) => p.number));
      return (
        statement(`SELECT * FROM runs WHERE repo_id = ? AND review_id IS NULL AND (
        ended_at IS NULL OR branch IN (SELECT json_extract(value, '$.branch') FROM json_each(?))
        OR ticket IN (SELECT json_extract(value, '$.ticket') FROM json_each(?))
        OR json_extract(loop, '$.prNumber') IN (SELECT value FROM json_each(?))
        OR EXISTS (SELECT 1 FROM json_each(prs) p WHERE json_extract(p.value, '$.number') IN (SELECT value FROM json_each(?)))
      ) ORDER BY started_at, seq`).all(
          repoId,
          JSON.stringify(prs),
          JSON.stringify(prs),
          numbers,
          numbers,
        ) as Row[]
      ).map(toRun);
    },

    /** Every recorded run on a branch; review ordering needs merged predecessors too. */
    runsOnBranch(repoId: RepoId, branch: string): Run[] {
      return (
        db
          .prepare("SELECT * FROM runs WHERE repo_id = ? AND branch = ? ORDER BY started_at, seq")
          .all(repoId, branch) as Row[]
      ).map(toRun);
    },

    /**
     * The merge hold on the branch's latest build run, ended or not. A hold outlives its run until
     * someone releases it. Only the latest run counts.
     */
    branchMergeHold(repoId: RepoId, branch: string): NonNullable<Run["loop"]>["mergeHold"] | null {
      const latest = q.runsOnBranch(repoId, branch).findLast((run) => run.reviewId == null);
      return latest?.loop?.mergeHold ?? null;
    },

    /**
     * Distinct tickets that a run by one of `seatIds` first started on since `since`. Review runs,
     * observed loops' runs and tickets already started before `since` (then handed on) do not count.
     */
    ticketsStartedSince(since: number, seatIds: readonly string[]): number {
      if (seatIds.length === 0) return 0;
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT r.ticket) AS n FROM runs r
           WHERE r.started_at >= ? AND r.ticket IS NOT NULL AND r.review_id IS NULL
             AND r.agent_id IN (SELECT value FROM json_each(?))
             AND NOT EXISTS (
               SELECT 1 FROM runs p
               WHERE p.ticket = r.ticket AND p.review_id IS NULL AND p.started_at < ?
             )`,
        )
        .get(since, JSON.stringify(seatIds), since) as { n: number };
      return row.n;
    },

    /**
     * What the away digest reads of the runs: each outstanding run's hold, and the PR head of every
     * run whose merge steps include `ready`. Only those few fields: thousands of ended runs carry
     * merge steps, and parsing each whole row cost the digest 20 to 65 ms a call.
     */
    awayDigestRuns(): {
      outstanding: { id: string; ticket: string | null; hold: RunLoop["hold"] | null }[];
      ready: { repoId: string; prNumber: number; sha: string }[];
    } {
      const outstanding = (
        db
          .prepare(
            `SELECT id, ticket, json_extract(loop, '$.hold') AS hold FROM runs
             WHERE ended_at IS NULL ORDER BY started_at, seq`,
          )
          .all() as { id: string; ticket: string | null; hold: string | null }[]
      ).map((r) => ({
        id: r.id,
        ticket: r.ticket,
        hold: r.hold === null ? null : parseJson<RunLoop["hold"]>(r.hold, null),
      }));
      const ready = db
        .prepare(
          `SELECT repo_id AS repoId, json_extract(loop, '$.prNumber') AS prNumber,
             json_extract(loop, '$.merging.sha') AS sha
           FROM runs INDEXED BY runs_merging_started
           WHERE json_extract(loop, '$.merging') > ''
             AND EXISTS (SELECT 1 FROM json_each(loop, '$.merging.done') WHERE value = 'ready')
           ORDER BY started_at, seq`,
        )
        .all() as { repoId: string; prNumber: number; sha: string }[];
      return { outstanding, ready };
    },

    /**
     * The runs a loop drives that may still need the engine: every one not yet ended, and those
     * that ended at or after `endedSince` with a loop that is not done, or is done with merge steps
     * recorded (the last of them may be owed). Oldest first.
     */
    loopRuns(endedSince: number): Run[] {
      const rows = db
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
    },

    /** Ended runs still carrying a merge hold or a parked state, oldest first. */
    endedRunsWithHoldOrPark(): Run[] {
      const rows = db
        .prepare(
          `SELECT * FROM runs WHERE ended_at IS NOT NULL AND loop IS NOT NULL
             AND (json_extract(loop, '$.mergeHold') IS NOT NULL OR json_extract(loop, '$.hold.kind') IS NOT NULL)
           ORDER BY started_at, seq`,
        )
        .all() as Row[];
      return rows.map(toRun);
    },

    /** Live acceptance metadata never needs to decode ended loop history. */
    activeLoopRuns(repoId: RepoId): Run[] {
      const rows = statement(
        "SELECT * FROM runs WHERE repo_id = ? AND ended_at IS NULL AND loop IS NOT NULL ORDER BY started_at, seq",
      ).all(repoId) as Row[];
      return rows.map(toRun);
    },

    /** The runs that have not ended and are off their seat in review, oldest first. */
    offSeatRuns(): Run[] {
      const rows = db
        .prepare(
          `SELECT * FROM runs WHERE ended_at IS NULL AND loop IS NOT NULL
             AND json_extract(loop, '$.hold.worktree') IS NOT NULL
           ORDER BY started_at, seq`,
        )
        .all() as Row[];
      return rows.map(toRun);
    },

    /** The tickets (`repo#n`) of the runs that have not ended. */
    activeTickets(): Set<string> {
      const rows = db
        .prepare(
          "SELECT ticket FROM runs WHERE ended_at IS NULL AND ticket IS NOT NULL AND review_id IS NULL",
        )
        .all() as Row[];
      return new Set(rows.map((r) => r.ticket as string));
    },

    /**
     * True when one of these agents has an open run that is not set aside and started at or after
     * `since`: a run left open for longer is a dead row, not work in progress.
     */
    hasActiveRunOf(agentIds: readonly string[], since: number): boolean {
      if (agentIds.length === 0) return false;
      return (
        db
          .prepare(
            `SELECT 1 FROM runs WHERE ended_at IS NULL AND started_at >= ? AND agent_id IN (${agentIds.map(() => "?").join(",")})
               AND (loop IS NULL OR json_extract(loop, '$.hold.worktree') IS NULL) LIMIT 1`,
          )
          .get(since, ...agentIds) !== undefined
      );
    },

    hasActiveRun(): boolean {
      return (
        db
          .prepare(
            "SELECT 1 FROM runs WHERE ended_at IS NULL AND (loop IS NULL OR json_extract(loop, '$.hold.worktree') IS NULL) LIMIT 1",
          )
          .get() !== undefined
      );
    },

    /**
     * The newest run (ended or not, not a review) on `branch`, which owns that branch's ticket:
     * `agentId`'s own run first, any seat's otherwise.
     */
    latestRunOnBranch(repoId: RepoId, branch: string, agentId?: AgentId): Run | null {
      const row = db
        .prepare(
          `SELECT * FROM runs WHERE repo_id = ? AND branch = ? AND review_id IS NULL
           ORDER BY (agent_id = ?) DESC, started_at DESC, id DESC LIMIT 1`,
        )
        .get(repoId, branch, agentId ?? "") as Row | undefined;
      return row ? toRun(row) : null;
    },

    /** Whether this hub has a run (ended or not) on `branch`. */
    hasRunOnBranch(repoId: RepoId, branch: string): boolean {
      return (
        db
          .prepare(
            "SELECT 1 FROM runs WHERE repo_id = ? AND branch = ? AND review_id IS NULL LIMIT 1",
          )
          .get(repoId, branch) !== undefined
      );
    },

    /** Every run on the ticket, ended ones too; review runs do not count. */
    runsOnTicket(repoId: RepoId, ticket: string): Run[] {
      const rows = db
        .prepare(
          "SELECT * FROM runs WHERE repo_id = ? AND ticket = ? AND review_id IS NULL ORDER BY started_at, seq",
        )
        .all(repoId, ticket) as Row[];
      return rows.map(toRun);
    },

    /** Whether a run is still going on the ticket (`repo#number`); a review run does not count. */
    hasLiveRunOnTicket(repoId: RepoId, ticket: string): boolean {
      return (
        db
          .prepare(
            `SELECT 1 FROM runs WHERE repo_id = ? AND ticket = ? AND status = 'running'
               AND ended_at IS NULL AND review_id IS NULL LIMIT 1`,
          )
          .get(repoId, ticket) !== undefined
      );
    },

    /** Whether another run on the same ticket started after this one. */
    hasNewerRunOnTicket(run: Run): boolean {
      if (run.ticket === null) return false;
      return (
        db
          .prepare(
            `SELECT 1 FROM runs WHERE repo_id = ? AND ticket = ? AND started_at > ? AND id != ?
               AND review_id IS NULL`,
          )
          .get(run.repoId, run.ticket, run.startedAt, run.id) !== undefined
      );
    },

    /**
     * Every agent's runs that overlap [sinceMs, untilMs): started before `untilMs` and ended after
     * `sinceMs`, or with no end. A run with no end counts as lasting until now only while `running`,
     * and only when it started within MAX_OPEN_RUN_AGE_MS of `untilMs` (older ones are abandoned
     * rows; a run left `running` for longer than that also drops out of `pruneFoldState`'s keep-set);
     * otherwise (`unknown`) it lasts an instant and overlaps only if it started at or after
     * `sinceMs`. Newest first.
     */
    runsOverlapping(sinceMs: number, untilMs: number): Run[] {
      return q.overlappingRuns("*", sinceMs, untilMs).map(toRun);
    },

    overlappingRuns(columns: string, sinceMs: number, untilMs: number): Row[] {
      return db
        .prepare(
          `SELECT ${columns} FROM runs WHERE started_at < ?
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
    },

    /**
     * Ended runs started before `startedBefore` whose transcript has not been folded, newest first
     * (the backfill's queue).
     */
    runsToFold(limit: number, startedBefore: number): Run[] {
      const rows = db
        .prepare(
          `SELECT * FROM runs WHERE folded = 0 AND ended_at IS NOT NULL AND started_at < ?
           ORDER BY started_at DESC, seq DESC LIMIT ?`,
        )
        .all(startedBefore, limit) as Row[];
      return rows.map(toRun);
    },

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
      const rows = db
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
    },

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
      const rows = db
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
    },

    /** Sets the title of every run of `ticket` in `repoId` that has none; returns how many it set. */
    setTicketTitle(repoId: string, ticket: string, title: string): number {
      const r = db
        .prepare(
          "UPDATE runs SET ticket_title = ? WHERE repo_id = ? AND ticket = ? AND ticket_title IS NULL",
        )
        .run(title, repoId, ticket);
      return Number(r.changes);
    },

    /** Rewrites only a run's summary (nothing else on its row). */
    setRunSummary(runId: string, summary: string): void {
      db.prepare("UPDATE runs SET summary = ? WHERE id = ?").run(summary, runId);
    },

    /** How many runs `runsToFold` has left before `startedBefore`. */
    countToFold(startedBefore: number): number {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n FROM runs WHERE folded = 0 AND ended_at IS NOT NULL AND started_at < ?",
        )
        .get(startedBefore) as { n: number };
      return row.n;
    },

    /** The run that performs the review, else null. */
    runOfReview(reviewId: number): Run | null {
      const row = db.prepare("SELECT * FROM runs WHERE review_id = ?").get(reviewId) as
        | Row
        | undefined;
      return row ? toRun(row) : null;
    },

    /** The first recorded crew run for a ticket, including one before a telemetry chart's range. */
    ticketStartedAt(ticket: string): number | null {
      const row = db
        .prepare("SELECT MIN(started_at) AS at FROM runs WHERE ticket = ?")
        .get(ticket) as { at: number | null };
      return row.at;
    },

    /** Ends the run: when, with what status, and who ended it. */
    setRunEnded(
      runId: string,
      at: number,
      status: RunStatus,
      endedBy: NonNullable<Run["endedBy"]>,
    ): void {
      db.prepare("UPDATE runs SET ended_at = ?, status = ?, ended_by = ? WHERE id = ?").run(
        at,
        status,
        endedBy,
        runId,
      );
    },

    /** Lightweight retained transcript sources; conversation paging is not limited to recent runs. */
    flightConversationRuns(
      agentId: string,
    ): Pick<Run, "id" | "startedAt" | "endedAt" | "transcriptPath" | "vendor" | "ticket">[] {
      const rows = db
        .prepare(`SELECT id, started_at, ended_at, transcript_path, vendor, ticket FROM runs
        WHERE agent_id = ? ORDER BY COALESCE(ended_at, 9223372036854775807) DESC, started_at DESC, seq DESC`)
        .all(agentId) as Row[];
      return rows.map((r) => ({
        id: r.id as string,
        startedAt: r.started_at as number,
        endedAt: r.ended_at as number | null,
        transcriptPath: r.transcript_path as string,
        ticket: r.ticket as string | null,
        ...(r.vendor ? { vendor: r.vendor as Run["vendor"] } : {}),
      }));
    },

    /** Sets the run's loop state and records the wait it starts or ends (null clears it). */
    setRunLoop(runId: string, loop: RunLoop | null, at: number): void {
      const previous = q.run(runId)?.loop;
      if (JSON.stringify(previous) !== JSON.stringify(loop)) {
        q.appendAttempt(runId, "loop", at, loop ?? { phase: null });
        if (
          previous &&
          (previous.phase === "ci" || previous.phase === "review" || previous.awaitingFlight)
        ) {
          if (previous.phase !== loop?.phase || previous.awaitingFlight !== loop?.awaitingFlight) {
            const start = db
              .prepare(
                "SELECT at FROM run_attempts WHERE run_id = ? AND kind = 'wait' ORDER BY id DESC LIMIT 1",
              )
              .get(runId) as Row | undefined;
            q.appendAttempt(runId, "wait-end", at, {
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
          q.appendAttempt(runId, "wait", at, { on: loop.awaitingFlight ?? loop.phase, since: at });
        }
      }
      db.prepare("UPDATE runs SET loop = ? WHERE id = ?").run(
        loop === null ? null : JSON.stringify(loop),
        runId,
      );
    },
  };
  return q;
}
