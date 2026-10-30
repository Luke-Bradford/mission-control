import { type FlightDecision, forTheControllerDecisions } from "@mc/core";

/** The decisions included in the controller metric and FLIGHT view. */
export function controllerDecisions(decisions: readonly FlightDecision[]): FlightDecision[] {
  return forTheControllerDecisions(decisions);
}
