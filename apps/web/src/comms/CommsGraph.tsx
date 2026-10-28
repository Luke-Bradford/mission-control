import { COMMS_CREW, type CrewRow } from "@mc/core";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import {
  type CommsView,
  commsAgentPath,
  commsCrewPath,
  commsFlightPath,
  navigate,
} from "../router.ts";
import { TrafficChart, type TrafficHour } from "./TrafficChart.tsx";

type Link = { from: string; to: string; count: number };
type Hour = Link & { hour: number };
type Edge = { a: string; b: string; aToB: number; bToA: number };
type ChatterPair = {
  from: string;
  to: string;
  ticket: string;
  rounds: number;
  tokens?: number | null;
};

const HOUR = 60 * 60 * 1000;
const CAPCOM = "CAPCOM";
const MC = "MC";
/** Chatter watch lists a pair once it passes this many rounds on one thing. */
const CHATTER_ROUNDS = 6;

/** The graph's size before it is measured (and in tests, where nothing is laid out). */
const DEFAULT_SIZE = { w: 340, h: 300 };

/**
 * The graph's coordinate space is its measured box, so it fills whatever the panel gives it.
 * CAPCOM, FLIGHT and #crew sit on the vertical spine; seats with traffic sit on an ellipse round it.
 */
type Frame = { w: number; h: number; cx: number; cy: number; rx: number; ry: number };
type Point = { x: number; y: number };

function frameFor(size: { w: number; h: number }): Frame {
  const w = Math.max(240, size.w);
  const h = Math.max(220, size.h);
  return {
    w,
    h,
    cx: w / 2,
    cy: h / 2,
    rx: Math.min(w / 2 - 40, 200),
    ry: h / 2 - 34,
  };
}

function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** System reports belong to CAPCOM; historical FLIGHT reports follow the configured seat. */
function canonicalEndpoint(id: string, flight: string): string {
  if (id === MC) return CAPCOM;
  if (id === "FLIGHT") return flight;
  return id;
}

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

/** Seats on an ellipse round FLIGHT, alternating right and left, clear of the spine's hubs. */
function seatPositions(count: number, f: Frame): Point[] {
  const right = Math.ceil(count / 2);
  const left = count - right;
  const side = (n: number, mirror: boolean) =>
    Array.from({ length: n }, (_, index) => {
      const degrees = n === 1 ? 0 : -52 + (104 * index) / (n - 1);
      const angle = ((mirror ? 180 - degrees : degrees) * Math.PI) / 180;
      return { x: f.cx + f.rx * Math.cos(angle), y: f.cy + f.ry * Math.sin(angle) };
    });
  const r = side(right, false);
  const l = side(left, true);
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? (r[index / 2] as { x: number; y: number })
      : (l[(index - 1) / 2] as { x: number; y: number }),
  );
}

/** A spoke from FLIGHT is straight; every other link bows away from the centre. */
function edgeGeometry(a: Point, b: Point, straight: boolean, avoid: Point[], f: Frame) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  let nx = -dy / length;
  let ny = dx / length;
  if (nx * (mx - f.cx) + ny * (my - f.cy) < 0) {
    nx = -nx;
    ny = -ny;
  }
  const bend = straight ? 0 : length * 0.16;
  const cx = mx + nx * bend;
  const cy = my + ny * bend;
  const at = (t: number) => ({
    x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * cx + t ** 2 * b.x,
    y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * cy + t ** 2 * b.y,
  });
  // The count sits mid-link unless a node or its label is there; then it slides along the link.
  const clear = (p: Point) =>
    avoid.every((node) => Math.abs(p.x - node.x) > 44 || p.y < node.y - 16 || p.y > node.y + 26);
  // Along the link first, then just off it on the outer side for a short, crowded link.
  const candidates = [0, 12].flatMap((off) =>
    [0.5, 0.4, 0.6, 0.32, 0.68].map((t) => {
      const p = at(t);
      return { x: p.x + nx * off, y: p.y + ny * off };
    }),
  );
  const room = (p: Point) =>
    Math.min(...avoid.map((node) => Math.hypot(p.x - node.x, p.y - (node.y + 8))));
  const label =
    candidates.find(clear) ??
    candidates.reduce((best, p) => (room(p) > room(best) ? p : best), at(0.5));
  return {
    d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
    label,
  };
}

const pct = (value: number, of: number) => `${Number(((value / of) * 100).toFixed(3))}%`;

/** The live crew's communication map. Token telemetry is intentionally optional until #T3 lands. */
export function CommsGraph({
  rows,
  flightId,
  view,
}: {
  rows: CrewRow[];
  flightId: string | undefined;
  view: CommsView;
}) {
  const links = useResource<{ links: Link[] }>(RESOURCES.commsLinks).data?.links;
  const hours = useResource<{ hours: Hour[] }>(RESOURCES.commsTraffic).data?.hours;
  const chatter = useResource<{ pairs: ChatterPair[] }>(RESOURCES.commsChatter).data?.pairs;
  const [metric, setMetric] = useState<"messages" | "tokens">("messages");
  const [liveEdges, setLiveEdges] = useState<Set<string>>(() => new Set());
  const previousCounts = useRef<Map<string, number> | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(DEFAULT_SIZE);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box && box.width > 0 && box.height > 0)
        setSize({ w: Math.round(box.width), h: Math.round(box.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const crewRows = useMemo(() => rows.filter((row) => row.kind === "crew"), [rows]);
  const flight = flightId ?? crewRows.find((row) => row.role === "FLIGHT")?.id ?? "FLIGHT";
  const known = useMemo(
    () => new Set([CAPCOM, COMMS_CREW, flight, ...crewRows.map((row) => row.id)]),
    [crewRows, flight],
  );
  const edges = useMemo(() => {
    const combined = new Map<string, Edge>();
    for (const link of links ?? []) {
      const from = canonicalEndpoint(link.from, flight);
      const to = canonicalEndpoint(link.to, flight);
      if (!known.has(from) || !known.has(to) || from === to) continue;
      const [a, b] = pair(from, to);
      const value = combined.get(`${a}\0${b}`) ?? { a, b, aToB: 0, bToA: 0 };
      if (from === a) value.aToB += link.count;
      else value.bToA += link.count;
      combined.set(`${a}\0${b}`, value);
    }
    return [...combined.values()];
  }, [flight, known, links]);
  useEffect(() => {
    if (links === undefined) return;
    const current = new Map(
      edges.map((edge) => [`${edge.a}\0${edge.b}`, edge.aToB + edge.bToA] as const),
    );
    const previous = previousCounts.current;
    previousCounts.current = current;
    if (previous === null) return;
    const increased = new Set(
      [...current].flatMap(([key, count]) => (count > (previous.get(key) ?? 0) ? [key] : [])),
    );
    if (increased.size === 0) return;
    setLiveEdges(increased);
    const timer = window.setTimeout(() => setLiveEdges(new Set()), 1_800);
    return () => window.clearTimeout(timer);
  }, [edges, links]);
  const scoped = edges.filter((edge) => inView(view, flight, edge.a, edge.b));
  const total = scoped.reduce((sum, edge) => sum + edge.aToB + edge.bToA, 0);
  const focusedView = view.kind !== "crew" && view.kind !== "ticket";
  const selected = new Set(
    view.kind === "crew"
      ? []
      : view.kind === "ticket"
        ? []
        : view.kind === "flight"
          ? [flight, CAPCOM]
          : view.kind === "contact"
            ? [view.agentId, view.contactId]
            : [view.agentId],
  );
  const active = new Set([...selected, ...scoped.flatMap((edge) => [edge.a, edge.b])]);
  const countOf = (id: string) =>
    edges
      .filter((edge) => edge.a === id || edge.b === id)
      .reduce((sum, edge) => sum + edge.aToB + edge.bToA, 0);
  const seats = crewRows.filter((row) => row.id !== flight);
  // A seat with no traffic in the window waits on the standby rack unless the page is about it.
  const onGraph = seats.filter((row) => countOf(row.id) > 0 || selected.has(row.id));
  const standby = seats.filter((row) => !onGraph.includes(row));
  const f = frameFor(size);
  const seatPoints = seatPositions(onGraph.length, f);
  const busiest = Math.max(1, ...onGraph.map((row) => countOf(row.id)));
  const liveIds = new Set(
    edges
      .filter((edge) => liveEdges.has(`${edge.a}\0${edge.b}`))
      .flatMap((edge) => [edge.a, edge.b]),
  );
  const rowOf = (id: string) => crewRows.find((candidate) => candidate.id === id);
  const inactive = (row: CrewRow | undefined) =>
    row !== undefined && (row.paused || row.crewPause != null || row.hudState === "stopped");
  type GraphNode = {
    id: string;
    label: string;
    x: number;
    y: number;
    hub: boolean;
    count: number;
    color: string;
  };
  const nodes: GraphNode[] = [
    { id: CAPCOM, label: CAPCOM, x: f.cx, y: f.cy - f.ry, hub: true, color: "var(--fg)" },
    { id: flight, label: "FLIGHT", x: f.cx, y: f.cy, hub: true, color: "var(--accent)" },
    { id: COMMS_CREW, label: "#crew", x: f.cx, y: f.cy + f.ry, hub: true, color: "var(--fg-2)" },
    ...onGraph.map((row, index) => ({
      id: row.id,
      label: row.id,
      x: seatPoints[index]?.x ?? f.cx,
      y: seatPoints[index]?.y ?? f.cy,
      hub: false,
      color: agentColor(row.index),
    })),
  ].map((node) => ({ ...node, count: countOf(node.id) }));
  const point = new Map(nodes.map((node) => [node.id, node]));
  const heaviest = Math.max(1, ...edges.map((edge) => edge.aToB + edge.bToA));
  const hasData = links !== undefined;
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
  const capcomCount = scoped.reduce(
    (sum, edge) => sum + (edge.a === CAPCOM || edge.b === CAPCOM ? edge.aToB + edge.bToA : 0),
    0,
  );
  const focused = agentScope ? view.agentId : null;
  const sent = focused
    ? scoped.reduce(
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
  const graphLabel = `Comms graph, ${crewRows.length} live seats, ${total} messages in view (${scopeLabel(view)})`;
  const open = (id: string) =>
    navigate(
      id === CAPCOM || id === flight
        ? commsFlightPath()
        : id === COMMS_CREW
          ? commsCrewPath()
          : commsAgentPath(id),
    );
  const nodeClass = (id: string, extra: string) =>
    `comms-node${extra}${active.size === 0 || active.has(id) ? "" : " dim"}${inactive(rowOf(id)) ? " inactive" : ""}${selected.has(id) ? " selected" : ""}${liveIds.has(id) ? " live" : ""}`;

  return (
    <aside className="comms-right" aria-label="Comms activity">
      <Panel
        id="commsGraph"
        className="comms-graph-panel"
        title="Comms graph"
        sub="24h"
        actions={
          <fieldset className="comms-metric">
            <legend className="sr-only">Measure links by</legend>
            <button
              type="button"
              className={metric === "messages" ? "on" : ""}
              onClick={() => setMetric("messages")}
              aria-pressed={metric === "messages"}
            >
              Msgs
            </button>
            <button
              type="button"
              className={metric === "tokens" ? "on" : ""}
              onClick={() => setMetric("tokens")}
              aria-pressed={metric === "tokens"}
            >
              Tokens
            </button>
          </fieldset>
        }
      >
        <div className="comms-graph-readout" aria-hidden="true">
          <span className="live">
            <i className="comms-live-dot" />
            Live
          </span>
          <span>
            <b>{edges.length}</b> links
          </span>
          <span>
            <b>{edges.reduce((sum, edge) => sum + edge.aToB + edge.bToA, 0)}</b> msg
          </span>
          <span>
            <b>{onGraph.length}</b>/{seats.length} seats talking
          </span>
        </div>
        <div className="comms-graph-stage" ref={stage}>
          <div
            className={`comms-graph${metric === "tokens" ? " tokens" : ""}`}
            role="img"
            aria-label={graphLabel}
          >
            <svg className="comms-graph-links" viewBox={`0 0 ${f.w} ${f.h}`} aria-hidden="true">
              <ellipse className="comms-graph-orbit" cx={f.cx} cy={f.cy} rx={f.rx} ry={f.ry} />
              <line
                className="comms-graph-spine"
                x1={f.cx}
                x2={f.cx}
                y1={f.cy - f.ry}
                y2={f.cy + f.ry}
              />
              {edges.map((edge) => {
                const a = point.get(edge.a);
                const b = point.get(edge.b);
                if (!a || !b) return null;
                const count = edge.aToB + edge.bToA;
                const weight = Math.sqrt(count / heaviest);
                const lit = scoped.includes(edge);
                const watching = watched.some(
                  (entry) =>
                    (entry.from === edge.a && entry.to === edge.b) ||
                    (entry.from === edge.b && entry.to === edge.a),
                );
                const live = liveEdges.has(`${edge.a}\0${edge.b}`);
                const geometry = edgeGeometry(
                  a,
                  b,
                  edge.a === flight || edge.b === flight,
                  nodes,
                  f,
                );
                return (
                  <g
                    key={`${edge.a}-${edge.b}`}
                    className={`comms-edge${lit ? (focusedView ? " active focus" : " active") : " dim"}${watching ? " watching" : ""}${live ? " live" : ""}`}
                    style={{ "--w": weight.toFixed(3) } as CSSProperties}
                  >
                    <title>{`${a.label} → ${b.label}: ${edge.aToB} · ${b.label} → ${a.label}: ${edge.bToA}`}</title>
                    <path
                      className="comms-edge-line"
                      d={geometry.d}
                      strokeWidth={metric === "tokens" ? 1 : 1 + 3 * weight}
                    />
                    {live && <path className="comms-edge-pulse" d={geometry.d} pathLength={100} />}
                    {metric === "messages" && (
                      <text
                        className="comms-edge-count"
                        x={geometry.label.x}
                        y={geometry.label.y}
                        dy="0.34em"
                        textAnchor="middle"
                      >
                        {count}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {nodes.map((node) => {
              const heat = node.count === 0 ? 0 : Math.sqrt(node.count / busiest);
              return (
                <button
                  key={node.id}
                  type="button"
                  className={nodeClass(
                    node.id,
                    `${node.hub ? " hub" : ""}${node.count === 0 ? " quiet" : ""}`,
                  )}
                  style={
                    {
                      left: pct(node.x, f.w),
                      top: pct(node.y, f.h),
                      "--node-color": node.color,
                      "--heat": heat.toFixed(3),
                    } as CSSProperties
                  }
                  onClick={() => open(node.id)}
                  aria-label={`Open ${node.label}, ${node.count} messages in 24h`}
                >
                  <span className="comms-node-dot" aria-hidden="true" />
                  <span className="comms-node-label" aria-hidden="true">
                    <b className="comms-node-name">{node.label}</b>
                    <em className="comms-node-count">{node.count}</em>
                  </span>
                </button>
              );
            })}
            {hasData && edges.length === 0 && (
              <p className="comms-empty">No direct messages in the last 24h.</p>
            )}
            {metric === "tokens" && (
              <p className="comms-token-empty">Token totals are not available yet.</p>
            )}
          </div>
        </div>
        {standby.length > 0 && (
          <div className="comms-standby">
            <span className="comms-standby-head">
              Quiet 24h <b>{standby.length}</b>
            </span>
            <div className="comms-standby-seats">
              {standby.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={nodeClass(row.id, " idle")}
                  style={{ "--node-color": agentColor(row.index) } as CSSProperties}
                  onClick={() => open(row.id)}
                  aria-label={`Open ${row.id}, 0 messages in 24h`}
                  title={inactive(row) ? `${row.id} · paused` : row.id}
                >
                  <span className="comms-node-dot" aria-hidden="true" />
                  <span aria-hidden="true">{row.id}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="comms-watch">
          <div className="comms-watch-head">
            Chatter watch <span>· over {CHATTER_ROUNDS} rounds on one thing</span>
          </div>
          {watched.length === 0 ? (
            <p className="clear">Nothing over {CHATTER_ROUNDS} rounds in 24h.</p>
          ) : (
            watched.map((entry) => (
              <p key={`${entry.from}-${entry.to}-${entry.ticket}`}>
                <b>{`${entry.from} ↔ ${entry.to}`}</b> · {entry.rounds} rounds on {entry.ticket}
                {entry.tokens === undefined || entry.tokens === null
                  ? ""
                  : ` · ${entry.tokens.toLocaleString()} tokens`}
                <span className="comms-watch-bar" aria-hidden="true">
                  <i style={{ width: pct(entry.rounds, mostRounds) }} />
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
              <Stat value={scoped.length} label={view.kind === "contact" ? "link" : "contacts"} />
            </>
          ) : (
            <>
              <Stat value={total} unit="msg" label="messages" />
              <Stat
                value={total ? `${Math.round(((total - capcomCount) / total) * 100)}%` : "—"}
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
          />
        )}
      </Panel>
    </aside>
  );
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
