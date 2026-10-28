import { metricHover } from "@mc/core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hub } from "../src/data.ts";
import { KpiStrip } from "../src/overview/KpiStrip.tsx";
import { setSession } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";
import { METRICS_VIEW, OVERVIEW, REGISTRY_ROUTES } from "./fixtures.ts";

const kpis = OVERVIEW.kpis;

describe("KpiStrip", () => {
  it("shows neutral skeletons until the first response, then renders zeros and flat sparklines", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = stubFetch({
      ...REGISTRY_ROUTES,
      "/api/metrics": { ...METRICS_VIEW, cost: { usd: 0 } },
      "/api/crew": { rows: [], firstRunToday: null },
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
    const { container } = render(<KpiStrip />);
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
    // an all-zero series is the bare baseline (y 23 of 24), labelled as no activity
    const graph = screen.getByRole("img", {
      name: "In progress · now · last 30 minutes · no activity",
    });
    expect(graph.querySelector('path[fill="none"]')?.getAttribute("d")).toBe(
      "M0.0,23.0L50.0,23.0L100.0,23.0",
    );
    expect(graph.querySelectorAll("circle")).toHaveLength(0);
    expect(
      within(screen.getByRole("link", { name: /In progress/ })).getByText("no activity"),
    ).toBeTruthy();
  });

  it("labels eight linked metrics with their windows, registry hover and honest histories", async () => {
    stubFetch({
      ...REGISTRY_ROUTES,
      "/api/overview": {
        at: OVERVIEW.at,
        kpis: { ...kpis, inFlight: { count: 4, oldestAt: OVERVIEW.at - 120_000 } },
      },
    });
    render(<KpiStrip />);
    await screen.findByText("41.2k");
    await screen.findByText("~$24.31");
    const labels = [
      "Agents working · now",
      "Tokens/min",
      "Cost · today",
      "In progress · now",
      "Merged · 24h",
      "CI pass rate",
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
      "/comms",
    ];
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
    expect(screen.getAllByRole("img", { name: /last 30 minutes/ })).toHaveLength(1);
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

  it("labels a peak under 1 as itself, not as the scale's floor", async () => {
    stubFetch({
      ...REGISTRY_ROUTES,
      "/api/overview": {
        ...OVERVIEW,
        kpis: { ...kpis, spendToday: { usd: 0.4, perHour: [0.4], series: [0, 0.2, 0.4] } },
      },
    });
    render(<KpiStrip />);
    const tile = await screen.findByRole("link", { name: /Cost · today/ });
    // the trace, its peak and its change wear the value's "~$" (API-equivalent)
    await waitFor(() => expect(tile.querySelector(".kpi-peak")?.textContent).toBe("~$0.40"));
    expect(within(tile).getByText("+~$0.40 · 30m")).toBeTruthy();
    expect(tile.querySelector(".kpi-peak")?.getAttribute("title")).toBe(
      "Peak in the last 30 minutes",
    );
  });

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
      "/api/overview": () => ({
        status: failed ? 503 : 200,
        body: failed ? {} : { at, kpis },
      }),
    });
    render(<KpiStrip />);
    await screen.findByText("41.2k");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelectorAll(".spark-now.live").length).toBeGreaterThan(0);
    failed = true;
    act(() => hub.refetchTopic("agents"));
    const warning = await screen.findByRole("alert");
    // stale values keep their traces, but the now-cursors stop claiming live
    expect(document.querySelectorAll(".spark-now.live")).toHaveLength(0);
    expect(warning.textContent).toBe(
      `Last updated ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · refresh failed. Showing stale values.`,
    );
    expect(screen.getByText("41.2k")).toBeTruthy();
    failed = false;
    act(() => hub.refetchTopic("agents"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("41.2k")).toBeTruthy();
  });
});
