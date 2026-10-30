import {
  FLIGHT_HOUR_MS,
  FLIGHT_RUNAWAY,
  FLIGHT_RUNAWAY_NOTE_KEY,
  FLIGHT_RUNAWAY_SETTING,
  type FlightRunawayTrip,
  MC_TOOL_NAMES,
  RUNAWAY_LIFTED_DECISION,
  runawayNoteText,
  runawaySameReason,
  runawayTrippedDecision,
  runawayWritesReason,
} from "@mc/core";
import type { ChangeBus } from "../bus.ts";
import type { Store } from "../store.ts";

/** The tools that only read: the breaker never stops these. */
export const FLIGHT_READ_TOOLS: ReadonlySet<string> = new Set([
  MC_TOOL_NAMES.readTicket,
  MC_TOOL_NAMES.flightState,
  MC_TOOL_NAMES.readPr,
  MC_TOOL_NAMES.readCiLog,
  MC_TOOL_NAMES.ghRead,
  MC_TOOL_NAMES.listTickets,
  MC_TOOL_NAMES.ledger,
  MC_TOOL_NAMES.recall,
]);

/** The setting that holds the write events of the last hour, as JSON. */
const EVENTS_SETTING = "flight.runaway-events";

/** One successful FLIGHT write call: the tool and the thing it acted on. */
export interface WriteEvent {
  at: number;
  action: string;
  target: string;
}

/**
 * FLIGHT's own bookkeeping: notes to itself that it may repeat while it works. They count toward
 * the hourly total but never trip the same-target rule.
 */
const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([
  MC_TOOL_NAMES.track,
  MC_TOOL_NAMES.untrack,
  MC_TOOL_NAMES.logDecision,
  MC_TOOL_NAMES.updateBrief,
  MC_TOOL_NAMES.remember,
  MC_TOOL_NAMES.forget,
]);

/** Whether a call only reads: a read tool, or message_seat asked for the seat's focus. */
export function isReadCall(name: string, args: unknown): boolean {
  if (FLIGHT_READ_TOOLS.has(name)) return true;
  return name === MC_TOOL_NAMES.messageSeat && argsOf(args).read_focus === true;
}

const argsOf = (args: unknown): Record<string, unknown> =>
  (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : typeof v === "object" && v !== null
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;

/**
 * What a write call acted on: its arguments, without the free-text basis, so the same message or
 * the same edit repeated is a loop but different work on one ticket is not. A queue reorder is
 * the ticket it moves.
 */
export function writeTarget(name: string, args: unknown): string {
  const a = argsOf(args);
  if (name === MC_TOOL_NAMES.promote && a.action === "queue-reorder" && typeof a.move === "string")
    return a.move.slice(0, 200);
  const { basis: _basis, ...rest } = a;
  return JSON.stringify(canonical(rest)).slice(0, 200);
}

/** Records one successful FLIGHT write and trips the breaker if it is now a loop. */
export function noteFlightWrite(
  store: Store,
  bus: ChangeBus,
  at: number,
  action: string,
  args: unknown,
): void {
  recordWrite(store, { at, action, target: writeTarget(action, args) });
  watchRunaway(store, bus, at);
}

function readEvents(store: Store): WriteEvent[] {
  const raw = store.getSetting(EVENTS_SETTING);
  if (raw === null) return [];
  try {
    const v = JSON.parse(raw) as WriteEvent[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Records one successful write call, keeping only the last hour. */
export function recordWrite(store: Store, event: WriteEvent): void {
  const kept = readEvents(store).filter((e) => e.at > event.at - FLIGHT_HOUR_MS);
  store.setSetting(EVENTS_SETTING, JSON.stringify([...kept, event]));
}

/** The breaker's trip while it is tripped; null when FLIGHT may write. */
export function runawayTrip(store: Store): FlightRunawayTrip | null {
  const raw = store.getSetting(FLIGHT_RUNAWAY_SETTING);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<FlightRunawayTrip>;
    if (typeof v.at === "number" && typeof v.reason === "string")
      return { at: v.at, reason: v.reason };
  } catch {
    // fall through: an unreadable trip still stops FLIGHT
  }
  return { at: 0, reason: "its record is unreadable" };
}

/** Why FLIGHT's recent write events are a loop, or null. */
export function runawayReason(events: readonly WriteEvent[], now: number): string | null {
  const writes = events.filter((e) => e.at > now - FLIGHT_HOUR_MS);
  if (writes.length > FLIGHT_RUNAWAY.writesPerHour) return runawayWritesReason(writes.length);
  const counts = new Map<string, number>();
  for (const e of writes) {
    if (e.at <= now - FLIGHT_RUNAWAY.sameActionWindowMs || BOOKKEEPING_TOOLS.has(e.action))
      continue;
    const key = JSON.stringify([e.action, e.target]);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n >= FLIGHT_RUNAWAY.sameActionLimit) return runawaySameReason(e.action, e.target, n);
  }
  return null;
}

/**
 * Trips the breaker when FLIGHT's recent write events are a loop: stores the trip, logs it, and
 * raises the one Needs-you note. Called after each FLIGHT write; does nothing while tripped.
 */
export function watchRunaway(store: Store, bus: ChangeBus, now: number): void {
  if (runawayTrip(store) !== null) return;
  const reason = runawayReason(readEvents(store), now);
  if (reason === null) return;
  store.setSetting(FLIGHT_RUNAWAY_SETTING, JSON.stringify({ at: now, reason }));
  store.addFlightDecision({
    at: now,
    kind: "hub",
    seatId: null,
    targetRunId: null,
    ref: null,
    questionId: null,
    about: "runaway breaker",
    decision: runawayTrippedDecision(reason),
    basis: "Mission Control stops FLIGHT's writes when it loops.",
  });
  store.raiseNote({
    key: FLIGHT_RUNAWAY_NOTE_KEY,
    kind: "flag",
    runId: null,
    seatId: null,
    repoId: null,
    text: runawayNoteText(reason),
    at: now,
  });
  bus.emit("attention");
  bus.emit("flight");
}

/** The operator lifts the breaker: false when it was not tripped. Logged in Decided without you. */
export function liftRunaway(store: Store, bus: ChangeBus, now: number): boolean {
  if (runawayTrip(store) === null) return false;
  store.deleteSetting(FLIGHT_RUNAWAY_SETTING);
  // the history that tripped it must not trip it again; the decision log is left as it was
  store.deleteSetting(EVENTS_SETTING);
  store.clearNote(FLIGHT_RUNAWAY_NOTE_KEY, now);
  store.addFlightDecision({
    at: now,
    kind: "hub",
    seatId: null,
    targetRunId: null,
    ref: null,
    questionId: null,
    about: "runaway breaker",
    decision: RUNAWAY_LIFTED_DECISION,
    basis: "The operator lifted it.",
  });
  bus.emit("attention");
  bus.emit("flight");
  return true;
}
