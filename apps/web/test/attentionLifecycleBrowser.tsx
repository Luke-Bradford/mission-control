import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "../src/hud.css";
import "../src/agent/agent.css";
import "../src/overview/overview.css";
import "../src/board/board.css";
import { createRoot } from "react-dom/client";
import { NeedBanner } from "../src/agent/NeedBanner.tsx";
import { AgentsPanel } from "../src/overview/AgentsPanel.tsx";
import { crewRow, item, NOW } from "./fixtures.ts";

Date.now = () => NOW;
const row = crewRow({
  id: "studio",
  kind: "loop",
  hudState: "idle",
  run: null,
  ticket: null,
  loop: null,
});
const items = Array.from({ length: 50 }, (_, i) =>
  item({ key: `loop:${i}`, agentId: "studio", ticket: null, kind: "decision", owner: "loop" }),
);
const root = document.getElementById("root");
if (!root) throw Error("missing root");
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main style={{ display: "block", overflow: "auto" }}>
        <div style={{ height: 260, display: "flex", flexDirection: "column" }}>
          <AgentsPanel />
        </div>
        <NeedBanner row={row} items={items} />
      </main>
    </div>
  </div>,
);
