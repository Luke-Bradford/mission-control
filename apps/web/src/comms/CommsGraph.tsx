import type { CrewRow } from "@mc/core";
import { useMemo, useState } from "react";
import { commsAgentPath, navigate, type CommsView } from "../router.ts";
import { CAPCOM, useChartData } from "./useChartData.ts";

type Point = { x: number; y: number };
const DAY = 24 * 60 * 60_000;

/** The living crew map. The chart hook is its live snapshot source. */
export function CommsGraph({ rows, flightId }: { rows: CrewRow[]; flightId: string | undefined; view: CommsView }) {
  const chart = useChartData(rows, flightId);
  const [full, setFull] = useState(false);
  const [pins, setPins] = useState<Record<string, Point>>({});
  const seats = useMemo(() => chart.seats.filter((seat) => seat.id !== CAPCOM && seat.id !== "crew"), [chart.seats]);
  const others = seats.filter((seat) => seat.id !== chart.flight);
  const pointFor = (id: string): Point => {
    if (pins[id]) return pins[id];
    if (id === chart.flight) return { x: 50, y: 50 };
    const index = others.findIndex((seat) => seat.id === id);
    const angle = (index / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
    return { x: 50 + Math.cos(angle) * 37, y: 50 + Math.sin(angle) * 37 };
  };
  const points = new Map(seats.map((seat) => [seat.id, pointFor(seat.id)]));
  const youngWaits = chart.edges.filter((edge) => edge.waiting && edge.waiting.ms < DAY);
  const drag = (id: string, event: React.PointerEvent<HTMLButtonElement>) => {
    const host = event.currentTarget.closest(".crew-map-stage");
    if (!host) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const box = host.getBoundingClientRect();
      setPins((old) => ({ ...old, [id]: { x: Math.max(7, Math.min(93, ((next.clientX - box.left) / box.width) * 100)), y: Math.max(9, Math.min(91, ((next.clientY - box.top) / box.height) * 100)) } }));
    };
    event.currentTarget.addEventListener("pointermove", move, { once: true });
  };
  return <aside className={`comms-right crew-map-host ${full ? "crew-map-full" : ""}`} aria-label="Comms activity">
    <section className="crew-map" aria-label="Crew map">
      <header className="crew-map-head"><h2>Crew map</h2><span role="status">{chart.streaming ? "LIVE" : "CONNECTING"}</span>
        <button type="button" aria-label={full ? "Close full screen map" : "Open the map full screen"} onClick={() => setFull(!full)}>{full ? "Close" : "Full"}</button>
      </header>
      <div className="crew-map-body">
        <div className="crew-map-stage" role="group" aria-label="FLIGHT at the centre; message links between seats">
          <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
            {[24, 37].map((radius) => <circle key={radius} cx="50" cy="50" r={radius} className="crew-map-orbit" />)}
            {chart.edges.map((edge) => { const a = points.get(edge.a), b = points.get(edge.b); return a && b ? <line key={edge.key} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`crew-map-link ${edge.waiting && edge.waiting.ms < DAY ? "warm" : ""}`} /> : null; })}
          </svg>
          {seats.map((seat) => {
            const point = points.get(seat.id) ?? pointFor(seat.id);
            const row = rows.find((candidate) => candidate.id === seat.id);
            const used = row?.digest?.contextTokens;
            const limit = row?.digest?.contextWindow ?? 150_000;
            const wait = youngWaits.some((edge) => edge.waiting?.owed === seat.id);
            const tool = row?.digest?.liveTool?.name ?? "no tool running";
            return <button key={seat.id} type="button" className={`crew-map-seat ${seat.id === chart.flight ? "flight" : ""} ${seat.presence} ${wait ? "owes" : ""}`} style={{ left: `${point.x}%`, top: `${point.y}%`, "--seat": seat.color } as React.CSSProperties} onClick={() => navigate(commsAgentPath(seat.id))} onPointerDown={(event) => drag(seat.id, event)} aria-label={`${seat.name}, ${seat.state ?? seat.presence}, ${used == null ? "context unknown" : `${Math.round(used / 1000)}K of ${Math.round(limit / 1000)}K context`}, ${tool}${wait ? ", owes a reply" : ""}`}>
              <i aria-hidden="true" /><b>{seat.name}</b><span>{seat.state ?? seat.presence}</span><small>{used == null ? "—" : `${Math.round(used / 1000)}K/${Math.round(limit / 1000)}K`} · {tool}</small>{wait && <em>reply</em>}
            </button>;
          })}
        </div>
        <div className="crew-map-side"><section><h3>Waiting on a reply</h3><ul>{youngWaits.length ? youngWaits.map((edge) => <li key={edge.key}>{edge.waiting?.asker} → {edge.waiting?.owed}</li>) : <li>Nobody owes a reply.</li>}</ul></section><section><h3>Seats</h3><ul>{seats.map((seat) => <li key={seat.id}>{seat.name} · {seat.state ?? seat.presence}</li>)}</ul></section></div>
      </div>
    </section>
  </aside>;
}
