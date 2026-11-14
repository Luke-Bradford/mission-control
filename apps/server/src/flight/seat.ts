import { seatDef } from "@mc/core";
import {
  type CcConfig,
  type CrewSeatConfig,
  type CrewSessionConfig,
  flightPowersOf,
  seatUnavailable,
} from "../config.ts";

/** The ids of every configured seat; their call signs differ only in case. */
export const crewSeatIds = (config: CcConfig): string[] =>
  config.crew?.sessions.flatMap((s) => s.seats.map((seat) => seat.id)) ?? [];

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

/**
 * Whether FLIGHT can run a held hub Update: a FLIGHT seat on a `superuser` repo. With it, the held
 * Update is FLIGHT's item (hud.ts routes it); without, it is the operator's.
 */
export const flightRunsUpdate = (config: CcConfig): boolean => {
  const found = flightSeat(config);
  return found !== null && flightPowersOf(config, found.session.repoId) === "superuser";
};
