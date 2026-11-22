import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  MODEL_CHANGE_SIDE_MS,
  type ModelRunRow,
  type ModelTableData,
  type SeatRun,
  type TokenUsage,
} from "@mc/core";

type Row = Record<string, SQLInputValue>;

const ticketNumber = (ticket: string): number | null => {
  const m = /#(\d+)$/.exec(ticket);
  return m?.[1] === undefined ? null : Number(m[1]);
};

/**
 * What the Audit model panel counts: build runs whose last reported review ended in
 * [since - 30 days, until] (the groups use the window, the changes reach 30 days either side),
 * the build and review seats' runs to find their changes, and when step-up advice began.
 */
export function modelTableData(db: DatabaseSync, since: number, until: number): ModelTableData {
  const lo = since - MODEL_CHANGE_SIDE_MS;
  const reviewed = db
    .prepare(
      `SELECT r.id, r.agent_id, r.repo_id, r.ticket, r.model, r.effort, r.profile, r.plan, r.cost_usd,
         MAX(rv.round) AS max_round, SUM(rv.blocking) AS blocking,
         MAX(COALESCE(rv.ended_at, rv.created_at)) AS ended,
         (SELECT x.seat_id FROM reviews x WHERE x.author_run_id = r.id AND x.state = 'reported'
            ORDER BY x.id LIMIT 1) AS review_seat,
         EXISTS (SELECT 1 FROM reviews x JOIN pr_history h
                   ON h.repo_id = x.repo_id AND h.number = x.pr_number
                 WHERE x.author_run_id = r.id) AS merged
       FROM runs r JOIN reviews rv ON rv.author_run_id = r.id AND rv.state = 'reported'
       WHERE r.loop_kind = 'build' AND r.ticket IS NOT NULL
       GROUP BY r.id HAVING ended >= ? AND ended <= ?`,
    )
    .all(lo, until) as Row[];
  const tokens = new Map<string, number>();
  for (const t of db
    .prepare(
      "SELECT repo_id, ticket, tokens FROM runs WHERE ticket IS NOT NULL AND tokens IS NOT NULL",
    )
    .all() as Row[]) {
    const u = JSON.parse(t.tokens as string) as TokenUsage;
    const key = `${t.repo_id}\n${t.ticket}`;
    tokens.set(key, (tokens.get(key) ?? 0) + u.input + u.output + u.cacheCreate);
  }
  const sizeOf = db.prepare("SELECT size FROM flow_issues WHERE repo_id = ? AND number = ?");
  const rows = reviewed.map((r): ModelRunRow => {
    const ticket = r.ticket as string;
    const n = ticketNumber(ticket);
    const size = n === null ? undefined : (sizeOf.get(r.repo_id, n) as Row | undefined);
    const plan = r.plan === null ? null : (JSON.parse(r.plan as string) as { skipped?: string });
    const profile =
      r.profile === null
        ? null
        : (JSON.parse(r.profile as string) as { profile?: { name?: string } });
    return {
      runId: r.id as string,
      seatId: r.agent_id as string,
      reviewSeatId: (r.review_seat ?? null) as string | null,
      ticket,
      model: (r.model ?? null) as string | null,
      effort: (r.effort ?? null) as string | null,
      template: profile?.profile?.name ?? null,
      planned: plan !== null && plan.skipped === undefined,
      size: (size?.size ?? null) as string | null,
      merged: r.merged === 1,
      maxRound: r.max_round as number,
      blocking: (r.blocking ?? 0) as number,
      costUsd: (r.cost_usd ?? null) as number | null,
      ticketTokens: tokens.get(`${r.repo_id}\n${ticket}`) ?? 0,
      endedAt: r.ended as number,
    };
  });
  const seatRuns = (
    db
      .prepare(
        `SELECT agent_id, loop_kind, model, effort, started_at FROM runs
         WHERE loop_kind IN ('build', 'review') AND started_at >= ? AND started_at <= ?
         ORDER BY started_at, id`,
      )
      .all(lo - MODEL_CHANGE_SIDE_MS, until) as Row[]
  ).map(
    (r): SeatRun => ({
      seatId: r.agent_id as string,
      loop: r.loop_kind as SeatRun["loop"],
      model: (r.model ?? null) as string | null,
      effort: (r.effort ?? null) as string | null,
      startedAt: r.started_at as number,
    }),
  );
  const first = db.prepare("SELECT MIN(at) AS at FROM model_step_ups").get() as Row;
  return { rows, seatRuns, stepUpSince: (first.at ?? null) as number | null };
}
