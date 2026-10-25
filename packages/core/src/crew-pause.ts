export const CREW_PAUSE_SETTING = "crew.paused";

export interface CrewPause {
  seats: "all" | string[];
  reason: string;
  at: number;
  by: string;
}

export function seatIsPaused(pause: CrewPause | null, seatId: string): boolean {
  return pause !== null && (pause.seats === "all" || pause.seats.includes(seatId));
}
