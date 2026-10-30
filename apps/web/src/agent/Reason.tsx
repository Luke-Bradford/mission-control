import { useState } from "react";

/**
 * A one-line reason with its whole text behind a "details" control: long text (a park reason,
 * findings, a developer's reply) is never shown until the viewer asks. `full` null: nothing more
 * to say, so no control.
 */
export function Reason({
  line,
  full,
  className = "vnow",
}: {
  line: string;
  full: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
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
            onClick={() => setOpen(!open)}
          >
            details
          </button>
        )}
      </div>
      {open && full !== null && <pre className="vdetail">{full}</pre>}
    </>
  );
}
