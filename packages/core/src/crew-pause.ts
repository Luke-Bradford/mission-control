export const CREW_PAUSE_SETTING = "crew.paused";

export interface CrewPauseException {
  seat: string;
  runId: string;
  by: string;
  at: number;
  reason: string;
}

export interface CrewPause {
  seats: "all" | string[];
  reason: string;
  at: number;
  by: string;
  /** Only these live runs may continue; the original pause still covers their seats. */
  except?: CrewPauseException[];
  /** Older seat-only entries kept visible for audit; no run or grantor is inferred from them. */
  legacyExcept?: string[];
  /** Last recorded exception editor; older records do not identify each grant. `by` keeps the owner. */
  liftedBy?: string;
}

export function seatIsPaused(
  pause: CrewPause | null,
  seatId: string,
  runId: string | null = null,
): boolean {
  if (pause === null) return false;
  const covered = pause.seats === "all" || pause.seats.includes(seatId);
  return covered && !pause.except?.some((item) => item.seat === seatId && item.runId === runId);
}

/**
 * Let one run continue without changing the pause's owner or seat coverage.
 */
export function pauseWithout(
  pause: CrewPause,
  seatId: string,
  exception: Omit<CrewPauseException, "seat">,
): CrewPause {
  return {
    ...pause,
    liftedBy: exception.by,
    except: [
      ...(pause.except ?? []).filter((item) => item.runId !== exception.runId),
      { ...exception, seat: seatId },
    ],
  };
}

/**
 * Whether only run exceptions changed. Another actor keeps the pause's owner and full scope.
 */
export function sameCrewPauseRecord(prev: CrewPause, next: CrewPause | null): boolean {
  return (
    next !== null &&
    next.by === prev.by &&
    next.at === prev.at &&
    next.reason === prev.reason &&
    JSON.stringify(next.seats) === JSON.stringify(prev.seats)
  );
}
