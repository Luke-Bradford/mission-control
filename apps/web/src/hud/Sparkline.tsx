import { useId } from "react";

/** The viewBox: stretched to the host (`preserveAspectRatio="none"`); strokes stay 1 px / 1.5 px. */
const W = 100;
const H = 24;
/** The y of the zero baseline; the peak gridline sits `top` units down from the top edge. */
const BASE = H - 1;

/** True when every reading is zero (or missing): there is nothing to draw but the baseline. */
export function quietSeries(values: (number | null)[]): boolean {
  return values.every((v) => v === null || v === 0);
}

/**
 * A mini trace of `values` (oldest first, the newest at the right edge) on a scale of 0 to `max`
 * (default: the series' peak): a solid baseline at zero, a dashed gridline at `max`, a 1.5 px line in
 * `color` over a gradient fill fading to transparent, and a thin "now" cursor at the right edge,
 * pulsing when `live`. A null breaks the line. An all-zero series is the baseline alone, drawn in the
 * trace's place. Renders nothing for fewer than two points.
 */
export function Sparkline({
  values,
  color,
  max: sharedMax,
  label = "tokens per minute",
  live = false,
  top: TOP = 3,
}: {
  values: (number | null)[];
  color: string;
  max?: number;
  label?: string;
  live?: boolean;
  /** Room above the peak gridline (viewBox units of 24), e.g. for a label over it. */
  top?: number;
}) {
  const gradient = `spark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const n = values.length;
  if (n < 2) return null;
  const max = Math.max(1, sharedMax ?? Math.max(...values.filter((v) => v !== null)));
  const quiet = quietSeries(values);
  const x = (i: number): number => (i / (n - 1)) * W;
  const y = (v: number): number => BASE - (Math.max(0, Math.min(v, max)) / max) * (BASE - TOP);
  // Contiguous runs of readings; each is a line piece and, when it has width, an area.
  const runs = values.reduce<{ i: number; v: number }[][]>(
    (all, v, i) => {
      if (v === null) all.push([]);
      else all.at(-1)?.push({ i, v });
      return all;
    },
    [[]],
  );
  const pieces = runs.filter((r) => r.length > 0);
  const line = pieces
    .map((r) =>
      r.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(""),
    )
    .join("");
  return (
    <svg
      data-max={max}
      className={`spark${quiet ? " quiet" : ""}`}
      preserveAspectRatio="none"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient
          id={gradient}
          gradientUnits="userSpaceOnUse"
          x1={0}
          y1={TOP}
          x2={0}
          y2={BASE}
        >
          <stop offset="0" stopColor={color} stopOpacity={0.26} />
          <stop offset="1" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {!quiet && <line className="spark-grid" x1={0} x2={W} y1={TOP} y2={TOP} />}
      <line className="spark-base" x1={0} x2={W} y1={BASE} y2={BASE} />
      {!quiet &&
        pieces
          .filter((r) => r.length > 1)
          .map((r) => {
            const first = r[0];
            const last = r.at(-1);
            if (!first || !last) return null;
            const top = r
              .map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`)
              .join("");
            return (
              <path
                key={first.i}
                d={`${top}L${x(last.i).toFixed(1)},${BASE}L${x(first.i).toFixed(1)},${BASE}Z`}
                fill={`url(#${gradient})`}
              />
            );
          })}
      <path
        className="spark-line"
        d={line}
        fill="none"
        stroke={quiet ? "var(--line-2)" : color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <line className={`spark-now${live ? " live" : ""}`} x1={W} x2={W} y1={0} y2={H} />
    </svg>
  );
}
