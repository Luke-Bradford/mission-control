import { GUARD_RULES } from "@mc/core";
import { RESOURCES } from "../src/data.ts";
import { agentView, populatedAgentView } from "./agentV2Fixture.ts";
import { type DesktopScenario, desktopFixture } from "./desktopFixtures.ts";
import { NOW, seatRow } from "./fixtures.ts";

/** Fictional, settled API contracts for the actual App. No fixture number is a live claim. */
export function agentDensityFixture(scenario: DesktopScenario = "default") {
  const fixture = desktopFixture(scenario);
  const view =
    scenario === "one"
      ? agentView(seatRow({ hudState: "idle", run: null, ticket: null, ticketTitle: null }))
      : populatedAgentView();
  if (view.row.run) {
    view.row.ticket = "shop-app#77";
    view.row.ticketTitle = "Keep the Agent result visible and preserve every operator route";
    view.row.run = { ...view.row.run, branch: "feature/77-agent-density" };
    view.story.title = view.row.ticketTitle;
    view.story.ticketHref = "/tickets/shop-app/77";
  }
  view.row.cli = { effort: "high", budgetUsd: 12.5, version: "2.1.302" };
  if (view.row.run)
    view.row.review = {
      prNumber: 77,
      state: "changes",
      check: {
        kind: "held",
        by: "CAPCOM",
        reason:
          "One keyboard check is still open. Retain the current head and inspect the saved evidence before continuing.",
      },
    };
  if (scenario === "long") {
    view.story.title =
      "Preserve all operator routes and the current-head review evidence while making the Agent page answer visible. ".repeat(
        6,
      );
    view.story.report =
      "The implementation preserves the message draft, account permissions and original evidence links. A concrete keyboard check remains before the next decision. ".repeat(
        20,
      );
    if (view.nextMove)
      view.nextMove.text =
        "Inspect the recorded failure and verify keyboard access through every action before requesting a new review. ".repeat(
          8,
        );
    view.awaiting.reason =
      "The current head has a held review with a detailed recovery step. ".repeat(12);
  }
  if (scenario === "many") {
    view.deliverables = Array.from({ length: 50 }, (_, index) => ({
      id: `file:${index}`,
      kind: "file",
      label: `apps/web/${"operator-route/".repeat(8)}evidence-${index + 1}.tsx`,
      href: `/agent/guido-1?side=files&path=evidence-${index + 1}.tsx`,
    }));
    view.related = Array.from({ length: 50 }, (_, index) => ({
      id: `review:${index}`,
      kind: "review",
      title: `Recorded review ${index + 1}`,
      status: "Previous review",
      href: `/agent/guido-1?trace=previous-${index + 1}`,
      detail: "Historical evidence; not a verdict on the current head.",
    }));
  }
  const rows =
    scenario === "empty" ? [] : [view.row, ...fixture.rows.filter((row) => row.id !== view.row.id)];
  const api = {
    ...fixture.api,
    [RESOURCES.guardHits.path]: {
      hits: [],
      counts: Object.fromEntries(Object.keys(GUARD_RULES).map((key) => [key, 0])),
    },
    "/api/crew?shape=summary": { rows, firstRunToday: null },
    [RESOURCES.agentDetail(view.row.id).path]: view,
    [RESOURCES.stream(view.row.id).path]: {
      runId: view.row.run?.id,
      events: view.row.run
        ? [
            {
              id: "agent:1",
              at: NOW - 60_000,
              kind: "op",
              text: "Keep the answer visible and preserve every existing action.",
            },
            {
              id: "agent:2",
              at: NOW,
              kind: "msg",
              text: "The change is ready for the remaining keyboard check. The current review is held until that evidence is recorded.",
            },
          ]
        : [],
      tasks: [],
      truncated: false,
      more: false,
    },
    [RESOURCES.runHandoff(view.row.run?.id ?? "r-12").path]: null,
    [RESOURCES.runLoop(view.row.run?.id ?? "r-12").path]: {
      loop: {
        phase: "parked",
        parked: { kind: "review", reason: "Keyboard check remains", ended: false },
      },
    },
    [RESOURCES.runs(view.row.id).path]: [],
    [RESOURCES.files(view.row.id).path]: { files: [], note: null },
    [RESOURCES.focus(view.row.id).path]: { focus: null },
  };
  return { view, rows, api };
}
