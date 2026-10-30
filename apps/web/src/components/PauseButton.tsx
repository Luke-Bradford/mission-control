import type { CrewRow } from "@mc/core";
import { useId, useState } from "react";
import { ApiError, apiPost } from "../api.ts";
import { ACTIONS, hub } from "../data.ts";
import "./PauseButton.css";

export const STUDIO_PAUSE_TOOLTIP = "pause arrives with cutover";

/**
 * Any refusal shows the server's own fixed text: a 409 is the studio cutover or a preview server's
 * `loop writes are disabled on this server`, a 503 a missing or unwritable state dir.
 */
const pauseError = (e: unknown): string =>
  e instanceof ApiError ? e.message : "server unreachable";

/** Pause / resume a TA loop through its PAUSE file; studio loops wait for the cutover. */
export function PauseButton({ row }: { row: Pick<CrewRow, "id" | "loopKind" | "paused"> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const studio = row.loopKind === "studio-loop";

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(row.paused ? ACTIONS.resume(row.id) : ACTIONS.pause(row.id));
    } catch (e) {
      setError(pauseError(e));
    } finally {
      setBusy(false);
      hub.refetchCrew(row.id);
    }
  };

  const button = (
    <button
      type="button"
      className="sm"
      disabled={studio || busy}
      title={
        studio
          ? undefined
          : row.paused
            ? "remove the loop's PAUSE file"
            : "create the loop's PAUSE file: it stops before its next run"
      }
      onClick={toggle}
    >
      {row.paused ? "resume" : "pause"}
    </button>
  );

  return (
    <>
      {error && <span className="crit-t s">{error}</span>}
      {studio ? (
        // a disabled button takes no focus and shows no tooltip by keyboard: the focusable
        // wrapper carries the reason, as a title for the pointer and a description for the rest
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the reason must be reachable by keyboard
        <span tabIndex={0} title={STUDIO_PAUSE_TOOLTIP} aria-describedby={reasonId}>
          {button}
          <span id={reasonId} className="sr-only">
            {STUDIO_PAUSE_TOOLTIP}
          </span>
        </span>
      ) : (
        button
      )}
    </>
  );
}
