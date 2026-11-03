import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { hub } from "../src/data.ts";
import { costRate } from "../src/fmt.ts";
import { MeasuredHistory, OverviewHistoryPanel } from "../src/overview/OverviewHistoryPanel.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, NOW, OVERVIEW } from "./fixtures.ts";

afterEach(() => {
  cleanup();
  hub.clear();
});
const source = () =>
  stubFetch({ "/api/config": { ...CONFIG, operator: { id: "operator", timezone: "UTC" } } });
it("keeps missing minutes as gaps and distinguishes unknown history from observed zero", async () => {
  source();
  const view = render(
    <MeasuredHistory
      values={[10, null, 20]}
      format={String}
      label="Measured rate"
      unit="tokens/min"
      at={NOW}
    />,
  );
  await waitFor(() => expect(screen.getAllByText("11:57")[0]).toBeTruthy());
  const graph = screen.getByRole("img", { name: /Measured rate/ });
  expect(graph.querySelector("path")?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
  expect(view.container.textContent).toContain("Latest 20 tokens/min");
  expect(view.container.textContent).toContain("Peak 20");
  view.rerender(
    <MeasuredHistory
      values={[null, null]}
      format={String}
      label="Measured rate"
      unit="tokens/min"
      at={NOW}
    />,
  );
  expect(screen.getByText("History not collected for this window.")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  view.rerender(
    <MeasuredHistory
      values={[0, 0]}
      format={String}
      label="Measured rate"
      unit="tokens/min"
      at={NOW}
    />,
  );
  expect(screen.getByText("No activity in the measured minutes.")).toBeTruthy();
  expect(screen.getByRole("img")).toBeTruthy();
});
it("uses the displayed fractional dollar scale instead of flattening spend below one dollar", () => {
  source();
  const v = render(
    <MeasuredHistory
      values={[0.1, 0.2]}
      format={(n) => `$${n.toFixed(2)}`}
      label="Cost per minute"
      unit="USD/min"
      at={NOW}
    />,
  );
  expect(v.container.querySelector(".measured-y")?.textContent).toBe("$0.20$0.10$0.00");
  expect(v.container.querySelector("path")?.getAttribute("d")).toMatch(/L100\.0,3\.0$/);
  expect(v.container.textContent).toContain("Latest $0.20 USD/min");
});

it("retains a nonzero sub-cent USD/minute rate in latest, peak and axis labels", () => {
  source();
  const v = render(
    <MeasuredHistory
      values={[0.001, 0.002]}
      format={costRate}
      label="Cost per minute"
      unit="USD/min"
      at={NOW}
    />,
  );
  expect(v.container.textContent).toContain("Latest ~$0.002 USD/min");
  expect(v.container.textContent).toContain("Peak ~$0.002");
  expect(v.container.querySelector(".measured-y")?.textContent).toContain("~$0.001");
  expect(v.container.textContent).not.toContain("$0.00 USD/min");
});

function panelSource(values: number[]) {
  return stubFetch({
    "/api/config": { ...CONFIG, operator: { id: "operator", timezone: "UTC" } },
    "/api/overview": {
      ...OVERVIEW,
      kpis: {
        ...OVERVIEW.kpis,
        tokensPerMin: { now: values.at(-1) ?? 0, series: values },
        inFlight: { ...OVERVIEW.kpis.inFlight, series: values },
        needsYou: { ...OVERVIEW.kpis.needsYou, series: values },
        ciPassRate24h: { ...OVERVIEW.kpis.ciPassRate24h, series: [0, null, 100] },
        spendToday: { ...OVERVIEW.kpis.spendToday, series: [0.001, 0.002] },
      },
    },
  });
}
const tickLabels = (container: HTMLElement) =>
  [...container.querySelectorAll(".measured-y > span")].map((tick) => tick.textContent);

for (const measure of ["tokens", "inflight", "needs"] as const) {
  it.each([
    [0, ["1", "0.5", "0"]],
    [1, ["1", "0.5", "0"]],
    [3, ["3", "1.5", "0"]],
  ] as const)(`keeps ${measure} axis positions accurate for a peak of %i`, async (peak, ticks) => {
    panelSource([0, peak]);
    const view = render(<OverviewHistoryPanel />);
    await screen.findByRole("img", { name: /Token throughput/ });
    fireEvent.change(screen.getByRole("combobox", { name: "Measured Overview history" }), {
      target: { value: measure },
    });
    await waitFor(() => expect(tickLabels(view.container)).toEqual([...ticks]));
    expect(new Set(tickLabels(view.container)).size).toBe(3);
    const readings = view.container.querySelector(".measured-reading")?.textContent;
    expect(readings).toContain(`Latest ${peak} `);
    expect(readings).toContain(`Peak ${peak}`);
    const raw = [...view.container.querySelectorAll(".history-data tbody td:last-child")].map(
      (cell) => cell.textContent,
    );
    expect(raw).toEqual(["0", String(peak)]);
    const line = view.container.querySelector(".measured-plot path")?.getAttribute("d");
    expect(line).toMatch(peak === 0 ? /L100\.0,22\.0$/ : /L100\.0,3\.0$/);
  });
}

it("preserves percentage, sub-cent money, gaps and raw values while switching without more reads", async () => {
  const fetch = panelSource([0, 3]);
  const view = render(<OverviewHistoryPanel />);
  await screen.findByRole("img", { name: /Token throughput/ });
  const reads = fetch.mock.calls.length;
  const select = screen.getByRole("combobox", { name: "Measured Overview history" });
  await act(async () => fireEvent.change(select, { target: { value: "ci" } }));
  expect(tickLabels(view.container)).toEqual(["100%", "50%", "0%"]);
  expect(view.container.querySelector(".measured-reading")?.textContent).toContain("Latest 100%");
  expect(
    view.container.querySelector(".measured-plot path")?.getAttribute("d")?.match(/M/g),
  ).toHaveLength(2);
  expect(view.container.querySelector(".history-data")?.textContent).toContain("Not collected");
  await act(async () => fireEvent.change(select, { target: { value: "spend" } }));
  expect(tickLabels(view.container)).toEqual(["~$0.002", "~$0.001", "~$0"]);
  expect(view.container.querySelector(".measured-reading")?.textContent).toContain(
    "Latest ~$0.002 USD/min",
  );
  expect(
    [...view.container.querySelectorAll(".history-data tbody td:last-child")].map(
      (cell) => cell.textContent,
    ),
  ).toEqual(["0.001", "0.002"]);
  for (const value of ["tokens", "inflight", "needs"])
    await act(async () => fireEvent.change(select, { target: { value } }));
  expect(fetch.mock.calls.length).toBe(reads);
});
