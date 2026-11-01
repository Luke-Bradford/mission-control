import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "../src/hud.css";
import { createRoot } from "react-dom/client";
import { streamStatus } from "../src/data.ts";
import { QaReadiness } from "../src/pages/QaReadiness.tsx";

streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: Date.now() });
const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <QaReadiness />
      </main>
    </div>
  </div>,
);
