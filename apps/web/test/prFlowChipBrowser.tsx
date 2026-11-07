import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "../src/hud.css";
import "../src/agent/agent.css";
import "../src/board/board.css";
import type { FlightPrFlowRow, ReviewCheckState } from "@mc/core";
import { createRoot } from "react-dom/client";
import { Card } from "../src/board/Card.tsx";
import { flowChip } from "../src/board/prFlowChip.ts";
import { boardItem, NOW, prView } from "./fixtures.ts";

Date.now = () => NOW;
const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const flow = (stage: FlightPrFlowRow["stage"], ownerKind: FlightPrFlowRow["ownerKind"]) =>
  ({ pr: 0, stage, ownerKind }) as FlightPrFlowRow;
const CASES: { name: string; check: ReviewCheckState; row: FlightPrFlowRow }[] = [
  {
    name: "controller-check",
    check: { kind: "held", by: "operator" },
    row: flow("controller check", "controller"),
  },
  { name: "operator", check: { kind: "held", by: "operator" }, row: flow("clearance", "operator") },
  { name: "sync", check: { kind: "ready" }, row: flow("sync", "seat") },
  { name: "merge", check: { kind: "ready" }, row: flow("merge", "hub") },
];
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main style={{ display: "block", overflow: "auto" }}>
        <div
          className="flow-chip-cases"
          style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}
        >
          {CASES.map(({ name, check, row }, i) => {
            const chip = flowChip(check, row);
            return (
              <div key={name} data-case={name}>
                <Card
                  item={boardItem({ issueNumber: 1 + i, status: "In review", title: name })}
                  showRepo={false}
                  agent={null}
                  step={null}
                  queued={null}
                  reviewer={null}
                  pr={prView({ number: 10 + i, check })}
                  checkLabel={chip.label}
                  checkTone={chip.tone}
                  checkReason={chip.reason}
                  mine={false}
                  unacked={false}
                  outcome="Closed"
                  when=""
                  statusOutOfDate={null}
                  you={null}
                />
              </div>
            );
          })}
        </div>
      </main>
    </div>
  </div>,
);
