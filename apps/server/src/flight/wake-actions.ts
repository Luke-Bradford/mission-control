import {
  FLIGHT_BATCH_LOOKBACK_MS,
  FLIGHT_BATCH_MIN_WAKES,
  FLIGHT_BATCH_NO_ACTION_SHARE,
  FLIGHT_IMMEDIATE_REASONS,
  FLIGHT_NON_ACTING_TOOLS,
  FLIGHT_WAKE_IDLE_MS,
  FLIGHT_WAKE_REMINDER,
  type FlightWakeAction,
  type FlightWakeActions,
} from "@mc/core";
import type { Store } from "../store.ts";

/** Summarises the audit rows for the daily retrospective. Riders count in the breakdown too. */
export function wakeActionSummary(
  wakes: readonly FlightWakeAction[],
  batched: string[],
): FlightWakeActions {
  const byReason = new Map<string, { wakes: number; noAction: number }>();
  for (const wake of wakes)
    for (const reason of new Set([...wake.reasons, ...wake.rode])) {
      const current = byReason.get(reason) ?? { wakes: 0, noAction: 0 };
      current.wakes++;
      if (!wake.acted) current.noAction++;
      byReason.set(reason, current);
    }
  const noAction = wakes.filter((wake) => !wake.acted).length;
  return {
    wakes: wakes.length,
    noAction,
    share: wakes.length === 0 ? null : noAction / wakes.length,
    byReason: [...byReason]
      .map(([reason, value]) => ({ reason, ...value }))
      .sort((a, b) => b.noAction - a.noAction || a.reason.localeCompare(b.reason)),
    batched,
  };
}

/** Reasons that reliably wake FLIGHT without a state-changing call. Riders never teach the set. */
export function noActionReasons(wakes: readonly FlightWakeAction[]): string[] {
  const counts = new Map<string, { wakes: number; noAction: number }>();
  for (const wake of wakes)
    for (const reason of wake.reasons) {
      if (wake.immediate.includes(reason)) continue;
      const current = counts.get(reason) ?? { wakes: 0, noAction: 0 };
      current.wakes++;
      if (!wake.acted) current.noAction++;
      counts.set(reason, current);
    }
  return [...counts]
    .filter(
      ([reason, count]) =>
        count.wakes >= FLIGHT_BATCH_MIN_WAKES &&
        count.noAction / count.wakes > FLIGHT_BATCH_NO_ACTION_SHARE &&
        !FLIGHT_IMMEDIATE_REASONS.includes(reason) &&
        reason !== "initial" &&
        reason !== "start" &&
        reason !== FLIGHT_WAKE_REMINDER,
    )
    .map(([reason]) => reason)
    .sort();
}

/** Learns from completed turns only, leaving the running turn out of the decision. */
export function batchedWakeReasons(store: Store, now: number): string[] {
  return noActionReasons(
    store.flightWakeActions(
      now - FLIGHT_BATCH_LOOKBACK_MS,
      now - FLIGHT_WAKE_IDLE_MS,
      FLIGHT_NON_ACTING_TOOLS,
    ),
  );
}
