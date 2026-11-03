import { metricHover } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { hub } from "../src/data.ts";
import { KpiStrip } from "../src/overview/KpiStrip.tsx";
import { type History, OverviewHistoryPanel } from "../src/overview/OverviewHistoryPanel.tsx";
import { SESSION_ALL, setSession } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, HOUR, item, METRICS_VIEW, NOW, OVERVIEW, REGISTRY_ROUTES } from "./fixtures.ts";

const kpis = OVERVIEW.kpis;

/** The KPI action selects the same cached canonical history used by Overview. */
function KpiHistory() {
  const [measure, setMeasure] = useState<History>("tokens");
  return (
    <>
      <KpiStrip onHistory={setMeasure} />
      <OverviewHistoryPanel measure={measure} />
    </>
  );
}

describe("KpiStrip", () => {
  it("shows neutral skeletons until the first response, then retains zeros in the canonical history", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = stubFetch({
      ...REGISTRY_ROUTES,
      "/api/metrics": { ...METRICS_VIEW, cost: { usd: 0 } },
      "/api/crew?shape=summary": { rows: [], firstRunToday: null },
      "/api/overview": {
        ...OVERVIEW,
        kpis: {
          ...kpis,
          inFlight: { count: 0, oldestAt: null, series: [0, 0, 0] },
          spendToday: { usd: 0, perHour: [0, 0, 0] },
        },
      },
    });
    const answer = fetch.getMockImplementation();
    if (!answer) throw new Error("Missing fetch stub");
    fetch.mockImplementation(async (...args) => {
      await ready;
      return answer(...args);
    });
    const { container } = render(<KpiHistory />);
    expect(screen.getByRole("region", { name: "Overview metrics" }).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(container.querySelectorAll(".kpi-skeleton")).toHaveLength(8);
    expect(screen.queryByText("—")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("~$0.00")).toBeTruthy();
    await waitFor(() =>
      expect(
        within(screen.getByRole("link", { name: /Agents working/ })).getByText("0"),
      ).toBeTruthy(),
    );
    await waitFor(() => expect(container.querySelectorAll(".kpi-skeleton")).toHaveLength(0));
    // History leaves the compact tiles, but zero observations remain a labelled flat baseline.
    fireEvent.click(screen.getByRole("button", { name: "Inspect In progress · now history" }));
    const graph = screen.getByRole("img", {
      name: "In-progress tickets · tickets · last 3 complete minutes · missing samples remain gaps",
    });
    expect(graph.querySelector('path[fill="none"]')?.getAttribute("d")).toBe(
      "M0.0,22.0L50.0,22.0L100.0,22.0",
    );
    expect(graph.querySelectorAll("circle")).toHaveLength(0);
    expect(screen.getByText("No activity in the measured minutes.")).toBeTruthy();
    fireEvent.click(screen.getByText("Recorded values · 3 points"));
    expect(
      screen.getByRole("region", { name: "Recorded tickets observations" }).textContent,
    ).toContain("0");
  });

  it("labels eight linked metrics with their windows, registry hover and honest histories", async () => {
    stubFetch({
      ...REGISTRY_ROUTES,
      "/api/overview": {
        at: OVERVIEW.at,
        kpis: { ...kpis, inFlight: { count: 4, oldestAt: OVERVIEW.at - 120_000 } },
      },
      // the tile counts the header's Needs-you set: one per key, the operator's, never by session
      "/api/attention": [
        item({ key: "a", at: NOW - 2 * HOUR }),
        item({ key: "a", at: NOW - 2 * HOUR }),
        item({ key: "b", at: NOW - 60_000 }),
        item({ key: "c", owner: "flight" }),
      ],
    });
    render(<KpiHistory />);
    await screen.findByText("41.2k");
    await screen.findByText("~$24.31");
    const labels = [
      "Agents working · now",
      "Tokens/min · 1m",
      "Cost · today",
      "In progress · now",
      "Merged · 24h",
      "CI pass rate · 24h",
      "Cycle time p50 · 14d",
      "Needs you · now",
    ];
    const paths = [
      "/agent",
      "/telemetry",
      "/telemetry",
      "/board",
      "/board",
      "/board",
      "/telemetry",
      // Needs you's home (FLIGHT › Plan › Operator actions until #766)
      "/flight#askP",
    ];
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Needs you/ }).querySelector(".v")?.textContent).toBe(
        "2",
      ),
    );
    labels.forEach((label, i) => {
      const tile = screen.getByRole("link", { name: new RegExp(label) });
      expect(tile.getAttribute("href")).toBe(paths[i]);
      expect(tile.querySelector(".lbl")?.textContent).toBe(label);
    });
    // a registry label carries its definition on hover
    expect(
      screen
        .getByRole("link", { name: /Merged · 24h/ })
        .querySelector(".lbl")
        ?.getAttribute("title"),
    ).toBe(metricHover("merged"));
    await screen.findByText("of 6 agents");
    for (const text of [
      "2m oldest",
      "92%",
      "10 runs · 1 red now",
      "1.2 h",
      "p85 30 h · 8 tickets · 1 left out",
      "PRs · +2 loops",
    ])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /complete minutes/ })).toHaveLength(1);
    for (const label of ["In progress", "CI pass rate", "Cycle time", "Merged", "Agents working"]) {
      const tile = screen.getByRole("link", { name: new RegExp(label) });
      expect(within(tile).queryByRole("img")).toBeNull();
      expect(tile.querySelector(".kpi-secondary")?.textContent).not.toBe("—");
    }
    for (const graph of screen.getAllByRole("img")) {
      expect(graph.getAttribute("preserveAspectRatio")).toBe("none");
    }
  });

  it("shows dashes for unavailable values, preserves zero and follows session and SSE changes", async () => {
    let data = {
      kpis: {
        ...kpis,
        ciPassRate24h: { pct: null, runs: 0, redNow: 0 },
        tokensPerMin: { now: 0, series: [] },
      },
    };
    stubFetch({ "/api/overview?session=s1": () => ({ status: 200, body: data }) });
    setSession("s1");
    render(<KpiStrip />);
    await screen.findByText("0 runs · 0 red now");
    expect(
      within(screen.getByRole("link", { name: /CI pass rate/ })).getAllByText("—").length,
    ).toBeGreaterThan(0);
    expect(
      within(screen.getByRole("link", { name: /Cycle time/ })).getAllByText("—").length,
    ).toBeGreaterThan(0);
    expect(within(screen.getByRole("link", { name: /Tokens\/min/ })).getByText("0")).toBeTruthy();
    data = { ...data, kpis: { ...data.kpis, tokensPerMin: { now: 1000, series: [] } } };
    act(() => hub.refetchTopic("agents"));
    await screen.findByText("1.0k");
  });

  it("labels a sub-unit minute peak accurately in the canonical history", async () => {
    stubFetch({
      ...REGISTRY_ROUTES,
      "/api/overview": {
        ...OVERVIEW,
        kpis: { ...kpis, spendToday: { usd: 0.4, perHour: [900], series: [0, 0.2, 0.4] } },
      },
    });
    render(<KpiHistory />);
    const tile = await screen.findByRole("link", { name: /Cost · today/ });
    await waitFor(() => expect(within(tile).getByText("+$0.40 · 30m")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Inspect Cost · today history" }));
    expect(screen.getByText("Peak ~$0.4")).toBeTruthy();
    expect(screen.getByText("Latest ~$0.4 USD/min")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Cost per minute · USD\/min/ })).toBeTruthy();
    // Neither the hourly900 nor a scale floor of1 can stand in for the measured0.4 peak.
    expect(screen.queryByText("Peak ~$1")).toBeNull();
  });

  it.each([
    ["rises", [0, 0.2, 0.4], [60, 62, 65], "+$0.40 · 30m", "+5 pp · 30m"],
    ["falls", [0.46, 0.2, 0.4], [65, 62, 60], "−$0.06 · 30m", "−5 pp · 30m"],
    ["is flat", [0.4, 0.2, 0.4], [60, 70, 60], "±$0.00 · 30m", "±0 pp · 30m"],
    [
      "moves less than a cent or a point",
      [0.4, 0.2, 0.396],
      [60, 70, 59.6],
      "±$0.00 · 30m",
      "±0 pp · 30m",
    ],
  ])(
    "signs the cost and CI changes once when the series %s",
    async (_, cost, ci, costText, ciText) => {
      stubFetch({
        ...REGISTRY_ROUTES,
        "/api/overview": {
          ...OVERVIEW,
          kpis: {
            ...kpis,
            spendToday: { usd: 0.4, perHour: [0.4], series: cost },
            ciPassRate24h: { pct: 60, runs: 10, redNow: 1, series: ci },
          },
        },
      });
      render(<KpiStrip />);
      const costTile = await screen.findByRole("link", { name: /Cost · today/ });
      const ciTile = screen.getByRole("link", { name: /CI pass rate/ });
      await waitFor(() => expect(within(costTile).getByText(costText)).toBeTruthy());
      expect(within(ciTile).getByText(ciText)).toBeTruthy();
      expect(costTile.textContent).not.toMatch(/[+−±]~|~[+−±]/);
    },
  );

  it("shows eight empty values when the endpoints are unavailable, and says both failed", async () => {
    stubFetch({
      "/api/overview": () => ({ status: 503, body: {} }),
      "/api/metrics": () => ({ status: 503, body: { error: "metrics down" } }),
    });
    const { container } = render(<KpiStrip />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Could not load overview metrics. Registry figures could not load: metrics down",
      ),
    );
    await waitFor(() => expect(container.querySelectorAll(".overview-kpi .v")).toHaveLength(8));
    expect([...container.querySelectorAll(".overview-kpi .v")].map((el) => el.textContent)).toEqual(
      Array(8).fill("—"),
    );
    // a failed source is not "loading": no skeleton, and the figure's hover says why
    expect(container.querySelectorAll(".kpi-skeleton")).toHaveLength(0);
    expect(
      container.querySelector('[data-metric="merged"]')?.getAttribute("title")?.split("\n")[0],
    ).toBe("Could not load: metrics down");
  });

  it("keeps cached values marked stale after a failed refresh and clears the warning on recovery", async () => {
    const at = new Date("2026-10-24T10:25:00Z").getTime();
    let failed = false;
    stubFetch({
      ...REGISTRY_ROUTES,
      "/api/config": CONFIG,
      "/api/overview": () => ({
        status: failed ? 503 : 200,
        body: failed ? {} : { at, kpis },
      }),
    });
    render(<KpiHistory />);
    await screen.findByText("41.2k");
    expect(screen.queryByRole("alert")).toBeNull();
    const graph = screen.getByRole("img", { name: /Token throughput.*complete minutes/ });
    const readings = graph.querySelector("path")?.getAttribute("d");
    expect(readings).toBeTruthy();
    failed = true;
    act(() => hub.refetchTopic("agents"));
    const warning = await screen.findByRole("alert");
    // Completed-minute observations stay available with an explicit stale history warning.
    expect(screen.getByRole("status").textContent).toBe(
      "History refresh failed. Showing the last received minutes.",
    );
    expect(graph.querySelector("path")?.getAttribute("d")).toBe(readings);
    expect(graph.getAttribute("aria-label")).not.toMatch(/live|now/);
    expect(warning.textContent).toBe("Last updated 11:25 · refresh failed. Showing stale values.");
    expect(screen.getByText("41.2k")).toBeTruthy();
    failed = false;
    act(() => hub.refetchTopic("agents"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen
        .getByRole("img", { name: /Token throughput/ })
        .querySelector("path")
        ?.getAttribute("d"),
    ).toBe(readings);
    expect(screen.getByText("41.2k")).toBeTruthy();
  });

  it("under a session, Needs you stays the whole inbox and keeps its history", async () => {
    // The server's Needs-you history is the whole inbox in every scope (#762), so it agrees with
    // the count under a session and the trace stays.
    const withHistory = {
      ...OVERVIEW,
      kpis: { ...kpis, needsYou: { count: 0, overHour: 0, series: [4, 0, 2] } },
    };
    stubFetch({
      "/api/overview": withHistory,
      "/api/overview?session=s1": withHistory,
      "/api/attention": [item({ key: "a", at: NOW - 2 * HOUR }), item({ key: "b", at: NOW })],
    });
    render(<KpiHistory />);
    const tile = () => screen.getByRole("link", { name: /Needs you/ });
    await waitFor(() => expect(tile().querySelector(".v")?.textContent).toBe("2"));
    fireEvent.click(screen.getByRole("button", { name: "Inspect Needs you · now history" }));
    const history = () => screen.getByRole("img", { name: /Needs you · global inbox/ });
    const trace = history().querySelector("path")?.getAttribute("d");
    expect(trace).toBe("M0.0,3.0L50.0,22.0L100.0,12.5");
    act(() => setSession("s1"));
    await waitFor(() => expect(tile().querySelector(".v")?.textContent).toBe("2"));
    expect(history().querySelector("path")?.getAttribute("d")).toBe(trace);
    fireEvent.click(screen.getByText("Recorded values · 3 points"));
    const values = screen.getByRole("region", { name: "Recorded items observations" });
    expect(
      [...values.querySelectorAll("tbody tr td:last-child")].map((cell) => cell.textContent),
    ).toEqual(["4", "0", "2"]);
    act(() => setSession(SESSION_ALL));
  });
});
