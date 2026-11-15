// Review and finding queries: the review tables only. Store delegates here.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  FindingResolution,
  QaFindingView,
  QaReviewRoundView,
  ReportedTest,
  ReviewCheck,
  ReviewRow,
  ReviewShotView,
  ReviewState,
  StoredFinding,
} from "@mc/core";
import { toReview } from "./rows.ts";

type Row = Record<string, SQLInputValue>;

// The queries over the review tables; the review methods of `Store` (store.ts) delegate here.

/** Every review of a PR, oldest first. */
export function reviewsOfPr(db: DatabaseSync, repoId: string, prNumber: number): ReviewRow[] {
  const rows = db
    .prepare("SELECT * FROM reviews WHERE repo_id = ? AND pr_number = ? ORDER BY id")
    .all(repoId, prNumber) as Row[];
  return rows.map(toReview);
}

export function review(db: DatabaseSync, id: number): ReviewRow | null {
  const row = db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as Row | undefined;
  return row ? toReview(row) : null;
}

/** Moves a queued review to another review seat; true only when it was still queued. The caller wraps it in a transaction. */
export function moveQueuedReview(
  db: DatabaseSync,
  id: number,
  seatId: string,
  at: number,
): boolean {
  const moved =
    db.prepare("UPDATE reviews SET seat_id = ? WHERE id = ? AND state = 'queued'").run(seatId, id)
      .changes === 1;
  if (moved)
    db.prepare("INSERT OR REPLACE INTO review_moves (review_id, seat_id, at) VALUES (?, ?, ?)").run(
      id,
      seatId,
      at,
    );
  return moved;
}

/** Whether FLIGHT assigned the queued review to its current seat. */
export function reviewMoved(db: DatabaseSync, id: number): boolean {
  return db.prepare("SELECT 1 FROM review_moves WHERE review_id = ?").get(id) !== undefined;
}

/** The review screenshot ids of reviews of open PRs. */
export function reviewShotIdsOfOpenPrs(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db
        .prepare(
          `SELECT s.shot_id FROM review_shots s JOIN reviews v ON v.id = s.review_id
               JOIN pull_requests p ON p.repo_id = v.repo_id AND p.number = v.pr_number AND p.state = 'open'`,
        )
        .all() as Row[]
    ).map((r) => r.shot_id as string),
  );
}

/** Every review of an external PR (author id `external-pr:...`) that has not been superseded. */
export function externalReviewRows(db: DatabaseSync): ReviewRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM reviews WHERE author_run_id LIKE 'external-pr:%' AND state != 'superseded' ORDER BY id",
    )
    .all() as Row[];
  return rows.map(toReview);
}

export function reviewsOfRun(db: DatabaseSync, authorRunId: string): ReviewRow[] {
  const rows = db
    .prepare("SELECT * FROM reviews WHERE author_run_id = ? ORDER BY id")
    .all(authorRunId) as Row[];
  return rows.map(toReview);
}

/** The latest review of a PR that has reported, else null. */
export function latestReportedReview(
  db: DatabaseSync,
  repoId: string,
  prNumber: number,
): ReviewRow | null {
  const row = db
    .prepare(
      `SELECT * FROM reviews WHERE repo_id = ? AND pr_number = ? AND state = 'reported'
         ORDER BY ended_at DESC, id DESC LIMIT 1`,
    )
    .get(repoId, prNumber) as Row | undefined;
  return row ? toReview(row) : null;
}

/** The review the run (a review run) performs, else null. */
export function reviewOfRun(db: DatabaseSync, reviewRunId: string): ReviewRow | null {
  const row = db.prepare("SELECT * FROM reviews WHERE run_id = ?").get(reviewRunId) as
    | Row
    | undefined;
  return row ? toReview(row) : null;
}

export function reviewsIn(
  db: DatabaseSync,
  states: readonly ReviewState[],
  window?: { repo: string; since: number; until: number },
): ReviewRow[] {
  if (states.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT * FROM reviews WHERE state IN (${states.map(() => "?").join(", ")})
         ${window ? "AND repo_id = ? AND ended_at >= ? AND ended_at <= ?" : ""}
         ORDER BY created_at, id`,
    )
    .all(...states, ...(window ? [window.repo, window.since, window.until] : [])) as Row[];
  return rows.map(toReview);
}

/** The files the author changed since the previous reviewed sha, for tagging late findings. */
export function setReviewChangedSince(
  db: DatabaseSync,
  reviewId: number,
  files: readonly string[],
): void {
  db.prepare("UPDATE reviews SET changed_since = ? WHERE id = ?").run(
    JSON.stringify(files),
    reviewId,
  );
}

/** Why this review ran without an install ("reviewed, not installed"), kept with the review. */
export function setReviewInstallNote(db: DatabaseSync, reviewId: number, note: string): void {
  db.prepare("UPDATE reviews SET install_note = ? WHERE id = ?").run(note, reviewId);
}

export function findingsOf(db: DatabaseSync, reviewId: number): StoredFinding[] {
  const rows = db
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
    category: (r.category as StoredFinding["category"]) ?? undefined,
    state: r.state as StoredFinding["state"],
    late: r.late === 1,
    resolution: (r.resolution as StoredFinding["resolution"]) ?? undefined,
    resolvedReviewId: (r.resolved_review_id as number | null) ?? undefined,
  }));
}

/**
 * Findings of reviews in the requested window, plus unresolved findings on PRs still open now.
 * The latter protects an open card from losing its blocking review evidence as it ages.
 */
export function qaFindings(db: DatabaseSync, since: number): QaFindingView[] {
  const rows = db
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

/** Completed review rounds in the requested window, plus the full history of open PRs. */
export function qaReviewRounds(db: DatabaseSync, since: number): QaReviewRoundView[] {
  const rows = db
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
    verdict: JSON.parse(r.verdict as string) as QaReviewRoundView["verdict"],
    blocking: r.blocking as number,
    minor: r.minor as number,
    endedAt: r.ended_at as number,
    screenshots: reviewShots(db, r.id as number),
  }));
}

/** Records a screenshot RETRO took on a review's preview; `shotId` names its stored PNG. */
export function addReviewShot(
  db: DatabaseSync,
  reviewId: number,
  shot: { shotId: string; label: string; width: number; theme: ReviewShotView["theme"] },
  at: number,
): void {
  db.prepare(
    "INSERT INTO review_shots (review_id, shot_id, label, width, theme, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(reviewId, shot.shotId, shot.label, shot.width, shot.theme, at);
}

export function reviewShots(db: DatabaseSync, reviewId: number): ReviewShotView[] {
  return (
    db
      .prepare(
        "SELECT shot_id, label, width, theme, at FROM review_shots WHERE review_id = ? ORDER BY id",
      )
      .all(reviewId) as Row[]
  ).map((r) => ({
    id: r.shot_id as string,
    label: r.label as string,
    width: r.width as number,
    theme: r.theme as ReviewShotView["theme"],
    at: r.at as number,
  }));
}

export function reviewChecks(db: DatabaseSync, reviewId: number): ReviewCheck[] {
  return (
    db
      .prepare(
        "SELECT check_id, result, note FROM review_checks WHERE review_id = ? ORDER BY check_id",
      )
      .all(reviewId) as Row[]
  ).map((r) => ({
    check: r.check_id as ReviewCheck["check"],
    result: r.result as ReviewCheck["result"],
    ...(r.note === null ? {} : { note: r.note as string }),
  }));
}

export function reviewTests(
  db: DatabaseSync,
  reviewId: number,
): (Omit<ReportedTest, "file"> & { file: string | null })[] {
  return (
    db
      .prepare(
        "SELECT command, file, passed, failed, skipped, duration FROM review_tests WHERE review_id = ? ORDER BY id",
      )
      .all(reviewId) as Row[]
  ).map((r) => ({
    command: r.command as string,
    file: r.file as string | null,
    passed: r.passed as number,
    failed: r.failed as number,
    skipped: r.skipped as number,
    duration: r.duration as number,
  }));
}

export function reviewResolutions(
  db: DatabaseSync,
  reviewId: number,
): { reviewId: number; pos: number; outcome: FindingResolution["outcome"] }[] {
  return (
    db
      .prepare(
        "SELECT prior_review_id, finding_pos, outcome FROM review_resolutions WHERE review_id = ? ORDER BY prior_review_id, finding_pos",
      )
      .all(reviewId) as Row[]
  ).map((r) => ({
    reviewId: r.prior_review_id as number,
    pos: r.finding_pos as number,
    outcome: r.outcome as FindingResolution["outcome"],
  }));
}

/** Reviews whose run has not ended although the review no longer needs it. */
export function reviewsWithLiveRun(db: DatabaseSync): ReviewRow[] {
  const rows = db
    .prepare(
      `SELECT reviews.* FROM reviews JOIN runs ON runs.id = reviews.run_id
         WHERE runs.ended_at IS NULL AND reviews.state NOT IN ('starting', 'running')
         ORDER BY reviews.id`,
    )
    .all() as Row[];
  return rows.map(toReview);
}
