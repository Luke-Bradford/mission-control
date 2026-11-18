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
import { createRoot } from "react-dom/client";
import { AgentNavRow } from "../src/comms/CommsNav.tsx";
import { AgentTag } from "../src/hud/AgentTag.tsx";
import { CrewLane } from "../src/overview/CrewLane.tsx";
import { crewRow } from "./fixtures.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const params = new URLSearchParams(window.location.search);
const index = Number(params.get("index") ?? "3");
const row = crewRow({ id: "GUIDO-1", index });
// One seat drawn the way each page draws it, inside the shell's own frame.
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <div style={{ display: "grid", gap: 8, alignContent: "start", overflow: "auto" }}>
          <section className="panel" data-surface="overview">
            <h2>Overview</h2>
            <CrewLane
              row={row}
              name={row.id}
              lane={{
                agentId: row.id,
                spans: [],
                ticks: [],
                tokens: [[Math.floor(Date.now() / 60_000) * 60_000, 5]],
              }}
              now={Date.now()}
              max={10}
            />
          </section>
          <section className="panel" data-surface="agent">
            <h2>Agent</h2>
            <AgentTag id="GUIDO-1" index={index} />
          </section>
          <section className="panel" data-surface="comms">
            <h2>Comms</h2>
            <AgentNavRow row={row} view={{ kind: "crew" }} onNavigate={() => {}} />
          </section>
        </div>
      </main>
    </div>
  </div>,
);
