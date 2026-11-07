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
import { FlightTabs } from "../src/flight/FlightTabs.tsx";

// ?at=/flight#wifP opens the tabbed page on that fragment.
const at = new URLSearchParams(location.search).get("at");
if (at) window.history.replaceState(null, "", at);

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// The shell App wraps the FLIGHT page in: full width, no dock.
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <FlightTabs />
      </main>
    </div>
  </div>,
);
