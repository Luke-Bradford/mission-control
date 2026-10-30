import {
  FLIGHT_HOUR_MS,
  FLIGHT_RUNAWAY,
  FLIGHT_RUNAWAY_NOTE_KEY,
  FLIGHT_RUNAWAY_SETTING,
  type FlightDecision,
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
  MC_TOOL_NAMES.screenshotHud,
  MC_TOOL_NAMES.readPr,
  MC_TOOL_NAMES.readCiLog,
  MC_TOOL_NAMES.ghRead,
  MC_TOOL_NAMES.listTickets,
  MC_TOOL_NAMES.ledger,
  MC_TOOL_NAMES.recall,
]);

/** The most decisions one check reads; far over what either trigger needs. */
const SCAN_LIMIT = 2000;

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

const targetOf = (d: FlightDecision): string => d.ref ?? d.targetRunId ?? d.seatId ?? d.about;

/** Why FLIGHT's recent write decisions are a loop, or null. */
export function runawayReason(
  decisions: readonly FlightDecision[],
  now: number,
  /** The briefs written in the hour: a write that leaves no decision row. */
  briefs = 0,
): string | null {
  const writes = decisions.filter((d) => d.kind !== "hub" && d.at > now - FLIGHT_HOUR_MS);
  if (writes.length + briefs > FLIGHT_RUNAWAY.writesPerHour)
    return runawayWritesReason(writes.length + briefs);
  const counts = new Map<string, { n: number; kind: string; target: string }>();
  for (const d of writes) {
    if (d.at <= now - FLIGHT_RUNAWAY.sameActionWindowMs) continue;
    const target = targetOf(d);
    const key = JSON.stringify([d.kind, target]);
    const seen = counts.get(key) ?? { n: 0, kind: d.kind, target };
    seen.n += 1;
    counts.set(key, seen);
    if (seen.n >= FLIGHT_RUNAWAY.sameActionLimit) return runawaySameReason(d.kind, target, seen.n);
  }
  return null;
}

/**
 * Trips the breaker when FLIGHT's recent decisions are a loop: stores the trip, logs it, and
 * raises the one Needs-you note. Called after each FLIGHT write; does nothing while tripped.
 */
export function watchRunaway(store: Store, bus: ChangeBus, now: number): void {
  if (runawayTrip(store) !== null) return;
  const reason = runawayReason(
    store.flightDecisions(now - FLIGHT_HOUR_MS, SCAN_LIMIT),
    now,
    store.countBriefs(now - FLIGHT_HOUR_MS),
  );
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
