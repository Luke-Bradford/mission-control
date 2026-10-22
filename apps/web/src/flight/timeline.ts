import { githubCollector, type HealthRow, type LimitRow, USAGE_COLLECTOR_PREFIX } from "@mc/core";

export const TIMELINE_MINUTES = 240;
const MIN = 60_000;

export interface TimelineEvent {
  at: number;
  label: string;
}

/** `60 s` under 120 s, else `30 min`. */
export function intervalText(seconds: number): string {
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** The newest status `at` among collectors matching `match`, failing ones included; null for none. */
function latest(health: HealthRow[], match: (collector: string) => boolean): number | null {
  const times = health.filter((h) => match(h.collector)).map((h) => h.at);
  return times.length === 0 ? null : Math.max(...times);
}

/**
 * What is coming up, soonest first: each limit window's reset, the next board poll and the next
 * usage read (their last status time plus the interval; a poll already due is shown as now).
 * Resets already in the past are dropped.
 */
export function upcoming(input: {
  now: number;
  limits: LimitRow[];
  /** The configured repos: their `githubCollector(id)` rows are the board polls. */
  repoIds: string[];
  health: HealthRow[];
  poll: { usageMinutes: number; githubSeconds: number };
}): TimelineEvent[] {
  const { now, limits, repoIds, health, poll } = input;
  const out: TimelineEvent[] = [];
  for (const l of limits) {
    if (l.resetAt >= now) {
      out.push({ at: l.resetAt, label: `${l.accountId} ${l.window} window resets` });
    }
  }
  const github = latest(health, (c) => repoIds.some((id) => githubCollector(id) === c));
  if (github !== null) {
    out.push({
      at: Math.max(now, github + poll.githubSeconds * 1000),
      label: `Board and escalations poll (every ${intervalText(poll.githubSeconds)})`,
    });
  }
  const usage = latest(health, (c) => c.startsWith(USAGE_COLLECTOR_PREFIX));
  if (usage !== null) {
    out.push({
      at: Math.max(now, usage + poll.usageMinutes * MIN),
      label: `Usage read (every ${intervalText(poll.usageMinutes * 60)})`,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Labels from this far along the line hang to the left of their marker so they stay on screen. */
export const RIGHT_FROM = 0.7;
/** hud.css `.tlev span`: 11 px text (about 6.5 px a character), at most 190 px, 10 px off its marker. */
const CHAR_PX = 6.5;
const LABEL_MAX_PX = 190;
const LABEL_OFF_PX = 10;
/** Where the `now` word, above the line at its start, ends; and the room kept between labels. */
const NOW_END_PX = 24;
const GAP_PX = 6;

export type LabelSide = "up" | "dn" | "none";

/**
 * Which side of the line each label hangs (mockup: alternating, first above), for a line `width`
 * px wide. A label goes on the side it alternates to if it clears the last label there (and, above,
 * the `now` word), else on the other side, else nowhere: `none` keeps the marker and its title, and
 * the page lists every event on a `Next:` line.
 */
export function labelSides(events: { frac: number; chars: number }[], width: number): LabelSide[] {
  const end = { up: NOW_END_PX, dn: Number.NEGATIVE_INFINITY };
  let prefer: "up" | "dn" = "up";
  return events.map(({ frac, chars }): LabelSide => {
    const x = frac * width;
    const w = Math.min(LABEL_MAX_PX, chars * CHAR_PX);
    const [from, to] =
      frac > RIGHT_FROM
        ? [x + LABEL_OFF_PX - w, x + LABEL_OFF_PX]
        : [x - LABEL_OFF_PX, x - LABEL_OFF_PX + w];
    const other: "up" | "dn" = prefer === "up" ? "dn" : "up";
    const side = [prefer, other].find((s) => from >= end[s] + GAP_PX);
    if (side === undefined) return "none";
    end[side] = to;
    prefer = side === "up" ? "dn" : "up";
    return side;
  });
}

/** Events within the timeline's window, and the rest (for the `Later:` line). */
export function splitTimeline(
  events: TimelineEvent[],
  now: number,
): { onLine: TimelineEvent[]; later: TimelineEvent[] } {
  const end = now + TIMELINE_MINUTES * MIN;
  return {
    onLine: events.filter((e) => e.at <= end),
    later: events.filter((e) => e.at > end),
  };
}
