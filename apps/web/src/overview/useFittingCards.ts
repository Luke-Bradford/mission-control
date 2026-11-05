import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * How many of a stage's cards fit whole in its body, so the Board never shows part of a card.
 *
 * The body renders every card first; this measures them, then trims to the ones whose foot is inside
 * the body, leaving room for the "+N more" row when any are left out (`reserveMore` says the list is
 * already cut, so that row is wanted even when every card fits). `null` means "show all": before the
 * first measure, and wherever the body has no height to measure (a hidden tab, a test DOM).
 *
 * `signature` changes when the cards do; it starts a fresh measure. A resize of the body also does,
 * but not the body's own shrink from the trim (a body that is as tall as its cards).
 */
export function useFittingCards(
  body: RefObject<HTMLElement | null>,
  signature: string,
  reserveMore: boolean,
): { limit: number | null; measuring: boolean } {
  const [limit, setLimit] = useState<number | null>(null);
  // The body's size after the last commit: a resize observer callback matching it is our own trim.
  const settled = useRef({ width: 0, height: 0 });
  const [measuring, setMeasuring] = useState(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new signature restarts the measure
  useLayoutEffect(() => {
    setLimit(null);
    setMeasuring(true);
  }, [signature, reserveMore]);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    if (measuring && limit === null) {
      const room = el.clientHeight;
      if (room > 0) {
        const top = el.getBoundingClientRect().top;
        const cards = [...el.querySelectorAll<HTMLElement>(":scope > .board-card")];
        const more = el.querySelector<HTMLElement>(":scope > .board-more");
        const moreHeight = more?.getBoundingClientRect().height ?? 0;
        const bottoms = cards.map((card) => card.getBoundingClientRect().bottom - top);
        const allFit = bottoms.every((bottom) => bottom <= room + 0.5);
        const withMore = (bottom: number) => bottom <= room - moreHeight + 0.5;
        const wholeList = allFit && (!reserveMore || bottoms.every(withMore));
        const fitting = wholeList ? cards.length : bottoms.filter(withMore).length;
        setLimit(fitting);
      }
      setMeasuring(false);
    }
    settled.current = { width: el.clientWidth, height: el.clientHeight };
  });

  useLayoutEffect(() => {
    const el = body.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const { width, height } = settled.current;
      if (el.clientWidth === width && el.clientHeight === height) return;
      setLimit(null);
      setMeasuring(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [body]);

  return { limit, measuring: measuring && limit === null };
}
