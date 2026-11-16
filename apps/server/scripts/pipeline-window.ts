// Measures the pipeline outcome of #925 over a window, from a COPY of the hub database:
// crew-PR CI failures by cause, and blocking review findings that may ask for controller-only evidence.
// Make the copy with: sqlite3 <db> ".backup <copy>"   (never point this at the live file)
// Run from the repo root:
//   node --experimental-strip-types apps/server/scripts/pipeline-window.ts --db <copy> --repo <repo id> --from <ISO time> [--hours 24]
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BLOCKING_SEVERITIES, CI_FAILED_STATES } from "@mc/core";

export type CiFailureClass = "lint-typecheck-build" | "tests" | "other";
export interface PipelineWindowInput {
  repoId: string;
  from: number;
  until: number;
}
export interface CiFailure {
  pr: number;
  sha: string;
  job: string;
  cls: CiFailureClass;
  url: string | null;
}
export interface ControllerOnlyCandidate {
  reviewId: number;
  pr: number;
  round: number;
  severity: string;
  summary: string;
  matched: string;
}
export interface PipelineReport {
  input: PipelineWindowInput;
  crewPrs: number;
  ciResults: number;
  failures: CiFailure[];
  byClass: Record<CiFailureClass, number>;
  reviewsEnded: number;
  blockingFindings: number;
  controllerCheckSummaries: number;
  controllerOnly: ControllerOnlyCandidate[];
}

/** Wording that asks for evidence only the controller can produce; candidates for a person to read. */
export const CONTROLLER_ONLY_PATTERNS: readonly RegExp[] = [
  /screenshots? of the (running|live) hub/i,
  /\b(running|live) hub\b/i,
  /\b\d+ (consecutive )?(ci )?(runs|reruns)\b/i,
  /\bre-?run(ning)? (the )?(whole |full )?ci\b/i,
  /\bcontroller('s)? (check|verdict|evidence|run)\b/i,
  /\blive (data|database|db|system|seat start)\b/i,
];

const USAGE =
  "Usage: pipeline-window.ts --db <copy of the hub DB> --repo <repo id> --from <ISO time> [--hours 24]";

/** The CI job's class by name; null for the `check` summary job, which is left out of every count. */
export function ciFailureClass(job: string): CiFailureClass | null {
  const name = job.toLowerCase();
  if (name.startsWith("check")) return null;
  if (name.startsWith("validate")) return "lint-typecheck-build";
  if (/^(server-process|server|web-core)\b/.test(name)) return "tests";
  return "other";
}

type Row = Record<string, string | number | null>;

export function pipelineWindow(db: DatabaseSync, input: PipelineWindowInput): PipelineReport {
  const { repoId, from, until } = input;
  const crew = `SELECT json_extract(loop, '$.prNumber') FROM runs WHERE repo_id = ? AND json_extract(loop, '$.prNumber') IS NOT NULL`;
  const rows = db
    .prepare(
      `SELECT pr_number, sha, name, conclusion, url FROM ci_runs
       WHERE repo_id = ? AND at >= ? AND at < ? AND pr_number IN (${crew}) ORDER BY at, name, attempt`,
    )
    .all(repoId, from, until, repoId) as Row[];
  const failed = new Set(CI_FAILED_STATES);
  const failures: CiFailure[] = [];
  const byClass: Record<CiFailureClass, number> = { "lint-typecheck-build": 0, tests: 0, other: 0 };
  const prs = new Set<number>();
  let ciResults = 0;
  for (const r of rows) {
    const cls = ciFailureClass(String(r.name));
    if (cls === null) continue;
    ciResults++;
    prs.add(Number(r.pr_number));
    if (!failed.has(String(r.conclusion))) continue;
    byClass[cls]++;
    failures.push({
      pr: Number(r.pr_number),
      sha: String(r.sha),
      job: String(r.name),
      cls,
      url: (r.url as string | null) ?? null,
    });
  }
  const reviews = db
    .prepare(
      `SELECT id, pr_number, round, summary FROM reviews
       WHERE repo_id = ? AND state = 'reported' AND ended_at >= ? AND ended_at < ? ORDER BY id`,
    )
    .all(repoId, from, until) as Row[];
  const blocking = new Set<string>(BLOCKING_SEVERITIES);
  const controllerOnly: ControllerOnlyCandidate[] = [];
  let blockingFindings = 0;
  const findings = db.prepare(
    "SELECT severity, summary, scenario, fix FROM review_findings WHERE review_id = ? ORDER BY pos",
  );
  for (const v of reviews) {
    for (const f of findings.all(Number(v.id)) as Row[]) {
      if (!blocking.has(String(f.severity))) continue;
      blockingFindings++;
      for (const text of [f.summary, f.scenario, f.fix]) {
        const matched = CONTROLLER_ONLY_PATTERNS.map((p) => p.exec(String(text))?.[0]).find(Boolean);
        if (!matched) continue;
        controllerOnly.push({
          reviewId: Number(v.id),
          pr: Number(v.pr_number),
          round: Number(v.round),
          severity: String(f.severity),
          summary: String(f.summary),
          matched,
        });
        break;
      }
    }
  }
  return {
    input,
    crewPrs: prs.size,
    ciResults,
    failures,
    byClass,
    reviewsEnded: reviews.length,
    blockingFindings,
    controllerCheckSummaries: reviews.filter((v) => String(v.summary ?? "").includes("Controller check:")).length,
    controllerOnly,
  };
}

export function formatPipelineReport(r: PipelineReport): string[] {
  return [
    `Pipeline window ${new Date(r.input.from).toISOString()} to ${new Date(r.input.until).toISOString()}, repo ${r.input.repoId}`,
    `Crew PRs with CI results: ${r.crewPrs}; job results: ${r.ciResults}; failed: ${r.failures.length}`,
    `Failed, lint/typecheck/build (validate): ${r.byClass["lint-typecheck-build"]}`,
    `Failed, tests (server, server-process, web-core): ${r.byClass.tests}`,
    `Failed, other: ${r.byClass.other}`,
    ...r.failures.map((f) => `  PR ${f.pr} ${f.sha.slice(0, 7)} ${f.job} ${f.url ?? "no link"}`),
    `Reviews ended: ${r.reviewsEnded}; blocking findings: ${r.blockingFindings}; reviews naming a Controller check: ${r.controllerCheckSummaries}`,
    `Blocking findings that might ask for controller-only evidence (read each): ${r.controllerOnly.length}`,
    ...r.controllerOnly.map(
      (c) => `  PR ${c.pr} round ${c.round} review ${c.reviewId} ${c.severity}: ${c.summary} [matched: ${c.matched}]`,
    ),
  ];
}

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dbPath = get("--db");
  const repoId = get("--repo");
  const fromText = get("--from");
  const hours = Number(get("--hours") ?? 24);
  if (!dbPath || !repoId || !fromText) usage();
  const from = Date.parse(fromText);
  if (!Number.isFinite(from) || !Number.isFinite(hours) || hours <= 0) usage();
  let db: DatabaseSync;
  try {
    if (!existsSync(dbPath)) throw new Error("missing");
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare("SELECT 1 FROM ci_runs LIMIT 1").get();
  } catch {
    console.log(`Not read: ${dbPath} is not a hub database.`);
    process.exit(1);
  }
  const report = pipelineWindow(db, { repoId, from, until: from + hours * 3_600_000 });
  for (const line of formatPipelineReport(report)) console.log(line);
}
