import { COMMS_MESSAGE_MAX, COMMS_METRICS, type CommsMetricsView, type CrewRow } from "@mc/core";
import { useState } from "react";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { percent, plural } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { type CommsView, navigate } from "../router.ts";
import { type ChartMode, ChartModeSwitch, CommsRails } from "./CommsRails.tsx";
import { chartHref, commsHrefFor, useChartFilter } from "./chartPaths.ts";
import { useReducedMotion } from "./chartTypes.ts";
import { type ChartFilter, pairFilter } from "./commsFilter.ts";
import { useChartData } from "./useChartData.ts";

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
  void view;
  const lengthsResource = useResource<CommsMetricsView>(RESOURCES.commsMetrics);
  const lengths = lengthsResource.data?.p95BySeat;
  const [mode, setMode] = useState<ChartMode>("all");
  const reduced = useReducedMotion();
  const chart = useChartData(rows, flightId);
  const { flight, known, edges } = chart;
  const [filter, setFilter] = useChartFilter(known);

  // A click opens the conversation in the chat and keeps the chart narrowed to match.
  const pick = (next: ChartFilter) => navigate(commsHrefFor(next, flight));
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
        {chart.chartLoading && !chart.hasData ? (
          <p className="comms-traffic-empty">Loading comms graph…</p>
        ) : !chart.hasData ? (
          <p className="comms-traffic-empty" role="alert">
            Couldn't load comms graph. Retrying.
          </p>
        ) : (
          <>
            {chart.chartError && (
              <p className="comms-length-stale" role="status">
                Stale · couldn't refresh. Retrying.
              </p>
            )}
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
            <SignalLists chart={chart} pick={pick} />
          </>
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

/** "Waiting on a reply" and "Just said", shared by the panel and the full-screen chart. */
export function SignalLists({
  chart,
  pick,
  className = "",
}: {
  chart: ReturnType<typeof useChartData>;
  pick: (filter: ChartFilter) => void;
  className?: string;
}) {
  return (
    <div className={`comms-signal-lists ${className}`.trim()}>
      <MessageList
        title="Waiting on a reply"
        empty="Nobody owes a reply."
        note={chart.waitingNote}
        rows={chart.edges
          .filter((edge) => edge.waiting)
          .sort((a, b) => (b.waiting?.ms ?? 0) - (a.waiting?.ms ?? 0))
          .map((edge) => ({
            key: edge.key,
            label: `${edge.waiting?.asker} → ${edge.waiting?.owed ?? (edge.waiting?.asker === edge.a ? edge.b : edge.a)}`,
            age: edge.waiting?.ms ?? 0,
            text: edge.waiting?.question ?? "Reply requested",
            onClick: () => pick(pairFilter(edge.a, edge.b)),
          }))}
      />
      <MessageList
        title="Just said"
        empty="No direct messages yet."
        rows={chart.feed.slice(0, 5).map((message) => ({
          key: message.id,
          label: `${message.from} → ${message.to}`,
          text: message.text.split(/\r?\n/, 1)[0] || "Message",
          onClick: () => pick(pairFilter(message.from, message.to)),
        }))}
      />
    </div>
  );
}

export function MessageList({
  title,
  empty,
  note = null,
  rows,
}: {
  title: string;
  empty: string;
  /** Says, in words, that the rows may be missing or out of date. */
  note?: string | null;
  rows: readonly { key: string; label: string; text: string; age?: number; onClick: () => void }[];
}) {
  return (
    <section className="comms-signal-list" aria-label={title}>
      <h3>{title}</h3>
      {note !== null && <p role="status">{note}</p>}
      {rows.length === 0 ? (
        note === null && <p>{empty}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.key}>
              <button type="button" onClick={row.onClick}>
                <b>{row.label}</b>
                <span>{row.text}</span>
                {row.age !== undefined && <em>{Math.floor(row.age / 60_000)}m</em>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
