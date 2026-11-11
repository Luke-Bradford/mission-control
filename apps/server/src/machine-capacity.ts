import type { MachineSample } from "@mc/core";
import type { Store } from "./store.ts";

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
