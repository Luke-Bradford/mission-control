import {
  type ConfigView,
  type Crew,
  type HealthRow,
  type LimitRow,
  type OverviewTimeline,
  usageCollector,
} from "@mc/core";
import { useNow, useTz } from "../clock.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { hhmm, kTokens, percent } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { metricTitle, useMetrics } from "../metrics.ts";
import { resetWhen } from "../quota.ts";
import { followLink, PAGE_PATHS, setupPath } from "../router.ts";
import { LANE_MINUTES, laneTokens } from "./CrewLane.tsx";

const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;

type WeekRow = Extract<LimitRow, { window: "7d" }>;

/** Whether a reading can be trusted, by the rule the complete allowance table uses. */
const isStale = (row: LimitRow, now: number, failed: boolean) =>
  row.stale || now - row.sampledAt > 60 * 60_000 || failed;

/** The plain-words verdict on the week, by the same rule the hub uses to refuse new runs. */
function paceVerdict(
  row: WeekRow,
  five: LimitRow | undefined,
  now: number,
  tz: string | null,
  stale: boolean,
) {
  if (row.resetAt <= now) return { text: "Reading is from before the last reset", tone: "warn-t" };
  if (row.used >= row.stopAt)
    return { text: "At its stop line · new runs refused", tone: "crit-t" };
  if (five && five.used >= row.stopAt)
    return { text: "5h at its stop line · new runs refused", tone: "crit-t" };
  const last = stale ? "Last reading: " : "";
  if (row.used >= row.alertAt) return { text: `${last}Past its alert line`, tone: "warn-t" };
  if (row.stopForecast !== null && row.stopForecast < row.resetAt)
    return {
      text: `${last}Stops about ${tz ? resetWhen({ ...row, resetAt: row.stopForecast }, now, tz) : "soon"}`,
      tone: "warn-t",
    };
  if (row.projected === null) return { text: `${last}Too few readings to project`, tone: "muted" };
  if (row.projected >= row.alertAt)
    return { text: `${last}Will pass its alert line`, tone: "warn-t" };
  return { text: `${last}On pace`, tone: stale ? "muted" : "ok-t" };
}

/** The week so far against its limits, then where this pace ends by the reset. */
function BurnUp({ row, now, tz }: { row: WeekRow; now: number; tz: string | null }) {
  if (!Number.isFinite(row.resetAt)) return <p className="s muted">Reset time unknown.</p>;
  const start = row.resetAt - WEEK_MS;
  const x = (at: number) => (Math.min(row.resetAt, Math.max(start, at)) - start) / (WEEK_MS / 100);
  const y = (pct: number) => 100 - Math.min(100, Math.max(0, pct));
  const points = [...(row.history ?? []), { at: row.sampledAt, pct: row.used }].filter(
    (point) => point.at >= start,
  );
  const line = points.map((point) => `${x(point.at).toFixed(2)},${y(point.pct).toFixed(2)}`);
  const nowX = x(now);
  const end =
    row.projected === null
      ? null
      : row.fullAt !== null && row.fullAt < row.resetAt
        ? { at: row.fullAt, pct: 100 }
        : { at: row.resetAt, pct: row.projected };
  const days = Array.from({ length: 7 }, (_, i) => start + i * DAY_MS);
  return (
    <div className="burnup">
      <div className="burnup-plot">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${row.accountId}: ${percent(row.used)} of the week used${
            row.projected === null ? "" : `, ${percent(row.projected)} by reset at this pace`
          }. Alert at ${row.alertAt}%, stop at ${row.stopAt}%.`}
        >
          <line className="burnup-alert" x1={0} x2={100} y1={y(row.alertAt)} y2={y(row.alertAt)} />
          <line className="burnup-stop" x1={0} x2={100} y1={y(row.stopAt)} y2={y(row.stopAt)} />
          {line.length > 1 && (
            <polygon
              className="burnup-fill"
              points={`${x(points[0]?.at ?? start)},100 ${line.join(" ")} ${x(points.at(-1)?.at ?? start)},100`}
            />
          )}
          {line.length > 0 && <polyline className="burnup-line" points={line.join(" ")} />}
          {end && (
            <line
              className="burnup-projection"
              x1={x(row.sampledAt)}
              y1={y(row.used)}
              x2={x(end.at)}
              y2={y(end.pct)}
            />
          )}
          <line className="burnup-now" x1={nowX} x2={nowX} y1={0} y2={100} />
        </svg>
        <span className="burnup-mark" style={{ top: `${y(row.stopAt)}%` }}>
          stop {row.stopAt}
        </span>
        <span
          className="burnup-mark"
          // Close limits would overprint: the alert label keeps a line below the stop label.
          style={{ top: `max(${y(row.alertAt)}%, calc(${y(row.stopAt)}% + var(--lh-axis)))` }}
        >
          alert {row.alertAt}
        </span>
      </div>
      <div className="burnup-axis num" aria-hidden="true">
        {days.map((day, i) => (
          <span key={day} style={{ left: `${(i / days.length) * 100}%` }}>
            {tz
              ? new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: tz }).format(day)
              : ""}
          </span>
        ))}
        <span className="burnup-reset">reset</span>
      </div>
    </div>
  );
}

/** Tokens a minute on this account for the last hour, on its own scale. */
function HourBars({
  rows,
  lanes,
  account,
  now,
}: {
  rows: Crew["rows"];
  lanes: OverviewTimeline["lanes"] | undefined;
  account: string;
  now: number;
}) {
  const series = rows
    .filter((row) => row.accountId === account)
    .map((row) =>
      laneTokens(
        row.digest,
        now,
        lanes?.find((lane) => lane.agentId === row.id),
      ),
    );
  const values = Array.from({ length: LANE_MINUTES }, (_, i) =>
    series.reduce((sum, seat) => sum + (seat[i] ?? 0), 0),
  );
  const total = values.reduce((sum, value) => sum + value, 0);
  const peak = Math.max(0, ...values);
  // The current minute is still filling, so the reading is the last whole one.
  const latest = values.at(-2) ?? 0;
  return (
    <div className="hourbars">
      <div className="plot-reading s">
        <span title="Input and output tokens, across runs">last hour {kTokens(total)}</span>
        <span>peak {kTokens(peak)}/min</span>
      </div>
      <svg
        viewBox={`0 0 ${LANE_MINUTES} 100`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${account}: ${kTokens(total)} tokens in the last hour, peak ${kTokens(peak)} a minute`}
      >
        {values.map((value, i) => {
          if (value <= 0) return null;
          const height = Math.max(2, (value / Math.max(1, peak)) * 100);
          return (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: each index is a fixed minute of the hour
              key={i}
              x={i + 0.1}
              y={100 - height}
              width={0.8}
              height={height}
            />
          );
        })}
      </svg>
      <div className="plot-axis num" aria-hidden="true">
        <span>−60m</span>
        <span>−30m</span>
        <span title="Tokens in the last whole minute">now {kTokens(latest)}/min</span>
      </div>
    </div>
  );
}

/** Each account's week and last hour. Vendors count tokens on different scales, so never one axis. */
export function TokensPanel() {
  const limits = useResource<LimitRow[]>(RESOURCES.limits);
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const metrics = useMetrics();
  const spend = metrics.readings.cost;
  const now = useNow();
  const tz = useTz();
  const accounts = config?.accounts.map((account) => account.id) ?? [];
  const health = useResource<HealthRow[]>(RESOURCES.health).data ?? [];
  const lanes = useResource<OverviewTimeline>(RESOURCES.overviewTimeline).data?.lanes;
  return (
    <Panel
      id="tokensP"
      title={
        <a href={PAGE_PATHS.telemetry} onClick={(e) => followLink(e, PAGE_PATHS.telemetry)}>
          Tokens
        </a>
      }
      sub="the week and the last hour"
      actions={
        spend ? (
          <span className="token-spend" title={metricTitle(metrics, "cost")}>
            <span data-metric="cost">{spend.value}</span> today
          </span>
        ) : undefined
      }
    >
      {limits.error && (
        <p role="status" className="pb s warn-t">
          {limits.data ? "Refresh failed. Showing the last readings." : "Allowance could not load."}{" "}
          <button type="button" className="sm" onClick={() => hub.refetch(RESOURCES.limits.path)}>
            Refresh allowance
          </button>
        </p>
      )}
      {!limits.data && !limits.error && <p className="pb s muted">Loading allowance…</p>}
      {config && accounts.length === 0 && (
        <p className="pb s muted">No provider accounts configured.</p>
      )}
      {accounts.map((account) => {
        const week = limits.data?.find(
          (row): row is WeekRow => row.accountId === account && row.window === "7d",
        );
        // A five-hour reading whose reset has passed says nothing about now.
        const five = limits.data?.find(
          (row) => row.accountId === account && row.window === "5h" && row.resetAt > now,
        );
        const stale =
          !!week &&
          isStale(
            week,
            now,
            !!health.find((row) => row.collector === usageCollector(account))?.error,
          );
        const verdict = week ? paceVerdict(week, five, now, tz, stale) : null;
        const setup = setupPath("accounts");
        return (
          <div className="token-account" key={account}>
            <div className="token-head">
              <a href={setup} onClick={(e) => followLink(e, setup)}>
                <b>{account}</b>
              </a>
              <span className="token-used num">{week ? percent(week.used) : "—"}</span>
              {week?.projected != null && week.used < week.stopAt && week.resetAt > now && (
                <span className="s muted">
                  → {percent(week.projected)} by reset {tz ? resetWhen(week, now, tz) : ""}
                </span>
              )}
              {five && (
                <span className="s muted">
                  · 5h {percent(five.used)}
                  {tz ? `, resets ${hhmm(five.resetAt, tz)}` : ""}
                </span>
              )}
              {stale && week && (
                <span className="s warn-t">· read {tz ? hhmm(week.sampledAt, tz) : "earlier"}</span>
              )}
              {verdict && <span className={`token-verdict s ${verdict.tone}`}>{verdict.text}</span>}
            </div>
            <div className="token-plots">
              {week ? (
                <BurnUp row={week} now={now} tz={tz} />
              ) : (
                <p className="s muted">No weekly reading yet.</p>
              )}
              {crew && <HourBars rows={crew.rows} lanes={lanes} account={account} now={now} />}
            </div>
          </div>
        );
      })}
    </Panel>
  );
}
