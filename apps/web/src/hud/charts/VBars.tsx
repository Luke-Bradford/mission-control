import { useState } from "react";
import { Grid, keyStep, PAD, Tip, useChartWidth } from "./Hover.tsx";

export interface VBar {
  key: string;
  /** Under the bar (when labelled) and in the aria-label. */
  label: string;
  /** The tooltip heading. */
  tip: string;
  /** Bottom-up; a single segment without a colour is the plain grey bar. */
  segments: { name: string; value: number; color?: string }[];
}

const BAR_MAX = 24;
const RADIUS = 4;

/** A rect rounded only at its top (the data end); square at the baseline. */
function topRounded(x: number, y: number, w: number, h: number, round: boolean): string {
  const r = round ? Math.min(RADIUS, w / 2, h) : 0;
  return `M${x},${y + h}L${x},${y + r}Q${x},${y} ${x + r},${y}L${x + w - r},${y}Q${x + w},${y} ${x + w},${y + r}L${x + w},${y + h}Z`;
}

/**
 * Vertical bars, stacked when a bar has several segments (the mockup's `vbars` and its tokens-per-
 * turn chart): bars at most 24 px wide with a rounded top, 2 px of surface between stacked
 * segments, grid at 0/50/100 % of the tallest bar, every `every`-th label (or sparser, to fit) counted back
 * from the last, the last bar in the accent when `accentLast`. Each bar's whole slot is its hover target.
 */
export function VBars({
  bars,
  label,
  every = 1,
  accentLast = false,
  format = (v) => String(Math.round(v)),
  height = 150,
}: {
  bars: VBar[];
  label: string;
  every?: number;
  accentLast?: boolean;
  format?: (v: number) => string;
  height?: number;
}) {
  const [ref, w] = useChartWidth(560);
  const [hover, setHover] = useState<number | null>(null);
  const n = bars.length;
  if (n === 0) return <div className="chart" ref={ref} />;

  const x0 = PAD.l;
  const x1 = w - PAD.r;
  const yTop = PAD.t;
  const yBottom = height - PAD.b;
  const total = (b: VBar): number => b.segments.reduce((a, s) => a + s.value, 0);
  const peak = Math.max(1, ...bars.map(total));
  const max = peak * 1.15;
  const Y = (v: number): number => yTop + (1 - v / max) * (yBottom - yTop);
  const slot = (x1 - x0) / n;
  const bw = Math.max(1, Math.min(BAR_MAX, slot - 4));
  const left = (i: number): number => x0 + i * slot + (slot - bw) / 2;
  // Labels thin out further when they would not fit their slots (~6.5 px a character at 11 px).
  const labelPx = Math.max(...bars.map((b) => b.label.length)) * 6.5 + 8;
  const step = Math.max(every, Math.ceil(labelPx / slot));

  const aria = `${label}: ${bars.map((b) => `${b.label} ${format(total(b))}`).join(", ")}`;
  const hovered = hover === null ? undefined : bars[hover];

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
        {bars.map((b, i) => {
          const last = i === n - 1;
          const stacked = b.segments.length > 1;
          const visible = b.segments.filter((s) => s.value > 0);
          let acc = 0;
          return (
            <g key={b.key} className={hover === i ? "on" : undefined}>
              {visible.map((s, k) => {
                const yb = Y(acc);
                acc += s.value;
                const yt = Y(acc);
                // 2 px of surface between stacked segments: 1 px off each side of a joint
                const gapBelow = stacked && k > 0 ? 1 : 0;
                const gapAbove = stacked && k < visible.length - 1 ? 1 : 0;
                // a non-zero segment keeps at least a 1 px sliver
                const h = Math.max(1, yb - yt - gapBelow - gapAbove);
                const plain = s.color === undefined;
                const fill = plain
                  ? accentLast && last
                    ? "var(--accent)"
                    : "var(--fg-2)"
                  : s.color;
                return (
                  <path
                    key={s.name}
                    className="bar"
                    d={topRounded(left(i), yt + gapAbove, bw, h, k === visible.length - 1)}
                    fill={fill}
                    fillOpacity={plain && !(accentLast && last) ? 0.55 : 1}
                  />
                );
              })}
              {(n - 1 - i) % step === 0 && (
                // the last label ends at the plot's edge so it is never cut off
                <text
                  className="ct xl"
                  x={last ? x1 : left(i) + bw / 2}
                  y={height - 4}
                  textAnchor={last ? "end" : "middle"}
                >
                  {b.label}
                </text>
              )}
              <rect
                className="hit"
                x={x0 + i * slot}
                y={yTop}
                width={slot}
                height={yBottom - yTop}
                fill="transparent"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover((h) => (h === i ? null : h))}
              />
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <Tip
          x={left(hover) + bw / 2}
          width={w}
          title={hovered.tip}
          rows={
            hovered.segments.length > 1
              ? [...hovered.segments].reverse().map((s) => ({
                  key: s.name,
                  name: s.name,
                  color: s.color,
                  value: format(s.value),
                }))
              : []
          }
        />
      )}
    </div>
  );
}
