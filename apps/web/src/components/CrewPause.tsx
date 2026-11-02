import type { ConfigView, CrewPause } from "@mc/core";
import { useState } from "react";
import { createPortal } from "react-dom";
import { apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { Pill } from "../hud/Pill.tsx";
import "./CrewPause.css";

const pauseTime = (at: number) =>
  new Date(at).toISOString().replace("T", " ").replace(".000Z", " UTC");

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
      {error && <span role="alert">Crew pause could not be loaded. Reload the page to retry.</span>}
      {pause === undefined && !error && <span role="status">Loading crew pause…</span>}
      {open &&
        createPortal(
          <form
            className="crew-pause-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {pause ? (
              <section className="crew-pause-audit" aria-label="Crew pause audit">
                <p>
                  {pause.at === 0 ? (
                    "Pause record unreadable; owner and time unknown."
                  ) : (
                    <>
                      Paused by {pause.by} · {pauseTime(pause.at)}
                    </>
                  )}
                </p>
                <h3>Run exceptions</h3>
                {pause.except?.length ? (
                  <ul>
                    {pause.except.map((item) => (
                      <li key={item.runId}>
                        <p>
                          <strong>{item.by}</strong> let <strong>{item.seat}</strong> continue
                        </p>
                        <p className="mono">Run {item.runId}</p>
                        <p>
                          <time dateTime={new Date(item.at).toISOString()}>
                            {pauseTime(item.at)}
                          </time>
                        </p>
                        <details>
                          <summary>Reason for this exception</summary>
                          <p>{item.reason}</p>
                        </details>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No run exceptions.</p>
                )}
                {!!pause.legacyExcept?.length && (
                  <p className="muted">
                    Older seat-only entries: {pause.legacyExcept.join(", ")}. Their run and grantor
                    are unknown; they do not bypass this pause.
                  </p>
                )}
                {pause.liftedBy && !pause.except?.length && (
                  <p className="muted">
                    Earlier pause edit by {pause.liftedBy}; no run exception remains.
                  </p>
                )}
                <p className="muted">Each exception ends with its run. Other tickets still wait.</p>
              </section>
            ) : (
              <p className="muted">The crew is not paused.</p>
            )}
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
              Live sessions stay running. Other work waits unless its run has an exception.
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
