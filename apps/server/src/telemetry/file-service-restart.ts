/**
 * Restarts a runaway file-change service (`fseventsd`) so the crew never has to stop for it.
 *
 * On 18 November `fseventsd` went into a state where it kept every file event in memory and grew
 * about 250 MB an hour until restarted; healthy, it stays flat under any amount of crew work. What
 * tips it into that state is not known yet, so each restart first saves what was running and the
 * service's own log, for finding the trigger.
 *
 * Restarting a system daemon needs root. The hub tries `sudo -n` first, which works only when the
 * operator has added a sudoers rule for exactly `/usr/bin/killall fseventsd`; otherwise it shows the
 * macOS administrator prompt once. Nothing else runs as root.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const KILLALL = "/usr/bin/killall";
const PROMPT =
  "Mission Control: the file-change service (fseventsd) is stuck and growing. Restarting it takes about 15 seconds and nothing is lost.";
const PROMPT_TIMEOUT_MS = 10 * 60_000;
const DIAGNOSTIC_TIMEOUT_MS = 120_000;
const DIAGNOSTIC_MAX_BUFFER = 64 * 1024 ** 2;

export interface FileServiceRestart {
  /** How it was restarted, or why it was not. */
  how: "sudo" | "prompt" | "not restarted";
  /** Where what was running and the service's log were saved; null if saving failed. */
  diagnostics: string | null;
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

async function saveDiagnostics(dir: string, at: number, exec: Exec): Promise<string | null> {
  const read = async (file: string, args: readonly string[]): Promise<string> => {
    try {
      return (
        await exec(file, args, { timeout: DIAGNOSTIC_TIMEOUT_MS, maxBuffer: DIAGNOSTIC_MAX_BUFFER })
      ).stdout;
    } catch (e) {
      return `(failed: ${e instanceof Error ? e.message : String(e)})`;
    }
  };
  const processes = await read("/bin/ps", ["-axo", "pid,ppid,lstart,etime,rss,command"]);
  const log = await read("/usr/bin/log", [
    "show",
    "--last",
    "90m",
    "--style",
    "compact",
    "--predicate",
    'subsystem == "com.apple.fsevents"',
  ]);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `fseventsd-${new Date(at).toISOString().replace(/[:.]/g, "-")}.txt`);
    await writeFile(
      path,
      `# Processes at the restart\n${processes}\n# fseventsd log, last 90 minutes\n${log}`,
      { mode: 0o600 },
    );
    return path;
  } catch {
    return null;
  }
}

/** Saves diagnostics into `dir`, then restarts `fseventsd`; never throws. */
export async function restartFileService(
  dir: string,
  at: number,
  exec: Exec = defaultExec,
): Promise<FileServiceRestart> {
  const diagnostics = await saveDiagnostics(dir, at, exec);
  try {
    await exec("/usr/bin/sudo", ["-n", KILLALL, "fseventsd"], { timeout: 30_000 });
    return { how: "sudo", diagnostics };
  } catch {
    // no sudoers rule: ask once through the macOS administrator prompt
  }
  try {
    await exec(
      "/usr/bin/osascript",
      [
        "-e",
        `do shell script "${KILLALL} fseventsd" with administrator privileges with prompt "${PROMPT}"`,
      ],
      { timeout: PROMPT_TIMEOUT_MS },
    );
    return { how: "prompt", diagnostics };
  } catch {
    return { how: "not restarted", diagnostics };
  }
}
