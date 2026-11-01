import analysis from "../../../packages/core/test/fixtures/map-analysis.json";
import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/barlow-semi-condensed/latin-700.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "../src/hud.css";
import { type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import tree from "../../../packages/core/test/fixtures/map-tree.json";
import { HistoryLens, ImpactLens } from "../src/lenses/lenses.tsx";
import { CrewMapView } from "../src/map/CrewMap.tsx";

const fixture: MapSnapshot = {
  ...structuredClone(mapSnapshotFixture),
  tree,
  imports: analysis.imports.map(([from, to]) => ({
    from: tree[from as number]?.path ?? "",
    to: tree[to as number]?.path ?? "",
  })),
  hist: analysis.hist as unknown as MapSnapshot["hist"],
  seats: Array.from({ length: 3 }, (_, i) => ({
    ...structuredClone(mapSnapshotFixture.seats[0]),
    seat: `GUIDO-${i + 1}`,
    scope: {
      read: [],
      modified: tree
        .filter((file) => file.path.endsWith(".ts") && !file.path.includes("/test/"))
        .slice(i * 8, i * 8 + 8)
        .map((file) => ({ file: file.path, add: 12, rem: 3, source: "diff" as const })),
    },
  })),
};
declare global {
  interface Window {
    mapPerformance: { snapshotMs: number[]; switchMs: number[] };
  }
}
window.mapPerformance = { snapshotMs: [], switchMs: [] };
function Bench() {
  const [snapshot, setSnapshot] = useState(fixture),
    [mode, setMode] = useState("map");
  const pending = useRef<{ kind: "snapshotMs" | "switchMs"; at: number } | null>(null);
  useLayoutEffect(() => {
    const current = pending.current;
    if (!current) return;
    window.mapPerformance[current.kind].push(performance.now() - current.at);
    pending.current = null;
  });
  const change = (kind: "snapshotMs" | "switchMs", update: () => void) => {
    pending.current = { kind, at: performance.now() };
    update();
  };
  return (
    <div className="app">
      <div className="shell shell-full">
        <main>
          <div className="toolbar">
            <button
              type="button"
              data-update
              onClick={() =>
                change("snapshotMs", () =>
                  setSnapshot((s) => ({
                    ...s,
                    tree: s.tree.map((file, i) =>
                      i === 0 ? { ...file, lines: file.lines + 1 } : file,
                    ),
                  })),
                )
              }
            >
              Update snapshot
            </button>
            {["map", "impact", "history"].map((next) => (
              <button
                type="button"
                key={next}
                data-mode={next}
                onClick={() => change("switchMs", () => setMode(next))}
              >
                {next}
              </button>
            ))}
          </div>
          <section id="page-map" className="map-page">
            {mode === "map" ? (
              <CrewMapView snapshot={snapshot} />
            ) : mode === "impact" ? (
              <ImpactLens snapshot={snapshot} focus={null} onFocus={() => {}} />
            ) : (
              <HistoryLens snapshot={snapshot} focus={null} onFocus={() => {}} />
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw Error("root");
createRoot(root).render(<Bench />);
