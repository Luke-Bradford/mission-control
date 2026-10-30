import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERIFY_CHECK_TIMEOUT_MS } from "@mc/core";

const quote = (path: string): string => {
  if (!path || [...path].some((char) => char === '"' || char === "\\" || char.charCodeAt(0) < 32))
    throw new Error("verify sandbox path is unsafe");
  return `"${path}"`;
};

/** Seatbelt profile for an untrusted committed check. There is intentionally no unsandboxed fallback. */
export function verifyProfile(i: {
  scratch: string;
  tmp: string;
  denied: readonly string[];
}): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(allow network* (local unix-socket))",
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(i.scratch)}))`,
    `(allow file-write* (subpath ${quote(i.tmp)}))`,
    '(allow file-write* (literal "/dev/null"))',
    `(deny file-write* (subpath ${quote(join(i.scratch, ".git"))})`,
    ...i.denied.map((path) => `(deny file-read* (subpath ${quote(path)}))`),
  ].join("\n");
}

export async function runVerifySandbox(i: {
  scratch: string;
  command: string;
  denied: readonly string[];
  timeoutMs?: number;
}): Promise<{ ok: boolean; output: string; durationMs: number }> {
  if (process.platform !== "darwin") throw new Error("verify jobs require macOS sandbox-exec");
  const temp = await mkdtemp(join(tmpdir(), "mc-verify-"));
  const started = Date.now();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          verifyProfile({ scratch: i.scratch, tmp: temp, denied: i.denied }),
          "/bin/sh",
          "-c",
          i.command,
        ],
        {
          cwd: i.scratch,
          env: { PATH: process.env.PATH ?? "", HOME: temp, TMPDIR: temp, CI: "true" },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      const append = (data: Buffer) => {
        output = `${output}${data.toString()}`.slice(0, 256 * 1024);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
          }
        }
      }, i.timeoutMs ?? VERIFY_CHECK_TIMEOUT_MS);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0,
          output: timedOut ? `${output}\ntimed out after 15 minutes` : output,
          durationMs: Date.now() - started,
        });
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
