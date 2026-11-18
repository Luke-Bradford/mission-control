/** The Quality tab's daily series: the rolling rate and where collection starts. */

/** Days in the rolling rate. */
export const ROLLING_DAYS = 7;

/** A validated daily numerator and denominator for one quality measure. */
export interface DailyCount {
  pass: number;
  total: number;
}

export interface QualityDay {
  at: number;
  ci: DailyCount | null;
  firstPass: DailyCount | null;
  rounds: DailyCount | null;
}

const finiteCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Reads the server's fixed quality window without trusting an untyped API response. */
export function readQuality14(value: unknown): QualityDay[] | null {
  if (!Array.isArray(value) || value.length !== 14) return null;
  const rows: QualityDay[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    if (typeof r.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.day)) return null;
    const [year, month, day] = r.day.split("-").map(Number);
    const at = Date.UTC(year as number, (month as number) - 1, day as number);
    if (!Number.isFinite(at)) return null;
    const count = (pass: unknown, total: unknown): DailyCount | null => {
      if (!finiteCount(pass) || !finiteCount(total) || pass > total) return null;
      return total === 0 ? null : { pass, total };
    };
    const ci = count(r.ciGreenPrs, r.ciPrs);
    const firstPass = count(r.firstPassPrs, r.reviewedPrs);
    const rounds = count(r.roundsSum, r.reviewedPrs);
    // A negative or over-total numerator is malformed, not an uncollected day.
    if (
      !finiteCount(r.ciGreenPrs) ||
      !finiteCount(r.ciPrs) ||
      !finiteCount(r.firstPassPrs) ||
      !finiteCount(r.reviewedPrs) ||
      !finiteCount(r.roundsSum) ||
      (r.ciGreenPrs as number) > (r.ciPrs as number) ||
      (r.firstPassPrs as number) > (r.reviewedPrs as number)
    )
      return null;
    rows.push({ at, ci, firstPass, rounds });
  }
  return rows;
}

/**
 * The pooled rate across trailing daily counts. A day without data is itself a gap (null): the line
 * does not run through a day that has no bar. Uncollected earlier days do not add a denominator.
 */
export function rollingRate(
  daily: readonly (DailyCount | null)[],
  window = ROLLING_DAYS,
): (number | null)[] {
  return daily.map((day, i) => {
    if (day === null) return null;
    const seen = daily.slice(Math.max(0, i - window + 1), i + 1).filter((v) => v !== null);
    const total = seen.reduce((sum, v) => sum + (v as DailyCount).total, 0);
    return total === 0
      ? null
      : (seen.reduce((sum, v) => sum + (v as DailyCount).pass, 0) / total) * 100;
  });
}

/** Index of the first day with a value; -1 when no day has one. */
export const collectedFrom = (daily: readonly (number | null)[]): number =>
  daily.findIndex((v) => v !== null);
