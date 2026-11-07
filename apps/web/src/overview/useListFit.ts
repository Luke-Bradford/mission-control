import { type RefObject, useLayoutEffect } from "react";

/** A list that overflows by less than this does not scroll: it grows, or its last row is left out whole. */
export const SCROLL_SLACK_PX = 40;

/** What a list's box should do, from the measures `useListFit` takes. */
export type ListFit =
  /** Fits, or has no limit to apply: leave it. */
  | { kind: "none" }
  /** Overflows by a sliver of a row: grow to the content so no scrollbar shows. */
  | { kind: "grow"; height: number }
  /** Overflows: end the box at the last whole row, so no row is cut at the foot. */
  | { kind: "snap"; height: number };

/**
 * `room` and `content` are the box's visible and full heights; `bottoms` are the foot of each row
 * from the top of the content; `limited` says a CSS max-height (not a parent's fixed size) is what
 * holds the box, so it may grow past it.
 */
export function fitList(
  room: number,
  content: number,
  bottoms: readonly number[],
  limited: boolean,
): ListFit {
  const overflow = content - room;
  if (overflow <= 0.5) return { kind: "none" };
  if (limited && overflow < SCROLL_SLACK_PX) return { kind: "grow", height: Math.ceil(content) };
  const whole = bottoms.filter((bottom) => bottom <= room + 0.5);
  const last = whole[whole.length - 1];
  return last === undefined || last >= room - 0.5
    ? { kind: "none" }
    : { kind: "snap", height: last };
}

/**
 * Keeps a scrolling list tidy: no scrollbar for a few pixels of overflow, and (with `rows`) no row cut
 * by the box's foot when it does scroll. It sets the box's inline max-height from measures and
 * clears it first, so the box's own CSS stays the starting point. `signature` restarts the measure
 * when the rows change; a resize of the box's parent does too.
 */
export function useListFit(
  list: RefObject<HTMLElement | null>,
  rows: string | null,
  signature: string | number,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new signature restarts the measure
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const apply = () => {
      el.style.maxHeight = "";
      const room = el.clientHeight;
      if (room <= 0) return;
      const top = el.getBoundingClientRect().top - el.scrollTop;
      const bottoms = rows
        ? [...el.querySelectorAll(rows)].map((row) => row.getBoundingClientRect().bottom - top)
        : [];
      const fit = fitList(
        room,
        el.scrollHeight,
        bottoms,
        getComputedStyle(el).maxHeight !== "none",
      );
      if (fit.kind !== "none") el.style.maxHeight = `${fit.height}px`;
    };
    apply();
    const parent = el.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(parent);
    return () => {
      observer.disconnect();
      el.style.maxHeight = "";
    };
  }, [list, rows, signature]);
}
