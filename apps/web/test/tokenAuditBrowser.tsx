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
import { Audit } from "../src/pages/Audit.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// The shell App wraps the Audit page in: the work area beside FLIGHT's 380 px dock (a stand-in).
createRoot(root).render(
  <div className="app">
    <div className="shell">
      <main>
        <Audit />
      </main>
      <aside className="dock" aria-label="FLIGHT dock">
        FLIGHT dock
      </aside>
    </div>
  </div>,
);
