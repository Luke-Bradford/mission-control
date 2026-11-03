import { type MetricId, type OverviewSummary, usd } from "@mc/core";
import { useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { elapsed, hhmm, kTokens, percent, plural } from "../fmt.ts";
import { MetricName } from "../hud/MetricName.tsx";
import { quietSeries, Sparkline } from "../hud/Sparkline.tsx";
import { metricText, metricTitle, useMetrics } from "../metrics.ts";
import { followLink, NEEDS_YOU_PATH, PAGE_PATHS } from "../router.ts";
import { useSession } from "../shell/session.ts";

/** A tile's change over its 30 minutes: one sign, and `±` when it rounds to nothing. */
export const change = (
  series: (number | null)[] | undefined,
  format = kTokens,
  decimals = 0,
): string => {
  if (!series || series.length < 2 || series[0] == null || series.at(-1) == null) return "—";
  const scale = 10 ** decimals;
  const delta = Math.round(((series.at(-1) ?? 0) - (series[0] ?? 0)) * scale) / scale;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  return `${sign}${format(Math.abs(delta))} · 30m`;
};

/** A change in dollars: the sign leads, so no `~` between it and the figure. */
export const dollars = (n: number): string => `$${n.toFixed(2)}`;
/** A change in percentage points. */
export const points = (n: number): string => `${Math.round(n)} pp`;

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
  const empty = readings.length === 0 ? "history not collected" : "no activity";
  const peak = Math.max(0, ...readings);
  const latest = values.at(-1);
  const aria = quiet
    ? `${label} · ${empty}`
    : `${label} · peak ${format(peak)}${latest == null ? "" : ` · latest ${format(latest)}`}`;
  return (
    <span className="kpi-trace">
      {readings.length > 0 && <Sparkline values={values} color={color} label={aria} live={live} />}
      {quiet ? (
        <span className="kpi-quiet" aria-hidden="true">
          {empty}
        </span>
      ) : (
        <span className="kpi-peak sr-only" aria-hidden="true" title="Peak in the last 30 minutes">
          {format(peak)}
        </span>
      )}
    </span>
  );
}

interface Tile {
  /** A registry figure (`METRICS` in @mc/core): its label, hover and value come from there. */
  metric?: MetricId;
  label: string;
  title: string;
  page: keyof typeof PAGE_PATHS;
  /** A link more exact than the page's root (Needs you's panel). */
  to?: string;
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
  const tz = useTz();
  const [session] = useSession();
  const { data: summary, error } = useResource<OverviewSummary>(RESOURCES.overview(session));
  const metrics = useMetrics();
  const r = metrics.readings;
  const pending = !summary && !error;
  const k = summary?.kpis;
  const registry = (
    id: MetricId,
    page: Tile["page"],
    rest: Pick<Tile, "delta" | "series" | "fmt"> & Partial<Pick<Tile, "color" | "to">>,
  ): Tile => ({
    metric: id,
    label: metricText(id).label,
    title: metricTitle(metrics, id),
    page,
    value: r[id]?.value ?? "—",
    pending: metrics.state(id) === "loading",
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
      label: "Tokens/min · 1m",
      title:
        "Input and output tokens in the last full minute, crew-wide in the repos in view. Unit: tokens per minute. History: last 30 complete minutes.",
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
      delta: change(k?.spendToday?.series, dollars, 2),
      series: k?.spendToday?.series,
      fmt: usd,
    }),
    registry("inProgress", "board", {
      delta:
        k?.inFlight?.series !== undefined
          ? change(k.inFlight.series)
          : oldestAt == null
            ? "—"
            : `${elapsed((metrics.view?.at ?? Date.now()) - oldestAt)} oldest`,
      series: k?.inFlight?.series,
      fmt: String,
    }),
    registry("merged", "board", {
      delta: r.merged?.detail ? `PRs · ${r.merged.detail}` : "PRs",
      series: undefined,
      fmt: String,
    }),
    {
      label: "CI pass rate · 24h",
      title:
        "CI runs that passed in the last 24 hours, of those that finished. Unit: percent of completed runs; this is not first-push PR success.",
      page: "board",
      value: percent(k?.ciPassRate24h?.pct),
      pending,
      delta:
        k?.ciPassRate24h?.series !== undefined
          ? change(k.ciPassRate24h.series, points)
          : k?.ciPassRate24h?.runs != null
            ? `${plural(k.ciPassRate24h.runs, "run")} · ${k.ciPassRate24h.redNow} red now`
            : "—",
      series: k?.ciPassRate24h?.series,
      fmt: (n: number) => percent(n),
      history: "last 30 minutes",
      color: "var(--accent)",
    },
    registry("cycleTime", "telemetry", {
      delta: r.cycleTime?.detail ?? "—",
      series: undefined,
      fmt: String,
    }),
    registry("needsYou", "flight", {
      to: NEEDS_YOU_PATH,
      delta: change(k?.needsYou?.series),
      series: k?.needsYou?.series,
      fmt: String,
      // amber only while something waits on the operator
      color: r.needsYou?.n ? "var(--warn-mark)" : "var(--accent)",
    }),
  ];
  return (
    <>
      {(error || metrics.error) && (
        <div className="pb crit-t" role="alert">
          {[
            error &&
              (summary
                ? `Last updated ${tz ? hhmm(summary.at, tz) : "—"} · refresh failed. Showing stale values.`
                : "Could not load overview metrics."),
            // the registry's figures come from /api/metrics: its failure is said too
            metrics.error &&
              (metrics.view
                ? "Registry figures: refresh failed, showing stale values."
                : `Registry figures could not load: ${metrics.error.message}`),
          ]
            .filter(Boolean)
            .join(" ")}
        </div>
      )}
      <section className="overview-kpis" aria-label="Overview metrics" aria-busy={pending}>
        {tiles.map((tile) => {
          const path = tile.to ?? PAGE_PATHS[tile.page];
          const series = tile.series;
          const measuredHistory =
            !!series && series.length >= 2 && series.some((value) => value !== null);
          // A figure with no history shows its context where the trace would be.
          const contextOnly = series === undefined;
          return (
            <a
              className="overview-kpi"
              key={tile.label}
              href={path}
              onClick={(e) => followLink(e, path)}
              title={tile.title}
            >
              <span className="lbl" title={tile.title}>
                {tile.metric ? <MetricName id={tile.metric} /> : tile.label}
              </span>
              <span className="kpi-reading">
                <span
                  className="v num"
                  data-metric={tile.metric}
                  title={tile.metric ? tile.title : undefined}
                >
                  {tile.pending ? <span className="kpi-skeleton" aria-hidden="true" /> : tile.value}
                </span>
                {series && measuredHistory ? (
                  <KpiTrace
                    values={series}
                    color={tile.color}
                    label={`${tile.label} · ${tile.history}`}
                    format={tile.fmt}
                    live={summary !== undefined && error === null}
                  />
                ) : null}
              </span>
              {!contextOnly && measuredHistory ? (
                <span className="d num" title={tile.pending ? undefined : tile.delta}>
                  {tile.pending ? null : tile.delta}
                </span>
              ) : (
                <span
                  className="kpi-secondary num"
                  title={contextOnly ? tile.delta : "History unavailable"}
                >
                  {tile.pending
                    ? "Loading measure…"
                    : contextOnly
                      ? tile.delta === "—"
                        ? "History not collected"
                        : tile.delta
                      : "History not collected"}
                </span>
              )}
            </a>
          );
        })}
      </section>
    </>
  );
}
