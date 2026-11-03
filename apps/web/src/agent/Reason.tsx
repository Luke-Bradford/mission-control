import { useEffect, useId, useRef, useState } from "react";
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
  brief = false,
}: {
  line: string;
  full: string | null;
  className?: string;
  label?: string;
  brief?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const preview = useRef<HTMLSpanElement>(null);
  const region = useRef<HTMLElement>(null);
  const revealPending = useRef(false);
  const detailId = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: text can change overflow without changing the clamped box size.
  useEffect(() => {
    if (!brief || !preview.current) return;
    const element = preview.current;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    document.fonts?.ready.then(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [brief, line]);
  const disclosure = full !== null && (!brief || full !== line || clipped || open);
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
      <div className={`${className}${brief ? " vbrief" : ""}`}>
        <span className="ellip" title={line} ref={preview}>
          {line}
        </span>
        {disclosure && (
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
