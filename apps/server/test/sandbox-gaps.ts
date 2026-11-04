/**
 * Tests that need something a crew seat's own sandbox denies (#1411): `sandbox-exec`, listening
 * on a port, or `pnpm install` with a store. In a seat they can only fail for the sandbox, and
 * an install runs to its timeout, so `pnpm -s test:related` could never pass there.
 *
 * A test is skipped only when BOTH hold: this process runs under a seat's sandbox
 * (`SANDBOX_RUNTIME=1`), and a probe of that very capability fails. CI and the hub set no such
 * marker, so they run every test; and a sandbox that does allow the capability runs the test,
 * where a real failure still fails. Each skip is named on stderr so it is never silent.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_ARGS, installEnv } from "../src/runtime/checkouts.ts";

export type Capability = "listen" | "seatbelt" | "install";

/** Set by the seat sandbox runtime on every command run inside it. */
const SANDBOX_MARKER = "SANDBOX_RUNTIME";

const PROBE_INSTALL_MS = 10_000;
const EMPTY_LOCK = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";

/** True when this process runs inside a seat's sandbox. */
export const inSeatSandbox = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[SANDBOX_MARKER] === "1";

const probes: Record<Capability, () => Promise<boolean>> = {
  listen: () =>
    new Promise((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(0, "127.0.0.1", () => s.close(() => resolve(true)));
    }),
  seatbelt: async () =>
    process.platform === "darwin" &&
    spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: "ignore",
    }).status === 0,
  install: async () => {
    // the install the checkout step runs, on an empty project: same arguments, same environment
    const dir = mkdtempSync(join(tmpdir(), "mc-probe-install-"));
    try {
      const worktree = join(dir, "wt");
      mkdirSync(worktree);
      writeFileSync(
        join(worktree, "package.json"),
        '{"name":"x","version":"1.0.0","private":true}\n',
      );
      writeFileSync(join(worktree, "pnpm-lock.yaml"), EMPTY_LOCK);
      const r = spawnSync("pnpm", [...INSTALL_ARGS], {
        cwd: worktree,
        env: installEnv(worktree, join(dir, "store")),
        stdio: "ignore",
        timeout: PROBE_INSTALL_MS,
      });
      return r.status === 0;
    } catch {
      return false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

/** Whether `cap` is blocked here, and why a test skipped for it should say so. */
export async function capabilityBlocked(
  cap: Capability,
  opts: { env?: NodeJS.ProcessEnv; probe?: () => Promise<boolean> } = {},
): Promise<boolean> {
  if (!inSeatSandbox(opts.env)) return false;
  return !(await (opts.probe ?? probes[cap])());
}

/**
 * Top-level `await` in a test file: true when the file's tests for `cap` should be skipped
 * (use as `describe.skipIf(await blockedHere("install"))`).
 */
export async function blockedHere(cap: Capability): Promise<boolean> {
  const blocked = await capabilityBlocked(cap);
  if (blocked)
    process.stderr.write(
      `sandbox-gaps: skipping tests that need "${cap}": this seat's sandbox denies it; CI runs them.\n`,
    );
  return blocked;
}
