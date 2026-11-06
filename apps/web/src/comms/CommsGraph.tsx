import { COMMS_MESSAGE_MAX, COMMS_METRICS, type CommsMetricsView, type CrewRow } from "@mc/core";
import { useMemo, useState } from "react";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { percent, plural } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { type CommsView, navigate } from "../router.ts";
import { type ChartMode, ChartModeSwitch, CommsRails } from "./CommsRails.tsx";
import { chartHref, commsHrefFor, useChartFilter } from "./chartPaths.ts";
import { useReducedMotion } from "./chartTypes.ts";
import { type ChartFilter, pairFilter } from "./commsFilter.ts";
import { TrafficChart, type TrafficHour } from "./TrafficChart.tsx";
import { CAPCOM, canonicalEndpoint, useChartData } from "./useChartData.ts";

type Hour = { from: string; to: string; count: number; hour: number };
type ChatterPair = {
  from: string;
  to: string;
  ticket: string;
  rounds: number;
  tokens?: number | null;
};

const HOUR = 60 * 60 * 1000;
/** Chatter watch lists a pair once it passes this many rounds on one thing. */
const CHATTER_ROUNDS = 6;

function inView(view: CommsView, flight: string, from: string, to: string): boolean {
  if (view.kind === "crew") return true;
  // Link telemetry is not ticket-scoped; keep its crew context for a ticket conversation.
  if (view.kind === "ticket") return true;
  if (view.kind === "flight")
    return (
      new Set([from, to]).size === 2 && [from, to].includes(flight) && [from, to].includes(CAPCOM)
    );
  if (view.kind === "agent" || view.kind === "inbox")
    return from === view.agentId || to === view.agentId;
  return (
    (from === view.agentId && to === view.contactId) ||
    (from === view.contactId && to === view.agentId)
  );
}

function scopeLabel(view: CommsView): string {
  if (view.kind === "crew") return "whole crew";
  if (view.kind === "ticket") return view.ticket ?? view.ref;
  if (view.kind === "flight") return "FLIGHT ↔ CAPCOM";
  if (view.kind === "contact") return `${view.agentId} ↔ ${view.contactId}`;
  if (view.kind === "inbox") return `${view.agentId}, inbox`;
  return `${view.agentId}, all contacts`;
}

/** The live crew's communication chart, with the traffic and message-length panels beneath it. */
export function CommsGraph({
  rows,
  flightId,
  view,
}: {
  rows: CrewRow[];
  flightId: string | undefined;
  view: CommsView;
}) {
  const hoursResource = useResource<{ hours: Hour[] }>(RESOURCES.commsTraffic);
  const hours = hoursResource.data?.hours;
  const chatter = useResource<{ pairs: ChatterPair[] }>(RESOURCES.commsChatter).data?.pairs;
  const lengthsResource = useResource<CommsMetricsView>(RESOURCES.commsMetrics);
  const lengths = lengthsResource.data?.p95BySeat;
  const [mode, setMode] = useState<ChartMode>("all");
  const reduced = useReducedMotion();
  const chart = useChartData(rows, flightId);
  const { flight, known, edges } = chart;
  const [filter, setFilter] = useChartFilter(known);

  // A click opens the conversation in the chat and keeps the chart narrowed to match.
  const pick = (next: ChartFilter) => navigate(commsHrefFor(next, flight));
  const traffic = edges.filter((edge) => inView(view, flight, edge.a, edge.b));
  const total = traffic.reduce((sum, edge) => sum + edge.aToB + edge.bToA, 0);

  const agentScope = view.kind === "agent" || view.kind === "inbox" || view.kind === "contact";
  const chartHours = useMemo<TrafficHour[]>(() => {
    const start = Math.floor(Date.now() / HOUR) * HOUR - 23 * HOUR;
    return Array.from({ length: 24 }, (_, index) => {
      const hour = start + index * HOUR;
      let all = 0;
      let part = 0;
      for (const entry of hours ?? []) {
        const from = canonicalEndpoint(entry.from, flight);
        const to = canonicalEndpoint(entry.to, flight);
        if (
          entry.hour !== hour ||
          !known.has(from) ||
          !known.has(to) ||
          from === to ||
          !inView(view, flight, from, to)
        )
          continue;
        all += entry.count;
        if (view.kind === "agent" || view.kind === "inbox" || view.kind === "contact") {
          if (from === view.agentId) part += entry.count;
        } else if (from === CAPCOM || to === CAPCOM) part += entry.count;
      }
      return { hour, total: all, part };
    });
  }, [flight, hours, known, view]);
  const peakHour = Math.max(0, ...chartHours.map((item) => item.total));
  const capcomCount = traffic.reduce(
    (sum, edge) => sum + (edge.a === CAPCOM || edge.b === CAPCOM ? edge.aToB + edge.bToA : 0),
    0,
  );
  const focused = agentScope ? view.agentId : null;
  const sent = focused
    ? traffic.reduce(
        (sum, edge) => sum + (edge.a === focused ? edge.aToB : edge.b === focused ? edge.bToA : 0),
        0,
      )
    : 0;
  const watched = useMemo(
    () =>
      (chatter ?? [])
        .map((entry) => ({
          ...entry,
          from: canonicalEndpoint(entry.from, flight),
          to: canonicalEndpoint(entry.to, flight),
        }))
        .filter((entry) => known.has(entry.from) && known.has(entry.to) && entry.from !== entry.to)
        .sort((a, b) => b.rounds - a.rounds),
    [chatter, flight, known],
  );
  const mostRounds = Math.max(CHATTER_ROUNDS * 2, ...watched.map((entry) => entry.rounds));
  const graphTotal = edges.reduce((sum, edge) => sum + edge.aToB + edge.bToA, 0);
  const graphLabel = `Comms chart, ${plural(rows.length, "seat")}, ${plural(graphTotal, "message")} in 24h${
    filter === null ? "" : ", narrowed"
  }`;

  return (
    <aside className="comms-right" aria-label="Comms activity">
      <Panel
        id="commsGraph"
        className="comms-graph-panel"
        title="Comms graph"
        sub="24h"
        actions={
          <>
            <ChartModeSwitch mode={mode} onChange={setMode} openCount={chart.openCount} />
            <a
              className="comms-popout"
              href={chartHref(filter)}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate(chartHref(filter));
              }}
              aria-label="Open the chart full screen"
              title="Open the chart full screen"
            >
              <span aria-hidden="true">⤢</span>
              <span className="comms-popout-text">Full screen</span>
            </a>
          </>
        }
      >
        <div className="comms-graph-readout" aria-hidden="true">
          {chart.streaming && (
            <span className="live">
              <i className="comms-live-dot" />
              Live
            </span>
          )}
          <span>
            <b>{edges.length}</b> links
          </span>
          <span>
            <b>{graphTotal}</b> msg
          </span>
          <span>
            <b>{chart.groups.length}</b> roles
          </span>
        </div>
        <div className="comms-graph-stage">
          <CommsRails
            seats={chart.seats}
            groups={chart.groups}
            hubIds={chart.hubIds}
            edges={edges}
            mode={mode}
            filter={filter}
            flows={chart.flows}
            reduced={reduced}
            label={graphLabel}
            full={false}
            onPickSeat={(id) => pick({ kind: "seat", id })}
            onPickLink={(a, b) => pick(pairFilter(a, b))}
            onClear={() => setFilter(null)}
          />
        </div>
        <div className="comms-watch">
          <div className="comms-watch-head">
            Chatter watch <span>· over {CHATTER_ROUNDS} rounds on one thing</span>
          </div>
          {watched.length === 0 ? (
            <p className="clear">Nothing over {CHATTER_ROUNDS} rounds in 24h.</p>
          ) : (
            watched.map((entry) => (
              <p key={`${entry.from}-${entry.to}-${entry.ticket}`}>
                <b>{`${entry.from} ↔ ${entry.to}`}</b> · {plural(entry.rounds, "round")} on{" "}
                {entry.ticket}
                {entry.tokens === undefined || entry.tokens === null
                  ? ""
                  : ` · ${entry.tokens.toLocaleString()} tokens`}
                <span className="comms-watch-bar" aria-hidden="true">
                  <i style={{ width: percent((entry.rounds / mostRounds) * 100, 3) }} />
                </span>
              </p>
            ))
          )}
        </div>
      </Panel>
      <Panel
        id="commsTraffic"
        className="comms-traffic-panel"
        title="Traffic"
        sub={`${scopeLabel(view)} · 24h`}
      >
        <div className={`comms-traffic-stats${total === 0 ? " zero" : ""}`}>
          {agentScope ? (
            <>
              <Stat value={total} unit="msg" label="messages" />
              <Stat value={sent} unit="msg" label="sent" tone="agent" />
              <Stat value={total - sent} unit="msg" label="received" />
              <Stat value={traffic.length} label={view.kind === "contact" ? "link" : "contacts"} />
            </>
          ) : (
            <>
              <Stat value={total} unit="msg" label="messages" />
              <Stat
                value={total ? percent(((total - capcomCount) / total) * 100) : "—"}
                label="agent↔agent"
                tone="think"
              />
              <Stat value={capcomCount} unit="msg" label="with CAPCOM" tone="accent" />
              <Stat value={peakHour} unit="/h" label="peak hour" />
            </>
          )}
        </div>
        {hours === undefined ? (
          <p className="comms-traffic-empty">Loading traffic…</p>
        ) : (
          <TrafficChart
            hours={chartHours}
            label={`Hourly messages over the last 24 hours, ${scopeLabel(view)}`}
            totalLabel="All messages"
            partLabel={agentScope ? `Sent by ${view.agentId}` : "With CAPCOM"}
            emptyText={`No messages in ${scopeLabel(view)} in the last 24h.`}
            live={hoursResource.error === null}
          />
        )}
      </Panel>
      <Panel
        id="commsLength"
        className="comms-length-panel"
        title={COMMS_METRICS.messageLengthP95.label}
        sub={`per sender · ${COMMS_METRICS.messageLengthP95.window} · limit ${COMMS_MESSAGE_MAX.toLocaleString()} ${COMMS_METRICS.messageLengthP95.unit}`}
      >
        {lengths === undefined && lengthsResource.error !== null ? (
          <p className="comms-traffic-empty" role="alert">
            Couldn't load message lengths. Retrying.
          </p>
        ) : lengths === undefined ? (
          <p className="comms-traffic-empty">Loading message lengths…</p>
        ) : (
          <>
            {lengthsResource.error !== null && (
              <p className="comms-length-stale" role="status">
                <i aria-hidden="true" />
                Stale · couldn't refresh. Retrying.
              </p>
            )}
            {lengths.length === 0 ? (
              <p className="comms-traffic-empty">No messages in the last 24h.</p>
            ) : (
              <ul className="comms-length-list" title={COMMS_METRICS.messageLengthP95.definition}>
                {[...lengths]
                  .sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1))
                  .map(({ seatId, p95, n }) => {
                    const row = rows.find((r) => r.id === seatId);
                    const level = lengthLevel(p95);
                    return (
                      <li key={seatId} className={level}>
                        <b>{row === undefined ? seatId : callSign(row)}</b>
                        <span className="comms-length-value">
                          {p95 === null ? "—" : Math.round(p95).toLocaleString()}
                          {level !== "" && (
                            <em>{level === "over" ? " over limit" : " near limit"}</em>
                          )}
                        </span>
                        <span className="comms-length-n">{n} msg</span>
                        <span className="comms-watch-bar" aria-hidden="true">
                          <i
                            style={{
                              width: percent(
                                Math.min(100, ((p95 ?? 0) / COMMS_MESSAGE_MAX) * 100),
                                0,
                              ),
                            }}
                          />
                        </span>
                      </li>
                    );
                  })}
              </ul>
            )}
          </>
        )}
      </Panel>
    </aside>
  );
}

/** Near the limit from 80% of it; over once the p95 passes it. */
const NEAR_LIMIT = 0.8;
function lengthLevel(p95: number | null): "" | "near" | "over" {
  if (p95 === null) return "";
  if (p95 > COMMS_MESSAGE_MAX) return "over";
  return p95 >= COMMS_MESSAGE_MAX * NEAR_LIMIT ? "near" : "";
}

function Stat({
  value,
  unit,
  label,
  tone,
}: {
  value: string | number;
  unit?: string;
  label: string;
  tone?: "agent" | "think" | "accent";
}) {
  return (
    <div className={value === 0 || value === "—" ? "nil" : ""}>
      <span className="comms-stat-figure">
        <strong className={tone ?? ""}>{value}</strong>
        {unit && <em>{unit}</em>}
      </span>
      <span>{label}</span>
    </div>
  );
}
