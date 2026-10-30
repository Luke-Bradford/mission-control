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
  except: z.array(z.string().min(1)).optional(),
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

/** FLIGHT's watch uses this boundary for fresh runs and crash restarts. */
export function pauseAwareSupervisor<T extends Pick<Supervisor, "startWatch">>(
  store: Store,
  supervisor: T,
): T {
  return {
    ...supervisor,
    startWatch: async (...args: Parameters<Supervisor["startWatch"]>) => {
      const pause = pausedSeat(store, args[0]);
      if (pause) throw new SupervisorError(409, `Paused: ${pause.reason}`);
      return supervisor.startWatch(...args);
    },
  };
}

/** FLIGHT must not deliver new instructions before checking whether rework may resume. */
export async function messageUnpausedSeat(
  store: Store,
  supervisor: Pick<Supervisor, "message">,
  ...args: Parameters<Supervisor["message"]>
): ReturnType<Supervisor["message"]> {
  const pause = pausedSeat(store, args[0]);
  if (pause) throw new SupervisorError(409, `Paused: ${pause.reason}`);
  return supervisor.message(args[0], args[1], { ...args[2], enforcePause: true });
}

type ReviewClock = { id: number; seatId: string; startedAt: number | null; createdAt: number };

/** Persist the suspended review clock so a hub restart does not consume its deadline. */
export function reviewPausedMs(store: Store, row: ReviewClock, at: number): number {
  const key = `crew.review-pause.${row.id}`;
  const saved = store.getSetting(key);
  const clock: { elapsed: number; since: number | null } =
    saved === null ? { elapsed: 0, since: null } : JSON.parse(saved);
  const pause = pausedSeat(store, row.seatId);
  if (pause && clock.since === null)
    clock.since = Math.max(pause.at, row.startedAt ?? row.createdAt);
  const elapsed = clock.elapsed + (clock.since === null ? 0 : Math.max(0, at - clock.since));
  if (!pause) {
    clock.elapsed = elapsed;
    clock.since = null;
  }
  store.setSetting(key, JSON.stringify(clock));
  return elapsed;
}

/** Settle the old interval and open the new one even if no engine tick fell between edits. */
export function writeCrewPause(
  store: Store,
  pause: CrewPause | null,
  at: number,
  reviews: ReviewClock[] = store.reviewsIn(["running"]),
): void {
  for (const row of reviews) reviewPausedMs(store, row, at);
  store.setSetting(CREW_PAUSE_SETTING, JSON.stringify(pause));
  store.addHubEvent(pause === null ? "Crew resumed" : `Crew paused: ${pause.reason}`, at);
  for (const row of reviews) reviewPausedMs(store, row, at);
}
