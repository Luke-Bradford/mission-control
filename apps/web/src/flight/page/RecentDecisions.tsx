import { useLayoutEffect, useRef, useState } from "react";
import { useTz } from "../../clock.ts";
import { hhmm } from "../../fmt.ts";
import { decisionAnchor } from "../conversation.ts";
import type { FlightDecision } from "../flightTypes.ts";

/** At least this many decisions show, however short the panel. */
const MIN_SHOWN = 3;

/** Newest first; ties by id. */
export const newestFirst = (all: readonly FlightDecision[]): FlightDecision[] =>
  [...all].sort((a, b) => b.at - a.at || b.id - a.id);

/**
 * Decisions that fit the panel, newest first. Rows keep their height and sit at the top; spare
 * height shows more of them, never taller rows or a gap. `onShown` reports the count for the heading.
 */
export function DecisionRows({
  decisions,
  onShown,
}: {
  decisions: FlightDecision[];
  onShown: (n: number) => void;
}) {
  const tz = useTz();
  const list = useRef<HTMLUListElement>(null);
  const [fit, setFit] = useState(decisions.length);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the row count changes
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => {
      const row = el.firstElementChild;
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
    <ul className="fp-lines fp-decisions" id="decisions" ref={list}>
      {shown.map((d) => (
        <li key={d.id} id={decisionAnchor(d.id)}>
          <span className="fp-t">{tz === null ? "—" : hhmm(d.at, tz)}</span>
          <span className="fp-w fp-one" title={`${d.about}: ${d.decision}`}>
            <b>{d.about}</b> {d.decision}
          </span>
        </li>
      ))}
    </ul>
  );
}
