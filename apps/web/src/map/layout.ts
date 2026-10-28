import type { MapSnapshot } from "@mc/core";
import type { MapNode } from "./model.ts";

type Vec = [number, number, number];

/** A path's area: the crew's known areas, else its top-level folder; files at the root share one. */
export const areaOf = (path: string, file = true): string =>
  ["apps/server", "apps/web", "packages/core", "docs", "roles"].find(
    (a) => path === a || path.startsWith(`${a}/`),
  ) ?? (path.includes("/") || !file ? (path.split("/")[0] as string) : ROOT_AREA);
export const ROOT_AREA = "(root)";

/** How many areas get their own direction and a name on the stage; the rest share "other". */
export const MAIN_AREAS = 4;

/** The prototype's area directions: the biggest areas left, right, down and up, facing the camera. */
const AREA_DIRS: Vec[] = [
  [-1, 0.15, 0],
  [1, 0.1, 0],
  [0.05, -1, 0],
  [0.15, 1, 0],
];
const OTHER_DIR: Vec = [-0.2, 0.7, 0];
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** Relaxation: repulsion reaches 15 units, so a grid of 15-unit cells finds every pair. */
const REACH = 15;
const STEPS = 80;

const norm = (v: Vec): Vec => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** The areas holding the most lines of code, biggest first: they get a direction and a name. */
export function mainAreas(tree: MapSnapshot["tree"]): string[] {
  const weight = new Map<string, number>();
  for (const f of tree) {
    const area = areaOf(f.path);
    weight.set(area, (weight.get(area) ?? 0) + f.lines + 20);
  }
  return [...weight.entries()]
    .filter(([area]) => area !== ROOT_AREA)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAIN_AREAS)
    .map(([area]) => area);
}

/**
 * The prototype's layout: compact folder neighbourhoods (each area fanned out in its own direction,
 * children in a cone around their folder's, the heaviest first), then 80 steps of relaxation: near
 * nodes repel, each keeps its branch length to its folder, and imports pull faintly. Every file is
 * its own node; folders are line junctions. A cold start is deterministic: the same tree and
 * imports give the same layout. A warm start (`previous`) keeps every node it knows where it was and
 * relaxes only the new ones, so its result depends on the layout it started from.
 */
export function forceLayout(
  tree: MapSnapshot["tree"],
  imports: MapSnapshot["imports"] = [],
  steps = STEPS,
  /** A warm start: these nodes keep their positions; only nodes new to the tree are placed. */
  previous?: ReadonlyMap<string, readonly [number, number, number]>,
): MapNode[] {
  const main = mainAreas(tree);
  const list: { path: string; parent: number; area: string; kids: number[]; lines: number }[] = [
    { path: "", parent: -1, area: "", kids: [], lines: -1 },
  ];
  const index = new Map<string, number>([["", 0]]);
  const folder = (path: string): number => {
    const found = index.get(path);
    if (found !== undefined) return found;
    const parent = folder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    const i = list.push({ path, parent, area: areaOf(path, false), kids: [], lines: -1 }) - 1;
    list[parent]?.kids.push(i);
    index.set(path, i);
    return i;
  };
  for (const file of [...tree].sort((a, b) => a.path.localeCompare(b.path))) {
    if (index.has(file.path)) continue;
    const parent = folder(
      file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "",
    );
    const i =
      list.push({
        path: file.path,
        parent,
        area: areaOf(file.path),
        kids: [],
        lines: Math.max(0, file.lines),
      }) - 1;
    list[parent]?.kids.push(i);
    index.set(file.path, i);
  }
  const n = list.length;
  const isFile = (i: number) => (list[i]?.lines ?? -1) >= 0;
  // parents are always listed before their children, so one pass from the end sums the weights
  const weight = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const node = list[i];
    if (!node) continue;
    if (node.lines >= 0) weight[i] += node.lines + 20;
    if (node.parent >= 0) weight[node.parent] += weight[i];
  }
  const pos = new Float64Array(n * 3);
  const place = (i: number, dir: Vec, spread: number) => {
    const node = list[i];
    if (!node?.kids.length) return;
    const up: Vec = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = norm(cross(dir, up));
    const v = cross(dir, u);
    const sorted = [...node.kids].sort(
      (a, b) => weight[b] - weight[a] || (list[a]?.path ?? "").localeCompare(list[b]?.path ?? ""),
    );
    sorted.forEach((k, j) => {
      const kid = list[k];
      if (!kid) return;
      let d: Vec;
      if (i === 0 || kid.area !== node.area) {
        const g = main.indexOf(kid.area);
        const a = norm(g >= 0 ? (AREA_DIRS[g] as Vec) : OTHER_DIR);
        d = norm([a[0] + ((j % 3) - 1) * 0.15, a[1], a[2] + (j % 2 ? 0.2 : -0.2)]);
      } else {
        const f = (j + 0.5) / sorted.length;
        const theta = Math.acos(1 - f * (1 - Math.cos(spread)));
        const phi = j * GOLDEN;
        const s = Math.sin(theta);
        const c = Math.cos(theta);
        d = norm([
          dir[0] * c + u[0] * s * Math.cos(phi) + v[0] * s * Math.sin(phi),
          dir[1] * c + u[1] * s * Math.cos(phi) + v[1] * s * Math.sin(phi),
          dir[2] * c + u[2] * s * Math.cos(phi) + v[2] * s * Math.sin(phi),
        ]);
      }
      const len = isFile(k)
        ? 3 + Math.min(5, Math.log1p(kid.lines) * 0.6)
        : 9 + Math.min(14, Math.log1p(weight[k]) * 1.3);
      for (let a = 0; a < 3; a++) pos[k * 3 + a] = pos[i * 3 + a] + d[a] * len;
      if (!isFile(k)) place(k, d, Math.min(1.6, 0.7 + kid.kids.length * 0.04));
    });
  };
  place(0, [0, 0, 1], Math.PI);
  // Warm start: a node the last layout had stays exactly there; a new one keeps its offset from
  // its folder, so it lands beside wherever that folder now is. Only new nodes relax.
  const pinned = new Uint8Array(n);
  pinned[0] = 1;
  if (previous?.size) {
    const initial = Float64Array.from(pos);
    for (let i = 1; i < n; i++) {
      const node = list[i];
      if (!node) continue;
      const known = previous.get(node.path);
      if (known) {
        pinned[i] = 1;
        for (let a = 0; a < 3; a++) pos[i * 3 + a] = known[a] as number;
      } else
        for (let a = 0; a < 3; a++)
          pos[i * 3 + a] =
            pos[node.parent * 3 + a] + initial[i * 3 + a] - initial[node.parent * 3 + a];
    }
  }
  const moving = pinned.some((p) => p === 0);
  const rest = new Float64Array(n);
  const dist = (a: number, b: number) =>
    Math.hypot(
      pos[a * 3] - pos[b * 3],
      pos[a * 3 + 1] - pos[b * 3 + 1],
      pos[a * 3 + 2] - pos[b * 3 + 2],
    );
  for (let i = 1; i < n; i++) rest[i] = dist(i, list[i]?.parent ?? 0);
  const links = imports.flatMap((l) => {
    const a = index.get(l.from);
    const b = index.get(l.to);
    return a !== undefined && b !== undefined && a !== b ? [[a, b] as const] : [];
  });
  const force = new Float64Array(n * 3);
  const spring = (a: number, b: number, length: number, k: number) => {
    const dx = pos[b * 3] - pos[a * 3];
    const dy = pos[b * 3 + 1] - pos[a * 3 + 1];
    const dz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
    const f = ((d - length) * k) / d;
    force[a * 3] += dx * f;
    force[a * 3 + 1] += dy * f;
    force[a * 3 + 2] += dz * f;
    force[b * 3] -= dx * f;
    force[b * 3 + 1] -= dy * f;
    force[b * 3 + 2] -= dz * f;
  };
  const cell = (v: number) => Math.floor(v / REACH);
  // cells within ±512 of the root, packed into one number (the layout spans a few dozen cells)
  const key = (x: number, y: number, z: number) => (x + 512) * 1048576 + (y + 512) * 1024 + z + 512;
  // Large trees retain every file, but deterministic initial placement is already well-spread.
  // Relaxing tens of thousands of nearby points is quadratic in the densest cells, so reserve it
  // for trees small enough to benefit. This function normally runs in layout.worker.ts.
  const relaxationSteps = n > 2500 ? 0 : steps;
  for (let step = 0; moving && step < relaxationSteps; step++) {
    force.fill(0);
    const grid = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const at = key(cell(pos[i * 3]), cell(pos[i * 3 + 1]), cell(pos[i * 3 + 2]));
      const bucket = grid.get(at);
      if (bucket) bucket.push(i);
      else grid.set(at, [i]);
    }
    for (let i = 0; i < n; i++) {
      const cx = cell(pos[i * 3]);
      const cy = cell(pos[i * 3 + 1]);
      const cz = cell(pos[i * 3 + 2]);
      for (let x = cx - 1; x <= cx + 1; x++)
        for (let y = cy - 1; y <= cy + 1; y++)
          for (let z = cz - 1; z <= cz + 1; z++)
            for (const j of grid.get(key(x, y, z)) ?? []) {
              if (j <= i) continue;
              const dx = pos[i * 3] - pos[j * 3];
              const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
              const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > REACH * REACH) continue;
              const f = 5 / (d2 + 1);
              force[i * 3] += dx * f;
              force[i * 3 + 1] += dy * f;
              force[i * 3 + 2] += dz * f;
              force[j * 3] -= dx * f;
              force[j * 3 + 1] -= dy * f;
              force[j * 3 + 2] -= dz * f;
            }
    }
    for (let i = 1; i < n; i++) spring(i, list[i]?.parent ?? 0, rest[i], 0.3);
    for (const [a, b] of links) spring(a, b, 12, 0.006);
    // the root and warm-started nodes stay put; every other node moves at most 1.5 units a step
    for (let i = 3; i < n * 3; i++)
      if (!pinned[Math.floor(i / 3)]) pos[i] += Math.max(-1.5, Math.min(1.5, force[i] * 0.5));
  }
  return list.map((node, i) => ({
    path: node.path,
    parent: node.parent < 0 ? null : (list[node.parent]?.path ?? ""),
    area: node.area,
    position: [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] as Vec,
    files: node.lines >= 0 ? [node.path] : [],
    count: node.lines >= 0 ? 1 : 0,
  }));
}

/** Layouts kept per repo, newest first: navigating back, or a tree whose paths are unchanged, reuses one. */
const layouts = new Map<string, { key: string; nodes: MapNode[] }[]>();

/**
 * The repo's layout, computed once per set of paths and imports (line counts don't move nodes) and
 * kept across page visits. A changed tree warm-starts from the repo's last layout, so a merge moves
 * only the files it added.
 */
export function repoLayout(
  repoId: string,
  tree: MapSnapshot["tree"],
  imports: MapSnapshot["imports"],
  collapse: (tree: MapSnapshot["tree"]) => MapNode[] | null = () => null,
): MapNode[] {
  const key = `${tree
    .map((f) => f.path)
    .sort()
    .join("\n")}\0${imports.map((i) => `${i.from}>${i.to}`).join("\n")}`;
  const kept = layouts.get(repoId) ?? [];
  const hit = kept.find((k) => k.key === key);
  const nodes =
    hit?.nodes ??
    collapse(tree) ??
    forceLayout(
      tree,
      imports,
      STEPS,
      kept[0] && new Map(kept[0].nodes.map((node) => [node.path, node.position])),
    );
  // delete before set, so the repo moves to the end and the oldest-used repo is dropped first
  layouts.delete(repoId);
  layouts.set(repoId, [{ key, nodes }, ...kept.filter((k) => k.key !== key)].slice(0, 3));
  if (layouts.size > 8) layouts.delete(layouts.keys().next().value as string);
  return nodes;
}
