import type { ConfigView, CrewPause } from "@mc/core";
import { useState } from "react";
import { createPortal } from "react-dom";
import { apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { Pill } from "../hud/Pill.tsx";
import "./CrewPause.css";

export function CrewPauseControl() {
  const { data: pause, error } = useResource<CrewPause | null>(RESOURCES.crewPause);
  const { data: config } = useResource<ConfigView>(RESOURCES.config);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const seats = (config?.crew?.sessions ?? []).flatMap((s) => s.seats);
  async function save(resume = false) {
    setBusy(true);
    setFailure("");
    try {
      await apiPost(
        ACTIONS.crewPause,
        resume ? { seats: null } : { seats: all ? "all" : selected, reason: reason.trim() },
      );
      hub.refetch(RESOURCES.crewPause.path);
      hub.refetch(RESOURCES.crew.path);
      setOpen(false);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="crew-pause">
      {pause && (
        <span title={pause.reason}>
          <Pill tone="warn">Paused</Pill>
        </span>
      )}
      <button
        type="button"
        className="sm"
        disabled={busy || pause === undefined || !!error}
        title={error ? `Could not load crew pause: ${error.message}` : undefined}
        onClick={() => {
          if (!open) {
            setReason(pause?.reason ?? "");
            setAll(!pause || pause.seats === "all");
            setSelected(pause && Array.isArray(pause.seats) ? pause.seats : []);
          }
          setOpen(!open);
        }}
      >
        {pause ? "Edit crew pause" : "Pause crew"}
      </button>
      {pause && (
        <button type="button" className="sm" disabled={busy} onClick={() => void save(true)}>
          Resume crew
        </button>
      )}
      {failure && <span role="alert">{failure}</span>}
      {open &&
        createPortal(
          <form
            className="crew-pause-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              Reason
              <input
                value={reason}
                maxLength={500}
                required
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <label>
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              All seats
            </label>
            {!all &&
              seats.map((seat) => (
                <label key={seat.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(seat.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, seat.id]
                          : selected.filter((id) => id !== seat.id),
                      )
                    }
                  />
                  {seat.id}
                </label>
              ))}
            <span className="muted s">
              Live runs are left as they are. New tickets, reviews and rework wait.
            </span>
            <button
              type="submit"
              className="sm"
              disabled={busy || !reason.trim() || (!all && !selected.length)}
            >
              {all ? "Pause all seats" : "Pause selected seats"}
            </button>
            <button type="button" className="sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>,
          document.body,
        )}
    </span>
  );
}
