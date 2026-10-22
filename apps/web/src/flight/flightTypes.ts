/** FLIGHT's types, from `@mc/core` (ticket #232). */
import type { FlightView } from "@mc/core";

export type { FlightDecision, FlightDecisionKind, FlightView } from "@mc/core";
export { MC_LINE_PREFIX } from "@mc/core";

/** FLIGHT's seat as `GET /api/flight` sends it. */
export type FlightSeat = NonNullable<FlightView["seat"]>;
