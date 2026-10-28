import type { MapCall, MapDelta, MapSnapshot } from "@mc/core";
import { orbPlacement, type Position } from "./agents.ts";
import { type MapNode, tokenBand } from "./model.ts";

export interface MotionEvent {
  delta: MapDelta;
  at: number;
  /** The delta's seat's calls when it arrived (never the whole snapshot, which events outlive). */
  calls?: MapCall[];
  epoch?: number;
}
export interface MessageArc {
  from: string;
  to: string;
  kind: string;
  ticket: number | null;
  at: number;
  count: number;
}
export interface Particle {
  from: Position;
  to: Position;
  at: number;
  life: number;
  size: number;
  seat: string;
  kind: "write" | "read" | "hub" | "add" | "remove";
}
interface Glow {
  path: string;
  at: number;
  seat: string;
}
export interface MotionState {
  seq: number;
  epoch: number;
  pending: MotionEvent[];
  particles: Particle[];
  arcs: MessageArc[];
  glows: Glow[];
  calls: Record<string, MapCall[]>;
  ended: Record<string, number>;
}
export const emptyMotion = (): MotionState => ({
  seq: -1,
  epoch: 0,
  pending: [],
  particles: [],
  arcs: [],
  glows: [],
  calls: {},
  ended: {},
});
export const flowStyle = (tokens: number) => {
  const band = tokenBand(tokens);
  return { count: band + 1, size: [3.6, 5.2, 7, 9][band] };
};
const writeTool = (tool: string) => ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool);
const hubTool = (tool: string) => tool.startsWith("mcp__mc__");

/** Unknown participants get a named marker, never another seat's orb or an implied HUB location. */
export function endpoint(
  id: string,
  snapshot: MapSnapshot,
  nodes: MapNode[],
  now: number,
): Position {
  const index = snapshot.seats.findIndex((s) => s.seat === id);
  if (index >= 0) return orbPlacement(snapshot.seats[index], nodes, index, now).position;
  return markerPosition(id, nodes);
}

/** The prototype's markers: CAPCOM just above the tree's middle, HUB beside it, others to its left. */
export function markerPosition(id: string, nodes: MapNode[]): Position {
  const bounds = [0, 1, 2].map((axis) => {
    const values = nodes.map((n) => n.position[axis] as number);
    return [Math.min(0, ...values), Math.max(0, ...values)] as const;
  });
  const size = bounds.map(([min, max]) => Math.max(20, max - min));
  const middle = bounds.map(([min, max]) => (min + max) / 2);
  const top = (bounds[1]?.[1] ?? 0) + (size[1] ?? 20) * 0.1;
  const [x, z, width] = [middle[0] ?? 0, middle[2] ?? 0, size[0] ?? 20];
  if (id === "CAPCOM") return [x, top, z];
  if (id === "HUB") return [x + width * 0.14, top - (size[1] ?? 20) * 0.02, z];
  const hash = [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  return [x - width * 0.14 - (hash % 5) * 5, top, z + (hash % 7) * 3];
}

export function arcPoint(a: Position, b: Position, u: number, out: Position = [0, 0, 0]): Position {
  const lift = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 0.35 + 6;
  for (let axis = 0; axis < 3; axis++)
    out[axis] = a[axis] + (b[axis] - a[axis]) * u + (axis === 1 ? 2 * (1 - u) * u * lift : 0);
  return out;
}

export function sampleMotion(state: MotionState, now: number) {
  const particles = state.particles.filter((p) => now < p.at + p.life);
  const arcs = state.arcs.filter((a) => now < a.at + 4000);
  const glows = state.glows.filter((g) => now < g.at + 6000);
  return { particles, arcs, glows, active: !!(particles.length || arcs.length || glows.length) };
}

/** Only live deltas create effects; snapshot scope and usage never synthesize particles. */
export function motionDelta(
  state: MotionState,
  event: MotionEvent,
  snapshot: MapSnapshot,
  nodes: MapNode[],
): MotionState {
  state = motionEpoch(state, event.epoch ?? 0);
  if ((event.epoch ?? 0) < state.epoch || event.delta.seq <= state.seq) return state;
  const next = { ...state, seq: event.delta.seq };
  if (!resolvable(event, snapshot, nodes)) {
    const delta = event.delta;
    const calls =
      "seat" in delta
        ? (state.calls[delta.seat] ??
          event.calls ??
          snapshot.seats.find((seat) => seat.seat === delta.seat)?.calls)
        : undefined;
    const pending = { ...event, calls: calls ?? (delta.type === "call.start" ? [] : undefined) };
    return {
      ...next,
      pending: [...state.pending.filter((e) => event.at - e.at < 3000), pending].slice(-64),
    };
  }
  return applyMotion(next, event, snapshot, nodes);
}

/** Old retained props belong to their original connection and must never replay. */
export function motionEpoch(state: MotionState, epoch: number): MotionState {
  return epoch > state.epoch ? { ...state, epoch, seq: -1, pending: [] } : state;
}

function resolvable(event: MotionEvent, snapshot: MapSnapshot, nodes: MapNode[]) {
  const delta = event.delta;
  if (!("seat" in delta)) return true;
  if (!snapshot.seats.some((s) => s.seat === delta.seat)) return false;
  const files = "files" in delta ? delta.files : "file" in delta ? [delta.file] : [];
  return files.every((file) => nodes.some((node) => node.files.includes(file)));
}

/** Retry briefly against the actual displayed layout, then replace call caches with server truth. */
export function reconcileMotion(
  state: MotionState,
  snapshot: MapSnapshot,
  nodes: MapNode[],
  now: number,
): MotionState {
  let next: MotionState = { ...state, ...sampleMotion(state, now), pending: [] };
  for (const event of state.pending) {
    if (now - event.at >= 3000) continue;
    if (resolvable(event, snapshot, nodes))
      next = applyMotion(next, event, snapshot, nodes, event.calls);
    else next.pending.push(event);
  }
  return {
    ...next,
    ...sampleMotion(next, now),
    calls: Object.fromEntries(snapshot.seats.map((seat) => [seat.seat, seat.calls])),
    ended: Object.fromEntries(
      Object.entries(next.ended).filter(([id, at]) =>
        snapshot.seats.some((seat) => seat.seat === id && seat.since <= at),
      ),
    ),
  };
}

function applyMotion(
  state: MotionState,
  event: MotionEvent,
  snapshot: MapSnapshot,
  nodes: MapNode[],
  observedCalls?: MapCall[],
): MotionState {
  const { delta, at } = event;
  const next: MotionState = {
    ...state,
    ...sampleMotion(state, at),
    calls: { ...state.calls },
    ended: { ...state.ended },
  };
  const seat = "seat" in delta ? snapshot.seats.find((s) => s.seat === delta.seat) : undefined;
  const paths = (files: string[]) => [
    ...new Set(
      files
        .map((f) => nodes.find((n) => n.files.includes(f))?.path)
        .filter((p): p is string => p !== undefined),
    ),
  ];
  const position = (path: string) => nodes.find((n) => n.path === path)?.position as Position;
  const glow = (files: string[]) => {
    for (const path of paths(files)) {
      if (next.glows.some((g) => g.path === path && g.at >= at)) continue;
      next.glows = next.glows.filter((g) => g.path !== path);
      next.glows.push({ path, at, seat: seat?.seat ?? "" });
    }
  };
  const emit = (
    from: Position,
    to: Position,
    tokens: number | undefined,
    kind: Particle["kind"],
  ) => {
    if (tokens !== undefined && tokens <= 0) return;
    // The contract has no outgoing hub payload size: one fixed call signal, no token estimate.
    const { count, size } = tokens === undefined ? { count: 1, size: 3.6 } : flowStyle(tokens);
    const life = 1100 * Math.min(1.8, 0.6 + Math.hypot(...from.map((v, i) => v - to[i])) / 120);
    for (let i = 0; i < count && next.particles.length < 200; i++)
      next.particles.push({ from, to, size, life, at: at + i * 160, kind, seat: seat?.seat ?? "" });
  };
  if (delta.type === "message") {
    const same = next.arcs.find((a) => a.from === delta.from && a.to === delta.to);
    const arc = {
      from: delta.from,
      to: delta.to,
      kind: delta.kind,
      ticket: delta.ticket,
      at,
      count: (same?.count ?? 0) + 1,
    };
    next.arcs = [...next.arcs.filter((a) => a !== same), arc].slice(-10);
  } else if (seat && "seat" in delta) {
    const here = endpoint(seat.seat, snapshot, nodes, at);
    const calls = observedCalls ?? next.calls[seat.seat] ?? event.calls ?? seat.calls;
    if (delta.type === "call.start") {
      next.calls[seat.seat] = [
        ...calls.filter((c) => at - c.since < 900_000),
        { tool: delta.tool, detail: delta.detail, files: delta.files, since: at },
      ].slice(-200);
      glow(delta.files);
      if (delta.writeTok !== undefined && writeTool(delta.tool))
        for (const path of paths(delta.files)) emit(here, position(path), delta.writeTok, "write");
      else if (hubTool(delta.tool))
        emit(here, endpoint("HUB", snapshot, nodes, at), undefined, "hub");
    } else if (delta.type === "call.end") {
      next.ended[seat.seat] = at;
      const matches = calls.filter(
        (c) =>
          c.files.length === delta.files.length && c.files.every((f) => delta.files.includes(f)),
      );
      // End frames have no call id/tool. Parallel calls with identical files are ambiguous.
      const call = matches.length === 1 ? matches[0] : undefined;
      next.calls[seat.seat] = calls
        .filter((c) => c !== matches[0])
        .map((c) => (matches.length > 1 && matches.includes(c) ? { ...c, tool: "ambiguous" } : c));
      if (
        call &&
        call.tool !== "ambiguous" &&
        !delta.error &&
        !delta.refused &&
        !writeTool(call.tool)
      ) {
        if (hubTool(call.tool))
          emit(endpoint("HUB", snapshot, nodes, at), here, delta.resultTok, "hub");
        else
          for (const path of paths(delta.files))
            emit(position(path), here, delta.resultTok, "read");
      }
      glow(delta.files);
    } else if (delta.type === "edit") {
      glow([delta.file]);
      const path = paths([delta.file])[0];
      if (path !== undefined) {
        const p = position(path);
        for (const [kind, lines] of [
          ["add", delta.add],
          ["remove", delta.rem],
        ] as const)
          for (
            let i = 0;
            i < Math.min(5, Math.ceil(lines / 8)) && next.particles.length < 200;
            i++
          ) {
            const angle = delta.seq * 2.4 + i * 2.4 + (kind === "add" ? 0 : 1);
            const outside: Position = [
              p[0] + Math.cos(angle) * 10,
              p[1] + Math.sin(angle) * 10,
              p[2] + Math.cos(angle * 2) * 5,
            ];
            next.particles.push({
              from: kind === "add" ? outside : p,
              to: kind === "add" ? p : outside,
              at: at + i * 100,
              life: 800,
              size: 3.6,
              seat: seat.seat,
              kind,
            });
          }
      }
    }
  }
  return next;
}
