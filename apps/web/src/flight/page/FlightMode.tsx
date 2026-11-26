import { FLIGHT_MODE_HINT, FLIGHT_MODE_LABEL, FLIGHT_MODES, type FlightMode } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../../api.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../../data.ts";

/**
 * How FLIGHT works, as the operator picks it: Crew, Watch or On call. The hub reads the setting on
 * every use, so a change applies at once. The checked mode is named in its radio and its hint.
 */
export function FlightModeControl() {
  const res = useResource<{ mode: FlightMode }>(RESOURCES.flightMode);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mode = res.data?.mode;
  const pick = async (next: FlightMode) => {
    if (next === mode || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await apiPost(ACTIONS.flightMode, { mode: next });
      hub.refetch(RESOURCES.flightMode.path);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fp-mode" role="radiogroup" aria-labelledby="fp-mode-label" aria-busy={busy}>
      <span className="fp-mode-label" id="fp-mode-label">
        Mode
      </span>
      {mode === undefined ? (
        res.error ? (
          <span className="fp-err">Could not read the mode: {res.error.message}</span>
        ) : (
          <span className="fp-muted">Mode: reading…</span>
        )
      ) : (
        <>
          {FLIGHT_MODES.map((m) => (
            <label key={m} className={`fp-mode-opt${m === mode ? " on" : ""}`}>
              <input
                type="radio"
                name="fp-mode"
                value={m}
                checked={m === mode}
                disabled={busy}
                onChange={() => void pick(m)}
              />
              {FLIGHT_MODE_LABEL[m]}
            </label>
          ))}
          <span className="fp-mode-hint" title={FLIGHT_MODE_HINT[mode]}>
            {FLIGHT_MODE_HINT[mode]}
          </span>
        </>
      )}
      {failure && (
        <span role="alert" className="fp-err">
          Mode not changed: {failure}
        </span>
      )}
    </div>
  );
}
