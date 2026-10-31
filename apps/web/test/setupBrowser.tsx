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
import { Setup } from "../src/pages/Setup.tsx";
import type { SetupTab } from "../src/router.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const tab = (new URLSearchParams(window.location.search).get("tab") ?? "accounts") as SetupTab;
// The shell App wraps every full-width page in: Setup takes the whole window, with no dock.
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <Setup tab={tab} />
      </main>
    </div>
  </div>,
);
