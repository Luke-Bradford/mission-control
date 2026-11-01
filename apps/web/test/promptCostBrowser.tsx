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
import "../src/agent/agent.css";
import { createRoot } from "react-dom/client";
import { SideTabs } from "../src/agent/SideTabs.tsx";
import { crewRow } from "./fixtures.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const row = crewRow({ id: "guido-1", kind: "crew", run: { id: "run-1" } as never });
// The Agent page's own frame: the side column beside the stream.
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <section id="page-agent">
          <div className="agrid">
            <div />
            <div className="side">
              <SideTabs row={row} />
            </div>
          </div>
        </section>
      </main>
    </div>
  </div>,
);
