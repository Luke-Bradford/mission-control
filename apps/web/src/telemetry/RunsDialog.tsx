import { useEffect, useId, useRef } from "react";
import { trapTab, useOverlay, useReturnFocus } from "../shell/overlays.ts";
import type { StatSpec } from "./Stat.tsx";

/**
 * "Runs behind this number": what the list would hold, and the plain fact that no crew-wide
 * filtered runs list exists yet (the agent runs route serves one seat). Marked as needing a route.
 */
export function RunsDialog({ stat, onClose }: { stat: StatSpec | null; onClose: () => void }) {
  const open = stat !== null;
  const head = useId();
  const close = useRef<HTMLButtonElement>(null);
  useOverlay("telemetry-runs", open, onClose);
  useReturnFocus(open);
  useEffect(() => {
    if (open) close.current?.focus();
  }, [open]);
  if (!stat) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop takes focus from a click, so Tab stays trapped
    <div className="modal" tabIndex={-1} onKeyDown={trapTab}>
      <div className="panel runs-dialog" role="dialog" aria-modal="true" aria-labelledby={head}>
        <div className="ph">
          <h2 id={head}>Runs behind this number</h2>
          <span className="act">
            <button type="button" className="sm" ref={close} onClick={onClose}>
              Close
            </button>
          </span>
        </div>
        <div className="pb">
          <p>
            <b>{stat.label}</b>: {stat.value} {stat.unit}, {stat.window}.
          </p>
          <p className="fg2">This would list {stat.drill.target}.</p>
          <p className="note">
            Needs a new route. No crew-wide filtered runs list exists today; the agent runs route
            serves one seat.
          </p>
        </div>
      </div>
    </div>
  );
}
