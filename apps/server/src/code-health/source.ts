import type { DatabaseSync } from "node:sqlite";
import type { CodeHealthFinding, CodeHealthReviewRound } from "@mc/core";
import { MAP_COUPLING_PR_FILES_MAX } from "../map/history-rules.ts";
import { gitFileMetrics } from "./git-store.ts";
import { datedPrFiles, reviewedFileMembership } from "./risk.ts";
import { sizeEvidence, sizeHistoryEvidence } from "./size-store.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
type Row = Record<string, unknown>;
const SOURCE_ROWS_MAX = 20_000;
export type CodeHealthEvidenceKind =
  | "review-rounds"
  | "findings"
  | "sizes"
  | "ci"
  | "durations"
  | "merged-files"
  | "reviewed-files"
  | "git-numstats"
  | "size-history"
  | "test-reports"
  | "test-attempts"
  | "test-durations"
  | "test-qa";

/** Revisions track relevant source writes, including writes from another SQLite connection. */
export function installCodeHealthRevisions(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS code_health_revisions (
    repo_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0
  )`);
  const tables = [
    ["code_health_recommendations", "direct"],
    ["code_health_test_reports", "direct"],
    ["code_health_test_attempts", "direct"],
    ["code_health_test_qa", "direct"],
    ["reviews", "direct"],
    ["review_findings", "review"],
    ["review_resolutions", "review"],
    ["review_tests", "review"],
    ["ci_runs", "direct"],
    ["pull_requests", "direct"],
    ["pr_history", "direct"],
    ["pr_files", "direct"],
    ["code_health_file_memberships", "direct"],
    ["code_health_git_sources", "direct"],
    ["code_health_size_sources", "direct"],
    ["code_health_size_snapshots", "direct"],
    ["code_health_file_sizes", "direct"],
    ["map_cache", "global"],
  ] as const;
  for (const [table, scope] of tables) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const aliases =
        operation === "UPDATE" ? ["OLD", "NEW"] : [operation === "DELETE" ? "OLD" : "NEW"];
      const statements = aliases
        .map((alias) => {
          const repo =
            scope === "direct"
              ? `${alias}.repo_id`
              : scope === "review"
                ? `(SELECT repo_id FROM reviews WHERE id = ${alias}.review_id)`
                : "'*'";
          return `INSERT INTO code_health_revisions (repo_id, version)
          SELECT ${repo}, 1 WHERE ${repo} IS NOT NULL
          ON CONFLICT(repo_id) DO UPDATE SET version = version + 1;`;
        })
        .join("\n");
      db.exec(`CREATE TRIGGER IF NOT EXISTS code_health_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} BEGIN ${statements} END`);
    }
  }
}

export function codeHealthSourceRevision(db: Db, repoId: string): string {
  return (
    db
      .prepare(`SELECT repo_id, version FROM code_health_revisions
    WHERE repo_id IN (?, '*') ORDER BY repo_id`)
      .all(repoId) as Row[]
  )
    .map((row) => `${row.repo_id}:${row.version}`)
    .join("/");
}

function bounded(rows: Row[]): Row[] {
  if (rows.length > SOURCE_ROWS_MAX)
    throw new Error("Code-health source exceeds the bounded query limit");
  return rows;
}

/** Only reported reviews form this cohort. Window filtering uses the parent report's time. */
export function codeHealthReviewSource(db: Db, repoId: string, from: number, until: number) {
  const rows = bounded(
    db
      .prepare(`SELECT v.id, v.pr_number, v.sha, v.round, v.ended_at, p.head_sha AS current_head_sha FROM reviews v
    LEFT JOIN pull_requests p ON p.repo_id = v.repo_id AND p.number = v.pr_number
    WHERE v.repo_id = ? AND v.state = 'reported' AND v.ended_at >= ? AND v.ended_at < ?
    ORDER BY ended_at, id LIMIT ?`)
      .all(repoId, from, until, SOURCE_ROWS_MAX + 1) as Row[],
  );
  const reviews: CodeHealthReviewRound[] = rows.map((row) => ({
    reviewId: String(row.id),
    repoId,
    pr: row.pr_number as number,
    headSha: row.sha as string,
    currentHeadSha: row.current_head_sha as string | null,
    round: row.round as number,
    state: "reported",
  }));
  const findings: CodeHealthFinding[] = bounded(
    db
      .prepare(`SELECT f.id, f.review_id,
    f.file, f.category, f.summary, f.fix, f.state, f.resolution, f.resolved_review_id, v.pr_number, v.sha,
    p.head_sha AS current_head_sha
    FROM review_findings f JOIN reviews v ON v.id = f.review_id
    LEFT JOIN pull_requests p ON p.repo_id = v.repo_id AND p.number = v.pr_number
    WHERE v.repo_id = ? AND v.state = 'reported' AND v.ended_at >= ? AND v.ended_at < ?
    ORDER BY f.id LIMIT ?`)
      .all(repoId, from, until, SOURCE_ROWS_MAX + 1) as Row[],
  ).map((row) => ({
    findingId: String(row.id),
    repoId,
    pr: row.pr_number as number,
    reviewId: String(row.review_id),
    headSha: row.sha as string,
    currentHeadSha: row.current_head_sha as string | null,
    file: row.file as string,
    category: row.category as string | null,
    summary: row.summary as string,
    fix: row.fix as string,
    state: row.state as CodeHealthFinding["state"],
    resolution: row.resolution as CodeHealthFinding["resolution"],
    resolvedReviewId: row.resolved_review_id as number | null,
    // The source links a resolution to a prior finding, not reliably to a new finding position.
    carry: { kind: "unknown" },
  }));
  return {
    reviews,
    findings,
    observedFrom: rows.length ? (rows[0].ended_at as number) : null,
    observedUntil: rows.length ? (rows[rows.length - 1].ended_at as number) : null,
  };
}

/** Stored job observations stay distinct from chronological test attempts. */
export function codeHealthCiSource(db: Db, repoId: string, from: number, until: number) {
  const coverage = db
    .prepare(`SELECT COUNT(*) AS observations, MIN(at) AS first_at,
    MAX(at) AS last_at FROM ci_runs WHERE repo_id = ? AND at >= ? AND at < ?`)
    .get(repoId, from, until) as Row;
  const mixed = db
    .prepare(`SELECT COUNT(*) AS n FROM (
    SELECT sha, COALESCE(workflow, '') AS workflow_key, name FROM ci_runs
    WHERE repo_id = ? AND at >= ? AND at < ? AND conclusion IN ('SUCCESS', 'FAILURE')
    GROUP BY sha, workflow_key, name HAVING COUNT(DISTINCT conclusion) = 2
  )`)
    .get(repoId, from, until) as { n: number };
  const unnormalised = db
    .prepare(`SELECT COUNT(*) AS n FROM review_tests t
    JOIN reviews v ON v.id = t.review_id
    WHERE v.repo_id = ? AND v.state = 'reported' AND v.ended_at >= ? AND v.ended_at < ?`)
    .get(repoId, from, until) as { n: number };
  return {
    observations: coverage.observations as number,
    observedFrom: coverage.first_at as number | null,
    observedUntil: coverage.last_at as number | null,
    mixedJobCandidates: mixed.n,
    unnormalisedCommandRecords: unnormalised.n,
  };
}

function validateSizeRows(rows: readonly { path: unknown; lines: unknown }[]): void {
  for (const row of rows) {
    if (
      typeof row.path !== "string" ||
      !row.path ||
      row.path.startsWith("/") ||
      row.path.split("/").includes("..") ||
      typeof row.lines !== "number" ||
      !Number.isSafeInteger(row.lines) ||
      row.lines < 0
    )
      throw new Error("Code-health size snapshot contains invalid file data");
  }
}

/** Read only the configured checkout's cached tree, projecting bounded size rows in SQLite. */
export function codeHealthSizeSource(db: Db, checkout: string) {
  const cache = db
    .prepare(`SELECT key, json_valid(value) AS valid,
      CASE WHEN json_valid(value) THEN json_type(value, '$.tree') END AS tree_kind FROM map_cache
    WHERE kind = 'tree' AND scope = ? ORDER BY rowid DESC LIMIT 1`)
    .get(checkout) as { key: string; valid: number; tree_kind: string | null } | undefined;
  if (!cache) return null;
  if (!cache.valid || cache.tree_kind !== "array" || !/^[a-f0-9]{40,64}$/i.test(cache.key))
    throw new Error("Code-health size snapshot is unreadable");
  const rows = db
    .prepare(`SELECT json_extract(j.value, '$.path') AS path,
    json_extract(j.value, '$.lines') AS lines FROM map_cache c, json_each(c.value, '$.tree') j
    WHERE c.kind = 'tree' AND c.scope = ? AND c.key = ? ORDER BY lines DESC, path LIMIT 50`)
    .all(checkout, cache.key) as { path: string; lines: number }[];
  validateSizeRows(rows);
  return { analysedSha: cache.key, files: rows };
}

/** Page one whitelisted source, with a single extra row for the next-page indicator. */
export function codeHealthEvidenceSource(
  db: Db,
  query: {
    repoId: string;
    kind: CodeHealthEvidenceKind;
    from: number;
    until: number;
    offset: number;
    limit: number;
    checkout?: string;
    sha?: string;
    file?: string;
    otherFile?: string;
    testId?: string;
    seriesKey?: string;
    environmentKey?: string;
    category?: string;
    findingSummary?: string;
    findingFix?: string;
    pr?: number;
    at?: number;
  },
): Row[] {
  if (
    !Number.isSafeInteger(query.offset) ||
    query.offset < 0 ||
    query.offset >= SOURCE_ROWS_MAX ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 50
  )
    throw new Error("Invalid code-health evidence page");
  const args = [query.repoId, query.from, query.until, query.limit + 1, query.offset];
  if (query.kind === "test-reports") {
    return db
      .prepare(`SELECT id AS reportId,head_sha AS headSha,workflow,workflow_run AS workflowRun,job,job_run AS jobRun,
      run_attempt AS runAttempt,environment,completed_at AS completedAt,expected_attempts AS expectedAttempts,
      source_format AS sourceFormat,collection_note AS collectionNote,cause,cause_evidence AS causeEvidence,received_at AS importedAt,actor
      FROM code_health_test_reports WHERE repo_id=? AND completed_at>=? AND completed_at<? ORDER BY completed_at,id LIMIT ? OFFSET ?`)
      .all(...args) as Row[];
  }
  if (query.kind === "test-qa") {
    const extras = [] as (string | number)[];
    let where = "";
    if (query.testId) {
      where += " AND test_id=?";
      extras.push(query.testId);
    }
    if (query.sha) {
      where += " AND head_sha=?";
      extras.push(query.sha);
    }
    return db
      .prepare(`SELECT id,test_id AS testId,head_sha AS headSha,judgement,reviewer,review_id AS reviewId,
      finding_position AS findingPosition,at,actor,file,line,summary,scenario,fix,spec_evidence AS specEvidence
      FROM code_health_test_qa WHERE repo_id=? AND at>=? AND at<? ${where} ORDER BY at,id LIMIT ? OFFSET ?`)
      .all(
        query.repoId,
        query.from,
        query.until,
        ...extras,
        query.limit + 1,
        query.offset,
      ) as Row[];
  }
  if (query.kind === "test-attempts" || query.kind === "test-durations") {
    const extras = [] as (string | number)[];
    let where =
      query.kind === "test-durations"
        ? " AND a.state IN ('passed','failed') AND a.duration_ms IS NOT NULL"
        : "";
    for (const [value, column] of [
      [query.testId, "a.test_id"],
      [query.sha, "r.head_sha"],
      [query.seriesKey, "r.series_key"],
      [query.environmentKey, "r.environment_key"],
      [query.file, "a.file"],
    ] as const)
      if (value) {
        where += ` AND ${column}=?`;
        extras.push(value);
      }
    // Keep a test/series together, then use only its declared retry positions before paging.
    // Group time and stable IDs order presentation; null/tied positions remain explicitly uncertain.
    return db
      .prepare(`WITH attempts AS (SELECT a.id AS attemptId,a.test_id AS testId,a.file,a.suite,a.name,a.execution_order AS executionOrder,
      a.state,a.completed_at AS completedAt,a.duration,a.duration_unit AS durationUnit,a.duration_ms AS durationMs,
      r.head_sha AS headSha,r.workflow,r.workflow_run AS workflowRun,r.job,r.job_run AS jobRun,r.run_attempt AS runAttempt,
      r.environment,r.completed_at AS reportCompletedAt,r.expected_attempts AS declaredAttempts,
      r.source_format AS sourceFormat,r.collection_note AS collectionNote,r.cause,r.cause_evidence AS causeEvidence,r.received_at AS importedAt,r.actor,
      r.series_key AS seriesKey,MIN(r.completed_at) OVER (PARTITION BY a.test_id,r.series_key) AS groupFirstReport,
      CASE WHEN a.execution_order IS NULL THEN 'missing'
        WHEN COUNT(*) OVER (PARTITION BY a.test_id,r.series_key,r.run_attempt,a.execution_order)>1 THEN 'tied'
        ELSE 'explicit' END AS executionOrderStatus
      FROM code_health_test_attempts a JOIN code_health_test_reports r ON r.repo_id=a.repo_id AND r.id=a.report_id
      WHERE a.repo_id=? AND r.completed_at>=? AND r.completed_at<? ${where})
      SELECT attemptId,testId,file,suite,name,executionOrder,executionOrderStatus,state,completedAt,duration,durationUnit,durationMs,
      headSha,workflow,workflowRun,job,jobRun,runAttempt,environment,reportCompletedAt,declaredAttempts,
      sourceFormat,collectionNote,cause,causeEvidence,importedAt,actor FROM attempts
      ORDER BY groupFirstReport,testId,seriesKey,runAttempt,executionOrder IS NULL,executionOrder,attemptId LIMIT ? OFFSET ?`)
      .all(
        query.repoId,
        query.from,
        query.until,
        ...extras,
        query.limit + 1,
        query.offset,
      ) as Row[];
  }

  if (query.kind === "git-numstats" && !query.checkout) return [];
  if (query.kind === "git-numstats" && query.checkout) {
    const metrics = gitFileMetrics(
      db,
      query.repoId,
      query.checkout,
      query.from,
      query.until,
      query.at ?? Date.now(),
    );
    return metrics.rows
      .flatMap<Row>((row) =>
        row.commit
          ? row.commit.changes
              .filter(
                (change) =>
                  !query.file || change.path === query.file || change.previousPath === query.file,
              )
              .map((change) => ({
                pr: row.pr,
                mergedAt: row.mergedAt,
                sha: row.commit?.sha,
                committedAt: row.commit?.committedAt,
                ...change,
              }))
          : query.file
            ? []
            : [{ pr: row.pr, mergedAt: row.mergedAt, sha: null, available: false }],
      )
      .slice(query.offset, query.offset + query.limit + 1);
  }
  if (query.kind === "merged-files") {
    return datedPrFiles(db, query.repoId, query.from, query.until)
      .filter(
        (row) =>
          (!query.file || row.files.includes(query.file)) &&
          (!query.otherFile ||
            (row.complete &&
              row.files.includes(query.otherFile) &&
              (row.declaredFiles ?? Infinity) <= MAP_COUPLING_PR_FILES_MAX)),
      )
      .slice(query.offset, query.offset + query.limit + 1)
      .map((row) => ({
        pr: row.pr,
        sha: row.sha,
        mergedAt: row.mergedAt,
        collectedAt: row.collectedAt,
        declaredFiles: row.declaredFiles,
        complete: row.complete,
        source: row.source,
      }));
  }
  if (query.kind === "reviewed-files") {
    const cohort = reviewedFileMembership(db, query.repoId, query.from, query.until);
    return cohort.provenance.slice(query.offset, query.offset + query.limit + 1).map((row) => ({
      pr: row.pr,
      sha: row.sha,
      changedFile: query.file && row.complete ? row.files.includes(query.file) : null,
      complete: row.complete,
      cohortMembershipComplete: cohort.complete,
    }));
  }
  if (query.kind === "review-rounds")
    return db
      .prepare(`SELECT id AS reviewId,
    pr_number AS pr, sha, round, state, ended_at AS reportedAt FROM reviews
    WHERE repo_id = ? AND state = 'reported' AND ended_at >= ? AND ended_at < ? ${query.pr === undefined ? "" : "AND pr_number=?"}
    ORDER BY pr_number, round, id LIMIT ? OFFSET ?`)
      .all(
        query.repoId,
        query.from,
        query.until,
        ...(query.pr === undefined ? [] : [query.pr]),
        query.limit + 1,
        query.offset,
      ) as Row[];
  if (query.kind === "findings")
    return db
      .prepare(`SELECT f.id AS findingId,
    f.review_id AS reviewId, f.pos, v.pr_number AS pr, v.sha, f.severity, f.file,
    f.line, f.summary, f.scenario, f.fix, f.category, f.state, f.resolution,
    f.resolved_review_id AS resolvedReviewId, v.ended_at AS reportedAt
    FROM review_findings f JOIN reviews v ON v.id = f.review_id
    WHERE v.repo_id = ? AND v.state = 'reported' AND v.ended_at >= ? AND v.ended_at < ? ${query.file === undefined ? "" : "AND f.file = ?"} ${query.category === undefined ? "" : "AND f.category=?"} ${query.findingSummary === undefined ? "" : "AND f.summary=?"} ${query.findingFix === undefined ? "" : "AND f.fix=?"} ${query.pr === undefined ? "" : "AND v.pr_number=?"}
    ORDER BY v.ended_at, f.id LIMIT ? OFFSET ?`)
      .all(
        query.repoId,
        query.from,
        query.until,
        ...(query.file === undefined ? [] : [query.file]),
        ...(query.category === undefined ? [] : [query.category]),
        ...(query.findingSummary === undefined ? [] : [query.findingSummary]),
        ...(query.findingFix === undefined ? [] : [query.findingFix]),
        ...(query.pr === undefined ? [] : [query.pr]),
        query.limit + 1,
        query.offset,
      ) as Row[];
  if (query.kind === "ci")
    return db
      .prepare(`SELECT run_key AS observationId, sha,
    pr_number AS pr, workflow, name AS job, attempt, state, conclusion,
    first_seen_at AS firstSeenAt, at AS lastSeenAt, url FROM ci_runs
    WHERE repo_id = ? AND at >= ? AND at < ? ORDER BY at, run_key LIMIT ? OFFSET ?`)
      .all(...args) as Row[];
  if (query.kind === "durations")
    return db
      .prepare(`SELECT t.id AS commandRecordId,
    v.id AS reviewId, v.pr_number AS pr, v.sha, t.command, t.file, t.passed, t.failed,
    t.skipped, t.duration AS rawDuration, NULL AS durationUnit, NULL AS environment
    FROM review_tests t JOIN reviews v ON v.id = t.review_id
    WHERE v.repo_id = ? AND v.state = 'reported' AND v.ended_at >= ? AND v.ended_at < ?
    ORDER BY v.ended_at, t.id LIMIT ? OFFSET ?`)
      .all(...args) as Row[];
  if (query.kind === "sizes" && query.checkout && query.sha)
    return sizeEvidence(db, { ...query, checkout: query.checkout, sha: query.sha });
  if (query.kind === "size-history" && query.checkout && query.file)
    return sizeHistoryEvidence(db, { ...query, checkout: query.checkout, file: query.file });
  throw new Error("Invalid code-health evidence source");
}
