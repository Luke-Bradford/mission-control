import { type RefObject, useEffect, useState } from "react";

/** A visible cue for overlay-scrollbar platforms, derived from actual region/content geometry. */
export function OverviewOverflowNote({
  region,
  label,
  compact = false,
}: {
  compact?: boolean;
  region: RefObject<HTMLElement | null>;
  label: string;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    const element = region.current;
    if (!element) return;
    const measure = () => {
      const directions = [
        element.scrollHeight > element.clientHeight + 1 ? "↕" : null,
        element.scrollWidth > element.clientWidth + 1 ? "↔" : null,
      ].filter(Boolean);
      const next = directions.length
        ? `Scroll ${directions.join(" ")}${compact ? "" : ` for ${label}`}`
        : "";
      setText((previous) => (previous === next ? previous : next));
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    measure();
    return () => observer?.disconnect();
  }, [region, label, compact]);
  return (
    <p className="s muted overview-overflow-note" hidden={!text} title={`Scroll for ${label}`}>
      {text}
    </p>
  );
}
