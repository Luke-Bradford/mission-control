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
import { mapSnapshotFixture } from "@mc/core";
import { createRoot } from "react-dom/client";
import { AgentNavRow } from "../src/comms/CommsNav.tsx";
import { AgentTag } from "../src/hud/AgentTag.tsx";
import { CrewMapView } from "../src/map/CrewMap.tsx";
import { AgentActivity } from "../src/overview/AgentActivity.tsx";
import { crewRow } from "./fixtures.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const params = new URLSearchParams(window.location.search);
const index = Number(params.get("index") ?? "3");
const row = crewRow({ id: "GUIDO-1", index });
const snapshot = structuredClone(mapSnapshotFixture);
snapshot.seats = [
  { ...structuredClone(mapSnapshotFixture.seats[0]), seat: "GUIDO-1", state: "running" },
];
// One seat drawn the way each page draws it, inside the shell's own frame.
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <div style={{ display: "grid", gap: 8, alignContent: "start", overflow: "auto" }}>
          <section className="panel" data-surface="overview">
            <h2>Overview</h2>
            <AgentActivity row={row} now={Date.now()} max={10} />
          </section>
          <section className="panel" data-surface="agent">
            <h2>Agent</h2>
            <AgentTag id="GUIDO-1" index={index} />
          </section>
          <section className="panel" data-surface="comms">
            <h2>Comms</h2>
            <AgentNavRow row={row} view={{ kind: "crew" }} mentions={0} onNavigate={() => {}} />
          </section>
          <section id="page-map" className="map-page" data-surface="map" style={{ height: 560 }}>
            <CrewMapView snapshot={snapshot} indices={{ "GUIDO-1": index }} names={{}} work={{}} />
          </section>
        </div>
      </main>
    </div>
  </div>,
);
