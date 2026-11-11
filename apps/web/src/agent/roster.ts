/** The Agents roster's rules: which seats it lists, in what order, and what each card says. */
import { type CrewRow, type OverviewTimeline, ROLES } from "@mc/core";
import { callSign, contextPct, isSeatFree } from "../crew.ts";
import { cutText } from "../fmt.ts";

/** A seat's place in a repo: FLIGHT, then the planner, developers, reviewers, then the rest. */
export const SEAT_CLASSES = ["flight", "planner", "developer", "reviewer", "other"] as const;
export type SeatClass = (typeof SEAT_CLASSES)[number];

const roleText = (role: string | null): string =>
  ROLES.find((r) => r.callSign === role)?.here ?? "";

export function seatClass(row: Pick<CrewRow, "kind" | "role" | "mode">): SeatClass {
  if (row.kind !== "crew") return "other";
  if (row.role === "FLIGHT") return "flight";
  const here = roleText(row.role);
  if (here.startsWith("planner")) return "planner";
  if (row.mode === "writer") return "developer";
  if (row.mode === "scratch" || here.startsWith("reviewer")) return "reviewer";
  return "other";
}

const byName = (a: CrewRow, b: CrewRow): number =>
  callSign(a).localeCompare(callSign(b), undefined, { numeric: true, sensitivity: "base" });

export interface RosterGroup {
  repoId: string;
  rows: CrewRow[];
}

/** Every seat, by repo (in config order of first appearance), each repo in the fixed seat order. */
export function rosterGroups(rows: readonly CrewRow[]): RosterGroup[] {
  const repos = new Map<string, CrewRow[]>();
  for (const row of [...rows].sort((a, b) => a.index - b.index)) {
    const list = repos.get(row.repoId);
    if (list) list.push(row);
    else repos.set(row.repoId, [row]);
  }
  return [...repos].map(([repoId, list]) => ({
    repoId,
    rows: list.sort(
      (a, b) =>
        SEAT_CLASSES.indexOf(seatClass(a)) - SEAT_CLASSES.indexOf(seatClass(b)) || byName(a, b),
    ),
  }));
}

/** The seats in the order the roster shows them, for j and k. */
export const rosterOrder = (rows: readonly CrewRow[]): CrewRow[] =>
  rosterGroups(rows).flatMap((g) => g.rows);

/** The seat `dir` steps from `current` (1 is j, -1 is k), wrapping; null when there are none. */
export function stepRoster(rows: readonly CrewRow[], current: string | null, dir: 1 | -1) {
  const order = rosterOrder(rows);
  if (order.length === 0) return null;
  const at = order.findIndex((r) => r.id === current);
  const next = at < 0 ? (dir > 0 ? 0 : order.length - 1) : (at + dir + order.length) % order.length;
  return order[next]?.id ?? null;
}

/** Longest ticket title a card shows before it cuts. */
export const WORK_TITLE_MAX = 32;

export interface WorkLine {
  /** `#1771`, else null. */
  ticket: string | null;
  text: string;
  /** The title uncut, for a tooltip. */
  full: string;
}

/** The ticket number and its short title; "Free" for a seat with no open run. */
export function workLine(row: CrewRow): WorkLine {
  if (row.role === "FLIGHT")
    return { ticket: null, text: "Watching the crew", full: "Watching the crew" };
  if (row.kind === "crew" && isSeatFree(row)) return { ticket: null, text: "Free", full: "Free" };
  const number = row.ticket?.split("#").at(-1);
  const title = row.ticketTitle ?? row.focus ?? (row.kind === "crew" ? "Working" : "Running");
  return {
    ticket: number ? `#${number}` : null,
    text: cutText(title, WORK_TITLE_MAX),
    full: title,
  };
}

/** The context in use as a whole percent; null (a dash on screen) when the seat is idle or unmeasured. */
export function contextShown(row: CrewRow): number | null {
  if (row.role !== "FLIGHT" && (row.hudState === "idle" || isSeatFree(row))) return null;
  const pct = contextPct(row);
  return pct === null ? null : Math.min(100, Math.round(pct));
}

export const HOUR_MS = 60 * 60_000;
/** The strip is this many slots wide (30 s each). */
export const STRIP_SLOTS = 120;
export type StripKind = "turn" | "check" | "review" | "wait";
export const STRIP_KINDS: readonly StripKind[] = ["turn", "check", "review", "wait"];
type TimelineLane = OverviewTimeline["lanes"][number];
const SPAN_KIND: Record<TimelineLane["spans"][number]["kind"], StripKind> = {
  turn: "turn",
  checks: "check",
  review: "review",
  lock: "wait",
};

export interface StripMark {
  /** Where it starts in the last hour: 0 the oldest edge, 1 now. */
  at: number;
  /** How much of the hour it covers; one slot for a tool start. */
  len: number;
  kind: StripKind;
}

/**
 * The last hour of a seat's overview lane as marks: each span (a turn, checks, review, the test
 * lock) over its length, and each tool start as one slot, one per slot and kind. No lane, no marks.
 */
export function hourMarks(lane: TimelineLane | undefined, now: number): StripMark[] {
  if (!lane) return [];
  const from = now - HOUR_MS;
  const marks: StripMark[] = [];
  for (const span of lane.spans) {
    const start = Math.max(span.from, from);
    const end = Math.min(span.to ?? now, now);
    if (end < start || end < from) continue;
    marks.push({
      at: (start - from) / HOUR_MS,
      len: Math.max(end - start, HOUR_MS / STRIP_SLOTS) / HOUR_MS,
      kind: SPAN_KIND[span.kind],
    });
  }
  const seen = new Set<number>();
  for (const t of lane.ticks) {
    if (t < from || t > now) continue;
    const slot = Math.min(STRIP_SLOTS - 1, Math.floor(((t - from) / HOUR_MS) * STRIP_SLOTS));
    if (seen.has(slot)) continue;
    seen.add(slot);
    marks.push({ at: slot / STRIP_SLOTS, len: 1 / STRIP_SLOTS, kind: "turn" });
  }
  return marks;
}

/** `now`, `12m`, `3h`, `2d`: how long a seat has been in its state. */
export function shortAge(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / (24 * 60))}d`;
}
