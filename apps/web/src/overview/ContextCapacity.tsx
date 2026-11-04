// biome-ignore-all lint/a11y/useSemanticElements: these cells belong to the existing ARIA grid-table roster.
import type { CrewRow } from "@mc/core";
import { kTokens, percent } from "../fmt.ts";
import { meterLevel } from "../hud/Meter.tsx";

const DASH = "—";

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

/** Context as number columns: used and limit where the table has room, and always the percent. */
export function ContextCapacity({ row }: { row: CrewRow | null }) {
  const value = contextCapacity(row);
  const used = value.used === null ? DASH : kTokens(value.used);
  const limit = value.window === null ? DASH : kTokens(value.window);
  const left =
    value.remaining === null
      ? value.window === null
        ? "limit unknown"
        : "remaining unknown"
      : value.over
        ? `${kTokens(value.over)} over`
        : `${kTokens(value.remaining)} left`;
  const title = `Last reported context: ${used} used of ${limit} · ${left}`;
  return (
    <>
      <span role="cell" className="num xs crew-wide" title={title}>
        {used}
      </span>
      <span role="cell" className="num xs muted crew-wide" title={title}>
        {limit}
      </span>
      <span role="cell" className={`num xs context-pct${meterLevel(value.pct)}`} title={title}>
        {value.pct === null ? DASH : percent(value.pct)}
      </span>
    </>
  );
}
