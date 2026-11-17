/** The Quality tab's daily series: the rolling rate and where collection starts. */

/** Days in the rolling rate. */
export const ROLLING_DAYS = 7;

/**
 * The mean of the daily rates over the trailing `window` days, for each day. A day without data
 * is skipped inside the window, never counted as zero, and is itself a gap (null): the line does not
 * run through a day that has no bar. This is a mean of daily rates until the server sends counts.
 */
export function rollingRate(
  daily: readonly (number | null)[],
  window = ROLLING_DAYS,
): (number | null)[] {
  return daily.map((day, i) => {
    if (day === null) return null;
    const seen = daily.slice(Math.max(0, i - window + 1), i + 1).filter((v) => v !== null);
    return seen.length === 0 ? null : seen.reduce((a, b) => a + b, 0) / seen.length;
  });
}

/** Index of the first day with a value; -1 when no day has one. */
export const collectedFrom = (daily: readonly (number | null)[]): number =>
  daily.findIndex((v) => v !== null);
