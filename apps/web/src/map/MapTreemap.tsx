import type { MapSnapshot } from "@mc/core";
import type { CSSProperties } from "react";
import type { LensVisual, MapLens } from "./Lenses.tsx";

const seatColours = [
  "var(--seat-1)",
  "var(--seat-2)",
  "var(--seat-3)",
  "var(--seat-4)",
  "var(--seat-5)",
  "var(--seat-6)",
  "var(--seat-7)",
];

/** A compact, file-sized overview used by the analytical Map lenses. */
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
  const files = [...snapshot.tree].sort(
    (a, b) => b.lines - a.lines || a.path.localeCompare(b.path),
  );
  const max = Math.max(
    1,
    ...files.map((file) => (lens === "history" ? (visual[file.path]?.hotspot ?? 0) : 1)),
  );
  const labelled = lens === "impact" ? "Impact reach treemap" : "History PR heat treemap";
  const positions = new Map(
    files.map((file, index) => [
      file.path,
      [5 + (index % 10) * 10, 7 + (Math.floor(index / 10) % 10) * 10],
    ]),
  );
  return (
    <div className={`map-treemap map-treemap-${lens}`} role="img" aria-label={labelled}>
      <div className="map-treemap-grid">
        {files.map((file, index) => {
          const value = visual[file.path];
          const intensity =
            lens === "history" ? (value?.hotspot ?? 0) / max : 1 / ((value?.distance ?? 3) + 1);
          const span = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(Math.max(file.lines, 1)) / 10)));
          return (
            <button
              type="button"
              className="map-treemap-tile"
              key={file.path}
              data-focused={focus === file.path || undefined}
              data-dim={value?.dim || undefined}
              style={
                {
                  "--tile-intensity": intensity,
                  "--tile-colour": seatColours[(value?.seat ?? index) % seatColours.length],
                  gridColumn: `span ${span}`,
                  gridRow: `span ${span}`,
                } as CSSProperties
              }
              onClick={() => onSelect(file.path)}
              title={file.path}
            >
              <span className="map-treemap-label">{file.path.split("/").at(-1)}</span>
            </button>
          );
        })}
      </div>
      {focusLinks.length > 0 && (
        <svg className="map-treemap-links" viewBox="0 0 100 100" aria-hidden="true">
          {focusLinks.map((link) => {
            const from = positions.get(link.from);
            const to = positions.get(link.to);
            return from && to ? (
              <line
                key={`${link.from}:${link.to}`}
                x1={from[0]}
                y1={from[1]}
                x2={to[0]}
                y2={to[1]}
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
