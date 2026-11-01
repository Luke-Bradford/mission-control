export const CREW_PAUSE_SETTING = "crew.paused";

export interface CrewPause {
  seats: "all" | string[];
  reason: string;
  at: number;
  by: string;
  /** Seats an "all" pause leaves running (FLIGHT's own, or one it let out). */
  except?: string[];
  /** Who last let a seat out of the pause (FLIGHT, starting a paused seat); `by` stays who set it. */
  liftedBy?: string;
}

export function seatIsPaused(pause: CrewPause | null, seatId: string): boolean {
  if (pause === null) return false;
  if (pause.seats === "all") return pause.except?.includes(seatId) !== true;
  return pause.seats.includes(seatId);
}

/**
 * The pause with one seat let out; the same record (reason, time, who set it) otherwise, or null
 * when none is left. `liftedBy` names who let the seat out, so the record shows that actor.
 */
export function pauseWithout(
  pause: CrewPause,
  seatId: string,
  liftedBy?: string,
): CrewPause | null {
  const named = liftedBy === undefined ? {} : { liftedBy };
  if (pause.seats === "all")
    return { ...pause, ...named, except: [...new Set([...(pause.except ?? []), seatId])] };
  const rest = pause.seats.filter((id) => id !== seatId);
  return rest.length === 0 ? null : { ...pause, ...named, seats: rest };
}

/**
 * Whether `next` is `prev` with only its seats edited (same reason, time and who set it), or the
 * end of a pause that listed one seat, which is that seat let out.
 */
export function sameCrewPauseRecord(prev: CrewPause, next: CrewPause | null): boolean {
  if (next === null) return prev.seats !== "all" && prev.seats.length === 1;
  return next.by === prev.by && next.at === prev.at && next.reason === prev.reason;
}
