/** Shared vocabulary and data shapes; independent of the domain algorithms. */

/** What FLIGHT may do on a repo: `superuser` is set only in the user config, never by the repo. */
export const FLIGHT_POWERS = ["standard", "superuser"] as const;

export type FlightPowers = (typeof FLIGHT_POWERS)[number];
