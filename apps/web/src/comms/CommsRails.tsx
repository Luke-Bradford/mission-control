import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNow, useTz } from "../clock.ts";
import { plural, rel } from "../fmt.ts";
import {
  type Flows,
  type LastMessage,
  type Presence,
  type Waiting,
  waitWord,
} from "./chartTypes.ts";
import { type ChartFilter, filterKeeps, filterLabel, pairFilter } from "./commsFilter.ts";
import {
  HUB_W,
  linkPath,
  NAME_ROOM,
  nameHalf,
  nameRect,
  type Point,
  placeWaitMarks,
  type RailGroup,
  type RailLayout,
  shownName,
  WAIT_H,
  waitMarkWidth,
} from "./rails.ts";
import "./CommsRails.css";

/** One seat or hub on the chart. */
export type RailSeatView = {
  id: string;
  /** The call sign printed by the seat. */
  name: string;
  /** Role title for the hover card; null for CAPCOM and #crew. */
  role: string | null;
  color: string;
  presence: Presence;
  /** The HUD state as the operator reads it (`Idle`, `Crew paused`); null for CAPCOM and #crew. */
  state: string | null;
  since: number | null;
  /** Error or stalled: ringed in --crit. */
  alert: boolean;
  hub: boolean;
  sent: number;
  received: number;
};

/** A link between two seats, both directions together. */
export type RailEdgeView = {
  key: string;
  a: string;
  b: string;
  aToB: number;
  bToA: number;
  /** 0..1, the link's share of the busiest link (square-root scaled). */
  weight: number;
  last: LastMessage | null;
  waiting: Waiting | null;
};

export type ChartMode = "all" | "open";

const PARTICLE_MS = 1_150;
const PARTICLE_GAP_MS = 200;
/** How long a link stays lit after a new message on it. */
const LIVE_MS = 1_800;
/** The chart's size before it is measured (and in tests, where nothing is laid out). */
const DEFAULT_SIZE = { w: 360, h: 420 };
const TIP_W = 240;
/** Where a link meets a seat: a hub's pill edge facing the other end, else the seat's dot. */
function meetAt(layout: RailLayout, id: string, other: string): Point | undefined {
  const where = (x: string) => layout.seats.get(x) ?? layout.hubs.get(x);
  const p = where(id);
  const q = where(other);
  if (!p || !q) return undefined;
  if (!layout.hubs.has(id) || layout.hubs.has(other)) return p;
  return { x: p.x + (q.x < p.x ? -HUB_W / 2 : HUB_W / 2), y: p.y };
}

/** `delay` is the stagger in ms; `begin` is when it starts on the overlay's own SMIL clock (s). */
type Particle = { id: number; d: string; color: string; delay: number; begin: number; to: string };
type Tip = { kind: "seat" | "edge"; id: string } | null;

/** The wait mark's words. */
const waitLabel = (w: Waiting) => `⧖ ${waitWord(w.ms)}`;

const keyOf = (a: string, b: string) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);

/** A small, deterministic force pass keeps frequent correspondents close without a simulation loop. */
function organicLayout(
  seats: readonly RailSeatView[],
  edges: readonly RailEdgeView[],
  size: { w: number; h: number },
  full: boolean,
): RailLayout {
  const w = Math.max(300, size.w);
  // Give the graph enough vertical perimeter for the labels as the crew grows. The scroll owner is
  // the chart, so a busy session grows there rather than turning names into an unreadable cluster.
  const h = Math.max(260, size.h, seats.length > 13 ? seats.length * 20 + 180 : size.h);
  const positions = new Map<string, Point>();
  const cx = w / 2;
  const cy = h / 2;
  // What each node takes up around its point: names sit under their dots, hubs are pills.
  const room = new Map(
    seats.map((seat) => [
      seat.id,
      seat.hub
        ? { hw: HUB_W / 2 + 2, up: 13, down: 13 }
        : { hw: nameHalf(shownName(seat.name, full)), up: 12, down: 28 },
    ]),
  );
  const roomOf = (id: string) => room.get(id) as { hw: number; up: number; down: number };
  const keep = (id: string, p: Point) => {
    const { hw, up, down } = roomOf(id);
    const x0 = hw + 8;
    const x1 = w - hw - 8;
    p.x = x1 < x0 ? cx : Math.min(x1, Math.max(x0, p.x));
    p.y = Math.min(h - down - 6, Math.max(up + 6, p.y));
  };
  const rx = Math.max(32, (w - NAME_ROOM * 2 - 40) / 2);
  const ry = Math.max(80, h * 0.4);
  const hash = (id: string) => [...id].reduce((n, char) => (n * 31 + char.charCodeAt(0)) >>> 0, 7);
  seats.forEach((seat, index) => {
    // A deterministic, irregular ring gives every label a berth before the force pass draws
    // frequent correspondents closer. The hashed offset means it never reads as a fixed grid.
    const angle =
      (Math.PI * 2 * index) / Math.max(1, seats.length) + ((hash(seat.id) % 17) - 8) * 0.008;
    positions.set(seat.id, {
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry,
    });
  });
  for (let pass = 0; pass < 18; pass++) {
    const delta = new Map(seats.map((seat) => [seat.id, { x: 0, y: 0 }]));
    for (let left = 0; left < seats.length; left++)
      for (let right = left + 1; right < seats.length; right++) {
        const a = positions.get(seats[left]?.id ?? "") as Point;
        const b = positions.get(seats[right]?.id ?? "") as Point;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.max(16, Math.hypot(dx, dy));
        const push = 1_800 / (distance * distance);
        const da = delta.get(seats[left]?.id ?? "") as Point;
        const db = delta.get(seats[right]?.id ?? "") as Point;
        da.x += (dx / distance) * push;
        da.y += (dy / distance) * push;
        db.x -= (dx / distance) * push;
        db.y -= (dy / distance) * push;
      }
    for (const edge of edges) {
      const a = positions.get(edge.a);
      const b = positions.get(edge.b);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const pull = (distance - 112) * (0.002 + edge.weight * 0.006);
      const da = delta.get(edge.a) as Point;
      const db = delta.get(edge.b) as Point;
      da.x += (dx / distance) * pull;
      da.y += (dy / distance) * pull;
      db.x -= (dx / distance) * pull;
      db.y -= (dy / distance) * pull;
    }
    for (const seat of seats) {
      const p = positions.get(seat.id) as Point;
      const d = delta.get(seat.id) as Point;
      p.x += d.x + (cx - p.x) * 0.002;
      p.y += d.y + (cy - p.y) * 0.002;
      keep(seat.id, p);
    }
  }
  // Last, push apart any two nodes whose boxes (dot, name, pill) still meet, so no name is covered.
  const PAD = 4;
  for (let pass = 0; pass < 120; pass++) {
    let moved = false;
    for (let i = 0; i < seats.length; i++)
      for (let j = i + 1; j < seats.length; j++) {
        const ia = seats[i]?.id ?? "";
        const ib = seats[j]?.id ?? "";
        const a = positions.get(ia) as Point;
        const b = positions.get(ib) as Point;
        const ra = roomOf(ia);
        const rb = roomOf(ib);
        const overX = ra.hw + rb.hw + PAD - Math.abs(a.x - b.x);
        const overY =
          Math.min(a.y + ra.down, b.y + rb.down) - Math.max(a.y - ra.up, b.y - rb.up) + PAD;
        if (overX <= 0 || overY <= 0) continue;
        moved = true;
        if (overY <= overX) {
          const dir = Math.sign(b.y - a.y) || (i % 2 ? 1 : -1);
          a.y -= (dir * (overY + 1)) / 2;
          b.y += (dir * (overY + 1)) / 2;
        } else {
          const dir = Math.sign(b.x - a.x) || (i % 2 ? 1 : -1);
          a.x -= (dir * (overX + 1)) / 2;
          b.x += (dir * (overX + 1)) / 2;
        }
      }
    for (const seat of seats) keep(seat.id, positions.get(seat.id) as Point);
    if (!moved) break;
  }
  const regular = new Map<string, Point & { side: "left" | "right" }>();
  const hubs = new Map<string, Point>();
  for (const seat of seats) {
    const p = positions.get(seat.id) as Point;
    if (seat.hub) hubs.set(seat.id, p);
    else regular.set(seat.id, { ...p, side: p.x < w / 2 ? "left" : "right" });
  }
  return {
    w,
    h,
    cx,
    leftX: 0,
    rightX: w,
    nameRoom: NAME_ROOM,
    rowH: 40,
    seats: regular,
    hubs,
    headers: [],
  };
}

/** The All / Open switch, in the panel's title row and the full-screen view's. */
export function ChartModeSwitch({
  mode,
  onChange,
  openCount,
}: {
  mode: ChartMode;
  onChange: (mode: ChartMode) => void;
  openCount: number;
}) {
  return (
    <fieldset className="comms-metric">
      <legend className="sr-only">Show links</legend>
      <button
        type="button"
        className={mode === "all" ? "on" : ""}
        aria-pressed={mode === "all"}
        onClick={() => onChange("all")}
      >
        All
      </button>
      <button
        type="button"
        className={mode === "open" ? "on" : ""}
        aria-pressed={mode === "open"}
        onClick={() => onChange("open")}
        title="Links with a question or blocker waiting for an answer. One answered by a reaction still shows until the hub closes it."
      >
        Open{openCount > 0 ? ` ${openCount}` : ""}
      </button>
    </fieldset>
  );
}

/**
 * The Comms chart: two facing rails of seats grouped by role, CAPCOM, FLIGHT and #crew on the centre
 * line, a line per conversation, a dot travelling along it for each new message, and a dashed line
 * with the wait in words where someone is waiting on an answer. A click, Enter or Space on a seat
 * or a line narrows the chart to it (the parent decides what that does); Escape clears.
 */
export function CommsRails({
  seats,
  groups,
  hubIds,
  edges,
  mode,
  filter,
  flows,
  reduced,
  label,
  full,
  onPickSeat,
  onPickLink,
  onClear,
}: {
  seats: readonly RailSeatView[];
  groups: readonly RailGroup[];
  hubIds: readonly [string, string, string];
  edges: readonly RailEdgeView[];
  mode: ChartMode;
  filter: ChartFilter | null;
  flows: Flows;
  reduced: boolean;
  label: string;
  /** The full-screen view: full seat names, more room. */
  full: boolean;
  onPickSeat: (id: string) => void;
  onPickLink: (a: string, b: string) => void;
  onClear: () => void;
}) {
  // Kept in the public chart contract while the organic layout derives its own topology from edges.
  void groups;
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [tip, setTip] = useState<Tip>(null);
  const [activeSeat, setActiveSeat] = useState<string | null>(null);
  const [activeEdge, setActiveEdge] = useState<string | null>(null);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [arrivals, setArrivals] = useState<ReadonlySet<string>>(new Set());
  const [lit, setLit] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Set<number>());
  const nextParticle = useRef(0);
  const overlay = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = (box: { width: number; height: number }) => {
      if (box.width > 0 && box.height > 0)
        setSize((current) => {
          const next = { w: Math.round(box.width), h: Math.round(box.height) };
          return current.w === next.w && current.h === next.h ? current : next;
        });
    };
    measure(el.getBoundingClientRect());
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box) measure(box);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const byId = useMemo(() => new Map(seats.map((s) => [s.id, s])), [seats]);
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const layout = useMemo(() => organicLayout(seats, edges, size, full), [seats, edges, size, full]);
  const point = (id: string): Point | undefined => layout.seats.get(id) ?? layout.hubs.get(id);

  const shown = useMemo(
    () => edges.filter((edge) => (mode === "open" ? edge.waiting !== null : true)),
    [edges, mode],
  );
  const drawn = useMemo(
    () =>
      shown.flatMap((edge) => {
        const a = meetAt(layout, edge.a, edge.b);
        const b = meetAt(layout, edge.b, edge.a);
        if (!a || !b) return [];
        return [{ edge, path: linkPath(a, b, layout.cx) }];
      }),
    [shown, layout],
  );

  // Wait marks sit near the seat owing the reply, longest wait first, clear of each other and
  // the hub pills. A mark with no room is left off its link and counted in the note instead.
  const waitSpots = useMemo(() => {
    const waiting = drawn
      .filter(({ edge }) => edge.waiting !== null)
      .sort((x, y) => (y.edge.waiting?.ms ?? 0) - (x.edge.waiting?.ms ?? 0));
    const out = placeWaitMarks(
      waiting.map(({ edge, path }) => ({
        key: edge.key,
        at: path.at,
        askerFirst:
          (edge.waiting?.owed ?? (edge.waiting?.asker === edge.a ? edge.b : edge.a)) === edge.a,
        width: waitMarkWidth(waitLabel(edge.waiting as Waiting)),
      })),
      [...layout.hubs.values()],
      [...layout.seats.values()],
      seats.flatMap((seat) => {
        const p = layout.seats.get(seat.id);
        return p ? [nameRect(p, nameHalf(shownName(seat.name, full)))] : [];
      }),
    );
    const left = waiting.filter(({ edge }) => out.dropped.includes(edge.key));
    return {
      placed: out.placed,
      more: left.length,
      longest: Math.max(0, ...left.map(({ edge }) => edge.waiting?.ms ?? 0)),
    };
  }, [drawn, layout, seats, full]);

  // Who is inside the filter: its own ends, and the ends of every drawn link it keeps.
  const inside = useMemo(() => {
    if (filter === null) return null;
    const ids = new Set<string>(filter.kind === "seat" ? [filter.id] : [filter.a, filter.b]);
    for (const { edge } of drawn)
      if (filterKeeps(filter, edge.a, edge.b)) ids.add(edge.a).add(edge.b);
    return ids;
  }, [filter, drawn]);
  const waitingSeats = useMemo(
    () =>
      new Set(
        shown.flatMap((e) =>
          e.waiting ? [e.waiting.owed ?? (e.waiting.asker === e.a ? e.b : e.a)] : [],
        ),
      ),
    [shown],
  );

  // A new message: a dot on its link (a few at most), and the link lit for a moment.
  const generation = flows.generation;
  const seenGeneration = useRef(generation);
  const latest = useRef({ flows, reduced, layout, byId });
  latest.current = { flows, reduced, layout, byId };
  useEffect(() => {
    const { flows: read, reduced, layout, byId } = latest.current;
    if (generation === seenGeneration.current) return;
    seenGeneration.current = generation;
    const keys = new Set<string>();
    const fresh: Particle[] = [];
    const clockNow = overlay.current?.getCurrentTime?.() ?? 0;
    for (const flow of read.list) {
      const a = meetAt(layout, flow.from, flow.to);
      const b = meetAt(layout, flow.to, flow.from);
      if (!a || !b) continue;
      keys.add(keyOf(flow.from, flow.to));
      if (reduced) continue;
      const { d } = linkPath(a, b, layout.cx);
      const color = byId.get(flow.from)?.color ?? "var(--accent)";
      for (let i = 0; i < flow.n; i++)
        fresh.push({
          id: nextParticle.current++,
          d,
          color,
          delay: i * PARTICLE_GAP_MS,
          // SMIL counts from when the overlay first loaded, so "0ms" would be long past: start at
          // the clock's current time plus the stagger.
          begin: clockNow + (i * PARTICLE_GAP_MS) / 1000,
          to: flow.to,
        });
    }
    if (keys.size > 0) {
      setLit(keys);
      const off = window.setTimeout(() => {
        timers.current.delete(off);
        setLit(new Set());
      }, LIVE_MS);
      timers.current.add(off);
    }
    if (fresh.length > 0) {
      const added = fresh;
      setParticles((current) => [...current, ...added]);
      const ids = new Set(added.map((p) => p.id));
      const life = PARTICLE_MS + PARTICLE_GAP_MS * Math.max(0, added.length - 1) + 100;
      const gone = window.setTimeout(() => {
        timers.current.delete(gone);
        setParticles((current) => current.filter((p) => !ids.has(p.id)));
      }, life);
      timers.current.add(gone);
      for (const particle of added) {
        const arrive = window.setTimeout(() => {
          timers.current.delete(arrive);
          setArrivals((current) => new Set(current).add(particle.to));
          const clear = window.setTimeout(() => {
            timers.current.delete(clear);
            setArrivals((current) => {
              const next = new Set(current);
              next.delete(particle.to);
              return next;
            });
          }, 500);
          timers.current.add(clear);
        }, PARTICLE_MS + particle.delay);
        timers.current.add(arrive);
      }
    }
  }, [generation]);
  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const t of live) window.clearTimeout(t);
      live.clear();
    };
  }, []);

  // Escape clears the filter wherever focus is, unless the key is for a field being typed in.
  useEffect(() => {
    if (filter === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      onClear();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filter, onClear]);

  // One tab stop for the seats and one for the links; arrows walk each.
  const seatOrder = useMemo(() => {
    const rail = (side: "left" | "right") =>
      [...layout.seats]
        .filter(([, s]) => s.side === side)
        .sort(([, a], [, b]) => a.y - b.y)
        .map(([id]) => id);
    return [...rail("left"), ...hubIds, ...rail("right")].filter((id) => byId.has(id));
  }, [layout, hubIds, byId]);
  const edgeOrder = drawn.map(({ edge }) => edge.key);
  const seatStop =
    activeSeat !== null && seatOrder.includes(activeSeat) ? activeSeat : seatOrder[0];
  const edgeStop =
    activeEdge !== null && edgeOrder.includes(activeEdge) ? activeEdge : edgeOrder[0];

  const walk = (
    e: KeyboardEvent,
    order: readonly string[],
    current: string,
    set: (id: string) => void,
    attr: "data-id" | "data-key",
  ) => {
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : e.key === "Home"
            ? -Infinity
            : e.key === "End"
              ? Infinity
              : 0;
    if (step === 0) return;
    e.preventDefault();
    const i = order.indexOf(current);
    const next =
      order[
        Math.max(
          0,
          Math.min(
            order.length - 1,
            Number.isFinite(step) ? i + step : step < 0 ? 0 : order.length - 1,
          ),
        )
      ];
    if (next === undefined) return;
    set(next);
    const target = [...(root.current?.querySelectorAll<HTMLElement>(`[${attr}]`) ?? [])].find(
      (el) => el.getAttribute(attr) === next,
    );
    target?.focus();
  };

  const press = (e: KeyboardEvent, act: () => void) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      act();
    }
  };

  const pickEdge = (edge: RailEdgeView) => onPickLink(edge.a, edge.b);
  const total = (e: RailEdgeView) => e.aToB + e.bToA;
  const edgeLabel = (e: RailEdgeView) =>
    `${nameOf(e.a)} ↔ ${nameOf(e.b)}, ${plural(total(e), "message")}${
      e.waiting ? `, waiting ${waitWord(e.waiting.ms)}` : ""
    }. Narrow the chart to this conversation`;
  const seatLabel = (s: RailSeatView) =>
    `${s.name}, ${[s.role, s.state].filter(Boolean).join(", ") || "channel"}, sent ${s.sent}, received ${s.received}${
      waitingSeats.has(s.id) ? ", owes a reply" : ""
    }. Narrow the chart to ${s.name}`;

  // The links and seats do not depend on the hover card, so hovering re-renders only the card.
  // biome-ignore lint/correctness/useExhaustiveDependencies: helpers below derive from these inputs
  const edgeMarks = useMemo(
    () => (
      <g className="comms-edges">
        {drawn.map(({ edge, path }, index) => {
          const kept = filterKeeps(filter, edge.a, edge.b);
          const chosen = filter !== null && filter.kind === "pair" && kept;
          const cls = [
            "comms-edge",
            edge.waiting ? "waiting" : "",
            lit.has(keyOf(edge.a, edge.b)) ? "live" : "",
            filter !== null && !kept ? "dim" : "",
            chosen ? "focus" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const w = 1 + edge.weight * 2.5;
          const age =
            edge.last === null ? 24 * 60 * 60_000 : Math.max(0, Date.now() - edge.last.at);
          const opacity = 0.18 + 0.72 * Math.max(0, 1 - age / (24 * 60 * 60_000));
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
            <g
              key={edge.key}
              className={cls}
              data-key={edge.key}
              role="button"
              tabIndex={edge.key === edgeStop ? 0 : -1}
              aria-label={edgeLabel(edge)}
              aria-pressed={chosen}
              onClick={() => pickEdge(edge)}
              onKeyDown={(e) => {
                press(e, () => pickEdge(edge));
                walk(e, edgeOrder, edge.key, setActiveEdge, "data-key");
              }}
              onFocus={() => {
                setActiveEdge(edge.key);
                setTip({ kind: "edge", id: edge.key });
              }}
              onBlur={() => setTip(null)}
              onMouseEnter={() => {
                setTip({ kind: "edge", id: edge.key });
              }}
              onMouseLeave={() => setTip(null)}
            >
              <path className="comms-edge-hit" d={path.d} />
              <path
                className="comms-edge-line"
                d={path.d}
                strokeWidth={w}
                stroke={`url(#${uid}-edge-${index})`}
                style={{ opacity } as CSSProperties}
                strokeDasharray={edge.waiting ? "6 4" : undefined}
              />
              {edge.waiting && waitSpots.placed.get(edge.key) && (
                <g
                  className="comms-wait-mark"
                  transform={`translate(${(waitSpots.placed.get(edge.key) as Point).x.toFixed(1)} ${(waitSpots.placed.get(edge.key) as Point).y.toFixed(1)})`}
                >
                  <rect
                    x={-waitMarkWidth(waitLabel(edge.waiting)) / 2}
                    y={-WAIT_H / 2}
                    width={waitMarkWidth(waitLabel(edge.waiting))}
                    height={WAIT_H}
                    rx={WAIT_H / 2}
                  />
                  <text textAnchor="middle" dy="0.34em">
                    {waitLabel(edge.waiting)}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </g>
    ),
    [drawn, filter, lit, edgeStop, onPickLink, byId, waitSpots, uid],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: helpers below derive from these inputs
  const nodeMarks = useMemo(
    () => (
      <g className="comms-nodes">
        {seats.map((seat) => {
          const p = point(seat.id);
          if (!p) return null;
          const hub = seat.hub;
          const dim = inside !== null && !inside.has(seat.id);
          const selected =
            filter !== null &&
            (filter.kind === "seat"
              ? filter.id === seat.id
              : filter.a === seat.id || filter.b === seat.id);
          const cls = [
            "comms-node",
            hub ? "hub" : "",
            `presence-${seat.presence}`,
            seat.alert ? "alert" : "",
            waitingSeats.has(seat.id) ? "waiting" : "",
            arrivals.has(seat.id) ? "arrival" : "",
            dim ? "dim" : "",
            selected ? "selected" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const r = hub ? 0 : seat.presence === "running" ? 6 : 5;
          const shown = shownName(seat.name, full);
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
            <g
              key={seat.id}
              className={cls}
              data-id={seat.id}
              style={{ "--node-color": seat.color } as CSSProperties}
              transform={`translate(${p.x} ${p.y})`}
              role="button"
              tabIndex={seat.id === seatStop ? 0 : -1}
              aria-label={seatLabel(seat)}
              aria-pressed={selected}
              onClick={() => onPickSeat(seat.id)}
              onKeyDown={(e) => {
                press(e, () => onPickSeat(seat.id));
                walk(e, seatOrder, seat.id, setActiveSeat, "data-id");
              }}
              onFocus={() => {
                setActiveSeat(seat.id);
                setTip({ kind: "seat", id: seat.id });
              }}
              onBlur={() => setTip(null)}
              onMouseEnter={() => {
                setTip({ kind: "seat", id: seat.id });
              }}
              onMouseLeave={() => setTip(null)}
            >
              {hub ? (
                <>
                  <rect
                    className="comms-node-hit"
                    x={-HUB_W / 2}
                    y={-13}
                    width={HUB_W}
                    height={26}
                    rx={13}
                  />
                  <rect
                    className="comms-node-core"
                    x={-HUB_W / 2}
                    y={-11}
                    width={HUB_W}
                    height={22}
                    rx={11}
                  />
                  <text className="comms-node-name hub-name" textAnchor="middle" dy="0.34em">
                    {seat.name}
                  </text>
                </>
              ) : (
                <>
                  <rect
                    className="comms-node-hit"
                    x={-nameHalf(shown)}
                    y={-14}
                    width={nameHalf(shown) * 2}
                    height={layout.rowH}
                  />
                  <circle className="comms-node-ring" r={r + 4} />
                  <circle className="comms-node-core" r={r} />
                  <text className="comms-node-name" y={r + 17} textAnchor="middle">
                    {shown}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </g>
    ),
    [
      seats,
      layout,
      hubIds,
      filter,
      inside,
      waitingSeats,
      seatStop,
      full,
      onPickSeat,
      particles.length,
      arrivals,
    ],
  );

  const tipFor = () => {
    if (tip === null) return null;
    if (tip.kind === "seat") {
      const seat = byId.get(tip.id);
      const p = point(tip.id);
      return seat && p
        ? {
            p,
            node: (
              <SeatTip
                seat={seat}
                waiting={shown.filter((e) => e.waiting && (e.a === seat.id || e.b === seat.id))}
                nameOf={nameOf}
              />
            ),
          }
        : null;
    }
    const hit = drawn.find(({ edge }) => edge.key === tip.id);
    return hit ? { p: hit.path.mid, node: <EdgeTip edge={hit.edge} nameOf={nameOf} /> } : null;
  };
  const tipped = tipFor();
  const tipStyle = (p: Point): CSSProperties => {
    const left = Math.min(Math.max(0, p.x + 14), Math.max(0, layout.w - TIP_W));
    return p.y > layout.h * 0.6 ? { left, bottom: layout.h - p.y + 14 } : { left, top: p.y + 14 };
  };

  const empty = drawn.length === 0;

  return (
    <div className={`comms-rails${full ? " full" : ""}`}>
      {filter !== null && (
        <p className="comms-filter-chip" role="status">
          <span>
            Showing <b>{filterLabel(filter, nameOf)}</b>
          </span>
          <button type="button" onClick={onClear} aria-label="Clear filter (Esc)">
            Clear <kbd>Esc</kbd>
          </button>
        </p>
      )}
      <div className="comms-rails-scroll" ref={root}>
        <div className="comms-rails-canvas" style={{ width: layout.w, height: layout.h }}>
          {/* biome-ignore lint/a11y/useSemanticElements: an SVG cannot be a <fieldset> */}
          <svg
            className="comms-rails-svg"
            width={layout.w}
            height={layout.h}
            viewBox={`0 0 ${layout.w} ${layout.h}`}
            role="group"
            aria-label={label}
          >
            <title>{label}</title>
            <defs>
              {drawn.map(({ edge }, index) => (
                <linearGradient
                  id={`${uid}-edge-${index}`}
                  key={edge.key}
                  x1="0"
                  x2="1"
                  y1="0"
                  y2="0"
                >
                  <stop stopColor={byId.get(edge.a)?.color ?? "var(--fg-2)"} offset="0" />
                  <stop stopColor={byId.get(edge.b)?.color ?? "var(--fg-2)"} offset="1" />
                </linearGradient>
              ))}
            </defs>
            <g className="comms-network">
              {edgeMarks}
              {nodeMarks}
            </g>
          </svg>
          {/* The travelling dots live on their own layer, so animating them repaints only them. */}
          <svg
            ref={overlay}
            className="comms-rails-overlay"
            width={layout.w}
            height={layout.h}
            viewBox={`0 0 ${layout.w} ${layout.h}`}
            aria-hidden="true"
          >
            <g className="comms-particles">
              {particles.map((p) => (
                // Hidden outside its own interval: the opacity animation below overrides this while the
                // light runs, so one waiting its turn or already arrived is not drawn at (0, 0).
                <circle key={p.id} className="comms-particle" r={3.5} fill={p.color} opacity={0}>
                  <animateMotion path={p.d} dur={`${PARTICLE_MS}ms`} begin={`${p.begin}s`} />
                  <animate
                    attributeName="opacity"
                    values="0;1;1;0"
                    keyTimes="0;0.1;0.9;1"
                    dur={`${PARTICLE_MS}ms`}
                    begin={`${p.begin}s`}
                  />
                </circle>
              ))}
            </g>
          </svg>
          {tipped && (
            <div
              id={`${uid}-tip`}
              className="comms-rails-tip"
              role="tooltip"
              style={tipStyle(tipped.p)}
            >
              {tipped.node}
            </div>
          )}
          {waitSpots.more > 0 && (
            <p className="comms-wait-more" role="status">
              +{waitSpots.more} more waiting, longest {waitWord(waitSpots.longest)}
            </p>
          )}
          {empty && (
            <p className="comms-empty">
              {mode === "open"
                ? "Nobody is waiting on an answer."
                : "No direct messages in the last 24h."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SeatTip({
  seat,
  waiting,
  nameOf,
}: {
  seat: RailSeatView;
  waiting: readonly RailEdgeView[];
  nameOf: (id: string) => string;
}) {
  const now = useNow();
  const tz = useTz();
  return (
    <>
      <p className="tip-head">
        <i className="tip-dot" style={{ background: seat.color }} />
        <b className="tip-name">{seat.name}</b>
        {seat.role && <span className="tip-role">{seat.role}</span>}
      </p>
      {seat.state && (
        <p className={`tip-state presence-${seat.presence}${seat.alert ? " alert" : ""}`}>
          {seat.state}
          {seat.since !== null && tz ? ` · ${rel(seat.since, now, tz)}` : ""}
        </p>
      )}
      <p className="tip-meta">
        Sent {seat.sent} · received {seat.received} · 24h
      </p>
      {waiting.map((e) =>
        e.waiting ? (
          <p key={e.key} className="tip-wait">
            <b>
              {nameOf(e.waiting.asker)} is waiting on{" "}
              {nameOf(e.waiting.owed ?? (e.waiting.asker === e.a ? e.b : e.a))} ·{" "}
              {waitWord(e.waiting.ms)}
            </b>
            {e.waiting.question && <q>{e.waiting.question}</q>}
          </p>
        ) : null,
      )}
    </>
  );
}

function EdgeTip({ edge, nameOf }: { edge: RailEdgeView; nameOf: (id: string) => string }) {
  const now = useNow();
  const tz = useTz();
  const last = edge.last;
  return (
    <>
      <p className="tip-head">
        <b className="tip-name">
          {nameOf(edge.a)} ↔ {nameOf(edge.b)}
        </b>
      </p>
      <p className="tip-meta">
        {nameOf(edge.a)} → {edge.aToB} · {nameOf(edge.b)} → {edge.bToA}
      </p>
      {edge.waiting && (
        <p className="tip-wait">
          <b>
            {nameOf(edge.waiting.asker)} is waiting on{" "}
            {nameOf(edge.waiting.owed ?? (edge.waiting.asker === edge.a ? edge.b : edge.a))} ·{" "}
            {waitWord(edge.waiting.ms)}
            {edge.waiting.n > 1 ? ` · ${edge.waiting.n} open` : ""}
          </b>
          {edge.waiting.question && <q>{edge.waiting.question}</q>}
        </p>
      )}
      {last && (
        <p className="tip-last">
          <span className="tip-meta">
            {nameOf(last.from)} → {nameOf(last.to)} · {tz ? rel(last.at, now, tz) : "—"}
          </span>
          <q>{last.text}</q>
        </p>
      )}
    </>
  );
}

export { pairFilter };
