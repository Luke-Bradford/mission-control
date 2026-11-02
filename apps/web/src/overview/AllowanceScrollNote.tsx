import { type RefObject, useLayoutEffect, useState } from "react";

/** A visible cue for overlay-scrollbar platforms, only while this evidence actually overflows. */
export function AllowanceScrollNote({ region }: { region: RefObject<HTMLElement | null> }) {
  const [text, setText] = useState("");
  useLayoutEffect(() => {
    const element = region.current;
    if (!element) return;
    const measure = () => {
      const next = [
        element.scrollWidth > element.clientWidth + 1
          ? "Scroll ↔ for every allowance column"
          : null,
        element.scrollHeight > element.clientHeight + 1
          ? "Scroll ↕ for every account window"
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
      setText((old) => (old === next ? old : next));
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    const table = element.querySelector("table");
    if (table) observer?.observe(table);
    measure();
    return () => observer?.disconnect();
  }, [region]);
  return (
    <p className="allowance-scroll-note s muted" hidden={!text}>
      {text}
    </p>
  );
}
