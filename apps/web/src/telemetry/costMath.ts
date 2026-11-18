import type { AgentId, AgentSeries, Telemetry } from "@mc/core";

export interface TokenLayer {
  id: string;
  name: string;
  values: number[];
}

/** The id of the layer that sums every seat outside the top few. */
export const OTHER_LAYER = "other";

const sumOf = (xs: number[]): number => xs.reduce((a, x) => a + x, 0);

/**
 * The busiest `top` seats by tokens over the series, busiest first, then Other: the rest summed at
 * each point. The layers add up to the total at every point (no Other layer when no seat is left).
 */
export function stackTokens(rows: AgentSeries[], top = 3): TokenLayer[] {
  const ranked = [...rows].sort((a, b) => sumOf(b.points) - sumOf(a.points));
  const layers: TokenLayer[] = ranked
    .slice(0, top)
    .map((r) => ({ id: r.agentId, name: r.agentId, values: r.points }));
  const rest = ranked.slice(top);
  if (rest.length > 0) {
    const n = Math.max(...rest.map((r) => r.points.length));
    layers.push({
      id: OTHER_LAYER,
      name: "Other",
      values: Array.from({ length: n }, (_, i) => sumOf(rest.map((r) => r.points[i] ?? 0))),
    });
  }
  return layers;
}

/** Share of input served from cache, today; null with no input at all. */
export function cacheHitPct(today: { tokens: number; cacheRead: number }): number | null {
  const input = today.tokens + today.cacheRead;
  return input > 0 ? (today.cacheRead / input) * 100 : null;
}

/** Mean full cost of the merged tickets that carry one; null when none does. */
export function costPerMergedTicket(rows: Telemetry["tokensByTicket"]): number | null {
  const costs = rows.flatMap((r) => (r.totalCostUsd == null ? [] : [r.totalCostUsd]));
  return costs.length > 0 ? sumOf(costs) / costs.length : null;
}

export interface Coverage {
  /** % of usage rows that reported a cost; null with no rows. */
  costPct: number | null;
  tokensPct: number | null;
  /** The seat (and model) of each row that reported none. */
  missingCost: string[];
  missingTokens: string[];
}

const rowName = (r: { agentId: AgentId; model: string | null }): string =>
  r.model ? `${r.agentId} on ${r.model}` : r.agentId;

/** What the usage rows (seat and model) did and did not report. The server sends no per-run counts. */
export function costCoverage(totals: Telemetry["totals"]): Coverage {
  const noCost = totals.filter((r) => r.costUsd === null);
  const noTokens = totals.filter((r) => r.input + r.output === 0);
  const pct = (missing: number) =>
    totals.length === 0 ? null : ((totals.length - missing) / totals.length) * 100;
  return {
    costPct: pct(noCost.length),
    tokensPct: pct(noTokens.length),
    missingCost: noCost.map(rowName),
    missingTokens: noTokens.map(rowName),
  };
}
