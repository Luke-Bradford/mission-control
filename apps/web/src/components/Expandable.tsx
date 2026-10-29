import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import "./Expandable.css";

export function Toggle({ on, of, onClick }: { on: boolean; of?: string; onClick: () => void }) {
  const text = on ? "Show less" : "Show more";
  return (
    <button
      type="button"
      className="sm"
      aria-expanded={on}
      aria-label={of ? `${text}, ${of}` : undefined}
      onClick={onClick}
    >
      {text}
    </button>
  );
}

/** The same clamp for measured disclosures and the Runs row's own button. */
export function Clamp({
  lines,
  open,
  children,
  className = "",
}: {
  lines: number;
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`expandable-text ${className}`}
      style={{ WebkitLineClamp: open ? "unset" : lines }}
    >
      {children}
    </span>
  );
}

type ExpandableProps =
  | { summary: ReactNode; children: ReactNode }
  | { lines: number; foldAfter?: number; of?: string; children: ReactNode };

/** Explicit summaries stay whole; measured prose folds only when it overflows. */
export function Expandable(props: ExpandableProps) {
  if ("summary" in props) {
    return (
      <details className="expandable disclosure">
        <summary>{props.summary}</summary>
        <div className="expandable-content">{props.children}</div>
      </details>
    );
  }
  return <MeasuredExpandable {...props} />;
}

/** Long text stays inside its row; expanded prose scrolls within a bounded height. */
function MeasuredExpandable({
  lines,
  foldAfter = lines,
  of,
  children,
}: {
  lines: number;
  foldAfter?: number;
  of?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const threshold = useRef(foldAfter);
  threshold.current = foldAfter;
  const remeasure = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
      const clampedHeight = Number.isFinite(lineHeight)
        ? threshold.current * lineHeight
        : el.clientHeight;
      const overflowing = el.scrollHeight > clampedHeight;
      setOverflows(overflowing);
      if (!overflowing) setOpen(false);
    };
    remeasure.current = measure;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    const mutations = new MutationObserver(measure);
    mutations.observe(el, { childList: true, characterData: true, subtree: true });
    window.addEventListener("resize", measure);
    // A disclosure may start inside a closed details element.
    const details = el.closest("details");
    details?.addEventListener("toggle", measure);
    return () => {
      observer?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", measure);
      details?.removeEventListener("toggle", measure);
    };
  }, []);
  useLayoutEffect(() => remeasure.current());
  const tabIndexes = useRef(new Map<HTMLElement, string | null>());
  useLayoutEffect(() => {
    const saved = tabIndexes.current;
    if (overflows && !open) {
      for (const el of box.current?.querySelectorAll<HTMLElement>(
        "a, button, input, select, textarea, [contenteditable], [tabindex]",
      ) ?? []) {
        if (!saved.has(el)) saved.set(el, el.getAttribute("tabindex"));
        el.setAttribute("tabindex", "-1");
      }
    } else {
      for (const [el, value] of saved) {
        if (value === null) el.removeAttribute("tabindex");
        else el.setAttribute("tabindex", value);
      }
      saved.clear();
    }
  });
  return (
    <div className={`expandable${open ? " open" : ""}`}>
      <div
        ref={box}
        className="expandable-content expandable-text"
        style={{ WebkitLineClamp: open ? "unset" : overflows ? lines : foldAfter }}
      >
        {children}
      </div>
      {overflows && <Toggle on={open} of={of} onClick={() => setOpen(!open)} />}
    </div>
  );
}
