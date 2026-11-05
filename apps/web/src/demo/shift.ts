/** Moving a data set in time: the seed is fixed at one instant, and Demo plays it at "now". */

const DAY_MS = 86_400_000;
/** A number this close to the seed's instant is a timestamp; anything farther is a count. */
export const SHIFT_WINDOW_MS = 90 * DAY_MS;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * A deep copy of `value` with every number within 90 days of `anchor`, and every ISO date string
 * (with the same limit), moved by `delta` milliseconds. Pure: the input is left as it was.
 */
export function shiftTimes<T>(value: T, anchor: number, delta: number): T {
  if (delta === 0) return structuredClone(value);
  const walk = (v: unknown): unknown => {
    if (typeof v === "number")
      return Number.isFinite(v) && Math.abs(v - anchor) <= SHIFT_WINDOW_MS ? v + delta : v;
    if (typeof v === "string" && ISO_DATE.test(v)) {
      const t = Date.parse(v);
      return Math.abs(t - anchor) <= SHIFT_WINDOW_MS ? new Date(t + delta).toISOString() : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
