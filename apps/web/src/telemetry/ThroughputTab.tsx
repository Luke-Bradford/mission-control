import {
  CYCLE_TIME_MIN_FOR_P85,
  FLOW_DAYS,
  formatHours,
  NO_SIZE,
  type Telemetry,
  TICKET_SIZES,
} from "@mc/core";
import { useState } from "react";
import { useTz } from "../clock.ts";
import { cost, dayLabel, dayMonth, narrowDay, plural } from "../fmt.ts";
import { Grid, keyStep, PAD, Tip, useChartSize, XAxis } from "../hud/charts/Hover.tsx";
import { VBars } from "../hud/charts/VBars.tsx";
import { Panel } from "../hud/Panel.tsx";
import { useMetrics } from "../metrics.ts";
import { PAGE_PATHS, ticketPath } from "../router.ts";
import { DASH, NOT_TRACKED } from "./common.ts";
import { Cell, Stat, type StatSpec } from "./Stat.tsx";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The per-ticket series covers the longest range the server serves: its dots span this window. */
export const TICKET_SERIES_RANGE = "7d" as const;
const TICKET_DAYS = FLOW_DAYS;
const CHART_H = 140;
const CHART_MIN_H = 120;
const MS_PER_HOUR_FIGURE = HOUR_MS;

/** A round top for an hours axis. */
function niceMax(v: number): number {
  const steps = [1, 2, 4, 6, 8, 12, 24, 36, 48, 72, 96, 144, 192, 288, 480, 960];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 100) * 100;
}

const hours = (ms: number): string => (ms / MS_PER_HOUR_FIGURE).toFixed(1);

type Ticket = NonNullable<Telemetry["series"]>["tickets"][number];
type Finished = Ticket & { readyAt: number; doneAt: number };

/** Tickets with an observed Ready and a Done after it: the ones a cycle time can be drawn for. */
export function finished(t: Telemetry | undefined): Finished[] {
  return (t?.series?.tickets ?? [])
    .filter((k): k is Finished => k.readyAt !== null && k.doneAt !== null && k.doneAt >= k.readyAt)
    .sort((a, b) => a.doneAt - b.doneAt);
}

/** Nearest-rank percentile of already sorted values. */
function rank(sorted: number[], pct: number): number | null {
  return sorted.length === 0 ? null : (sorted[Math.ceil(sorted.length * pct) - 1] ?? null);
}

function KeyLegend({
  items,
}: {
  items: { key: string; name: string; kind: "bar" | "dash" | "dot" | "line"; color: string }[];
}) {
  return (
    <div className="legend tp-legend">
      {items.map((it) => (
        <span key={it.key}>
          <i className={`k-${it.kind}`} style={{ "--k": it.color } as React.CSSProperties} />
          {it.name}
        </span>
      ))}
    </div>
  );
}

/** What a panel says in place of a chart. */
const say = (text: string) => <p className="pb s muted">{text}</p>;

// ── summary ──

/** The Throughput summary row: merges, cycle time, work in progress and commits per run. */
export function ThroughputSummaryRow({
  t,
  onNeedsRoute,
}: {
  t: Telemetry | undefined;
  onNeedsRoute: (s: StatSpec) => void;
}) {
  const metrics = useMetrics();
  const ct = metrics.view?.cycleTime;
  const merged = t?.throughput.at(-1)?.merged;
  const sum = t?.throughput.reduce((a, d) => a + d.merged, 0);
  const wip = t?.series?.ticketsInProgress;
  const wipNow = wip?.at(-1)?.tickets ?? null;
  const cpr = t?.quality.commitsPerRun;
  const enough = ct !== undefined && ct.n >= CYCLE_TIME_MIN_FOR_P85;
  const board = { kind: "link", href: PAGE_PATHS.board, target: "the Board" } as const;
  const stats: StatSpec[] = [
    {
      id: "mtoday",
      label: "Merged",
      value: merged === undefined ? DASH : String(merged),
      unit: "PRs",
      window: "today",
      definition: "Pull requests merged today.",
      drill: board,
    },
    {
      id: "m14",
      label: "Merged",
      value: sum === undefined ? DASH : String(sum),
      unit: "PRs",
      window: "14d",
      definition: `Pull requests merged in the last ${FLOW_DAYS} days.`,
      drill: board,
    },
    {
      id: "p50",
      label: "Cycle time p50",
      value: ct?.p50Ms == null || ct.n === 0 ? DASH : hours(ct.p50Ms),
      unit: "hours",
      window: "14d",
      definition: "Median hours from a ticket's first move into Ready to Done.",
      drill: board,
    },
    {
      id: "p85",
      label: "Cycle time p85",
      value: !enough || ct?.p85Ms == null ? DASH : hours(ct.p85Ms),
      unit: "hours",
      window: "14d",
      detail: ct && !enough ? `needs ${CYCLE_TIME_MIN_FOR_P85} tickets` : undefined,
      definition: `85% of tickets finished faster than this. Shown from ${CYCLE_TIME_MIN_FOR_P85} tickets.`,
      drill: board,
    },
    {
      id: "wip",
      label: "Tickets in progress",
      value: wipNow === null ? DASH : String(wipNow),
      unit: "tickets",
      window: "now",
      detail: t && wip === undefined ? "not collected yet" : undefined,
      definition: "Tickets started and not yet merged.",
      drill: board,
    },
    {
      id: "cpr",
      label: "Commits per run",
      value: cpr == null ? DASH : cpr.toFixed(1),
      unit: "commits",
      window: "14d",
      detail: t && cpr === undefined ? NOT_TRACKED : undefined,
      definition: "Commits per finished crew run, last 14 days.",
      drill: { kind: "needs-route", target: "the runs behind this average" },
    },
  ];
  return (
    <section className="summary" aria-label="Throughput summary">
      <div className="scope">
        <b>Last {FLOW_DAYS} days</b>
        <span>Fixed window</span>
      </div>
      {stats.map((s) => (
        <Stat key={s.id} stat={s} onNeedsRoute={onNeedsRoute} />
      ))}
    </section>
  );
}

// ── charts ──

function MergedPerDay({ t, wait }: { t: Telemetry | undefined; wait: string }) {
  const rows = t?.throughput ?? [];
  const mean = rows.length ? rows.reduce((a, d) => a + d.merged, 0) / rows.length : 0;
  const best = Math.max(0, ...rows.map((d) => d.merged));
  return (
    <Panel id="tMerged" title="Merged per day" sub={`PRs · last ${FLOW_DAYS} days`}>
      {!t ? (
        say(wait)
      ) : rows.length === 0 ? (
        say("No days to show yet.")
      ) : (
        <div className="pb">
          <VBars
            label="PRs merged per day"
            every={2}
            accentLast
            height={CHART_H}
            fill
            guide={mean}
            bars={rows.map((d) => ({
              key: d.day,
              label: narrowDay(d.day),
              tip: `${dayLabel(d.day)}: ${d.merged} merged`,
              segments: [{ name: "merged", value: d.merged }],
            }))}
          />
          <KeyLegend
            items={[
              {
                key: "today",
                name: `Today ${rows.at(-1)?.merged}`,
                kind: "bar",
                color: "var(--accent)",
              },
              {
                key: "mean",
                name: `14-day mean ${mean.toFixed(1)}`,
                kind: "dash",
                color: "var(--warn)",
              },
              { key: "best", name: `Best day ${best}`, kind: "bar", color: "var(--fg-2)" },
            ]}
          />
        </div>
      )}
    </Panel>
  );
}

function CycleDots({ t, wait, now }: { t: Telemetry | undefined; wait: string; now: number }) {
  const [ref, w, measuredHeight] = useChartSize(560, CHART_H);
  const chartHeight = Math.max(CHART_MIN_H, measuredHeight);
  const [hover, setHover] = useState<number | null>(null);
  const rows = finished(t);
  const from = now - TICKET_DAYS * DAY_MS;
  // The server's ticket series is already the complete 14-day window.
  const shown = rows;
  const sorted = shown.map((r) => r.doneAt - r.readyAt).sort((a, b) => a - b);
  const p50 = rank(sorted, 0.5);
  const p85 = rank(sorted, 0.85);
  const p50Hours = p50 === null ? 0 : p50 / HOUR_MS;
  const p85Hours = p85 === null ? 0 : p85 / HOUR_MS;
  // Percentiles describe the useful comparison range; a single stalled ticket must not flatten it.
  const top = niceMax(Math.max(24, p85Hours * 1.5, p50Hours * 3));
  const overflow = shown.filter((r) => (r.doneAt - r.readyAt) / HOUR_MS > top);
  const longest = Math.max(...sorted) / HOUR_MS;
  const x0 = PAD.l;
  const x1 = w - PAD.r;
  const yBottom = chartHeight - PAD.b;
  const Y = (h: number): number => PAD.t + (1 - h / top) * (yBottom - PAD.t);
  const X = (at: number): number => x0 + ((at - from) / (now - from)) * (x1 - x0);
  const fmt = (v: number): string => `${v} h`;
  const tz = useTz();
  const lines = [
    { key: "p50", ms: p50, color: "var(--ok)", dash: undefined },
    { key: "p85", ms: p85, color: "var(--warn)", dash: "5 4" },
  ];
  return (
    <Panel
      id="tCycleTicket"
      title="Cycle time per ticket"
      sub={`hours, Ready to Done · last ${TICKET_DAYS} days`}
    >
      {!t ? (
        say(wait)
      ) : !t.series ? (
        say(`Per-ticket cycle time is not available for the last ${TICKET_DAYS} days yet.`)
      ) : shown.length === 0 ? (
        say(`No tickets finished in the last ${TICKET_DAYS} days.`)
      ) : (
        <div className="pb">
          <div className="chart" ref={ref}>
            <svg
              viewBox={`0 0 ${w} ${chartHeight}`}
              width="100%"
              height={chartHeight}
              preserveAspectRatio="xMinYMin meet"
              role="img"
              aria-label={`Cycle time per ticket: ${shown.map((r) => `${r.ticket} ${hours(r.doneAt - r.readyAt)} h`).join(", ")}`}
              {...keyStep(shown.length, hover, setHover)}
            >
              <Grid max={top} ticks={[0, top / 2, top]} y={Y} x0={x0} x1={x1} label={fmt} />
              <XAxis y={yBottom} x0={x0} x1={x1} at={[]} />
              {lines.map(
                (l) =>
                  l.ms !== null && (
                    <line
                      key={l.key}
                      className="cycle-line"
                      x1={x0}
                      x2={x1}
                      y1={Y(l.ms / HOUR_MS)}
                      y2={Y(l.ms / HOUR_MS)}
                      stroke={l.color}
                      strokeDasharray={l.dash}
                    />
                  ),
              )}
              {shown.map((r, i) => {
                const duration = (r.doneAt - r.readyAt) / HOUR_MS;
                const x = X(r.doneAt);
                return duration > top ? (
                  <path
                    key={r.ticket}
                    className="overflow-dot"
                    d={`M${x},${PAD.t}l-4,7h8Z`}
                    onPointerEnter={() => setHover(i)}
                    onPointerLeave={() => setHover(null)}
                  />
                ) : (
                  <circle
                    key={r.ticket}
                    className="dot"
                    cx={x}
                    cy={Y(duration)}
                    r={hover === i ? 5 : 3.5}
                    onPointerEnter={() => setHover(i)}
                    onPointerLeave={() => setHover(null)}
                  />
                );
              })}
              <text className="ct xl" x={x0} y={chartHeight - 3}>
                {tz ? dayMonth(from, tz) : "start"}
              </text>
              <text className="ct xl" x={x1} y={chartHeight - 3} textAnchor="end">
                now
              </text>
            </svg>
            {hover !== null && shown[hover] && (
              <Tip
                x={X((shown[hover] as Finished).doneAt)}
                width={w}
                title={(shown[hover] as Finished).ticket}
                rows={[
                  {
                    key: "h",
                    name: "Cycle time",
                    value: formatHours(
                      (shown[hover] as Finished).doneAt - (shown[hover] as Finished).readyAt,
                    ),
                  },
                ]}
              />
            )}
          </div>
          <KeyLegend
            items={[
              {
                key: "dot",
                name: `Ticket · ${plural(shown.length, "dot")}`,
                kind: "dot",
                color: "var(--accent)",
              },
              {
                key: "p50",
                name: `p50 ${p50 === null ? DASH : formatHours(p50)}`,
                kind: "line",
                color: "var(--ok)",
              },
              {
                key: "p85",
                name: `p85 ${p85 === null ? DASH : formatHours(p85)}`,
                kind: "dash",
                color: "var(--warn)",
              },
              ...(overflow.length
                ? [
                    {
                      key: "overflow",
                      name: `${overflow.length} above ${top} h · longest ${longest.toFixed(0)} h`,
                      kind: "dot" as const,
                      color: "var(--accent)",
                    },
                  ]
                : []),
            ]}
          />
        </div>
      )}
    </Panel>
  );
}

function CycleBySize({ t, wait }: { t: Telemetry | undefined; wait: string }) {
  const hasTicketSeries = t?.series !== undefined;
  const bySize = new Map<string, number[]>();
  for (const ticket of finished(t)) {
    const size = ticket.size ?? NO_SIZE;
    const cycles = bySize.get(size) ?? [];
    cycles.push(ticket.doneAt - ticket.readyAt);
    bySize.set(size, cycles);
  }
  const otherSizes = [...bySize.keys()]
    .filter(
      (size) => !TICKET_SIZES.includes(size as (typeof TICKET_SIZES)[number]) && size !== NO_SIZE,
    )
    .sort();
  const ticketRows = [...TICKET_SIZES, ...otherSizes, NO_SIZE]
    .map((size) => {
      const cycles = (bySize.get(size) ?? []).sort((a, b) => a - b);
      return {
        size,
        p50Ms: rank(cycles, 0.5),
        p85Ms: cycles.length >= CYCLE_TIME_MIN_FOR_P85 ? rank(cycles, 0.85) : null,
        tickets: cycles.length,
      };
    })
    .filter((r) => r.tickets > 0 || r.size !== NO_SIZE);
  const rows = hasTicketSeries
    ? ticketRows
    : (t?.cycleTime.rows ?? []).filter((r) => r.tickets > 0 || r.size !== NO_SIZE);
  const peak = Math.max(
    1,
    ...rows.map((r) => (r.tickets === 0 ? 0 : (r.p85Ms ?? r.p50Ms ?? 0)) / HOUR_MS),
  );
  const top = niceMax(peak);
  const pct = (ms: number): number => (ms / HOUR_MS / top) * 100;
  return (
    <Panel
      id="tCycleSize"
      title="Cycle time by size"
      sub={`p50 to p85, hours · last ${FLOW_DAYS} days`}
    >
      {!t ? (
        say(wait)
      ) : rows.every((r) => r.tickets === 0) ? (
        say(`No tickets finished in the last ${FLOW_DAYS} days.`)
      ) : (
        <div className="pb">
          <ul className="size-rows" aria-label="Cycle time by size">
            {rows.map((r) => {
              const label = r.size === NO_SIZE ? "no size" : r.size;
              const range =
                r.tickets >= CYCLE_TIME_MIN_FOR_P85 && r.p50Ms !== null && r.p85Ms !== null
                  ? { from: r.p50Ms, to: r.p85Ms }
                  : null;
              const value =
                r.tickets === 0 || r.p50Ms === null
                  ? "no tickets"
                  : range
                    ? `${formatHours(range.from)}–${formatHours(range.to)}`
                    : `p50 ${formatHours(r.p50Ms)}`;
              return (
                <li key={r.size}>
                  <span className="lb">
                    {label} · {plural(r.tickets, "ticket")}
                  </span>
                  <div className="tr">
                    {range && (
                      <i
                        className="rng"
                        style={{
                          left: `${pct(range.from)}%`,
                          width: `${pct(range.to - range.from)}%`,
                        }}
                      />
                    )}
                    {r.p50Ms !== null && r.tickets > 0 && (
                      <b style={{ left: `${pct(r.p50Ms)}%` }} />
                    )}
                  </div>
                  <span className="vl">
                    <Cell
                      text={value}
                      label={`${label} cycle time`}
                      definition={`Hours from Ready to Done for ${label} tickets, last ${FLOW_DAYS} days. Opens the Board.`}
                      href={PAGE_PATHS.board}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="pnote">
            Each bar runs from p50 to p85; the mark is p50. The axis is 0 to {top} hours. p85 shows
            from {CYCLE_TIME_MIN_FOR_P85} tickets.
            {!hasTicketSeries &&
              t?.cycleTime.excluded > 0 &&
              ` ${t.cycleTime.excluded} done tickets left out: no Ready entry.`}
          </p>
        </div>
      )}
    </Panel>
  );
}

function TicketsInProgress({ t, wait }: { t: Telemetry | undefined; wait: string }) {
  const [ref, w, measuredHeight] = useChartSize(560, CHART_H);
  const chartHeight = Math.max(CHART_MIN_H, measuredHeight);
  const [hover, setHover] = useState<number | null>(null);
  const series = t?.series?.ticketsInProgress;
  // Days before the first observation are left out, not drawn as zero.
  const first = series?.findIndex((d) => d.tickets !== null) ?? -1;
  const days = first < 0 || !series ? [] : series.slice(first);
  const values = days.flatMap((d) => (d.tickets === null ? [] : [d.tickets]));
  const peak = Math.max(1, ...values);
  const top = Math.max(4, Math.ceil(peak / 4) * 4);
  const x0 = PAD.l;
  const x1 = w - PAD.r;
  const yBottom = chartHeight - PAD.b;
  const Y = (v: number): number => PAD.t + (1 - v / top) * (yBottom - PAD.t);
  const slot = (x1 - x0) / Math.max(1, days.length);
  const mid = (i: number): number => x0 + i * slot + slot / 2;
  let d = "";
  let pen = false;
  days.forEach((day, i) => {
    if (day.tickets === null) {
      pen = false;
      return;
    }
    const y = Y(day.tickets);
    d += pen ? `V${y}H${x0 + (i + 1) * slot}` : `M${x0 + i * slot},${y}H${x0 + (i + 1) * slot}`;
    pen = true;
  });
  const now = days.at(-1)?.tickets ?? null;
  return (
    <Panel id="tWip" title="Tickets in progress" sub={`step per day · last ${FLOW_DAYS} days`}>
      {!t ? (
        say(wait)
      ) : first < 0 ? (
        say("Not collected yet.")
      ) : (
        <div className="pb">
          <div className="chart" ref={ref}>
            <svg
              viewBox={`0 0 ${w} ${chartHeight}`}
              width="100%"
              height={chartHeight}
              preserveAspectRatio="xMinYMin meet"
              role="img"
              aria-label={`Tickets in progress: ${days
                .map((day) => `${narrowDay(day.day)} ${day.tickets ?? "not observed"}`)
                .join(", ")}`}
              {...keyStep(days.length, hover, setHover)}
            >
              <Grid max={top} ticks={[0, top / 2, top]} y={Y} x0={x0} x1={x1} label={String} />
              <XAxis y={yBottom} x0={x0} x1={x1} at={[]} />
              <path className="step" d={d} fill="none" stroke="var(--accent)" strokeWidth={2} />
              {days.map((day, i) => (
                <g key={day.day}>
                  {i % 2 === (days.length - 1) % 2 && (
                    <text
                      className="ct xl"
                      x={i === days.length - 1 ? x1 : mid(i)}
                      y={chartHeight - 3}
                      textAnchor={i === days.length - 1 ? "end" : "middle"}
                    >
                      {narrowDay(day.day)}
                    </text>
                  )}
                  <rect
                    x={x0 + i * slot}
                    y={PAD.t}
                    width={slot}
                    height={yBottom - PAD.t}
                    fill="transparent"
                    onPointerEnter={() => setHover(i)}
                    onPointerLeave={() => setHover(null)}
                  />
                </g>
              ))}
            </svg>
            {hover !== null && days[hover] && (
              <Tip
                x={mid(hover)}
                width={w}
                title={dayLabel((days[hover] as (typeof days)[number]).day)}
                rows={[
                  {
                    key: "n",
                    name: "In progress",
                    value:
                      (days[hover] as (typeof days)[number]).tickets === null
                        ? "not observed"
                        : String((days[hover] as (typeof days)[number]).tickets),
                  },
                ]}
              />
            )}
          </div>
          <KeyLegend
            items={[
              {
                key: "now",
                name: `Now ${now === null ? DASH : now}`,
                kind: "line",
                color: "var(--accent)",
              },
              { key: "peak", name: `Peak ${peak}`, kind: "line", color: "var(--muted)" },
              ...(first > 0
                ? [
                    {
                      key: "since",
                      name: `Collected from ${dayLabel(series?.[first]?.day ?? "")}`,
                      kind: "line" as const,
                      color: "var(--fg-2)",
                    },
                  ]
                : []),
            ]}
          />
        </div>
      )}
    </Panel>
  );
}

/** The Charts view: merged per day, cycle time per ticket and by size, tickets in progress. */
export function ThroughputCharts({
  t,
  wait,
  now,
  dim,
}: {
  t: Telemetry | undefined;
  wait: string;
  now: number;
  dim: boolean;
}) {
  return (
    <div className={`grid${dim ? " dim" : ""}`} data-view="charts" data-n="4">
      <MergedPerDay t={t} wait={wait} />
      <CycleDots t={t} wait={wait} now={now} />
      <CycleBySize t={t} wait={wait} />
      <TicketsInProgress t={t} wait={wait} />
    </div>
  );
}

/** The Table view: the tickets that finished, with their cycle time and cost. */
export function ThroughputTable({
  t,
  wait,
  dim,
}: {
  t: Telemetry | undefined;
  wait: string;
  dim: boolean;
}) {
  const tz = useTz();
  const costs = new Map(
    (t?.tokensByTicket ?? []).map((r) => [
      r.ticket,
      r.totalCostUsd === undefined ? r.costUsd : r.totalCostUsd,
    ]),
  );
  const rows = (t?.series?.tickets ?? [])
    .filter((k) => k.mergedAt !== null)
    .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0));
  return (
    <div className={`grid${dim ? " dim" : ""}`} data-view="table" data-n="1">
      <Panel
        id="tTickets"
        title="Tickets"
        sub={`merged in the last ${TICKET_DAYS} days`}
        className="tickets-panel"
      >
        {!t ? (
          say(wait)
        ) : rows.length === 0 ? (
          say(`No tickets merged in the last ${TICKET_DAYS} days.`)
        ) : (
          <div className="pb tw">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Title</th>
                  <th>Size</th>
                  <th className="r">Merged</th>
                  <th className="r">Cycle</th>
                  <th className="r">~Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((k) => {
                  const hash = k.ticket.lastIndexOf("#");
                  const n = Number(k.ticket.slice(hash + 1));
                  return (
                    <tr key={k.ticket}>
                      <td>
                        {hash > 0 && Number.isInteger(n) ? (
                          <a href={ticketPath(k.ticket.slice(0, hash), n)}>{k.ticket}</a>
                        ) : (
                          k.ticket
                        )}
                      </td>
                      <td>{k.title ?? "Title not on board"}</td>
                      <td>{k.size ?? DASH}</td>
                      <td className="r num">
                        {k.mergedAt !== null && tz ? dayMonth(k.mergedAt, tz) : DASH}
                      </td>
                      <td className="r num">
                        {k.readyAt !== null && k.doneAt !== null && k.doneAt >= k.readyAt
                          ? formatHours(k.doneAt - k.readyAt)
                          : DASH}
                      </td>
                      <td className="r num">{cost(costs.get(k.ticket))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
