import { type LimitRow, TELEMETRY_RANGES, type Telemetry } from "@mc/core";
import { useSecond } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { minutesAgo, percent } from "../fmt.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Legend } from "../hud/charts/Hover.tsx";
import { LineChart, type LineSeries } from "../hud/charts/LineChart.tsx";
import { QuotaPanel } from "../overview/QuotaPanel.tsx";
import "../overview/overview.css";
import { chartAnnotations } from "./annotations.ts";
import { DASH, type Scope } from "./common.ts";
import { TPanel as Panel, useShows } from "./TPanel.tsx";

const MINUTE_MS = 60_000;

/** Capacity (catalogue 2.6.5): quota per account window. The machine's load and the test lock are on the Machine tab. */
export function CapacityGroup({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const showQuota = useShows("quotaP");
  const now = useSecond();
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data ?? [];
  const from = now - TELEMETRY_RANGES[scope.range] * MINUTE_MS;
  const chart = {
    from,
    to: now,
    xLabels: [`-${scope.range}`, "now"] as [string, string],
    at: (ms: number) => minutesAgo((now - ms) / MINUTE_MS),
    // the window ends now and slides every second, while the telemetry under it is fresh
    live: scope.live,
  };

  // New telemetry carries explicit provider reset observations. Legacy rows remain readable, but
  // never manufacture a reset from a falling percentage.
  const quotaRows =
    t?.series?.quota ?? (t?.quota ?? []).map((row) => ({ ...row, resets: [] as const }));
  // A window keeps its colour whichever account is picked: its place among all the windows.
  const quota = quotaRows
    .map((q, i) => ({ q, color: agentColor(i) }))
    .filter(({ q }) => scope.account === "" || q.accountId === scope.account);
  const quotaLines: LineSeries[] = quota.map(({ q, color }) => ({
    id: `${q.accountId}:${q.window}`,
    name: `${q.accountId} ${q.window}`,
    color,
    points: q.points.flatMap((point, index) => {
      const previous = q.points[index - 1];
      const reset = q.resets.some((event) => event.at === point.at);
      // Both an observed reset and an unexplained fall break continuity; only the former is named.
      return reset || (previous && point.pct < previous.pct)
        ? [
            { at: point.at, v: null },
            { at: point.at, v: point.pct },
          ]
        : [{ at: point.at, v: point.pct }];
    }),
  }));
  // Only the provider's explicit reset record earns a reset annotation.
  const quotaResets = quota.flatMap(({ q }) =>
    q.resets.map((reset) => ({ at: reset.at, label: `${q.accountId} ${q.window} reset` })),
  );
  const quotaLegend = quota.map(({ q, color }) => {
    const latest = q.points.at(-1);
    return {
      key: `${q.accountId}:${q.window}`,
      name: `${q.accountId} ${q.window} · ${latest ? percent(latest.pct) : DASH}`,
      color,
    };
  });
  const quotaGuides = quota.flatMap(({ q }) => {
    const row = limits.find(
      (limit) => limit.accountId === q.accountId && limit.window === q.window,
    );
    return row
      ? [
          {
            value: row.alertAt,
            label: `${q.accountId} alert ${percent(row.alertAt)}`,
            color: "var(--warn)",
          },
          {
            value: row.stopAt,
            label: `${q.accountId} stop ${percent(row.stopAt)}`,
            color: "var(--crit)",
          },
        ]
      : [];
  });
  const quotaForecastLines: LineSeries[] = quota.flatMap(({ q, color }) => {
    const row = limits.find(
      (limit) => limit.accountId === q.accountId && limit.window === q.window,
    );
    const last = q.points.at(-1);
    // Only the server's 7d projection is used: no client-side pace is invented.
    return row?.window === "7d" && last && row.projected !== null
      ? [
          {
            id: `${q.accountId}:${q.window}:forecast`,
            name: `${q.accountId} ${q.window} projected`,
            color,
            dash: "4 3",
            points: [
              { at: last.at, v: last.pct },
              { at: row.resetAt, v: row.projected },
            ],
          },
        ]
      : [];
  });
  const quotaResetEvents = [
    ...quotaResets,
    ...quota.flatMap(({ q }) => {
      const row = limits.find(
        (limit) => limit.accountId === q.accountId && limit.window === q.window,
      );
      return row
        ? [
            { at: row.resetAt, label: `${q.accountId} ${q.window} reset` },
            ...(row.stopForecast === null
              ? []
              : [{ at: row.stopForecast, label: `${q.accountId} ${q.window} stop forecast` }]),
            ...(row.fullAt === null
              ? []
              : [{ at: row.fullAt, label: `${q.accountId} ${q.window} full forecast` }]),
          ]
        : [];
    }),
    ...chartAnnotations(t?.series?.annotations ?? []),
  ];
  const quotaTo = Math.max(now, ...limits.map((row) => row.resetAt));
  const quotaChart = {
    ...chart,
    to: quotaTo,
    xLabels: [`-${scope.range}`, quotaTo === now ? "now" : "reset"] as [string, string],
    live: quotaTo === now && scope.live,
  };
  return (
    <div className="tgrid">
      {/* The complete readers the Overview summarises in its Tokens panel and Mac row. */}
      {showQuota && <QuotaPanel />}
      <Panel id="tQuota" title="Quota used" sub="each account window, 100% is the limit">
        {!t ? (
          <p className="pb s muted">{scope.wait}</p>
        ) : quotaLines.length === 0 ? (
          <p className="pb s muted">No quota readings in the last {scope.range}.</p>
        ) : (
          <div className="pb">
            <LineChart
              series={[...quotaLines, ...quotaForecastLines]}
              max={110}
              ticks={[0, 50, 100]}
              limit
              annotations={quotaResetEvents}
              guides={quotaGuides}
              label="Quota used"
              {...quotaChart}
            />
            <Legend items={quotaLegend} />
          </div>
        )}
      </Panel>
    </div>
  );
}
