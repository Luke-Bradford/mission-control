import { BUILTIN_ROLES, type CrewRow } from "@mc/core";

/**
 * The Comms graph's layout and physics, kept free of React and the DOM so both can be tested.
 *
 * FLIGHT sits at the centre with CAPCOM above it and the #crew channel below; every other seat sits
 * on its role's spoke (observed loops share one), anchored at a fixed point along it. A small
 * spring simulation holds each node near its anchor, so a node that appears springs out along its
 * spoke, a node whose anchor moves eases there, and in motion mode every seat drifts a few pixels
 * round its anchor. Positions live in the simulation, not in React state, so a data refetch that
 * changes nothing moves nothing.
 */

/** How present a seat is: running seats glow, idle ones dim, stopped or paused ones fade back. */
export type Presence = "running" | "idle" | "stopped";

export function presenceOf(row: CrewRow): Presence {
  if (row.paused || row.crewPause != null || row.hudState === "stopped") return "stopped";
  return row.hudState === "running" ? "running" : "idle";
}

/** Observed loops share one spoke. */
export const LOOPS_SPOKE = "LOOPS";

export type Point = { x: number; y: number };
/** The graph's coordinate space: its measured box, the centre and the spokes' reach. */
export type Frame = { w: number; h: number; cx: number; cy: number; rx: number; ry: number };

/** The graph's size before it is measured (and in tests, where nothing is laid out). */
export const DEFAULT_SIZE = { w: 340, h: 360 };

/** The strip under the plot that holds the legend. */
export const LEGEND_PX = 20;
/** How far a tall panel may stretch the web vertically, as a multiple of its width. */
const MAX_STRETCH = 1.5;

export function frameFor(size: { w: number; h: number }): Frame {
  const w = Math.max(240, size.w);
  const h = Math.max(240, size.h);
  const plot = h - LEGEND_PX;
  // Room outside the web for the spokes' labels.
  const rx = Math.min(w / 2 - 46, plot / 2 - 26);
  // A tall panel stretches the web to fill it; spokesFor widens the spread to match.
  const ry = Math.min(plot / 2 - 26, rx * MAX_STRETCH);
  return { w, h, cx: w / 2, cy: plot / 2, rx, ry };
}

export type Spoke = { key: string; angle: number; ids: string[] };

/** Built-in roles first in their own order, then configured roles A–Z, then the loops. */
function spokeOrder(keys: string[]): string[] {
  const builtin = Object.keys(BUILTIN_ROLES);
  const rank = (key: string) =>
    key === LOOPS_SPOKE ? Number.POSITIVE_INFINITY : builtin.indexOf(key) + 1 || builtin.length + 1;
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Angles (degrees, y down) for `k` spokes on one side, centred on the horizontal. A web stretched
 * tall (`stretch` = ry / rx above 1) spreads them wider, up to a third more, so they reach into it.
 */
function sideAngles(k: number, stretch: number): number[] {
  if (k <= 1) return [0];
  const tall = Math.min(1, Math.max(0, (stretch - 1) / (MAX_STRETCH - 1)));
  const span = Math.min(100, 36 * (k - 1)) * (1 + tall / 3);
  return Array.from({ length: k }, (_, i) => -span / 2 + (span * i) / (k - 1));
}

/**
 * One spoke per role (and one for the loops), alternating right and left of FLIGHT so the top and
 * bottom stay clear for CAPCOM and #crew. Seats on a spoke keep config order.
 */
export function spokesFor(rows: readonly CrewRow[], flight: string, stretch = 1): Spoke[] {
  const groups = new Map<string, CrewRow[]>();
  for (const row of rows) {
    if (row.id === flight) continue;
    const key = row.kind === "loop" ? LOOPS_SPOKE : (row.role ?? "CREW");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const keys = spokeOrder([...groups.keys()]);
  const right = keys.filter((_, i) => i % 2 === 0);
  const left = keys.filter((_, i) => i % 2 === 1);
  const rightAngles = sideAngles(right.length, stretch);
  const leftAngles = sideAngles(left.length, stretch).map((a) => 180 - a);
  return keys.map((key, i) => ({
    key,
    angle: (i % 2 === 0 ? rightAngles[i / 2] : leftAngles[(i - 1) / 2]) ?? 0,
    ids: (groups.get(key) ?? []).sort((a, b) => a.index - b.index).map((row) => row.id),
  }));
}

/**
 * The role name drawn at a spoke's rim, or null when it would only repeat the one seat on it
 * (GUIDO-1 under "GUIDO"): the seat's own name says the role, and the rail has no room for both.
 */
export function spokeName(
  spoke: Pick<Spoke, "key" | "ids">,
  present: (id: string) => boolean,
  nameOf: (id: string) => string,
): string | null {
  const ids = spoke.ids.filter(present);
  if (
    ids.length === 1 &&
    nameOf(ids[0] as string)
      .toUpperCase()
      .startsWith(spoke.key.toUpperCase())
  )
    return null;
  return spoke.key;
}

/** Where seat `i` of `n` sits along a spoke, as a fraction of the spoke's reach. */
export function spokeFraction(i: number, n: number): number {
  if (n <= 1) return 0.66;
  return 0.44 + (0.48 * i) / (n - 1);
}

export function onSpoke(f: Frame, angle: number, fraction: number): Point {
  const a = (angle * Math.PI) / 180;
  return { x: f.cx + f.rx * fraction * Math.cos(a), y: f.cy + f.ry * fraction * Math.sin(a) };
}

/**
 * CAPCOM just above FLIGHT and the #crew channel just below it, close in on the vertical axis:
 * both talk to everyone, so their links stay short and inside the web.
 */
export const hubPoint = (f: Frame, where: "centre" | "above" | "below"): Point =>
  where === "centre"
    ? { x: f.cx, y: f.cy }
    : { x: f.cx, y: f.cy + (where === "above" ? -1 : 1) * Math.max(44, f.ry * 0.4) };

/**
 * The anchors of the seats on the graph. Spokes come from the whole crew, so a seat coming or
 * going never turns a spoke; seats on a spoke share it out among those present.
 */
export function spokeAnchors(
  spokes: readonly Spoke[],
  f: Frame,
  present: (id: string) => boolean = () => true,
): Map<string, Point> {
  const anchors = new Map<string, Point>();
  for (const spoke of spokes) {
    const ids = spoke.ids.filter(present);
    for (const [i, id] of ids.entries())
      anchors.set(id, onSpoke(f, spoke.angle, spokeFraction(i, ids.length)));
  }
  return anchors;
}

/** Which side of its node a name sits on. */
export type LabelSide = "below" | "above" | "right" | "left";
export type Box = { x0: number; y0: number; x1: number; y1: number };

/** A 9px mono upper-case name is about this wide per character. */
const CHAR_PX = 5.9;
const LABEL_H = 11;

/** A name's box when it sits on `side` of a node of radius `r` at `p`. */
export function labelBox(p: Point, r: number, text: string, side: LabelSide): Box {
  const w = text.length * CHAR_PX + 4;
  if (side === "below")
    return { x0: p.x - w / 2, y0: p.y + r + 3, x1: p.x + w / 2, y1: p.y + r + 3 + LABEL_H };
  if (side === "above")
    return { x0: p.x - w / 2, y0: p.y - r - 3 - LABEL_H, x1: p.x + w / 2, y1: p.y - r - 3 };
  if (side === "right")
    return { x0: p.x + r + 4, y0: p.y - LABEL_H / 2, x1: p.x + r + 4 + w, y1: p.y + LABEL_H / 2 };
  return { x0: p.x - r - 4 - w, y0: p.y - LABEL_H / 2, x1: p.x - r - 4, y1: p.y + LABEL_H / 2 };
}

const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** What a name must keep clear of besides other names and nodes: lines and shown count chips. */
export type LabelObstacles = { segments?: readonly [Point, Point][]; boxes?: readonly Box[] };

/** How much of a segment runs through a box, by sampling (cheap and good enough for a few lines). */
function crossing(box: Box, [a, b]: [Point, Point]): number {
  let hits = 0;
  for (let i = 1; i < 16; i++) {
    const x = a.x + ((b.x - a.x) * i) / 16;
    const y = a.y + ((b.y - a.y) * i) / 16;
    if (x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1) hits++;
  }
  return hits;
}

/**
 * Places every full name: on the side it had before if that is still clear (so traffic changes do
 * not flip names), else its preferred side, else the first clear side, else the least crowded.
 * Clear means off other names, nodes, the given lines and chips, the plot's edges and the legend
 * strip. Done on the anchors, not per frame, so names never flicker as the web drifts.
 */
export function placeLabels(
  nodes: readonly { id: string; at: Point; r: number; text: string; prefer: LabelSide }[],
  f: Frame,
  previous: ReadonlyMap<string, LabelSide> = new Map(),
  obstacles: LabelObstacles = {},
): Map<string, LabelSide> {
  const placed: Box[] = [];
  const sides = new Map<string, LabelSide>();
  const floor = f.h - LEGEND_PX;
  const discs = nodes.map((n) => ({
    id: n.id,
    box: { x0: n.at.x - n.r, y0: n.at.y - n.r, x1: n.at.x + n.r, y1: n.at.y + n.r },
  }));
  for (const n of nodes) {
    const before = previous.get(n.id);
    const order: LabelSide[] = [
      ...(before ? [before] : []),
      n.prefer,
      ...(["below", "above", "right", "left"] as const),
    ];
    let best: { side: LabelSide; box: Box; cost: number } | null = null;
    for (const side of order) {
      const box = labelBox(n.at, n.r, n.text, side);
      const outside =
        Math.max(0, -box.x0) +
        Math.max(0, box.x1 - f.w) +
        Math.max(0, -box.y0) +
        Math.max(0, box.y1 - floor);
      const cost =
        placed.reduce((sum, b) => sum + overlap(box, b), 0) +
        discs.reduce((sum, d) => sum + (d.id === n.id ? 0 : overlap(box, d.box)), 0) +
        (obstacles.boxes ?? []).reduce((sum, b) => sum + overlap(box, b), 0) +
        (obstacles.segments ?? []).reduce((sum, seg) => sum + crossing(box, seg) * 4, 0) +
        outside * LABEL_H;
      if (best === null || cost < best.cost) best = { side, box, cost };
      if (cost === 0) break;
    }
    if (best) {
      sides.set(n.id, best.side);
      placed.push(best.box);
    }
  }
  return sides;
}

/**
 * A link's line: straight when `straight` (a link to FLIGHT, CAPCOM or #crew), otherwise bowed a
 * little away from the centre so links between seats do not stack on the spokes.
 */
export function curve(a: Point, b: Point, straight: boolean, centre: Point) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  let nx = -dy / length;
  let ny = dx / length;
  if (nx * (mx - centre.x) + ny * (my - centre.y) < 0) {
    nx = -nx;
    ny = -ny;
  }
  // A gentle bow, never a sweep; more only where a straight line would run through FLIGHT.
  const t = Math.max(0, Math.min(1, ((centre.x - a.x) * dx + (centre.y - a.y) * dy) / length ** 2));
  const through = Math.hypot(a.x + dx * t - centre.x, a.y + dy * t - centre.y) < 18;
  const bend = straight ? 0 : through ? 26 : Math.min(length * 0.1, 16);
  const c = { x: mx + nx * bend, y: my + ny * bend };
  const at = (t: number): Point => ({
    x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t ** 2 * b.x,
    y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t ** 2 * b.y,
  });
  return {
    d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
    at,
  };
}

/** What the simulation is asked to hold: a node's anchor, its radius, and whether it is fixed. */
export type SimTarget = { id: string; x: number; y: number; r: number; pinned: boolean };

type SimNode = SimTarget & {
  px: number;
  py: number;
  vx: number;
  vy: number;
  phase: number;
  /** Where the node was after the previous step (where it started, before one), to measure movement. */
  lx: number;
  ly: number;
};

/** A stable per-id phase so each seat drifts on its own path, the same every visit. */
export function phaseOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) / 2 ** 32) * Math.PI * 2;
}

/** Spring stiffness (1/s²) and damping (1/s): a little under critical, so a move settles softly. */
const STIFFNESS = 14;
const DAMPING = 6;
/** The clear gap kept between two nodes' edges. */
const GAP = 9;
/** Where a node that appears after the first layout starts: this far out along its spoke. */
const ENTRY_FRACTION = 0.45;

/** Damped springs to each anchor, plus pairwise separation; deterministic for a given step list. */
export class SpiderSim {
  private readonly nodes = new Map<string, SimNode>();
  private started = false;

  /**
   * Holds `targets` from now on. A node already held keeps its position (only its anchor moves),
   * a new one starts at its anchor on the first sync and partway in from it afterwards, and a node
   * no longer listed is dropped. `instant` puts every node on its anchor (reduced motion).
   */
  sync(targets: readonly SimTarget[], centre: Point, instant: boolean): void {
    const ids = new Set(targets.map((t) => t.id));
    for (const id of this.nodes.keys()) if (!ids.has(id)) this.nodes.delete(id);
    for (const t of targets) {
      const node = this.nodes.get(t.id);
      if (node) {
        Object.assign(node, { x: t.x, y: t.y, r: t.r, pinned: t.pinned });
        continue;
      }
      const fresh = !this.started || instant || t.pinned;
      const px = fresh ? t.x : centre.x + (t.x - centre.x) * ENTRY_FRACTION;
      const py = fresh ? t.y : centre.y + (t.y - centre.y) * ENTRY_FRACTION;
      this.nodes.set(t.id, { ...t, px, py, vx: 0, vy: 0, phase: phaseOf(t.id), lx: px, ly: py });
    }
    this.started = true;
    if (instant) this.settle();
  }

  /**
   * Advances `dt` seconds (capped, so a backgrounded tab does not jump) and returns how far the
   * nodes moved in all: once that stays near zero the picture has settled and the loop can rest.
   * (The resting drift is a CSS animation on each node, not physics, so it costs no frames.)
   */
  step(dt: number): number {
    const h = Math.min(Math.max(dt, 0), 1 / 20);
    for (const n of this.nodes.values()) {
      if (n.pinned) {
        n.px = n.x;
        n.py = n.y;
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx += (STIFFNESS * (n.x - n.px) - DAMPING * n.vx) * h;
      n.vy += (STIFFNESS * (n.y - n.py) - DAMPING * n.vy) * h;
      n.px += n.vx * h;
      n.py += n.vy * h;
    }
    this.separate();
    let moved = 0;
    for (const n of this.nodes.values()) {
      moved += Math.hypot(n.px - n.lx, n.py - n.ly);
      n.lx = n.px;
      n.ly = n.py;
    }
    return moved;
  }

  /** Puts every node on its anchor at rest, then clears any overlap. */
  settle(): void {
    for (const n of this.nodes.values()) {
      n.px = n.x;
      n.py = n.y;
      n.vx = 0;
      n.vy = 0;
    }
    for (let i = 0; i < 12; i++) this.separate();
    for (const n of this.nodes.values()) {
      n.lx = n.px;
      n.ly = n.py;
    }
  }

  private separate(): void {
    const list = [...this.nodes.values()];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as SimNode;
        const b = list[j] as SimNode;
        if (a.pinned && b.pinned) continue;
        const min = a.r + b.r + GAP;
        let dx = b.px - a.px;
        let dy = b.py - a.py;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d < 0.01) {
          dx = Math.cos(a.phase);
          dy = Math.sin(a.phase);
          d = 1;
        }
        const push = min - d;
        const ux = dx / d;
        const uy = dy / d;
        const share = a.pinned ? 0 : b.pinned ? 1 : 0.5;
        a.px -= ux * push * share;
        a.py -= uy * push * share;
        b.px += ux * push * (1 - share);
        b.py += uy * push * (1 - share);
      }
  }

  position(id: string): Point | undefined {
    const n = this.nodes.get(id);
    return n ? { x: n.px, y: n.py } : undefined;
  }

  /** Total speed across nodes (px/s): near zero once the picture has settled. */
  energy(): number {
    let sum = 0;
    for (const n of this.nodes.values()) sum += Math.hypot(n.vx, n.vy);
    return sum;
  }
}
