import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ActivityPanel } from "../src/overview/ActivityPanel.tsx";
import { KpiStrip } from "../src/overview/KpiStrip.tsx";
import { MachinePanel } from "../src/overview/MachinePanel.tsx";
import { OverviewHistoryPanel } from "../src/overview/OverviewHistoryPanel.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, OVERVIEW, seatRow } from "./fixtures.ts";

it("retains every minute series in one canonical plot with KPI history access and no new reads", async () => {
  const kpis = Object.fromEntries(
    Object.entries(OVERVIEW.kpis).map(([key, value]) => [
      key,
      { ...value, series: [1, 2, 4], perHour: [100, 200] },
    ]),
  );
  const source = stubFetch({ "/api/overview": { ...OVERVIEW, kpis } });
  const inspect = vi.fn();
  render(
    <>
      <KpiStrip onHistory={inspect} />
      <OverviewHistoryPanel />
    </>,
  );
  await screen.findByText("41.2k");
  const selector = screen.getByRole("combobox", { name: "Measured Overview history" });
  const controls = [
    ["tokens", /Inspect Tokens\/min/],
    ["spend", /Inspect Cost/],
    ["inflight", /Inspect In progress/],
    ["ci", /Inspect CI pass rate/],
    ["needs", /Inspect Needs you/],
  ] as const;
  for (const [measure, name] of controls) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(inspect).toHaveBeenLastCalledWith(measure);
    fireEvent.change(selector, { target: { value: measure } });
    const graphs = screen.getAllByRole("img");
    expect(graphs).toHaveLength(1);
    const graph = graphs[0];
    // Minute values1/2/4, never hourly100/200. CI retains its meaningful0–100% scale.
    expect(graph.querySelector('path[fill="none"]')?.getAttribute("d")).toBe(
      measure === "ci" ? "M0.0,21.8L50.0,21.6L100.0,21.2" : "M0.0,17.3L50.0,12.5L100.0,3.0",
    );
    expect(graph.getAttribute("aria-label")).toContain("last 3 complete minutes");
  }
  expect(screen.getByText("+$3.00 · 30m")).toBeTruthy();
  expect(screen.getByText("+3 pp · 30m")).toBeTruthy();
  expect(source.mock.calls.filter(([path]) => String(path) === "/api/overview")).toHaveLength(1);
});

it("keeps empty minute series honest even when hourly figures exist", async () => {
  const kpis = Object.fromEntries(
    Object.entries(OVERVIEW.kpis).map(([key, value]) => [key, { ...value, series: [] }]),
  );
  stubFetch({ "/api/overview": { ...OVERVIEW, kpis } });
  render(<KpiStrip />);
  await screen.findByText("41.2k");
  expect(screen.queryAllByRole("img")).toHaveLength(0);
  const tokens = screen.getByRole("link", { name: /Tokens\/min/ });
  expect(within(tokens).getByText("41.2k")).toBeTruthy();
  expect(within(tokens).getByText("History not collected")).toBeTruthy();
  expect(within(tokens).queryByRole("img")).toBeNull();
});

it("graphs free disk GiB with gaps for missing minutes", async () => {
  stubFetch({
    "/api/overview": { ...OVERVIEW, machine: { disk: [80, null, 40, 60] } },
    "/api/machine": { latest: null },
    "/api/test-lock": { holder: null, waiting: [] },
  });
  render(<MachinePanel />);
  const graph = await screen.findByRole("img", { name: "Disk history · GiB free" });
  expect(graph.getAttribute("data-max")).toBe("80");
  expect(graph.querySelector('path[fill="none"]')?.getAttribute("d")).toBe(
    "M0.0,3.0M66.7,12.5L100.0,7.8",
  );
  expect(graph.querySelectorAll("path")).toHaveLength(3);
  expect(
    screen.getByText(/CPU, memory history not collected; those bars use the current sample/),
  ).toBeTruthy();
});

it("links run chips to the specific run and preserves chips without a run", async () => {
  const event = {
    at: Date.now(),
    who: "seat",
    kind: "run-start",
    ref: null,
    url: null,
    prs: [],
    status: null,
    summary: null,
  };
  stubFetch({
    "/api/activity": [
      { ...event, text: "With run", runId: "run/one" },
      { ...event, at: event.at - 1, text: "Without run" },
    ],
    "/api/crew?shape=summary": { rows: [] },
    "/api/config": CONFIG,
    "/api/attention": [],
  });
  render(<ActivityPanel />);
  const text = await screen.findByText("With run");
  expect(text.closest(".arow")?.querySelector(".log-who a")?.getAttribute("href")).toBe(
    "/agent/seat?run=run%2Fone",
  );
  expect(screen.getByText("Without run").closest(".arow")?.querySelector(".log-who a")).toBeNull();
});

it("shows only the call sign in the log's agent column, with the role in its tooltip", async () => {
  const [role] = CONFIG.crew?.roles ?? [];
  stubFetch({
    "/api/activity": [
      {
        at: Date.now(),
        who: "backend-1",
        kind: "run-start",
        ref: null,
        url: null,
        prs: [],
        status: null,
        summary: null,
        text: "Started",
        runId: null,
      },
    ],
    "/api/crew?shape=summary": { rows: [seatRow({ id: "backend-1", role: "BACKEND", index: 1 })] },
    "/api/config": {
      ...CONFIG,
      crew: { ...CONFIG.crew, roles: [{ ...role, name: "BACKEND", here: "Backend developer" }] },
    },
    "/api/attention": [],
  });
  render(<ActivityPanel />);
  const who = (await screen.findByText("Started")).closest(".arow")?.querySelector(".log-who");
  await waitFor(() =>
    expect(who?.querySelector(".ag")?.getAttribute("title")).toBe("Backend developer"),
  );
  expect(who?.textContent).toBe("backend-1");
});
