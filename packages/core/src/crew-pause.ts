export const CREW_PAUSE_SETTING = "crew.paused";

export interface CrewPause {
  seats: "all" | string[];
  reason: string;
  at: number;
  by: string;
  /** Seats an "all" pause leaves running. */
  except?: string[];
}

export function seatIsPaused(pause: CrewPause | null, seatId: string): boolean {
  if (pause === null) return false;
  return pause.seats === "all"
    ? pause.except?.includes(seatId) !== true
    : pause.seats.includes(seatId);
}

/** Let one seat out of a pause, preserving who set it and why. */
export function pauseWithout(pause: CrewPause, seatId: string): CrewPause | null {
  if (pause.seats === "all")
    return { ...pause, except: [...new Set([...(pause.except ?? []), seatId])] };
  const seats = pause.seats.filter((id) => id !== seatId);
  return seats.length === 0 ? null : { ...pause, seats };
}
