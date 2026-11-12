import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Run, WasteAlarm, WasteCheck, WasteFinding } from "@mc/core";
import { toRun } from "./rows.ts";

type Row = Record<string, SQLInputValue>;

/** What a rerun refusal is recorded as, next to the run's own attempts. */
export const RERUN_REFUSED_ATTEMPT = "rerun-refused";
/** The attempt a carry-on resume is recorded as. */
export const RESUME_ATTEMPT = "resume";

const toAlarm = (r: Row): WasteAlarm => ({
  id: r.id as number,
  check: r.check_id as WasteCheck,
  subject: r.subject as string,
  repoId: (r.repo_id as string | null) ?? null,
  ticket: (r.ticket as string | null) ?? null,
  seatId: (r.seat_id as string | null) ?? null,
  runId: (r.run_id as string | null) ?? null,
  level: r.level as number,
  evidence: r.evidence as string,
  openedAt: r.opened_at as number,
  closedAt: (r.closed_at as number | null) ?? null,
  resolvedAt: (r.resolved_at as number | null) ?? null,
  basis: (r.basis as string | null) ?? null,
});

/** The queries the waste checks read, over the hub's recorded runs, checks and reviews. */
export function wasteQueries(db: DatabaseSync) {
  const all = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as Row[];
  const get = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).get(...args) as Row | undefined;
  return {
    /** Every run that started at or after `since`, newest first. */
    runsSince(since: number): Run[] {
      return all("SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at DESC", since).map(
        toRun,
      );
    },

    /** The same check run again on the same commit by one run (clean tree each time): past one retry after a failure, or again after a pass. */
    repeatedChecks(since: number) {
      return all(
        `SELECT c.run_id AS runId, c.command AS command, c.head_sha AS sha, COUNT(*) AS n,
           MAX(c.at) AS lastAt, r.ticket AS ticket, r.repo_id AS repoId, r.agent_id AS agentId
         FROM check_runs c JOIN runs r ON r.id = c.run_id
         WHERE c.at >= ? AND (c.ok = 1 OR c.exit_code IS NOT NULL) GROUP BY c.run_id, c.command, c.head_sha
         HAVING COUNT(*) > 2 OR (COUNT(*) > 1 AND SUM(c.ok) > 1)`,
        since,
      ) as unknown as {
        runId: string;
        command: string;
        sha: string;
        n: number;
        lastAt: number;
        ticket: string | null;
        repoId: string;
        agentId: string;
      }[];
    },

    /** Reruns the hook refused, by run, command and commit. */
    refusedReruns(since: number) {
      return all(
        `SELECT a.run_id AS runId, json_extract(a.data, '$.command') AS command,
           json_extract(a.data, '$.sha') AS sha, COUNT(*) AS n, MAX(a.at) AS lastAt,
           r.ticket AS ticket, r.repo_id AS repoId, r.agent_id AS agentId
         FROM run_attempts a JOIN runs r ON r.id = a.run_id
         WHERE a.kind = '${RERUN_REFUSED_ATTEMPT}' AND a.at >= ?
         GROUP BY a.run_id, command, sha`,
        since,
      ) as unknown as {
        runId: string;
        command: string;
        sha: string;
        n: number;
        lastAt: number;
        ticket: string | null;
        repoId: string;
        agentId: string;
      }[];
    },

    /** Runs resumed `min` times or more with no report of evidence. */
    unreportedResumes(since: number, min: number) {
      return all(
        `SELECT a.run_id AS runId, COUNT(*) AS n, r.ticket AS ticket, r.repo_id AS repoId,
           r.agent_id AS agentId
         FROM run_attempts a JOIN runs r ON r.id = a.run_id
         WHERE a.kind = '${RESUME_ATTEMPT}' AND r.started_at >= ?
           AND NOT EXISTS (SELECT 1 FROM run_evidence e WHERE e.run_id = a.run_id)
         GROUP BY a.run_id HAVING COUNT(*) >= ?`,
        since,
        min,
      ) as unknown as {
        runId: string;
        n: number;
        ticket: string | null;
        repoId: string;
        agentId: string;
      }[];
    },

    /** Each changed author run's review rounds so far, from `since`. */
    reviewRounds(since: number) {
      return all(
        `SELECT v.author_run_id AS runId, v.pr_number AS pr, MAX(v.round) AS rounds,
           r.ticket AS ticket, r.repo_id AS repoId, r.agent_id AS agentId
         FROM reviews v JOIN runs r ON r.id = v.author_run_id
         WHERE v.created_at >= ? GROUP BY v.author_run_id, v.pr_number`,
        since,
      ) as unknown as {
        runId: string;
        pr: number;
        rounds: number;
        ticket: string | null;
        repoId: string;
        agentId: string;
      }[];
    },

    /** The most rounds any review of this author run has reached. */
    maxRound(authorRunId: string): number {
      return (
        (get(
          "SELECT MAX(v.round) AS n FROM reviews v JOIN runs r ON r.id = v.author_run_id WHERE v.author_run_id = ?",
          authorRunId,
        )?.n as number | null | undefined) ?? 0
      );
    },

    /** Tickets (`repo#n`) with a merged PR, and when it merged (the first), from the runs' branches and the PRs' own ticket. */
    mergedTickets(): Map<string, number> {
      const out = new Map<string, number>();
      const note = (ticket: string, at: number) => {
        const had = out.get(ticket);
        if (had === undefined || at < had) out.set(ticket, at);
      };
      // one pass over the PRs, then one over the runs' distinct branches (no run-by-PR join)
      const mergedAt = new Map<string, number>();
      for (const r of all(
        `SELECT repo_id, json_extract(record, '$.branch') AS branch, MIN(merged_at) AS at
         FROM pr_history GROUP BY repo_id, branch`,
      )) {
        if (r.branch === null) continue;
        mergedAt.set(`${r.repo_id as string}\u0000${r.branch as string}`, r.at as number);
      }
      for (const r of all(
        "SELECT DISTINCT repo_id, branch, ticket FROM runs WHERE ticket IS NOT NULL AND branch IS NOT NULL",
      )) {
        const at = mergedAt.get(`${r.repo_id as string}\u0000${r.branch as string}`);
        if (at !== undefined) note(r.ticket as string, at);
      }
      for (const r of all(
        "SELECT repo_id, ticket, MIN(merged_at) AS at FROM pull_requests WHERE ticket IS NOT NULL AND merged_at IS NOT NULL GROUP BY repo_id, ticket",
      )) {
        const t = r.ticket as string;
        note(t.startsWith("#") ? `${r.repo_id as string}${t}` : t, r.at as number);
      }
      return out;
    },

    /** Closed cards, as `repo#n`. */
    closedTickets(): Set<string> {
      return new Set(
        all("SELECT repo_id, issue_number FROM board_items WHERE closed = 1").map(
          (r) => `${r.repo_id as string}#${r.issue_number as number}`,
        ),
      );
    },

    /** Each merged ticket's size and the cost of its runs, for the median of a size. */
    mergedTicketCosts(
      merged: ReadonlyMap<string, number> = this.mergedTickets(),
    ): { ticket: string; size: string; costUsd: number }[] {
      const sizes = new Map(
        all("SELECT repo_id, number, size FROM flow_issues WHERE size IS NOT NULL").map((r) => [
          `${r.repo_id as string}#${r.number as number}`,
          r.size as string,
        ]),
      );
      const cost = new Map<string, number>();
      for (const r of all(
        "SELECT ticket, SUM(cost_usd) AS usd FROM runs WHERE ticket IS NOT NULL AND cost_usd IS NOT NULL GROUP BY ticket",
      ))
        cost.set(r.ticket as string, r.usd as number);
      return [...merged.keys()].flatMap((ticket) => {
        const size = sizes.get(ticket);
        const costUsd = cost.get(ticket);
        return size === undefined || costUsd === undefined ? [] : [{ ticket, size, costUsd }];
      });
    },

    /** A ticket's size, null when unrecorded. */
    ticketSize(ticket: string): string | null {
      const at = ticket.lastIndexOf("#");
      const r = get(
        "SELECT size FROM flow_issues WHERE repo_id = ? AND number = ?",
        ticket.slice(0, at),
        Number(ticket.slice(at + 1)),
      );
      return (r?.size as string | null | undefined) ?? null;
    },

    /** Blocking findings per author run, from its reviews. */
    blockingByRun(runIds: readonly string[]): Map<string, number> {
      if (runIds.length === 0) return new Map();
      const marks = runIds.map(() => "?").join(",");
      return new Map(
        all(
          `SELECT author_run_id AS id, SUM(blocking) AS n FROM reviews
           WHERE author_run_id IN (${marks}) GROUP BY author_run_id`,
          ...runIds,
        ).map((r) => [r.id as string, (r.n as number | null) ?? 0]),
      );
    },

    /** Cards opened at or after `since`. */
    ticketsOpened(since: number) {
      return all(
        "SELECT repo_id AS repoId, issue_number AS n, title FROM board_items WHERE created_at >= ? ORDER BY issue_number",
        since,
      ) as unknown as { repoId: string; n: number; title: string }[];
    },

    /** Tickets closed at or after `since`, by repo. */
    ticketsClosed(since: number): Map<string, number> {
      return new Map(
        all(
          "SELECT repo_id, COUNT(*) AS n FROM flow_issues WHERE done_at >= ? GROUP BY repo_id",
          since,
        ).map((r) => [r.repo_id as string, r.n as number]),
      );
    },

    /** PRs merged in [since, until]: repo, number and branch. */
    mergedBetween(since: number, until: number) {
      return all(
        `SELECT repo_id AS repoId, number, merged_at AS mergedAt,
           json_extract(record, '$.branch') AS branch FROM pr_history
         WHERE merged_at >= ? AND merged_at <= ?`,
        since,
        until,
      ) as unknown as { repoId: string; number: number; mergedAt: number; branch: string | null }[];
    },

    controllerTokens(since: number): number {
      return (
        (get(
          "SELECT COALESCE(SUM(input + cache_write + output), 0) AS n FROM controller_messages WHERE at >= ?",
          since,
        )?.n as number | undefined) ?? 0
      );
    },

    alarms(where: string, ...args: SQLInputValue[]): WasteAlarm[] {
      return all(`SELECT * FROM waste_alarms ${where}`, ...args).map(toAlarm);
    },

    /** Opens an alarm; the caller has checked none is open for this check and subject. */
    insertAlarm(f: WasteFinding, at: number): number {
      const r = db
        .prepare(
          `INSERT INTO waste_alarms (check_id, subject, repo_id, ticket, seat_id, run_id, level, evidence, opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(f.check, f.subject, f.repoId, f.ticket, f.seatId, f.runId, f.level, f.evidence, at);
      return Number(r.lastInsertRowid);
    },

    updateAlarm(id: number, level: number, evidence: string): void {
      db.prepare("UPDATE waste_alarms SET level = ?, evidence = ? WHERE id = ?").run(
        level,
        evidence,
        id,
      );
    },

    closeAlarm(id: number, at: number): void {
      db.prepare("UPDATE waste_alarms SET closed_at = ? WHERE id = ? AND closed_at IS NULL").run(
        at,
        id,
      );
    },

    resolveAlarm(id: number, at: number, basis: string): boolean {
      return (
        db
          .prepare(
            "UPDATE waste_alarms SET resolved_at = ?, basis = ? WHERE id = ? AND resolved_at IS NULL",
          )
          .run(at, basis, id).changes === 1
      );
    },
  };
}
