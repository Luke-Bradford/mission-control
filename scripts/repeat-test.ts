/** Repeat one exact Vitest file in one job, retaining every outcome and rejecting empty proof. */
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface RepeatOptions {
  root: string;
  file: string;
  repetitions: number;
  pattern: string | null;
  output: string;
}
export function repeatOptions(
  root: string,
  file: string,
  repetitions: string,
  pattern = "",
): RepeatOptions {
  const actualRoot = realpathSync(root);
  if (
    !/^(apps|packages)\/[A-Za-z0-9_./-]+\.test\.tsx?$/.test(file) ||
    file.split("/").some((part) => part === "..")
  )
    throw new Error(
      "Choose one .test.ts or .test.tsx file under apps/ or packages/; globs and parent paths are not accepted.",
    );
  const path = realpathSync(resolve(actualRoot, file));
  if (!path.startsWith(actualRoot + sep) || !statSync(path).isFile())
    throw new Error("The test file must be a regular file inside this checkout.");
  if (!/^[1-9]\d*$/.test(repetitions) || Number(repetitions) > 100)
    throw new Error("Repetitions must be an integer from 1 to 100.");
  if (pattern.length > 1000)
    throw new Error("The test name pattern must be at most 1000 characters.");
  return {
    root: actualRoot,
    file: relative(actualRoot, path).split(sep).join("/"),
    repetitions: Number(repetitions),
    pattern: pattern || null,
    output: join(actualRoot, ".mc-tmp", "repeat-tests"),
  };
}
type Execution = { status: number | null; signal?: string | null; error?: Error };
type Execute = (args: string[], log: number) => Execution;
interface Outcome {
  run: number;
  status: "passed" | "failed" | "no-tests-executed" | "invalid-report";
  exitCode: number | null;
  signal: string | null;
  passed: number;
  failed: number;
  durationMs: number;
  log: string;
  report: string;
  error?: string;
}
export function repeatTest(options: RepeatOptions, execute?: Execute) {
  mkdirSync(options.output, { recursive: true });
  let sha = process.env.GITHUB_SHA ?? "unknown",
    dirty: boolean | null = null;
  try {
    sha =
      process.env.GITHUB_SHA ??
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: options.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    dirty =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: options.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() !== "";
  } catch {
    /* A fixture may not be a git checkout; it must not claim an exact head. */
  }
  const outcomes: Outcome[] = [];
  const summary = {
    sha,
    dirty,
    file: options.file,
    pattern: options.pattern,
    requested: options.repetitions,
    completed: 0,
    finalized: false,
    success: false,
    outcomes,
  };
  const save = () =>
    writeFileSync(join(options.output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  save();
  for (let run = 1; run <= options.repetitions; run++) {
    const stem = `run-${String(run).padStart(3, "0")}`,
      log = `${stem}.log`,
      report = `${stem}.json`;
    const args = [
      "exec",
      "vitest",
      "run",
      options.file,
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${join(options.output, report)}`,
      ...(options.pattern ? [`--testNamePattern=${options.pattern}`] : []),
    ];
    rmSync(join(options.output, report), { force: true });
    const fd = openSync(join(options.output, log), "w"),
      start = performance.now();
    let execution: Execution;
    try {
      execution = (
        execute ??
        ((args, log) => spawnSync("pnpm", args, { cwd: options.root, stdio: ["ignore", log, log] }))
      )(args, fd);
    } catch (error) {
      execution = {
        status: null,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      closeSync(fd);
    }
    const outcome: Outcome = {
      run,
      status: "invalid-report",
      exitCode: execution.status,
      signal: execution.signal ?? null,
      passed: 0,
      failed: 0,
      durationMs: performance.now() - start,
      log,
      report,
    };
    try {
      const value: unknown = JSON.parse(readFileSync(join(options.output, report), "utf8"));
      if (!value || typeof value !== "object")
        throw new Error("Vitest did not return a result object.");
      const result = value as Record<string, unknown>;
      for (const key of ["numPassedTests", "numFailedTests"])
        if (!Number.isSafeInteger(result[key]) || (result[key] as number) < 0)
          throw new Error(`Vitest omitted a valid ${key} count.`);
      outcome.passed = result.numPassedTests as number;
      outcome.failed = result.numFailedTests as number;
      outcome.status =
        outcome.passed + outcome.failed === 0
          ? "no-tests-executed"
          : execution.status === 0 &&
              !execution.error &&
              outcome.failed === 0 &&
              result.success === true
            ? "passed"
            : "failed";
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }
    if (execution.error) outcome.error = execution.error.message;
    outcomes.push(outcome);
    summary.completed = outcomes.length;
    save();
    console.log(
      `Repeat ${run}/${options.repetitions}: ${outcome.status} (${outcome.passed} passed, ${outcome.failed} failed)`,
    );
  }
  summary.finalized = true;
  summary.success =
    outcomes.length === options.repetitions && outcomes.every((run) => run.status === "passed");
  save();
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = repeatOptions(
      process.cwd(),
      process.env.TEST_FILE ?? "",
      process.env.TEST_REPETITIONS ?? "",
      process.env.TEST_NAME_PATTERN ?? "",
    );
    const summary = repeatTest(options);
    process.exitCode = summary.success ? 0 : 1;
    console.log(`Results: ${relative(options.root, options.output)}/summary.json`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
