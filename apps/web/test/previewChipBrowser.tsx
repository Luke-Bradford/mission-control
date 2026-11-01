import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "../src/hud.css";
import "../src/board/board.css";
import "../src/agent/agent.css";
import type { RunView } from "@mc/core";
import { createRoot } from "react-dom/client";
import { RunRow } from "../src/agent/RunsPanel.tsx";
import { Card } from "../src/board/Card.tsx";
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
  branch: "feature/1174-web-the-pr-chip",
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
  previewable: params.get("state") === "start",
};
const runPr = {
  repoId: pr.repoId,
  number: pr.number,
  title: pr.title,
  url: pr.url,
  state: pr.state,
  ticket: pr.ticket,
};
const runView = { ...run(), prs: [runPr], ticket: pr.ticket, ticketTitle: pr.title } as RunView;

createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <div
          className="preview-chip-browser"
          style={{ display: "grid", gap: "var(--sp-4)", alignContent: "start" }}
        >
          <section className="panel" data-surface="board">
            <div className="ph">
              <h2>Board card</h2>
            </div>
            <div
              className="kcards"
              style={{ width: 280, maxWidth: "100%", padding: "var(--sp-3)" }}
            >
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
            <div className="ph">
              <h2>Agent page</h2>
            </div>
            <div style={{ padding: "var(--sp-3)" }}>
              <RunRow
                row={crewRow({ repoId: "mission-control" })}
                run={runView}
                tz="UTC"
                prs={[runPr]}
                previewPrs={[pr]}
                open={false}
                onToggle={() => {}}
              />
            </div>
          </section>
        </div>
      </main>
    </div>
  </div>,
);
