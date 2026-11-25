import { useState } from "react";
import { useTz } from "../../clock.ts";
import { rel } from "../../fmt.ts";
import {
  LOADING,
  NOT_MEASURED,
  UNMEASURED,
  VITAL_SHAPE,
  VITAL_WORD,
  type Vital,
} from "./vitals.ts";

/** What the Checked column says for a figure worked out afresh on each load. */
export const CHECKED_LIVE = "live";

/**
 * The control room: one row per measure, worst first, with its state (a colour, a word and a shape), the value,
 * the bands it is judged by and when its source last moved. A row with no figure says why (loading,
 * or what its source is missing). Measures the hub has no source for are one line at the foot,
 * opened to name each and what it needs, so they never push the rows that have figures apart.
 */
export function ControlRoom({ vitals, now }: { vitals: readonly Vital[]; now: number }) {
  const tz = useTz();
  // The list is rendered only when open: a closed <details> still lays its rows out past the panel.
  const [unmeasuredOpen, setUnmeasuredOpen] = useState(false);
  const counts = { ok: 0, warn: 0, crit: 0, none: 0 };
  for (const v of vitals) counts[v.state]++;
  return (
    <section className="fp-panel fp-room" id="roomP" aria-labelledby="roomH">
      <h2 className="fp-head" id="roomH">
        How the operation is faring
        <span className="fp-sub">
          {counts.crit} bad · {counts.warn} watch · {counts.ok} good
          {counts.none > 0 && ` · ${counts.none} unknown`}
        </span>
      </h2>
      <ul className="fp-vitals">
        <li className="fp-vrow fp-vcols" aria-hidden="true">
          <span>State</span>
          <span>Measure</span>
          <span>Now</span>
          <span>Good and bad</span>
          <span>Checked</span>
        </li>
        {vitals.map((v) => (
          <li key={v.id} className={`fp-vrow fp-v-${v.state}`} data-vital={v.id}>
            <span className="fp-vstate">
              <i className={`fp-shape ${VITAL_SHAPE[v.state]}`} aria-hidden="true" />
              {VITAL_WORD[v.state]}
            </span>
            <span className="fp-vlabel">
              {v.label}
              <span className="fp-vsource">from {v.source}</span>
            </span>
            <span
              className={
                v.value === NOT_MEASURED || v.value === LOADING ? "fp-vvalue fp-muted" : "fp-vvalue"
              }
            >
              {v.value}
            </span>
            <span className="fp-vband">{v.band}</span>
            <span className="fp-vchecked">
              {v.state === "none"
                ? "—"
                : v.checkedAt !== null && tz !== null
                  ? rel(v.checkedAt, now, tz)
                  : CHECKED_LIVE}
            </span>
          </li>
        ))}
      </ul>
      <div className="fp-unmeasured">
        <button
          type="button"
          className="fp-unmeasured-toggle"
          aria-expanded={unmeasuredOpen}
          aria-controls="fp-unmeasured-list"
          onClick={() => setUnmeasuredOpen(!unmeasuredOpen)}
        >
          {`${UNMEASURED.length} measures ${NOT_MEASURED}`}
        </button>
        {unmeasuredOpen && (
          <ul id="fp-unmeasured-list">
            {UNMEASURED.map((u) => (
              <li key={u.id} data-vital={u.id}>
                <span className="fp-vlabel">{u.label}</span>
                <span className="fp-muted">: {u.source}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="fp-note fp-bandnote">
        Good and bad limits are drafts until a week of real figures settles them with the operator.
      </p>
    </section>
  );
}
