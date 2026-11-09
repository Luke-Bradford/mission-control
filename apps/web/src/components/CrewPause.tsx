import type { ConfigView, CrewPause } from "@mc/core";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { Pill } from "../hud/Pill.tsx";
import { pushOverlay, trapTab, useOverlay, useReturnFocus } from "../shell/overlays.ts";
import {
  ErrorSummary,
  FieldError,
  type FieldIssue,
  fieldProps,
  isUncertain,
  UNCERTAIN_TEXT,
  useSubmitGuard,
} from "./formSupport.tsx";
import "./CrewPause.css";

const pauseTime = (at: number) =>
  new Date(at).toISOString().replace("T", " ").replace(".000Z", " UTC");

const REASON_MAX = 500;

export function CrewPauseControl() {
  const { data: pause, error } = useResource<CrewPause | null>(RESOURCES.crewPause);
  const { data: config } = useResource<ConfigView>(RESOURCES.config);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // What the server or the network said, kept as written; shown in the form's summary, or beside
  // the buttons when the form is closed (a failed Resume).
  const [failure, setFailure] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const guard = useSubmitGuard();
  const head = useId();
  const scopeId = useId();
  const seatsId = useId();
  const reasonId = useId();
  const allBox = useRef<HTMLInputElement>(null);
  const seats = (config?.crew?.sessions ?? []).flatMap((s) => s.seats);
  // While a save is out the modal stays: closing would drop the draft a failure must keep. Esc
  // pops the overlay before calling this, so it goes back on the stack.
  const close = () => {
    if (guard.pending()) pushOverlay("crew-pause", close);
    else setOpen(false);
  };
  useOverlay("crew-pause", open, close);
  useReturnFocus(open);
  useEffect(() => {
    if (open) allBox.current?.focus();
  }, [open]);

  const seatError =
    !all && selected.length === 0
      ? seats.length === 0
        ? "No seats are configured. Pause all seats instead."
        : "Choose at least one seat to pause, or pause all seats."
      : undefined;
  const reasonError = reason.trim() === "" ? "Enter a reason for the pause." : undefined;
  const issues: FieldIssue[] = attempted
    ? [
        ...(seatError ? [{ id: seatsId, message: seatError }] : []),
        ...(reasonError ? [{ id: reasonId, message: reasonError }] : []),
      ]
    : [];

  async function send(body: unknown, closeAfter: boolean) {
    if (pause === undefined || error) return;
    if (!guard.take()) return;
    setBusy(true);
    setFailure(null);
    setUncertain(false);
    try {
      await apiPost(ACTIONS.crewPause, body);
      hub.refetch(RESOURCES.crewPause.path);
      hub.refetch(RESOURCES.crew.path);
      if (closeAfter) setOpen(false);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
      setUncertain(isUncertain(err instanceof ApiError ? err.status : undefined));
      setFocusKey((key) => key + 1);
      // The server may have acted before the answer was lost: read what is saved.
      hub.refetch(RESOURCES.crewPause.path);
    } finally {
      guard.release();
      setBusy(false);
    }
  }

  function submit() {
    if (pause === undefined || error || guard.pending()) return;
    if (seatError || reasonError) {
      setAttempted(true);
      setFailure(null);
      setUncertain(false);
      setFocusKey((key) => key + 1);
      return;
    }
    setAttempted(false);
    void send({ seats: all ? "all" : selected, reason: reason.trim() }, true);
  }

  const picked = seats.filter((seat) => selected.includes(seat.id));
  const summary = all
    ? `All ${seats.length} seat${seats.length === 1 ? "" : "s"} will pause.`
    : picked.length === 0
      ? "No seats selected."
      : `${picked.length} of ${seats.length} seat${seats.length === 1 ? "" : "s"} will pause: ${picked
          .map((seat) => seat.id)
          .join(", ")}.`;

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
            setAttempted(false);
            setFailure(null);
            setUncertain(false);
          }
          setOpen(!open);
        }}
      >
        {pause ? "Edit crew pause" : "Pause crew"}
      </button>
      {pause && (
        <button
          type="button"
          className="sm"
          disabled={busy || !!error}
          onClick={() => void send({ seats: null }, false)}
        >
          Resume crew
        </button>
      )}
      {!open && failure && <span role="alert">{failure}</span>}
      {error && <span role="alert">Crew pause could not be loaded. Reload the page to retry.</span>}
      {pause === undefined && !error && <span role="status">Loading crew pause…</span>}
      {open &&
        createPortal(
          // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop takes focus from a click, so Tab stays trapped
          <div className="modal" tabIndex={-1} onKeyDown={trapTab}>
            <form
              className="panel crew-pause-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby={head}
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <div className="ph">
                <h2 id={head}>{pause ? "Edit crew pause" : "Pause crew"}</h2>
                <span className="sub">
                  {pause ? "The crew is paused." : "The crew is not paused."}
                </span>
              </div>
              <div className="pb scroll fform fform-640">
                <ErrorSummary
                  title="The crew pause was not saved"
                  issues={issues}
                  message={failure}
                  focusKey={focusKey}
                >
                  {uncertain && <p className="s">{UNCERTAIN_TEXT}</p>}
                </ErrorSummary>
                <fieldset className="fgroup" aria-labelledby={scopeId}>
                  <legend id={scopeId}>Scope</legend>
                  <label className="ffield-check">
                    <input
                      ref={allBox}
                      type="checkbox"
                      checked={all}
                      onChange={(e) => setAll(e.target.checked)}
                    />
                    All seats
                  </label>
                  {!all && (
                    <fieldset
                      id={seatsId}
                      className="fgroup crew-pause-seats"
                      tabIndex={-1}
                      aria-label="Seats to pause"
                      aria-describedby={seatError ? `${seatsId}-error` : undefined}
                    >
                      {seats.map((seat) => (
                        <label key={seat.id} className="ffield-check">
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
                      <FieldError id={seatsId} error={attempted ? seatError : undefined} />
                    </fieldset>
                  )}
                  <p className="s" role="status">
                    {summary}
                  </p>
                </fieldset>
                <div className="ffield">
                  <label htmlFor={reasonId}>Reason</label>
                  <input
                    {...fieldProps(
                      reasonId,
                      attempted ? reasonError : undefined,
                      `${reasonId}-hint`,
                    )}
                    value={reason}
                    maxLength={REASON_MAX}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <span id={`${reasonId}-hint`} className="fhint muted xs">
                    Shown beside the Paused badge. Up to {REASON_MAX} characters.
                  </span>
                  <FieldError id={reasonId} error={attempted ? reasonError : undefined} />
                </div>
                <fieldset className="fgroup crew-pause-duration">
                  <legend>Duration</legend>
                  <p>Until resumed</p>
                  <p className="fhint muted xs">
                    No automatic expiry. Live sessions stay running; other work waits unless its run
                    has an exception.
                  </p>
                </fieldset>
                {pause ? (
                  <section className="crew-pause-audit" aria-label="Crew pause audit">
                    <h3>Run exceptions</h3>
                    <p>
                      {pause.at === 0 ? (
                        "Pause record unreadable; owner and time unknown."
                      ) : (
                        <>
                          Paused by {pause.by} · {pauseTime(pause.at)}
                        </>
                      )}
                    </p>
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
                        Older seat-only entries: {pause.legacyExcept.join(", ")}. Their run and
                        grantor are unknown; they do not bypass this pause.
                      </p>
                    )}
                    {pause.liftedBy && !pause.except?.length && (
                      <p className="muted">
                        Earlier pause edit by {pause.liftedBy}; no run exception remains.
                      </p>
                    )}
                    <p className="muted">
                      Each exception ends with its run. Other tickets still wait.
                    </p>
                  </section>
                ) : null}
              </div>
              <div className="pfoot fact">
                <button type="submit" className="sm" disabled={busy || !!error}>
                  {all ? "Pause all seats" : "Pause selected seats"}
                </button>
                <button type="button" className="sm" disabled={busy} onClick={close}>
                  Cancel
                </button>
              </div>
            </form>
          </div>,
          document.body,
        )}
    </span>
  );
}
