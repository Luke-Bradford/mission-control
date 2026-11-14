import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** Rows not wholly inside the scroller's view (or below it). */
function rowsBelow(scroller: HTMLElement, row: string): number {
  const edge = scroller.getBoundingClientRect().bottom + 1;
  return [...scroller.querySelectorAll(row)].filter(
    (el) => el.getBoundingClientRect().bottom > edge,
  ).length;
}

/**
 * A list that may be cut short by the panel around it: it scrolls, and a foot counts the rows that
 * are not wholly in view, as Blockers does, so nothing hides without a sign.
 */
export function ScrollList({
  row,
  className,
  children,
}: {
  /** Selector for one row, inside the scroller. */
  row: string;
  className?: string;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(0);
  // Measure again after every render: the rows change the heights.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) setBelow(rowsBelow(el, row));
  });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const count = () => setBelow(rowsBelow(el, row));
    el.addEventListener("scroll", count);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(count);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", count);
      ro?.disconnect();
    };
  }, [row]);
  return (
    <div className="fp-sl">
      <div className={className ? `fp-slbody ${className}` : "fp-slbody"} ref={scroller}>
        {children}
      </div>
      {below > 0 && (
        <div className="fp-more" role="status">
          {below} more below · scroll the list or Tab to the next row
        </div>
      )}
    </div>
  );
}
