import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** What a check or test runs as: its executable, or the script node runs. */
const CHECK_PROGRAMS = new Set(["node", "pnpm", "vitest", "tsc", "eslint"]);
/** The seat's own agent is no check, whatever it runs on. */
const AGENT = /claude|codex/i;

/**
 * Whether a check or test process still runs in `worktree`: a process whose working directory is
 * inside it and whose executable, or the script it runs, is node, pnpm, vitest, tsc or eslint.
 * The hub sees a check this way when the seat's tool handed back before the check ended, whatever
 * shell started it (a shell replaces itself with the last command of a chain).
 */
export async function processAlive(worktree: string): Promise<boolean> {
  const { stdout } = await run("ps", ["-axww", "-o", "pid=,command="]);
  const pids = stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .filter((m) => Number(m[1]) !== process.pid && isCheckProcess(m[2] ?? ""))
    .map((m) => m[1] as string);
  if (pids.length === 0) return false;
  // lsof exits 1 when some pid has already gone: read what it printed
  const out = await run("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")]).then(
    (r) => r.stdout,
    (e: { stdout?: string }) => e.stdout ?? "",
  );
  const root = worktree.replace(/\/+$/, "");
  return out
    .split("\n")
    .some((l) => l.startsWith("n") && (l.slice(1) === root || l.slice(1).startsWith(`${root}/`)));
}

function isCheckProcess(command: string): boolean {
  if (AGENT.test(command)) return false;
  const [exe = "", script = ""] = command.split(/\s+/);
  const name = (w: string) => basename(w).replace(/\.(c|m)?js$/, "");
  return (
    CHECK_PROGRAMS.has(name(exe)) || (name(exe) === "node" && CHECK_PROGRAMS.has(name(script)))
  );
}
