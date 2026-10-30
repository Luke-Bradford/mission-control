import {
  FLIGHT_DECISIONS_SCAN_LIMIT,
  FLIGHT_METRICS_DAY_MS,
  type FlightDecision,
  forTheControllerDecisions,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { flightSeat } from "./seat.ts";

/** Recent decisions included in the controller metric and FLIGHT view. */
export function controllerDecisions(config: CcConfig, store: Store, now: number): FlightDecision[] {
  if (flightSeat(config) === null) return [];
  return forTheControllerDecisions(
    store.flightDecisions(now - FLIGHT_METRICS_DAY_MS, FLIGHT_DECISIONS_SCAN_LIMIT),
  );
}
