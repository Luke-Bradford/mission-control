/**
 * Shared formatters for the HUD's numbers and times. `tz` is always `config.operator.timezone`
 * (`useTz()`); while it is loading, components show `—` instead of calling these (the doing line
 * shows its text without the time). A unit is chosen after rounding (99 960 tokens is `100k`,
 * 59.6 s is `1m 00s`).
 */
import { startOfLocalDay, zoneFormatter } from "@mc/core";

const DAY = 86_400_000;
const pad2 = (n: number): string => String(n).padStart(2, "0");

function format(ms: number, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return zoneFormatter(tz, opts).format(new Date(ms));
}

const HHMM: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/** `14:05` */
export const hhmm = (ms: number, tz: string): string => format(ms, tz, HHMM);

/**
 * Month and weekday names are fixed three-letter words: ICU's en-GB "short" month for September is
 * `Sept`, and the HUD's shape is `{d Mon}` everywhere.
 */
export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const YMD: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" };

/** The calendar date of `ms` in `tz`: year, month (1–12) and day. */
function localDate(ms: number, tz: string): { y: number; m: number; d: number } {
  const f = zoneFormatter(tz, YMD);
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year ?? 0, m: p.month ?? 1, d: p.day ?? 1 };
}

/** `Wed 08:00` */
export function wkdTime(ms: number, tz: string): string {
  const { y, m, d } = localDate(ms, tz);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${hhmm(ms, tz)}`;
}

/** `18 Oct` */
export function dayMonth(ms: number, tz: string): string {
  const { m, d } = localDate(ms, tz);
  return `${d} ${MONTHS[m - 1]}`;
}

/** The calendar date of `ms` in `tz`, `plusDays` later, as `YYYY-MM-DD` (an `<input type="date">` value). */
export function isoDay(ms: number, tz: string, plusDays = 0): string {
  const { y, m, d } = localDate(ms, tz);
  return new Date(Date.UTC(y, m - 1, d + plusDays)).toISOString().slice(0, 10);
}

/**
 * Away mode's `until` (a calendar date, whatever the zone) as `until Wed 28 Oct`; `until you turn it
 * off` for none. Built in UTC from the parts, so no timezone shifts the day.
 */
export function untilLabel(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return "until you turn it off";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return `until ${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[mo - 1]}`;
}

/** `11:02`: minutes and seconds, hours folded into the minutes. */
export function mss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/** `03:12:40`, the MET clock. */
export function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** `today` / `1d ago` / `{n}d ago` for a count of local days. */
/** How a PR is named on screen, wherever it is: `PR #77`. */
export const prLabel = (number: number): string => `PR #${number}`;

export const agoDays = (days: number): string => (days <= 0 ? "today" : `${days}d ago`);

/** `today` / `1d ago` / `{n}d ago`, counted in local days (a 23- or 25-hour day is one day). */
export function ago(ms: number, now: number, tz: string): string {
  return agoDays(Math.round((startOfLocalDay(now, tz) - startOfLocalDay(ms, tz)) / DAY));
}

/** `just now` / `{n} min ago` / `{n} h ago`, then `ago`'s day form; each unit floors. */
export function rel(ms: number, now: number, tz: string): string {
  const d = now - ms;
  if (d < 60_000) return "just now";
  const mins = Math.floor(d / 60_000);
  if (mins < 120) return `${mins} min ago`;
  const hours = Math.floor(d / 3_600_000);
  if (hours < 48) return `${hours} h ago`;
  return ago(ms, now, tz);
}

const round = (x: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};

/** `512 B`, `3.4 KB`, `12.3 MB`, `1.20 GB`; binary units throughout. */
export function bytes(n: number): string {
  if (n < 2 ** 10) return `${Math.round(n)} B`;
  if (n < 2 ** 20) return `${(n / 2 ** 10).toFixed(1)} KB`;
  if (n < 2 ** 30) return `${(n / 2 ** 20).toFixed(1)} MB`;
  return `${(n / 2 ** 30).toFixed(2)} GB`;
}

/** `950`, `60.1k` (one decimal under 100k), `612k`, `1.24M` (two decimals under 10M), `18.4M`. */
export function kTokens(n: number): string {
  if (Math.round(n) < 1000) return String(Math.round(n));
  const k1 = round(n / 1e3, 1);
  if (k1 < 100) return `${k1.toFixed(1)}k`;
  const k0 = Math.round(n / 1e3);
  if (k0 < 1000) return `${k0}k`;
  const m2 = round(n / 1e6, 2);
  if (m2 < 10) return `${m2.toFixed(2)}M`;
  return `${round(n / 1e6, 1).toFixed(1)}M`;
}

/** API-equivalent cost: `~$1.84`, or `—` when no run reported one. */
export const cost = (usd: number | null): string => (usd === null ? "—" : `~$${usd.toFixed(2)}`);

/** `<0.1s`, `3.4s` (one decimal under 10 s), `42s`, `6m 05s`, `1h 12m`. */
export function dur(ms: number): string {
  if (ms < 50) return "<0.1s";
  const s1 = round(ms / 1000, 1);
  if (s1 < 10) return `${s1.toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  const m = Math.round(ms / 60_000);
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

/** A `YYYY-MM-DD` calendar day's parts, built in UTC so no timezone shifts it; null if malformed. */
function calendarDay(
  day: string,
): { wd: (typeof WEEKDAYS)[number]; d: number; mon: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wd = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  const mon = MONTHS[mo - 1];
  return wd && mon ? { wd, d, mon } : null;
}

/** `Sat 17 Oct` for the calendar day `2026-10-17`; the input itself if it is not one. */
export function dayLabel(day: string): string {
  const c = calendarDay(day);
  return c ? `${c.wd} ${c.d} ${c.mon}` : day;
}

/** `S17`: the narrow weekday and the date, for a day axis. */
export function narrowDay(day: string): string {
  const c = calendarDay(day);
  return c ? `${c.wd[0]}${c.d}` : day;
}

/** At most `max` characters (code points, so a cut never splits a pair), the last one `…` when cut. */
export function cutText(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** Like `cutText` but keeps the end: `…/src/runtime/supervisor.ts`, breaking at a `/` when it can. */
export function cutStart(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const tail = chars.slice(chars.length - (max - 1)).join("");
  const slash = tail.indexOf("/");
  return `…${slash > 0 ? tail.slice(slash) : tail}`;
}

/** The first line with text in it, trimmed; empty when there is none. */
export const firstLine = (s: string): string =>
  s
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

/** Swap used as the guard judges it: GB, and its share of physical RAM (not of the swap file). */
export function swapOfRam(
  used: number | null | undefined,
  memTotal: number | null | undefined,
): string {
  if (used == null) return "—";
  const gb = `${(used / 2 ** 30).toFixed(1)} GB`;
  return memTotal != null && memTotal > 0
    ? `${gb} (${Math.round((100 * used) / memTotal)}% of RAM)`
    : gb;
}
