import {
  METRIC_IDS,
  type MetricId,
  metricHover,
  metricLabel,
  type Telemetry as TelemetryData,
} from "@mc/core";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { Comms } from "../src/pages/Comms.tsx";
import { Flight } from "../src/pages/Flight.tsx";
import { Overview } from "../src/pages/Overview.tsx";
import { Telemetry } from "../src/pages/Telemetry.tsx";
import { resetSession } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, NOW, OVERVIEW, REGISTRY_ROUTES } from "./fixtures.ts";

const TELEMETRY: TelemetryData = {
  today: { tokens: 0, cacheRead: 0, costUsd: 99, toolCalls: 0, turns: 0, working: 9, agents: 9 },
  throughput: [],
  cycleTime: { rows: [], excluded: 0 },
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
};

/** What the one fixture reads as, on every page that shows the figure. */
const EXPECTED: Record<MetricId, string> = {
  inProgress: "4",
  blocked: "1",
  merged: "6",
  cycleTime: "1.2 h",
  needsYou: "2",
  agentsLive: "3",
  agentsWorking: "1",
  cost: "~$24.31",
};

/** Where each page shows a figure; every figure appears on at least one. */
const PAGES: { name: string; page: () => ReactElement; shows: MetricId[] }[] = [
  {
    name: "Overview",
    page: () => <Overview />,
    shows: ["agentsWorking", "cost", "inProgress", "merged", "cycleTime", "needsYou"],
  },
  {
    name: "FLIGHT",
    page: () => <Flight />,
    shows: ["inProgress", "blocked", "merged", "cycleTime", "needsYou"],
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

function stub() {
  stubFetch({
    ...REGISTRY_ROUTES,
    "/api/config": CONFIG,
    "/api/overview": {
      ...OVERVIEW,
      kpis: { ...OVERVIEW.kpis, inFlight: { count: 4, oldestAt: null } },
    },
    "/api/telemetry?range=6h": TELEMETRY,
  });
}

afterEach(() => {
  cleanup();
  hub.clear();
  resetSession();
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

describe("the metric registry across pages", () => {
  it("every figure appears somewhere", () => {
    const covered = new Set(PAGES.flatMap((p) => p.shows));
    expect([...covered].sort()).toEqual([...METRIC_IDS].sort());
  });

  it.each(PAGES)(
    "$name renders each registry figure with the one fixture's value",
    async ({ page, shows }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      stub();
      const { container } = render(page());
      await waitFor(() => {
        const figures = shown(container);
        for (const id of shows) expect(figures.get(id), id).toBeDefined();
        for (const [id, values] of figures)
          for (const value of values) expect(value, id).toBe(EXPECTED[id]);
      });
      vi.useRealTimers();
    },
  );

  it("labels carry the registry's window and hover carries its definition", async () => {
    stub();
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
