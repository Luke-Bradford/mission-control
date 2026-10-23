/** Quota windows as the Overview and (later) Setup show them. */
import { type AccountId, type LimitRow, MIN_PACE_5H_MINUTES } from "@mc/core";
import { dayMonth, hhmm, isoDay, wkdTime } from "./fmt.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIVE_HOURS = 5 * HOUR;

/** What a 5h window too young for a pace says, whether the hub or the clock found it so. */
const TOO_YOUNG = "too little history for a pace";

/** The account's first quota window: its 5h row, else its 7d row; null when it has neither. */
export function firstWindow(limits: LimitRow[], accountId: AccountId): LimitRow | null {
  const mine = limits.filter((l) => l.accountId === accountId);
  return mine.find((l) => l.window === "5h") ?? mine.find((l) => l.window === "7d") ?? null;
}

/** Time until a window is full at the current pace. */
export function timeToFull(row: LimitRow, now: number): string {
  if (row.used >= 100) return "at limit";
  // A missing paceReady is ready: an older hub does not send it.
  if (row.window === "5h" && row.paceReady === false) return TOO_YOUNG;
  if (row.fullAt === null) {
    // The server gives a 5h window no pace until MIN_PACE_5H_MINUTES of it have passed.
    const young =
      row.window === "5h" && now - (row.resetAt - FIVE_HOURS) < MIN_PACE_5H_MINUTES * MINUTE;
    return young ? TOO_YOUNG : "not filling at this rate";
  }
  const ms = Math.max(0, row.fullAt - now);
  if (ms >= DAY) return `~${Math.floor(ms / DAY)}d`;
  const h = Math.floor(ms / HOUR);
  const mm = Math.floor((ms % HOUR) / 60_000);
  return `~${h}h${String(mm).padStart(2, "0")}`;
}

/** A window's reset: a clock time for the 5-hour window, weekday and time for the 7-day one. */
export const resetLabel = (row: LimitRow, tz: string): string =>
  row.window === "5h" ? hhmm(row.resetAt, tz) : wkdTime(row.resetAt, tz);

/** When a window resets: the clock time if that is later today, else weekday, date and time. */
export function resetWhen(row: LimitRow, now: number, tz: string): string {
  return isoDay(row.resetAt, tz) === isoDay(now, tz)
    ? hhmm(row.resetAt, tz)
    : wkdTime(row.resetAt, tz).replace(" ", ` ${dayMonth(row.resetAt, tz)} `);
}

/** Windows at their limit (red) and windows that will fill before they reset (amber). */
export function quotaWarnings(
  rows: LimitRow[],
  now: number,
  tz: string,
): { crit: boolean; text: string }[] {
  const out: { crit: boolean; text: string }[] = [];
  for (const r of rows) {
    if (r.used >= 100) {
      out.push({
        crit: true,
        text: `${r.accountId} ${r.window} at its limit until ${resetLabel(r, tz)}`,
      });
    } else if (r.fullAt !== null) {
      // Due within the minute (or already): "full in ~0h00" would read as a countdown.
      const when =
        r.fullAt - now < MINUTE
          ? "full at this rate now"
          : `full in ${timeToFull(r, now)} at this rate`;
      out.push({
        crit: false,
        text: `${r.accountId} ${r.window} ${when} (resets ${resetLabel(r, tz)})`,
      });
    }
  }
  return out;
}
