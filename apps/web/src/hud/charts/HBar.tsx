import type { ReactNode } from "react";

/**
 * One horizontal bar row (the mockup's `.hrow`): a label, a track filled to `pct`, the value and a
 * muted extra. Magnitude in one hue; the numbers carry the values.
 */
export function HBar({
  label,
  pct,
  value,
  extra,
  title,
}: {
  label: ReactNode;
  pct: number;
  value: ReactNode;
  extra?: ReactNode;
  title?: string;
}) {
  const width = `${Math.max(0, Math.min(100, pct))}%`;
  return (
    <div className="hrow" title={title}>
      <span className="ellip">{label}</span>
      <span className="track">
        <i style={{ width }} />
      </span>
      <span className="num s">{value}</span>
      <span className="xs muted num">{extra}</span>
    </div>
  );
}
