/**
 * Probes for the few tests that exercise a capability a seat's own sandbox refuses: listening on
 * loopback, applying a Seatbelt profile, running a real `pnpm install`. Each is skipped only when its
 * probe is refused, and never on CI, where a refused probe is a failure the test itself reports.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** True when tests run on CI, where nothing may be skipped for lack of a capability. */
export const ON_CI = process.env.CI === "true";

/** Skip a test when its capability probe was refused, unless on CI. */
export const skipWhenRefused = (capable: boolean): boolean => !capable && !ON_CI;

let loopback: boolean | undefined;
/** True when this process may listen on 127.0.0.1. */
export function canListenOnLoopback(): boolean {
  loopback ??=
    spawnSync(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().on('error',()=>process.exit(1)).listen(0,'127.0.0.1',()=>process.exit(0))",
      ],
      { stdio: "ignore", timeout: 10_000 },
    ).status === 0;
  return loopback;
}

let seatbelt: boolean | undefined;
/** True when this process may apply a Seatbelt profile (a process already inside one may not). */
export function canApplySeatbelt(): boolean {
  seatbelt ??=
    process.platform === "darwin" &&
    spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: "ignore",
      timeout: 10_000,
    }).status === 0;
  return seatbelt;
}

let install: boolean | undefined;
/** True when a real, empty `pnpm install --frozen-lockfile` works here, as the install tests need. */
export function canRunPnpmInstall(): boolean {
  if (install !== undefined) return install;
  const dir = mkdtempSync(join(tmpdir(), "mc-install-probe-"));
  try {
    mkdirSync(join(dir, "store"));
    writeFileSync(join(dir, "package.json"), '{"name":"probe","private":true}\n');
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n");
    install =
      spawnSync("pnpm", ["install", "--frozen-lockfile"], {
        cwd: dir,
        stdio: "ignore",
        timeout: 30_000,
        env: {
          ...process.env,
          CI: "false",
          NPM_CONFIG_WORKSPACE_DIR: dir,
          pnpm_config_store_dir: join(dir, "store"),
        },
      }).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return install;
}
