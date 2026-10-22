import { spawn } from "node:child_process";
import type { AdoptedLoop } from "../config.ts";

/** Runs `launchctl <args>`; resolves with the exit code and rejects only when it could not run at all. */
export type LaunchctlRunner = (args: string[]) => Promise<{ code: number }>;

/** `launchctl print` exits 113 for a service that is not loaded ("Could not find service"). */
export const LAUNCHCTL_NOT_FOUND = 113;
export const LAUNCHCTL_TIMEOUT_MS = 5_000;

/**
 * stdout is never used, so all stdio is ignored: nothing to buffer, nothing to leak to the hub's
 * logs. `command` and `timeoutMs` are parameters so the timeout path can be tested with a real spawn.
 */
export const makeLaunchctl =
  (
    spawnFn: typeof spawn,
    command = "launchctl",
    timeoutMs = LAUNCHCTL_TIMEOUT_MS,
  ): LaunchctlRunner =>
  (args) =>
    new Promise((resolve, reject) => {
      const child = spawnFn(command, args, { stdio: "ignore", timeout: timeoutMs });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (typeof code === "number") resolve({ code });
        else reject(new Error(`launchctl ended by ${signal ?? "unknown signal"}`));
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

/**
 * The note for a loop whose launchd job is gone, else null. Read-only: only `launchctl print` is
 * ever run, once per call. Any other outcome (another exit code, launchctl unrunnable) is logged
 * and gives no note, so a broken probe never marks a healthy loop. A failure identical to the last
 * one logged for the label is repeated at most once per LOG_REPEAT_MS, not every poll.
 */
export async function launchdNote(
  loop: AdoptedLoop,
  run: LaunchctlRunner | undefined,
  uid: number = process.getuid?.() ?? 0,
  log: (line: string) => void = stderrLog,
  now: () => number = Date.now,
): Promise<string | null> {
  if (run === undefined) return null;
  try {
    const { code } = await run(["print", `gui/${uid}/${loop.launchdLabel}`]);
    if (code === 0 || code === LAUNCHCTL_NOT_FOUND) lastLogged.delete(loop.launchdLabel);
    if (code === 0) return null;
    if (code === LAUNCHCTL_NOT_FOUND) return launchdMissingNote(loop.launchdLabel);
    throw new Error(`launchctl print exited ${code}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const prev = lastLogged.get(loop.launchdLabel);
    const at = now();
    if (prev === undefined || prev.message !== message || at - prev.at >= LOG_REPEAT_MS) {
      lastLogged.set(loop.launchdLabel, { message, at });
      log(`cc: launchd check failed for ${loop.id}: ${message}\n`);
    }
    return null;
  }
}
