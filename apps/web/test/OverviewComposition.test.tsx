import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OverviewMeasuredPanel } from "../src/overview/OverviewAnalyticalPanels.tsx";
import { OverviewCanvas, useOverviewLayout } from "../src/overview/OverviewLayout.tsx";
import { stubFetch } from "./fetchStub.ts";
import { overviewDensityFixture } from "./overviewDensityFixtures.ts";

afterEach(() => vi.unstubAllGlobals());

/** Deliver real observer callbacks with independently controlled content dimensions.
 * The viewport is deliberately unrelated to the available canvas.
 */
function observeCanvas() {
  const callbacks = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
        callbacks.add(callback);
      }
      observe() {}
      disconnect() {
        callbacks.delete(this.callback);
      }
    },
  );
  return (width: number, remaining: number) => {
    const grid = document.querySelector<HTMLElement>(".overview-grid");
    const workspace = document.querySelector<HTMLElement>(".overview-workspace");
    if (!grid || !workspace) throw Error("Canvas not mounted");
    Object.defineProperties(grid, {
      clientWidth: { configurable: true, value: width },
      clientHeight: { configurable: true, value: remaining + 110 },
    });
    grid.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
    workspace.getBoundingClientRect = () => ({ top: 160 }) as DOMRect;
    act(() => {
      for (const callback of callbacks) callback();
    });
  };
}

it("uses actual canvas width and post-KPI height, without rebuilding stable roster children per resize", () => {
  const resize = observeCanvas();
  const renders = vi.fn();
  function RosterBoundary() {
    renders();
    return <p>Stable crew</p>;
  }
  function LayoutProbe() {
    return <output>{JSON.stringify(useOverviewLayout())}</output>;
  }
  const view = render(
    <OverviewCanvas>
      <div className="overview-metrics" />
      <div className="overview-workspace">
        <RosterBoundary />
        <LayoutProbe />
      </div>
    </OverviewCanvas>,
  );
  const flags = () => JSON.parse(view.container.querySelector("output")?.textContent ?? "{}");
  resize(3163, 2000);
  expect(flags()).toEqual({ hostEvidence: true, wideDetails: false, allHistories: false });
  resize(3164, 1839);
  expect(flags()).toEqual({ hostEvidence: true, wideDetails: true, allHistories: false });
  resize(3164, 1840);
  expect(flags().allHistories).toBe(true);
  resize(3165, 1841);
  expect(flags().allHistories).toBe(true);
  resize(2075, 2000);
  expect(flags()).toEqual({ hostEvidence: false, wideDetails: false, allHistories: false });
  resize(2076, 1119);
  expect(flags().hostEvidence).toBe(false);
  resize(2076, 1120);
  expect(flags().hostEvidence).toBe(true);
  expect(renders).toHaveBeenCalledTimes(1);
});

it("reflows one selected history into five unique measured histories and back without another collection", async () => {
  const resize = observeCanvas();
  const fixture = overviewDensityFixture();
  const fetch = stubFetch(fixture.api);
  render(
    <OverviewCanvas>
      <div className="overview-metrics" />
      <div className="overview-workspace">
        <OverviewMeasuredPanel />
      </div>
    </OverviewCanvas>,
  );
  await screen.findByText(/Latest 41.2k/);
  fireEvent.change(screen.getByRole("combobox", { name: "Measured Overview history" }), {
    target: { value: "needs" },
  });
  await screen.findByText(/Latest 3 items/);
  const before = fetch.mock.calls.length;
  resize(3368, 1923);
  await waitFor(() =>
    expect(document.querySelectorAll(".overview-history-domain > .panel")).toHaveLength(5),
  );
  expect(
    [...document.querySelectorAll(".overview-history-domain > .panel")].map((p) => p.id),
  ).toEqual([
    "overviewHistory-tokens",
    "overviewHistory-spend",
    "overviewHistory-inflight",
    "overviewHistory-ci",
    "overviewHistory-needs",
  ]);
  expect(document.querySelectorAll(".history-recent")).toHaveLength(5);
  expect(document.querySelectorAll(".history-recent dl > div")).toHaveLength(25);
  resize(1800, 843);
  await waitFor(() =>
    expect(document.querySelectorAll(".overview-history-domain > .panel")).toHaveLength(1),
  );
  expect(
    (screen.getByRole("combobox", { name: "Measured Overview history" }) as HTMLSelectElement)
      .value,
  ).toBe("needs");
  expect(fetch.mock.calls).toHaveLength(before);
});
