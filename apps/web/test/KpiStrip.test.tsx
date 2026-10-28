import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hub } from "../src/data.ts";
import { KpiStrip } from "../src/overview/KpiStrip.tsx";
import { SESSION_ALL, setSession } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";
import { HOUR, item, NOW, OVERVIEW } from "./fixtures.ts";

const kpis = OVERVIEW.kpis;

describe("KpiStrip", () => {
  it("shows neutral skeletons until the first response, then renders zeros and flat sparklines", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = stubFetch({
      "/api/overview": {
        ...OVERVIEW,
        kpis: {
          ...kpis,
          working: { now: 0, of: 5, series: [0, 0, 0] },
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
    expect(await screen.findByText("$0.00")).toBeTruthy();
    expect(
      within(screen.getByRole("link", { name: /Agents working/ })).getByText("0"),
    ).toBeTruthy();
    expect(container.querySelectorAll(".kpi-skeleton")).toHaveLength(0);
    // an all-zero series is the bare baseline (y 23 of 24), labelled as no activity
    const graph = screen.getByRole("img", {
      name: "Agents working · last 30 minutes · no activity",
    });
    expect(graph.querySelector('path[fill="none"]')?.getAttribute("d")).toBe(
      "M0.0,23.0L50.0,23.0L100.0,23.0",
    );
    expect(graph.querySelectorAll("circle")).toHaveLength(0);
    expect(
      within(screen.getByRole("link", { name: /Agents working/ })).getByText("no activity"),
    ).toBeTruthy();
  });

  it("formats eight linked metrics and labels the available histories honestly", async () => {
    stubFetch({
      "/api/overview": {
        at: OVERVIEW.at,
        kpis: {
          ...kpis,
          working: { ...kpis.working, series: undefined },
          inFlight: { count: 4, oldestAt: OVERVIEW.at - 120_000 },
        },
      },
      // the tile counts the header's Needs-you set: one per key, the operator's, never by session
      "/api/attention": [
        item({ key: "a", at: NOW - 2 * HOUR }),
        item({ key: "a", at: NOW - 2 * HOUR }),
        item({ key: "b", at: NOW - 60_000 }),
        item({ key: "c", owner: "flight" }),
      ],
    });
    render(<KpiStrip />);
    await screen.findByText("41.2k");
    const labels = [
      "Agents working",
      "Tokens/min",
      "Spend today",
      "In flight",
      "Merged today",
      "CI pass rate",
      "Cycle time",
      "Needs you",
    ];
    const paths = [
      "/agent",
      "/telemetry",
      "/telemetry",
      "/board",
      "/board",
      "/board",
      "/board",
      // Needs you's home (FLIGHT › Plan › Operator actions until #766)
      "/flight#askP",
    ];
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Needs you/ }).querySelector(".v")?.textContent).toBe(
        "2",
      ),
    );
    labels.forEach((label, i) => {
      expect(screen.getByRole("link", { name: new RegExp(label) }).getAttribute("href")).toBe(
        paths[i],
      );
    });
    for (const text of [
      "$24.31",
      "1h 12m",
      "92%",
      "10 runs · 1 red now",
      "of 5 agents",
      "1 over 1 h",
    ])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /last 30 minutes/ })).toHaveLength(1);
    expect(screen.queryAllByRole("img", { name: /hourly today/ })).toHaveLength(0);
    for (const label of ["Spend today", "Merged today"]) {
      expect(
        screen.getByRole("link", { name: new RegExp(label) }).querySelector(".kpi-secondary")
          ?.textContent,
      ).toBe("—");
    }
    expect(screen.getByText("n=8 · 1h 30m avg (14d)")).toBeTruthy();
    for (const label of ["In flight", "CI pass rate", "Cycle time", "Needs you"]) {
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
        cycleTime: { medianMs: null, n: 0, avg14dMs: null },
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
      "/api/overview": {
        ...OVERVIEW,
        kpis: { ...kpis, spendToday: { usd: 0.4, perHour: [0.4], series: [0, 0.2, 0.4] } },
      },
    });
    render(<KpiStrip />);
    const tile = await screen.findByRole("link", { name: /Spend today/ });
    await waitFor(() => expect(tile.querySelector(".kpi-peak")?.textContent).toBe("$0.40"));
    expect(tile.querySelector(".kpi-peak")?.getAttribute("title")).toBe(
      "Peak in the last 30 minutes",
    );
  });

  it("shows eight empty values when the endpoint is unavailable", async () => {
    stubFetch({ "/api/overview": () => ({ status: 503, body: {} }) });
    const { container } = render(<KpiStrip />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe("Could not load overview metrics.");
    await waitFor(() => expect(container.querySelectorAll(".overview-kpi .v")).toHaveLength(8));
    expect([...container.querySelectorAll(".overview-kpi .v")].map((el) => el.textContent)).toEqual(
      Array(8).fill("—"),
    );
  });

  it("keeps cached values marked stale after a failed refresh and clears the warning on recovery", async () => {
    const at = new Date("2026-10-24T10:25:00Z").getTime();
    let failed = false;
    stubFetch({
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
    expect(screen.getByText("$24.31")).toBeTruthy();
    failed = false;
    act(() => hub.refetchTopic("agents"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("41.2k")).toBeTruthy();
  });

  it("under a session, the Needs-you tile drops the session-scoped history and keeps canonical figures", async () => {
    const withHistory = {
      ...OVERVIEW,
      kpis: { ...kpis, needsYou: { count: 0, overHour: 0, series: [4, 0, 0] } },
    };
    stubFetch({
      "/api/overview": withHistory,
      "/api/overview?session=s1": withHistory,
      "/api/attention": [item({ key: "a", at: NOW - 2 * HOUR }), item({ key: "b", at: NOW })],
    });
    render(<KpiStrip />);
    const tile = () => screen.getByRole("link", { name: /Needs you/ });
    await waitFor(() => expect(within(tile()).queryByRole("img")).not.toBeNull());
    act(() => setSession("s1"));
    await waitFor(() => expect(within(tile()).queryByRole("img")).toBeNull());
    expect(tile().querySelector(".v")?.textContent).toBe("2");
    expect(tile().querySelector(".kpi-secondary")?.textContent).toBe("1 over 1 h");
    act(() => setSession(SESSION_ALL));
  });
});
