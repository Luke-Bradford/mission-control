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
import { Flight } from "../src/pages/Flight.tsx";

const params = new URLSearchParams(location.search);
// ?at=/flight#wifP opens the tabbed page on that fragment.
const at = params.get("at");
if (at) window.history.replaceState(null, "", at);
// ?theme=light|dark pins the theme.
const theme = params.get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// The shell App wraps the FLIGHT page in: full width, no dock. ?view=page renders the one-screen
// page between the live app's 49 px top bar and 30 px footer; the default is the tabbed page. One
// entry serves both, as a harness page of its own would change how the shared CSS is chunked.
createRoot(root).render(
  params.get("view") === "page" ? (
    <div className="app">
      <div style={{ flex: "none", height: 49, borderBottom: "1px solid var(--line)" }} />
      <div className="shell shell-full">
        <main>
          <Flight />
        </main>
      </div>
      <div style={{ flex: "none", height: 30, borderTop: "1px solid var(--line)" }} />
    </div>
  ) : (
    <div className="app">
      <div className="shell shell-full">
        <main>
          <FlightTabs />
        </main>
      </div>
    </div>
  ),
);
