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

/**
 * Rules FLIGHT may accept by itself: work it can ticket without a code or rule change (breaking up
 * a bloated file today; flaky-test, minor-dependency and fold-into-agreed-work rules join when
 * they exist). Every other rule stays with the operator. Adding a rule widens what FLIGHT does
 * alone: this file is a hard rule, so the change needs operator clearance.
 */
export const CODE_HEALTH_FLIGHT_TIER_RULES: readonly string[] = ["repeatedly-changed-large-file"];
/** When FLIGHT accepts without a date, the accepted proposal is re-measured this long after. */
export const CODE_HEALTH_FLIGHT_REVIEW_DAYS = 30;
