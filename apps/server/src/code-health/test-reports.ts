/** Imported result data only: no file, URL, workflow, seat or schedule is executed. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { codeHealthDurationMs } from "@mc/core";
import { z } from "zod";
import { cleanCodeHealth } from "./clean.ts";
import { CodeHealthReadError } from "./error.ts";
import { riskPath } from "./risk.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
export const TEST_REPORT_BYTES_MAX = 1024 * 1024;
export const TEST_REPORT_CASES_MAX = 2000;
const text = z.string().trim().min(1).max(500);
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const time = z.number().int().min(0).max(8640000000000000);
const file = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      riskPath(value) &&
      ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    "A relative test file is required",
  );
const Case = z.strictObject({
  /** A stable reporter identity; the server also binds it to file/suite/name. */
  testId: identity,
  file,
  suite: z.string().max(500),
  name: text,
  /** Identifies a distinct retry, never an array/declaration position. */
  attemptId: identity,
  executionOrder: z.number().int().min(0).max(1000000).nullable(),
  state: z.enum(["passed", "failed", "skipped", "cancelled", "not-run"]),
  completedAt: time.nullable(),
  duration: z.number().min(0).max(86400000).nullable(),
  durationUnit: z.enum(["ms", "s"]).nullable(),
});
export const TestReport = z.strictObject({
  version: z.literal(1),
  sourceFormat: z.enum(["normalized-v1", "vitest-json-final"]).optional(),
  collectionNote: z.string().max(1000).optional(),
  repo: identity,
  headSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/i)
    .transform((value) => value.toLowerCase()),
  workflow: text,
  workflowRun: z.string().regex(/^[1-9][0-9]{0,19}$/),
  job: text,
  jobRun: z.string().regex(/^[1-9][0-9]{0,19}$/),
  runAttempt: z.number().int().min(1).max(10000),
  environment: text.nullable(),
  completedAt: time,
  /** Null explicitly means incomplete collection, rather than a complete zero. */
  expectedAttempts: z.number().int().min(0).max(TEST_REPORT_CASES_MAX).nullable(),
  cause: z.enum(["unknown", "infrastructure", "test"]).default("unknown"),
  causeEvidence: z.string().max(1000).default(""),
  cases: z.array(Case).max(TEST_REPORT_CASES_MAX),
});
export type TestReportInput = z.infer<typeof TestReport>;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

export function installTestReports(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS code_health_test_reports (
    repo_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, head_sha TEXT NOT NULL,
    workflow TEXT NOT NULL, workflow_run TEXT NOT NULL, job TEXT NOT NULL, job_run TEXT NOT NULL,
    run_attempt INTEGER NOT NULL, environment TEXT, environment_key TEXT NOT NULL, series_key TEXT NOT NULL, completed_at INTEGER NOT NULL,
    expected_attempts INTEGER, cause TEXT NOT NULL, cause_evidence TEXT NOT NULL,
    received_at INTEGER NOT NULL, actor TEXT NOT NULL, source_format TEXT NOT NULL, collection_note TEXT NOT NULL, PRIMARY KEY(repo_id,id)
  );
  CREATE TABLE IF NOT EXISTS code_health_test_attempts (
    repo_id TEXT NOT NULL, report_id TEXT NOT NULL, id TEXT NOT NULL, test_id TEXT NOT NULL,
    source_test_id TEXT NOT NULL, test_signature TEXT NOT NULL, file TEXT NOT NULL, suite TEXT NOT NULL, name TEXT NOT NULL,
    execution_order INTEGER, state TEXT NOT NULL, completed_at INTEGER, duration REAL,
    duration_unit TEXT, duration_ms REAL, PRIMARY KEY(repo_id,id)
  );
  CREATE INDEX IF NOT EXISTS code_health_test_report_window ON code_health_test_reports(repo_id,completed_at,id);
  CREATE INDEX IF NOT EXISTS code_health_test_attempt_report ON code_health_test_attempts(repo_id,report_id,id);
  CREATE INDEX IF NOT EXISTS code_health_test_attempt_test ON code_health_test_attempts(repo_id,test_id,id);`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS code_health_test_source_identity ON code_health_test_attempts(repo_id,source_test_id,report_id)",
  );
}

/** Caller wraps this in one Store transaction. Conflicting immutable identities fail closed. */
export function importTestReport(
  db: Db,
  raw: unknown,
  actor: string,
  at: number,
  knownSecrets: readonly string[],
) {
  if (
    !Number.isSafeInteger(at) ||
    at < 0 ||
    at > 8640000000000000 ||
    !z.string().trim().min(1).max(200).safeParse(actor).success
  )
    throw new CodeHealthReadError(400, "Invalid test-report actor or import time.");
  if (Buffer.byteLength(JSON.stringify(raw) ?? "") > TEST_REPORT_BYTES_MAX)
    throw new CodeHealthReadError(413, "Test report exceeds the one MiB limit.");
  const parsed = TestReport.safeParse(raw);
  if (!parsed.success) throw new CodeHealthReadError(400, "Invalid version 1 test report.");
  const source = parsed.data;
  if (
    source.completedAt > at + 300000 ||
    source.cases.some((row) => row.completedAt !== null && row.completedAt > source.completedAt)
  )
    throw new CodeHealthReadError(400, "Test attempt times exceed the report completion time.");
  if (source.expectedAttempts !== null && source.expectedAttempts !== source.cases.length)
    throw new CodeHealthReadError(400, "Declared test-attempt count does not match the report.");
  if (source.cause !== "unknown" && !source.causeEvidence.trim())
    throw new CodeHealthReadError(400, "A recorded cause requires source evidence.");
  const reportId = `ctr_${hash([source.repo, source.workflowRun, source.jobRun, source.runAttempt])}`;
  const fingerprint = hash({
    ...source,
    sourceFormat: source.sourceFormat ?? "normalized-v1",
    collectionNote: source.collectionNote ?? "",
    cases: source.cases.slice().sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
  });
  const existing = db
    .prepare("SELECT fingerprint FROM code_health_test_reports WHERE repo_id=? AND id=?")
    .get(source.repo, reportId);
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new CodeHealthReadError(
        409,
        "This test-report identity already has different evidence.",
      );
    return { id: reportId, attempts: source.cases.length, reused: true };
  }
  const rows = source.cases.map((row) => ({
    ...row,
    id: hash([source.repo, source.workflowRun, source.jobRun, source.runAttempt, row.attemptId]),
    testIdentity: hash([source.repo, row.testId]),
    signature: hash([row.file, row.suite, row.name]),
  }));
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new CodeHealthReadError(400, "Test-attempt identities must be unique within a report.");
  const identities = new Map<string, string>();
  for (const row of rows) {
    const previous = identities.get(row.testId);
    if (previous !== undefined && previous !== row.signature)
      throw new CodeHealthReadError(409, "A stable test identity names different tests.");
    identities.set(row.testId, row.signature);
    const old = db
      .prepare(`SELECT a.test_signature FROM code_health_test_attempts a
      JOIN code_health_test_reports r ON r.repo_id=a.repo_id AND r.id=a.report_id
      WHERE a.repo_id=? AND a.source_test_id=? AND r.head_sha=? LIMIT 1`)
      .get(source.repo, hash(row.testId), source.headSha);
    if (old && old.test_signature !== row.signature)
      throw new CodeHealthReadError(409, "A stable test identity changed its file or name.");
  }
  const clean = cleanCodeHealth(source, knownSecrets) as TestReportInput;
  db.prepare(
    "INSERT INTO code_health_test_reports VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    source.repo,
    reportId,
    fingerprint,
    source.headSha,
    clean.workflow,
    source.workflowRun,
    clean.job,
    source.jobRun,
    source.runAttempt,
    clean.environment,
    hash(source.environment),
    hash([
      source.repo,
      source.headSha,
      source.workflow,
      source.workflowRun,
      source.job,
      source.environment,
    ]),
    source.completedAt,
    source.expectedAttempts,
    source.cause,
    clean.causeEvidence,
    at,
    cleanCodeHealth(actor, knownSecrets) as string,
    source.sourceFormat ?? "normalized-v1",
    clean.collectionNote ?? "",
  );
  const insert = db.prepare(
    "INSERT INTO code_health_test_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const [index, row] of rows.entries()) {
    const shown = clean.cases[index];
    insert.run(
      source.repo,
      reportId,
      row.id,
      row.testIdentity,
      hash(row.testId),
      row.signature,
      shown.file,
      shown.suite,
      shown.name,
      row.executionOrder,
      row.state,
      row.completedAt,
      row.duration,
      row.durationUnit,
      row.state === "passed" || row.state === "failed"
        ? codeHealthDurationMs(row.duration, row.durationUnit, source.environment)
        : null,
    );
  }
  return { id: reportId, attempts: rows.length, reused: false };
}

export function testAttemptSource(db: Db, repo: string, from: number, until: number) {
  const reports = db
    .prepare(
      "SELECT COUNT(*) AS n,MIN(completed_at) AS first_at,MAX(completed_at) AS last_at, SUM(expected_attempts IS NULL) AS partial FROM code_health_test_reports WHERE repo_id=? AND completed_at>=? AND completed_at<?",
    )
    .get(repo, from, until);
  const rows = db
    .prepare(`SELECT a.*,r.head_sha,r.workflow,r.workflow_run,r.job,r.job_run,r.run_attempt,
    r.source_format,r.collection_note,r.environment,r.environment_key,r.series_key,r.completed_at AS report_completed_at,r.cause,r.cause_evidence,r.actor
    FROM code_health_test_attempts a JOIN code_health_test_reports r ON r.repo_id=a.repo_id AND r.id=a.report_id
    WHERE a.repo_id=? AND r.completed_at>=? AND r.completed_at<? ORDER BY r.completed_at,r.id,a.id LIMIT 20001`)
    .all(repo, from, until);
  return {
    reports: Number(reports?.n ?? 0),
    observedFrom: reports?.first_at as number | null,
    observedUntil: reports?.last_at as number | null,
    complete: Number(reports?.partial ?? 0) === 0 && rows.length <= 20000,
    truncated: rows.length > 20000,
    rows: rows.slice(0, 20000),
  };
}

/** Overview needs only collection state, never the 20,000-row attempt payload. */
export function testCollectionCoverage(db: Db, repo: string, from: number, until: number) {
  const summary = db
    .prepare(`SELECT COUNT(*) AS reports, SUM(expected_attempts IS NULL) AS partial
    FROM code_health_test_reports WHERE repo_id=? AND completed_at>=? AND completed_at<?`)
    .get(repo, from, until);
  const exists = (extra: string) =>
    db
      .prepare(`SELECT 1 FROM code_health_test_reports r
    JOIN code_health_test_attempts a ON a.repo_id=r.repo_id AND a.report_id=r.id
    WHERE r.repo_id=? AND r.completed_at>=? AND r.completed_at<? ${extra} LIMIT 1`)
      .get(repo, from, until) !== undefined;
  return {
    reports: Number(summary?.reports ?? 0),
    partialReports: Number(summary?.partial ?? 0),
    hasAttempts: exists(""),
    hasExecuted: exists("AND a.state IN ('passed','failed')"),
    unorderedExecuted: exists("AND a.state IN ('passed','failed') AND a.execution_order IS NULL"),
  };
}
