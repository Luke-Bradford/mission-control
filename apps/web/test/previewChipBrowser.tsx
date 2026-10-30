import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "../src/hud.css";
import { createRoot } from "react-dom/client";
import { PrChip } from "../src/hud/PrChip.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

const pr = {
  repoId: "mission-control",
  number: 1174,
  title: "Web preview chip",
  url: "https://github.com/Luke-Bradford/mission-control/pull/1174",
  state: "open" as const,
  ticket: "mission-control#1174",
};
const preview = {
  pr: 1174,
  branch: "feature/1174-web-the-pr-chip",
  port: 5175,
  url: "http://127.0.0.1:5175",
  startedAt: Date.now(),
};

createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main className="preview-chip-browser">
        <section className="panel" data-surface="board">
          <h2>Board card</h2>
          <PrChip pr={pr} bare preview={preview} />
        </section>
        <section className="panel" data-surface="agent">
          <h2>Agent page</h2>
          <PrChip pr={pr} bare preview={preview} />
        </section>
      </main>
    </div>
  </div>,
);
