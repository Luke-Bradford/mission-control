import { useEffect, useId, useRef, useState } from "react";
import { copyText } from "../clipboard.ts";
import { Seg } from "../hud/Seg.tsx";
import { trapTab, useOverlay, useReturnFocus } from "../shell/overlays.ts";

export type BriefMode = "standup" | "weekly";

/** Standup or weekly update as plain text; Esc closes it and Tab stays inside. */
export function BriefModal({
  open,
  onClose,
  text,
}: {
  open: boolean;
  onClose: () => void;
  text: (mode: BriefMode) => string;
}) {
  const [mode, setMode] = useState<BriefMode>("standup");
  useOverlay("brief", open, onClose);
  const head = useId();
  const close = useRef<HTMLButtonElement>(null);
  useReturnFocus(open);
  useEffect(() => {
    if (open) close.current?.focus();
  }, [open]);
  if (!open) return null;
  const body = text(mode);
  const copy = () =>
    copyText(
      body,
      "Copied. Paste it into Teams or an email.",
      "Copy was blocked here; select the text and copy it.",
    );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop takes focus from a click, so Tab stays trapped
    <div className="modal" id="briefModal" tabIndex={-1} onKeyDown={trapTab}>
      <div className="panel" role="dialog" aria-modal="true" aria-labelledby={head}>
        <div className="ph">
          <h2 id={head}>Brief</h2>
          <Seg
            label="Brief type"
            options={[
              { value: "standup", label: "Standup" },
              { value: "weekly", label: "Weekly update" },
            ]}
            value={mode}
            onChange={setMode}
          />
          <span className="sub">plain text, no call signs, ready for Teams or email</span>
          <span className="act">
            <button type="button" className="sm primary" onClick={() => void copy()}>
              Copy
            </button>
            <button type="button" className="sm" ref={close} onClick={onClose}>
              Close
            </button>
          </span>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll a long brief, and a click here keeps focus in the modal */}
        <section className="pb scroll" aria-label="Brief text" tabIndex={0}>
          <pre id="briefText">{body}</pre>
        </section>
      </div>
    </div>
  );
}
