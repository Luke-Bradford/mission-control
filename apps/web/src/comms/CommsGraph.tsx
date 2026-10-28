import { COMMS_CREW, type CrewRow, HUD_STATE_LABEL } from "@mc/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { callSign, seatRoleTitle } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import {
  type CommsView,
  commsAgentPath,
  commsContactPath,
  commsCrewPath,
  commsFlightPath,
  navigate,
} from "../router.ts";
import {
  CommsSpider,
  type Flow,
  type LastMessage,
  type SpiderEdge,
  type SpiderNode,
  useReducedMotion,
} from "./CommsSpider.tsx";
import {
  DEFAULT_SIZE,
  frameFor,
  hubPoint,
  LOOPS_SPOKE,
  presenceOf,
  spokeAnchors,
  spokesFor,
} from "./spider.ts";
import { TrafficChart, type TrafficHour } from "./TrafficChart.tsx";

/** One direction of a link over the window, with its newest message (absent on older hubs). */
type Link = {
  from: string;
  to: string;
  count: number;
  lastId?: string;
  lastAt?: number;
  lastText?: string;
};
type Hour = { from: string; to: string; count: number; hour: number };
type Edge = { a: string; b: string; aToB: number; bToA: number; last: LastMessage | null };
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
/** How long a link stays lit after a new message on it. */
const LIVE_MS = 1_800;

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

const pct = (value: number, of: number) => `${Number(((value / of) * 100).toFixed(3))}%`;

/** What a seat is called on its spoke: the id without its role's prefix (`guido-cx` is `cx`). */
function spokeLabel(row: CrewRow): string {
  if (row.kind === "loop") return callSign(row);
  const prefix = `${(row.role ?? "").toLowerCase()}-`;
  return row.id.startsWith(prefix) && row.id.length > prefix.length
    ? row.id.slice(prefix.length)
    : row.id;
}

/** `Idle`, `Paused`, `Crew paused`, ...: the HUD's word for a seat's state. */
function stateLabel(row: CrewRow): string {
  if (row.crewPause != null) return "Crew paused";
  if (row.paused) return "Paused";
  return HUD_STATE_LABEL[row.hudState];
}

/** The newer of two messages. */
const newer = (a: LastMessage | null, b: LastMessage | null) =>
  a === null ? b : b === null ? a : b.at > a.at ? b : a;

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
  const linksResource = useResource<{ links: Link[] }>(RESOURCES.commsLinks);
  const links = linksResource.data?.links;
  // Live only while the links are loaded and the last read of them succeeded.
  const streaming = links !== undefined && linksResource.error === null;
  const trafficResource = useResource<{ hours: Hour[] }>(RESOURCES.commsTraffic);
  const hours = trafficResource.data?.hours;
  const chatter = useResource<{ pairs: ChatterPair[] }>(RESOURCES.commsChatter).data?.pairs;
  const [metric, setMetric] = useState<"messages" | "tokens">("messages");
  const reduced = useReducedMotion();
  // The raw from/to pairs that gained a message on the last read, the canonical flows they make
  // (one particle per new message), and a generation per read that had any.
  const [pulse, setPulse] = useState<{ pairs: Set<string>; flows: Flow[]; generation: number }>(
    () => ({ pairs: new Set(), flows: [], generation: 0 }),
  );
  const previousLinks = useRef<Map<string, { count: number; lastId?: string }> | null>(null);
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
      const value = combined.get(`${a}\0${b}`) ?? { a, b, aToB: 0, bToA: 0, last: null };
      if (from === a) value.aToB += link.count;
      else value.bToA += link.count;
      if (link.lastAt !== undefined && link.lastText !== undefined)
        value.last = newer(value.last, { from, to, text: link.lastText, at: link.lastAt });
      combined.set(`${a}\0${b}`, value);
    }
    return [...combined.values()];
  }, [flight, known, links]);
  // New messages are read from the links alone (raw endpoints), so crew rows or the FLIGHT seat
  // resolving later neither re-run this nor make an edge that just became visible look new. A
  // link has new messages when its count rises or its newest message changes (the 24h window can
  // drop an old one as a new one lands, leaving the count where it was).
  useEffect(() => {
    if (links === undefined) return;
    const current = new Map<string, { count: number; lastId?: string }>();
    for (const link of links) {
      const key = `${link.from}\0${link.to}`;
      const seen = current.get(key);
      current.set(key, {
        count: (seen?.count ?? 0) + link.count,
        lastId: link.lastId ?? seen?.lastId,
      });
    }
    const previous = previousLinks.current;
    previousLinks.current = current;
    if (previous === null) return;
    const fresh = new Map<string, number>();
    for (const [key, now] of current) {
      const before = previous.get(key);
      const rise = now.count - (before?.count ?? 0);
      const moved = now.lastId !== undefined && before?.lastId !== now.lastId;
      const n = Math.max(rise, moved ? 1 : 0);
      if (n > 0) fresh.set(key, n);
    }
    if (fresh.size === 0) return;
    setPulse((last) => ({
      pairs: new Set(fresh.keys()),
      flows: [...fresh].map(([key, n]) => {
        const [from = "", to = ""] = key.split("\0");
        return { from, to, n };
      }),
      generation: last.generation + 1,
    }));
  }, [links]);
  // Each new message lights its link for LIVE_MS; this timer is the only one that clears it.
  useEffect(() => {
    if (pulse.pairs.size === 0) return;
    const timer = window.setTimeout(
      () => setPulse((last) => ({ pairs: new Set(), flows: [], generation: last.generation })),
      LIVE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pulse]);
  const liveEdges = useMemo(() => {
    const keys = new Set<string>();
    for (const key of pulse.pairs) {
      const [rawFrom = "", rawTo = ""] = key.split("\0");
      const from = canonicalEndpoint(rawFrom, flight);
      const to = canonicalEndpoint(rawTo, flight);
      if (from === to) continue;
      const [a, b] = pair(from, to);
      keys.add(`${a}\0${b}`);
    }
    return keys;
  }, [flight, pulse]);
  // Particles for this read's new messages, between endpoints the graph draws.
  const flows = useMemo(
    () => ({
      generation: pulse.generation,
      list: pulse.flows.flatMap((flow) => {
        const from = canonicalEndpoint(flow.from, flight);
        const to = canonicalEndpoint(flow.to, flight);
        return from !== to && known.has(from) && known.has(to) ? [{ ...flow, from, to }] : [];
      }),
    }),
    [flight, known, pulse],
  );
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
  const touching = (id: string) => edges.filter((edge) => edge.a === id || edge.b === id);
  const sentBy = (id: string) =>
    touching(id).reduce((sum, edge) => sum + (edge.a === id ? edge.aToB : edge.bToA), 0);
  const receivedBy = (id: string) =>
    touching(id).reduce((sum, edge) => sum + (edge.a === id ? edge.bToA : edge.aToB), 0);
  const countOf = (id: string) => sentBy(id) + receivedBy(id);
  const lastOf = (id: string) =>
    touching(id).reduce<LastMessage | null>((last, edge) => newer(last, edge.last), null);

  // Every seat and observed loop sits on its role's spoke; FLIGHT, CAPCOM and #crew on the axis.
  const f = frameFor(size);
  const spokes = spokesFor(rows, flight);
  const anchors = spokeAnchors(spokes, f);
  const flightRow = crewRows.find((row) => row.id === flight);
  const seatRows = rows.filter((row) => row.id !== flight);
  const busiest = Math.max(1, ...seatRows.map((row) => countOf(row.id)));
  const liveIds = new Set(
    edges
      .filter((edge) => liveEdges.has(`${edge.a}\0${edge.b}`))
      .flatMap((edge) => [edge.a, edge.b]),
  );
  const dimmed = (id: string) => focusedView && active.size > 0 && !active.has(id);
  const common = (id: string) => ({
    count: countOf(id),
    sent: sentBy(id),
    received: receivedBy(id),
    selected: selected.has(id),
    dim: dimmed(id),
    live: liveIds.has(id),
    last: lastOf(id),
  });
  const hub = (
    id: string,
    label: string,
    color: string,
    at: "centre" | "above" | "below",
    r: number,
    row?: CrewRow,
  ): SpiderNode => ({
    id,
    label,
    name: label,
    hub: true,
    role: row ? (seatRoleTitle(row.id, rows, undefined) ?? row.role) : null,
    color,
    presence: row ? presenceOf(row) : "idle",
    state: row ? stateLabel(row) : null,
    since: row?.stateSince ?? null,
    alert: row ? row.hudState === "error" || row.hudState === "stalled" : false,
    r,
    anchor: hubPoint(f, at),
    pinned: true,
    ...common(id),
  });
  const nodes: SpiderNode[] = [
    hub(CAPCOM, CAPCOM, "var(--fg)", "above", 8),
    hub(flight, "FLIGHT", "var(--accent)", "centre", 12, flightRow),
    hub(COMMS_CREW, "#crew", "var(--fg-2)", "below", 7.5),
    ...seatRows.map((row): SpiderNode => {
      const presence = presenceOf(row);
      const count = countOf(row.id);
      const base = presence === "running" ? 6 : presence === "idle" ? 5 : 4;
      return {
        id: row.id,
        label: spokeLabel(row),
        name: row.kind === "loop" ? callSign(row) : row.id,
        hub: false,
        role:
          row.kind === "loop"
            ? `${LOOPS_SPOKE.toLowerCase()} · observed`
            : (seatRoleTitle(row.id, rows, undefined) ?? row.role),
        color: agentColor(row.index),
        presence,
        state: stateLabel(row),
        since: row.stateSince,
        alert: row.hudState === "error" || row.hudState === "stalled",
        r: Math.round((base + 5 * Math.sqrt(count / busiest)) * 2) / 2,
        anchor: anchors.get(row.id) ?? hubPoint(f, "centre"),
        pinned: false,
        ...common(row.id),
      };
    }),
  ];
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
  const heaviest = Math.max(1, ...edges.map((edge) => edge.aToB + edge.bToA));
  const spiderEdges: SpiderEdge[] = edges.map((edge) => ({
    key: `${edge.a}\0${edge.b}`,
    a: edge.a,
    b: edge.b,
    aToB: edge.aToB,
    bToA: edge.bToA,
    weight: Math.sqrt((edge.aToB + edge.bToA) / heaviest),
    straight: edge.a === flight || edge.b === flight,
    lit: scoped.includes(edge),
    focus: focusedView && scoped.includes(edge),
    watching: watched.some(
      (entry) =>
        (entry.from === edge.a && entry.to === edge.b) ||
        (entry.from === edge.b && entry.to === edge.a),
    ),
    live: liveEdges.has(`${edge.a}\0${edge.b}`),
    last: edge.last,
  }));
  const seatCount = rows.length;
  const graphLabel = `Comms graph, ${seatCount} seats, ${total} messages in view (${scopeLabel(view)})`;
  const open = (id: string) =>
    navigate(
      id === CAPCOM || id === flight
        ? commsFlightPath()
        : id === COMMS_CREW
          ? commsCrewPath()
          : commsAgentPath(id),
    );
  /** A link opens its conversation: FLIGHT ↔ CAPCOM, #crew, or the pair from the seat's side. */
  const openEdge = (a: string, b: string) => {
    if (new Set([a, b, flight, CAPCOM]).size === 2) return navigate(commsFlightPath());
    if (a === COMMS_CREW || b === COMMS_CREW) return navigate(commsCrewPath());
    const [agent, contact] = a === CAPCOM ? [b, a] : [a, b];
    navigate(commsContactPath(agent, contact));
  };

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
          {streaming && (
            <span className="live">
              <i className="comms-live-dot" />
              Live
            </span>
          )}
          <span>
            <b>{edges.length}</b> links
          </span>
          <span>
            <b>{edges.reduce((sum, edge) => sum + edge.aToB + edge.bToA, 0)}</b> msg
          </span>
          <span>
            <b>{spokes.length}</b> roles
          </span>
        </div>
        <div className="comms-graph-stage" ref={stage}>
          <CommsSpider
            frame={f}
            spokes={spokes}
            nodes={nodes}
            edges={spiderEdges}
            metric={metric}
            flows={flows}
            reduced={reduced}
            label={graphLabel}
            onOpenNode={open}
            onOpenEdge={openEdge}
          />
          {hasData && edges.length === 0 && (
            <p className="comms-empty">No direct messages in the last 24h.</p>
          )}
          {metric === "tokens" && (
            <p className="comms-token-empty">Token totals are not available yet.</p>
          )}
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
            live={trafficResource.error === null}
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
