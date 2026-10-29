import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
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
  type LabelSide,
  onSpoke,
  type Point,
  type Presence,
  phaseOf,
  SpiderSim,
  type Spoke,
} from "./spider.ts";

/** A link's newest message, for the hover card. */
export type LastMessage = { from: string; to: string; text: string; at: number };

export type SpiderNode = {
  id: string;
  /** The call sign the graph prints by the node. */
  label: string;
  /** The call sign for cards and accessible names (the same as `label`). */
  name: string;
  hub: boolean;
  /** Which side of the node its name sits on (placed clear of other names and nodes). */
  labelSide: LabelSide;
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
/** A seat that is stopped or paused and quiet in the window: not drawn, listed in the legend. */
export type AwaySeat = { id: string; name: string; state: string };

const PARTICLE_MS = 1_150;
const PARTICLE_GAP_MS = 200;
const MAX_PARTICLES_PER_FLOW = 4;
/** A node that leaves fades for this long before it is removed. */
const LEAVE_MS = 650;
/** The physics loop steps at most this often (ms); about 30 fps while anything moves. */
const STEP_MS = 30;
/** The loop rests once the nodes have moved less than this (px, all told) for QUIET_STEPS steps. */
const QUIET_PX = 0.05;
const QUIET_STEPS = 8;
const PING_MS = 900;
const TIP_W = 228;
const TIP_GAP = 16;
const SVG_NS = "http://www.w3.org/2000/svg";

type Particle = {
  edge: string;
  from: string;
  to: string;
  /** Set on the first frame that paints it, on the frame clock (`delay` after that frame). */
  start: number | null;
  delay: number;
  el: SVGGElement | null;
};

type Ghost = { node: SpiderNode; at: Point };

type Hover = { kind: "node"; id: string } | { kind: "edge"; key: string } | null;

/** A link's drawn parts, held so the loop writes to them without searching the DOM. */
type EdgeParts = { hit?: SVGPathElement; line?: SVGPathElement; chip?: SVGGElement };

/** Where a node's name sits, relative to the node, for its placed side. */
function nameAt(node: { r: number; labelSide: LabelSide }) {
  const gap = node.r + 4;
  if (node.labelSide === "above") return { y: -gap - 2, textAnchor: "middle" } as const;
  if (node.labelSide === "right") return { x: gap, dy: "0.34em", textAnchor: "start" } as const;
  if (node.labelSide === "left") return { x: -gap, dy: "0.34em", textAnchor: "end" } as const;
  return { y: gap + 8, textAnchor: "middle" } as const;
}

/** A count chip's width for its digits. */
const chip = (n: number) => 7 + 5.6 * String(n).length;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

const reducedMotionQuery = () =>
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

/** True while the operator asks for reduced motion; follows the setting live. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false);
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

/** Clockwise from straight up, the centre first: the order the arrow keys walk the nodes in. */
function walkOrder(nodes: readonly SpiderNode[], centre: Point): SpiderNode[] {
  const angle = (n: SpiderNode) => {
    const a = Math.atan2(n.anchor.y - centre.y, n.anchor.x - centre.x) + Math.PI / 2;
    return a < 0 ? a + 2 * Math.PI : a;
  };
  const middle = (n: SpiderNode) => Math.hypot(n.anchor.x - centre.x, n.anchor.y - centre.y) < 1;
  return [...nodes].sort((a, b) => Number(middle(b)) - Number(middle(a)) || angle(a) - angle(b));
}

/**
 * The Comms graph as a live spider. React draws the structure; a physics loop moves it only while
 * something is moving (a node arriving or re-anchored, a particle in flight), then rests. The
 * resting drift is a CSS animation on each node's body, so a still graph costs no frames, and
 * everything pauses while the panel is scrolled out of view.
 */
export function CommsSpider({
  frame: f,
  spokes,
  nodes,
  edges,
  metric,
  flows,
  away,
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
  away: readonly AwaySeat[];
  reduced: boolean;
  label: string;
  onOpenNode: (id: string) => void;
  onOpenEdge: (a: string, b: string) => void;
}) {
  const uid = useId();
  const tipId = `${uid}-tip`;
  const hintId = `${uid}-hint`;
  const awayId = `${uid}-away`;
  const simRef = useRef<SpiderSim | null>(null);
  if (simRef.current === null) simRef.current = new SpiderSim();
  const sim = simRef.current;
  const figure = useRef<HTMLElement>(null);
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef(new Map<string, SVGGElement>());
  const edgeParts = useRef(new Map<string, EdgeParts>());
  const partRefs = useRef(new Map<string, (el: SVGElement | null) => void>());
  const particleLayer = useRef<SVGGElement>(null);
  const particles = useRef<Particle[]>([]);
  const pingTimers = useRef(new Set<number>());
  const ghostTimers = useRef(new Set<number>());
  const latest = useRef({ edges, f });
  latest.current = { edges, f };
  const [ghosts, setGhosts] = useState<Map<string, Ghost>>(() => new Map());
  const [hover, setHover] = useState<Hover>(null);
  const [awayHover, setAwayHover] = useState(false);
  const [awayPinned, setAwayPinned] = useState(false);
  const centre = hubPoint(f, "centre");
  const at = (node: SpiderNode): Point => sim.position(node.id) ?? node.anchor;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const call = (id: string) => byId.get(id)?.name ?? id;

  /** A stable callback ref per link part, so React does not detach and reattach it every render. */
  const partRef = (key: string, part: keyof EdgeParts) => {
    const id = `${key}\u0001${part}`;
    let ref = partRefs.current.get(id);
    if (!ref) {
      ref = (el: SVGElement | null) => {
        const parts = edgeParts.current.get(key) ?? {};
        if (el) (parts as Record<string, SVGElement>)[part] = el;
        else delete parts[part];
        edgeParts.current.set(key, parts);
      };
      partRefs.current.set(id, ref);
    }
    return ref;
  };

  /**
   * Writes every node, link and particle at the simulation's current positions. Particles run on
   * the frame clock only: a paint outside the loop (`now` null) leaves them to the next frame.
   */
  const paint = useCallback(
    (now: number | null) => {
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
        if (!a || !b) continue;
        const c = curve(a, b, edge.straight, middle);
        geometry.set(edge.key, c);
        const parts = edgeParts.current.get(edge.key);
        parts?.hit?.setAttribute("d", c.d);
        parts?.line?.setAttribute("d", c.d);
        const mid = c.at(0.5);
        parts?.chip?.setAttribute(
          "transform",
          `translate(${mid.x.toFixed(1)} ${mid.y.toFixed(1)})`,
        );
      }
      if (now === null) return;
      const layer = particleLayer.current;
      particles.current = particles.current.filter((p) => {
        const c = geometry.get(p.edge);
        // Start on the clock that paints it: a frame's timestamp needn't share performance.now()'s
        // origin (jsdom's doesn't), which would expire a particle on its first frame.
        p.start ??= now + p.delay;
        const t = (now - p.start) / PARTICLE_MS;
        if (!c || t >= 1) {
          p.el?.remove();
          if (c) ping(nodeEls.current.get(p.to), pingTimers.current);
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
        const dots = p.el?.childNodes ?? [];
        dots.forEach((dot, i) => {
          const lag = (dots.length - 1 - i) * 0.045;
          const e = easeInOut(Math.max(0, t - lag));
          const q = c.at(forward ? e : 1 - e);
          (dot as SVGCircleElement).setAttribute("cx", q.x.toFixed(1));
          (dot as SVGCircleElement).setAttribute("cy", q.y.toFixed(1));
        });
        return true;
      });
    },
    [sim],
  );

  // The loop: steps the springs and particles while anything moves, then stops asking for frames.
  // It wakes on a sync, a new particle or the panel scrolling back into view.
  const raf = useRef(0);
  const visible = useRef(true);
  const wake = useCallback(() => {
    if (reduced || raf.current !== 0 || !visible.current) return;
    if (typeof window.requestAnimationFrame !== "function") return;
    // Seeded from the first frame: a frame's timestamp needn't share performance.now()'s origin.
    let last: number | null = null;
    let quiet = 0;
    const tick = (now: number) => {
      raf.current = 0;
      last ??= now - STEP_MS;
      if (now - last >= STEP_MS) {
        const moved = sim.step((now - last) / 1000);
        last = now;
        paint(now);
        quiet = moved < QUIET_PX ? quiet + 1 : 0;
      }
      if (!visible.current) return;
      if (quiet >= QUIET_STEPS && particles.current.length === 0) return;
      raf.current = window.requestAnimationFrame(tick);
    };
    raf.current = window.requestAnimationFrame(tick);
  }, [reduced, sim, paint]);
  const rest = useCallback(() => {
    if (raf.current !== 0) window.cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  // A seat that leaves fades out where it was last drawn: its position is read before the sync
  // below drops it from the simulation. Under reduced motion it simply goes.
  const shownIds = useRef<string[]>([]);
  const lastNodes = useRef(new Map<string, SpiderNode>());
  useLayoutEffect(() => {
    const ids = new Set(nodes.map((n) => n.id));
    const gone = shownIds.current.filter((id) => !ids.has(id));
    const leaving = gone.flatMap((id) => {
      const node = lastNodes.current.get(id);
      return node ? [{ node, at: sim.position(id) ?? node.anchor }] : [];
    });
    shownIds.current = [...ids];
    lastNodes.current = new Map(nodes.map((n) => [n.id, n]));
    if (reduced || leaving.length === 0) return;
    setGhosts((prev) => {
      const next = new Map(prev);
      for (const g of leaving) next.set(g.node.id, g);
      return next;
    });
    const timer = window.setTimeout(() => {
      ghostTimers.current.delete(timer);
      setGhosts((prev) => {
        const next = new Map(prev);
        for (const g of leaving) if (next.get(g.node.id) === g) next.delete(g.node.id);
        return next;
      });
    }, LEAVE_MS);
    ghostTimers.current.add(timer);
  }, [nodes, reduced, sim]);
  // A ghost whose seat came back is dropped at once.
  const visibleGhosts = [...ghosts.values()].filter((g) => !byId.has(g.node.id));

  // Hold the current nodes in the simulation; only a new or moved anchor sets anything in motion.
  const signature = `${nodes
    .map((n) => `${n.id}:${n.anchor.x.toFixed(1)},${n.anchor.y.toFixed(1)}:${n.r}:${n.pinned}`)
    .join("|")}#${reduced}`;
  const targets = useRef(nodes);
  targets.current = nodes;
  useLayoutEffect(() => {
    void signature;
    sim.sync(
      targets.current.map((n) => ({
        id: n.id,
        x: n.anchor.x,
        y: n.anchor.y,
        r: n.r,
        pinned: n.pinned,
      })),
      hubPoint(latest.current.f, "centre"),
      reduced,
    );
    paint(null);
    wake();
  }, [signature, reduced, sim, paint, wake]);

  // New messages become particles, once per read (a crew refetch hands over the same read again).
  // None while the tab is hidden or motion is reduced; the lit link says it alone.
  const flown = useRef(flows.generation);
  useEffect(() => {
    if (flows.generation === flown.current) return;
    flown.current = flows.generation;
    if (reduced || document.hidden || flows.list.length === 0) return;
    for (const flow of flows.list) {
      const [a, b] = flow.from < flow.to ? [flow.from, flow.to] : [flow.to, flow.from];
      for (let i = 0; i < Math.min(flow.n, MAX_PARTICLES_PER_FLOW); i++)
        particles.current.push({
          edge: `${a}\0${b}`,
          from: flow.from,
          to: flow.to,
          start: null,
          delay: i * PARTICLE_GAP_MS,
          el: null,
        });
    }
    wake();
  }, [flows, reduced, wake]);

  // Reduced motion stops the loop and drops anything in flight.
  useEffect(() => {
    if (!reduced) return;
    rest();
    for (const p of particles.current) p.el?.remove();
    particles.current = [];
  }, [reduced, rest]);

  // Out of view: no frames and no drift; back in view, catch up.
  useEffect(() => {
    const el = figure.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      visible.current = entry?.isIntersecting ?? true;
      el.classList.toggle("offscreen", !visible.current);
      if (visible.current) wake();
      else rest();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [wake, rest]);

  // Unmount: no frame, timer, particle or ping outlives the graph.
  useEffect(() => {
    const pings = pingTimers.current;
    const leaves = ghostTimers.current;
    return () => {
      rest();
      for (const p of particles.current) p.el?.remove();
      particles.current = [];
      for (const timer of pings) window.clearTimeout(timer);
      for (const timer of leaves) window.clearTimeout(timer);
    };
  }, [rest]);

  // Keyboard: the graph is one tab stop. Left/right walk the nodes clockwise from FLIGHT, down
  // walks the focused node's links, up (or Escape) goes back to the node.
  const order = walkOrder(nodes, centre);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [walkFrom, setWalkFrom] = useState<string | null>(null);
  const moveFocus = useRef(false);
  const linksOf = (id: string) =>
    edges
      .filter((e) => e.a === id || e.b === id)
      .map((e) => ({ e, other: byId.get(e.a === id ? e.b : e.a) }))
      .filter((x): x is { e: SpiderEdge; other: SpiderNode } => x.other !== undefined)
      .map((x) => x.e);
  const current =
    focusKey !== null &&
    (focusKey.startsWith("n:")
      ? byId.has(focusKey.slice(2))
      : edges.some((e) => `e:${e.key}` === focusKey))
      ? focusKey
      : order[0]
        ? `n:${order[0].id}`
        : null;
  const goTo = (key: string, from?: string) => {
    moveFocus.current = true;
    setFocusKey(key);
    if (from !== undefined) setWalkFrom(from);
  };
  useEffect(() => {
    if (!moveFocus.current || current === null) return;
    moveFocus.current = false;
    const el = current.startsWith("n:")
      ? nodeEls.current.get(current.slice(2))
      : edgeEls.current.get(current.slice(2));
    el?.focus();
  }, [current]);
  const nodeKeys = (node: SpiderNode) => (event: KeyboardEvent) => {
    const i = order.findIndex((n) => n.id === node.id);
    const step = (d: number) => order[(i + d + order.length) % order.length];
    // A node missing from the walk (a hidden hub) or an empty walk has nowhere to step to.
    const toNode = (target: { id: string } | undefined) => {
      if (target) goTo(`n:${target.id}`);
    };
    if (event.key === "Enter" || event.key === " ") onOpenNode(node.id);
    else if (event.key === "ArrowRight") toNode(i === -1 ? order[0] : step(1));
    else if (event.key === "ArrowLeft") toNode(i === -1 ? order.at(-1) : step(-1));
    else if (event.key === "Home") toNode(order[0]);
    else if (event.key === "End") toNode(order.at(-1));
    else if (event.key === "ArrowDown") {
      const first = linksOf(node.id)[0];
      if (!first) return;
      goTo(`e:${first.key}`, node.id);
    } else return;
    event.preventDefault();
  };
  const edgeKeys = (edge: SpiderEdge) => (event: KeyboardEvent) => {
    const from =
      walkFrom !== null && (edge.a === walkFrom || edge.b === walkFrom) ? walkFrom : edge.a;
    const list = linksOf(from);
    const i = list.findIndex((e) => e.key === edge.key);
    if (event.key === "Enter" || event.key === " ") onOpenEdge(edge.a, edge.b);
    else if (event.key === "ArrowDown" || event.key === "ArrowRight")
      goTo(`e:${list[(i + 1) % list.length]?.key}`, from);
    else if (event.key === "ArrowLeft")
      goTo(`e:${list[(i - 1 + list.length) % list.length]?.key}`, from);
    else if (event.key === "ArrowUp" || event.key === "Escape") goTo(`n:${from}`);
    else return;
    event.preventDefault();
  };

  const hovered =
    hover?.kind === "node"
      ? nodes.find((n) => n.id === hover.id)
      : hover?.kind === "edge"
        ? edges.find((e) => e.key === hover.key)
        : undefined;
  const seats = nodes.filter((n) => !n.hub || n.state !== null);
  const counts = {
    running: seats.filter((n) => n.presence === "running").length,
    idle: seats.filter((n) => n.presence === "idle").length,
    stopped: seats.filter((n) => n.presence === "stopped").length,
  };
  const awayOpen = away.length > 0 && (awayHover || awayPinned);
  const describedBy = (kind: "node" | "edge", id: string) => {
    const on =
      hover?.kind === "node"
        ? kind === "node" && hover.id === id
        : hover?.kind === "edge" && kind === "edge" && hover.key === id;
    return on ? `${tipId} ${hintId}` : hintId;
  };

  const renderNode = (node: SpiderNode, index: number, ghost?: Ghost) => {
    const p = ghost?.at ?? at(node);
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
    // Each node drifts on its own slow lap (9–15s), started part-way round so none move together.
    const lap = phaseOf(node.id) / (2 * Math.PI);
    const drift = {
      "--drift-s": `${(9 + lap * 6).toFixed(2)}s`,
      "--drift-at": `${(-lap * 15).toFixed(2)}s`,
    } as CSSProperties;
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
              tabIndex: current === `n:${node.id}` ? 0 : -1,
              "aria-label": `${node.label}, open ${node.name}, ${node.count} messages in 24h${node.state ? `, ${node.state}` : ""}`,
              "aria-describedby": describedBy("node", node.id),
              onClick: () => onOpenNode(node.id),
              onKeyDown: nodeKeys(node),
              onMouseEnter: () => setHover({ kind: "node", id: node.id }),
              onMouseLeave: () => setHover(null),
              onFocus: () => {
                setFocusKey(`n:${node.id}`);
                setHover({ kind: "node", id: node.id });
              },
              onBlur: () => setHover(null),
            })}
      >
        <g className="comms-node-drift" style={node.pinned ? undefined : drift}>
          <g
            className="comms-node-body"
            style={{ animationDelay: `${Math.min(index, 16) * 35}ms` } as CSSProperties}
          >
            <circle className="comms-node-hit" r={node.r + 9} />
            <g className="comms-node-halo">
              <circle r={node.r + 7} />
              <circle r={node.r + 3.5} />
            </g>
            <circle className="comms-node-core" r={node.r} />
            {node.hub && <circle className="comms-node-inner" r={Math.max(2, node.r - 4.5)} />}
            <circle className="comms-node-ring" r={node.r + 3.5} />
            <text className="comms-node-name" {...nameAt(node)}>
              {node.label}
            </text>
          </g>
        </g>
      </g>
    );
  };

  const tipAt = (() => {
    if (!hovered) return null;
    if ("anchor" in hovered) return { p: at(hovered), r: hovered.r };
    const a = byId.get(hovered.a);
    const b = byId.get(hovered.b);
    if (!a || !b) return null;
    return { p: curve(at(a), at(b), hovered.straight, centre).at(0.5), r: 4 };
  })();

  return (
    <figure
      ref={figure}
      className={`comms-spider${metric === "tokens" ? " tokens" : ""}`}
      aria-label={label}
    >
      <p id={hintId} className="sr-only">
        Left and right arrows move between agents; down walks an agent's links, up goes back.
      </p>
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
            // Clear of the seat names, which hang under their nodes: lower spokes' names drop.
            const drop = sin > 0.2 ? 9 : sin < -0.2 ? -3 : 0;
            // Every seat on this spoke is away: the spoke stays, dimmed and marked.
            const empty = spoke.ids.every((id) => !byId.has(id));
            return (
              <g key={spoke.key} className={`comms-spoke${empty ? " away" : ""}`}>
                <line className="comms-spoke-line" x1={f.cx} y1={f.cy} x2={tip.x} y2={tip.y} />
                <text
                  className="comms-spoke-name"
                  x={out.x}
                  y={out.y + drop}
                  dy="0.34em"
                  textAnchor={Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end"}
                >
                  {spoke.key}
                  {empty && <tspan className="away-mark"> · away</tspan>}
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
              hover?.kind === "node" && (hover.id === edge.a || hover.id === edge.b) ? "near" : "",
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
                tabIndex={current === `e:${edge.key}` ? 0 : -1}
                aria-label={`Conversation ${a.name} ↔ ${b.name}, ${count} messages in 24h`}
                aria-describedby={describedBy("edge", edge.key)}
                onClick={() => onOpenEdge(edge.a, edge.b)}
                onKeyDown={edgeKeys(edge)}
                onMouseEnter={() => setHover({ kind: "edge", key: edge.key })}
                onMouseLeave={() => setHover(null)}
                onFocus={() => {
                  setFocusKey(`e:${edge.key}`);
                  setHover({ kind: "edge", key: edge.key });
                }}
                onBlur={() => setHover(null)}
              >
                <path className="comms-edge-hit" ref={partRef(edge.key, "hit")} d={c.d} />
                <path
                  className="comms-edge-line"
                  ref={partRef(edge.key, "line")}
                  d={c.d}
                  strokeWidth={metric === "tokens" ? 1 : 1 + 2.6 * edge.weight}
                />
                {metric === "messages" && (
                  <g
                    className="comms-edge-count"
                    ref={partRef(edge.key, "chip")}
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
        <SpiderTip id={tipId} at={tipAt.p} r={tipAt.r} frame={f} subject={hovered} name={call} />
      )}
      <div className="comms-spider-legend">
        <span className="running" aria-hidden="true">
          <i className="key" />
          Running <b>{counts.running}</b>
        </span>
        <span className="idle" aria-hidden="true">
          <i className="key" />
          Idle <b>{counts.idle}</b>
        </span>
        {counts.stopped > 0 && (
          <span className="stopped" aria-hidden="true">
            <i className="key" />
            Stopped <b>{counts.stopped}</b>
          </span>
        )}
        {away.length > 0 && (
          <span className="away-wrap">
            <button
              type="button"
              className="away"
              aria-expanded={awayOpen}
              aria-controls={awayId}
              onClick={() => setAwayPinned((open) => !open)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                setAwayPinned(false);
                setAwayHover(false);
              }}
              onMouseEnter={() => setAwayHover(true)}
              onMouseLeave={() => setAwayHover(false)}
            >
              <b>{away.length}</b> away
            </button>
            <ul id={awayId} className="comms-spider-away" hidden={!awayOpen}>
              {away.map((seat) => (
                <li key={seat.id} className="away-seat">
                  <b className="away-name">{seat.name}</b> {seat.state}
                </li>
              ))}
            </ul>
          </span>
        )}
        <span className="link" aria-hidden="true">
          <i className="key" />
          {metric === "messages" ? "Msgs" : "Tokens"}
        </span>
        {!reduced && (
          <span className="particle" aria-hidden="true">
            <i className="key" />
            New
          </span>
        )}
      </div>
    </figure>
  );
}

/** One expanding ring on the node a message reached; its timer is tracked so unmount clears it. */
function ping(el: SVGGElement | undefined, timers: Set<number>) {
  const body = el?.querySelector(".comms-node-body");
  const core = el?.querySelector(".comms-node-core");
  if (!body || !core) return;
  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("class", "comms-node-ping");
  ring.setAttribute("r", core.getAttribute("r") ?? "6");
  body.append(ring);
  const timer = window.setTimeout(() => {
    timers.delete(timer);
    ring.remove();
  }, PING_MS);
  timers.add(timer);
}

/**
 * Where the hover card goes: beside the subject on whichever side it fits, else under (or over)
 * it, clamped inside the stage, so a hub's card never runs off the panel.
 */
export function tipPlacement(at: Point, r: number, f: Frame): CSSProperties {
  const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(2)}%`;
  const gap = TIP_GAP + r;
  if (at.x + gap + TIP_W <= f.w)
    return { left: pct(at.x + gap, f.w), top: pct(at.y, f.h), transform: "translateY(-50%)" };
  if (at.x - gap - TIP_W >= 0)
    return {
      left: pct(at.x - gap - TIP_W, f.w),
      top: pct(at.y, f.h),
      transform: "translateY(-50%)",
    };
  const left = Math.min(Math.max(0, at.x - TIP_W / 2), Math.max(0, f.w - TIP_W));
  const below = at.y < f.h * 0.55;
  return {
    left: pct(left, f.w),
    top: pct(below ? at.y + gap : at.y - gap, f.h),
    transform: below ? "none" : "translateY(-100%)",
  };
}

/** The hover card: who, state, counts both ways and the newest message. */
function SpiderTip({
  id,
  at,
  r,
  frame: f,
  subject,
  name,
}: {
  id: string;
  at: Point;
  r: number;
  frame: Frame;
  subject: SpiderNode | SpiderEdge;
  name: (id: string) => string;
}) {
  const now = useNow();
  const tz = useTz();
  const last = subject.last;
  const total = "anchor" in subject ? subject.count : subject.aToB + subject.bToA;
  return (
    <div id={id} className="comms-spider-tip" style={tipPlacement(at, r, f)} role="tooltip">
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
