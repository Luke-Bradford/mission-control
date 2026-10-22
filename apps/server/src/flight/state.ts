/**
 * The FLIGHT seat as the rest of the hub sees it: which seat it is, whether it is running, and
 * what `GET /api/flight` shows (the seat and the last day's decisions).
 */
import {
  FLIGHT_VIEW_LIMIT,
  FLIGHT_VIEW_MS,
  type FlightView,
  seatCallSign,
  seatDef,
} from "@mc/core";
import type { CcConfig, CrewSeatConfig, CrewSessionConfig } from "../config.ts";
import { ACTIVE_SEAT_STATES, type Store } from "../store.ts";

/** The watch seat (the first seat whose seatDef loop is "watch") and its session, else null. */
export function flightSeat(
  config: CcConfig,
): { seat: CrewSeatConfig; session: CrewSessionConfig } | null {
  for (const session of config.crew?.sessions ?? []) {
    const seat = session.seats.find((s) => seatDef(s).loop === "watch");
    if (seat !== undefined) return { seat, session };
  }
  return null;
}

/** That seat's row holds an unended run in a state of ACTIVE_SEAT_STATES. */
export function flightLive(config: CcConfig, store: Store): boolean {
  const found = flightSeat(config);
  if (found === null) return false;
  const row = store.seatSession(found.seat.id);
  if (row === null || row.runId === null || !ACTIVE_SEAT_STATES.includes(row.state)) return false;
  return store.run(row.runId)?.endedAt === null;
}

export function flightView(config: CcConfig, store: Store, now: number): FlightView {
  const found = flightSeat(config);
  return {
    seat:
      found === null
        ? null
        : {
            id: found.seat.id,
            call: seatCallSign(found.seat.id),
            model: found.seat.model,
            state: store.seatSession(found.seat.id)?.state ?? null,
            live: flightLive(config, store),
          },
    decisions: store.flightDecisions(now - FLIGHT_VIEW_MS, FLIGHT_VIEW_LIMIT),
  };
}
