import {
  METRIC_IDS,
  type MetricId,
  type MetricsView,
  metricHover,
  metricLabel,
  type Telemetry as TelemetryData,
} from "@mc/core";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { Comms } from "../src/pages/Comms.tsx";
import { Flight } from "../src/pages/Flight.tsx";
import { Overview } from "../src/pages/Overview.tsx";
import { Telemetry } from "../src/pages/Telemetry.tsx";
import { resetSession, setSession } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";
import {
  CONFIG,
  crewRow,
  item,
  METRICS_VIEW,
  NOW,
  OVERVIEW,
  REGISTRY_ROUTES,
  SESSION_CONFIG,
  seatRow,
} from "./fixtures.ts";
import { flightSummary } from "./flightSummaryFixture.ts";

/**
 * The old per-page sources, each answering something else than the registry: a page that still
 * read one of them would show its number and fail.
 */
const LEGACY = {
  "/api/overview": {
    ...OVERVIEW,
    kpis: {
      ...OVERVIEW.kpis,
      inFlight: { count: 9, oldestAt: null },
      needsYou: { count: 7, overHour: 7 },
      spendToday: { usd: 99, perHour: [99] },
    },
  },
  "/api/flight/summary": flightSummary({
    metrics: { ...flightSummary().metrics, inReview: 9 },
  }),
  "/api/telemetry?range=6h": {
    today: { tokens: 0, cacheRead: 0, costUsd: 99, toolCalls: 0, turns: 0, working: 9, agents: 9 },
    throughput: [],
    cycleTime: { rows: [], excluded: 99 },
    quality: { ciGreenFirstPushPct: null, prs: 0 },
    tokensPerMinute: [],
    liveMinutes: [],
    utilisation: [],
    turnUsage: [],
    toolLatency: [],
    subagents: [],
    quota: [],
    machine: [],
    tokensByTicket: [],
    totals: [],
  } satisfies TelemetryData,
};

/** What the one fixture reads as, on every page that shows the figure. */
const EXPECTED: Record<MetricId, string> = {
  inProgress: "4",
  blocked: "1",
  merged: "6",
  cycleTime: "1.2 h",
  needsYou: "2",
  agentsLive: "2",
  agentsWorking: "1",
  cost: "~$24.31",
};

/** The FLIGHT page opened on the tab a `#fragment` link names. */
function flightAt(hash: string): ReactElement {
  window.history.replaceState(null, "", `/flight${hash}`);
  return <Flight />;
}

/** Where each page shows a figure; every figure appears on at least one. */
const PAGES: { name: string; page: () => ReactElement; shows: MetricId[] }[] = [
  {
    name: "Overview",
    page: () => <Overview />,
    shows: ["agentsWorking", "cost", "inProgress", "merged", "cycleTime", "needsYou"],
  },
  // Only the open tab is mounted, so each tab that shows a figure is opened by its link.
  {
    name: "FLIGHT",
    page: () => flightAt("#askP"),
    shows: ["needsYou"],
  },
  {
    name: "FLIGHT Crew & board",
    page: () => flightAt("#wifP"),
    shows: ["inProgress", "blocked", "needsYou"],
  },
  {
    name: "FLIGHT What FLIGHT did",
    page: () => flightAt("#outcomesP"),
    shows: ["cost", "needsYou"],
  },
  {
    name: "Telemetry",
    page: () => <Telemetry />,
    shows: ["cost", "agentsWorking", "merged", "cycleTime"],
  },
  {
    name: "Comms",
    page: () => <Comms item={null} view={{ kind: "crew" }} />,
    shows: ["agentsLive"],
  },
];

afterEach(() => {
  window.history.replaceState(null, "", "/");
  cleanup();
  hub.clear();
  resetSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The figures a page renders, by registry id. */
const shown = (root: HTMLElement): Map<MetricId, string[]> => {
  const out = new Map<MetricId, string[]>();
  for (const el of root.querySelectorAll<HTMLElement>("[data-metric]")) {
    const id = el.dataset.metric as MetricId;
    out.set(id, [...(out.get(id) ?? []), el.textContent ?? ""]);
  }
  return out;
};

async function expectFigures(
  page: () => ReactElement,
  shows: MetricId[],
  expected: Record<MetricId, string>,
) {
  const { container } = render(page());
  await waitFor(() => {
    const figures = shown(container);
    for (const id of shows) expect(figures.get(id), id).toBeDefined();
    for (const [id, values] of figures)
      for (const value of values) expect(value, id).toBe(expected[id]);
  });
}

describe("the metric registry across pages", () => {
  it("every figure appears somewhere", () => {
    const covered = new Set(PAGES.flatMap((p) => p.shows));
    expect([...covered].sort()).toEqual([...METRIC_IDS].sort());
  });

  it.each(PAGES)(
    "$name renders each registry figure with the one fixture's value, not its old source's",
    async ({ page, shows }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      stubFetch({ ...LEGACY, ...REGISTRY_ROUTES, "/api/config": CONFIG });
      await expectFigures(page, shows, EXPECTED);
    },
  );

  it.each(PAGES)(
    "$name follows the header's session filter the same way",
    async ({ page, shows }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const session: MetricsView = {
        ...METRICS_VIEW,
        inProgress: { count: 1, oldestAt: null },
        merged: { count: 2, loops: 0 },
        cycleTime: { p50Ms: 0.5 * 3_600_000, p85Ms: null, n: 2, excluded: 0 },
        cost: { usd: 3 },
      };
      stubFetch({
        ...LEGACY,
        ...REGISTRY_ROUTES,
        "/api/config": SESSION_CONFIG,
        "/api/overview?session=site-builder-session": LEGACY["/api/overview"],
        "/api/metrics?session=site-builder-session": session,
        "/api/crew?shape=summary": {
          rows: [
            seatRow({ id: "guido-1", sessionId: "shop-app-session", hudState: "blocked" }),
            seatRow({
              id: "guido-2",
              sessionId: "site-builder-session",
              repoId: "site-builder",
              hudState: "running",
            }),
            crewRow({ id: "studio", repoId: "site-builder", hudState: "parked", paused: true }),
          ],
          firstRunToday: null,
        },
        // Needs you is the whole inbox: the session filter does not narrow it.
        "/api/attention": [item(), item({ key: "b", repoId: "site-builder" })],
      });
      act(() => setSession("site-builder-session"));
      await expectFigures(page, shows, {
        inProgress: "1",
        blocked: "0",
        merged: "2",
        cycleTime: "0.5 h",
        needsYou: "2",
        agentsLive: "1",
        agentsWorking: "1",
        cost: "~$3.00",
      });
    },
  );

  it("labels carry the registry's window and hover carries its definition", async () => {
    stubFetch({ ...LEGACY, ...REGISTRY_ROUTES, "/api/config": CONFIG });
    const { container } = render(<Overview />);
    await waitFor(() => expect(shown(container).get("merged")).toEqual(["6"]));
    for (const id of [
      "agentsWorking",
      "cost",
      "inProgress",
      "merged",
      "cycleTime",
      "needsYou",
    ] as const) {
      const label = [...container.querySelectorAll(".overview-kpi .lbl")].find(
        (el) => el.textContent === metricLabel(id),
      );
      expect(label?.getAttribute("title"), id).toBe(metricHover(id));
    }
  });
});
