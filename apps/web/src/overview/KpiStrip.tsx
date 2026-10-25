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
const change = (series: (number | null)[] | undefined, format = kTokens): string => {
  if (!series || series.length < 2 || series[0] == null || series.at(-1) == null) return "—";
  const delta = (series.at(-1) ?? 0) - (series[0] ?? 0);
  return `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${format(Math.abs(delta))} · 30m`;
};

/** Live Overview KPIs, scoped by the header's session filter. */
export function KpiStrip() {
  const [session] = useSession();
  const { data: summary, error } = useResource<OverviewSummary>(RESOURCES.overview(session));
  const pending = !summary && !error;
  const k = summary?.kpis;
  const tiles = [
    {
      label: "Agents working",
      page: "agent",
      value: value(k?.working?.now),
      delta:
        k?.working?.series !== undefined
          ? change(k.working.series)
          : k?.working?.of != null
            ? `of ${k.working.of} agents`
            : "—",
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
      delta: change(k?.spendToday?.series, (n) => `$${n.toFixed(2)}`),
      series: k?.spendToday?.series,
      color: "var(--think)",
      history: "last 30 minutes",
    },
    {
      label: "In flight",
      page: "board",
      value: value(k?.inFlight?.count),
      delta:
        k?.inFlight?.series !== undefined
          ? change(k.inFlight.series)
          : k?.inFlight?.oldestAt == null
            ? "—"
            : `${duration((summary?.at ?? Date.now()) - k.inFlight.oldestAt)} oldest`,
      series: k?.inFlight?.series,
      history: "last 30 minutes",
      color: "var(--accent)",
    },
    {
      label: "Merged today",
      page: "board",
      value: value(k?.mergedToday?.count),
      delta: change(k?.mergedToday?.series),
      series: k?.mergedToday?.series,
      color: "var(--ok)",
      history: "last 30 minutes",
    },
    {
      label: "CI pass rate",
      page: "board",
      value: k?.ciPassRate24h?.pct == null ? "—" : `${Math.round(k.ciPassRate24h.pct)}%`,
      delta:
        k?.ciPassRate24h?.series !== undefined
          ? change(k.ciPassRate24h.series, (n) => `${kTokens(n)} pp`)
          : k?.ciPassRate24h?.runs != null
            ? `${k.ciPassRate24h.runs} runs · ${k.ciPassRate24h.redNow} red now`
            : "—",
      series: k?.ciPassRate24h?.series,
      history: "last 30 minutes",
      color: "var(--crit)",
    },
    {
      label: "Cycle time",
      page: "board",
      value: duration(k?.cycleTime?.medianMs),
      delta:
        k?.cycleTime?.series !== undefined
          ? change(k.cycleTime.series, duration)
          : k?.cycleTime?.n == null
            ? "—"
            : `n=${k.cycleTime.n} · ${duration(k.cycleTime.avg14dMs)} avg (14d)`,
      series: k?.cycleTime?.series,
      history: "last 30 minutes",
      color: "var(--think)",
    },
    {
      label: "Needs you",
      page: "comms",
      value: value(k?.needsYou?.count),
      delta:
        k?.needsYou?.series !== undefined
          ? change(k.needsYou.series)
          : k?.needsYou?.overHour != null
            ? `${k.needsYou.overHour} over 1 h`
            : "—",
      series: k?.needsYou?.series,
      history: "last 30 minutes",
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
      <section className="overview-kpis" aria-label="Overview metrics" aria-busy={pending}>
        {tiles.map((tile) => {
          const path = PAGE_PATHS[tile.page];
          const series = tile.series;
          const contextOnly =
            series === undefined &&
            ["In flight", "CI pass rate", "Cycle time", "Needs you"].includes(tile.label);
          return (
            <a
              className="overview-kpi"
              key={tile.label}
              href={path}
              onClick={(e) => followLink(e, path)}
            >
              <span className="lbl" title={tile.label}>
                {tile.label}
              </span>
              <span className="v num">
                {pending ? <span className="kpi-skeleton" aria-hidden="true" /> : tile.value}
              </span>
              {!contextOnly && (
                <span className="d num" title={pending ? undefined : tile.delta}>
                  {pending ? null : tile.delta}
                </span>
              )}
              {series && series.length >= 2 ? (
                <Sparkline
                  values={series}
                  color={tile.color}
                  label={`${tile.label} · ${tile.history}`}
                />
              ) : (
                <span className="kpi-secondary num" title="History unavailable">
                  {pending ? null : contextOnly ? tile.delta : "—"}
                </span>
              )}
            </a>
          );
        })}
      </section>
    </>
  );
}
