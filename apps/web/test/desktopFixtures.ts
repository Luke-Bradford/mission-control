import { populatedAgentView } from "./agentV2Fixture.ts";
import {
  boardItem,
  brief,
  CONFIG,
  item,
  METRICS_VIEW,
  NOW,
  OVERVIEW,
  prView,
  REPOS,
  seatRow,
} from "./fixtures.ts";
import { flightSummary } from "./flightSummaryFixture.ts";
import { qaReportApi, qaReportFixture } from "./qaReportFixture.ts";

export type DesktopScenario =
  | "default"
  | "empty"
  | "one"
  | "many"
  | "long"
  | "loading"
  | "error"
  | "stale"
  | "disconnected";
/** Fictional API data used only by production-component browser captures. */
export function desktopFixture(scenario: DesktopScenario = "default") {
  const n = scenario === "empty" ? 0 : scenario === "one" ? 1 : scenario === "many" ? 50 : 11;
  const rows = Array.from({ length: n }, (_, index) =>
    seatRow({
      id: `guido-${index + 1}`,
      index,
      hudState: index % 3 ? "running" : "idle",
      ticket: `shop-app#${101 + index}`,
      ticketTitle:
        scenario === "long"
          ? "A long scope explanation with a concrete next action and its recovery evidence. ".repeat(
              5,
            )
          : `Fictional work ${index + 1}`,
    }),
  );
  const attention = Array.from({ length: scenario === "many" ? 50 : Math.min(n, 3) }, (_, index) =>
    item({
      key: `fixture:${index}`,
      agentId: `guido-${index + 1}`,
      brief: brief(),
      kind: index ? "question" : "decision",
      text:
        scenario === "long"
          ? "The current head needs a concrete rollback decision with its evidence and next owner. ".repeat(
              6,
            )
          : [
              "Choose the cache eviction policy before the next check.",
              "Confirm the recorded rollback evidence.",
              "Clarify the import scope for the waiting developer.",
            ][index % 3],
    }),
  );
  const agent = populatedAgentView();
  const api: Record<string, unknown> = {
    "/api/config": { ...CONFIG, operator: { id: "operator", timezone: "UTC" } },
    "/api/repos": REPOS,
    "/api/metrics": METRICS_VIEW,
    "/api/crew?shape=summary": { rows, firstRunToday: null },
    "/api/agents/guido-1": agent,
    "/api/crew/guido-1": agent.row,
    "/api/attention": attention,
    "/api/escalations": [],
    "/api/overview": OVERVIEW,
    "/api/overview/timeline": { from: NOW - 3600000, to: NOW, lanes: [] },
    "/api/flight": {
      seat: { id: "flight-1", call: "FLIGHT", model: "fixture-model", state: "idle", live: true },
      decisions: [],
    },
    "/api/flight/summary": flightSummary({
      headline:
        scenario === "empty"
          ? ""
          : scenario === "long"
            ? "The reviewed work has a bounded recovery path. ".repeat(12)
            : "Two decisions need your attention. The crew is checking the current work.",
      headlineAgeMin: scenario === "stale" ? 95 : 2,
    }),
    "/api/agents/flight-1/stream?limit=20": {
      events:
        scenario === "many"
          ? Array.from({ length: 20 }, (_, index) => ({
              id: `fixture:${index}`,
              at: NOW - (20 - index) * 10000,
              kind: "msg",
              text: `Recorded fixture message ${index + 1}: the next step is recorded with its evidence and owner.`,
            }))
          : [
              {
                id: "fixture:0",
                at: NOW - 10000,
                kind: "msg",
                text: "The next step is recorded with the current work. Review its evidence before deciding.",
              },
            ],
      hasMore: false,
    },
    "/api/activity": [],
    "/api/health": [],
    "/api/limits": [],
    "/api/limits/github": { queries: {}, pollCost: null },
    "/api/machine": { latest: null, warning: null },
    "/api/test-lock": { holder: null, waiting: [] },
    "/api/crew/status": { enabled: true, note: null },
    "/api/settings/away": { on: false, until: "", may: {} },
    "/api/settings/crew-pause": null,
    "/api/boards/shop-app": n ? [boardItem()] : [],
    "/api/boards/site-builder": [],
    "/api/repos/shop-app/prs?linked=1&shape=summary": n ? [prView()] : [],
    "/api/repos/site-builder/prs?linked=1&shape=summary": [],
    "/api/qa/queue": { prs: [], flightId: "flight-1" },
    "/api/notifications": { open: [], handledToday: [] },
    "/api/settings/notifications": {},
    "/api/crew/changes": { pending: [], error: null, restartNeeded: [] },
    "/api/crew/sessions": [],
    "/api/settings/teams": { sources: [] },
  };
  return { api, attention, rows };
}

/** Filled saved report + current queue; image bytes are deliberately synthetic layout fixtures. */
export function desktopQaFixture() {
  const report = qaReportFixture();
  for (const pair of report.visual.pairs) {
    pair.before.url = `/api/qa-report-assets/${"d".repeat(64)}`;
    pair.after.url = `/api/qa-report-assets/${"e".repeat(64)}`;
  }
  return {
    ...desktopFixture().api,
    ...qaReportApi(),
    [`/api/qa-reports/${report.id}`]: report,
    [`/api/qa-reports?repoId=mission-control&prNumber=1011&headSha=${report.headSha}`]: {
      reports: [report],
    },
    "/api/qa-reports?repoId=mission-control&prNumber=1011": { reports: [report] },
  };
}
