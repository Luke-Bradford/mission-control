import type { Crew } from "@mc/core";
import { useEffect, useState } from "react";
import { ChartPane } from "../comms/ChartPane.tsx";
import { type ChartMode, ChartModeSwitch, CommsRails } from "../comms/CommsRails.tsx";
import { useChartFilter } from "../comms/chartPaths.ts";
import { useReducedMotion } from "../comms/chartTypes.ts";
import { type ChartFilter, pairFilter, sameFilter } from "../comms/commsFilter.ts";
import { useChartData } from "../comms/useChartData.ts";
import { RESOURCES, useResource } from "../data.ts";
import type { FlightSeat } from "../flight/flightTypes.ts";
import { plural } from "../fmt.ts";
import { followLink, PAGE_PATHS } from "../router.ts";
import "../comms/comms.css";
import "../comms/CommsChartPage.css";

/**
 * The Comms chart on its own route, filling the window: the same chart as the panel, with a pane of
 * the filtered conversation beside it (there is no chat here). The route has its own address, so
 * it can sit in a second window or go browser full screen.
 */
export function CommsChartPage() {
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const flightSeat = useResource<{ seat: FlightSeat | null }>(RESOURCES.flight).data?.seat ?? null;
  const rows = crew?.rows ?? [];
  const chart = useChartData(rows, flightSeat?.id);
  const reduced = useReducedMotion();
  const [mode, setMode] = useState<ChartMode>("all");
  const [filter, setFilter] = useChartFilter(chart.known);
  const nameOf = (id: string) => chart.seats.find((s) => s.id === id)?.name ?? id;
  const total = chart.edges.reduce((sum, e) => sum + e.aToB + e.bToA, 0);
  const [isFull, setIsFull] = useState(() => document.fullscreenElement !== null);
  useEffect(() => {
    const change = () => setIsFull(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  const canFullscreen = typeof document.documentElement.requestFullscreen === "function";
  const back = PAGE_PATHS.comms;

  return (
    <section id="page-comms-chart" className="comms-chart-page">
      <h1 className="sr-only">Comms chart</h1>
      <header className="comms-chart-head">
        <a className="comms-back" href={back} onClick={(e) => followLink(e, back)}>
          ← Comms
        </a>
        <span className="comms-chart-title">Comms graph · 24h</span>
        <span className="comms-chart-sum">
          {plural(chart.edges.length, "link")} · {plural(total, "message")}
          {chart.streaming ? " · live" : ""}
        </span>
        <ChartModeSwitch mode={mode} onChange={setMode} openCount={chart.openCount} />
        {canFullscreen && (
          <button
            type="button"
            className="comms-popout"
            onClick={() =>
              isFull
                ? void document.exitFullscreen()
                : void document.documentElement.requestFullscreen()
            }
          >
            {isFull ? "Exit full screen" : "Browser full screen"}
          </button>
        )}
      </header>
      <div className={`comms-chart-body${filter ? " with-pane" : ""}`}>
        <div className="comms-chart-main">
          {crew === undefined ? (
            <p className="comms-chart-note">Loading the crew…</p>
          ) : (
            <CommsRails
              seats={chart.seats}
              groups={chart.groups}
              hubIds={chart.hubIds}
              edges={chart.edges}
              mode={mode}
              filter={filter}
              flows={chart.flows}
              reduced={reduced}
              label={`Comms chart, ${plural(rows.length, "seat")}, ${plural(total, "message")} in 24h`}
              full
              onPickSeat={(id) => {
                const next: ChartFilter = { kind: "seat", id };
                setFilter(sameFilter(filter, next) ? null : next);
              }}
              onPickLink={(a, b) => {
                const next = pairFilter(a, b);
                setFilter(sameFilter(filter, next) ? null : next);
              }}
              onClear={() => setFilter(null)}
            />
          )}
        </div>
        {filter && (
          <ChartPane filter={filter} flight={chart.flight} edges={chart.edges} nameOf={nameOf} />
        )}
      </div>
    </section>
  );
}
