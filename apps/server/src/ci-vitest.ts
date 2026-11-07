/**
 * Runs the CI vitest step and decides its exit code (#1561). Vitest 3.2 hardcodes a 60 s wait for a
 * worker's `onTaskUpdate` call to the main process; on a loaded runner that wait can expire after
 * every test has passed, and vitest then exits 1 on the unhandled error alone. That one error is
 * forgiven here, only when the JSON report shows no failed test or suite. Any other unhandled error,
 * and any run vitest did not explain, keeps its failing exit.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_RPC_TIMEOUT = '[vitest-worker]: Timeout calling "onTaskUpdate"';

export interface VitestReportTotals {
  numFailedTests: number;
  numFailedTestSuites: number;
  numTotalTestSuites: number;
}

/** The exit code CI should use, given vitest's own exit code, its JSON totals and its console output. */
export function vitestVerdict(
  exitCode: number,
  report: VitestReportTotals | undefined,
  output: string,
): number {
  if (exitCode === 0) return 0;
  if (!report || report.numTotalTestSuites === 0) return 1;
  if (report.numFailedTests > 0 || report.numFailedTestSuites > 0) return 1;
  const caught = /Vitest caught (\d+) unhandled errors?/.exec(output);
  if (!caught) return 1;
  const count = Number(caught[1]);
  const blocks = output.split(/^.*Unhandled Error ⎯+$/m).slice(1);
  const timeouts = blocks.filter(
    (b) => b.trim().split("\n")[0]?.trim() === `Error: ${WORKER_RPC_TIMEOUT}`,
  );
  return count > 0 && blocks.length === count && timeouts.length === count ? 0 : 1;
}

function readTotals(file: string): VitestReportTotals | undefined {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return {
      numFailedTests: Number(j.numFailedTests),
      numFailedTestSuites: Number(j.numFailedTestSuites),
      numTotalTestSuites: Number(j.numTotalTestSuites),
    };
  } catch {
    return undefined;
  }
}

/** Runs `vitest run <args>` with a JSON report beside the console one, and returns the verdict. */
export function runVitestForCi(args: string[]): number {
  const dir = mkdtempSync(join(tmpdir(), "mc-vitest-"));
  const outputFile = join(dir, "report.json");
  try {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        ...args,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${outputFile}`,
      ],
      { encoding: "utf8", maxBuffer: 1 << 28 },
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    const verdict = vitestVerdict(
      result.status ?? 1,
      readTotals(outputFile),
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
    if (verdict === 0 && result.status !== 0)
      console.error(
        `ci-vitest: every test passed; ignoring the one worker RPC timeout (${WORKER_RPC_TIMEOUT}).`,
      );
    return verdict;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(runVitestForCi(process.argv.slice(2)));
