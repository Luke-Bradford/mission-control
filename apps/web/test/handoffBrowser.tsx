import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "../src/hud.css";
import { createRoot } from "react-dom/client";
import { HandoffPanel } from "../src/agent/HandoffPanel.tsx";
import { Card } from "../src/board/Card.tsx";
import "../src/board/board.css";
import { boardItem } from "./fixtures.ts";
import { handoffFixture as h } from "./handoffFixture.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <HandoffPanel runId="old" />
        <div style={{ width: 300, marginTop: 16 }}>
          <Card
            item={boardItem({ repoId: h.repoId, issueNumber: 997, handoff: h })}
            showRepo={false}
            agent={null}
            step={null}
            queued={null}
            reviewer={null}
            pr={null}
            checkPill={null}
            mine={false}
            unacked={false}
            outcome="Closed"
            when=""
            statusOutOfDate={null}
            you={null}
          />
        </div>
      </main>
    </div>
  </div>,
);
