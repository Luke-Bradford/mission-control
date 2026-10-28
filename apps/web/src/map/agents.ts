import type { MapSeat } from "@mc/core";
import { duration } from "./cards.ts";
import { isDocked, type MapNode } from "./model.ts";

export type Position = [number, number, number];
export function stateLabel(seat: MapSeat, now: number, lastCallEnd?: number): string {
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
  if (seat.state === "running")
    return lastCallEnd === undefined || lastCallEnd < seat.since
      ? "thinking"
      : `thinking ${duration(now - lastCallEnd)}`;
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

export function orbPlacement(seat: MapSeat, nodes: MapNode[], index: number, now: number) {
  const docked = isDocked(seat, now) || (seat.seat === "FLIGHT" && !seat.calls.length);
  const files = docked
    ? []
    : seat.calls.length
      ? seat.calls.flatMap((c) => c.files)
      : [...seat.recent]
          .sort((a, b) => b.at - a.at)
          .slice(0, 8)
          .map((r) => r.file);
  const paths = [
    ...new Set(
      files
        .map((f) => nodes.find((n) => n.files.includes(f))?.path)
        .filter((p): p is string => p !== undefined),
    ),
  ];
  const positions = paths.map((p) => nodes.find((n) => n.path === p)?.position as Position);
  const position: Position = positions.length
    ? ([0, 1, 2].map(
        (axis) => positions.reduce((sum, p) => sum + p[axis], 0) / positions.length,
      ) as Position)
    : dockPosition(nodes, index);
  if (positions.length) position[1] += seat.state === "running" && !seat.calls.length ? 16 : 9;
  return {
    position,
    docked,
    links: seat.calls.length ? paths.slice(0, 12) : [],
    more: seat.calls.length ? Math.max(0, paths.length - 12) : 0,
  };
}

export const haloSize = (seat: MapSeat): number | null =>
  seat.context && seat.context.window !== null && seat.context.window > 0
    ? 2.4 + Math.sqrt(Math.min(1, Math.max(0, seat.context.total / seat.context.window))) * 5
    : null;
