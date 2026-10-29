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

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// The shell App wraps every full-width page in: Setup takes the whole window, with no dock.
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <Setup tab="accounts" />
      </main>
    </div>
  </div>,
);
