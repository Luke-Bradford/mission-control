import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "../src/hud.css";
// the modal overlay and panel rules the app loads with its panels
import "../src/hud/shared.css";
import { createRoot } from "react-dom/client";
import { CrewPauseControl } from "../src/components/CrewPause.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing");
createRoot(root).render(
  <div className="app">
    <main style={{ padding: "var(--sp-4)" }}>
      <h1>Controlled crew-pause fixture</h1>
      <p>Fictional run and operator state. No live crew action.</p>
      <CrewPauseControl />
    </main>
  </div>,
);
