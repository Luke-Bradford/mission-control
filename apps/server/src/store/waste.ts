import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Run } from "@mc/core";
import { toRun } from "./rows.ts";

type Row = Record<string, SQLInputValue>;

/** The queries the spend report and the daily retrospective read, over the hub's recorded runs and reviews. */
export function wasteQueries(db: DatabaseSync) {
  const all = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as Row[];
  return {
    /** Every run that started at or after `since`, newest first. */
    runsSince(since: number): Run[] {
      return all("SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at DESC", since).map(
        toRun,
      );
    },

    /**
     * Open PRs with reported reviews that failed (blocking findings or a failed verdict), and how
     * many; the PR's latest author run names the seat.
     */
    failedReviewRounds() {
      return all(
        `SELECT v.repo_id AS repoId, v.pr_number AS pr, COUNT(*) AS rounds,
           (SELECT x.author_run_id FROM reviews x WHERE x.repo_id = v.repo_id AND x.pr_number = v.pr_number
              ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS runId
         FROM reviews v JOIN pull_requests p ON p.repo_id = v.repo_id AND p.number = v.pr_number
         WHERE p.state = 'open' AND v.state = 'reported'
           AND (v.blocking > 0 OR json_extract(v.verdict, '$.spec') = 'fail'
                OR json_extract(v.verdict, '$.quality') = 'fail')
         GROUP BY v.repo_id, v.pr_number`,
      ) as unknown as { repoId: string; pr: number; rounds: number; runId: string }[];
    },

    /** Each agent's state when `since` began: its latest recorded change before it. */
    agentStatesBefore(since: number): Map<string, string> {
      return new Map(
        all(
          `SELECT agent_id, to_state FROM agent_events e
           WHERE at < ? AND at = (SELECT MAX(at) FROM agent_events WHERE agent_id = e.agent_id AND at < ?)`,
          since,
          since,
        ).map((r) => [r.agent_id as string, r.to_state as string]),
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
  };
}
