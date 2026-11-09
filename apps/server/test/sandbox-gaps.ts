/**
 * Server-side capabilities for the seat-sandbox skips (#1411); the shared rule and the generic
 * probes (listen, seatbelt, ps, git-hooks) are in packages/core/test/sandbox-gaps.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type BaseCapability,
  baseProbes,
  inSeatSandbox,
  noteSkip,
  probeBlocked,
  skipTestsIf,
} from "../../../packages/core/test/sandbox-gaps.ts";
import { INSTALL_ARGS, installEnv } from "../src/runtime/checkouts.ts";
import { crewTempRoot } from "../src/runtime/supervisor.ts";

export { inSeatSandbox, skipTestsIf };

export type Capability = BaseCapability | "install" | "crew-run";

const PROBE_INSTALL_MS = 10_000;
const EMPTY_LOCK = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";

const serverProbes: Record<"install" | "crew-run", () => Promise<boolean>> = {
  // a crew run keeps its files in a temp folder the seat's sandbox does not own
  "crew-run": async () => {
    const path = crewTempRoot("sandbox-gaps-probe", "run", process.getuid?.() ?? 0);
    if (!(await baseProbes.ps())) return false;
    try {
      mkdirSync(dirname(path), { mode: 0o700, recursive: true });
      mkdirSync(path, { mode: 0o700 });
      rmdirSync(path);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EEXIST";
    }
  },
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

const probeOf = (cap: Capability): (() => Promise<boolean>) =>
  cap === "install" || cap === "crew-run" ? serverProbes[cap] : baseProbes[cap];

/** Whether `cap` is blocked here: in a seat, and its probe fails. */
export const capabilityBlocked = (
  cap: Capability,
  opts: { env?: NodeJS.ProcessEnv; probe?: () => Promise<boolean> } = {},
): Promise<boolean> => probeBlocked(opts.probe ?? probeOf(cap), opts.env);

/** Top-level `await` in a test file: true when its tests for `cap` should be skipped. */
export async function blockedHere(cap: Capability): Promise<boolean> {
  const blocked = await capabilityBlocked(cap);
  if (blocked) noteSkip(cap);
  return blocked;
}
