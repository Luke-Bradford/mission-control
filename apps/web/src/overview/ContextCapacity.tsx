// biome-ignore-all lint/a11y/useSemanticElements: this cell belongs to the existing ARIA grid-table roster.
import type { CrewRow } from "@mc/core";
import { kTokens, percent } from "../fmt.ts";
import { meterLevel } from "../hud/Meter.tsx";

/** Last reported context, distinct from throughput and the provider's account allowance. */
export function contextCapacity(row: CrewRow | null) {
  const used = row?.digest?.contextTokens ?? null;
  const window = row?.contextWindow ?? null;
  const known = used !== null && window !== null && window > 0;
  return {
    used,
    window: window !== null && window > 0 ? window : null,
    remaining: known ? Math.max(0, window - used) : null,
    over: known ? Math.max(0, used - window) : null,
    pct: known ? (100 * used) / window : null,
  };
}

export function ContextCapacity({ row }: { row: CrewRow | null }) {
  const value = contextCapacity(row);
  const used = value.used === null ? "—" : kTokens(value.used);
  const window = value.window === null ? "—" : kTokens(value.window);
  const left =
    value.remaining === null
      ? value.window === null
        ? "limit unknown"
        : "remaining unknown"
      : value.over
        ? `${kTokens(value.over)} over`
        : `${kTokens(value.remaining)} left`;
  return (
    <span
      role="cell"
      className={`context-capacity num${meterLevel(value.pct)}`}
      title={`Last reported context: ${value.used ?? "unknown"} used / ${value.window ?? "unknown"} window tokens · ${value.remaining ?? "unknown"} remaining · ${percent(value.pct)} used. Not provider allowance or token rate.`}
    >
      <span>
        {used} / {window} · {left}
        {value.pct === null ? "" : ` · ${percent(value.pct)}`}
      </span>
      <span className="context-track" aria-hidden="true">
        {value.pct !== null && <i style={{ width: `${Math.min(100, Math.max(0, value.pct))}%` }} />}
      </span>
    </span>
  );
}
