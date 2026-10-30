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
import { createRoot } from "react-dom/client";
import { CrewMapView } from "../src/map/CrewMap.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const now = Date.now();
const snapshot: MapSnapshot = structuredClone(mapSnapshotFixture);
snapshot.tree = [
  { path: "src/contract.ts", lines: 120 },
  { path: "src/consumer.ts", lines: 80 },
  { path: "src/untested.ts", lines: 60 },
];
snapshot.imports = [{ from: "src/consumer.ts", to: "src/contract.ts" }];
snapshot.seats = [
  {
    ...structuredClone(snapshot.seats[0]),
    seat: "GUIDO-1",
    recent: [
      { file: "src/contract.ts", at: now - 4 * 60_000 },
      { file: "src/untested.ts", at: now - 2 * 60_000 },
    ],
    scope: {
      read: [],
      modified: [
        { file: "src/contract.ts", add: 30, rem: 10, source: "diff" },
        { file: "src/untested.ts", add: 2, rem: 0, source: "diff" },
      ],
    },
  },
];
// The shell App wraps the Map in: full width, no dock.
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <section id="page-map" className="map-page">
          <CrewMapView snapshot={snapshot} />
        </section>
      </main>
    </div>
  </div>,
);
