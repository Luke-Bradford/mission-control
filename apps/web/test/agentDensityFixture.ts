import {
  type ConfigView,
  type CrewChanges,
  GUARD_RULES,
  type RunLoopView,
  type RunView,
} from "@mc/core";
import { RESOURCES } from "../src/data.ts";
import { agentView, populatedAgentView } from "./agentV2Fixture.ts";
import { type DesktopScenario, desktopFixture } from "./desktopFixtures.ts";
import { CREW_CONFIG, NOW, run, seatRow } from "./fixtures.ts";

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
  const crewConfig = CREW_CONFIG.crew;
  if (!crewConfig) throw new Error("The Agent density fixture needs a configured crew");
  for (const [index, row] of rows.entries()) {
    row.area = [`fixture-seat-${index + 1}/**`];
    row.model = row.run?.model ?? row.model ?? "sonnet";
    if (row !== view.row && row.run) row.run = { ...row.run, id: `fixture-run-${row.id}` };
  }
  const seats = rows.map((row) => ({
    id: row.id,
    role: row.role ?? "GUIDO",
    mode: row.mode ?? "writer",
    accountId: row.accountId,
    model: row.model ?? "sonnet",
    area: row.area,
  }));
  const config: ConfigView = {
    ...CREW_CONFIG,
    operator: { id: "operator", timezone: "UTC" },
    crew: {
      ...crewConfig,
      sessions: [{ id: "s1", repoId: "shop-app", checkout: "/mc/clone", seats }],
    },
  };
  const changes: CrewChanges = {
    sessions: [{ id: "s1", seats: seats.map(({ mode: _mode, ...seat }) => seat) }],
    pending: [],
    restartNeeded: [],
    error: null,
    checkedAt: NOW,
  };
  const loopView: RunLoopView = {
    runId: view.row.run?.id ?? "r-12",
    startedAt: view.row.run?.startedAt,
    endedAt: view.row.run?.endedAt,
    loop: view.row.loop
      ? {
          phase: "parked",
          reportedEvidenceId: 1,
          prNumber: 77,
          pushStartedAt: NOW - 300000,
          pushFor: "a".repeat(40),
          unparkedAt: null,
          ciFails: 1,
          ciFailedSha: "a".repeat(40),
          relayedSha: null,
          transient: 0,
          lastRefusal: null,
          epoch: 1,
          budgetExtra: 0,
          parked: { kind: "review", reason: "Keyboard check remains", ended: false },
          touches: null,
          cardFor: null,
          mergeHold: { by: "CAPCOM", reason: "Keyboard check remains", at: NOW - 300000 },
        }
      : null,
    events: [],
    tries: [],
    round: view.row.loop ? 2 : null,
    budget: null,
    review: null,
  };
  const savedRuns = (row: typeof view.row): RunView[] =>
    row.run
      ? [
          {
            ...run({
              ...row.run,
              agentId: row.id,
              repoId: row.repoId,
              sessionId: row.sessionId ?? "s1",
              ticket: row.ticket,
              summary: row.summary,
            }),
            prs: [],
            ticketTitle: row.ticketTitle,
          },
        ]
      : [];
  const api: Record<string, unknown> = {
    ...fixture.api,
    "/api/config": config,
    "/api/crew/changes": changes,
    "/api/crew/sessions": [
      {
        id: "s1",
        readable: true,
        folders: rows.map((row, index) => ({
          name: `fixture-seat-${index + 1}`,
          owners: [row.id],
        })),
      },
    ],
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
    [RESOURCES.runLoop(view.row.run?.id ?? "r-12").path]: loopView,
    [RESOURCES.runs(view.row.id).path]: savedRuns(view.row),
    [RESOURCES.files(view.row.id).path]: { files: [], note: null },
    [RESOURCES.focus(view.row.id).path]: { focus: null },
  };
  for (const row of rows)
    if (row !== view.row) {
      api[RESOURCES.agentDetail(row.id).path] = agentView(row);
      api[RESOURCES.stream(row.id).path] = {
        runId: row.run?.id ?? null,
        events: [],
        tasks: [],
        more: false,
        truncated: false,
      };
      api[RESOURCES.focus(row.id).path] = { focus: null };
      api[RESOURCES.runs(row.id).path] = savedRuns(row);
      api[RESOURCES.files(row.id).path] = { files: [], note: null };
      if (row.run) api[RESOURCES.runHandoff(row.run.id).path] = null;
    }
  return { view, rows, api };
}
