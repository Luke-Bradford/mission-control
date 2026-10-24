import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hub } from "../src/data.ts";
import { KpiStrip } from "../src/overview/KpiStrip.tsx";
import { setSession } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";
import { OVERVIEW } from "./fixtures.ts";

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
    const line = screen
      .getByRole("img", { name: /Agents working/ })
      .querySelector('path[fill="none"]');
    expect(line?.getAttribute("d")).toBe("M0.0,16.0L26.0,16.0L52.0,16.0");
  });

  it("formats eight linked metrics and labels the available histories honestly", async () => {
    stubFetch({ "/api/overview": { kpis } });
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
      "/comms",
    ];
    labels.forEach((label, i) => {
      expect(screen.getByRole("link", { name: new RegExp(label) }).getAttribute("href")).toBe(
        paths[i],
      );
    });
    for (const text of ["$24.31", "1h 12m", "92%", "1 red now", "of 5 agents", "1 over an hour"])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /last 30 minutes/ })).toHaveLength(2);
    expect(screen.getAllByRole("img", { name: /hourly today/ })).toHaveLength(2);
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
    await screen.findByText("0 red now");
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
    failed = true;
    act(() => hub.refetchTopic("agents"));
    const warning = await screen.findByRole("alert");
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
});
