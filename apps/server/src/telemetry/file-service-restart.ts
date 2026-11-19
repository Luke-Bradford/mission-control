/**
 * Restarts a runaway file-change service (`fseventsd`) so the crew never has to stop for it.
 *
 * On 18 November `fseventsd` went into a state where it kept every file event in memory and grew
 * about 250 MB an hour until restarted; healthy, it stays flat under any amount of crew work. What
 * tips it into that state is not known yet, so the first attempt of each episode saves what was
 * running and the service's own log, for finding the trigger.
 *
 * Restarting a system daemon needs root. The hub runs `sudo -n /usr/bin/killall fseventsd`, which
 * works only when the operator has added a sudoers rule for exactly that command. Without it the
 * caller raises an operator alert; the hub never shows a password prompt of its own.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const DIAGNOSTIC_TIMEOUT_MS = 120_000;
const DIAGNOSTIC_MAX_BUFFER = 16 * 1024 ** 2;
/** Diagnostics files kept; older ones are deleted. */
export const DIAGNOSTICS_KEPT = 10;
const DIAGNOSTICS_PREFIX = "fseventsd-";

export interface FileServiceRestart {
  restarted: boolean;
  /** Why it was not restarted. */
  error?: string;
  /**
   * Where what was running and the service's log were saved; null if saving failed; absent when
   * the caller asked for none (a later attempt in the same episode keeps the first capture).
   */
  diagnostics?: string | null;
}

type Exec = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer?: number },
) => Promise<{ stdout: string }>;

const defaultExec: Exec = async (file, args, options) => {
  const { stdout } = await execFileP(file, [...args], { ...options, encoding: "utf8" });
  return { stdout };
};

/** One readable line from an `execFile` failure: its last stderr line, or that it timed out. */
export function failureReason(e: unknown): string {
  const x = (typeof e === "object" && e !== null ? e : {}) as {
    killed?: boolean;
    signal?: string | null;
    stderr?: unknown;
    message?: unknown;
  };
  if (x.killed === true || x.signal === "SIGTERM") return "it timed out";
  const last = (text: unknown): string | undefined =>
    typeof text === "string"
      ? text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "" && !l.startsWith("Command failed:"))
          .at(-1)
      : undefined;
  return (last(x.stderr) ?? last(x.message) ?? String(e)).replace(/^sudo: /, "");
}

async function saveDiagnostics(dir: string, at: number, exec: Exec): Promise<string | null> {
  const read = async (file: string, args: readonly string[]): Promise<string> => {
    try {
      return (
        await exec(file, args, { timeout: DIAGNOSTIC_TIMEOUT_MS, maxBuffer: DIAGNOSTIC_MAX_BUFFER })
      ).stdout;
    } catch (e) {
      // over the buffer limit, what was read so far is kept
      const partial = (e as { stdout?: unknown }).stdout;
      return typeof partial === "string" && partial !== ""
        ? `${partial}\n(cut short: ${failureReason(e)})`
        : `(failed: ${failureReason(e)})`;
    }
  };
  const processes = await read("/bin/ps", ["-axo", "pid,ppid,lstart,etime,rss,command"]);
  // the daemon's own lines carry no subsystem, so the process is named as well
  const log = await read("/usr/bin/log", [
    "show",
    "--last",
    "90m",
    "--style",
    "compact",
    "--predicate",
    'process == "fseventsd" OR subsystem BEGINSWITH "com.apple.fsevents"',
  ]);
  try {
    // The modes apply on creation; the hub's data directory is 0700 already and each name is new.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(
      dir,
      `${DIAGNOSTICS_PREFIX}${new Date(at).toISOString().replace(/[:.]/g, "-")}.txt`,
    );
    await writeFile(
      path,
      `# Processes at the restart\n${processes}\n# fseventsd log, last 90 minutes\n${log}`,
      { mode: 0o600 },
    );
    const old = (await readdir(dir))
      .filter((f) => f.startsWith(DIAGNOSTICS_PREFIX))
      .sort()
      .slice(0, -DIAGNOSTICS_KEPT);
    await Promise.all(old.map((f) => rm(join(dir, f), { force: true })));
    return path;
  } catch {
    return null;
  }
}

/** Saves diagnostics into `dir` when asked, then restarts `fseventsd` through sudo; never throws. */
export async function restartFileService(
  dir: string,
  at: number,
  opts: { diagnose: boolean },
  exec: Exec = defaultExec,
): Promise<FileServiceRestart> {
  const saved = opts.diagnose ? { diagnostics: await saveDiagnostics(dir, at, exec) } : {};
  try {
    await exec("/usr/bin/sudo", ["-n", "/usr/bin/killall", "fseventsd"], { timeout: 30_000 });
    return { restarted: true, ...saved };
  } catch (e) {
    return { restarted: false, error: failureReason(e), ...saved };
  }
}
