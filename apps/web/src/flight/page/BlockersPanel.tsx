import { useLayoutEffect, useRef, useState } from "react";
import { dur } from "../../fmt.ts";
import type { Blocker } from "./blockers.ts";

export const NOTHING_BLOCKING = "Nothing is blocking FLIGHT";

/** Rows not wholly inside the scroller's view (or below it), for the "N more below" cue. */
function rowsBelow(scroller: HTMLElement): number {
  const edge = scroller.getBoundingClientRect().bottom + 1;
  return [...scroller.children].filter((row) => row.getBoundingClientRect().bottom > edge).length;
}

/**
 * The blockers table; with none, the panel says so at the top. Each row is a button that opens in
 * place to the whole blocker, its detail and what FLIGHT is doing, so cut-off text is reachable
 * from the keyboard. A list longer than the panel scrolls, and the foot says how many rows lie below.
 */
export function BlockersList({ rows }: { rows: Blocker[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [below, setBelow] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-count when the rows or an opened row change the heights
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const count = () => setBelow(rowsBelow(el));
    count();
    el.addEventListener("scroll", count);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(count);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", count);
      ro?.disconnect();
    };
  }, [rows, open]);
  if (rows.length === 0) {
    return (
      <div className="fp-empty" id="blockers">
        <b className="fp-ok">{NOTHING_BLOCKING}</b>
        <span>If something stalls, it appears here with its owner and how long it has waited.</span>
      </div>
    );
  }
  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <div className="fp-blockers" id="blockers">
      <div className="fp-bhead">
        <span>Blocker</span>
        <span>Owner</span>
        <span className="fp-r">Waited ↓</span>
        <span>What FLIGHT is doing</span>
      </div>
      <div className="fp-brows" ref={scroller}>
        {rows.map((b) => {
          const isOpen = open.has(b.key);
          return (
            <button
              type="button"
              className={isOpen ? "fp-brow open" : "fp-brow"}
              key={b.key}
              aria-expanded={isOpen}
              onClick={() => toggle(b.key)}
            >
              <span className="fp-what">
                <b>{b.what}</b>
                {b.detail && <span>{b.detail}</span>}
              </span>
              <span className={`fp-owner ${b.tone}`}>{b.owner}</span>
              <span className="fp-wait">{b.waitedMs === null ? "—" : dur(b.waitedMs)}</span>
              <span className="fp-act">{b.doing}</span>
            </button>
          );
        })}
      </div>
      {below > 0 && (
        <div className="fp-more" role="status">
          {below} more below · scroll the list or Tab to the next row
        </div>
      )}
    </div>
  );
}
