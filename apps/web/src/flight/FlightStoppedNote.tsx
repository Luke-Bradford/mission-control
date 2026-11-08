import { useState } from "react";
import { apiPost, errorNote } from "../api.ts";
import { ACTIONS } from "../data.ts";
import { FLIGHT_NO_SEAT, FLIGHT_STOPPED_NOTICE, type FlightSeat } from "./flightTypes.ts";

/**
 * Shown beside a message box that is bound for FLIGHT while FLIGHT is not running. The box stays
 * usable: the message is kept and FLIGHT reads it when it starts. `seat` is undefined while the
 * FLIGHT view loads, null when no FLIGHT seat is configured.
 */
export function FlightStoppedNote({ seat }: { seat: FlightSeat | null | undefined }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (seat === undefined || seat?.live === true) return null;
  const start = async () => {
    if (!seat) return;
    setBusy(true);
    setErr(null);
    try {
      await apiPost(ACTIONS.seatStart(seat.id), {});
    } catch (e) {
      setErr(e instanceof Error ? (errorNote(e) ?? e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flight-stopped" data-testid="flight-stopped">
      <span className="note" role="status">
        {seat ? FLIGHT_STOPPED_NOTICE : FLIGHT_NO_SEAT}
      </span>
      {seat && (
        <button type="button" className="primary sm" disabled={busy} onClick={() => void start()}>
          Start FLIGHT
        </button>
      )}
      {err !== null && (
        <span className="note err" role="alert">
          {err}
        </span>
      )}
    </div>
  );
}
