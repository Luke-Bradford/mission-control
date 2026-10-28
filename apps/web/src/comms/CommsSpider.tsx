import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNow, useTz } from "../clock.ts";
import { rel } from "../fmt.ts";
import {
  curve,
  type Frame,
  hubPoint,
  onSpoke,
  type Point,
  type Presence,
  SpiderSim,
  type Spoke,
} from "./spider.ts";

/** A link's newest message, for the hover card. */
export type LastMessage = { from: string; to: string; text: string; at: number };

export type SpiderNode = {
  id: string;
  /** What the graph prints under the node (a seat's suffix on its role's spoke). */
  label: string;
  /** The full name: tooltips and the accessible name. */
  name: string;
  hub: boolean;
  /** Role title or spoke, for the hover card. */
  role: string | null;
  color: string;
  presence: Presence;
  /** The HUD state as the operator reads it (`Idle`, `Crew paused`); null for CAPCOM and #crew. */
  state: string | null;
  /** When the seat entered that state. */
  since: number | null;
  /** Error or stalled: ringed in --crit. */
  alert: boolean;
  count: number;
  sent: number;
  received: number;
  r: number;
  anchor: Point;
  pinned: boolean;
  selected: boolean;
  dim: boolean;
  live: boolean;
  last: LastMessage | null;
};

export type SpiderEdge = {
  key: string;
  a: string;
  b: string;
  aToB: number;
  bToA: number;
  /** 0..1, the link's share of the busiest link (square-root scaled). */
  weight: number;
  straight: boolean;
  lit: boolean;
  focus: boolean;
  watching: boolean;
  live: boolean;
  last: LastMessage | null;
};

/** New messages seen on the last read: one particle each (a few at most per link). */
export type Flow = { from: string; to: string; n: number };
export type Flows = { generation: number; list: Flow[] };

const PARTICLE_MS = 1_150;
const PARTICLE_GAP_MS = 200;
const MAX_PARTICLES_PER_FLOW = 4;
/** A node that leaves fades for this long before it is removed. */
const LEAVE_MS = 650;
/** The physics loop runs at most this often (ms between steps); about 30 fps. */
const STEP_MS = 30;
const SVG_NS = "http://www.w3.org/2000/svg";

type Particle = {
  edge: string;
  from: string;
  to: string;
  start: number;
  el: SVGGElement | null;
};

type Ghost = { node: SpiderNode; at: Point };

type Hover = { kind: "node"; id: string } | { kind: "edge"; key: string } | null;

/** A count chip's width for its digits. */
const chip = (n: number) => 7 + 5.6 * String(n).length;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

const reducedMotionQuery = () =>
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

/** True while the operator asks for reduced motion; follows the setting live. */
export function useReducedMotion(): boolean {
  const query = reducedMotionQuery;
  const [reduced, setReduced] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const media = reducedMotionQuery();
    if (!media) return;
    const change = () => setReduced(media.matches);
    change();
    media.addEventListener?.("change", change);
    return () => media.removeEventListener?.("change", change);
  }, []);
  return reduced;
}

/**
 * The Comms graph as a live spider: React draws the structure; a physics loop moves it. The loop
 * writes node transforms, link paths and particles straight to the DOM, so a refetch re-renders
 * nothing that moved and the picture never jumps.
 */
export function CommsSpider({
  frame: f,
  spokes,
  nodes,
  edges,
  metric,
  flows,
  reduced,
  label,
  onOpenNode,
  onOpenEdge,
}: {
  frame: Frame;
  spokes: readonly Spoke[];
  nodes: readonly SpiderNode[];
  edges: readonly SpiderEdge[];
  metric: "messages" | "tokens";
  flows: Flows;
  reduced: boolean;
  label: string;
  onOpenNode: (id: string) => void;
  onOpenEdge: (a: string, b: string) => void;
}) {
  const simRef = useRef<SpiderSim | null>(null);
  if (simRef.current === null) simRef.current = new SpiderSim();
  const sim = simRef.current;
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef(new Map<string, SVGGElement>());
  const particleLayer = useRef<SVGGElement>(null);
  const particles = useRef<Particle[]>([]);
  const latest = useRef({ nodes, edges, f });
  latest.current = { nodes, edges, f };
  const [ghosts, setGhosts] = useState<Map<string, Ghost>>(() => new Map());
  const [hover, setHover] = useState<Hover>(null);
  const centre = hubPoint(f, "centre");
  const at = (node: SpiderNode): Point => sim.position(node.id) ?? node.anchor;

  /** Writes every node, link and particle at the simulation's current positions. */
  const paint = useCallback(
    (now: number) => {
      const { edges: liveEdges, f: frame } = latest.current;
      const middle = hubPoint(frame, "centre");
      for (const [id, el] of nodeEls.current) {
        const p = sim.position(id);
        if (p) el.setAttribute("transform", `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
      }
      const geometry = new Map<string, ReturnType<typeof curve>>();
      for (const edge of liveEdges) {
        const a = sim.position(edge.a);
        const b = sim.position(edge.b);
        const el = edgeEls.current.get(edge.key);
        if (!a || !b || !el) continue;
        const c = curve(a, b, edge.straight, middle);
        geometry.set(edge.key, c);
        for (const path of el.querySelectorAll("path")) path.setAttribute("d", c.d);
        const mid = c.at(0.5);
        el.querySelector(".comms-edge-count")?.setAttribute(
          "transform",
          `translate(${mid.x.toFixed(1)} ${mid.y.toFixed(1)})`,
        );
      }
      const layer = particleLayer.current;
      particles.current = particles.current.filter((p) => {
        const c = geometry.get(p.edge);
        const t = (now - p.start) / PARTICLE_MS;
        if (!c || t >= 1) {
          p.el?.remove();
          if (c) ping(nodeEls.current.get(p.to));
          return false;
        }
        if (t < 0) return true;
        if (!p.el && layer) {
          p.el = document.createElementNS(SVG_NS, "g");
          p.el.setAttribute("class", "comms-particle");
          for (const [r, cls] of [
            [1.6, "trail"],
            [2, "trail"],
            [2.6, "head"],
          ] as const) {
            const dot = document.createElementNS(SVG_NS, "circle");
            dot.setAttribute("r", String(r));
            dot.setAttribute("class", cls);
            p.el.append(dot);
          }
          layer.append(p.el);
        }
        const [a, b] = p.edge.split("\0");
        const forward = p.from === a && p.to === b;
        const dots = p.el?.querySelectorAll("circle") ?? [];
        dots.forEach((dot, i) => {
          const lag = (dots.length - 1 - i) * 0.045;
          const e = easeInOut(Math.max(0, t - lag));
          const q = c.at(forward ? e : 1 - e);
          dot.setAttribute("cx", q.x.toFixed(1));
          dot.setAttribute("cy", q.y.toFixed(1));
        });
        return true;
      });
    },
    [sim],
  );

  // Hold the current nodes in the simulation; only a new or moved anchor sets anything in motion.
  const targets = nodes.map(
    (n) => `${n.id}:${n.anchor.x.toFixed(1)},${n.anchor.y.toFixed(1)}:${n.r}`,
  );
  const signature = `${targets.join("|")}#${reduced}`;
  useLayoutEffect(() => {
    void signature;
    const { nodes: current, f: frame } = latest.current;
    sim.sync(
      current.map((n) => ({ id: n.id, x: n.anchor.x, y: n.anchor.y, r: n.r, pinned: n.pinned })),
      hubPoint(frame, "centre"),
      reduced,
    );
    paint(performance.now());
  }, [signature, reduced, sim, paint]);

  // A seat that leaves fades out where it was; under reduced motion it simply goes.
  const shown = useRef(new Map<string, Ghost>());
  const ghostTimers = useRef(new Set<number>());
  useEffect(() => {
    const timers = ghostTimers.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);
  useLayoutEffect(() => {
    const ids = new Set(nodes.map((n) => n.id));
    const gone = [...shown.current.values()].filter((g) => !ids.has(g.node.id));
    shown.current = new Map(
      nodes.map((n) => [n.id, { node: n, at: sim.position(n.id) ?? n.anchor }]),
    );
    if (reduced || gone.length === 0) return;
    setGhosts((last) => {
      const next = new Map(last);
      for (const g of gone) next.set(g.node.id, g);
      return next;
    });
    const timer = window.setTimeout(() => {
      ghostTimers.current.delete(timer);
      setGhosts((last) => {
        const next = new Map(last);
        for (const g of gone) if (next.get(g.node.id) === g) next.delete(g.node.id);
        return next;
      });
    }, LEAVE_MS);
    ghostTimers.current.add(timer);
  }, [nodes, reduced, sim]);
  // A ghost whose seat came back is dropped at once.
  const visibleGhosts = [...ghosts.values()].filter((g) => !nodes.some((n) => n.id === g.node.id));

  // New messages become particles, once per read (a crew refetch hands over the same read again);
  // reduced motion shows the lit link alone.
  const flown = useRef(flows.generation);
  useEffect(() => {
    if (flows.generation === flown.current) return;
    flown.current = flows.generation;
    if (reduced || flows.list.length === 0) return;
    const now = performance.now();
    const queued: Particle[] = [];
    for (const flow of flows.list) {
      const [a, b] = flow.from < flow.to ? [flow.from, flow.to] : [flow.to, flow.from];
      const edge = `${a}\0${b}`;
      for (let i = 0; i < Math.min(flow.n, MAX_PARTICLES_PER_FLOW); i++)
        queued.push({
          edge,
          from: flow.from,
          to: flow.to,
          start: now + i * PARTICLE_GAP_MS,
          el: null,
        });
    }
    particles.current.push(...queued);
  }, [flows, reduced]);

  // The physics loop: drift, springs and particles, about 30 frames a second; none when reduced.
  useEffect(() => {
    if (reduced || typeof window.requestAnimationFrame !== "function") return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = window.requestAnimationFrame(tick);
      if (now - last < STEP_MS) return;
      sim.step((now - last) / 1000, now / 1000, true);
      last = now;
      paint(now);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
      for (const p of particles.current) p.el?.remove();
      particles.current = [];
    };
  }, [reduced, sim, paint]);

  const nodeKey = (open: () => void) => (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
  };
  const hovered =
    hover?.kind === "node"
      ? nodes.find((n) => n.id === hover.id)
      : hover?.kind === "edge"
        ? edges.find((e) => e.key === hover.key)
        : undefined;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seats = nodes.filter((n) => !n.hub || n.state !== null);
  const counts = {
    running: seats.filter((n) => n.presence === "running").length,
    idle: seats.filter((n) => n.presence === "idle").length,
    stopped: seats.filter((n) => n.presence === "stopped").length,
  };

  const renderNode = (node: SpiderNode, index: number, ghost?: Ghost) => {
    const p = ghost?.at ?? at(node);
    const open = () => onOpenNode(node.id);
    const className = [
      "comms-node",
      `presence-${node.presence}`,
      node.hub ? "hub" : "",
      node.presence === "stopped" ? "inactive" : "",
      node.selected ? "selected" : "",
      node.dim ? "dim" : "",
      node.live ? "live" : "",
      node.alert ? "alert" : "",
      ghost ? "leaving" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <g
        key={ghost ? `ghost-${node.id}` : node.id}
        ref={(el) => {
          if (ghost) return;
          if (el) nodeEls.current.set(node.id, el);
          else nodeEls.current.delete(node.id);
        }}
        className={className}
        transform={`translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`}
        style={{ "--node-color": node.color } as CSSProperties}
        {...(ghost
          ? { "aria-hidden": true }
          : {
              role: "button",
              tabIndex: 0,
              "aria-label": `Open ${node.name}, ${node.count} messages in 24h${node.state ? `, ${node.state}` : ""}`,
              onClick: open,
              onKeyDown: nodeKey(open),
              onMouseEnter: () => setHover({ kind: "node", id: node.id }),
              onMouseLeave: () => setHover(null),
              onFocus: () => setHover({ kind: "node", id: node.id }),
              onBlur: () => setHover(null),
            })}
      >
        <g
          className="comms-node-body"
          style={{ animationDelay: `${Math.min(index, 16) * 35}ms` } as CSSProperties}
        >
          <circle className="comms-node-hit" r={node.r + 9} />
          <circle className="comms-node-halo" r={node.r + 6} />
          <circle className="comms-node-core" r={node.r} />
          {node.hub && <circle className="comms-node-inner" r={Math.max(2, node.r - 4.5)} />}
          <circle className="comms-node-ring" r={node.r + 3.5} />
          <text className="comms-node-name" y={node.r + 12} textAnchor="middle">
            {node.label}
          </text>
        </g>
      </g>
    );
  };

  const tipAt = (() => {
    if (!hovered) return null;
    if ("anchor" in hovered) return at(hovered);
    const a = byId.get(hovered.a);
    const b = byId.get(hovered.b);
    if (!a || !b) return null;
    return curve(at(a), at(b), hovered.straight, centre).at(0.5);
  })();

  return (
    <figure className={`comms-spider${metric === "tokens" ? " tokens" : ""}`} aria-label={label}>
      <svg className="comms-spider-svg" viewBox={`0 0 ${f.w} ${f.h}`}>
        <title>Crew by role: FLIGHT at the centre, one spoke per role</title>
        <g className="comms-spider-scale">
          <ellipse cx={f.cx} cy={f.cy} rx={f.rx} ry={f.ry} />
          <ellipse className="inner" cx={f.cx} cy={f.cy} rx={f.rx * 0.58} ry={f.ry * 0.58} />
          <line
            className="axis"
            x1={f.cx}
            x2={f.cx}
            y1={hubPoint(f, "above").y}
            y2={hubPoint(f, "below").y}
          />
          {spokes.map((spoke) => {
            const tip = onSpoke(f, spoke.angle, 1);
            const out = onSpoke(f, spoke.angle, 1 + 8 / Math.max(1, f.rx));
            const cos = Math.cos((spoke.angle * Math.PI) / 180);
            const sin = Math.sin((spoke.angle * Math.PI) / 180);
            // Clear of the seat labels, which hang under their nodes: lower spokes' names drop.
            const drop = sin > 0.2 ? 9 : sin < -0.2 ? -3 : 0;
            return (
              <g key={spoke.key} className="comms-spoke">
                <line x1={f.cx} y1={f.cy} x2={tip.x} y2={tip.y} />
                <text
                  x={out.x}
                  y={out.y + drop}
                  dy="0.34em"
                  textAnchor={Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end"}
                >
                  {spoke.key}
                  <tspan className="n"> {spoke.ids.length}</tspan>
                </text>
              </g>
            );
          })}
        </g>
        <g className="comms-spider-links">
          {edges.map((edge) => {
            const a = byId.get(edge.a);
            const b = byId.get(edge.b);
            if (!a || !b) return null;
            const c = curve(at(a), at(b), edge.straight, centre);
            const mid = c.at(0.5);
            const count = edge.aToB + edge.bToA;
            const className = [
              "comms-edge",
              edge.lit ? (edge.focus ? "active focus" : "active") : "dim",
              edge.watching ? "watching" : "",
              edge.live ? "live" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              // biome-ignore lint/a11y/useSemanticElements: SVG has no button; a link is a path
              <g
                key={edge.key}
                ref={(el) => {
                  if (el) edgeEls.current.set(edge.key, el);
                  else edgeEls.current.delete(edge.key);
                }}
                className={className}
                style={{ "--w": edge.weight.toFixed(3) } as CSSProperties}
                role="button"
                tabIndex={0}
                aria-label={`Conversation ${byId.get(edge.a)?.name ?? edge.a} ↔ ${byId.get(edge.b)?.name ?? edge.b}, ${count} messages in 24h`}
                onClick={() => onOpenEdge(edge.a, edge.b)}
                onKeyDown={nodeKey(() => onOpenEdge(edge.a, edge.b))}
                onMouseEnter={() => setHover({ kind: "edge", key: edge.key })}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover({ kind: "edge", key: edge.key })}
                onBlur={() => setHover(null)}
              >
                <path className="comms-edge-hit" d={c.d} />
                <path
                  className="comms-edge-line"
                  d={c.d}
                  strokeWidth={metric === "tokens" ? 1 : 1 + 2.6 * edge.weight}
                />
                {metric === "messages" && (
                  <g
                    className="comms-edge-count"
                    transform={`translate(${mid.x.toFixed(1)} ${mid.y.toFixed(1)})`}
                  >
                    <rect
                      className="comms-edge-chip"
                      x={-chip(count) / 2}
                      y={-6.5}
                      width={chip(count)}
                      height={13}
                      rx={2}
                    />
                    <text className="comms-edge-num" dy="0.34em" textAnchor="middle">
                      {count}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
        <g className="comms-spider-particles" ref={particleLayer} />
        <g className="comms-spider-nodes">
          {visibleGhosts.map((g, i) => renderNode(g.node, i, g))}
          {nodes.map((node, i) => renderNode(node, i))}
        </g>
      </svg>
      {hovered && tipAt && (
        <SpiderTip at={tipAt} frame={f} subject={hovered} name={(id) => byId.get(id)?.name ?? id} />
      )}
      <div className="comms-spider-legend" aria-hidden="true">
        <span className="running">
          <i className="key" />
          Running <b>{counts.running}</b>
        </span>
        <span className="idle">
          <i className="key" />
          Idle <b>{counts.idle}</b>
        </span>
        <span className="stopped">
          <i className="key" />
          Stopped <b>{counts.stopped}</b>
        </span>
        <span className="link">
          <i className="key" />
          {metric === "messages" ? "Msgs" : "Tokens"}
        </span>
        {!reduced && (
          <span className="particle">
            <i className="key" />
            New
          </span>
        )}
      </div>
    </figure>
  );
}

/** One expanding ring on the node a message reached. */
function ping(el: SVGGElement | undefined) {
  const body = el?.querySelector(".comms-node-body");
  const core = el?.querySelector(".comms-node-core");
  if (!body || !core) return;
  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("class", "comms-node-ping");
  ring.setAttribute("r", core.getAttribute("r") ?? "6");
  body.append(ring);
  window.setTimeout(() => ring.remove(), 900);
}

/** The hover card: who, state, counts both ways and the newest message. */
function SpiderTip({
  at,
  frame: f,
  subject,
  name,
}: {
  at: Point;
  frame: Frame;
  subject: SpiderNode | SpiderEdge;
  name: (id: string) => string;
}) {
  const now = useNow();
  const tz = useTz();
  const flip = at.x > f.w * 0.55;
  const style = {
    left: `${((at.x / f.w) * 100).toFixed(2)}%`,
    top: `${((at.y / f.h) * 100).toFixed(2)}%`,
  } as CSSProperties;
  const last = subject.last;
  const total = "anchor" in subject ? subject.count : subject.aToB + subject.bToA;
  return (
    <div className={`comms-spider-tip${flip ? " flip" : ""}`} style={style} role="tooltip">
      {"anchor" in subject ? (
        <>
          <p className="tip-head">
            <i className="tip-dot" style={{ background: subject.color }} />
            <b className="tip-name">{subject.name}</b>
            {subject.role && <span className="tip-role">{subject.role}</span>}
          </p>
          {subject.state && (
            <p className={`tip-state presence-${subject.presence}${subject.alert ? " alert" : ""}`}>
              <i className="tip-state-dot" />
              {subject.state}
              {subject.since !== null && tz ? ` · ${rel(subject.since, now, tz)}` : ""}
            </p>
          )}
          <dl className="tip-stats">
            <div className="tip-stat">
              <dt>Sent</dt>
              <dd>{subject.sent}</dd>
            </div>
            <div className="tip-stat">
              <dt>Received</dt>
              <dd>{subject.received}</dd>
            </div>
            <div className="tip-stat">
              <dt>Window</dt>
              <dd>24h</dd>
            </div>
          </dl>
        </>
      ) : (
        <>
          <p className="tip-head">
            <b className="tip-name">
              {name(subject.a)} ↔ {name(subject.b)}
            </b>
          </p>
          <dl className="tip-stats">
            <div className="tip-stat">
              <dt>{name(subject.a)} →</dt>
              <dd>{subject.aToB}</dd>
            </div>
            <div className="tip-stat">
              <dt>{name(subject.b)} →</dt>
              <dd>{subject.bToA}</dd>
            </div>
          </dl>
        </>
      )}
      {last && (
        <p className="tip-last">
          <span className="tip-meta">
            {name(last.from)} → {name(last.to)} · {tz ? rel(last.at, now, tz) : "—"}
          </span>
          <q>{last.text}</q>
        </p>
      )}
      {/* An older hub sends counts without the newest message; say nothing rather than "none". */}
      {!last && total === 0 && <p className="tip-last none">No messages in 24h</p>}
    </div>
  );
}
