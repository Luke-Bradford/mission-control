import { METER_FULL_PCT } from "./hud.ts";
import type { UsageSample } from "./types.ts";

const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;

const sorted = (samples: UsageSample[]): UsageSample[] => [...samples].sort((a, b) => a.at - b.at);

function interpolate(h: UsageSample[], at: number): number | null {
  const first = h[0];
  const last = h[h.length - 1];
  if (!first || !last) return null;
  if (at <= first.at) return first.pct;
  for (let i = 1; i < h.length; i++) {
    const b = h[i] as UsageSample;
    if (b.at >= at) {
      const a = h[i - 1] as UsageSample;
      if (b.at === a.at) return b.pct;
      return a.pct + ((b.pct - a.pct) * (at - a.at)) / (b.at - a.at);
    }
  }
  return last.pct;
}

/** Linear interpolation of pct at `at`, clamped to the first/last sample. Null if no samples. */
export function usageAt(samples: UsageSample[], at: number): number | null {
  return interpolate(sorted(samples), at);
}

/** Below this many hours of samples, a pace is too noisy to project from: pace is null. */
export const MIN_PACE_HOURS = 3;

/*
 * Contract for pace24h / projectAtReset / stopForecast: `samples` are ONE account's readings of
 * ONE window, all taken since that window's last reset (the caller filters; a previous window's
 * samples would make the pace meaningless). Input need not be sorted and is never mutated.
 */

/**
 * Percentage points per hour over the last 24h before `at` (default: the last sample), or over
 * the hours actually covered when the samples span less than 24h:
 * `(usage(end) - usage(max(first.at, end - 24h))) / min(24, (end - first.at) / 1h)`.
 * Null with fewer than 2 samples or under MIN_PACE_HOURS of coverage.
 */
export function pace24h(samples: UsageSample[], at?: number): number | null {
  const h = sorted(samples);
  const first = h[0];
  const last = h[h.length - 1];
  if (h.length < 2 || !first || !last) return null;
  const end = at ?? last.at;
  const coveredHours = Math.min(24, (end - first.at) / HOUR_MS);
  if (coveredHours < MIN_PACE_HOURS) return null;
  const now = interpolate(h, end);
  const before = interpolate(h, Math.max(first.at, end - DAY_MS));
  if (now === null || before === null) return null;
  return (now - before) / coveredHours;
}

/**
 * Usage at `resetAt` if the pace (see pace24h) continues from `at` (default: the last sample).
 * Usage never falls within a window, so a zero or negative pace projects the current usage.
 * Null when pace is null. Same samples contract as pace24h.
 */
export function projectAtReset(
  samples: UsageSample[],
  resetAt: number,
  at?: number,
): number | null {
  const h = sorted(samples);
  const end = at ?? h[h.length - 1]?.at;
  if (end === undefined) return null;
  const now = interpolate(h, end);
  const pace = pace24h(h, end);
  if (now === null || pace === null) return null;
  return now + (Math.max(0, pace) * (resetAt - end)) / HOUR_MS;
}

/**
 * Epoch ms when usage reaches `stopAt` at the current pace (see pace24h), or null if not before
 * `resetAt`, already at/over `stopAt`, pace not positive, or pace null. Same samples contract.
 */
export function stopForecast(
  samples: UsageSample[],
  stopAt: number,
  resetAt: number,
): number | null {
  const h = sorted(samples);
  const last = h[h.length - 1];
  const pace = pace24h(h);
  if (!last || pace === null || last.pct >= stopAt || pace <= 0) return null;
  const ms = last.at + ((stopAt - last.pct) / pace) * HOUR_MS;
  return ms < resetAt ? ms : null;
}

/** `at` of the sample where `pred` turns true after a false one; the latest such transition. */
export function latestCrossing(
  samples: UsageSample[],
  pred: (s: UsageSample, i: number) => boolean,
): number | null {
  const h = sorted(samples);
  for (let i = h.length - 1; i > 0; i--) {
    const cur = h[i] as UsageSample;
    const prev = h[i - 1] as UsageSample;
    if (pred(cur, i) && !pred(prev, i - 1)) return cur.at;
  }
  return null;
}

/** Below this many minutes between a 5h window's first and last sample, its pace is noise. */
export const MIN_PACE_5H_MINUTES = 30;

/*
 * Contract for pace5h / fullAt5h: `samples` are ONE account's readings of its 5h window, all taken
 * since that window's last reset (the caller filters, as for pace24h). Input need not be sorted and
 * is never mutated.
 */

/**
 * Percentage points per hour from the first sample of the 5h window to `at` (default: the last
 * sample): `(usage(end) - first.pct) / hours(first.at .. end)`. Null with fewer than 2 samples or
 * less than MIN_PACE_5H_MINUTES between them.
 */
export function pace5h(samples: UsageSample[], at?: number): number | null {
  const h = sorted(samples);
  const first = h[0];
  const last = h[h.length - 1];
  if (h.length < 2 || !first || !last) return null;
  const end = at ?? last.at;
  if (end - first.at < MIN_PACE_5H_MINUTES * 60e3) return null;
  const now = interpolate(h, end);
  if (now === null) return null;
  return (now - first.pct) / ((end - first.at) / HOUR_MS);
}

/**
 * Epoch ms when the latest reading reaches 100 at the pace of pace5h, or null when the pace is
 * null or not positive, the reading is already at 100, or that time is at or after `resetAt`.
 */
export function fullAt5h(samples: UsageSample[], resetAt: number): number | null {
  const h = sorted(samples);
  const last = h[h.length - 1];
  const pace = pace5h(h);
  if (!last || pace === null || pace <= 0 || last.pct >= METER_FULL_PCT) return null;
  const ms = last.at + ((METER_FULL_PCT - last.pct) / pace) * HOUR_MS;
  return ms < resetAt ? ms : null;
}
