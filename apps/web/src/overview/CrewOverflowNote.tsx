import { type RefObject, useEffect, useState } from "react";

/** Actual layout feedback belongs to this note, never to the roster's clock/data projection. */
export function CrewOverflowNote({
  id,
  table,
  count,
  pending,
}: {
  id: string;
  table: RefObject<HTMLDivElement | null>;
  count: number;
  pending: boolean;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    const region = table.current;
    if (!region) return;
    const measure = () => {
      const vertical = region.scrollHeight > region.clientHeight + 1,
        horizontal = region.scrollWidth > region.clientWidth + 1;
      const box = region.getBoundingClientRect(),
        header = region.querySelector(".head")?.getBoundingClientRect().height ?? 0;
      const visible = [...region.querySelectorAll(".trow:not(.head)")].filter((row) => {
        const b = row.getBoundingClientRect();
        return b.top >= box.top + header - 1 && b.bottom <= box.bottom + 1;
      }).length;
      const next = [
        vertical
          ? pending
            ? "Loading configured seats · scroll ↕ to see every row"
            : `${count} agents · ${visible} fully visible · scroll ↕ to see every agent`
          : null,
        horizontal ? "Scroll ↔ to compare every column" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      setText((previous) => (previous === next ? previous : next));
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(region);
    for (const row of region.children) observer?.observe(row);
    region.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      observer?.disconnect();
      region.removeEventListener("scroll", measure);
    };
  }, [count, pending, table]);
  return (
    <p id={id} className="crew-scroll-note" hidden={!text}>
      {text}
    </p>
  );
}
