import type { MapSnapshot } from "@mc/core";
import { type CSSProperties, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LensVisual, MapLens } from "./Lenses.tsx";

const colours = [
  "var(--seat-1)",
  "var(--seat-2)",
  "var(--seat-3)",
  "var(--seat-4)",
  "var(--seat-5)",
  "var(--seat-6)",
  "var(--seat-7)",
];
type Rect = { x: number; y: number; width: number; height: number };
export type TreemapTile = Rect & { path: string; center: [number, number] };
export type TreemapFolder = Rect & { path: string; name: string };
type Branch = { path: string; name: string; children: Branch[]; lines?: number };
const weight = (node: Branch): number =>
  node.lines === undefined
    ? Math.max(
        1,
        node.children.reduce((n, c) => n + weight(c), 0),
      )
    : Math.max(4, node.lines);

/** Line-weighted hierarchy; the returned rectangles drive both the tiles and relationship lines. */
export function treemapLayout(files: MapSnapshot["tree"], width: number, height: number) {
  const root: Branch = { path: "", name: "", children: [] };
  for (const file of files) {
    let node = root,
      path = "";
    for (const part of file.path.split("/")) {
      path = path ? `${path}/${part}` : part;
      let child = node.children.find((x) => x.name === part);
      if (!child) {
        child = { path, name: part, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.lines = file.lines;
  }
  const tiles: TreemapTile[] = [],
    folders: TreemapFolder[] = [],
    byPath = new Map<string, TreemapTile>();
  const place = (node: Branch, box: Rect, depth: number) => {
    if (node.lines !== undefined) {
      const tile = {
        ...box,
        path: node.path,
        center: [box.x + box.width / 2, box.y + box.height / 2] as [number, number],
      };
      tiles.push(tile);
      byPath.set(tile.path, tile);
      return;
    }
    if (depth) folders.push({ ...box, path: node.path, name: node.name });
    const content = depth
      ? {
          x: box.x + 3,
          y: box.y + 15,
          width: Math.max(0, box.width - 6),
          height: Math.max(0, box.height - 18),
        }
      : box;
    const horizontal = content.width >= content.height,
      total = node.children.reduce((n, c) => n + weight(c), 0);
    let cursor = horizontal ? content.x : content.y;
    for (const child of node.children) {
      const size = ((horizontal ? content.width : content.height) * weight(child)) / total;
      const childBox = horizontal
        ? { x: cursor, y: content.y, width: size, height: content.height }
        : { x: content.x, y: cursor, width: content.width, height: size };
      cursor += size;
      place(child, childBox, depth + 1);
    }
  };
  place(root, { x: 0, y: 0, width, height }, 0);
  return { tiles, folders, byPath };
}

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) setSize({ width: r.width, height: r.height });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}
const style = (r: Rect): CSSProperties => ({
  left: `${r.x}px`,
  top: `${r.y}px`,
  width: `${r.width}px`,
  height: `${r.height}px`,
});

export function MapTreemap({
  snapshot,
  lens,
  visual,
  focus,
  focusLinks = [],
  onSelect,
}: {
  snapshot: MapSnapshot;
  lens: Exclude<MapLens, "changes">;
  visual: Record<string, LensVisual>;
  focus: string | null;
  focusLinks?: { from: string; to: string; unlinked?: boolean }[];
  onSelect: (path: string) => void;
}) {
  const [ref, size] = useSize();
  const layout = useMemo(
    () => treemapLayout(snapshot.tree, size.width, size.height),
    [snapshot.tree, size],
  );
  const max = Math.max(1, ...layout.tiles.map((tile) => visual[tile.path]?.hotspot ?? 0));
  return (
    <div
      ref={ref}
      className={`map-treemap map-treemap-${lens}`}
      role="img"
      aria-label={lens === "impact" ? "Impact reach treemap" : "History PR heat treemap"}
    >
      {layout.folders.map((folder) => (
        <div key={folder.path} className="map-treemap-folder" style={style(folder)}>
          <span className="map-treemap-folder-label">{folder.name}</span>
        </div>
      ))}
      {layout.tiles.map((tile) => {
        const v = visual[tile.path];
        const active =
          lens === "history"
            ? v?.hotspot !== undefined
            : v?.seat !== undefined && v.distance !== undefined;
        const intensity = active
          ? lens === "history"
            ? (v?.hotspot ?? 0) / max
            : 1 / ((v?.distance ?? 0) + 1)
          : 0;
        return (
          <button
            type="button"
            className="map-treemap-tile"
            key={tile.path}
            data-focused={focus === tile.path || undefined}
            data-dim={v?.dim || undefined}
            data-neutral={!active || undefined}
            style={
              {
                ...style(tile),
                "--tile-intensity": intensity,
                "--tile-colour": active
                  ? colours[(v?.seat ?? 0) % colours.length]
                  : "var(--void-line)",
              } as CSSProperties
            }
            onClick={() => onSelect(tile.path)}
            title={tile.path}
          >
            <span className="map-treemap-label">{tile.path.split("/").at(-1)}</span>
          </button>
        );
      })}
      {focusLinks.length > 0 && (
        <svg
          className="map-treemap-links"
          viewBox={`0 0 ${size.width} ${size.height}`}
          aria-hidden="true"
        >
          {focusLinks.map((link) => {
            const from = layout.byPath.get(link.from),
              to = layout.byPath.get(link.to);
            return from && to ? (
              <line
                key={`${link.from}:${link.to}`}
                x1={from.center[0]}
                y1={from.center[1]}
                x2={to.center[0]}
                y2={to.center[1]}
                data-hidden={link.unlinked || undefined}
              />
            ) : null;
          })}
        </svg>
      )}
      {focus !== null && (
        <p className="map-treemap-trace">Focused file and its relationships are traced.</p>
      )}
    </div>
  );
}
