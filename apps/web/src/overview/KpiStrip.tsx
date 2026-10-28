import type { MetricId, OverviewSummary } from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";
import { kTokens } from "../fmt.ts";
import { quietSeries, Sparkline } from "../hud/Sparkline.tsx";
import { metricText, useMetrics } from "../metrics.ts";
import { followLink, PAGE_PATHS } from "../router.ts";
import { useSession } from "../shell/session.ts";

const duration = (ms: number | null | undefined): string => {
  if (ms == null) return "—";
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
};
const change = (series: (number | null)[] | undefined, format = kTokens): string => {
  if (!series || series.length < 2 || series[0] == null || series.at(-1) == null) return "—";
  const delta = (series.at(-1) ?? 0) - (series[0] ?? 0);
  return `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${format(Math.abs(delta))} · 30m`;
};

/**
 * A KPI's last 30 minutes on its own scale: the trace, its real peak labelled on the dashed top
 * gridline (the scale itself never drops under 1, so a peak under 1 sits below it), and a -30m … now
 * axis. An all-zero series is the bare baseline and says so.
 */
function KpiTrace({
  values,
  color,
  label,
  format,
  live,
}: {
  values: (number | null)[];
  color: string;
  label: string;
  format: (n: number) => string;
  /** The summary is loaded and its last read succeeded: the now-cursor pulses. */
  live: boolean;
}) {
  const quiet = quietSeries(values);
  const readings = values.filter((v): v is number => v !== null);
  // zeros are no activity; no readings at all (e.g. no completed cycles) is no data
  const empty = readings.length === 0 ? "no data" : "no activity";
  const peak = Math.max(0, ...readings);
  const latest = values.at(-1);
  const aria = quiet
    ? `${label} · ${empty}`
    : `${label} · peak ${format(peak)}${latest == null ? "" : ` · latest ${format(latest)}`}`;
  return (
    <span className="kpi-trace">
      <Sparkline values={values} color={color} label={aria} live={live} top={9} />
      {quiet ? (
        <span className="kpi-quiet" aria-hidden="true">
          {empty}
        </span>
      ) : (
        <span className="kpi-peak num" aria-hidden="true" title="Peak in the last 30 minutes">
          {format(peak)}
        </span>
      )}
      <span className="kpi-axis num" aria-hidden="true">
        <span>-30m</span>
        <span>now</span>
      </span>
    </span>
  );
}

interface Tile {
  /** A registry figure (`METRICS` in @mc/core): its label, hover and value come from there. */
  metric?: MetricId;
  label: string;
  title: string;
  page: keyof typeof PAGE_PATHS;
  value: string;
  pending: boolean;
  delta: string;
  series: (number | null)[] | undefined;
  fmt: (n: number) => string;
  color: string;
  history: string;
}

/** Live Overview KPIs, scoped by the header's session filter. */
export function KpiStrip() {
  const [session] = useSession();
  const { data: summary, error } = useResource<OverviewSummary>(RESOURCES.overview(session));
  const metrics = useMetrics();
  const r = metrics.readings;
  const pending = !summary && !error;
  const k = summary?.kpis;
  const registry = (
    id: MetricId,
    page: Tile["page"],
    rest: Pick<Tile, "delta" | "series" | "fmt"> & Partial<Pick<Tile, "color">>,
  ): Tile => ({
    metric: id,
    ...metricText(id),
    page,
    value: r[id]?.value ?? "—",
    pending: r[id] === null && metrics.error === null,
    color: "var(--accent)",
    history: "last 30 minutes",
    ...rest,
  });
  const oldestAt = metrics.view?.inProgress.oldestAt;
  const tiles: Tile[] = [
    registry("agentsWorking", "agent", {
      delta: r.agentsWorking?.detail ?? "—",
      series: undefined,
      fmt: String,
    }),
    {
      label: "Tokens/min",
      title: "Input and output tokens in the last full minute, crew-wide in the repos in view.",
      page: "telemetry",
      value: k?.tokensPerMin?.now != null ? kTokens(k.tokensPerMin.now) : "—",
      pending,
      delta: change(k?.tokensPerMin?.series),
      series: k?.tokensPerMin?.series,
      fmt: kTokens,
      color: "var(--accent)",
      history: "last 30 minutes",
    },
    registry("cost", "telemetry", {
      delta: change(k?.spendToday?.series, (n) => `$${n.toFixed(2)}`),
      series: k?.spendToday?.series,
      fmt: (n: number) => `$${n.toFixed(2)}`,
    }),
    registry("inProgress", "board", {
      delta:
        k?.inFlight?.series !== undefined
          ? change(k.inFlight.series)
          : oldestAt == null
            ? "—"
            : `${duration((metrics.view?.at ?? Date.now()) - oldestAt)} oldest`,
      series: k?.inFlight?.series,
      fmt: String,
    }),
    registry("merged", "board", { delta: "PRs", series: undefined, fmt: String }),
    {
      label: "CI pass rate",
      title: "CI runs that passed in the last 24 hours, of those that finished.",
      page: "board",
      value: k?.ciPassRate24h?.pct == null ? "—" : `${Math.round(k.ciPassRate24h.pct)}%`,
      pending,
      delta:
        k?.ciPassRate24h?.series !== undefined
          ? change(k.ciPassRate24h.series, (n) => `${kTokens(n)} pp`)
          : k?.ciPassRate24h?.runs != null
            ? `${k.ciPassRate24h.runs} runs · ${k.ciPassRate24h.redNow} red now`
            : "—",
      series: k?.ciPassRate24h?.series,
      fmt: (n: number) => `${Math.round(n)}%`,
      history: "last 30 minutes",
      color: "var(--accent)",
    },
    registry("cycleTime", "telemetry", {
      delta: r.cycleTime?.detail ?? "—",
      series: undefined,
      fmt: String,
    }),
    registry("needsYou", "comms", {
      delta: change(k?.needsYou?.series),
      series: k?.needsYou?.series,
      fmt: String,
      // amber only while something waits on the operator
      color: r.needsYou?.n ? "var(--warn-mark)" : "var(--accent)",
    }),
  ];
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
          // A figure with no history shows its context where the trace would be.
          const contextOnly = series === undefined;
          return (
            <a
              className="overview-kpi"
              key={tile.label}
              href={path}
              onClick={(e) => followLink(e, path)}
            >
              <span className="lbl" title={tile.title}>
                {tile.label}
              </span>
              <span className="v num" data-metric={tile.metric}>
                {tile.pending ? <span className="kpi-skeleton" aria-hidden="true" /> : tile.value}
              </span>
              {!contextOnly && (
                <span className="d num" title={tile.pending ? undefined : tile.delta}>
                  {tile.pending ? null : tile.delta}
                </span>
              )}
              {series && series.length >= 2 ? (
                <KpiTrace
                  values={series}
                  color={tile.color}
                  label={`${tile.label} · ${tile.history}`}
                  format={tile.fmt}
                  live={summary !== undefined && error === null}
                />
              ) : (
                <span
                  className="kpi-secondary num"
                  title={contextOnly ? tile.delta : "History unavailable"}
                >
                  {tile.pending ? null : contextOnly ? tile.delta : "—"}
                </span>
              )}
            </a>
          );
        })}
      </section>
    </>
  );
}
