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
import { Flight } from "../src/pages/Flight.tsx";

const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// The shell the page sits in: the live app's 49 px top bar and 30 px footer, full width, no dock.
createRoot(root).render(
  <div className="app">
    <div style={{ flex: "none", height: 49, borderBottom: "1px solid var(--line)" }} />
    <div className="shell shell-full">
      <main>
        <Flight />
      </main>
    </div>
    <div style={{ flex: "none", height: 30, borderTop: "1px solid var(--line)" }} />
  </div>,
);
