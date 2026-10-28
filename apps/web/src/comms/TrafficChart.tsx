import { useId } from "react";
import { useTz } from "../clock.ts";
import { hhmm } from "../fmt.ts";

export type TrafficHour = {
  hour: number;
  /** Every message in scope that hour. */
  total: number;
  /** The highlighted subset (with CAPCOM, or sent by the open agent). */
  part: number;
};

const W = 320;
const H = 108;
const PAD_L = 24;
const PAD_R = 10;
const PAD_T = 8;
const PAD_B = 18;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

/** A bucket's start as a clock time in the operator's zone (`—` while the config loads). */
function bucketLabel(at: number, tz: string | null): string {
  return tz === null ? "—" : hhmm(at, tz);
}

/** Two intervals on whole messages: 0 · step · 2·step, with the top at or over the peak. */
export function niceScale(peak: number): number {
  if (peak <= 0) return 2;
  const step = Math.ceil(peak / 2);
  return 2 * (step > 10 ? Math.ceil(step / 5) * 5 : step);
}

/**
 * An hourly traffic instrument: a 1.5px trace over a gradient on a fixed scale, the subset as a
 * thin dashed trace, and a "now" cursor at the right edge, pulsing while `live`. Buckets are labelled
 * by their start in the operator's zone (a half-hour zone starts them at :30). An hour's figures are
 * its tooltip.
 */
export function TrafficChart({
  hours,
  totalLabel,
  partLabel,
  label,
  emptyText,
  live = false,
}: {
  hours: TrafficHour[];
  totalLabel: string;
  partLabel: string;
  label: string;
  emptyText: string;
  /** The traffic is loaded and its last read succeeded. */
  live?: boolean;
}) {
  const gradient = useId();
  const tz = useTz();
  const peak = Math.max(0, ...hours.map((hour) => hour.total));
  const top = niceScale(peak);
  const band = PLOT_W / Math.max(1, hours.length);
  const y = (value: number) => PAD_T + PLOT_H * (1 - value / top);
  const base = PAD_T + PLOT_H;
  // Hourly buckets are drawn as steps: each hour's count holds across its own band.
  const line = (pick: (hour: TrafficHour) => number) =>
    hours
      .map((hour, index) => {
        const level = y(pick(hour)).toFixed(1);
        const left = (PAD_L + band * index).toFixed(1);
        const right = (PAD_L + band * (index + 1)).toFixed(1);
        return `${index === 0 ? `M${left} ${level}` : `V${level}`} H${right}`;
      })
      .join(" ");
  const empty = peak === 0;
  const totalLine = line((hour) => hour.total);
  const area = `${totalLine} V${base} H${PAD_L} Z`;
  const ticks = [top, top / 2, 0];
  const marks = [0, Math.floor(hours.length / 2)].filter((index) => index < hours.length);
  return (
    <figure className={`comms-chart${empty ? " empty" : ""}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.32" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick} className={`comms-chart-grid${tick === 0 ? " base" : ""}`}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(tick)} y2={y(tick)} />
            {!empty || tick === 0 ? (
              <text x={PAD_L - 5} y={y(tick)} dy="0.32em" textAnchor="end">
                {tick}
              </text>
            ) : null}
          </g>
        ))}
        {marks.map((index) => (
          <text
            key={index}
            className="comms-chart-tick"
            x={PAD_L + band * index}
            y={H - 4}
            textAnchor="start"
          >
            {bucketLabel(hours[index]?.hour ?? Date.now(), tz)}
          </text>
        ))}
        <text className="comms-chart-tick" x={W - PAD_R} y={H - 4} textAnchor="end">
          now
        </text>
        {!empty && (
          <>
            <path className="comms-chart-area" d={area} fill={`url(#${gradient})`} />
            <path className="comms-chart-part" d={line((hour) => hour.part)} />
            <path className="comms-chart-trace" d={totalLine} />
          </>
        )}
        <line
          className={`comms-chart-now${live ? " live" : ""}`}
          x1={W - PAD_R}
          x2={W - PAD_R}
          y1={PAD_T - 2}
          y2={base}
        />
        {hours.map((hour, index) => (
          <rect
            key={hour.hour}
            className="comms-hour"
            x={PAD_L + band * index}
            y={PAD_T}
            width={band}
            height={PLOT_H}
          >
            <title>{`${bucketLabel(hour.hour, tz)} · ${hour.total} messages · ${hour.part} ${partLabel.toLowerCase()}`}</title>
          </rect>
        ))}
      </svg>
      {empty ? (
        <figcaption className="comms-chart-empty">{emptyText}</figcaption>
      ) : (
        <figcaption className="comms-chart-legend">
          <span className="total">
            <i aria-hidden="true" />
            {totalLabel}
          </span>
          <span className="part">
            <i aria-hidden="true" />
            {partLabel}
          </span>
          <span className="unit">msg / h</span>
        </figcaption>
      )}
    </figure>
  );
}
