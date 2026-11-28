import { execFileSync } from "node:child_process";
import { SEAT_SANDBOX_ENV } from "@mc/core";

export type RunTool = (cmd: string, args: string[]) => string;

const defaultRun: RunTool = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });

const MAX_DEPTH = 16;
/** The pid at the client end of a loopback connection that came from `clientPort`. */
function clientPid(clientPort: number, run: RunTool): number | null {
  const out = run("lsof", ["-nP", `-iTCP:${clientPort}`, "-sTCP:ESTABLISHED", "-Fpn"]);
  let pid: number | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number.parseInt(line.slice(1), 10);
    // the client's own entry reads `<its address>:<port>-><hub address>`
    else if (line.startsWith("n") && new RegExp(`:${clientPort}->`).test(line)) return pid;
  }
  return null;
}

/**
 * Whether the local process on the other end of a loopback connection is a seat or descends from one
 * (a seat's processes carry the sandbox marker in their environment). A caller that cannot be
 * identified, or whose parent chain cannot be followed to launchd, counts as a seat's: doubt refuses.
 *
 * This is a second layer. The seat sandbox (Claude: loopback denied; Codex: network off) is the
 * barrier. A process that clears its environment and detaches, so that launchd becomes its parent,
 * looks the same as the operator's browser and is not caught here.
 */
export function peerIsSeat(clientPort: number | undefined, run: RunTool = defaultRun): boolean {
  if (clientPort === undefined) return true;
  try {
    let pid = clientPid(clientPort, run);
    if (pid === null) return true;
    const marker = new RegExp(`(?:^|\\s)${SEAT_SANDBOX_ENV}=1(?:\\s|$)`);
    for (let depth = 0; depth < MAX_DEPTH && pid !== null && pid > 1; depth++) {
      if (marker.test(run("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)]))) return true;
      const parent = Number.parseInt(run("ps", ["-o", "ppid=", "-p", String(pid)]).trim(), 10);
      pid = Number.isFinite(parent) ? parent : null;
    }
    // only a walk that really ended at launchd (or the kernel) clears the caller
    return pid !== 1 && pid !== 0;
  } catch {
    return true;
  }
}
