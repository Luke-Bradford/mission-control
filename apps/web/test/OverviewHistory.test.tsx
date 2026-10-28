import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { ActivityPanel } from "../src/overview/ActivityPanel.tsx";
import { KpiStrip } from "../src/overview/KpiStrip.tsx";
import { MachinePanel } from "../src/overview/MachinePanel.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, OVERVIEW } from "./fixtures.ts";

it("uses every KPI's minute series instead of hourly history", async () => {
  const kpis = Object.fromEntries(
    Object.entries(OVERVIEW.kpis).map(([key, value]) => [
      key,
      { ...value, series: [1, 2, 4], perHour: [100, 200] },
    ]),
  );
  stubFetch({ "/api/overview": { ...OVERVIEW, kpis } });
  render(<KpiStrip />);
  await screen.findByText("41.2k");
  // Registry figures without a minute history (working, merged, cycle time) draw no trace.
  expect(screen.getAllByRole("img", { name: /last 30 minutes/ })).toHaveLength(5);
  for (const graph of screen.getAllByRole("img")) {
    // 0 at the baseline (y 23), the peak (4) on the top gridline (y 9), newest at the right edge
    expect(graph.querySelector('path[fill="none"]')?.getAttribute("d")).toBe(
      "M0.0,19.5L50.0,16.0L100.0,9.0",
    );
    expect(graph.getAttribute("aria-label")).toMatch(/peak .+ · latest /);
    expect(graph.querySelectorAll("circle")).toHaveLength(0);
  }
  expect(screen.getByText("+~$3.00 · 30m")).toBeTruthy();
  expect(screen.getByText("+3 pp · 30m")).toBeTruthy();
});

it("keeps empty minute series honest even when hourly figures exist", async () => {
  const kpis = Object.fromEntries(
    Object.entries(OVERVIEW.kpis).map(([key, value]) => [key, { ...value, series: [] }]),
  );
  stubFetch({ "/api/overview": { ...OVERVIEW, kpis } });
  render(<KpiStrip />);
  await screen.findByText("41.2k");
  expect(screen.queryAllByRole("img")).toHaveLength(0);
  for (const tile of screen.getAllByRole("link")) {
    expect(within(tile).getAllByText("—").length).toBeGreaterThan(0);
  }
});

it("graphs free disk GB with gaps for missing minutes", async () => {
  stubFetch({
    "/api/overview": { ...OVERVIEW, machine: { disk: [80, null, 40, 60] } },
    "/api/machine": { latest: null },
    "/api/test-lock": { holder: null, waiting: [] },
  });
  render(<MachinePanel />);
  const graph = await screen.findByRole("img", { name: "Disk history · GB free" });
  expect(graph.getAttribute("data-max")).toBe("80");
  expect(graph.querySelector('path[fill="none"]')?.getAttribute("d")).toBe(
    "M0.0,3.0M66.7,12.5L100.0,7.8",
  );
  expect(graph.querySelectorAll("path")).toHaveLength(3);
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
    "/api/crew": { rows: [] },
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
