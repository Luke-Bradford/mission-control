import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "../src/hud.css";
import { createRoot } from "react-dom/client";
import { Flight } from "../src/pages/Flight.tsx";
import { FLOW_NOW } from "./prFlowFixture.ts";

// Only this fixture's browser clock is fixed, so time-based labels are reproducible.
Date.now = () => FLOW_NOW;
const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <Flight />
      </main>
    </div>
  </div>,
);
