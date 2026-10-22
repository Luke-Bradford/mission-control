import { useState } from "react";
import { Grid, keyStep, PAD, pointerX, Tip, useChartWidth } from "./Hover.tsx";

export interface LineSeries {
  id: string;
  name: string;
  color: string;
  /** Oldest first; a null value breaks the line. */
  points: { at: number; v: number | null }[];
}

const pct = (v: number): string => `${Math.round(v)}%`;

/**
 * Percent lines over time (the mockup's `lineChart`): x from `from` to `to` (epoch ms), y from 0 to
 * `max`, grid at 0/50/100 % of `max`, an optional dashed limit at 100 %, a dot on each line's newest
 * point, and a crosshair that snaps to the nearest sample and lists every series there.
 */
export function LineChart({
  series,
  from,
  to,
  max = 100,
  ticks,
  limit = false,
  label,
  xLabels,
  at,
  height = 170,
}: {
  series: LineSeries[];
  from: number;
  to: number;
  max?: number;
  /** Y values (in the same units as `max`) to grid and label; default 0, 50 and 100 % of `max`. */
  ticks?: number[];
  limit?: boolean;
  label: string;
  xLabels: [string, string];
  /** The tooltip heading for a sample time. */
  at: (ms: number) => string;
  height?: number;
}) {
  const [ref, w] = useChartWidth(560);
  const [hover, setHover] = useState<number | null>(null);
  const span = Math.max(1, to - from);
  const x0 = PAD.l;
  const x1 = w - PAD.r;
  const yTop = PAD.t;
  const yBottom = height - PAD.b;
  const X = (t: number): number => x0 + ((t - from) / span) * (x1 - x0);
  const Y = (v: number): number => yTop + (1 - Math.min(v, max) / max) * (yBottom - yTop);

  const valued = (s: LineSeries) =>
    s.points.filter((p): p is { at: number; v: number } => p.v !== null);
  const times = [...new Set(series.flatMap((s) => valued(s).map((p) => p.at)))].sort(
    (a, b) => a - b,
  );
  const nearest = <T extends { at: number }>(list: T[], t: number): T | undefined =>
    list.reduce<T | undefined>(
      (best, p) => (best === undefined || Math.abs(p.at - t) < Math.abs(best.at - t) ? p : best),
      undefined,
    );

  const path = (s: LineSeries): string => {
    let d = "";
    let pen = false;
    for (const p of s.points) {
      if (p.v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${X(p.at).toFixed(1)},${Y(p.v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const aria = `${label}: ${series
    .map((s) => {
      const vs = valued(s);
      const last = vs.at(-1);
      return last
        ? `${s.name} latest ${pct(last.v)}, peak ${pct(Math.max(...vs.map((p) => p.v)))}`
        : `${s.name} no readings`;
    })
    .join("; ")}`;

  return (
    <div className="chart" ref={ref}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        width="100%"
        preserveAspectRatio="xMinYMin meet"
        role="img"
        aria-label={aria}
        {...keyStep(times.length, hover === null ? null : times.indexOf(hover), (i) =>
          setHover(i === null ? null : (times[i] ?? null)),
        )}
      >
        <Grid max={max} ticks={ticks} y={Y} x0={x0} x1={x1} label={pct} />
        {limit && (
          <line
            className="limit"
            x1={x0}
            x2={x1}
            y1={Y(100)}
            y2={Y(100)}
            stroke="var(--crit)"
            strokeDasharray="4 3"
            strokeWidth={1}
          />
        )}
        {series.map((s) => {
          const last = valued(s).at(-1);
          return (
            <g key={s.id}>
              <path
                className="line"
                d={path(s)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {last && (
                <circle
                  cx={X(last.at)}
                  cy={Y(last.v)}
                  r={4}
                  fill={s.color}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              )}
            </g>
          );
        })}
        <text className="ct" x={x0} y={height - 4} textAnchor="start">
          {xLabels[0]}
        </text>
        <text className="ct" x={x1} y={height - 4} textAnchor="end">
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
          onPointerMove={(e) => {
            const t = from + ((pointerX(e, w) - x0) / Math.max(1, x1 - x0)) * span;
            const snap = nearest(
              times.map((at) => ({ at })),
              t,
            );
            setHover(snap ? snap.at : null);
          }}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null && (
        <Tip
          x={X(hover)}
          width={w}
          title={at(hover)}
          rows={series.map((s) => {
            const p = nearest(valued(s), hover);
            return { key: s.id, name: s.name, color: s.color, value: p ? pct(p.v) : "—" };
          })}
        />
      )}
    </div>
  );
}
