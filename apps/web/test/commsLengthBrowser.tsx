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
import "../src/comms/comms.css";
import { createRoot } from "react-dom/client";
import { CommsGraph } from "../src/comms/CommsGraph.tsx";
import { seatRow } from "./fixtures.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const rows = [
  seatRow({ id: "flight-1", index: 0, role: "FLIGHT" }),
  seatRow({ id: "guido-1", index: 1 }),
  seatRow({ id: "retro-1", index: 2, role: "RETRO" }),
];
// The Comms page's own frame: the right column beside a conversation, filling the shell.
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <div className="comms-page" id="page-comms">
          <div className="comms-grid">
            <div />
            <div />
            <CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />
          </div>
        </div>
      </main>
    </div>
  </div>,
);
