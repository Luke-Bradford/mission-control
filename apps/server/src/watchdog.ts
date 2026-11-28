import { execFile } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { HealthRow } from "@mc/core";

const execFileP = promisify(execFile);

export const WATCHDOG_INTERVAL_MS = 60_000;
export const WATCHDOG_FAILURE_MS = 5 * 60_000;
export const WATCHDOG_EXIT_GAP_MS = 60 * 60_000;
export const WATCHDOG_OPEN_FILE_PCT = 80;
export const HUB_WATCHDOG_RESTART_SETTING = "hub-watchdog-restart";
const HUB_WATCHDOG_EXIT_SETTING = "hub-watchdog-last-exit";

export interface WatchdogProbe {
  openFiles: number;
  limit: number | null;
  folders: string[];
  error: string | null;
}

export interface HubWatchdog {
  check(): Promise<void>;
  health(): HealthRow;
  files(): { openFiles: number; limit: number | null } | null;
}

export interface HubWatchdogDeps {
  now: () => number;
  probe: () => Promise<WatchdogProbe>;
  event: (text: string) => void;
  notice: (text: string) => void;
  setting: (key: string) => string | null;
  setSetting: (key: string, value: string) => void;
  exit: (code: number) => void;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const lastExit = (read: (key: string) => string | null): number => {
  const raw = read(HUB_WATCHDOG_EXIT_SETTING);
  if (raw === null) return -Infinity;
  const value = Number(raw);
  return Number.isFinite(value) ? value : -Infinity;
};

/** Checks the hub can still fork and has enough file descriptors left to recover itself. */
export function createHubWatchdog(deps: HubWatchdogDeps): HubWatchdog {
  let failedSince: number | null = null;
  let latest: WatchdogProbe | null = null;
  let row: HealthRow = {
    collector: "watchdog",
    ok: true,
    error: null,
    at: 0,
    lastOkAt: null,
  };

  const fail = (cause: string, now: number, probe: WatchdogProbe): void => {
    failedSince ??= now;
    row = { collector: "watchdog", ok: false, error: cause, at: now, lastOkAt: row.lastOkAt };
    const urgent =
      probe.limit !== null && probe.openFiles / probe.limit >= WATCHDOG_OPEN_FILE_PCT / 100;
    if (!urgent && now - failedSince < WATCHDOG_FAILURE_MS) return;
    const text = `Hub watchdog: ${urgent ? "open files reached" : "spawn check failed for"} ${urgent ? `${probe.openFiles}/${probe.limit}` : "5 minutes"}: ${cause}. Open-file folders: ${probe.folders.join(", ") || "unavailable"}.`;
    if (now - lastExit(deps.setting) < WATCHDOG_EXIT_GAP_MS) {
      deps.event(text);
      deps.notice(
        `Hub watchdog did not restart: it already restarted within the last hour. ${cause}`,
      );
      return;
    }
    deps.event(text);
    deps.setSetting(HUB_WATCHDOG_EXIT_SETTING, String(now));
    deps.setSetting(
      HUB_WATCHDOG_RESTART_SETTING,
      JSON.stringify({ at: now, cause, folders: probe.folders }),
    );
    deps.exit(1);
  };

  return {
    async check(): Promise<void> {
      const now = deps.now();
      try {
        const probe = await deps.probe();
        latest = probe;
        const pressure =
          probe.limit !== null && probe.openFiles / probe.limit >= WATCHDOG_OPEN_FILE_PCT / 100;
        if (probe.error !== null || pressure) {
          fail(probe.error ?? `open files ${probe.openFiles}/${probe.limit}`, now, probe);
          return;
        }
        failedSince = null;
        row = { collector: "watchdog", ok: true, error: null, at: now, lastOkAt: now };
      } catch (error) {
        fail(`watchdog probe: ${errorText(error)}`, now, {
          openFiles: 0,
          limit: null,
          folders: [],
          error: null,
        });
      }
    },
    health: () => row,
    files: () => (latest === null ? null : { openFiles: latest.openFiles, limit: latest.limit }),
  };
}

/** The macOS process file limit is inherited by this shell, as it is by the hub. */
export async function realWatchdogProbe(): Promise<WatchdogProbe> {
  let error: string | null = null;
  try {
    await execFileP("/usr/bin/true", [], { timeout: 2_000 });
  } catch (e) {
    error = errorText(e);
  }
  const fds = await readdir("/dev/fd");
  let limit: number | null = null;
  try {
    const { stdout } = await execFileP("/bin/sh", ["-c", "ulimit -n"], { timeout: 2_000 });
    const n = Number(stdout.trim());
    limit = Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch (e) {
    error ??= errorText(e);
  }
  const counts = new Map<string, number>();
  await Promise.all(
    fds.map(async (fd) => {
      try {
        const folder = dirname(await readlink(`/dev/fd/${fd}`));
        counts.set(folder, (counts.get(folder) ?? 0) + 1);
      } catch {
        // A descriptor may close while this diagnostic reads it.
      }
    }),
  );
  const folders = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([folder, count]) => `${folder} (${count})`);
  return { openFiles: fds.length, limit, folders, error };
}
