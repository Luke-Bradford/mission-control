const W = 56;
const H = 18;

/**
 * A 56×18 line over `values` (oldest first) in `color`, with a dot on the newest; the mockup's
 * `spark`. Renders nothing for fewer than two points.
 */
export function Sparkline({ values, color }: { values: number[]; color: string }) {
  const n = values.length;
  if (n < 2) return null;
  const max = Math.max(1, ...values);
  const x = (i: number): number => (i / (n - 1)) * (W - 4);
  const y = (v: number): number => H - 2 - (v / max) * (H - 5);
  const line = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join("");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="tokens per minute">
      <path d={`${line}L${W - 4},${H}L0,${H}Z`} fill={color} fillOpacity={0.18} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={W - 4} cy={y(values[n - 1] ?? 0)} r={2.2} fill={color} />
    </svg>
  );
}
