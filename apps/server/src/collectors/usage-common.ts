import type { UsageSample } from "@mc/core";

/** Default staleness bound: 2x the 30-minute usage poll interval. */
export const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export type Window = UsageSample["window"];
export const WINDOWS: readonly Window[] = ["5h", "7d"];

/** A window reading before it is stamped with an account and source. */
export interface WindowReading {
  window: Window;
  pct: number;
  resetAt: number;
  at: number;
}

/** A reading is usable when it is finite, fresh (not older than `maxAgeMs`) and has not yet reset. */
export function isUsable(r: WindowReading, now: number, maxAgeMs: number): boolean {
  return (
    Number.isFinite(r.pct) &&
    Number.isFinite(r.at) &&
    Number.isFinite(r.resetAt) &&
    now - r.at <= maxAgeMs &&
    r.resetAt > now
  );
}

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Per window, take the first usable reading from the ordered sources. Each source is only run
 * if some window is still missing; a throwing source is reported and skipped. Never throws.
 */
export async function collect(
  accountId: string,
  sources: { name: string; read: () => Promise<WindowReading[]> | WindowReading[] }[],
  now: number,
  maxAgeMs: number,
  onError?: (source: string, err: unknown) => void,
): Promise<UsageSample[]> {
  const got = new Map<Window, UsageSample>();
  for (const src of sources) {
    if (got.size === WINDOWS.length) break;
    let readings: WindowReading[];
    try {
      readings = await src.read();
    } catch (err) {
      onError?.(src.name, err);
      continue;
    }
    for (const r of readings) {
      if (got.has(r.window) || !isUsable(r, now, maxAgeMs)) continue;
      got.set(r.window, {
        accountId,
        window: r.window,
        at: r.at,
        pct: r.pct,
        resetAt: r.resetAt,
        source: src.name,
      });
    }
  }
  return WINDOWS.flatMap((w) => got.get(w) ?? []);
}
