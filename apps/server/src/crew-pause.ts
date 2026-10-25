import { CREW_PAUSE_SETTING, type CrewPause, seatIsPaused } from "@mc/core";
import { z } from "zod";
import { type Supervisor, SupervisorError } from "./runtime/supervisor.ts";
import type { Store } from "./store.ts";

const seats = z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]);
export const CrewPauseBody = z.union([
  z.strictObject({ seats, reason: z.string().trim().min(1).max(500) }),
  z.strictObject({ seats: z.null() }),
]);
const record = z.strictObject({
  seats,
  reason: z.string().trim().min(1).max(500),
  at: z.number().finite().nonnegative(),
  by: z.string().min(1),
});

export function readCrewPause(store: Store): CrewPause | null {
  const raw = store.getSetting(CREW_PAUSE_SETTING);
  if (raw === null || raw === "null") return null;
  try {
    const parsed = record.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // An unreadable pause must not allow new starts.
  }
  return { seats: "all", reason: "Crew pause setting is unreadable", at: 0, by: "operator" };
}

export function pausedSeat(store: Store, seatId: string): CrewPause | null {
  const pause = readCrewPause(store);
  return seatIsPaused(pause, seatId) ? pause : null;
}

/** The direct start boundary used by the operator and FLIGHT. */
export async function startUnpausedRun(
  store: Store,
  supervisor: Pick<Supervisor, "startRun">,
  ...args: Parameters<Supervisor["startRun"]>
): ReturnType<Supervisor["startRun"]> {
  const pause = pausedSeat(store, args[0]);
  if (pause) throw new SupervisorError(409, `Paused: ${pause.reason}`);
  return supervisor.startRun(...args);
}
