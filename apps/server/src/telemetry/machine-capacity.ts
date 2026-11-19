import type { MachineSample } from "@mc/core";
import { FILE_SERVICE } from "../collectors/machine.ts";
import type { Store } from "../store.ts";

export const MACHINE_CAPACITY_KEY = "machine-capacity";
export const DISK_PERCENTAGE_CLEAR_HEADROOM = 1;
export const DISK_PERCENTAGE_CLEAR_AFTER_MIN = 10;
/** Recovery needs readings this close together; a longer gap in collection restarts the wait. */
export const DISK_PERCENTAGE_MAX_GAP_MS = 2 * 60_000;
const DISK_EPISODE_SETTING = "machine-capacity:disk-percentage-episode";
export const MACHINE_CAPACITY_DEFAULTS = {
  diskFreeGb: 15,
  diskFreePct: 5,
  swapUsedPct: 60,
  memoryFreePct: 10,
  loadPerCore: 1.5,
  loadWindowMin: 5,
  clearAfterMin: 5,
} as const;

/** Swap alone is an emergency only once it exceeds this share of physical RAM. */
export const SWAP_USED_HARD_PCT_OF_RAM = 90;

/** Swap alone is an emergency once it fills this share of the swap file itself (#1812). */
export const SWAP_FILE_USED_HARD_PCT = 85;
/** ...but only when that much swap is also a real share of physical RAM. */
export const SWAP_FILE_MIN_PCT_OF_RAM = 50;
/**
 * The file-change service (`fseventsd`) hurts the Mac near this size: on 29 October it made the
 * Mac unusable at 7 GB, so this holds a little before that. A runaway is caught and restarted long before this (see
 * `fileServiceRunaway`); this hold is only the backstop for when that restart could not run.
 */
export const FSEVENTSD_RSS_HARD_BYTES = 6 * 1024 ** 3;
/**
 * A healthy `fseventsd` stays flat under crew work: from 13 to 18 November it held 5 to 13 MB
 * through 100 to 230 runs a day, and grew 31 MB in its busiest hour. In the stuck state seen on
 * 18 November it kept every event and grew 150 to 317 MB an hour until restarted.
 */
export const FSEVENTSD_RUNAWAY_BYTES = 150 * 1024 ** 2;
export const FSEVENTSD_RUNAWAY_WINDOW_MS = 60 * 60_000;
/**
 * A service this large is stuck whether or not it is still growing (it may have levelled off
 * while the hub was down or the crew idle): healthy, it holds megabytes, not a gigabyte.
 */
export const FSEVENTSD_STUCK_BYTES = 1024 ** 3;
/** At most one diagnostics capture in this long, so the one from the onset is kept. */
export const FILE_SERVICE_CAPTURE_GAP_MS = 6 * 60 * 60_000;
/** This many restarts within `FILE_SERVICE_RECURRING_WINDOW_MS` means restarting is not fixing it. */
export const FILE_SERVICE_RECURRING_RESTARTS = 3;
/** The window for `FILE_SERVICE_RECURRING_RESTARTS`; independent of the capture gap. */
export const FILE_SERVICE_RECURRING_WINDOW_MS = 6 * 60 * 60_000;
/**
 * A reading under this is a healthy service again, so an open alert may clear. A size, unlike
 * `FSEVENTSD_RUNAWAY_BYTES` (an amount of growth); equal today by choice, not by necessity.
 */
export const FSEVENTSD_HEALTHY_BYTES = 150 * 1024 ** 2;
/** The setting holding when the hub last saved diagnostics. */
export const FILE_SERVICE_CAPTURE_SETTING = "machine-capacity:fseventsd-capture-at";
/** The setting holding the times of the hub's recent successful restarts, as a JSON array. */
export const FILE_SERVICE_RESTARTS_SETTING = "machine-capacity:fseventsd-restarts";
/** The setting holding when the hub last tried to restart a runaway `fseventsd`. */
export const FILE_SERVICE_RESTART_SETTING = "machine-capacity:fseventsd-restart-at";
/** The operator alert for a runaway the hub could not restart, or one that keeps coming back. */
export const FILE_SERVICE_RUNAWAY_KEY = "file-service-runaway";
/**
 * The one sudoers rule that lets the hub restart it unattended, and nothing else. Root writes it
 * under a dotted name (sudo ignores those), checks it, and only then moves it into place, so no
 * user-writable file sits between the check and the install and a bad line never goes live; the
 * last step shows whether sudo now grants the command without a password.
 */
export const FILE_SERVICE_SUDOERS_ADVICE =
  'To let the hub restart it by itself next time, run once in Terminal: `sudo sh -c \'umask 337; printf "%s ALL=(root) NOPASSWD: /usr/bin/killall fseventsd\\n" "$1" > /etc/sudoers.d/.mc-fseventsd && visudo -cf /etc/sudoers.d/.mc-fseventsd && mv /etc/sudoers.d/.mc-fseventsd /etc/sudoers.d/mc-fseventsd\' _ "$(whoami)" && sudo -k && sudo -n /usr/bin/killall fseventsd && echo "The hub can now restart it."`. The last step restarts it once without a password, as the hub will, and says so. It allows only that one command; any program running as you could then restart fseventsd, and nothing more.';

export interface FileServiceRunaway {
  fromBytes: number;
  toBytes: number;
  sinceAt: number;
}

/** One reading of `fseventsd` taken at that minute (never a figure carried forward). */
export interface FileServiceReading {
  at: number;
  bytes: number;
}

/**
 * `fseventsd` grew by the runaway amount within the last hour of fresh readings, or holds the
 * stuck size at the latest one; null if neither. Only readings actually taken count: a figure
 * carried forward while the hub was idle says nothing about when it was reached.
 */
export function fileServiceRunaway(
  readings: readonly FileServiceReading[],
  now: number,
): FileServiceRunaway | null {
  const recent = readings.filter(
    (r) => r.at >= now - FSEVENTSD_RUNAWAY_WINDOW_MS && r.at <= now && r.bytes > 0,
  );
  const latest = recent.at(-1);
  if (latest === undefined) return null;
  let low = latest;
  for (const r of recent) if (r.bytes < low.bytes) low = r;
  return latest.bytes - low.bytes >= FSEVENTSD_RUNAWAY_BYTES ||
    latest.bytes >= FSEVENTSD_STUCK_BYTES
    ? { fromBytes: low.bytes, toBytes: latest.bytes, sinceAt: low.at }
    : null;
}
/** What a swollen file-change service costs to fix, for the Needs-you item. */
export const FILE_SERVICE_RESTART_ADVICE =
  "Restart the file-change service: run `sudo killall fseventsd` in Terminal. macOS starts it again by itself; it takes about 15 seconds and the Mac does not restart.";

export interface MachineCapacityConfig {
  diskFreeGb: number;
  diskFreePct: number;
  swapUsedPct: number;
  memoryFreePct: number;
  loadPerCore: number;
  loadWindowMin: number;
  clearAfterMin: number;
}

export interface MachineCapacity {
  blocked: boolean;
  /** The concrete measured reason, suitable for an operator-facing refusal. */
  reason: string | null;
}

/** Earliest persisted reading needed to assess a sustained breach and its recovery period. */
export const machineCapacitySince = (now: number, config: MachineCapacityConfig): number =>
  now -
  (Math.max(config.loadWindowMin + config.clearAfterMin, DISK_PERCENTAGE_CLEAR_AFTER_MIN) + 1) *
    60_000;

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

const diskFreePct = (s: MachineSample): number | null =>
  s.diskFreeBytes !== null && s.diskTotalBytes !== null && s.diskTotalBytes > 0
    ? (s.diskFreeBytes / s.diskTotalBytes) * 100
    : null;

function percentageDiskBreach(
  samples: readonly MachineSample[],
  now: number,
  config: MachineCapacityConfig,
  persistedAt: number | null,
): number | null {
  let breachedAt = persistedAt;
  for (const sample of samples) {
    const pct = diskFreePct(sample);
    if (sample.at <= now && pct !== null && pct < config.diskFreePct)
      breachedAt = Math.max(breachedAt ?? -Infinity, sample.at);
  }
  if (breachedAt === null) return null;
  const since = now - DISK_PERCENTAGE_CLEAR_AFTER_MIN * 60_000;
  const anchor = samples.findLast((sample) => sample.at <= since);
  if (anchor === undefined || anchor.at <= breachedAt) return breachedAt;
  const window = samples.filter((sample) => sample.at >= anchor.at && sample.at <= now);
  const covered =
    window.every(
      (sample, i) => i === 0 || sample.at - window[i - 1].at <= DISK_PERCENTAGE_MAX_GAP_MS,
    ) && now - window[window.length - 1].at <= DISK_PERCENTAGE_MAX_GAP_MS;
  const recovered =
    covered &&
    window.every((sample) => {
      const pct = diskFreePct(sample);
      return pct !== null && pct > config.diskFreePct + DISK_PERCENTAGE_CLEAR_HEADROOM;
    });
  return recovered ? null : breachedAt;
}

/** The persisted episode is shared by every admission caller and survives a hub restart. */
export function storedMachineCapacity(
  store: Pick<Store, "machineSamples" | "getSetting" | "setSetting">,
  now: number,
  config: MachineCapacityConfig = MACHINE_CAPACITY_DEFAULTS,
  latest?: MachineSample | null,
): MachineCapacity {
  const raw = store.getSetting(DISK_EPISODE_SETTING);
  let persistedAt: number | null = null;
  let known = false;
  try {
    const saved: unknown = JSON.parse(raw ?? "null");
    if (
      saved !== null &&
      typeof saved === "object" &&
      "floor" in saved &&
      saved.floor === config.diskFreePct &&
      "breachedAt" in saved &&
      (saved.breachedAt === null ||
        (typeof saved.breachedAt === "number" &&
          Number.isFinite(saved.breachedAt) &&
          saved.breachedAt <= now))
    ) {
      known = true;
      persistedAt = saved.breachedAt;
    }
  } catch {
    // A missing or invalid setting is reconstructed from the retained readings.
  }
  const samples = store.machineSamples(known ? machineCapacitySince(now, config) : 0);
  if (latest !== undefined && latest !== null) {
    const index = samples.findIndex((sample) => sample.at === latest.at);
    if (index === -1) samples.push(latest);
    else samples[index] = latest;
    samples.sort((a, b) => a.at - b.at);
  }
  const breachedAt = percentageDiskBreach(samples, now, config, persistedAt);
  const state = JSON.stringify({ floor: config.diskFreePct, breachedAt });
  if (raw !== state) store.setSetting(DISK_EPISODE_SETTING, state);
  return machineCapacity(samples, now, config, breachedAt);
}

/** Why the file-change service or a nearly full swap file needs a restart of that service; null if neither. */
export function fileServiceFault(s: MachineSample): string | null {
  // `ps` RSS leaves out compressed pages, so the collector's own reading is judged too
  const held = Math.max(
    s.fileServiceBytes ?? 0,
    s.topConsumers?.find((p) => p.command === FILE_SERVICE)?.rssBytes ?? 0,
  );
  if (held > FSEVENTSD_RSS_HARD_BYTES)
    return `the file-change service (fseventsd) holds ${gb(held)} of memory (above ${gb(FSEVENTSD_RSS_HARD_BYTES)})`;
  if (
    s.swapUsedBytes !== null &&
    s.swapUsedBytes !== undefined &&
    s.swapTotalBytes !== null &&
    s.swapTotalBytes !== undefined &&
    s.swapTotalBytes > 0 &&
    (s.swapUsedBytes / s.swapTotalBytes) * 100 > SWAP_FILE_USED_HARD_PCT &&
    // macOS shrinks its swap file, so a small one is often nearly full on a healthy Mac (#1052)
    s.memTotalBytes > 0 &&
    (s.swapUsedBytes / s.memTotalBytes) * 100 > SWAP_FILE_MIN_PCT_OF_RAM
  )
    return `the swap file is ${gb(s.swapUsedBytes)} full of ${gb(s.swapTotalBytes)} (above ${SWAP_FILE_USED_HARD_PCT}%)`;
  return null;
}

function immediateReason(s: MachineSample, c: MachineCapacityConfig): string | null {
  if (s.diskFreeBytes !== null && s.diskFreeBytes < c.diskFreeGb * 1024 ** 3)
    return `disk free is ${gb(s.diskFreeBytes)} (below ${c.diskFreeGb} GB)`;
  const pct = diskFreePct(s);
  if (pct !== null) {
    if (pct < c.diskFreePct) return `disk free is ${pct.toFixed(1)}% (below ${c.diskFreePct}%)`;
  }
  const swap =
    s.swapUsedBytes !== null && s.swapUsedBytes !== undefined && s.memTotalBytes > 0
      ? {
          pctOfRam: (s.swapUsedBytes / s.memTotalBytes) * 100,
          description: `swap used is ${gb(s.swapUsedBytes)} of ${gb(s.memTotalBytes)} RAM`,
        }
      : null;
  if (swap !== null && swap.pctOfRam > SWAP_USED_HARD_PCT_OF_RAM)
    return `${swap.description} (above ${SWAP_USED_HARD_PCT_OF_RAM}%)`;
  if (
    swap !== null &&
    swap.pctOfRam > c.swapUsedPct &&
    s.memoryPressureFreePct !== null &&
    s.memoryPressureFreePct !== undefined &&
    s.memoryPressureFreePct < c.memoryFreePct
  )
    return `${swap.description} (above ${c.swapUsedPct}%) and memory free is ${s.memoryPressureFreePct.toFixed(1)}% (below ${c.memoryFreePct}%)`;
  const fault = fileServiceFault(s);
  if (fault !== null) return fault;
  if (
    s.memoryPressureFreePct !== null &&
    s.memoryPressureFreePct !== undefined &&
    s.memoryPressureFreePct < c.memoryFreePct
  )
    return `memory free is ${s.memoryPressureFreePct.toFixed(1)}% (below ${c.memoryFreePct}%)`;
  return null;
}

/** Machine admission, including the sustained-load and clear hysteresis windows. */
export function machineCapacity(
  samples: readonly MachineSample[],
  now: number,
  config: MachineCapacityConfig = MACHINE_CAPACITY_DEFAULTS,
  diskBreachAt: number | null = null,
): MachineCapacity {
  const latest = samples.at(-1);
  if (latest === undefined && diskBreachAt === null) return { blocked: false, reason: null };
  if (latest === undefined)
    return { blocked: true, reason: "disk recovery readings are not yet available" };
  const direct = immediateReason(latest, config);
  if (direct !== null) return { blocked: true, reason: direct };
  const windowMs = config.loadWindowMin * 60_000;
  const sustainedAt = (at: number): boolean => {
    const recent = samples.filter((s) => s.at >= at - windowMs && s.at <= at);
    return (
      recent[0]?.at !== undefined &&
      recent[0].at <= at - windowMs &&
      recent.every(
        (s) => s.load1 !== null && s.load1 !== undefined && s.load1 > s.cores * config.loadPerCore,
      )
    );
  };
  if (sustainedAt(now))
    return {
      blocked: true,
      reason: `load is ${latest.load1?.toFixed(1) ?? "—"} on ${latest.cores} cores (above ${config.loadPerCore}× cores for ${config.loadWindowMin} minutes)`,
    };

  // A sample over any threshold within the clear window remains held. This makes recovery stable
  // across restarts because it is derived from the persisted samples rather than process memory.
  const clearMs = config.clearAfterMin * 60_000;
  const prior = samples
    .filter((s) => s.at >= now - clearMs)
    .map((s) => immediateReason(s, config))
    .find(Boolean);
  if (prior)
    return {
      blocked: true,
      reason: `${prior}; waiting ${config.clearAfterMin} minutes of headroom`,
    };
  if (percentageDiskBreach(samples, now, config, diskBreachAt) !== null)
    return {
      blocked: true,
      reason: `disk free is waiting ${DISK_PERCENTAGE_CLEAR_AFTER_MIN} minutes above ${(config.diskFreePct + DISK_PERCENTAGE_CLEAR_HEADROOM).toFixed(0)}%`,
    };
  const loaded = samples.some((s) => s.at >= now - clearMs && sustainedAt(s.at));
  return loaded
    ? {
        blocked: true,
        reason: `load was above ${config.loadPerCore}× cores; waiting ${config.clearAfterMin} minutes of headroom`,
      }
    : { blocked: false, reason: null };
}
