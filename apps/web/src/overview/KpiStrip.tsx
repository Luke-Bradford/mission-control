import type { OverviewSummary } from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";
import { kTokens } from "../fmt.ts";
import { Sparkline } from "../hud/Sparkline.tsx";
import { followLink, PAGE_PATHS } from "../router.ts";
import { useSession } from "../shell/session.ts";

const duration = (ms: number | null | undefined): string => {
  if (ms == null) return "—";
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
};
const value = (n: number | undefined): string => (n === undefined ? "—" : String(n));
const change = (series: number[] | undefined): string => {
  if (!series || series.length < 2) return "—";
  const delta = (series.at(-1) ?? 0) - (series[0] ?? 0);
  return `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${kTokens(Math.abs(delta))} · 30m`;
};

/** Live Overview KPIs, scoped by the header's session filter. */
export function KpiStrip() {
  const [session] = useSession();
  const { data: summary, error } = useResource<OverviewSummary>(RESOURCES.overview(session));
  const k = summary?.kpis;
  const tiles = [
    {
      label: "Agents working",
      page: "agent",
      value: value(k?.working?.now),
      delta: k?.working?.of != null ? `of ${k.working.of} agents` : "—",
      series: k?.working?.series,
      color: "var(--ok)",
      history: "last 30 minutes",
    },
    {
      label: "Tokens/min",
      page: "telemetry",
      value: k?.tokensPerMin?.now != null ? kTokens(k.tokensPerMin.now) : "—",
      delta: change(k?.tokensPerMin?.series),
      series: k?.tokensPerMin?.series,
      color: "var(--accent)",
      history: "last 30 minutes",
    },
    {
      label: "Spend today",
      page: "telemetry",
      value: k?.spendToday?.usd != null ? `$${k.spendToday.usd.toFixed(2)}` : "—",
      delta: k?.spendToday?.perHour?.length
        ? `$${(k.spendToday.perHour.at(-1) ?? 0).toFixed(2)} this hour`
        : "—",
      series: k?.spendToday?.perHour,
      color: "var(--think)",
      history: "hourly today",
    },
    {
      label: "In flight",
      page: "board",
      value: value(k?.inFlight?.count),
      delta:
        k?.inFlight?.oldestAt == null
          ? "—"
          : `${duration((summary?.at ?? Date.now()) - k.inFlight.oldestAt)} oldest`,
      color: "var(--accent)",
    },
    {
      label: "Merged today",
      page: "board",
      value: value(k?.mergedToday?.count),
      delta: k?.mergedToday?.perHour?.length ? `${k.mergedToday.perHour.at(-1)} this hour` : "—",
      series: k?.mergedToday?.perHour,
      color: "var(--ok)",
      history: "hourly today",
    },
    {
      label: "CI pass rate",
      page: "board",
      value: k?.ciPassRate24h?.pct == null ? "—" : `${Math.round(k.ciPassRate24h.pct)}%`,
      delta: k?.ciPassRate24h?.redNow != null ? `${k.ciPassRate24h.redNow} red now` : "—",
      color: "var(--crit)",
    },
    {
      label: "Cycle time",
      page: "board",
      value: duration(k?.cycleTime?.medianMs),
      delta:
        k?.cycleTime?.avg14dMs == null ? "—" : `${duration(k.cycleTime.avg14dMs)} · 14d average`,
      color: "var(--think)",
    },
    {
      label: "Needs you",
      page: "comms",
      value: value(k?.needsYou?.count),
      delta: k?.needsYou?.overHour != null ? `${k.needsYou.overHour} over an hour` : "—",
      color: "var(--warn)",
    },
  ] as const;
  return (
    <>
      {error && (
        <div className="pb crit-t" role="alert">
          {summary
            ? `Last updated ${new Date(summary.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · refresh failed. Showing stale values.`
            : "Could not load overview metrics."}
        </div>
      )}
      <section className="overview-kpis" aria-label="Overview metrics">
        {tiles.map((tile) => {
          const path = PAGE_PATHS[tile.page];
          const series = "series" in tile ? tile.series : undefined;
          return (
            <a
              className="overview-kpi"
              key={tile.label}
              href={path}
              onClick={(e) => followLink(e, path)}
            >
              <span className="lbl">{tile.label}</span>
              <span className="v num">{tile.value}</span>
              <span className="d num">{tile.delta}</span>
              {series && series.length >= 2 ? (
                <Sparkline
                  values={series}
                  color={tile.color}
                  label={`${tile.label} · ${"history" in tile ? tile.history : ""}`}
                />
              ) : (
                <span className="kpi-no-trend" title="History unavailable">
                  —
                </span>
              )}
            </a>
          );
        })}
      </section>
    </>
  );
}
