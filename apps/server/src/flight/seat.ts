import { seatDef } from "@mc/core";
import {
  type CcConfig,
  type CrewSeatConfig,
  type CrewSessionConfig,
  seatUnavailable,
} from "../config.ts";

/**
 * The watch seat (the first seat that is not retiring and whose seatDef loop is "watch") and its
 * session, else null. Kept apart from state.ts so the mc tools can name FLIGHT without importing
 * FLIGHT's state (which imports FLIGHT's tools, which import the mc tools).
 */
export function flightSeat(
  config: CcConfig,
): { seat: CrewSeatConfig; session: CrewSessionConfig } | null {
  for (const session of config.crew?.sessions ?? []) {
    const seat = session.seats.find(
      (s) => !s.retiring && !seatUnavailable(s) && seatDef(s).loop === "watch",
    );
    if (seat !== undefined) return { seat, session };
  }
  return null;
}
