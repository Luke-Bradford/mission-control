export const CREW_PAUSE_SETTING = "crew.paused";

export interface CrewPause {
  seats: "all" | string[];
  reason: string;
  at: number;
  by: string;
  /** Seats an "all" pause leaves running (FLIGHT's own, or one it let out). */
  except?: string[];
}

export function seatIsPaused(pause: CrewPause | null, seatId: string): boolean {
  if (pause === null) return false;
  if (pause.seats === "all") return pause.except?.includes(seatId) !== true;
  return pause.seats.includes(seatId);
}

/** The pause with one seat let out; the same record (reason, time, who set it) otherwise, or null when none is left. */
export function pauseWithout(pause: CrewPause, seatId: string): CrewPause | null {
  if (pause.seats === "all")
    return { ...pause, except: [...new Set([...(pause.except ?? []), seatId])] };
  const rest = pause.seats.filter((id) => id !== seatId);
  return rest.length === 0 ? null : { ...pause, seats: rest };
}
