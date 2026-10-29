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
export const historyHeat = (prs: number) =>
  prs >= 30 ? 0.85 : prs >= 10 ? 0.6 : prs >= 3 ? 0.36 : prs > 0 ? 0.16 : 0;
export const isFixHeavy = (fixes: number, prs: number) =>
  fixes >= 5 || (fixes >= 3 && prs > 0 && fixes / prs >= 0.5);

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
  const collapse = (node: Branch, root = false): Branch => {
    node.children = node.children.map((child) => collapse(child));
    while (!root && node.lines === undefined && node.children.length === 1) {
      const child = node.children[0] as Branch;
      node.name = `${node.name}/${child.name}`;
      node.path = child.path;
      node.lines = child.lines;
      node.children = child.children;
    }
    return node;
  };
  collapse(root, true);
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
    const showHeader = depth > 0 && box.width >= 64 && box.height >= 40;
    if (depth) folders.push({ ...box, path: node.path, name: node.name });
    const inset = showHeader && box.width >= 12 && box.height >= 24 ? 3 : 0;
    const content = depth
      ? {
          x: box.x + inset,
          y: box.y + (showHeader ? 15 : 0),
          width: box.width - inset * 2,
          height: box.height - (showHeader ? 15 : 0) - inset,
        }
      : box;
    const children = [...node.children].sort((a, b) => weight(b) - weight(a));
    const totalWeight = children.reduce((total, child) => total + weight(child), 0);
    const area = new Map(
      children.map((child) => [
        child,
        (weight(child) * content.width * content.height) / totalWeight,
      ]),
    );
    let remaining = content;
    let row: Branch[] = [];
    let rowWeight = 0;
    const worst = (next: Branch[]) => {
      const sum = next.reduce((total, child) => total + (area.get(child) ?? 0), 0);
      const side = Math.max(1, Math.min(remaining.width, remaining.height));
      const values = next.map((child) => area.get(child) ?? 0);
      return Math.max(
        (side * side * Math.max(...values)) / (sum * sum),
        (sum * sum) / (side * side * Math.min(...values)),
      );
    };
    const layRow = () => {
      if (!row.length) return;
      const total = rowWeight;
      if (remaining.width >= remaining.height) {
        const width = total / remaining.height;
        let y = remaining.y;
        for (const child of row) {
          const height = (area.get(child) ?? 0) / width;
          place(child, { x: remaining.x, y, width, height }, depth + 1);
          y += height;
        }
        remaining = {
          ...remaining,
          x: remaining.x + width,
          width: Math.max(0, remaining.width - width),
        };
      } else {
        const height = total / remaining.width;
        let x = remaining.x;
        for (const child of row) {
          const width = (area.get(child) ?? 0) / height;
          place(child, { x, y: remaining.y, width, height }, depth + 1);
          x += width;
        }
        remaining = {
          ...remaining,
          y: remaining.y + height,
          height: Math.max(0, remaining.height - height),
        };
      }
      row = [];
      rowWeight = 0;
    };
    for (const child of children) {
      if (row.length && worst([...row, child]) > worst(row)) layRow();
      row.push(child);
      rowWeight += area.get(child) ?? 0;
    }
    layRow();
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
  lens: MapLens;
  visual: Record<string, LensVisual>;
  focus: string | null;
  focusLinks?: { from: string; to: string; unlinked?: boolean }[];
  onSelect: (path: string) => void;
}) {
  const [ref, size] = useSize();
  const files = useMemo(
    () =>
      lens === "changes"
        ? [
            ...snapshot.tree,
            ...Object.keys(visual)
              .filter((path) => !snapshot.tree.some((file) => file.path === path))
              .map((path) => ({ path, lines: 1 })),
          ]
        : snapshot.tree,
    [lens, snapshot.tree, visual],
  );
  const layout = useMemo(() => treemapLayout(files, size.width, size.height), [files, size]);
  return (
    <div
      ref={ref}
      className={`map-treemap map-treemap-${lens}`}
      role="img"
      aria-label={
        lens === "changes"
          ? "Changes treemap"
          : lens === "impact"
            ? "Impact reach treemap"
            : "History PR heat treemap"
      }
    >
      {layout.folders.map((folder) => (
        <div key={folder.path} className="map-treemap-folder" style={style(folder)}>
          <span className="map-treemap-folder-label">{folder.name}</span>
        </div>
      ))}
      {layout.tiles.map((tile) => {
        const v = visual[tile.path];
        const changes = v?.changes ?? [];
        const changed = changes.filter((change) => change.changed);
        const reads = changes.filter((change) => change.read && !change.changed);
        const colour = (seat: string) =>
          colours[
            Math.max(
              0,
              snapshot.seats.findIndex((item) => item.seat === seat),
            ) % colours.length
          ];
        const directImport = lens === "impact" && v?.directImport === true;
        const active =
          lens === "changes"
            ? changes.length > 0
            : lens === "history"
              ? v?.hotspot !== undefined
              : directImport || (v?.seat !== undefined && v.distance !== undefined);
        const intensity = active
          ? lens === "history"
            ? historyHeat(v?.hotspot ?? 0)
            : lens === "changes"
              ? changeIntensity(Math.max(0, ...changed.map((change) => change.lines)))
              : 1 / ((v?.distance ?? 0) + 1)
          : 0;
        const fixHeavy = lens === "history" && isFixHeavy(v?.fixes ?? 0, v?.hotspot ?? 0);
        return (
          <button
            type="button"
            className="map-treemap-tile"
            key={tile.path}
            data-focused={focus === tile.path || undefined}
            data-dim={v?.dim || undefined}
            data-neutral={!active || undefined}
            data-overlap={v?.overlap || undefined}
            data-direct-import={directImport || undefined}
            data-fix-heavy={fixHeavy || undefined}
            data-changed={changed.map((change) => change.seat).join(" ") || undefined}
            data-read={reads.map((change) => change.seat).join(" ") || undefined}
            style={
              {
                ...style(tile),
                "--tile-intensity": intensity,
                "--tile-colour": active
                  ? lens === "history"
                    ? "var(--accent)"
                    : lens === "changes"
                      ? colour(changed[0]?.seat ?? reads[0]?.seat ?? "")
                      : colours[(v?.seat ?? 0) % colours.length]
                  : "var(--void-line)",
                "--tile-colour-2": changed[1] ? colour(changed[1].seat) : "transparent",
                "--tile-read-colour": reads[0] ? colour(reads[0].seat) : "transparent",
                "--tile-read-colour-2": reads[1] ? colour(reads[1].seat) : "transparent",
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
    </div>
  );
}

const changeIntensity = (lines: number) =>
  lines <= 10 ? 0.42 : lines <= 40 ? 0.6 : lines <= 120 ? 0.8 : 1;
