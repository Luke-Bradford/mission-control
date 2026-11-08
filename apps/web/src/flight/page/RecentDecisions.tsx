import { useLayoutEffect, useRef, useState } from "react";
import { useNow, useTz } from "../../clock.ts";
import { hhmm } from "../../fmt.ts";
import { decisionAnchor } from "../conversation.ts";
import type { FlightDecision } from "../flightTypes.ts";
import { decisionLine, readableTimes } from "./decisionText.ts";

/** At least this many decisions show, however short the panel. */
const MIN_SHOWN = 3;

/** Newest first; ties by id. */
export const newestFirst = (all: readonly FlightDecision[]): FlightDecision[] =>
  [...all].sort((a, b) => b.at - a.at || b.id - a.id);

/**
 * Decisions that fit the panel, newest first. Rows keep their height and sit at the top; spare
 * height shows more of them, never taller rows or a gap. A row is a button: it opens in place to
 * the whole decision and its basis, one at a time, for a reader who cannot hover the cut-off line.
 * `onShown` reports the count for the heading.
 */
export function DecisionRows({
  decisions,
  onShown,
}: {
  decisions: FlightDecision[];
  onShown: (n: number) => void;
}) {
  const tz = useTz();
  const now = useNow();
  const list = useRef<HTMLUListElement>(null);
  const [fit, setFit] = useState(decisions.length);
  const [open, setOpen] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the row count changes
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => {
      // An open row is taller than the others, so the height comes from a closed one.
      const row = [...el.children].find((li) => !li.hasAttribute("data-open"));
      const h = row ? row.getBoundingClientRect().height : 0;
      if (h > 0) setFit(Math.max(MIN_SHOWN, Math.floor(el.clientHeight / h)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [decisions.length]);
  const shown = decisions.slice(0, fit);
  useLayoutEffect(() => onShown(shown.length), [shown.length, onShown]);
  return (
    <ul
      className="fp-lines fp-decisions"
      id="decisions"
      ref={list}
      data-open={open === null ? undefined : ""}
    >
      {shown.map((d) => {
        const line = tz === null ? { lead: d.about, rest: d.decision } : decisionLine(d, now, tz);
        const isOpen = open === d.id;
        return (
          <li key={d.id} id={decisionAnchor(d.id)} data-open={isOpen ? "" : undefined}>
            <button
              type="button"
              className="fp-drow"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : d.id)}
            >
              <span className="fp-t">{tz === null ? "—" : hhmm(d.at, tz)}</span>
              <span className="fp-w fp-one">
                <b>{line.lead}</b> {line.rest}
              </span>
            </button>
            {isOpen && (
              <div className="fp-detail">
                <p>
                  <b>{line.lead}</b> {line.rest}
                </p>
                {d.basis && (
                  <p>
                    <span className="fp-muted">Basis</span>{" "}
                    {tz === null ? d.basis : readableTimes(d.basis, now, tz)}
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
