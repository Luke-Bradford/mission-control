import { useState } from "react";
import { Grid, keyStep, PAD, Tip, useChartCursor, useChartWidth, XAxis } from "./Hover.tsx";

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
/** A bar takes at most this share of its slot; the rest is air. */
const BAR_SHARE = 0.6;

/** A square-ended bar from (x, y) down `h`. */
function barPath(x: number, y: number, w: number, h: number): string {
  return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`;
}

/**
 * Vertical bars, stacked when a bar has several segments (the mockup's `vbars` and its tokens-per-
 * turn chart): square-ended bars at most 60 % of their slot and 24 px wide, 2 px of surface between
 * stacked segments, dashed grid at 0/50/100 % of the tallest bar, an x axis, every `every`-th label
 * (or sparser, to fit) counted back from the last, plain history in a muted tone and the last bar
 * in the accent when `accentLast`. Each bar's whole slot is its hover target.
 */
export function VBars({
  bars,
  label,
  every = 1,
  accentLast = false,
  format = (v) => String(Math.round(v)),
  height = 150,
  times,
  annotations = [],
}: {
  bars: VBar[];
  label: string;
  every?: number;
  accentLast?: boolean;
  format?: (v: number) => string;
  height?: number;
  /** Epoch timestamps for bars in the shared time-chart workspace. */
  times?: number[];
  /** Events at known times, rendered only when the bars are timestamped. */
  annotations?: { at: number; label: string; color?: string }[];
}) {
  const [ref, w] = useChartWidth(560);
  const [hover, setHover] = useState<number | null>(null);
  const cursor = useChartCursor();
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
  const bw = Math.max(1, Math.min(BAR_MAX, slot * BAR_SHARE));
  const left = (i: number): number => x0 + i * slot + (slot - bw) / 2;
  const selected =
    times && cursor?.at !== null && cursor?.at !== undefined ? times.indexOf(cursor.at) : hover;
  const setSelected = (index: number | null) => {
    setHover(index);
    if (times) cursor?.setAt(index === null ? null : (times[index] ?? null));
  };
  // Labels thin out further when they would not fit their slots (~6.5 px a character at 11 px).
  const labelPx = Math.max(...bars.map((b) => b.label.length)) * 6.5 + 8;
  const step = Math.max(every, Math.ceil(labelPx / slot));

  const aria = `${label}: ${bars.map((b) => `${b.label} ${format(total(b))}`).join(", ")}`;

  return (
    <div className="chart" ref={ref}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        width="100%"
        preserveAspectRatio="xMinYMin meet"
        role="img"
        aria-label={aria}
        {...keyStep(n, selected, setSelected)}
      >
        <Grid max={peak} y={Y} x0={x0} x1={x1} label={format} />
        <XAxis y={yBottom} x0={x0} x1={x1} at={[]} />
        {bars.map((b, i) => {
          const last = i === n - 1;
          const stacked = b.segments.length > 1;
          const visible = b.segments.filter((s) => s.value > 0);
          let acc = 0;
          return (
            <g key={b.key} className={selected === i ? "on" : undefined}>
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
                    d={barPath(left(i), yt + gapAbove, bw, h)}
                    fill={fill}
                    fillOpacity={plain && !(accentLast && last) ? 0.38 : 1}
                  />
                );
              })}
              {(n - 1 - i) % step === 0 && (
                // the last label ends at the plot's edge so it is never cut off
                <text
                  className="ct xl"
                  x={last ? x1 : left(i) + bw / 2}
                  y={height - 3}
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
                onPointerEnter={() => setSelected(i)}
                onPointerLeave={() => setSelected(null)}
              />
            </g>
          );
        })}
        {times &&
          annotations.flatMap((annotation) => {
            const index = times.reduce(
              (best, time, i) =>
                Math.abs(time - annotation.at) < Math.abs((times[best] ?? time) - annotation.at)
                  ? i
                  : best,
              0,
            );
            if (index < 0) return [];
            const x = left(index) + bw / 2;
            return (
              <g className="annotation" key={`${annotation.at}:${annotation.label}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={yTop}
                  y2={yBottom}
                  stroke={annotation.color ?? "var(--warn)"}
                  strokeDasharray="2 3"
                />
                <text className="ct" x={x + 3} y={yTop + 12}>
                  {annotation.label}
                </text>
              </g>
            );
          })}
      </svg>
      {selected !== null && bars[selected] && (
        <Tip
          x={left(selected) + bw / 2}
          width={w}
          title={bars[selected].tip}
          rows={
            bars[selected].segments.length > 1
              ? [...bars[selected].segments].reverse().map((s) => ({
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
