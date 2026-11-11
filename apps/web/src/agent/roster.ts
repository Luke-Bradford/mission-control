/** The Agents roster's rules: which seats it lists, in what order, and what each card says. */
import { type CrewEvent, type CrewRow, ROLES } from "@mc/core";
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
const EVENT_KIND: Record<CrewEvent["kind"], StripKind> = {
  commit: "turn",
  push: "turn",
  "pr-opened": "turn",
  message: "turn",
  test: "check",
  review: "review",
  park: "wait",
};

/** Where in the last hour (0 oldest, up to 1 now) a tool start or recorded event fell, one per slot and kind. */
export function hourTicks(row: CrewRow, now: number): { at: number; kind: StripKind }[] {
  const from = now - HOUR_MS;
  const marks = [
    ...(row.digest?.toolStarts ?? []).map((t) => ({ t, kind: "turn" as const })),
    ...(row.events ?? []).map((e) => ({ t: e.at, kind: EVENT_KIND[e.kind] })),
  ];
  // One tick per kind per slot, so a busy hour stays a bounded number of marks.
  const seen = new Set<string>();
  const ticks: { at: number; kind: StripKind }[] = [];
  for (const m of marks) {
    if (m.t < from || m.t > now) continue;
    const slot = Math.min(STRIP_SLOTS - 1, Math.floor(((m.t - from) / HOUR_MS) * STRIP_SLOTS));
    const key = `${slot}:${m.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ticks.push({ at: slot / STRIP_SLOTS, kind: m.kind });
  }
  return ticks;
}

/** `now`, `12m`, `3h`, `2d`: how long a seat has been in its state. */
export function shortAge(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / (24 * 60))}d`;
}
