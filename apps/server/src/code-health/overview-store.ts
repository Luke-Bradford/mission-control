import type { DatabaseSync } from "node:sqlite";
import type { CodeHealthMergedDay, CodeHealthWindow } from "@mc/core";

type Db = Pick<DatabaseSync, "prepare" | "exec">;

/** The stored first-screen summary: one row per repo and window, so retained keys stay bounded. */
export function installOverview(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS code_health_overview (
    repo_id TEXT NOT NULL, span TEXT NOT NULL, version INTEGER NOT NULL,
    source_revision TEXT NOT NULL, summary_revision TEXT NOT NULL, generated_at INTEGER NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY (repo_id, span)
  )`);
}

export interface StoredOverview {
  version: number;
  sourceRevision: string;
  summaryRevision: string;
  generatedAt: number;
  body: string;
}

export function readOverviewRow(
  db: Db,
  repoId: string,
  window: CodeHealthWindow,
): StoredOverview | null {
  const row = db
    .prepare(
      "SELECT version, source_revision, summary_revision, generated_at, body FROM code_health_overview WHERE repo_id = ? AND span = ?",
    )
    .get(repoId, window);
  return row
    ? {
        version: Number(row.version),
        sourceRevision: String(row.source_revision),
        summaryRevision: String(row.summary_revision),
        generatedAt: Number(row.generated_at),
        body: String(row.body),
      }
    : null;
}

export function writeOverviewRow(
  db: Db,
  repoId: string,
  window: CodeHealthWindow,
  row: StoredOverview,
) {
  db.prepare(
    `INSERT INTO code_health_overview (repo_id, span, version, source_revision, summary_revision, generated_at, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, span) DO UPDATE SET version = excluded.version,
       source_revision = excluded.source_revision, summary_revision = excluded.summary_revision,
       generated_at = excluded.generated_at, body = excluded.body`,
  ).run(
    repoId,
    window,
    row.version,
    row.sourceRevision,
    row.summaryRevision,
    row.generatedAt,
    row.body,
  );
}

export interface MergedAggregate {
  days: CodeHealthMergedDay[];
  merged: number;
  /** Merged PRs with a hub review record that still exists. */
  reviewed: number;
  /** Reviewed PRs whose reported rounds reached two or more. */
  rework: number;
  /** Newest stored merge in the window; null when none. */
  newest: number | null;
}

/** Merged PRs by UTC day, from the stored merge time. A PR with no hub review record is its own bucket. */
export function mergedAggregate(
  db: Db,
  repoId: string,
  from: number,
  until: number,
): MergedAggregate {
  const rows = db
    .prepare(
      `SELECT date(m.merged_at / 1000, 'unixepoch') AS day,
         CASE WHEN v.id IS NULL THEN 0 WHEN v.round >= 3 THEN 3 ELSE v.round END AS bucket,
         COUNT(*) AS n, MAX(m.merged_at) AS newest
       FROM code_health_merged_reviews m LEFT JOIN reviews v ON v.id = m.review_id AND v.state = 'reported'
       WHERE m.repo_id = ? AND m.merged_at >= ? AND m.merged_at < ?
       GROUP BY day, bucket ORDER BY day, bucket`,
    )
    .all(repoId, from, until);
  const days = new Map<string, CodeHealthMergedDay>();
  let merged = 0,
    reviewed = 0,
    rework = 0,
    newest: number | null = null;
  for (const row of rows) {
    const day = String(row.day),
      n = Number(row.n),
      bucket = Number(row.bucket);
    const entry = days.get(day) ?? { day, noHubReview: 0, round1: 0, round2: 0, round3Plus: 0 };
    if (bucket === 0) entry.noHubReview += n;
    else if (bucket === 1) entry.round1 += n;
    else if (bucket === 2) entry.round2 += n;
    else entry.round3Plus += n;
    days.set(day, entry);
    merged += n;
    if (bucket > 0) reviewed += n;
    if (bucket >= 2) rework += n;
    newest = Math.max(newest ?? 0, Number(row.newest));
  }
  return { days: [...days.values()], merged, reviewed, rework, newest };
}

/** The first and last stored merge for the repo, whatever the window. */
export function mergedObserved(db: Db, repoId: string) {
  const row = db
    .prepare(
      "SELECT MIN(merged_at) AS first, MAX(merged_at) AS last FROM code_health_merged_reviews WHERE repo_id = ?",
    )
    .get(repoId);
  return {
    first: row?.first === null || row?.first === undefined ? null : Number(row.first),
    last: row?.last === null || row?.last === undefined ? null : Number(row.last),
  };
}

export interface CostAggregate {
  /** Merged PRs with at least one run on their branch. */
  withRuns: number;
  /** Of those, PRs where every run recorded a cost. */
  priced: number;
  /** Median cost of the priced PRs; null when none is priced. */
  median: number | null;
}

/** Cost per merged PR from recorded run cost. A run with no recorded cost makes its PR unpriced, never free. */
export function costAggregate(db: Db, repoId: string, from: number, until: number): CostAggregate {
  const rows = db
    .prepare(
      `SELECT COUNT(r.id) AS runs, SUM(r.cost_usd IS NULL) AS unpriced, SUM(r.cost_usd) AS cost
       FROM code_health_merged_reviews m
       JOIN pull_requests p ON p.repo_id = m.repo_id AND p.number = m.pr_number
       JOIN runs r ON r.repo_id = p.repo_id AND r.branch = p.branch
       WHERE m.repo_id = ? AND m.merged_at >= ? AND m.merged_at < ?
       GROUP BY m.pr_number`,
    )
    .all(repoId, from, until);
  const costs = rows
    .filter((row) => Number(row.unpriced) === 0 && row.cost !== null)
    .map((row) => Number(row.cost))
    .sort((a, b) => a - b);
  const mid = costs.length >> 1;
  return {
    withRuns: rows.length,
    priced: costs.length,
    median:
      costs.length === 0 ? null : costs.length % 2 ? costs[mid] : (costs[mid - 1] + costs[mid]) / 2,
  };
}

export interface LandingRow {
  path: string;
  findings: number;
  touches: number;
}

/**
 * Per file: distinct finding lineages (one per PR, file, category, summary and fix, so a finding
 * repeated across rounds counts once) and the merged PRs that changed that exact path in the window.
 */
export function landingAggregate(
  db: Db,
  repoId: string,
  from: number,
  until: number,
  limit: number,
): { rows: LandingRow[]; newest: number | null } {
  const rows = db
    .prepare(
      `WITH lineage AS (
         SELECT file, COUNT(*) AS findings, MAX(ended_at) AS newest FROM (
           SELECT v.pr_number, f.file, f.category, f.summary, f.fix, MAX(v.ended_at) AS ended_at
           FROM review_findings f JOIN reviews v ON v.id = f.review_id
           WHERE v.repo_id = ? AND v.state = 'reported' AND v.ended_at >= ? AND v.ended_at < ?
           GROUP BY v.pr_number, f.file, f.category, f.summary, f.fix
         ) GROUP BY file
       )
       SELECT l.file AS path, l.findings AS findings, l.newest AS newest,
         (SELECT COUNT(*) FROM pr_files t JOIN code_health_merged_reviews m
            ON m.repo_id = t.repo_id AND m.pr_number = t.pr_number
          WHERE t.repo_id = ? AND t.path = l.file AND m.merged_at >= ? AND m.merged_at < ?) AS touches
       FROM lineage l ORDER BY l.findings DESC, l.file LIMIT ?`,
    )
    .all(repoId, from, until, repoId, from, until, limit);
  return {
    rows: rows.map((row) => ({
      path: String(row.path),
      findings: Number(row.findings),
      touches: Number(row.touches),
    })),
    newest: rows.reduce<number | null>((a, row) => Math.max(a ?? 0, Number(row.newest)), null),
  };
}
