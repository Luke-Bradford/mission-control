import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

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

/** Long text stays inside its row; expanded prose scrolls within a bounded height. */
export function Expandable({
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Remeasure after refreshed children change the rendered height.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
      const clampedHeight = Number.isFinite(lineHeight) ? foldAfter * lineHeight : el.clientHeight;
      const overflowing = el.scrollHeight > clampedHeight;
      setOverflows(overflowing);
      if (!overflowing) setOpen(false);
    };
    measure();
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
  }, [children, foldAfter]);
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
