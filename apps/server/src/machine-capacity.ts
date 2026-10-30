import type { MachineSample } from "@mc/core";

export const MACHINE_CAPACITY_KEY = "machine-capacity";
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
  now - (config.loadWindowMin + config.clearAfterMin) * 60_000;

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function immediateReason(s: MachineSample, c: MachineCapacityConfig): string | null {
  if (s.diskFreeBytes !== null && s.diskFreeBytes < c.diskFreeGb * 1024 ** 3)
    return `disk free is ${gb(s.diskFreeBytes)} (below ${c.diskFreeGb} GB)`;
  if (s.diskFreeBytes !== null && s.diskTotalBytes !== null && s.diskTotalBytes > 0) {
    const pct = (s.diskFreeBytes / s.diskTotalBytes) * 100;
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
  if (swap !== null && swap.pctOfRam > c.swapUsedPct)
    return `${swap.description} (above ${c.swapUsedPct}%)`;
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
): MachineCapacity {
  const latest = samples.at(-1);
  if (latest === undefined) return { blocked: false, reason: null };
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
  const loaded = samples.some((s) => s.at >= now - clearMs && sustainedAt(s.at));
  return loaded
    ? {
        blocked: true,
        reason: `load was above ${config.loadPerCore}× cores; waiting ${config.clearAfterMin} minutes of headroom`,
      }
    : { blocked: false, reason: null };
}
