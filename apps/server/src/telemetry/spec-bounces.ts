import type { DatabaseSync } from "node:sqlite";
import {
  type AuditSpecBounce,
  type AuditSpecBounceCount,
  classifySpecBounce,
  SPEC_BOUNCE_CAUSES,
} from "@mc/core";

const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;

/**
 * Spec-failed review rounds (a failed quality verdict alone is left out) with the cause of each,
 * from the finding text and the author run's recorded Done-when lines. Rows are for the range;
 * the counts are for the 7 and 30 days up to its end. No model reads a finding.
 */
export function specBounces(
  db: DatabaseSync,
  since: number,
  until: number,
): { rows: AuditSpecBounce[]; counts: AuditSpecBounceCount[] } {
  const from30 = until - 30 * DAY_MS;
  const from7 = until - 7 * DAY_MS;
  const reviews = db
    .prepare(
      `SELECT v.id, v.repo_id, v.pr_number, v.summary, v.ended_at, r.ticket,
         (SELECT COUNT(*) FROM run_done_when d WHERE d.run_id = v.author_run_id) AS done_when
       FROM reviews v LEFT JOIN runs r ON r.id = v.author_run_id
       WHERE v.state = 'reported' AND json_extract(v.verdict, '$.spec') = 'fail'
         AND v.ended_at >= ? AND v.ended_at <= ?
       ORDER BY v.ended_at, v.id`,
    )
    .all(Math.min(since, from30), until) as Row[];
  const findingsOf = db.prepare(
    "SELECT summary, scenario FROM review_findings WHERE review_id = ? ORDER BY pos",
  );

  const counts = new Map(SPEC_BOUNCE_CAUSES.map((c) => [c, { days7: 0, days30: 0 }]));
  const rows = new Map<string, AuditSpecBounce>();
  for (const v of reviews) {
    const found = findingsOf.all(v.id as number) as Row[];
    const summaries = found.map((f) => f.summary as string);
    const text = [
      ...found.flatMap((f) => [f.summary as string, f.scenario as string]),
      (v.summary as string | null) ?? "",
    ].join("\n");
    // A ticket with no recorded Done-when lines is told to the rule as an empty list.
    const cause = classifySpecBounce(text, (v.done_when as number) === 0 ? [] : ["recorded"]);
    const at = v.ended_at as number;
    const count = counts.get(cause);
    if (count !== undefined) {
      if (at >= from30) count.days30++;
      if (at >= from7) count.days7++;
    }
    if (at < since) continue;
    const key = `${v.repo_id as string}\0${v.pr_number as number}\0${cause}`;
    const row = rows.get(key) ?? {
      repoId: v.repo_id as string,
      ticket: (v.ticket as string | null) ?? null,
      pr: v.pr_number as number,
      cause,
      rounds: 0,
      findings: [],
      at,
    };
    row.rounds++;
    row.at = at;
    row.findings.push(
      ...(summaries.length > 0 ? summaries : [((v.summary as string | null) ?? "").trim()]).filter(
        (s) => s !== "",
      ),
    );
    rows.set(key, row);
  }
  return {
    rows: [...rows.values()].sort((a, b) => b.at - a.at || a.pr - b.pr),
    counts: SPEC_BOUNCE_CAUSES.map(
      (cause) => ({ cause, ...(counts.get(cause) as object) }) as AuditSpecBounceCount,
    ),
  };
}
