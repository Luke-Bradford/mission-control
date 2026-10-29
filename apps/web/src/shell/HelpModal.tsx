import { useEffect, useId, useRef } from "react";
import { closeHelp, trapTab, useHelpOpen, useOverlay, useReturnFocus } from "./overlays.ts";

/** "Keys and lamps" (catalogue §2.10, without the mockup's "invented data" sentence); Tab stays inside. */
export function HelpModal() {
  const open = useHelpOpen();
  useOverlay("help", open, closeHelp);
  const head = useId();
  const close = useRef<HTMLButtonElement>(null);
  useReturnFocus(open);
  useEffect(() => {
    if (open) close.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop takes focus from a click, so Tab stays trapped
    <div className="modal" tabIndex={-1} onKeyDown={trapTab}>
      <div className="panel" role="dialog" aria-modal="true" aria-labelledby={head}>
        <div className="ph">
          <h2 id={head}>Keys and lamps</h2>
          <span className="act">
            <button type="button" className="sm" ref={close} onClick={closeHelp}>
              Close
            </button>
          </span>
        </div>
        <div className="pb helpb">
          <p>
            <kbd>g</kbd> then <kbd>o</kbd> Overview · <kbd>f</kbd> FLIGHT · <kbd>b</kbd> Board ·{" "}
            <kbd>a</kbd> Agent · <kbd>m</kbd> Map · <kbd>c</kbd> Comms · <kbd>t</kbd> Telemetry ·{" "}
            <kbd>d</kbd> Audit · <kbd>s</kbd> Setup
          </p>
          <p>
            <kbd>f</kbd> show or hide FLIGHT · <kbd>j</kbd> <kbd>k</kbd> next or previous agent ·{" "}
            <kbd>/</kbd> message the selected agent · <kbd>i</kbd> interrupt it · <kbd>Esc</kbd>{" "}
            close
          </p>
          <p className="note">
            Amber breathes slowly where something waits on you; green breathes where an agent is
            working. Acknowledge an item to stop its pulse; it clears when you act. Colour always
            comes with a word, so nothing depends on colour alone. @CAPCOM marks a message addressed
            to you.
          </p>
          <p className="note">
            Answer, Open and Read the brief all open one panel for that item: what is asked, why,
            what FLIGHT checked, your choices, and a chat about it. Every item FLIGHT brings starts
            with a catch-up: new or follow-up, the story so far, and what to be aware of. Show build
            status (bottom left) marks every panel with how buildable it is today.
          </p>
        </div>
      </div>
    </div>
  );
}
