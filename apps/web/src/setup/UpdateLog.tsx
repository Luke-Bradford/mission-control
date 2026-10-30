import type { UpdateLog } from "@mc/core";
import { useEffect, useId, useRef, useState } from "react";
import { apiGet } from "../api.ts";
import { ACTIONS } from "../data.ts";
import { trapTab, useOverlay, useReturnFocus } from "../shell/overlays.ts";

type LogState =
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | { kind: "ok"; log: UpdateLog };

/** The last update's commands and output, read fresh on each open; Esc closes it and Tab stays inside. */
export function UpdateLogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, setState] = useState<LogState>({ kind: "loading" });
  useOverlay("update-log", open, onClose);
  const head = useId();
  const close = useRef<HTMLButtonElement>(null);
  useReturnFocus(open);
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    let live = true;
    setState({ kind: "loading" });
    apiGet<UpdateLog>(ACTIONS.updateLog).then(
      (log) => live && setState({ kind: "ok", log }),
      (err: unknown) =>
        live && setState({ kind: "error", text: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [open]);
  const pane = useRef<HTMLElement>(null);
  // opens at the end, where a failed step says why
  useEffect(() => {
    if (state.kind === "ok" && pane.current) pane.current.scrollTop = pane.current.scrollHeight;
  }, [state]);
  if (!open) return null;
  const body =
    state.kind === "loading"
      ? "Reading update.log…"
      : state.kind === "error"
        ? `Could not read update.log: ${state.text}`
        : (state.log.text ?? "No update has run on this hub yet.");
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop takes focus from a click, so Tab stays trapped
    <div className="modal" id="updateLogModal" tabIndex={-1} onKeyDown={trapTab}>
      <div className="panel" role="dialog" aria-modal="true" aria-labelledby={head}>
        <div className="ph">
          <h2 id={head}>Update log</h2>
          <span className="sub">the last update's commands and output; a failed step ends it</span>
          <span className="act">
            <button type="button" className="sm" ref={close} onClick={onClose}>
              Close
            </button>
          </span>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll a long log, and a click here keeps focus in the modal */}
        <section className="pb scroll" aria-label="Update log text" tabIndex={0} ref={pane}>
          <pre>{body}</pre>
        </section>
      </div>
    </div>
  );
}
