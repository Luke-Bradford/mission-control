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
          title: "Cache the quote total at checkout",
          size: "S",
          readyAt: NOW - 3 * DAY,
          startedAt: NOW - 3 * DAY,
          mergedAt: NOW - 2 * DAY,
          doneAt: NOW - 2 * DAY + HOUR,
        },
        {
          ticket: "shop#13",
          title: null,
          size: null,
          readyAt: NOW - 2 * DAY,
          startedAt: null,
          mergedAt: NOW - DAY,
          doneAt: NOW - DAY + HOUR,
        },
        {
          ticket: "shop#11",
          title: "Keep ticket history for fourteen days",
          size: "M",
          readyAt: NOW - 11 * DAY,
          startedAt: null,
          mergedAt: NOW - 10 * DAY,
          doneAt: NOW - 10 * DAY + HOUR,
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
  it("uses the server's 14-day ticket series whatever range Crew last used", async () => {
    const fetch = await open(tel());
    expect(fetch).toHaveBeenCalledWith("/api/telemetry?range=7d", expect.anything());
    expect(panel("tCycleTicket").querySelectorAll("svg circle.dot")).toHaveLength(3);
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

  it("compares four repository weeks with the configured loop baseline", async () => {
    await open(
      tel({
        repoWeeks: [
          {
            repoId: "mission-control",
            baseline: {
              mergedPrsPerWeek: { min: 88, max: 88 },
              tokensPerWeek: { min: 1_500_000_000, max: 1_500_000_000 },
            },
            weeks: [
              {
                week: "2026-11-02",
                mergedPrs: 101,
                tokensPerMergedPr: { claude: 20_000_000, codex: 9_000_000 },
                reviewRoundsPerPr: 1.4,
                medianReadyToMergeHours: 6.5,
                noSeatWorkingHours: 2,
              },
              {
                week: "2026-11-09",
                mergedPrs: 0,
                tokensPerMergedPr: { claude: null, codex: null },
                reviewRoundsPerPr: null,
                medianReadyToMergeHours: null,
                noSeatWorkingHours: null,
              },
            ],
          },
          {
            repoId: "autonomy-engine",
            baseline: {
              mergedPrsPerWeek: { min: 76, max: 100 },
              tokensPerWeek: { min: 1_300_000_000, max: 1_700_000_000 },
            },
            weeks: [],
          },
          {
            repoId: "eBull",
            baseline: {
              mergedPrsPerWeek: { min: 97, max: 161 },
              tokensPerWeek: { min: 1_500_000_000, max: 2_000_000_000 },
            },
            weeks: [],
          },
          { repoId: "unbaselined", baseline: null, weeks: [] },
        ],
      }),
      "?tab=throughput&view=table",
    );
    const scoreboard = panel("tRepoScoreboard");
    expect(scoreboard.textContent).toContain("Repository throughput");
    expect(scoreboard.textContent).toContain("mission-control");
    expect(scoreboard.textContent).toContain("101");
    expect(scoreboard.textContent).toContain("29M total");
    expect(scoreboard.textContent).toContain("Claude 20M");
    expect(scoreboard.textContent).toContain("Codex 9M");
    expect(scoreboard.textContent).toContain("1.4");
    expect(scoreboard.textContent).toContain("6.5 h");
    expect(scoreboard.textContent).toContain("2 h");
    expect(scoreboard.textContent).toContain("88 PRs/wk · 1.5B tokens/wk");
    expect(scoreboard.textContent).toContain("76–100 PRs/wk · 1.3–1.7B tokens/wk");
    expect(scoreboard.textContent).toContain("97–161 PRs/wk · 1.5–2B tokens/wk");
    expect(scoreboard.textContent).toContain("4 repositories · scroll to compare all");
    expect(scoreboard.textContent).toContain("No merged PRs");
    expect(scoreboard.textContent).toContain("Baseline not configured");
    const summary = scoreboard.querySelector(".repo-scoreboard-repo > summary") as HTMLElement;
    summary.focus();
    expect(document.activeElement).toBe(summary);
  });

  it("explains an empty repository comparison and keeps many repositories in the scroll region", async () => {
    await open(tel({ repoWeeks: [] }), "?tab=throughput&view=table");
    expect(panel("tRepoScoreboard").textContent).toContain(
      "No repository telemetry is configured yet.",
    );
    cleanup();

    await open(
      tel({
        repoWeeks: Array.from({ length: 12 }, (_, index) => ({
          repoId: `crew-repo-${index + 1}`,
          baseline: {
            mergedPrsPerWeek: { min: 88, max: 88 },
            tokensPerWeek: { min: 1_500_000_000, max: 1_500_000_000 },
          },
          weeks: [
            {
              week: "2026-11-02",
              mergedPrs: 1,
              tokensPerMergedPr: { claude: 29_000_000, codex: null },
              reviewRoundsPerPr: 1,
              medianReadyToMergeHours: 1,
              noSeatWorkingHours: 0,
            },
          ],
        })),
      }),
      "?tab=throughput&view=table",
    );
    const scoreboard = panel("tRepoScoreboard");
    expect(scoreboard.querySelectorAll(".repo-scoreboard-repo")).toHaveLength(12);
    expect(scoreboard.querySelector(".repo-scoreboard-scroll")).toBeTruthy();
    expect(scoreboard.textContent).toContain("crew-repo-12");
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

  it("plots every finished ticket in the server's 14-day series, with p50 and p85 lines", async () => {
    await open(tel());
    const cycle = panel("tCycleTicket");
    expect(within(cycle).getByText(/last 14 days/)).toBeTruthy();
    expect(cycle.querySelectorAll("svg circle.dot")).toHaveLength(3);
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
    expect(panel("tCycleTicket").textContent).toContain("not available for the last 14 days yet.");
    expect(panel("tWip").textContent).toContain("Not collected yet.");
    expect(panel("tCycleTicket").querySelector("svg")).toBeNull();
  });

  it("derives cycle time by size from the ticket series", async () => {
    await open(tel());
    const size = panel("tCycleSize");
    const rows = [...size.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows.find((row) => row?.includes("S · 1 ticket"))).toContain("p50 25 h");
    expect(rows.find((row) => row?.includes("M · 1 ticket"))).toContain("p50 25 h");
    expect(rows.find((row) => row?.includes("no size · 1 ticket"))).toContain("p50 25 h");
    expect(size.querySelectorAll(".rng")).toHaveLength(0);
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

  it("shows ticket titles and sizes, with plain placeholders when the board omits either", async () => {
    const base = tel();
    await open(
      {
        ...base,
        series: {
          ...(base.series as object),
          tickets: (base.series?.tickets ?? []) as NonNullable<TelemetryData["series"]>["tickets"],
        } as never,
      },
      "?tab=throughput&view=table",
    );
    const table = within(panel("tTickets")).getByRole("table");
    expect([...table.querySelectorAll("th")].map((h) => h.textContent)).toEqual([
      "Ticket",
      "Title",
      "Size",
      "Merged",
      "Cycle",
      "~Cost",
    ]);
    // Rows come newest merge first: the table and its subtitle say so.
    expect(
      [...table.querySelectorAll("th[aria-sort]")].map((h) => [
        h.textContent,
        h.getAttribute("aria-sort"),
      ]),
    ).toEqual([["Merged", "descending"]]);
    expect(panel("tTickets").textContent).toContain("newest first");
    const rows = table.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("shop#13");
    expect(rows[0]?.textContent).toContain("Title not on board");
    expect(rows[0]?.textContent).toContain("—");
    expect(rows[1]?.textContent).toContain("shop#12");
    expect(rows[1]?.textContent).toContain("Cache the quote total at checkout");
    expect(rows[1]?.textContent).toContain("S");
    expect(rows[1]?.textContent).toContain("25 h");
    expect(rows[1]?.textContent).toContain("~$18.60");
    expect(rows[2]?.textContent).toContain("shop#11");
    expect(panel("tTickets").textContent).not.toMatch(/not shown yet|not in the payload/);
    expect(document.getElementById("tMerged")).toBeNull();
  });

  it("switches from charts to the table with the View control", async () => {
    await open(tel());
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(panel("tTickets")).toBeTruthy();
  });
});
