/**
 * What the hand-written SVG charts share: the measured width (so 11 px text stays 11 px at any
 * size), the pointer's x in chart units, and the tooltip. CSP forbids `style="…"` strings, so sizes
 * are SVG attributes and the tooltip's position is a React style prop.
 */
import {
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import "./Hover.css";

/** A timestamp shared by time charts inside one operator workspace. */
const ChartCursor = createContext<{
  at: number | null;
  setAt: (at: number | null) => void;
} | null>(null);

/** Synchronises hover/focus crosshairs without making charts outside this workspace stateful. */
export function ChartCursorProvider({ children }: { children: ReactNode }) {
  const [at, setAt] = useState<number | null>(null);
  return <ChartCursor.Provider value={{ at, setAt }}>{children}</ChartCursor.Provider>;
}

export function useChartCursor() {
  return useContext(ChartCursor);
}

/** The plot's left edge (room for the y labels), right inset, top and bottom (x labels). */
export const PAD = { l: 38, r: 4, t: 6, b: 18 } as const;

/**
 * The host's width in px, followed while it resizes; `fallback` until it is measured and wherever
 * there is no layout (tests).
 */
export function useChartWidth(fallback: number): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const px = Math.round(el.getBoundingClientRect().width);
      if (px > 0) setW(px);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * The pointer's x in the SVG's own units. The viewBox is the measured width, so this is px from the
 * SVG's left edge; with no layout (width 0) the client x is taken as is.
 */
export function pointerX(e: PointerEvent<SVGElement>, w: number): number {
  const svg = e.currentTarget.ownerSVGElement ?? e.currentTarget;
  const r = svg.getBoundingClientRect();
  return r.width > 0 ? ((e.clientX - r.left) / r.width) * w : e.clientX;
}

/** Nearest index of `n` points evenly spread over [x0, x1]. */
export function nearestIndex(x: number, n: number, x0: number, x1: number): number {
  if (n <= 1) return 0;
  return Math.max(0, Math.min(n - 1, Math.round(((x - x0) / (x1 - x0)) * (n - 1))));
}

/**
 * The keyboard's way to the crosshair, for the chart's SVG: it takes focus (Tab), focus shows the
 * newest point, ←/→ step one point, Home/End jump to the ends, and leaving hides it again. `index`
 * is the point shown (null: none) out of `n`.
 */
export function keyStep(n: number, index: number | null, set: (i: number | null) => void) {
  const last = n - 1;
  return {
    tabIndex: 0,
    onFocus: () => set(n > 0 ? last : null),
    onBlur: () => set(null),
    onKeyDown: (e: KeyboardEvent<SVGSVGElement>) => {
      if (n === 0) return;
      const at = index ?? last;
      const to =
        e.key === "ArrowLeft"
          ? at - 1
          : e.key === "ArrowRight"
            ? at + 1
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? last
                : null;
      if (to === null) return;
      e.preventDefault();
      set(Math.max(0, Math.min(last, to)));
    },
  };
}

export interface TipRow {
  key: string;
  name: string;
  value: string;
  color?: string;
}

/**
 * The hover readout: a muted heading, then one row per series (a colour key, its name, the value).
 * Placed beside the pointer `x` (px in the host), flipped to the left past the middle.
 */
export function Tip({
  x,
  width,
  title,
  rows = [],
}: {
  x: number;
  width: number;
  title: string;
  rows?: TipRow[];
}) {
  const style: CSSProperties =
    x > width / 2 ? { right: Math.max(0, width - x + 12) } : { left: x + 12 };
  return (
    <div className="tip" style={style} aria-live="polite" aria-atomic="true">
      <div className="xs muted">{title}</div>
      {rows.map((r) => (
        <div className="tr" key={r.key}>
          {r.color && <i style={{ background: r.color }} />}
          {r.name}
          <b>{r.value}</b>
        </div>
      ))}
    </div>
  );
}

/** Grid lines at 0, 50 and 100 % of `max`, each with its label at the left. */
export function Grid({
  max,
  ticks = [0, max / 2, max],
  y,
  x0,
  x1,
  label,
}: {
  max: number;
  /** Values to draw, default 0, 50 and 100 % of `max`. */
  ticks?: number[];
  y: (v: number) => number;
  x0: number;
  x1: number;
  label: (v: number) => string;
}) {
  return (
    <>
      {ticks.map((v) => {
        const yy = y(v);
        return (
          <g key={v}>
            <line className="gl" x1={x0} x2={x1} y1={yy} y2={yy} />
            <text className="ct" x={x0 - 6} y={yy + 4} textAnchor="end">
              {label(v)}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** A colour key and a name per series, below a chart. */
export function Legend({ items }: { items: { key: string; name: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.key}>
          <i style={{ background: it.color }} />
          {it.name}
        </span>
      ))}
    </div>
  );
}

/** An id prefix safe inside `url(#…)` for a chart's gradients. */
export function useGradientId(): string {
  return `g${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/**
 * A vertical gradient for a trace's fill: `color` at `opacity` at the top, fading to transparent.
 * `box` fits it to each filled shape (stacked layers); otherwise it spans y1..y2 of the plot.
 */
export function FadeGradient({
  id,
  color,
  opacity = 0.28,
  box,
}: {
  id: string;
  color: string;
  opacity?: number;
  box?: { y1: number; y2: number };
}) {
  return (
    <linearGradient
      id={id}
      x1={0}
      x2={0}
      {...(box ? { gradientUnits: "userSpaceOnUse", y1: box.y1, y2: box.y2 } : { y1: 0, y2: 1 })}
    >
      <stop offset="0" stopColor={color} stopOpacity={opacity} />
      <stop offset="1" stopColor={color} stopOpacity={0} />
    </linearGradient>
  );
}

/** The x axis: a solid baseline from x0 to x1 at `y`, with a short tick at each of `at` (px). */
export function XAxis({ y, x0, x1, at }: { y: number; x0: number; x1: number; at: number[] }) {
  return (
    <g className="xaxis">
      <line x1={x0} x2={x1} y1={y} y2={y} />
      {at.map((x) => (
        <line key={x} x1={x} x2={x} y1={y} y2={y + 4} />
      ))}
    </g>
  );
}

/** Evenly spaced positions from x0 to x1 inclusive, `parts` intervals. */
export function spread(x0: number, x1: number, parts: number): number[] {
  return Array.from({ length: parts + 1 }, (_, i) => x0 + (i / parts) * (x1 - x0));
}

/** The "now" cursor: a thin accent line at `x`, pulsing (motion allowing) while `live`. */
export function NowCursor({
  x,
  y1,
  y2,
  live = false,
}: {
  x: number;
  y1: number;
  y2: number;
  live?: boolean;
}) {
  return <line className={`nowc${live ? " live" : ""}`} x1={x} x2={x} y1={y1} y2={y2} />;
}
