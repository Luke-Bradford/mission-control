/**
 * Tests that need something a crew seat's own sandbox denies (#1411): listening on a port or a
 * socket, `sandbox-exec`, `ps`, repo hooks. In a seat they can only fail for the sandbox, so
 * `pnpm -s test:related` could never pass there when a change selects them.
 *
 * A test is skipped only when BOTH hold: this process runs in a crew seat (the hub marks every
 * seat's environment with SEAT_SANDBOX_ENV, Claude and Codex alike; the Claude sandbox runtime
 * sets SANDBOX_RUNTIME), and a probe of that very capability fails. CI and the hub set neither
 * marker, so they run every test; and a seat whose sandbox allows the capability runs the test,
 * where a real failure still fails. Each skip is named on stderr so it is never silent.
 *
 * This module imports no server code, so any package's tests can use it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";
import { SEAT_SANDBOX_ENV } from "../src/runtime.ts";

export type BaseCapability = "listen" | "seatbelt" | "ps" | "git-hooks";

/** Set by the Claude sandbox runtime on every command run inside it. */
const CLAUDE_SANDBOX_MARKER = "SANDBOX_RUNTIME";

/** True when this process runs in a crew seat (either vendor). */
export const inSeatSandbox = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[CLAUDE_SANDBOX_MARKER] === "1" || env[SEAT_SANDBOX_ENV] === "1";

const listenOn = (listen: (s: Server, done: () => void) => void) =>
  new Promise<boolean>((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    listen(s, () => s.close(() => resolve(true)));
  });

export const baseProbes: Record<BaseCapability, () => Promise<boolean>> = {
  // a TCP port and a unix socket: the hub tests and the keeper use one or the other
  listen: async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-probe-listen-"));
    try {
      return (
        (await listenOn((s, done) => s.listen(0, "127.0.0.1", done))) &&
        (await listenOn((s, done) => s.listen(join(dir, "s.sock"), done)))
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  seatbelt: async () =>
    process.platform === "darwin" &&
    spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: "ignore",
    }).status === 0,
  ps: async () =>
    spawnSync("ps", ["-axww", "-o", "pid=,command="], { stdio: "ignore" }).status === 0,
  // a plain `git commit` runs the clone's hook (a seat's git settings may switch hooks off)
  "git-hooks": async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-probe-hooks-"));
    try {
      const marker = join(dir, "ran");
      const git = (...a: string[]) =>
        spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...a], {
          cwd: dir,
          stdio: "ignore",
        }).status === 0;
      if (!git("init", "-q")) return false;
      writeFileSync(join(dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, {
        mode: 0o755,
      });
      writeFileSync(join(dir, "f"), "f\n");
      git("add", "f");
      git("commit", "-qm", "f");
      return existsSync(marker);
    } catch {
      return false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

/** Whether the capability is blocked here: in a seat, and the probe fails. */
export async function probeBlocked(
  probe: () => Promise<boolean>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!inSeatSandbox(env)) return false;
  return !(await probe());
}

/** `probeBlocked` for a base capability, or a probe given. */
export const capabilityBlocked = (
  cap: BaseCapability,
  opts: { env?: NodeJS.ProcessEnv; probe?: () => Promise<boolean> } = {},
): Promise<boolean> => probeBlocked(opts.probe ?? baseProbes[cap], opts.env);

/** Prints the skip line. */
export function noteSkip(cap: string): void {
  process.stderr.write(
    `sandbox-gaps: skipping tests that need "${cap}": this seat's sandbox denies it; CI runs them.\n`,
  );
}

/** Top-level `await` in a test file: true when its tests for `cap` should be skipped. */
export async function blockedHere(cap: BaseCapability): Promise<boolean> {
  const blocked = await capabilityBlocked(cap);
  if (blocked) noteSkip(cap);
  return blocked;
}

/** Skips every test of the file when `blocked` (use as `skipTestsIf(await blockedHere(cap))`). */
export function skipTestsIf(blocked: boolean): void {
  if (blocked) beforeEach(({ skip }) => skip());
}
