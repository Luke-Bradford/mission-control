import type { DatabaseSync } from "node:sqlite";

type Db = Pick<DatabaseSync, "prepare" | "exec">;

/** How the PR reached main: no crew run (by hand), a build run that had ended, or one still running. */
export const MERGE_KINDS = ["crew-run", "ended-run", "hand"] as const;
export type MergeKind = (typeof MERGE_KINDS)[number];
export interface MergedReviewRecord {
  repoId: string;
  pr: number;
  mergedAt: number;
  merge: MergeKind;
  /** The hub review of this PR that was reported last (its own head preferred); null when none exists. */
  reviewId: number | null;
  recordedAt: number;
}

/** One row per merged PR; the review link is filled in when a review exists and kept up to date. */
export function installMergedReviews(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS code_health_merged_reviews (
    repo_id TEXT NOT NULL, pr_number INTEGER NOT NULL, merged_at INTEGER NOT NULL,
    merge_kind TEXT NOT NULL, review_id INTEGER, recorded_at INTEGER NOT NULL,
    PRIMARY KEY (repo_id, pr_number)
  )`);
}

const MERGED_PRS_MAX = 2000;

/**
 * Records every merged PR with its review, or with none when none was ever reported. A build
 * run's end or a merge by hand does not leave a PR out. Safe to repeat.
 */
export function recordMergedReviews(db: Db, repoId: string, at: number): number {
  const merged = db
    .prepare(
      `SELECT number, branch, head_sha, merged_at FROM pull_requests
       WHERE repo_id = ? AND state = 'merged' AND merged_at IS NOT NULL
       ORDER BY merged_at DESC LIMIT ?`,
    )
    .all(repoId, MERGED_PRS_MAX);
  const lastReview = db.prepare(
    `SELECT id FROM reviews WHERE repo_id = ? AND pr_number = ? AND state = 'reported'
     ORDER BY (sha = ?) DESC, id DESC LIMIT 1`,
  );
  const runs = db.prepare(
    "SELECT ended_at FROM runs WHERE repo_id = ? AND branch = ? AND review_id IS NULL ORDER BY started_at DESC, seq DESC LIMIT 1",
  );
  const write = db.prepare(
    `INSERT INTO code_health_merged_reviews(repo_id,pr_number,merged_at,merge_kind,review_id,recorded_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(repo_id,pr_number) DO UPDATE SET review_id = excluded.review_id
     WHERE code_health_merged_reviews.review_id IS NOT excluded.review_id`,
  );
  let changed = 0;
  for (const row of merged) {
    const pr = Number(row.number),
      mergedAt = Number(row.merged_at);
    const review = lastReview.get(repoId, pr, String(row.head_sha ?? ""));
    const run = runs.get(repoId, String(row.branch));
    const merge: MergeKind = !run
      ? "hand"
      : run.ended_at !== null && Number(run.ended_at) <= mergedAt
        ? "ended-run"
        : "crew-run";
    changed += Number(
      write.run(repoId, pr, mergedAt, merge, review ? Number(review.id) : null, at).changes,
    );
  }
  return changed;
}

export function mergedReviewRecords(db: Db, repoId: string): MergedReviewRecord[] {
  return db
    .prepare(
      "SELECT * FROM code_health_merged_reviews WHERE repo_id = ? ORDER BY pr_number LIMIT ?",
    )
    .all(repoId, MERGED_PRS_MAX)
    .map((row) => ({
      repoId,
      pr: Number(row.pr_number),
      mergedAt: Number(row.merged_at),
      merge: row.merge_kind as MergeKind,
      reviewId: row.review_id === null ? null : Number(row.review_id),
      recordedAt: Number(row.recorded_at),
    }));
}
