/** FLIGHT's types, from `@mc/core` (ticket #232). */
import type { FlightView } from "@mc/core";

export type { FlightDecision, FlightDecisionKind, FlightView } from "@mc/core";
export { MC_LINE_PREFIX } from "@mc/core";

/** FLIGHT's seat as `GET /api/flight` sends it. */
export type FlightSeat = NonNullable<FlightView["seat"]>;

export const FLIGHT_NO_SEAT = "No FLIGHT seat is configured.";
export const FLIGHT_STOPPED = "FLIGHT is stopped.";
/** Beside a message box while FLIGHT is down: the message is kept for its next start. */
export const FLIGHT_STOPPED_NOTICE = "FLIGHT is stopped. It reads this when it starts.";

/** Why FLIGHT cannot be reached: no seat is configured, or the seat is stopped. */
export const flightOffText = (seat: FlightSeat | null): string =>
  seat === null ? FLIGHT_NO_SEAT : FLIGHT_STOPPED;
