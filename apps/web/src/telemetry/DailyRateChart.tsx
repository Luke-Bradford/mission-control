import { useState } from "react";
import { dayMonth } from "../fmt.ts";
import { Grid, keyStep, PAD, Tip, useChartWidth, XAxis } from "../hud/charts/Hover.tsx";
import "../hud/charts/VBars.css";

export interface DailyPoint {
  /** Start of the local day, epoch ms. */
  at: number;
  /** The day's value; null when nothing was observed that day (a gap, never zero). */
  v: number | null;
}

const BAR_MAX = 28;
const BAR_SHARE = 0.6;

/**
 * One bar per day with the day's value on hover and keyboard focus, and, with `rolling`, a line of
 * the rolling rate over the bars. Days without data are gaps in both. The scale runs 0 to `max`.
 */
export function DailyRateChart({
  label,
  days,
  rolling,
  rollingName,
  barName,
  max,
  ticks,
  format,
  tz,
  height = 150,
}: {
  label: string;
  days: DailyPoint[];
  rolling?: (number | null)[];
  rollingName?: string;
  barName: string;
  max: number;
  ticks: number[];
  format: (v: number) => string;
  tz: string;
  height?: number;
}) {
  const [ref, w] = useChartWidth(560);
  const [sel, setSel] = useState<number | null>(null);
  const n = days.length;
  if (n === 0) return <div className="chart" ref={ref} />;
  const x0 = PAD.l;
  const x1 = w - PAD.r;
  const yTop = PAD.t;
  const yBottom = height - PAD.b;
  const Y = (v: number): number => yTop + (1 - v / max) * (yBottom - yTop);
  const slot = (x1 - x0) / n;
  const bw = Math.max(1, Math.min(BAR_MAX, slot * BAR_SHARE));
  const cx = (i: number): number => x0 + i * slot + slot / 2;
  const dayText = (i: number): string => dayMonth((days[i] as DailyPoint).at, tz);
  let line = "";
  let pen = false;
  (rolling ?? []).forEach((v, i) => {
    if (v === null || days[i]?.v == null) {
      pen = false;
      return;
    }
    line += `${pen ? "L" : "M"}${cx(i).toFixed(1)},${Y(v).toFixed(1)}`;
    pen = true;
  });
  const aria = `${label}: ${days
    .map((d, i) => `${dayText(i)} ${d.v === null ? "no data" : format(d.v)}`)
    .join(", ")}`;
  const hit = sel === null ? null : (days[sel] ?? null);
  return (
    <div className="chart" ref={ref}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        width="100%"
        preserveAspectRatio="xMinYMin meet"
        role="img"
        aria-label={aria}
        {...keyStep(n, sel, setSel)}
      >
        <Grid max={max} ticks={ticks} y={Y} x0={x0} x1={x1} label={format} />
        <XAxis y={yBottom} x0={x0} x1={x1} at={[]} />
        {days.map((d, i) => (
          <g key={d.at} className={sel === i ? "on" : undefined} data-day={d.at}>
            {d.v !== null && (
              <rect
                className="bar"
                x={cx(i) - bw / 2}
                y={Y(d.v)}
                width={bw}
                height={Math.max(1, yBottom - Y(d.v))}
                fill="var(--fg-2)"
                fillOpacity={0.38}
              />
            )}
            {(n - 1 - i) % Math.max(1, Math.ceil(52 / slot)) === 0 && (
              <text
                className="ct xl"
                x={i === n - 1 ? x1 : cx(i)}
                y={height - 3}
                textAnchor={i === n - 1 ? "end" : "middle"}
              >
                {dayText(i)}
              </text>
            )}
            <rect
              className="hit"
              x={x0 + i * slot}
              y={yTop}
              width={slot}
              height={yBottom - yTop}
              fill="transparent"
              onPointerEnter={() => setSel(i)}
              onPointerLeave={() => setSel(null)}
            />
          </g>
        ))}
        {line && (
          <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} className="rolling" />
        )}
      </svg>
      {sel !== null && hit && (
        <Tip
          x={cx(sel)}
          width={w}
          title={dayText(sel)}
          rows={
            hit.v === null
              ? [{ key: "none", name: "No data", value: "—" }]
              : [
                  { key: "bar", name: barName, value: format(hit.v) },
                  ...(rolling?.[sel] != null
                    ? [
                        {
                          key: "roll",
                          name: rollingName ?? "Rolling",
                          color: "var(--accent)",
                          value: format(rolling[sel] as number),
                        },
                      ]
                    : []),
                ]
          }
        />
      )}
    </div>
  );
}
