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
import { Tiles } from "../src/agent/Tiles.tsx";
import { crewRow } from "./fixtures.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const params = new URLSearchParams(window.location.search);
const count = Number(params.get("count") ?? "128");
const tokensSaved = Number(params.get("saved") ?? "1234000");
const NOW = Date.now();
const row = crewRow({
  id: "GUIDO-1",
  kind: "crew",
  contextWindow: 1_000_000,
  digest: {
    toolCalls: 37,
    turns: 21,
    lastEventAt: NOW,
    model: "claude-opus-4-1",
    contextTokens: 150_000,
    contextWindow: 1_000_000,
    liveTool: null,
    tools: {},
    subagents: [],
    minuteTokens: [],
    turnUsage: [],
    background: [],
    compactions: 12,
    rereads: { count, tokensSaved },
  },
});
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <Tiles row={row} limits={[]} now={NOW} />
      </main>
    </div>
  </div>,
);
