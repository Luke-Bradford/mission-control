import type { MetricId } from "@mc/core";
import { useId } from "react";
import { followLink } from "../router.ts";
import { DASH } from "./common.ts";

/** Where a number leads: a page that exists today, or a list that needs a new route. */
export type Drill =
  | { kind: "link"; href: string; target: string }
  | { kind: "needs-route"; target: string };

/** One figure: label, value, unit, window, definition, and where it leads. */
export interface StatSpec {
  id: string;
  label: string;
  /** `—` while it has no figure. */
  value: string;
  unit: string;
  window: string;
  /** What it counts, shown on hover and on keyboard focus. */
  definition: string;
  drill: Drill;
  /** A comparison or reason beside the window ("vs ~$41.00 7-day average"). */
  detail?: string;
  /** A registry figure (`METRICS` in mc/core): the value is the registry's and is marked as such. */
  metric?: MetricId;
  /** The Crew health tile only: its verdict. */
  verdict?: "Healthy" | "Watch" | "Needs attention";
}

/** The accessible name: everything the tile shows, and where the number goes. */
const nameOf = (s: StatSpec): string =>
  `${s.label}: ${s.value} ${s.unit}, ${s.window}. ${
    s.drill.kind === "link" ? "Opens" : "Needs a new route:"
  } ${s.drill.target}.${s.detail ? ` ${s.detail}.` : ""}`;

/**
 * A stat tile. The value is a link where a page exists and a button where the list behind it needs
 * a route that is not built; the definition shows on hover and keyboard focus.
 */
export function Stat({
  stat: s,
  onNeedsRoute,
}: {
  stat: StatSpec;
  onNeedsRoute: (s: StatSpec) => void;
}) {
  const def = useId();
  const verdictClass = s.verdict
    ? ` v-${s.verdict === "Needs attention" ? "attention" : s.verdict.toLowerCase()}`
    : "";
  // No figure, nothing to open: the value stays focusable but does nothing until one arrives.
  const unavailable = s.value === DASH;
  const value =
    s.drill.kind === "link" ? (
      <a
        className="num stat-value"
        href={unavailable ? undefined : s.drill.href}
        role={unavailable ? "link" : undefined}
        tabIndex={unavailable ? 0 : undefined}
        aria-disabled={unavailable || undefined}
        aria-describedby={def}
        aria-label={nameOf(s)}
        data-drill="exists"
        data-metric={s.metric}
        onClick={(e) => {
          if (unavailable) e.preventDefault();
          else followLink(e, (s.drill as { href: string }).href);
        }}
      >
        {s.value}
      </a>
    ) : (
      <button
        type="button"
        className="num stat-value"
        aria-disabled={unavailable || undefined}
        aria-describedby={def}
        aria-label={nameOf(s)}
        data-drill="needs-route"
        data-metric={s.metric}
        onClick={() => {
          if (!unavailable) onNeedsRoute(s);
        }}
      >
        {s.value}
      </button>
    );
  return (
    <div className={`stat${verdictClass}`} data-stat={s.id}>
      <span className="stat-label" title={s.label}>
        {s.label}
      </span>
      <div className="stat-main">
        {value}
        <span className="stat-unit" title={s.unit}>
          {s.unit}
        </span>
      </div>
      <div className="stat-sub" title={`${s.window}${s.detail ? ` · ${s.detail}` : ""}`}>
        <span className="stat-window">{s.window}</span>
        {s.detail && <span className="stat-cmp"> · {s.detail}</span>}
      </div>
      <div className="stat-def" id={def} role="tooltip">
        {s.definition}
        {s.detail && <span> {s.detail}</span>}
      </div>
    </div>
  );
}

/**
 * A figure inside a chart's readout: a link to the page behind it, focusable, with its definition
 * on hover and keyboard focus.
 */
export function Cell({
  text,
  label,
  definition,
  href,
}: {
  text: string;
  label: string;
  definition: string;
  href: string;
}) {
  const def = useId();
  return (
    <span className="crew-cell">
      <a
        className="num crew-cell-value"
        href={href}
        aria-describedby={def}
        aria-label={`${label}: ${text}. ${definition}`}
        data-drill="exists"
        onClick={(e) => followLink(e, href)}
      >
        {text}
      </a>
      <span className="crew-cell-def" id={def} role="tooltip">
        {definition}
      </span>
    </span>
  );
}
