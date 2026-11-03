import { useId, useRef, useState } from "react";
import { ListScrollCue } from "./ListScrollCue.tsx";

/**
 * A one-line reason with its whole text behind a "details" control: long text (a park reason,
 * findings, a developer's reply) is never shown until the viewer asks. `full` null: nothing more
 * to say, so no control.
 */
export function Reason({
  line,
  full,
  className = "vnow",
  label,
}: {
  line: string;
  full: string | null;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const region = useRef<HTMLElement>(null);
  const revealPending = useRef(false);
  const detailId = useId();
  // Keep the focused box within its ancestors while native scrolling preserves the reading position.
  const reveal = (reader: HTMLElement) => {
    if (revealPending.current) return;
    revealPending.current = true;
    requestAnimationFrame(() => {
      revealPending.current = false;
      if (document.activeElement === reader) {
        reader.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }
    });
  };
  return (
    <>
      <div className={className}>
        <span className="ellip" title={line}>
          {line}
        </span>
        {full !== null && (
          <button
            type="button"
            className="sm ghost"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={label ? `Read full ${label}` : undefined}
            onClick={() => setOpen(!open)}
          >
            {label ? "Read full" : "details"}
          </button>
        )}
      </div>
      {open && full !== null && (
        <>
          <ListScrollCue
            region={region}
            count={full.length}
            label="characters"
            text="Scroll ↕ for the full text"
          />
          <section
            className="vdetail"
            ref={region}
            id={detailId}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: full text can exceed the bounded disclosure.
            tabIndex={0}
            aria-label={label ? `Full ${label}` : "Full reason text"}
            onFocus={(event) => reveal(event.currentTarget)}
            onScroll={(event) => reveal(event.currentTarget)}
          >
            {full}
          </section>
        </>
      )}
    </>
  );
}
