import { TELEMETRY_RANGES, type Telemetry } from "@mc/core";
import { useState } from "react";
import { cost, minutesAgo, percent } from "../fmt.ts";
import {
  keyStep,
  Legend,
  pointerX,
  Tip,
  useChartCursor,
  useChartWidth,
} from "../hud/charts/Hover.tsx";
import { LineChart, type LineSeries } from "../hud/charts/LineChart.tsx";
import { Panel } from "../hud/Panel.tsx";
import { chartAnnotations } from "./annotations.ts";
import type { Scope } from "./common.ts";

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
  annotations: { at: number; label: string }[];
}) {
  const [ref, width] = useChartWidth(560);
  const [local, setLocal] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
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
  const span = (to - from) / zoom;
  const centre = at !== null && at >= from && at <= to ? at : (from + to) / 2;
  const visibleFrom = Math.max(from, Math.min(to - span, centre - span / 2));
  const visibleTo = visibleFrom + span;
  const x = (time: number) =>
    x0 + ((time - visibleFrom) / Math.max(1, visibleTo - visibleFrom)) * (x1 - x0);
  const setAt = (time: number | null) => {
    setLocal(time);
    cursor?.setAt(time);
  };
  if (!agents.length)
    return <p className="pb s muted">No crew state observations in this range.</p>;
  const stateAt = (agent: string, time: number) =>
    spans.find(
      (state) =>
        state.agentId === agent &&
        (state.startedAt === state.endedAt
          ? time === state.startedAt
          : state.startedAt <= time && time < state.endedAt),
    )?.state ?? "—";
  const nearest = (time: number) =>
    times.reduce<number | null>(
      (best, candidate) =>
        best === null || Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best,
      null,
    );
  const visibleAnnotations = annotations
    .filter((event) => event.at >= visibleFrom && event.at <= visibleTo)
    .sort((a, b) => a.at - b.at);
  const times = [
    ...new Set([
      ...spans
        .filter((state) => state.endedAt >= visibleFrom && state.startedAt <= visibleTo)
        .flatMap((state) => [state.startedAt, state.endedAt]),
      ...visibleAnnotations.map((event) => event.at),
    ]),
  ]
    .filter((time) => time >= visibleFrom && time <= visibleTo)
    .sort((a, b) => a - b);
  const annotationMarkers: typeof visibleAnnotations = [];
  for (const event of visibleAnnotations) {
    const previous = annotationMarkers.at(-1);
    if (previous === undefined || Math.abs(x(previous.at) - x(event.at)) >= 8)
      annotationMarkers.push(event);
  }
  return (
    <div className="chart crew-state-chart" ref={ref}>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add a border in the chart toolbar */}
      <span className="seg" role="group" aria-label="Crew state zoom">
        <button
          type="button"
          aria-label="Zoom in crew state"
          onClick={() => setZoom((value) => Math.min(16, value * 2))}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out crew state"
          onClick={() => setZoom((value) => Math.max(1, value / 2))}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Reset crew state zoom"
          onClick={() => setZoom(1)}
          disabled={zoom === 1}
        >
          Reset
        </button>
      </span>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        data-from={visibleFrom}
        data-to={visibleTo}
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
              .filter(
                (state) =>
                  state.agentId === agent &&
                  state.endedAt >= visibleFrom &&
                  state.startedAt <= visibleTo,
              )
              .map((span) => (
                <rect
                  className="crew-state-span"
                  data-ended-at={span.endedAt}
                  key={`${span.startedAt}:${span.endedAt}:${span.state}`}
                  x={x(Math.max(visibleFrom, span.startedAt))}
                  y={row * lane + 5}
                  width={Math.max(
                    1,
                    x(Math.min(visibleTo, span.endedAt)) - x(Math.max(visibleFrom, span.startedAt)),
                  )}
                  height={12}
                  fill={STATE_COLOUR[span.state]}
                >
                  <title>{`${agent} ${span.state}`}</title>
                </rect>
              ))}
          </g>
        ))}
        {annotationMarkers.map((event) => (
          <g className="annotation" key={`${event.at}:${event.label}`}>
            <line
              x1={x(event.at)}
              x2={x(event.at)}
              y1={0}
              y2={height - 18}
              stroke="var(--warn)"
              strokeDasharray="2 3"
            />
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
              visibleFrom +
              ((pointerX(event, width) - x0) / Math.max(1, x1 - x0)) * (visibleTo - visibleFrom);
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
                key: `${event.at}:${event.label}`,
                name: "Event",
                value: event.label,
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
  const annotations = chartAnnotations(series?.annotations ?? []);
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
      ticket.readyAt === null
        ? []
        : [
            { at: ticket.readyAt, delta: 1 },
            ...(ticket.doneAt !== null && ticket.doneAt >= ticket.readyAt
              ? [{ at: ticket.doneAt, delta: -1 }]
              : []),
          ],
    )
    .sort((a, b) => a.at - b.at);
  for (const event of flowEvents) {
    if (event.at >= from) break;
    inProgress += event.delta;
  }
  const activePoints = inProgress === 0 ? [] : [{ at: from, v: inProgress }];
  for (const event of flowEvents) {
    if (event.at < from || event.at > to) continue;
    inProgress += event.delta;
    activePoints.push({ at: event.at, v: inProgress });
  }
  if (activePoints.length && (activePoints.at(-1)?.at ?? to) < to)
    activePoints.push({ at: to, v: inProgress });
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
  const totalCostByTicket = new Map(
    ticketCosts.map((row) => [
      row.ticket,
      row.totalCostUsd === undefined ? row.costUsd : row.totalCostUsd,
    ]),
  );
  const mergedCosts = tickets
    .filter((ticket): ticket is typeof ticket & { mergedAt: number } => ticket.mergedAt !== null)
    .sort((a, b) => a.mergedAt - b.mergedAt)
    .map((ticket) => ({ at: ticket.mergedAt, v: totalCostByTicket.get(ticket.ticket) ?? null }));
  const inRangeCost = tickets
    .filter((ticket): ticket is typeof ticket & { mergedAt: number } => ticket.mergedAt !== null)
    .reduce((sum, ticket) => sum + (costByTicket.get(ticket.ticket) ?? 0), 0);
  const quality = series?.quality ?? [];
  const qualitySeries: LineSeries[] = [
    {
      id: "ci-green-first-push",
      name: "CI green first push",
      color: "var(--accent)",
      points: quality.map((point) => ({ at: point.at, v: point.ciGreenFirstPushPct })),
    },
    {
      id: "review-rounds",
      name: "review rounds per PR",
      color: "var(--warn)",
      points: quality.map((point) => ({ at: point.at, v: point.reviewRoundsPerPr })),
    },
    {
      id: "first-pass-review",
      name: "first pass review",
      color: "var(--seat-2)",
      points: quality.map((point) => ({ at: point.at, v: point.firstPassReviewPct })),
    },
  ];
  const forecast = series?.throughput ?? [];
  const labels = [`-${scope.range}`, "now"] as [string, string];
  return (
    <div className="tgrid">
      <Panel id="tCrewState" title="Crew state" sub="observed running, waiting and parked lanes">
        {!series ? (
          unavailable("Timestamped crew-state history", scope.range)
        ) : (
          <>
            <CrewStateTimeline
              spans={series.stateSpans}
              from={from}
              to={to}
              annotations={annotations}
            />
            <Legend
              items={Object.entries(STATE_COLOUR).map(([name, color]) => ({
                key: name,
                name,
                color,
              }))}
            />
          </>
        )}
      </Panel>
      <Panel id="tFlow" title="Cumulative flow" sub="observed Ready and merged ticket events">
        {!series ? (
          unavailable("Board-stage history", scope.range)
        ) : !flowEvents.length && !mergedPoints.length ? (
          <p className="pb s muted">No board-stage observations in this range.</p>
        ) : (
          <>
            <LineChart
              series={[
                {
                  id: "in-progress",
                  name: "in progress",
                  color: "var(--accent)",
                  points: activePoints,
                },
                { id: "merged", name: "merged", color: "var(--seat-2)", points: mergedPoints },
              ]}
              from={from}
              to={to}
              label="Cumulative flow"
              xLabels={labels}
              at={at}
              annotations={annotations}
              format={(v) => String(Math.round(v))}
            />
            <Legend
              items={[
                { key: "in-progress", name: "in progress", color: "var(--accent)" },
                { key: "merged", name: "merged", color: "var(--seat-2)" },
              ]}
            />
          </>
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
        {!series ? (
          unavailable("Daily quality history", scope.range)
        ) : !quality.length ||
          !qualitySeries.some((line) => line.points.some((point) => point.v !== null)) ? (
          <p className="pb s muted">No daily quality observations in this range.</p>
        ) : (
          <>
            {qualitySeries.map((line) => {
              const isPct = line.id !== "review-rounds";
              return (
                <LineChart
                  key={line.id}
                  series={[line]}
                  from={from}
                  to={to}
                  max={
                    isPct
                      ? 100
                      : Math.max(
                          1,
                          ...line.points.flatMap((point) => (point.v === null ? [] : [point.v])),
                        ) * 1.1
                  }
                  label={line.name}
                  xLabels={labels}
                  at={at}
                  annotations={annotations}
                  format={(v) => (isPct ? percent(v) : v.toFixed(1))}
                  height={116}
                />
              );
            })}
            <Legend
              items={qualitySeries.map(({ id, name, color }) => ({ key: id, name, color }))}
            />
          </>
        )}
      </Panel>
      <Panel
        id="tCostMerged"
        title="Full cost per merged ticket"
        sub="all observed runs · API-equivalent estimate"
      >
        {!series ? (
          unavailable("Merged-ticket cost history", scope.range)
        ) : !mergedCosts.length ? (
          <p className="pb s muted">No merged tickets in this range.</p>
        ) : !mergedCosts.some((point) => point.v !== null) ? (
          <>
            <p className="pb s muted">No API-equivalent cost was reported for merged tickets.</p>
            <p className="note xs">In range: {cost(inRangeCost, false)}</p>
          </>
        ) : (
          <>
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
                Math.max(
                  1,
                  ...mergedCosts.flatMap((point) => (point.v === null ? [] : [point.v])),
                ) * 1.1
              }
              label="Full cost per merged ticket"
              xLabels={labels}
              at={at}
              annotations={annotations}
              format={(v) => cost(v, false)}
            />
            <p className="note xs">In range: {cost(inRangeCost, false)}</p>
          </>
        )}
      </Panel>
      <Panel id="tForecast" title="Forecast" sub="range-bounded throughput">
        {!series ? (
          unavailable("Timestamped throughput", scope.range)
        ) : !forecast.length ? (
          <p className="pb s muted">No throughput observations in this range.</p>
        ) : (
          <>
            <LineChart
              series={[
                {
                  id: "throughput",
                  name: "throughput",
                  color: "var(--accent)",
                  points: forecast.map((point) => ({ at: point.at, v: point.merged })),
                },
              ]}
              from={from}
              to={to}
              max={Math.max(1, ...forecast.map((point) => point.merged)) * 1.1}
              label="Forecast"
              xLabels={labels}
              at={at}
              annotations={annotations}
              format={(v) => String(Math.round(v))}
            />
            <Legend
              items={[{ key: "throughput", name: "merged per bucket", color: "var(--accent)" }]}
            />
          </>
        )}
      </Panel>
    </div>
  );
}
