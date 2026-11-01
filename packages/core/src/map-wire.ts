import type { MapLive, MapSnapshot, MapTree } from "./map.ts";

/** Paths share a prefix with the preceding path; graph edges refer to this stable tree order. */
export type MapFileWire = [prefix: number, suffix: string, lines: number];
export type MapPayload = MapLive &
  Pick<MapTree, "repoId" | "rules"> & {
    tree: MapFileWire[];
    graphKey: string;
  };
export interface MapGraph {
  key: string;
  imports: [number, number][];
  hist: MapTree["hist"];
}

export function packMapTree(tree: MapTree["tree"]): MapFileWire[] {
  let previous = "";
  return tree.map(({ path, lines }) => {
    let prefix = 0;
    while (prefix < previous.length && prefix < path.length && previous[prefix] === path[prefix])
      prefix++;
    const entry: MapFileWire = [prefix, path.slice(prefix), lines];
    previous = path;
    return entry;
  });
}

/** Accept full snapshots too: fixtures and an already-open page can outlive a hub update. */
export function unpackMap(payload: MapPayload | MapSnapshot): MapSnapshot {
  if (!("graphKey" in payload) || payload.graphKey === undefined || "imports" in payload)
    return payload as MapSnapshot;
  let previous = "";
  const tree = payload.tree.map(([prefix, suffix, lines]) => {
    if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > previous.length)
      throw Error("Invalid map tree prefix");
    const path = previous.slice(0, prefix) + suffix;
    previous = path;
    return { path, lines };
  });
  return {
    ...payload,
    tree,
    imports: [],
    hist: { since: 0, prCount: 0, fixCount: 0, files: {}, coupling: [] },
  };
}

const decodedImports = new WeakMap<MapGraph, WeakMap<MapTree["tree"], MapTree["imports"]>>();
export function joinMapGraph(snapshot: MapSnapshot, graph: MapGraph): MapSnapshot {
  if (snapshot.graphKey !== graph.key) throw Error("Map graph changed; reload the map");
  let byTree = decodedImports.get(graph);
  if (!byTree) {
    byTree = new WeakMap();
    decodedImports.set(graph, byTree);
  }
  let imports = byTree.get(snapshot.tree);
  if (!imports) {
    imports = graph.imports.map(([from, to]) => {
      const a = snapshot.tree[from],
        b = snapshot.tree[to];
      if (!a || !b) throw Error("Invalid map graph index");
      return { from: a.path, to: b.path };
    });
    byTree.set(snapshot.tree, imports);
  }
  return { ...snapshot, imports, hist: graph.hist };
}
