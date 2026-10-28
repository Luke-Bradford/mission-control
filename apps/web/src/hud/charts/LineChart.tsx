import { useState } from "react";
import {
  FadeGradient,
  Grid,
  keyStep,
  NowCursor,
  PAD,
  pointerX,
  spread,
  Tip,
  useChartCursor,
  useChartWidth,
  useGradientId,
  XAxis,
} from "./Hover.tsx";

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
 * `max`, dashed grid at 0/50/100 % of `max`, an optional dashed limit at 100 %, 1.5 px lines over a
 * fill fading to transparent, a "now" cursor at `to` (pulsing while `live`), and a crosshair that
 * snaps to the nearest sample and lists every series there.
 */
export function LineChart({
  series,
  bands = [],
  from,
  to,
  max = 100,
  ticks,
  limit = false,
  annotations = [],
  label,
  xLabels,
  at,
  height = 170,
  live = false,
}: {
  series: LineSeries[];
  bands?: { from: number; to: number; label: string }[];
  from: number;
  to: number;
  max?: number;
  /** Y values (in the same units as `max`) to grid and label; default 0, 50 and 100 % of `max`. */
  ticks?: number[];
  limit?: boolean;
  /** Events known at a precise sample time, such as an observed quota reset. */
  annotations?: { at: number; label: string; color?: string }[];
  label: string;
  xLabels: [string, string];
  /** The tooltip heading for a sample time. */
  at: (ms: number) => string;
  height?: number;
  /** `to` is now and moving: the cursor pulses. */
  live?: boolean;
}) {
  const [ref, w] = useChartWidth(560);
  const gid = useGradientId();
  const [localHover, setLocalHover] = useState<number | null>(null);
  const cursor = useChartCursor();
  const hover = cursor?.at ?? localHover;
  const setHover = (at: number | null) => {
    setLocalHover(at);
    cursor?.setAt(at);
  };
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

  // One area per unbroken run of readings, down to the baseline.
  const areas = (s: LineSeries): string[] => {
    const runs: { at: number; v: number }[][] = [[]];
    for (const p of s.points) {
      if (p.v === null) runs.push([]);
      else runs.at(-1)?.push({ at: p.at, v: p.v });
    }
    return runs
      .filter((r) => r.length > 1)
      .map((r) => {
        const top = r
          .map((p, i) => `${i ? "L" : "M"}${X(p.at).toFixed(1)},${Y(p.v).toFixed(1)}`)
          .join("");
        const first = r[0]?.at ?? from;
        const last = r.at(-1)?.at ?? from;
        return `${top}L${X(last).toFixed(1)},${yBottom}L${X(first).toFixed(1)},${yBottom}Z`;
      });
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
        {bands
          .filter((b) => b.to > from && b.from < to)
          .map((b) => {
            const left = X(Math.max(from, b.from));
            const right = X(Math.min(to, b.to));
            return (
              <g key={`${b.from}:${b.label}`}>
                <rect
                  className="band"
                  x={left}
                  y={yTop}
                  width={Math.max(0, right - left)}
                  height={yBottom - yTop}
                  fill="var(--warn)"
                  opacity={0.12}
                >
                  <title>{b.label}</title>
                </rect>
                <text className="ct" x={left + 3} y={yTop + 12}>
                  {b.label}
                </text>
              </g>
            );
          })}
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
        {annotations
          .filter((annotation) => annotation.at >= from && annotation.at <= to)
          .map((annotation) => {
            const x = X(annotation.at);
            return (
              <g className="annotation" key={`${annotation.at}:${annotation.label}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={yTop}
                  y2={yBottom}
                  stroke={annotation.color ?? "var(--warn)"}
                  strokeDasharray="2 3"
                  strokeWidth={1}
                />
                <text className="ct" x={x + 3} y={yTop + 12}>
                  {annotation.label}
                </text>
              </g>
            );
          })}
        <defs>
          {series.map((s, i) => (
            <FadeGradient
              key={s.id}
              id={`${gid}-${i}`}
              color={s.color}
              opacity={0.14}
              box={{ y1: yTop, y2: yBottom }}
            />
          ))}
        </defs>
        {series.map((s, i) => (
          <g key={s.id}>
            {areas(s).map((d) => (
              <path key={d} className="area" d={d} fill={`url(#${gid}-${i})`} />
            ))}
            <path
              className="line"
              d={path(s)}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        ))}
        <XAxis y={yBottom} x0={x0} x1={x1} at={spread(x0, x1, 4)} />
        <NowCursor x={x1} y1={yTop} y2={yBottom} live={live} />
        <text className="ct" x={x0} y={height - 3} textAnchor="start">
          {xLabels[0]}
        </text>
        <text className="ct now" x={x1} y={height - 3} textAnchor="end">
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
            strokeDasharray="3 3"
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
            // A shared crosshair must not invent a value from another sample time.
            const value = s.points.find((point) => point.at === hover)?.v;
            return {
              key: s.id,
              name: s.name,
              color: s.color,
              value: value === null || value === undefined ? "—" : pct(value),
            };
          })}
        />
      )}
    </div>
  );
}
