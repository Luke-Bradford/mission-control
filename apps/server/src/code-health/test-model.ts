import { createHash } from "node:crypto";
import {
  type CodeHealthCiClassification,
  type CodeHealthTestAttempt,
  codeHealthTestRate,
} from "@mc/core";
import type { testAttemptSource } from "./test-reports.ts";

type Source = ReturnType<typeof testAttemptSource>;
type Row = Record<string, unknown>;
interface Attempt extends CodeHealthTestAttempt {
  file: string;
  name: string;
  workflowRun: string;
  jobRun: string;
  runAttempt: number;
  executionOrder: number | null;
  durationMs: number | null;
  environmentKey: string;
  seriesKey: string;
  cause: "unknown" | "infrastructure" | "test";
  causeEvidence: string;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const states = new Set(["passed", "failed", "skipped", "cancelled", "not-run"]);
const causes = new Set(["unknown", "infrastructure", "test"]);
function text(row: Row, key: string): string {
  if (typeof row[key] !== "string") throw new Error("Invalid stored test evidence");
  return row[key] as string;
}
function numeric(row: Row, key: string, nullable = false): number | null {
  if (nullable && row[key] === null) return null;
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Invalid stored test evidence");
  return value;
}
function attempt(row: Row): Attempt {
  const state = text(row, "state"),
    cause = text(row, "cause");
  if (!states.has(state) || !causes.has(cause)) throw new Error("Invalid stored test evidence");
  const unit = row.duration_unit;
  if (unit !== null && unit !== "ms" && unit !== "s")
    throw new Error("Invalid stored duration evidence");
  if (row.environment !== null && typeof row.environment !== "string")
    throw new Error("Invalid stored test environment");
  return {
    attemptId: text(row, "id"),
    testId: text(row, "test_id"),
    repoId: text(row, "repo_id"),
    headSha: text(row, "head_sha"),
    workflow: text(row, "workflow"),
    job: text(row, "job"),
    file: text(row, "file"),
    name: text(row, "name"),
    state: state as Attempt["state"],
    completedAt: numeric(row, "completed_at", true),
    duration: numeric(row, "duration", true),
    durationUnit: unit,
    environment: row.environment as string | null,
    workflowRun: text(row, "workflow_run"),
    jobRun: text(row, "job_run"),
    runAttempt: numeric(row, "run_attempt") as number,
    executionOrder: numeric(row, "execution_order", true),
    durationMs: numeric(row, "duration_ms", true),
    environmentKey: text(row, "environment_key"),
    seriesKey: text(row, "series_key"),
    cause: cause as Attempt["cause"],
    causeEvidence: text(row, "cause_evidence"),
  };
}
const executed = (row: Attempt) => row.state === "passed" || row.state === "failed";

/** Explicit attempt metadata orders retries; report-array position and poll time never do. */
function ordered(rows: Attempt[]): Attempt[] | null {
  if (rows.some((row) => row.executionOrder === null)) return null;
  const seen = new Set<string>(),
    jobs = new Map<number, string>();
  for (const row of rows) {
    const key = JSON.stringify([row.runAttempt, row.executionOrder]);
    if (seen.has(key) || (jobs.has(row.runAttempt) && jobs.get(row.runAttempt) !== row.jobRun))
      return null;
    seen.add(key);
    jobs.set(row.runAttempt, row.jobRun);
  }
  const runs = [...jobs.keys()].sort((a, b) => a - b);
  if (runs.some((value, i) => i > 0 && value !== runs[i - 1] + 1)) return null;
  const sorted = rows
    .slice()
    .sort(
      (a, b) => a.runAttempt - b.runAttempt || (a.executionOrder ?? 0) - (b.executionOrder ?? 0),
    );
  if (
    sorted.some(
      (row, i) =>
        i > 0 &&
        row.completedAt !== null &&
        sorted[i - 1].completedAt !== null &&
        row.completedAt < (sorted[i - 1].completedAt ?? 0),
    )
  )
    return null;
  return sorted;
}
/** Nearest-rank quantile, over documented milliseconds in one test/file/environment scope. */
const percentile = (values: number[], p: number) =>
  values[Math.max(0, Math.ceil(values.length * p) - 1)];

export function deriveTestHealth(repoId: string, source: Source, qaRows: readonly Row[] = []) {
  const rows = source.rows.map(attempt).filter((row) => row.repoId === repoId);
  const verifiedFlaky = new Set(
    qaRows
      .filter((row) => row.repo_id === repoId && row.judgement === "flaky")
      .map((row) => JSON.stringify([row.test_id, row.head_sha])),
  );
  const groups = new Map<string, Attempt[]>(),
    durationGroups = new Map<string, Attempt[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.testId, row.seriesKey]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
    if (executed(row) && row.durationMs !== null && row.environment !== null) {
      const durationKey = JSON.stringify([row.testId, row.file, row.environmentKey]);
      const durations = durationGroups.get(durationKey) ?? [];
      durations.push(row);
      durationGroups.set(durationKey, durations);
    }
  }
  const disruption = [...groups.values()]
    .flatMap((group) => {
      const observed = group.filter(executed),
        failed = observed.filter((row) => row.state === "failed");
      if (!failed.length) return [];
      const first = group[0],
        sequence = ordered(observed);
      let classification: CodeHealthCiClassification = "candidate";
      if (failed.every((row) => row.cause === "infrastructure" && row.causeEvidence.trim()))
        classification = "infrastructure";
      else if (sequence && source.complete) {
        const failure = sequence.findIndex((row) => row.state === "failed");
        const recovered = sequence.slice(failure + 1).some((row) => row.state === "passed");
        const verified = verifiedFlaky.has(JSON.stringify([first.testId, first.headSha]));
        if (recovered && verified) classification = "confirmed-flaky";
        else if (observed.length >= 2 && failed.length === observed.length)
          classification = "consistently-failing";
      }
      return [
        {
          id: `ctd_${hash([first.testId, first.seriesKey])}`,
          testId: first.testId,
          headSha: first.headSha,
          seriesKey: first.seriesKey,
          label: `${first.name || "Redacted test"} · ${first.job} · ${first.environment ?? "environment unknown"} · run ${first.workflowRun}`,
          classification,
          rate: codeHealthTestRate(observed, repoId, source.complete),
          ordered: sequence !== null,
        },
      ];
    })
    .sort((a, b) => b.rate.numerator - a.rate.numerator || a.id.localeCompare(b.id));
  const durations = [...durationGroups.values()]
    .map((group) => {
      const first = group[0],
        values = group.map((row) => row.durationMs as number).sort((a, b) => a - b);
      return {
        testId: first.testId,
        file: first.file,
        label: first.name,
        environment: first.environment as string,
        environmentKey: first.environmentKey,
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        samples: values.length,
      };
    })
    .sort((a, b) => b.p95Ms - a.p95Ms || a.testId.localeCompare(b.testId));
  return {
    rate: source.reports ? codeHealthTestRate(rows, repoId, source.complete) : null,
    executed: rows.filter(executed).length,
    notExecuted: rows.filter((row) => !executed(row)).length,
    unnormalised: rows.filter((row) => executed(row) && row.durationMs === null).length,
    disruption: disruption.slice(0, 50),
    omittedDisruption: Math.max(0, disruption.length - 50),
    durations: durations.slice(0, 50),
    omittedDurations: Math.max(0, durations.length - 50),
  };
}
