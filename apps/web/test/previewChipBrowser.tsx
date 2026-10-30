import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "../src/hud.css";
import { createRoot } from "react-dom/client";
import { Card } from "../src/board/Card.tsx";
import { RunRow } from "../src/agent/RunsPanel.tsx";
import { boardItem, crewRow, NOW, run } from "./fixtures.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

const params = new URLSearchParams(window.location.search);
const preview =
  params.get("state") === "preview"
    ? {
        pr: 1174,
        branch: "feature/1174-web-the-pr-chip",
        port: 5175,
        url: "http://127.0.0.1:5175",
        startedAt: NOW,
      }
    : null;
const pr = {
  repoId: "mission-control",
  number: 1174,
  title: "Web preview chip",
  url: "https://github.com/Luke-Bradford/mission-control/pull/1174",
  state: "open" as const,
  ticket: "mission-control#1174",
  state: "open" as const,
  isDraft: false,
  review: null,
  ci: null,
  createdAt: NOW,
  updatedAt: NOW,
  mergedAt: null,
  headSha: null,
  mergeable: null,
  preview,
};
const runPr = {
  repoId: pr.repoId,
  number: pr.number,
  title: pr.title,
  url: pr.url,
  state: pr.state,
  ticket: pr.ticket,
};

createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main className="preview-chip-browser">
        <section className="panel" data-surface="board">
          <h2>Board card</h2>
          <div className="kcards">
            <Card
              item={boardItem({
                repoId: "mission-control",
                issueNumber: 1174,
                title: "A long Board card title that keeps the preview row under real pressure",
                status: "In review",
                state: "review",
              })}
              showRepo={false}
              agent={null}
              step={null}
              queued={null}
              reviewer={null}
              pr={pr}
              mine={false}
              unacked={false}
              outcome="Merged"
              when=""
              statusOutOfDate={null}
              you={null}
            />
          </div>
        </section>
        <section className="panel" data-surface="agent">
          <h2>Agent page</h2>
          <RunRow
            row={crewRow({ repoId: "mission-control" })}
            run={run({ prs: [runPr], ticket: pr.ticket, ticketTitle: pr.title })}
            tz="UTC"
            prs={[runPr]}
            previewPrs={[pr]}
            open={false}
            onToggle={() => {}}
          />
        </section>
      </main>
    </div>
  </div>,
);
