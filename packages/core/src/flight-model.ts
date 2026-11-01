/** Shared vocabulary and data shapes; independent of the domain algorithms. */

/** How a notification relates to what the person already knows. */
export const CATCH_UP_KINDS = ["new", "follow-up", "old"] as const;

export type CatchUpKind = (typeof CATCH_UP_KINDS)[number];

/**
 * Why FLIGHT is not triaging, most telling first: its watch could not keep it running, its watch
 * reports it down, the operator stopped it, it is not running, or it is live and missed a window.
 */
export const FLIGHT_NOT_TRIAGING_CAUSES = [
  "start-failed",
  "down",
  "stopped",
  "off",
  "late",
] as const;

export type FlightNotTriagingCause = (typeof FLIGHT_NOT_TRIAGING_CAUSES)[number];
