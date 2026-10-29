import type { FindingSeverity, MapSnapshot } from "@mc/core";
import { type CSSProperties, memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type LensVisual, type MapLens, ownershipOf } from "./Lenses.tsx";

const colours = [
  "var(--seat-1)",
  "var(--seat-2)",
  "var(--seat-3)",
  "var(--seat-4)",
  "var(--seat-5)",
  "var(--seat-6)",
  "var(--seat-7)",
];
/** Conflicts shows each seat's changes at this strength, under the files that conflict. */
const conflictFade = 0.3;
const severityColours: Record<FindingSeverity, string> = {
  Critical: "var(--rem)",
  Important: "var(--warn-mark)",
  Minor: "var(--void-muted)",
};
type Rect = { x: number; y: number; width: number; height: number };
export type TreemapTile = Rect & { path: string; center: [number, number] };
export type TreemapFolder = Rect & { path: string; name: string };
type Branch = {
  path: string;
  name: string;
  children: Branch[];
  lines?: number;
  byName?: Map<string, Branch>;
};
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
  // a path is a file or a folder, never both: a file whose path runs through a file, or onto a
  // folder, is left out rather than collapsing the folder's subtree into one tile
  for (const file of files) {
    let node = root,
      path = "",
      clash = false;
    for (const part of file.path.split("/")) {
      if (node.lines !== undefined) {
        clash = true;
        break;
      }
      path = path ? `${path}/${part}` : part;
      node.byName ??= new Map();
      let child = node.byName.get(part);
      if (!child) {
        child = { path, name: part, children: [] };
        node.children.push(child);
        node.byName.set(part, child);
      }
      node = child;
    }
    if (!clash && node.children.length === 0) node.lines = file.lines;
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

const noFiles: MapSnapshot["tree"] = [];
const noIndices: Record<string, number> = {};
const noMarks = new Map<string, number>();

/**
 * Files changed or read on a seat's branch but absent from the main-branch tree, sized by their
 * changed lines, so a new file still gets a tile. A path that is a folder (a seat read a
 * directory, or listed it) is not a file and never gets one.
 */
export function branchOnlyFiles(
  tree: MapSnapshot["tree"],
  visual: Record<string, LensVisual>,
): MapSnapshot["tree"] {
  const known = new Set(tree.map((file) => file.path));
  const candidates = Object.keys(visual).filter((path) => path !== "" && !known.has(path));
  const folders = new Set<string>();
  for (const path of [...known, ...candidates]) {
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1))
      folders.add(path.slice(0, i));
  }
  return candidates
    .filter((path) => !folders.has(path))
    .map((path) => ({
      path,
      lines: Math.max(1, ...(visual[path]?.changes ?? []).map((change) => change.lines)),
    }));
}

type TileProps = {
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  focused: boolean;
  dim: boolean;
  neutral: boolean;
  overlap: boolean;
  directImport: boolean;
  fixHeavy: boolean;
  changed: string;
  read: string;
  strong: boolean;
  playCurrent: boolean;
  lines: string;
  /** What the lens says about the file, for assistive technology. */
  note: string;
  /** Ownership: the matching area label ("" for none) and whether the file is hard-rule. */
  area: string;
  hardRule: boolean;
  /** Review: the file's top severity ("" for none) and how many findings it has. */
  severity: string;
  findings: number;
  /** Conflicts: the file is changed on 2+ open branches. */
  conflict: boolean;
  intensity: number;
  intensity2: number;
  colour: string;
  colour2: string;
  readColour: string;
  readColour2: string;
  onSelect: (path: string) => void;
};

/** One file's tile; primitive props only, so a tile nothing changed for is not drawn again. */
const Tile = memo(function Tile(t: TileProps) {
  return (
    <button
      type="button"
      className="map-treemap-tile"
      data-focused={t.focused || undefined}
      data-dim={t.dim || undefined}
      data-neutral={t.neutral || undefined}
      data-overlap={t.overlap || undefined}
      data-direct-import={t.directImport || undefined}
      data-fix-heavy={t.fixHeavy || undefined}
      data-changed={t.changed || undefined}
      data-read={t.read || undefined}
      data-strong={t.strong || undefined}
      data-play-current={t.playCurrent || undefined}
      data-area={t.area || undefined}
      data-hard-rule={t.hardRule || undefined}
      data-severity={t.severity || undefined}
      data-findings={t.findings || undefined}
      data-conflict={t.conflict || undefined}
      style={
        {
          ...style({ x: t.x, y: t.y, width: t.width, height: t.height }),
          "--tile-intensity": t.intensity,
          "--tile-intensity-2": t.intensity2,
          "--tile-colour": t.colour,
          "--tile-colour-2": t.colour2,
          "--tile-split": t.width >= t.height ? "90deg" : "180deg",
          "--tile-read-colour": t.readColour,
          "--tile-read-colour-2": t.readColour2,
        } as CSSProperties
      }
      onClick={() => t.onSelect(t.path)}
      title={t.path}
      aria-description={t.note || undefined}
    >
      <span className="map-treemap-label">{t.path.split("/").at(-1)}</span>
      {t.lines && t.width >= 58 && t.height >= 26 && (
        <span className="map-treemap-lines">{t.lines}</span>
      )}
    </button>
  );
});

export const MapTreemap = memo(function MapTreemap({
  snapshot,
  lens,
  visual,
  focus,
  focusLinks = [],
  onSelect,
  indices = noIndices,
  extraFiles = noFiles,
  marks = noMarks,
  currentMark = null,
  markSeat = null,
}: {
  snapshot: MapSnapshot;
  lens: MapLens;
  visual: Record<string, LensVisual>;
  focus: string | null;
  focusLinks?: { from: string; to: string; unlinked?: boolean }[];
  onSelect: (path: string) => void;
  /** Each seat's colour, its place in config order; a seat not listed takes its place in the snapshot. */
  indices?: Record<string, number>;
  /** Changes: files absent from the tree that still get a tile (see branchOnlyFiles). */
  extraFiles?: MapSnapshot["tree"];
  /** Changes, playing: the step number of each file revealed so far, the latest one, and whose. */
  marks?: Map<string, number>;
  currentMark?: string | null;
  markSeat?: string | null;
}) {
  const [ref, size] = useSize();
  const files = useMemo(
    () =>
      lens === "changes" || lens === "conflicts"
        ? [...snapshot.tree, ...extraFiles]
        : snapshot.tree,
    [lens, snapshot.tree, extraFiles],
  );
  const layout = useMemo(() => treemapLayout(files, size.width, size.height), [files, size]);
  const owner = useMemo(
    () => (lens === "ownership" ? ownershipOf(snapshot.rules) : null),
    [lens, snapshot.rules],
  );
  // the branches a conflicting file is changed on, for the tile's description
  const conflictBranches = useMemo(() => {
    const out = new Map<string, Set<string>>();
    if (lens !== "conflicts") return out;
    for (const { file, branches } of snapshot.conflicts) {
      const set = out.get(file) ?? new Set<string>();
      for (const branch of branches) set.add(branch);
      out.set(file, set);
    }
    return out;
  }, [lens, snapshot.conflicts]);
  const colour = (seat: string) =>
    colours[
      Math.max(0, indices[seat] ?? snapshot.seats.findIndex((item) => item.seat === seat)) %
        colours.length
    ];
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group, not an image (its tiles are buttons); a fieldset is not a positioned canvas
    <div
      ref={ref}
      role="group"
      className={`map-treemap map-treemap-${lens}`}
      aria-label={
        lens === "changes"
          ? "Changes treemap"
          : lens === "impact"
            ? "Impact reach treemap"
            : lens === "history"
              ? "History PR heat treemap"
              : lens === "ownership"
                ? "Ownership treemap"
                : lens === "review"
                  ? "Review findings treemap"
                  : "Conflicts treemap"
      }
    >
      {layout.folders.map((folder) => {
        // Ownership tints a folder with its area, as the mockup does
        const area = owner?.areaOf(`${folder.path}/x`);
        return (
          <div
            key={folder.path}
            className="map-treemap-folder"
            data-area={area}
            style={
              {
                ...style(folder),
                ...(area ? { "--area-colour": owner?.colours[area] } : {}),
              } as CSSProperties
            }
          >
            <span className="map-treemap-folder-label">{folder.name}</span>
          </div>
        );
      })}
      {layout.tiles.map((tile) => {
        const v = visual[tile.path];
        const changes = v?.changes ?? [];
        const changed = changes.filter((change) => change.changed);
        const reads = changes.filter((change) => change.read && !change.changed);
        const first = changed[0],
          second = changed[1];
        const strength = (change?: { lines: number }) =>
          change ? changeIntensity(change.lines) : 0;
        const directImport = lens === "impact" && v?.directImport === true;
        const active =
          lens === "changes" || lens === "conflicts"
            ? changed.length > 0 || v?.conflict === true
            : lens === "history"
              ? v?.hotspot !== undefined
              : lens === "ownership"
                ? v?.area !== undefined || v?.hardRule === true
                : lens === "review"
                  ? v?.severity !== undefined
                  : directImport || (v?.seat !== undefined && v.distance !== undefined);
        const intensity = active
          ? lens === "history"
            ? historyHeat(v?.hotspot ?? 0)
            : lens === "changes"
              ? strength(first)
              : lens === "conflicts"
                ? strength(first) * conflictFade
                : lens === "ownership" || lens === "review"
                  ? 1
                  : 1 / ((v?.distance ?? 0) + 1)
          : 0;
        const fixHeavy = lens === "history" && isFixHeavy(v?.fixes ?? 0, v?.hotspot ?? 0);
        const tileColour =
          lens === "ownership"
            ? v?.area !== undefined
              ? (owner?.colours[v.area] ?? "var(--accent)")
              : "var(--void-line)"
            : lens === "review"
              ? severityColours[v?.severity ?? "Minor"]
              : first
                ? colour(first.seat)
                : active
                  ? lens === "history"
                    ? "var(--accent)"
                    : lens === "conflicts"
                      ? "var(--rem)"
                      : (colours[(v?.seat ?? 0) % colours.length] as string)
                  : "var(--void-line)";
        return (
          <Tile
            key={tile.path}
            path={tile.path}
            x={tile.x}
            y={tile.y}
            width={tile.width}
            height={tile.height}
            focused={focus === tile.path}
            dim={v?.dim === true}
            neutral={!active}
            overlap={v?.overlap === true}
            directImport={directImport}
            fixHeavy={fixHeavy}
            changed={changed.map((change) => change.seat).join(" ")}
            read={lens === "changes" ? reads.map((change) => change.seat).join(" ") : ""}
            strong={
              (lens === "changes" || lens === "conflicts") &&
              Math.max(strength(first), strength(second)) *
                (lens === "conflicts" ? conflictFade : 1) >=
                0.8
            }
            playCurrent={currentMark === tile.path && marks.has(tile.path)}
            lines={
              lens === "changes" && changed.length
                ? `+${changed.reduce((n, c) => n + c.add, 0)} −${changed.reduce((n, c) => n + c.rem, 0)}`
                : ""
            }
            note={
              lens === "ownership"
                ? `${v?.area ?? "no area"}${v?.hardRule ? ", hard-rule" : ""}`
                : lens === "review" && v?.severity
                  ? `${v.findings} finding${v.findings === 1 ? "" : "s"}, top severity ${v.severity}`
                  : lens === "conflicts" && v?.conflict
                    ? `conflicts between ${[...(conflictBranches.get(tile.path) ?? [])].join(", ")}`
                    : ""
            }
            area={lens === "ownership" ? (v?.area ?? "") : ""}
            hardRule={lens === "ownership" && v?.hardRule === true}
            severity={lens === "review" ? (v?.severity ?? "") : ""}
            findings={lens === "review" ? (v?.findings ?? 0) : 0}
            conflict={lens === "conflicts" && v?.conflict === true}
            intensity={intensity}
            intensity2={
              (second ? strength(second) : strength(first)) *
              (lens === "conflicts" ? conflictFade : 1)
            }
            colour={tileColour}
            colour2={second ? colour(second.seat) : first ? colour(first.seat) : "transparent"}
            readColour={reads[0] ? colour(reads[0].seat) : "transparent"}
            readColour2={reads[1] ? colour(reads[1].seat) : "transparent"}
            onSelect={onSelect}
          />
        );
      })}
      {marks.size > 0 && (
        <div
          className="map-treemap-marks"
          style={
            { "--mark-colour": markSeat ? colour(markSeat) : "var(--treemap-ink)" } as CSSProperties
          }
        >
          {[...marks].map(([path, n]) => {
            const tile = layout.byPath.get(path);
            if (!tile) return null;
            // on the tile's top edge, kept inside both the tile's reach and the map
            const x = Math.min(
              Math.max(tile.x + tile.width / 2, tile.x + 9),
              tile.x + tile.width + 2,
            );
            const y = Math.min(tile.y + tile.height / 2, tile.y + 20);
            return (
              <span
                className="map-treemap-mark"
                data-for={path}
                data-current={currentMark === path || undefined}
                key={path}
                style={{
                  left: `${Math.min(Math.max(x, 10), size.width - 10)}px`,
                  top: `${Math.min(Math.max(y, 10), size.height - 10)}px`,
                }}
              >
                {n}
              </span>
            );
          })}
        </div>
      )}
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
});

/** The mockup's change magnitude bands: up to 10 lines, 40, 120, and more. */
export const changeIntensity = (lines: number) =>
  lines <= 10 ? 0.42 : lines <= 40 ? 0.6 : lines <= 120 ? 0.8 : 1;
