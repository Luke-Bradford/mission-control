import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "../src/hud.css";
import "../src/agent/agent.css";
import "../src/overview/overview.css";
import "../src/board/board.css";
import { reviewCheckPill } from "@mc/core";
import { createRoot } from "react-dom/client";
import { Header } from "../src/agent/Header.tsx";
import { Card } from "../src/board/Card.tsx";
import { PrChip } from "../src/hud/PrChip.tsx";
import { AgentsPanel } from "../src/overview/AgentsPanel.tsx";
import { boardItem, NOW, prView, seatRow } from "./fixtures.ts";
import { REVIEW_STATES } from "./reviewDisplayFixture.ts";

Date.now = () => NOW;
const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const check = REVIEW_STATES[1]?.check;
if (!check) throw new Error("missing check");
const author = seatRow({ hudState: "idle", review: { prNumber: 1039, state: "open", check } });
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main style={{ display: "block", overflow: "auto" }}>
        <div style={{ height: 220, display: "flex", flexDirection: "column", marginBottom: 16 }}>
          <AgentsPanel />
        </div>
        <Header row={author} limits={[]} />
        <div
          className="review-display-cases"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
            gap: 12,
            marginTop: 16,
          }}
        >
          {REVIEW_STATES.map(({ check }, i) => {
            const pr = prView({ number: 1039 + i, check });
            return (
              <div key={check.kind} data-kind={check.kind}>
                <Card
                  item={boardItem({
                    issueNumber: 1027 + i,
                    status: "In review",
                    title: "Review state",
                  })}
                  showRepo={false}
                  agent={null}
                  step={null}
                  queued={null}
                  reviewer={null}
                  pr={pr}
                  checkPill={reviewCheckPill(check, NOW)}
                  mine={false}
                  unacked={false}
                  outcome="Closed"
                  when=""
                  statusOutOfDate={null}
                  you={null}
                />
                <PrChip pr={pr} />
              </div>
            );
          })}
        </div>
      </main>
    </div>
  </div>,
);
