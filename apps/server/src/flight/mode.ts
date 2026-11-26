import {
  COMMS_CAPCOM,
  FLIGHT_MODE_LABEL,
  FLIGHT_MODE_SETTING,
  FLIGHT_MODES,
  type FlightMode,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import { parseJson } from "../json.ts";
import type { Store } from "../store.ts";
import { flightSeat } from "./seat.ts";

/** How FLIGHT works now, read on every use so a change needs no restart. Missing or unreadable: crew. */
export function readFlightMode(store: Store): FlightMode {
  const raw = store.getSetting(FLIGHT_MODE_SETTING);
  return FLIGHT_MODES.find((m) => m === raw) ?? "crew";
}

/** Store the mode and log who set it; the caller emits the bus events. */
export function writeFlightMode(store: Store, mode: FlightMode, by: string, at: number): void {
  store.setSetting(FLIGHT_MODE_SETTING, mode);
  store.addHubEvent(`FLIGHT mode set to ${FLIGHT_MODE_LABEL[mode]} by ${by}`, at);
}

/** The wake-fact categories that still wake FLIGHT outside crew mode: the operator's own. */
const OPERATOR_FACTS = ["operator", "owed", "breaker"] as const;

/** Wake facts cut to the operator's messages, what FLIGHT still owes him, and the breaker. */
export function operatorOnlyFacts(facts: string): string {
  const parsed = parseJson<Record<string, unknown[]>>(facts, {});
  const kept: Record<string, unknown[]> = {};
  for (const key of OPERATOR_FACTS) kept[key] = parsed[key] ?? [];
  return JSON.stringify(kept);
}

/**
 * Whether a Comms message wakes its seat now. Outside crew mode FLIGHT takes only the operator's;
 * the rest stay unread until his next message wakes it.
 */
export function deliversToFlight(
  store: Store,
  config: CcConfig,
  seatId: string,
  from: string,
): boolean {
  if (seatId !== flightSeat(config)?.seat.id) return true;
  return from === COMMS_CAPCOM || readFlightMode(store) === "crew";
}
