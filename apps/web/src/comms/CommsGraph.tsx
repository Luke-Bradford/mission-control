import type { CrewRow } from "@mc/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { type CommsView, commsAgentPath, navigate } from "../router.ts";
import { useReducedMotion } from "./chartTypes.ts";
import { pairFilter, searchWithFocus } from "./commsFilter.ts";
import { CAPCOM, useChartData } from "./useChartData.ts";

type Point = { x: number; y: number };
const TRAVEL_LIGHTS = ["first", "second", "third"] as const;

/** A hidden tab must not keep a live visual running. */
function useDocumentVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible;
}

/** The living crew map. The chart hook is its live snapshot source. */
export function CommsGraph({
  rows,
  flightId,
}: {
  rows: CrewRow[];
  flightId: string | undefined;
  view: CommsView;
}) {
  const chart = useChartData(rows, flightId);
  const [full, setFull] = useState(false);
  const [pins, setPins] = useState<{ panel: Record<string, Point>; full: Record<string, Point> }>({
    panel: {},
    full: {},
  });
  const dragStart = useRef<{ id: string; x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const visible = useDocumentVisible();
  const reducedMotion = useReducedMotion();
  const seats = useMemo(() => chart.seats.filter((seat) => seat.id !== "crew"), [chart.seats]);
  const others = seats.filter((seat) => seat.id !== chart.flight && seat.id !== CAPCOM);
  const crewSeats = seats.filter((seat) => seat.id !== CAPCOM);
  const crowded = others.length > 12;
  const pointFor = (id: string): Point => {
    const pinSet = full ? pins.full : pins.panel;
    if (pinSet[id]) return pinSet[id];
    if (id === chart.flight) return { x: 50, y: 50 };
    if (id === CAPCOM) return { x: 50, y: 8 };
    const index = others.findIndex((seat) => seat.id === id);
    if (crowded) {
      const rows = Math.ceil(others.length / 2);
      return {
        x: index % 2 === 0 ? 12 : 88,
        y: (Math.floor(index / 2) + 0.5) * (100 / rows),
      };
    }
    const angle = (index / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
    return { x: 50 + Math.cos(angle) * 37, y: 50 + Math.sin(angle) * 37 };
  };
  const points = new Map(seats.map((seat) => [seat.id, pointFor(seat.id)]));
  const youngWaits = chart.edges.filter((edge) => (edge.waiting?.young ?? 0) > 0);
  const oldWaitCount = chart.edges.reduce((count, edge) => count + (edge.waiting?.old ?? 0), 0);
  const drag = (id: string, event: React.PointerEvent<HTMLButtonElement>) => {
    const host = event.currentTarget.closest(".crew-map-stage");
    if (!host) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragged.current = false;
    dragStart.current = { id, x: event.clientX, y: event.clientY };
  };
  const move = (event: React.PointerEvent<HTMLButtonElement>) => {
    const active = dragStart.current;
    const host = event.currentTarget.closest(".crew-map-stage");
    if (!active || !host) return;
    if (Math.abs(active.x - event.clientX) + Math.abs(active.y - event.clientY) > 4)
      dragged.current = true;
    const box = host.getBoundingClientRect();
    const pin: Point = {
      x: Math.max(7, Math.min(93, ((event.clientX - box.left) / box.width) * 100)),
      y: Math.max(9, Math.min(91, ((event.clientY - box.top) / box.height) * 100)),
    };
    setPins((old) =>
      full
        ? { ...old, full: { ...old.full, [active.id]: pin } }
        : { ...old, panel: { ...old.panel, [active.id]: pin } },
    );
  };
  return (
    <aside
      className={`comms-right crew-map-host ${full ? "crew-map-full" : ""}`}
      aria-label="Comms activity"
    >
      <section className="crew-map" aria-label="Crew map">
        <header className="crew-map-head">
          <h2>Crew map</h2>
          <span role="status">{chart.streaming ? "LIVE" : "CONNECTING"}</span>
          <button
            type="button"
            aria-label={full ? "Close full screen map" : "Open the map full screen"}
            onClick={() => setFull(!full)}
          >
            {full ? "Close" : "Full"}
          </button>
        </header>
        <div className="crew-map-body">
          <fieldset
            className={`crew-map-stage ${crowded ? "crowded" : ""} ${visible ? "" : "paused"}`}
            aria-label="FLIGHT at the centre; message links between seats"
          >
            <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
              {[24, 37].map((radius) => (
                <circle key={radius} cx="50" cy="50" r={radius} className="crew-map-orbit" />
              ))}
              {chart.edges.map((edge) => {
                const a = points.get(edge.a),
                  b = points.get(edge.b);
                return a && b ? (
                  <line
                    key={edge.key}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className={`crew-map-link ${edge.aToB + edge.bToA > 0 || (edge.waiting?.young ?? 0) > 0 ? "warm" : ""}`}
                  />
                ) : null;
              })}
            </svg>
            {visible &&
              !reducedMotion &&
              chart.flows.list.flatMap((flow) => {
                const from = points.get(flow.from);
                const to = points.get(flow.to);
                const sender = seats.find((seat) => seat.id === flow.from);
                if (!from || !to || !sender) return [];
                return TRAVEL_LIGHTS.slice(0, Math.min(flow.n, TRAVEL_LIGHTS.length)).map(
                  (light, index) => (
                    <i
                      aria-hidden="true"
                      className="crew-map-travel"
                      key={`${chart.flows.generation}-${flow.from}-${flow.to}-${light}`}
                      style={
                        {
                          left: `${from.x}%`,
                          top: `${from.y}%`,
                          "--travel-to-x": `${to.x}%`,
                          "--travel-to-y": `${to.y}%`,
                          "--seat": sender.color,
                          animationDelay: `${index * 120}ms`,
                        } as React.CSSProperties
                      }
                    />
                  ),
                );
              })}
            {seats.map((seat) => {
              const point = points.get(seat.id) ?? pointFor(seat.id);
              const row = rows.find((candidate) => candidate.id === seat.id);
              const used = row?.digest?.contextTokens;
              const limit = row?.digest?.contextWindow ?? 150_000;
              const wait = youngWaits.some((edge) => edge.waiting?.youngOwed === seat.id);
              const tool = row?.digest?.liveTool?.name ?? "no tool running";
              return (
                <button
                  key={seat.id}
                  type="button"
                  className={`crew-map-seat ${seat.id === chart.flight ? "flight" : ""} ${seat.presence} ${row?.hudState === "blocked" || row?.hudState === "stalled" || row?.hudState === "error" ? "held" : ""} ${wait ? "owes" : ""}`}
                  style={
                    {
                      left: `${point.x}%`,
                      top: `${point.y}%`,
                      "--seat": seat.color,
                    } as React.CSSProperties
                  }
                  onClick={() => {
                    if (!dragged.current) navigate(commsAgentPath(seat.id));
                  }}
                  onPointerDown={(event) => drag(seat.id, event)}
                  onPointerMove={move}
                  onPointerUp={() => {
                    dragStart.current = null;
                  }}
                  aria-label={`${seat.name}, ${seat.state ?? seat.presence}, ${used == null ? "context unknown" : `${Math.round(used / 1000)}K of ${Math.round(limit / 1000)}K context`}, ${tool}${wait ? ", owes a reply" : ""}`}
                >
                  <i aria-hidden="true" />
                  <b>{seat.name}</b>
                  <span>{seat.state ?? seat.presence}</span>
                  <small>
                    {used == null
                      ? "—"
                      : `${Math.round(used / 1000)}K/${Math.round(limit / 1000)}K`}{" "}
                    · {tool}
                  </small>
                  {wait && <em>reply</em>}
                </button>
              );
            })}
          </fieldset>
          <div className="crew-map-side">
            <section>
              <h3>Waiting on a reply</h3>
              <ul>
                {chart.waitingNote && <li className="crew-map-wait-note">{chart.waitingNote}</li>}
                {youngWaits.length ? (
                  youngWaits.map((edge) => (
                    <li key={edge.key}>
                      <button
                        type="button"
                        onClick={() =>
                          navigate(
                            window.location.pathname +
                              searchWithFocus(
                                "",
                                pairFilter(
                                  edge.waiting?.youngAsker ?? edge.a,
                                  edge.waiting?.youngOwed ?? edge.b,
                                ),
                              ),
                          )
                        }
                      >
                        {edge.waiting?.youngAsker} → {edge.waiting?.youngOwed}
                      </button>
                      {edge.waiting?.old ? <small>{edge.waiting.old} older</small> : null}
                    </li>
                  ))
                ) : chart.waitingNote ? null : (
                  <li>
                    Nobody owes a reply.
                    {oldWaitCount
                      ? ` ${oldWaitCount} older ask${oldWaitCount === 1 ? "" : "s"}.`
                      : ""}
                  </li>
                )}
              </ul>
            </section>
            <section>
              <h3>Seats</h3>
              <ul>
                {crewSeats.map((seat) =>
                  (() => {
                    const row = rows.find((candidate) => candidate.id === seat.id);
                    const used = row?.digest?.contextTokens;
                    const limit = row?.digest?.contextWindow ?? 150_000;
                    const tool = row?.digest?.liveTool?.name ?? "no tool running";
                    const context =
                      used == null
                        ? "context unknown"
                        : `${Math.round(used / 1000)}K of ${Math.round(limit / 1000)}K context`;
                    return (
                      <li key={seat.id}>
                        <button
                          type="button"
                          aria-label={`${seat.name}, ${seat.state ?? seat.presence}, ${context}, ${tool}`}
                          onClick={() => navigate(commsAgentPath(seat.id))}
                        >
                          <b>
                            {seat.name} · {seat.state ?? seat.presence}
                          </b>
                          <small>{context}</small>
                          <small>{tool}</small>
                        </button>
                      </li>
                    );
                  })(),
                )}
              </ul>
            </section>
          </div>
        </div>
      </section>
    </aside>
  );
}
