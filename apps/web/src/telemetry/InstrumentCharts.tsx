import { TELEMETRY_RANGES, type Telemetry } from "@mc/core";
import { useState } from "react";
import { keyStep, pointerX, Tip, useChartCursor, useChartWidth } from "../hud/charts/Hover.tsx";
import { LineChart, type LineSeries } from "../hud/charts/LineChart.tsx";
import { Panel } from "../hud/Panel.tsx";
import { minutesAgo, type Scope } from "./common.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
type Series = NonNullable<Telemetry["series"]>;

function unavailable(what: string, range: string) {
  return (
    <p className="pb s muted">
      {what} data is not available for the last {range} yet.
    </p>
  );
}

const STATE_COLOUR: Record<Series["stateSpans"][number]["state"], string> = {
  running: "var(--accent)",
  waiting: "var(--warn)",
  parked: "var(--crit)",
  idle: "var(--fg-2)",
};

export function nearestRank(values: number[], pct: number): number | null {
  if (!values.length) return null;
  return values[Math.ceil(values.length * pct) - 1] ?? null;
}

function CrewStateTimeline({
  spans,
  from,
  to,
  annotations,
}: {
  spans: Series["stateSpans"];
  from: number;
  to: number;
  annotations: Series["annotations"];
}) {
  const [ref, width] = useChartWidth(560);
  const [local, setLocal] = useState<number | null>(null);
  const cursor = useChartCursor();
  const at = cursor?.at ?? local;
  // Idle-only agents say nothing about active crew state, so keep their lanes folded.
  const agents = [...new Set(spans.map((span) => span.agentId))].filter((agent) =>
    spans.some((span) => span.agentId === agent && span.state !== "idle"),
  );
  const lane = 22;
  const height = Math.max(56, agents.length * lane + 24);
  const x0 = 80;
  const x1 = width - 4;
  const x = (time: number) => x0 + ((time - from) / Math.max(1, to - from)) * (x1 - x0);
  const times = [...new Set(spans.flatMap((span) => [span.startedAt, span.endedAt]))].sort(
    (a, b) => a - b,
  );
  const setAt = (time: number | null) => {
    setLocal(time);
    cursor?.setAt(time);
  };
  if (!agents.length)
    return <p className="pb s muted">No crew state observations in this range.</p>;
  const stateAt = (agent: string, time: number) =>
    spans.find((span) => span.agentId === agent && span.startedAt <= time && span.endedAt >= time)
      ?.state ?? "—";
  const nearest = (time: number) =>
    times.reduce<number | null>(
      (best, candidate) =>
        best === null || Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best,
      null,
    );
  return (
    <div className="chart crew-state-chart" ref={ref}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label={`Crew state: ${agents.length} active lanes; idle-only lanes folded`}
        {...keyStep(times.length, at === null ? null : times.indexOf(at), (i) =>
          setAt(i === null ? null : (times[i] ?? null)),
        )}
      >
        {agents.map((agent, row) => (
          <g key={agent}>
            <text className="ct" x={x0 - 4} y={row * lane + 16} textAnchor="end">
              {agent}
            </text>
            {spans
              .filter((span) => span.agentId === agent)
              .map((span) => (
                <rect
                  className="crew-state-span"
                  data-ended-at={span.endedAt}
                  key={`${span.startedAt}:${span.endedAt}:${span.state}`}
                  x={x(span.startedAt)}
                  y={row * lane + 5}
                  width={Math.max(1, x(span.endedAt) - x(span.startedAt))}
                  height={12}
                  fill={STATE_COLOUR[span.state]}
                >
                  <title>{`${agent} ${span.state}`}</title>
                </rect>
              ))}
          </g>
        ))}
        {annotations.map((event) => (
          <g className="annotation" key={`${event.at}:${event.kind}`}>
            <line
              x1={x(event.at)}
              x2={x(event.at)}
              y1={0}
              y2={height - 18}
              stroke="var(--warn)"
              strokeDasharray="2 3"
            />
            <text className="ct" x={x(event.at) + 3} y={12}>
              {event.cause}
            </text>
          </g>
        ))}
        {at !== null && (
          <line
            className="xhair"
            x1={x(at)}
            x2={x(at)}
            y1={0}
            y2={height - 18}
            stroke="var(--fg-2)"
            strokeDasharray="3 3"
          />
        )}
        <rect
          className="hit"
          x={x0}
          y={0}
          width={x1 - x0}
          height={height - 18}
          fill="transparent"
          onPointerMove={(event) => {
            const time =
              from + ((pointerX(event, width) - x0) / Math.max(1, x1 - x0)) * (to - from);
            setAt(nearest(time));
          }}
          onPointerLeave={() => setAt(null)}
        />
      </svg>
      {at !== null && (
        <Tip
          x={x(at)}
          width={width}
          title={new Date(at).toLocaleString()}
          rows={[
            ...agents.map((agent) => ({ key: agent, name: agent, value: stateAt(agent, at) })),
            ...annotations
              .filter((event) => event.at === at)
              .map((event) => ({
                key: `${event.at}:${event.kind}`,
                name: "Event",
                value: event.cause,
              })),
          ]}
        />
      )}
    </div>
  );
}

/** Raw chart observations are rendered as provided; unavailable histories stay explicitly empty. */
export function InstrumentCharts({
  scope,
  series,
  ticketCosts = [],
  from = Date.now() - TELEMETRY_RANGES[scope.range] * MINUTE_MS,
  to = Date.now(),
}: {
  scope: Scope;
  series?: Series;
  ticketCosts?: Telemetry["tokensByTicket"];
  from?: number;
  to?: number;
}) {
  const at = (ms: number) => minutesAgo((to - ms) / MINUTE_MS);
  const annotations = (series?.annotations ?? []).map((event) => ({
    at: event.at,
    label: event.cause,
  }));
  const tickets = series?.tickets ?? [];
  const completed = tickets
    .filter(
      (ticket): ticket is typeof ticket & { readyAt: number; doneAt: number } =>
        ticket.readyAt !== null && ticket.doneAt !== null && ticket.doneAt >= ticket.readyAt,
    )
    .sort((a, b) => a.doneAt - b.doneAt);
  let inProgress = 0;
  let merged = 0;
  const flowEvents = tickets
    .flatMap((ticket) =>
      ticket.readyAt === null || ticket.doneAt === null || ticket.doneAt < ticket.readyAt
        ? []
        : [
            { at: ticket.readyAt, delta: 1 },
            { at: ticket.doneAt, delta: -1 },
          ],
    )
    .sort((a, b) => a.at - b.at);
  const activePoints = flowEvents.map((event) => {
    inProgress += event.delta;
    return { at: event.at, v: inProgress };
  });
  const mergedPoints = tickets
    .filter((ticket): ticket is typeof ticket & { mergedAt: number } => ticket.mergedAt !== null)
    .sort((a, b) => a.mergedAt - b.mergedAt)
    .map((ticket) => ({ at: ticket.mergedAt, v: ++merged }));
  const cycle: LineSeries[] = [50, 85].map((p) => ({
    id: `p${p}`,
    name: `p${p} cycle time`,
    color: p === 50 ? "var(--accent)" : "var(--warn)",
    points: completed.map((ticket, i) => ({
      at: ticket.doneAt,
      v: nearestRank(
        completed
          .slice(0, i + 1)
          .map((row) => (row.doneAt - row.readyAt) / HOUR_MS)
          .sort((a, b) => a - b),
        p / 100,
      ),
    })),
  }));
  const costByTicket = new Map(ticketCosts.map((row) => [row.ticket, row.costUsd]));
  const mergedCosts = tickets
    .filter((ticket): ticket is typeof ticket & { mergedAt: number } => ticket.mergedAt !== null)
    .sort((a, b) => a.mergedAt - b.mergedAt)
    .map((ticket) => ({ at: ticket.mergedAt, v: costByTicket.get(ticket.ticket) ?? null }));
  const labels = [`-${scope.range}`, "now"] as [string, string];
  return (
    <div className="tgrid">
      <Panel id="tCrewState" title="Crew state" sub="observed running, waiting and parked lanes">
        {!series ? (
          unavailable("Timestamped crew-state history", scope.range)
        ) : (
          <CrewStateTimeline
            spans={series.stateSpans}
            from={from}
            to={to}
            annotations={series.annotations}
          />
        )}
      </Panel>
      <Panel id="tFlow" title="Cumulative flow" sub="observed Ready and merged ticket events">
        {!series ? (
          unavailable("Board-stage history", scope.range)
        ) : !flowEvents.length ? (
          <p className="pb s muted">No board-stage observations in this range.</p>
        ) : (
          <LineChart
            series={[
              {
                id: "in-progress",
                name: "in progress",
                color: "var(--accent)",
                points: activePoints,
              },
              { id: "merged", name: "merged", color: "var(--s2)", points: mergedPoints },
            ]}
            from={from}
            to={to}
            label="Cumulative flow"
            xLabels={labels}
            at={at}
            annotations={annotations}
            format={(v) => String(Math.round(v))}
          />
        )}
      </Panel>
      <Panel id="tCycleControl" title="Cycle-time control chart" sub="p50 and p85, hours">
        {!series ? (
          unavailable("Per-ticket cycle-time history", scope.range)
        ) : !completed.length ? (
          <p className="pb s muted">No completed tickets with observed Ready time in this range.</p>
        ) : (
          <LineChart
            series={cycle}
            from={from}
            to={to}
            max={
              Math.max(
                1,
                ...cycle.flatMap((line) =>
                  line.points.flatMap((point) => (point.v === null ? [] : [point.v])),
                ),
              ) * 1.1
            }
            label="Cycle-time control chart"
            xLabels={labels}
            at={at}
            annotations={annotations}
            format={(v) => `${v.toFixed(1)} h`}
          />
        )}
      </Panel>
      <Panel id="tQualityTrend" title="Quality trends" sub="daily small multiples">
        {unavailable("Daily quality history", scope.range)}
      </Panel>
      <Panel id="tCostMerged" title="Cost per merged ticket" sub="API-equivalent estimate">
        {!series ? (
          unavailable("Merged-ticket cost history", scope.range)
        ) : !mergedCosts.length ? (
          <p className="pb s muted">No merged tickets in this range.</p>
        ) : !mergedCosts.some((point) => point.v !== null) ? (
          <p className="pb s muted">No API-equivalent cost was reported for merged tickets.</p>
        ) : (
          <LineChart
            series={[
              {
                id: "cost-per-merged-ticket",
                name: "cost per merged ticket",
                color: "var(--accent)",
                points: mergedCosts,
              },
            ]}
            from={from}
            to={to}
            max={
              Math.max(1, ...mergedCosts.flatMap((point) => (point.v === null ? [] : [point.v]))) *
              1.1
            }
            label="Cost per merged ticket"
            xLabels={labels}
            at={at}
            annotations={annotations}
            format={(v) => `$${v.toFixed(2)}`}
          />
        )}
      </Panel>
    </div>
  );
}
