import { type RefObject, useEffect, useState } from "react";

/** Overlay scrollbars cannot tell the reader that a bounded list has more content. */
export function ListScrollCue({
  region,
  label,
  count,
  text,
}: {
  region: RefObject<HTMLElement | null>;
  label: string;
  count: number;
  text?: string;
}) {
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = region.current;
    if (!element) return;
    const measure = () => setOverflow(count > 0 && element.scrollHeight > element.clientHeight + 1);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    measure();
    return () => observer?.disconnect();
  }, [region, count]);
  return (
    <p className="agent-list-scroll-cue s muted" hidden={!overflow}>
      {text ?? `Scroll ↕ for all ${count} ${label}`}
    </p>
  );
}
