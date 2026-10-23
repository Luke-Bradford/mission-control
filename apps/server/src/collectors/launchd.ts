import { spawn } from "node:child_process";
import type { AdoptedLoop } from "../config.ts";

/** Runs `launchctl <args>`; resolves with the exit code and stdout, and rejects only when it could not run at all. */
export type LaunchctlRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

/** `launchctl print` exits 113 for a service that is not loaded ("Could not find service"). */
export const LAUNCHCTL_NOT_FOUND = 113;
export const LAUNCHCTL_TIMEOUT_MS = 5_000;
/** At most this much of stdout is kept. */
export const LAUNCHCTL_STDOUT_MAX = 64 * 1024;

/**
 * Only stdout is piped (stdin and stderr are ignored), and only its first LAUNCHCTL_STDOUT_MAX bytes
 * are kept; the caller reads two lines of it and discards the rest. `command` and `timeoutMs` are
 * parameters so the timeout path can be tested with a real spawn.
 */
export const makeLaunchctl =
  (
    spawnFn: typeof spawn,
    command = "launchctl",
    timeoutMs = LAUNCHCTL_TIMEOUT_MS,
  ): LaunchctlRunner =>
  (args) =>
    new Promise((resolve, reject) => {
      const child = spawnFn(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutMs,
      });
      const chunks: Buffer[] = [];
      let kept = 0;
      // Keep consuming past the cap so the pipe never blocks the child.
      child.stdout?.on("data", (chunk: Buffer) => {
        if (kept >= LAUNCHCTL_STDOUT_MAX) return;
        chunks.push(chunk);
        kept += chunk.length;
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (typeof code === "number") {
          const stdout = Buffer.concat(chunks).subarray(0, LAUNCHCTL_STDOUT_MAX).toString("utf8");
          resolve({ code, stdout });
        } else reject(new Error(`launchctl ended by ${signal ?? "unknown signal"}`));
      });
    });

export const launchctl: LaunchctlRunner = makeLaunchctl(spawn);

export const launchdMissingNote = (label: string): string => `launchd job missing: ${label}`;

/** The same failure for the same label is logged at most this often. */
export const LOG_REPEAT_MS = 60 * 60_000;

const lastLogged = new Map<string, { message: string; at: number }>();

/** Forget what was logged (tests). */
export const resetLaunchdLogState = (): void => lastLogged.clear();

const stderrLog = (line: string): void => {
  process.stderr.write(line);
};

/** The service's own top-level lines (one tab); nested blocks such as `environment` are indented deeper. */
const STATE_LINE = /^\tstate = (.+)$/m;
const PID_LINE = /^\tpid = (\d+)$/m;

export type LaunchdJob =
  | { kind: "missing"; note: string }
  | { kind: "running"; pid: number | null }
  | { kind: "not running" }
  | { kind: "unknown" };

/**
 * What launchd says about a loop's job. Read-only: only `launchctl print` is ever run, once per
 * call, and only its top-level `state` and `pid` lines are read; the rest of stdout (which can hold
 * the job's environment) is never logged, stored or returned. Any other outcome (another exit code,
 * no known state, launchctl unrunnable) is logged and gives `unknown`, so a broken probe never marks
 * a healthy loop. A failure identical to the last one logged for the label is repeated at most once
 * per LOG_REPEAT_MS, not every poll.
 */
export async function launchdJob(
  loop: AdoptedLoop,
  run: LaunchctlRunner | undefined,
  uid: number = process.getuid?.() ?? 0,
  log: (line: string) => void = stderrLog,
  now: () => number = Date.now,
): Promise<LaunchdJob> {
  if (run === undefined) return { kind: "unknown" };
  try {
    const { code, stdout } = await run(["print", `gui/${uid}/${loop.launchdLabel}`]);
    if (code === LAUNCHCTL_NOT_FOUND) {
      lastLogged.delete(loop.launchdLabel);
      return { kind: "missing", note: launchdMissingNote(loop.launchdLabel) };
    }
    if (code !== 0) throw new Error(`launchctl print exited ${code}`);
    const state = STATE_LINE.exec(stdout)?.[1];
    if (state === "running") {
      lastLogged.delete(loop.launchdLabel);
      const pid = PID_LINE.exec(stdout)?.[1];
      return { kind: "running", pid: pid === undefined ? null : Number(pid) };
    }
    if (state === "not running") {
      lastLogged.delete(loop.launchdLabel);
      return { kind: "not running" };
    }
    throw new Error("launchctl print gave no known state");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const prev = lastLogged.get(loop.launchdLabel);
    const at = now();
    if (prev === undefined || prev.message !== message || at - prev.at >= LOG_REPEAT_MS) {
      lastLogged.set(loop.launchdLabel, { message, at });
      log(`cc: launchd check failed for ${loop.id}: ${message}\n`);
    }
    return { kind: "unknown" };
  }
}

/** The note for a loop whose launchd job is gone, else null. */
export async function launchdNote(
  loop: AdoptedLoop,
  run: LaunchctlRunner | undefined,
  uid: number = process.getuid?.() ?? 0,
  log: (line: string) => void = stderrLog,
  now: () => number = Date.now,
): Promise<string | null> {
  const job = await launchdJob(loop, run, uid, log, now);
  return job.kind === "missing" ? job.note : null;
}
