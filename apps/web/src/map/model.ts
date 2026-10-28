import type { FindingSeverity, MapDelta, MapSeat, MapSnapshot } from "@mc/core";
import { areaOf, forceLayout } from "./layout.ts";

export const isDocked = (seat: MapSeat, now: number): boolean =>
  seat.calls.length === 0 && seat.state !== "running" && now - seat.since >= 60_000;

export const level = (lines: number): number => [10, 50, 200, 500].filter((n) => lines > n).length;
export const tokenBand = (tokens: number): number =>
  tokens < 100 ? 0 : tokens < 1000 ? 1 : tokens < 4000 ? 2 : 3;
export const pinToken = (severity: FindingSeverity): string =>
  severity === "Critical" ? "--crit" : severity === "Important" ? "--warn" : "--muted";
/** A file's brightness in fileStyle: written by a working seat, by a docked one, read, untouched. */
export const BRIGHTNESS = { written: 1, docked: 0.45, read: 0.55, untouched: 0.3 } as const;
export interface MapNode {
  path: string;
  parent: string | null;
  area: string;
  position: [number, number, number];
  files: string[];
  count: number;
}
const hash = (s: string) => {
  let n = [...s].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0, 7);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
};

/**
 * The origin tree gets the prototype's force-directed layout (layout.ts), computed once per tree.
 * Files new on a branch (`base` given) are placed under their folder by path, so the rest never
 * moves. Files are always individual nodes; the renderer decides how much detail is visible.
 */
export function layoutTree(
  tree: MapSnapshot["tree"],
  base: MapNode[] = [],
  _collapse = false,
  imports: MapSnapshot["imports"] = [],
): MapNode[] {
  if (!base.length) return forceLayout(tree, imports);
  const nodes = new Map<string, MapNode>(base.map((n) => [n.path, { ...n, files: [...n.files] }]));
  nodes.set("", { path: "", parent: null, area: "", position: [0, 0, 0], files: [], count: 0 });
  const ensure = (path: string, lines?: number): MapNode => {
    const found = nodes.get(path);
    if (found) return found;
    const parts = path.split("/");
    const parent = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const p = ensure(parent);
    const h = hash(path);
    const angle = (h / 0xffffffff) * Math.PI * 2;
    const distance =
      lines !== undefined
        ? 3 + Math.min(5, Math.log1p(lines) * 0.6)
        : 10 + Math.min(14, path.length * 0.2);
    const direction = parent === "" ? (hash(parts[0]) / 0xffffffff) * Math.PI * 2 : angle;
    const node: MapNode = {
      path,
      parent,
      area: areaOf(path, lines !== undefined),
      position: [
        p.position[0] + Math.cos(direction) * distance,
        p.position[1] + ((h % 101) / 100 - 0.5) * distance,
        p.position[2] + Math.sin(direction) * distance,
      ],
      files: [],
      count: 0,
    };
    nodes.set(path, node);
    return node;
  };
  for (const file of [...tree].sort((a, b) => a.path.localeCompare(b.path))) {
    const n = ensure(file.path, file.lines);
    n.files = [file.path];
    n.count = 1;
  }
  return [...nodes.values()];
}

export function fileStyle(
  snapshot: MapSnapshot,
  files: string[],
  area: string,
  now = 0,
  indices: Record<string, number> = {},
) {
  const has = (f: string) => files.includes(f);
  const seats = snapshot.seats.map((seat, index) => {
    const docked = isDocked(seat, now);
    const changes = seat.scope.modified.filter((c) => has(c.file));
    return { seat, index, docked, changes, read: !docked && seat.scope.read.some(has) };
  });
  const writers = seats.filter((s) => s.changes.length);
  const readers = seats.filter((s) => s.read);
  const owner = writers[0] ?? readers[0];
  const add = writers.reduce((n, s) => n + s.changes.reduce((a, c) => a + c.add, 0), 0);
  const rem = writers.reduce((n, s) => n + s.changes.reduce((a, c) => a + c.rem, 0), 0);
  return {
    token: owner
      ? owner.seat.seat === "FLIGHT"
        ? "--fg-2"
        : `--s${((indices[owner.seat.seat] ?? owner.index) % 7) + 1}`
      : "--muted",
    area,
    brightness: owner
      ? writers.length
        ? owner.docked
          ? BRIGHTNESS.docked
          : BRIGHTNESS.written
        : BRIGHTNESS.read
      : BRIGHTNESS.untouched,
    level: level(add + rem),
    add,
    rem,
    source: writers.some((s) => s.changes.some((c) => c.source === "churn"))
      ? "edit churn"
      : "diff",
    label: writers.some((s) => !s.docked),
    accessing: seats.some((s) => s.seat.calls.some((c) => c.files.some(has))),
    recent: seats.some(
      (s) =>
        !s.docked &&
        s.seat.state === "running" &&
        !s.seat.calls.length &&
        s.seat.recent.some((r) => has(r.file) && now - r.at < 600_000),
    ),
    overlap:
      writers.length > 1
        ? "write overlap"
        : writers.length && readers.some((r) => r.index !== writers[0].index)
          ? "shared"
          : null,
    findings: snapshot.findings.filter((f) => has(f.file)),
    conflicts: snapshot.conflicts.filter((c) => has(c.file)),
  };
}

export function pickRepo(
  ids: string[],
  running: { repoId: string; started: number }[],
  last: string,
): string {
  const ranked = ids.map((id) => ({ id, rows: running.filter((r) => r.repoId === id) }));
  ranked.sort(
    (a, b) =>
      b.rows.length - a.rows.length ||
      Math.max(0, ...b.rows.map((r) => r.started)) - Math.max(0, ...a.rows.map((r) => r.started)),
  );
  return ranked[0]?.rows.length ? ranked[0].id : ids.includes(last) ? last : (ids[0] ?? "");
}

/** null asks the feed to reload authoritative state, never inventing a missing seat. */
export function applyDelta(
  snapshot: MapSnapshot,
  delta: MapDelta,
  now: number,
): MapSnapshot | null {
  if (delta.seq <= snapshot.seq) return snapshot;
  if (delta.seq !== snapshot.seq + 1) return null;
  const next = structuredClone(snapshot);
  next.seq = delta.seq;
  if (delta.type === "message") return null;
  if (!("seat" in delta)) return next;
  const seat = next.seats.find((s) => s.seat === delta.seat);
  if (!seat) return null;
  switch (delta.type) {
    case "call.start":
      seat.calls.push({ tool: delta.tool, detail: delta.detail, files: delta.files, since: now });
      for (const file of delta.files)
        if (!seat.scope.read.includes(file)) seat.scope.read.push(file);
      break;
    case "call.end": {
      // End frames lack a tool id and result time; fetch authoritative badge data.
      if (delta.error || delta.refused || (delta.tests && delta.tests.runner !== null)) return null;
      const i = seat.calls.findIndex(
        (c) =>
          c.files.length === delta.files.length && c.files.every((f) => delta.files.includes(f)),
      );
      if (i >= 0) seat.calls.splice(i, 1);
      seat.recent = delta.files.map((file) => ({ file, at: now }));
      break;
    }
    case "state":
      // A state frame does not carry the park reason or test-lock queue data.
      if (delta.state === "parked" || seat.badges.waiting) return null;
      seat.state = delta.state;
      seat.since = delta.since;
      break;
    case "edit":
    case "diff": {
      let change = seat.scope.modified.find((c) => c.file === delta.file);
      if (
        seat.badges.tests &&
        (delta.type === "edit" || change?.add !== delta.add || change?.rem !== delta.rem)
      )
        seat.badges.tests.editedSince = true;
      if (!change) {
        change = {
          file: delta.file,
          add: 0,
          rem: 0,
          source: delta.type === "diff" ? "diff" : "churn",
        };
        seat.scope.modified.push(change);
      }
      if (delta.type === "diff")
        Object.assign(change, { add: delta.add, rem: delta.rem, source: "diff" });
      else if (change.source === "churn") {
        change.add += delta.add;
        change.rem += delta.rem;
      }
      break;
    }
    case "review":
      return null;
  }
  return next;
}
