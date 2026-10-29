import { type MapSeat, type MapSnapshot, namesOnly } from "@mc/core";
import { duration, freshRecent, touchedFiles } from "./cards.ts";
import { isDocked, type MapNode } from "./model.ts";

export type Position = [number, number, number];

export function stateLabel(seat: MapSeat, now: number): string {
  if (seat.state === "stalled") return `stalled ${duration(now - seat.since)}`;
  const call = [...seat.calls].sort((a, b) => a.since - b.since)[0];
  if (call) {
    const verbs: Record<string, string> = {
      Read: "reading",
      Edit: "editing",
      MultiEdit: "editing",
      NotebookEdit: "editing",
      Write: "writing",
      Grep: "searching",
      Glob: "searching",
      Bash: "running",
    };
    const verb = verbs[call.tool] ?? (call.tool.startsWith("mcp__mc__") ? "using" : call.tool);
    const detail = call.detail.replace(/^cd \S+ && /, "").slice(0, 80);
    return `${verb} ${detail} ${duration(now - call.since)}${seat.calls.length > 1 ? ` · +${seat.calls.length - 1} calls` : ""}`;
  }
  if (seat.state === "running") return "thinking";
  return `${seat.state} ${duration(now - seat.since)}`;
}

export function dockPosition(nodes: MapNode[], index: number): Position {
  const bounds = [0, 1, 2].map((axis) => {
    const values = nodes.map((n) => n.position[axis]);
    return [Math.min(0, ...values), Math.max(0, ...values)];
  });
  const size = bounds.map(([min, max]) => Math.max(20, max - min));
  return [
    bounds[0][0] - size[0] * 0.16 - 12,
    (bounds[1][0] + bounds[1][1]) / 2 + size[1] * 0.3 - index * Math.max(7, size[1] * 0.13),
    (bounds[2][0] + bounds[2][1]) / 2 - size[2] * 0.2,
  ];
}

/** Each file's node (a collapsed tree's folder), computed once per layout. */
const indexes = new WeakMap<MapNode[], Map<string, MapNode>>();
function nodeOfFile(nodes: MapNode[]): Map<string, MapNode> {
  let index = indexes.get(nodes);
  if (!index) {
    index = new Map();
    for (const node of nodes) for (const file of node.files) index.set(file, node);
    indexes.set(nodes, index);
  }
  return index;
}

/** How many nodes a seat's path runs through. */
const TRAIL_NODES = 12;

/**
 * The nodes a seat visited, oldest first: its recent accesses the hub still keeps and the files
 * its calls in flight are on (a name-only listing such as Glob opened none), in time order, as the
 * nodes that hold them (a file not on the map is skipped), a node visited twice in a row once.
 */
export function seatTrail(seat: MapSeat, nodes: MapNode[], now: number): string[] {
  const index = nodeOfFile(nodes);
  const recent = freshRecent(seat, now);
  const visits = [
    ...recent.map((r, i) => ({ file: r.file, at: r.at, order: i })),
    ...seat.calls
      .filter((c) => !namesOnly(c.tool))
      .flatMap((c, i) =>
        c.files.map((file, j) => ({ file, at: c.since, order: recent.length + i * 1000 + j })),
      ),
  ].sort((a, b) => a.at - b.at || a.order - b.order);
  const trail: string[] = [];
  for (const visit of visits) {
    const path = index.get(visit.file)?.path;
    if (path !== undefined && trail.at(-1) !== path) trail.push(path);
  }
  return trail.slice(-TRAIL_NODES);
}

/**
 * Where a seat's light sits: on the last node it touched (a call in flight or its latest access);
 * with no access on the map, on the file it changed most, so a resting branch still shows where its
 * work is; else in the dock beside the tree.
 */
export function lightPlacement(
  seat: MapSeat,
  nodes: MapNode[],
  index: number,
  now: number,
): { position: Position; node: string | null; trail: string[]; docked: boolean } {
  const trail = seatTrail(seat, nodes, now);
  const files = nodeOfFile(nodes);
  const biggest = [...seat.scope.modified]
    .filter((c) => files.has(c.file))
    .sort((a, b) => b.add + b.rem - (a.add + a.rem))[0];
  const path = trail.at(-1) ?? (biggest ? (files.get(biggest.file)?.path ?? null) : null);
  const node = path === null ? undefined : nodes.find((n) => n.path === path);
  return {
    position: node ? [...node.position] : dockPosition(nodes, index),
    node: node ? node.path : null,
    trail,
    docked: isDocked(seat, now),
  };
}

/**
 * Each node a seat touched, with the seats that touched it in seat order (the selector's order),
 * so a shared node's colours keep their places from one frame to the next.
 */
export function touchedNodes(snapshot: MapSnapshot, nodes: MapNode[]): Map<string, string[]> {
  const index = nodeOfFile(nodes);
  const touched = new Map<string, string[]>();
  for (const seat of snapshot.seats)
    for (const path of new Set(
      [...touchedFiles(seat)].flatMap((file) => index.get(file)?.path ?? []),
    )) {
      const seats = touched.get(path) ?? [];
      seats.push(seat.seat);
      touched.set(path, seats);
    }
  return touched;
}
