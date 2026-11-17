import type { ConfigView, Telemetry as TelemetryData } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamStatus } from "../src/data.ts";
import { Telemetry } from "../src/pages/Telemetry.tsx";
import { navigate } from "../src/router.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, crewRow, HOUR, METRICS_VIEW, NOW } from "./fixtures.ts";

const DAY = 24 * HOUR;
const MERGED = [3, 5, 6, 7, 8, 4, 2, 6, 8, 9, 7, 10, 6, 7];
const days = Array.from({ length: 14 }, (_, i) => `2026-10-${String(4 + i).padStart(2, "0")}`);
const CFG: ConfigView = { ...CONFIG };

function tel(over: Partial<TelemetryData> = {}): TelemetryData {
  return {
    today: { tokens: 1, cacheRead: 0, costUsd: 1, toolCalls: 1, turns: 1, working: 1, agents: 1 },
    throughput: days.map((day, i) => ({ day, merged: MERGED[i] as number })),
    cycleTime: {
      rows: [
        { size: "S", p50Ms: 4 * HOUR, p85Ms: 9 * HOUR, tickets: 6 },
        { size: "M", p50Ms: 14 * HOUR, p85Ms: 31 * HOUR, tickets: 8 },
        { size: "L", p50Ms: 20 * HOUR, p85Ms: null, tickets: 2 },
        { size: "XL", p50Ms: null, p85Ms: null, tickets: 0 },
      ],
      excluded: 0,
    },
    quality: { ciGreenFirstPushPct: 80, prs: 10, commitsPerRun: 3.4 },
    tokensPerMinute: [],
    liveMinutes: [],
    utilisation: [],
    turnUsage: [],
    toolLatency: [],
    subagents: [],
    quota: [],
    machine: [],
    tokensByTicket: [{ ticket: "shop#12", tokens: 5, costUsd: 4, totalCostUsd: 18.6 }],
    totals: [],
    series: {
      stateSpans: [],
      quota: [],
      tickets: [
        {
          ticket: "shop#12",
          readyAt: NOW - 3 * DAY,
          startedAt: NOW - 3 * DAY,
          mergedAt: NOW - 2 * DAY,
          doneAt: NOW - 2 * DAY + HOUR,
        },
        {
          ticket: "shop#13",
          readyAt: NOW - 2 * DAY,
          startedAt: null,
          mergedAt: NOW - DAY,
          doneAt: NOW - DAY + HOUR,
        },
        { ticket: "shop#14", readyAt: NOW - DAY, startedAt: null, mergedAt: null, doneAt: null },
      ],
      ticketsInProgress: days.map((day, i) => ({
        day,
        tickets: i < 3 ? null : i === 13 ? 4 : 2,
      })),
      annotations: [],
    },
    ...over,
  };
}

async function open(
  data: TelemetryData,
  search = "?tab=throughput",
  extra: Record<string, unknown> = {},
) {
  window.history.replaceState(null, "", `/telemetry${search}`);
  const routes: Record<string, unknown> = {
    "/api/config": CFG,
    "/api/metrics": METRICS_VIEW,
    "/api/attention": [],
    "/api/machine": {
      latest: null,
      warning: null,
      maxSeats: 1,
      seats: 1,
      perSessionMax: 1,
      transcripts: null,
    },
    "/api/crew?shape=summary": { rows: [crewRow({ id: "studio" })], firstRunToday: null },
  };
  routes["/api/telemetry?range=7d"] = data;
  routes["/api/telemetry?range=24h"] = {
    ...data,
    series: { ...(data.series as object), tickets: [] } as never,
  };
  Object.assign(routes, extra);
  const fetch = stubFetch(routes);
  render(<Telemetry />);
  await waitFor(() =>
    expect(document.getElementById("telemetry-tabpanel")?.getAttribute("aria-busy")).toBe("false"),
  );
  return fetch;
}

const panel = (id: string) => document.getElementById(id) as HTMLElement;
const stat = (label: string, window: string) =>
  [...document.querySelectorAll(".summary .stat")].find(
    (s) =>
      s.querySelector(".stat-label")?.textContent === label &&
      s.querySelector(".stat-window")?.textContent === window,
  ) as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  streamStatus.set({ connected: false, reconnecting: false, lastMessageAt: null });
});

describe("Telemetry, Throughput tab", () => {
  it("loads the 7-day per-ticket series whatever range Crew last used", async () => {
    const fetch = await open(tel());
    expect(fetch).toHaveBeenCalledWith("/api/telemetry?range=7d", expect.anything());
    expect(panel("tCycleTicket").querySelectorAll("svg circle.dot")).toHaveLength(2);
  });

  it("drops a hidden Crew agent filter before loading the unscoped Throughput table", async () => {
    const unscoped = tel();
    const scoped = {
      ...unscoped,
      tokensByTicket: [{ ticket: "shop#12", tokens: 5, costUsd: 1, totalCostUsd: 1 }],
    };
    const fetch = await open(unscoped, "?tab=crew", {
      "/api/telemetry?range=24h": unscoped,
      "/api/telemetry?range=24h&agent=shop-app-ta": scoped,
    });
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "shop-app-ta" } });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/telemetry?range=24h&agent=shop-app-ta",
        expect.anything(),
      ),
    );
    act(() => navigate("/telemetry?tab=throughput&view=table"));
    await waitFor(() => expect(panel("tTickets")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith("/api/telemetry?range=7d", expect.anything());
    expect(within(panel("tTickets")).getByRole("table").textContent).toContain("~$18.60");
  });

  it("shows the summary row with each figure, unit and window", async () => {
    await open(tel());
    const read = (label: string, window: string) => {
      const s = stat(label, window);
      return [
        s.querySelector(".stat-value")?.textContent,
        s.querySelector(".stat-unit")?.textContent,
      ];
    };
    expect(read("Merged", "today")).toEqual(["7", "PRs"]);
    expect(read("Merged", "14d")).toEqual(["88", "PRs"]);
    expect(read("Cycle time p50", "14d")).toEqual(["1.2", "hours"]);
    expect(read("Cycle time p85", "14d")).toEqual(["30.4", "hours"]);
    expect(read("Tickets in progress", "now")).toEqual(["4", "tickets"]);
    expect(read("Commits per run", "14d")).toEqual(["3.4", "commits"]);
  });

  it("builds the five panels and drops the forecast and the coming note", async () => {
    await open(tel());
    for (const id of ["tMerged", "tCycleTicket", "tCycleSize", "tWip"])
      expect(panel(id), id).toBeTruthy();
    for (const id of ["tForecast", "tFlow", "tCycleControl", "tThru", "tCycle"])
      expect(document.getElementById(id), id).toBeNull();
    expect(screen.queryByText("Throughput is coming")).toBeNull();
    expect(document.querySelectorAll("#tMerged svg rect.bar, #tMerged svg path.bar")).toHaveLength(
      14,
    );
  });

  it("puts the 14-day mean's label in the legend, not on the chart", async () => {
    await open(tel());
    const merged = panel("tMerged");
    expect(merged.querySelector(".legend")?.textContent).toContain("14-day mean 6.3");
    expect(merged.querySelector("svg .guide")).toBeTruthy();
    expect(merged.querySelector("svg")?.textContent).not.toMatch(/mean/i);
  });

  it("plots one dot per finished ticket in the last 7 days, with p50 and p85 lines", async () => {
    await open(tel());
    const cycle = panel("tCycleTicket");
    expect(within(cycle).getByText(/last 7 days/)).toBeTruthy();
    expect(cycle.querySelectorAll("svg circle.dot")).toHaveLength(2);
    expect(cycle.querySelectorAll("svg .cycle-line")).toHaveLength(2);
    expect(cycle.querySelector(".legend")?.textContent).toMatch(/p50/);
    expect(cycle.querySelector(".legend")?.textContent).toMatch(/p85/);
  });

  it("keeps the cycle-time distribution readable when one ticket is an outlier", async () => {
    const regular = Array.from({ length: 20 }, (_, i) => ({
      ticket: `shop#${100 + i}`,
      readyAt: NOW - (i + 1) * HOUR,
      startedAt: null,
      mergedAt: NOW - HOUR,
      doneAt: NOW,
    }));
    const outlier = {
      ticket: "shop#outlier",
      readyAt: NOW - 600 * HOUR,
      startedAt: null,
      mergedAt: NOW - HOUR,
      doneAt: NOW,
    };
    const base = tel();
    await open({
      ...base,
      series: { ...(base.series as object), tickets: [...regular, outlier] } as never,
    });
    const cycle = panel("tCycleTicket");
    const grid = [...cycle.querySelectorAll("svg .gl + text")].map((n) => n.textContent);
    expect(grid).toContain("36 h");
    expect(cycle.querySelectorAll("svg .dot, svg .overflow-dot")).toHaveLength(21);
    expect(cycle.querySelector(".legend")?.textContent).toContain("1 above 36 h");
  });

  it("does not invent per-ticket history when the server sends no series", async () => {
    await open({ ...tel(), series: undefined });
    expect(panel("tCycleTicket").textContent).toContain("not available for the last 7 days yet.");
    expect(panel("tWip").textContent).toContain("Not collected yet.");
    expect(panel("tCycleTicket").querySelector("svg")).toBeNull();
  });

  it("draws cycle time by size as p50 to p85 ranges, and says so for a size with no tickets", async () => {
    await open(tel());
    const size = panel("tCycleSize");
    const rows = [...size.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows[0]).toContain("S");
    expect(rows[0]).toContain("4.0 h–9.0 h");
    expect(rows[2]).toContain("p50 20 h");
    expect(rows[3]).toContain("no tickets");
    expect(size.querySelectorAll(".rng")).toHaveLength(2);
  });

  it("steps through tickets in progress and leaves out the days before collection", async () => {
    await open(tel());
    const label = panel("tWip").querySelector("svg")?.getAttribute("aria-label") ?? "";
    expect(label).toContain("W7 2");
    expect(label).toContain("S17 4");
    for (const before of ["S4", "M5", "T6"]) expect(label).not.toContain(before);
  });

  it("says not collected yet, with no flat zero, when the server sends no per-day series", async () => {
    const base = tel();
    await open({
      ...base,
      series: { ...(base.series as object), ticketsInProgress: undefined } as never,
    });
    expect(within(panel("tWip")).getByText("Not collected yet.")).toBeTruthy();
    expect(panel("tWip").querySelector("svg")).toBeNull();
    expect(stat("Tickets in progress", "now").querySelector(".stat-value")?.textContent).toBe("—");
  });

  it("shows the Tickets table with Ticket, Merged, Cycle and cost, and a note on Title and Size", async () => {
    const base = tel();
    await open(
      {
        ...base,
        series: {
          ...(base.series as object),
          tickets: [
            ...((base.series?.tickets ?? []) as NonNullable<TelemetryData["series"]>["tickets"]),
            {
              ticket: "shop#9",
              readyAt: null,
              startedAt: null,
              mergedAt: NOW - 30 * DAY,
              doneAt: null,
            },
          ],
        } as never,
      },
      "?tab=throughput&view=table",
    );
    const table = within(panel("tTickets")).getByRole("table");
    expect([...table.querySelectorAll("th")].map((h) => h.textContent)).toEqual([
      "Ticket",
      "Merged",
      "Cycle",
      "~Cost",
    ]);
    const rows = table.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(table.textContent).not.toContain("shop#9");
    expect(rows[1]?.textContent).toContain("shop#12");
    expect(rows[1]?.textContent).toContain("25 h");
    expect(rows[1]?.textContent).toContain("~$18.60");
    expect(panel("tTickets").textContent).toMatch(/Title and size are not shown yet/);
    expect(document.getElementById("tMerged")).toBeNull();
  });

  it("switches from charts to the table with the View control", async () => {
    await open(tel());
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(panel("tTickets")).toBeTruthy();
  });
});
