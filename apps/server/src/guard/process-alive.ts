import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Whether a process is still running `command` in `worktree`: a process whose command line holds
 * the exact command (the shell that runs it) and whose working directory is the worktree. The hub
 * sees a check's process this way when the seat's tool handed back before the check ended.
 */
export async function processAlive(worktree: string, command: string): Promise<boolean> {
  const { stdout } = await run("ps", ["-axww", "-o", "pid=,command="]);
  const pids = stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .filter((m) => Number(m[1]) !== process.pid && m[2]?.includes(command) === true)
    .map((m) => m[1] as string);
  if (pids.length === 0) return false;
  // lsof exits 1 when some pid has already gone: read what it printed
  const out = await run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]).then(
    (r) => r.stdout,
    (e: { stdout?: string }) => e.stdout ?? "",
  );
  const root = worktree.replace(/\/+$/, "");
  return out
    .split("\n")
    .some((l) => l.startsWith("n") && (l.slice(1) === root || l.slice(1).startsWith(`${root}/`)));
}
