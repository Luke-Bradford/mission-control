import { useState } from "react";
import { Grid, keyStep, nearestIndex, PAD, pointerX, Tip, useChartWidth } from "./Hover.tsx";

export interface AreaSeries {
  id: string;
  name: string;
  /** An agent token (`agentColor`). */
  color: string;
  /** Evenly spaced, oldest first; every series the same length. */
  values: number[];
}

/**
 * Series stacked bottom-up in the order given (the mockup's `stackedArea`): a wash and a 2 px top
 * line per series, a dot on the newest total, grid at 0/50/100 % of the peak total, and a crosshair
 * whose tooltip lists every series at that point, top of the stack first. An empty host for no series.
 */
export function StackedArea({
  series,
  label,
  xLabels,
  at,
  format,
  height = 170,
}: {
  series: AreaSeries[];
  /** What is plotted; the aria-label adds each series' latest and peak. */
  label: string;
  /** Under the first and last points. */
  xLabels: [string, string];
  /** The tooltip heading for point `i` of `n`. */
  at: (i: number, n: number) => string;
  format: (v: number) => string;
  height?: number;
}) {
  const [ref, w] = useChartWidth(1100);
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.max(0, ...series.map((s) => s.values.length));
  // The host stays mounted so its width is followed once series arrive.
  if (series.length === 0 || n < 2) return <div className="chart" ref={ref} />;

  const x0 = PAD.l;
  const x1 = w - PAD.r;
  const yTop = PAD.t;
  const yBottom = height - PAD.b;
  const totals = Array.from({ length: n }, (_, i) =>
    series.reduce((a, s) => a + (s.values[i] ?? 0), 0),
  );
  const peak = Math.max(1, ...totals);
  const max = peak * 1.08;
  const X = (i: number): number => x0 + (i / (n - 1)) * (x1 - x0);
  const Y = (v: number): number => yTop + (1 - v / max) * (yBottom - yTop);

  let base = Array<number>(n).fill(0);
  const layers = series.map((s) => {
    const top = base.map((b, i) => b + (s.values[i] ?? 0));
    const line = top
      .map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`)
      .join("");
    let area = line;
    for (let i = n - 1; i >= 0; i--) area += `L${X(i).toFixed(1)},${Y(base[i] ?? 0).toFixed(1)}`;
    base = top;
    return { s, line, area: `${area}Z` };
  });

  const aria = `${label}: ${series
    .map(
      (s) =>
        `${s.name} latest ${format(s.values[n - 1] ?? 0)}, peak ${format(Math.max(0, ...s.values))}`,
    )
    .join("; ")}`;

  return (
    <div className="chart" ref={ref}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        width="100%"
        preserveAspectRatio="xMinYMin meet"
        role="img"
        aria-label={aria}
        {...keyStep(n, hover, setHover)}
      >
        <Grid max={peak} y={Y} x0={x0} x1={x1} label={format} />
        {layers.map(({ s, area, line }) => (
          <g key={s.id}>
            <path className="area" d={area} fill={s.color} fillOpacity={0.26} />
            <path
              className="line"
              d={line}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        ))}
        <circle
          cx={X(n - 1)}
          cy={Y(totals[n - 1] ?? 0)}
          r={4}
          fill="var(--fg)"
          stroke="var(--surface)"
          strokeWidth={2}
        />
        <text className="ct" x={X(0)} y={height - 4} textAnchor="start">
          {xLabels[0]}
        </text>
        <text className="ct" x={X(n - 1)} y={height - 4} textAnchor="end">
          {xLabels[1]}
        </text>
        {hover !== null && (
          <line
            className="xhair"
            x1={X(hover)}
            x2={X(hover)}
            y1={yTop}
            y2={yBottom}
            stroke="var(--fg-2)"
            strokeWidth={1}
          />
        )}
        <rect
          className="hit"
          x={x0}
          y={yTop}
          width={Math.max(0, x1 - x0)}
          height={yBottom - yTop}
          fill="transparent"
          onPointerMove={(e) => setHover(nearestIndex(pointerX(e, w), n, x0, x1))}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null && (
        <Tip
          x={X(hover)}
          width={w}
          title={at(hover, n)}
          rows={[...series].reverse().map((s) => ({
            key: s.id,
            name: s.name,
            color: s.color,
            value: format(s.values[hover] ?? 0),
          }))}
        />
      )}
    </div>
  );
}
