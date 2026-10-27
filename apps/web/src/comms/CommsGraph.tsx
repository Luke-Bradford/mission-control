import type { CrewRow } from "@mc/core";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { type CommsView, commsAgentPath, commsFlightPath, navigate } from "../router.ts";

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

function hourLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", hour12: false });
}

function visibleDots(edge: Edge, start: string, end: string, color: string, lit: boolean) {
  const count = start === edge.a ? edge.aToB : edge.bToA;
  const dots = Math.min(8, Math.max(0, Math.ceil(count / 3)));
  return Array.from({ length: dots }, (_, i) => ({
    key: `${start}-${end}-${i}`,
    color,
    delay: `${-(i / Math.max(dots, 1)) * Math.max(1.25, 4.5 - count / 10)}s`,
    duration: `${Math.max(1.25, 4.5 - count / 10)}s`,
    dim: !lit,
  }));
}

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
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const crewRows = useMemo(() => rows.filter((row) => row.kind === "crew"), [rows]);
  const flight = flightId ?? crewRows.find((row) => row.role === "FLIGHT")?.id ?? "FLIGHT";
  const known = useMemo(
    () => new Set([CAPCOM, flight, ...crewRows.map((row) => row.id)]),
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
  const scoped = edges.filter((edge) => inView(view, flight, edge.a, edge.b));
  const total = scoped.reduce((sum, edge) => sum + edge.aToB + edge.bToA, 0);
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
  const ring = [CAPCOM, ...crewRows.map((row) => row.id).filter((id) => id !== flight)];
  const nodes = [flight, ...ring].map((id, index) => {
    const ringIndex = index - 1;
    const radius = ring.length > 7 ? 128 : 112;
    const angle = ringIndex < 0 ? 0 : -Math.PI / 2 + (2 * Math.PI * ringIndex) / ring.length;
    const row = crewRows.find((candidate) => candidate.id === id);
    const count = edges
      .filter((edge) => edge.a === id || edge.b === id)
      .reduce((sum, edge) => sum + edge.aToB + edge.bToA, 0);
    return {
      id,
      label: id === flight ? "FLIGHT" : id,
      x: id === flight ? 170 : 170 + radius * Math.cos(angle),
      y: id === flight ? 160 : 160 + radius * Math.sin(angle),
      count,
      color:
        id === CAPCOM ? "var(--fg)" : id === flight ? "var(--accent)" : agentColor(row?.index ?? 0),
      lit: active.size === 0 || active.has(id),
      inactive:
        row !== undefined && (row.paused || row.crewPause != null || row.hudState === "stopped"),
    };
  });
  const point = new Map(nodes.map((node) => [node.id, node]));
  const hasData = links !== undefined;
  const chartHours = useMemo(() => {
    const start = Math.floor(Date.now() / HOUR) * HOUR - 23 * HOUR;
    return Array.from({ length: 24 }, (_, index) => {
      const hour = start + index * HOUR;
      let agent = 0;
      let capcom = 0;
      let sent = 0;
      let received = 0;
      for (const entry of hours ?? []) {
        const from = canonicalEndpoint(entry.from, flight);
        const to = canonicalEndpoint(entry.to, flight);
        if (
          entry.hour !== hour ||
          !known.has(from) ||
          !known.has(to) ||
          !inView(view, flight, from, to)
        )
          continue;
        if (view.kind === "agent" || view.kind === "inbox" || view.kind === "contact") {
          if (from === view.agentId) sent += entry.count;
          if (to === view.agentId) received += entry.count;
        } else if (from === CAPCOM || to === CAPCOM) capcom += entry.count;
        else agent += entry.count;
      }
      return { hour, agent, capcom, sent, received };
    });
  }, [flight, hours, known, view]);
  const agentScope = view.kind === "agent" || view.kind === "inbox" || view.kind === "contact";
  const peak = Math.max(
    1,
    ...chartHours.map((item) =>
      agentScope ? item.sent + item.received : item.agent + item.capcom,
    ),
  );
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
  const graphLabel = `Comms graph, ${crewRows.length} live seats, ${total} messages in view (${scopeLabel(view)})`;

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
        <div
          className={`comms-graph${hidden ? " paused" : ""}${metric === "tokens" ? " tokens" : ""}`}
          role="img"
          aria-label={graphLabel}
        >
          {edges.map((edge) => {
            const a = point.get(edge.a);
            const b = point.get(edge.b);
            if (!a || !b) return null;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const length = Math.hypot(dx, dy);
            const lit = scoped.includes(edge);
            const watching = watched.some(
              (entry) =>
                (entry.from === edge.a && entry.to === edge.b) ||
                (entry.from === edge.b && entry.to === edge.a),
            );
            const width = metric === "tokens" ? 1 : 1 + Math.min(5, (edge.aToB + edge.bToA) / 8);
            const dots = [
              ...visibleDots(edge, edge.a, edge.b, a.color, lit),
              ...visibleDots(edge, edge.b, edge.a, b.color, lit),
            ];
            return (
              <div
                key={`${edge.a}-${edge.b}`}
                className={`comms-edge${lit ? " active" : " dim"}${watching ? " watching" : ""}`}
              >
                <span
                  className="comms-edge-line"
                  style={{
                    left: a.x,
                    top: a.y,
                    width: length,
                    height: width,
                    transform: `rotate(${Math.atan2(dy, dx)}rad)`,
                  }}
                />
                <span
                  className="comms-edge-count"
                  style={{ left: a.x + dx / 2, top: a.y + dy / 2 }}
                >
                  {metric === "messages" ? edge.aToB + edge.bToA : "—"}
                </span>
                {metric === "messages" &&
                  dots.map((dot) => {
                    const reverse = dot.key.startsWith(`${edge.b}-`);
                    const origin = reverse ? b : a;
                    return (
                      <span
                        key={dot.key}
                        className={`comms-edge-run${dot.dim ? " dim" : ""}`}
                        style={{
                          left: origin.x,
                          top: origin.y,
                          width: length,
                          transform: `rotate(${reverse ? Math.atan2(-dy, -dx) : Math.atan2(dy, dx)}rad)`,
                        }}
                      >
                        <i
                          className="comms-edge-dot"
                          style={{
                            background: dot.color,
                            animationDelay: dot.delay,
                            animationDuration: dot.duration,
                          }}
                        />
                      </span>
                    );
                  })}
              </div>
            );
          })}
          {nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className={`comms-node${node.lit ? "" : " dim"}${node.inactive ? " inactive" : ""}${selected.has(node.id) ? " selected" : ""}`}
              style={
                {
                  left: node.x,
                  top: node.y,
                  "--node-color": node.color,
                  "--count": Math.min(node.count, 16),
                } as CSSProperties
              }
              onClick={() =>
                navigate(
                  node.id === CAPCOM || node.id === flight
                    ? commsFlightPath()
                    : commsAgentPath(node.id),
                )
              }
              aria-label={`Open ${node.label}, ${node.count} messages in 24h`}
            >
              <span>{node.count}</span>
              <small>{node.label}</small>
            </button>
          ))}
          {hasData && edges.length === 0 && (
            <p className="comms-empty">No direct messages in the last 24h.</p>
          )}
          {metric === "tokens" && (
            <p className="comms-token-empty">Token totals are not available yet.</p>
          )}
        </div>
        <div className="comms-watch">
          <div>
            Chatter watch <span>· over 6 rounds on one thing</span>
          </div>
          {watched.length === 0 ? (
            <p>Nothing over 6 rounds in 24h.</p>
          ) : (
            watched.map((entry) => (
              <p key={`${entry.from}-${entry.to}-${entry.ticket}`}>
                <b>{`${entry.from} ↔ ${entry.to}`}</b> · {entry.rounds} rounds on {entry.ticket}
                {entry.tokens === undefined || entry.tokens === null
                  ? ""
                  : ` · ${entry.tokens.toLocaleString()} tokens`}
              </p>
            ))
          )}
        </div>
      </Panel>
      <Panel
        id="commsTraffic"
        className="comms-traffic-panel"
        title="Traffic"
        sub={scopeLabel(view)}
      >
        <div className="comms-traffic-stats">
          {agentScope ? (
            <>
              <Stat value={total} label="messages" />
              <Stat value={sent} label="sent" tone="agent" />
              <Stat value={total - sent} label="received" />
              <Stat value={scoped.length} label={view.kind === "contact" ? "link" : "contacts"} />
            </>
          ) : (
            <>
              <Stat value={total} label="messages" />
              <Stat
                value={total ? `${Math.round(((total - capcomCount) / total) * 100)}%` : "—"}
                label="agent ↔ agent"
                tone="think"
              />
              <Stat value={capcomCount} label="with CAPCOM" tone="accent" />
              <Stat value={crewRows.length} label="agents" />
            </>
          )}
        </div>
        {hours === undefined ? (
          <p className="comms-traffic-empty">Loading traffic…</p>
        ) : (
          <>
            <div
              className="comms-bars"
              role="img"
              aria-label={`Hourly messages over the last 24 hours, ${scopeLabel(view)}`}
            >
              {chartHours.map((item) => {
                const first = agentScope ? item.sent : item.agent;
                const second = agentScope ? item.received : item.capcom;
                return (
                  <span
                    className="comms-bar"
                    key={item.hour}
                    title={`${hourLabel(item.hour)} · ${first + second} messages`}
                  >
                    <i style={{ height: `${(second / peak) * 56}px` }} />
                    <b style={{ height: `${(first / peak) * 56}px` }} />
                  </span>
                );
              })}
            </div>
            <div className="comms-bar-times">
              <span>{hourLabel(chartHours[0]?.hour ?? Date.now())}</span>
              <span>now</span>
            </div>
            <div className="comms-bar-legend">
              <span>
                <i />
                {agentScope ? `Sent by ${view.agentId}` : "Agent ↔ agent"}
              </span>
              <span>
                <i />
                {agentScope ? "Received" : "With CAPCOM"}
              </span>
            </div>
          </>
        )}
      </Panel>
    </aside>
  );
}

function Stat({
  value,
  label,
  tone,
}: {
  value: string | number;
  label: string;
  tone?: "agent" | "think" | "accent";
}) {
  return (
    <div>
      <strong className={tone ?? ""}>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
