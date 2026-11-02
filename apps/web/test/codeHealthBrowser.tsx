import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/hud.css";
import { createRoot } from "react-dom/client";
import { CodeHealth } from "../src/code-health/CodeHealth.tsx";
import { streamStatus } from "../src/data.ts";

const params = new URLSearchParams(location.search);
streamStatus.set({
  connected: !params.has("disconnected"),
  reconnecting: params.has("disconnected"),
  lastMessageAt: Date.now(),
});
const root = document.getElementById("root");
if (!root) throw Error("Fixture root missing");
const style = document.createElement("style");
style.textContent =
  "html,body{height:auto;overflow:auto}body{padding:24px}#root{min-width:0}.fixture-caption{margin:0 0 16px;font:12px/16px var(--sans);color:var(--fg-2)}.fixture-frame{min-width:0}.fixture-dock{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px}.fixture-side{border:1px solid var(--line-2);padding:16px;font:12px/16px var(--sans)}";
document.head.append(style);
createRoot(root).render(
  <>
    <p className="fixture-caption">
      Fictional browser fixtures · Code-health product layout
      {params.has("dock") ? " · available width beside a 380 px dock" : ""}
    </p>
    <div className={params.has("dock") ? "fixture-dock" : "fixture-frame"}>
      <CodeHealth />
      {params.has("dock") && (
        <aside className="fixture-side">FLIGHT · representative dock width</aside>
      )}
    </div>
  </>,
);
