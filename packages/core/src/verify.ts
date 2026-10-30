import { FIX_TEXT_MAX } from "./review.ts";

export const VERIFY_STATES = [
  "queued",
  "running",
  "passed",
  "failed",
  "error",
  "superseded",
] as const;
export type VerifyState = (typeof VERIFY_STATES)[number];
export interface VerifyCheckResult {
  command: string;
  ok: boolean;
  durationMs: number;
  failingTests: string[];
  errorLines: string[];
  files: string[];
}
export interface VerifyJobView {
  id: number;
  runId: string;
  seatId: string;
  repoId: string;
  sha: string;
  state: VerifyState;
  position: number | null;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  checks: VerifyCheckResult[];
  reason: string | null;
}
export interface VerifyQueueView {
  running: VerifyJobView | null;
  queued: VerifyJobView[];
  recent: VerifyJobView[];
}
export const VERIFY_CHECK_TIMEOUT_MS = 15 * 60_000;
export const VERIFY_SEAT = "verify";
export const verifyFixKey = (runId: string, epoch: number, jobId: number): string =>
  `verify-fix:${runId}:${epoch}:${jobId}`;
export function queuePositionText(position: number): string {
  return position === 0
    ? "Verifying"
    : `Verifying · ${position}${position === 1 ? "st" : position === 2 ? "nd" : position === 3 ? "rd" : "th"} in queue`;
}

const cap = (xs: string[]) => xs.slice(0, 20);
/** Extract compact, stable evidence from common Vitest and TypeScript output. */
export function parseCheckOutput(
  output: string,
): Pick<VerifyCheckResult, "failingTests" | "errorLines" | "files"> {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const failingTests = cap(
    lines
      .filter((line) => /^(?:FAIL\b|×(?:\s|$))/.test(line))
      .map((line) => line.replace(/^(?:FAIL|×)\s*/, "")),
  );
  const errorLines = cap(lines.filter((line) => /(?:error TS\d+|\berror\b)/i.test(line)));
  const files = cap(
    lines.flatMap((line) => {
      const m = line.match(/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]sx?|json|css|html)(?::\d+|\(\d+,)/g);
      return m?.map((x) => x.replace(/[(:].*$/, "")) ?? [];
    }),
  );
  return {
    failingTests,
    errorLines: errorLines.length > 0 ? errorLines : cap(lines.slice(-20)),
    files: [...new Set(files)],
  };
}

export function verifyReworkText(i: { sha: string; checks: readonly VerifyCheckResult[] }): string {
  const failed = i.checks.filter((check) => !check.ok);
  const head = `The verify queue ran the checks on ${i.sha.slice(0, 7)}: ${failed.length} of ${i.checks.length} failed. Fix each below, commit with mc commit, then call mc report_evidence; the queue checks the new commit.`;
  const entries = failed.map((check, index) => {
    const parts = [`${index + 1}. ${check.command} — failed`];
    if (check.failingTests.length) parts.push(`   Tests: ${check.failingTests.join("; ")}`);
    if (check.errorLines.length)
      parts.push(`   Error: ${check.errorLines.slice(0, 20).join("\n   ")}`);
    if (check.files.length) parts.push(`   Files: ${check.files.join(", ")}`);
    return parts.join("\n");
  });
  let out = head;
  for (const entry of entries) {
    if (`${out}\n\n${entry}`.length > FIX_TEXT_MAX) break;
    out += `\n\n${entry}`;
  }
  return out;
}
