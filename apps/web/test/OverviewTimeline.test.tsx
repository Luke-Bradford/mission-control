import type { CrewRow, OverviewTimeline } from "@mc/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { TimelinePanel } from "../src/overview/TimelinePanel.tsx";
import { stubFetch } from "./fetchStub.ts";
import { HOUR, MIN, NOW, seatRow } from "./fixtures.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function stub(lanes: OverviewTimeline["lanes"] = [], rows: CrewRow[] = []) {
  return stubFetch({
    "/api/overview/timeline": { from: NOW - HOUR, to: NOW, lanes },
    "/api/crew": { rows },
  });
}

it("clips spans and ticks to the last hour and extends open spans to now", async () => {
  stub([
    {
      agentId: "dev-1",
      spans: [
        { kind: "turn", from: NOW - 2 * HOUR, to: NOW - 30 * MIN },
        { kind: "checks", from: NOW - 15 * MIN, to: null },
        { kind: "lock", from: NOW - 2 * HOUR, to: NOW - HOUR },
        { kind: "review", from: NOW + MIN, to: null },
        { kind: "review", from: NOW - 6 * MIN, to: NOW + MIN },
      ],
      ticks: [NOW - 2 * HOUR, NOW - 30 * MIN, NOW + MIN],
    },
  ]);
  const { container } = render(<TimelinePanel />);
  await screen.findByTitle("dev-1");
  const spans = [...container.querySelectorAll<HTMLElement>(".overview-span")];
  expect(spans.map((s) => [s.style.left, s.style.width])).toEqual([
    ["0%", "50%"],
    ["75%", "25%"],
    ["90%", "10%"],
  ]);
  const ticks = container.querySelectorAll<HTMLElement>(".overview-tick");
  expect(ticks).toHaveLength(1);
  expect(ticks[0]?.style.left).toBe("50%");
});

it("shows the axis and legend even for an empty window", async () => {
  stub();
  render(<TimelinePanel />);
  await screen.findByText("No activity in the last hour.");
  for (const label of [
    "-60m",
    "-45m",
    "-30m",
    "-15m",
    "now",
    "turn",
    "checks",
    "lock",
    "review",
    "tool calls",
  ]) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  // no lane links in an empty window; only the head's link to the activity map
  const links = screen.queryAllByRole("link");
  expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
    ["Activity map →", "/map"],
  ]);
});

it("keeps idle lanes and links the whole lane to its agent", async () => {
  stub([{ agentId: "dev-1", spans: [], ticks: [] }]);
  render(<TimelinePanel />);
  const lane = await screen.findByRole("link", { name: "dev-1" });
  expect(lane.getAttribute("href")).toBe("/agent/dev-1");
  fireEvent.click(lane);
  expect(window.location.pathname).toBe("/agent/dev-1");
});

it("does not fabricate a running span for a currently parked agent", async () => {
  stub(
    [{ agentId: "dev-1", spans: [{ kind: "turn", from: NOW - HOUR, to: null }], ticks: [] }],
    [seatRow({ id: "dev-1", hudState: "parked" })],
  );
  const { container } = render(<TimelinePanel />);
  await screen.findByTitle("dev-1");
  expect(container.querySelector(".overview-span")).toBeNull();
});

it("keeps an observed open lock when a parked agent has no current turn", async () => {
  stub(
    [
      {
        agentId: "dev-1",
        spans: [
          { kind: "turn", from: NOW - HOUR, to: null },
          { kind: "lock", from: NOW - 30 * MIN, to: null },
        ],
        ticks: [],
      },
    ],
    [seatRow({ id: "dev-1", hudState: "parked" })],
  );
  const { container } = render(<TimelinePanel />);
  await screen.findByTitle("dev-1");
  expect(container.querySelector(".k-turn")).toBeNull();
  expect(container.querySelector(".k-lock")).not.toBeNull();
});

it("slides every second between fetches", async () => {
  const fetch = stub([
    { agentId: "dev-1", spans: [{ kind: "turn", from: NOW - 30 * MIN, to: null }], ticks: [] },
  ]);
  const { container } = render(<TimelinePanel />);
  await screen.findByRole("link", { name: "dev-1" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  const span = container.querySelector<HTMLElement>(".overview-span");
  expect(Number.parseFloat(span?.style.left ?? "")).toBeCloseTo(50 - 100 / 3600);
  expect(Number.parseFloat(span?.style.width ?? "")).toBeCloseTo(50 + 100 / 3600);
  expect(fetch.mock.calls.filter(([path]) => path === "/api/overview/timeline")).toHaveLength(1);
});

it("caps cached open spans at the last good data time and reports failed refetches", async () => {
  const fetch = stub([
    { agentId: "dev-1", spans: [{ kind: "turn", from: NOW - 30 * MIN, to: null }], ticks: [] },
  ]);
  const { container } = render(<TimelinePanel />);
  await screen.findByRole("link", { name: "dev-1" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MIN);
  });
  fetch.mockRejectedValueOnce(new Error("offline"));
  await act(async () => hub.refetchTopic("agents"));
  const span = () => container.querySelector<HTMLElement>(".overview-span");
  expect(Number.parseFloat(span()?.style.width ?? "")).toBeCloseTo(50);
  expect(screen.getByText("Could not refresh timeline. Showing stale data.").className).toBe(
    "crit-t",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MIN);
  });
  expect(Number.parseFloat(span()?.style.width ?? "")).toBeCloseTo(50);
  expect(Number.parseFloat(span()?.style.left ?? "")).toBeCloseTo(50 - 100 / 30);

  await act(async () => hub.refetchTopic("agents"));
  expect(screen.queryByText("Could not refresh timeline. Showing stale data.")).toBeNull();
  expect(Number.parseFloat(span()?.style.width ?? "")).toBeCloseTo(50 + 100 / 30);
});

it("uses live crew names and colours and resizes its lane grid after updates", async () => {
  const lanes = ["seat-1", "seat-2"].map((agentId) => ({ agentId, spans: [], ticks: [] }));
  stub(lanes, [seatRow({ id: "seat-1", displayCallSign: "guido-cx", index: 2 })]);
  const { container } = render(<TimelinePanel />);
  const lane = await screen.findByRole("link", { name: "guido-cx" });
  expect(lane.querySelector<HTMLElement>(".num")?.style.getPropertyValue("--c")).toBe(
    "var(--seat-3)",
  );
  const grid = () => container.querySelector<HTMLElement>(".overview-lanes");
  expect(grid()?.style.getPropertyValue("--lane-count")).toBe("2");
  stub(lanes.slice(0, 1), [seatRow({ id: "seat-1", displayCallSign: "renamed", index: 4 })]);
  await act(async () => hub.refetchTopic("agents"));
  const renamed = await screen.findByRole("link", { name: "renamed" });
  expect(renamed.querySelector<HTMLElement>(".num")?.style.getPropertyValue("--c")).toBe(
    "var(--seat-5)",
  );
  expect(grid()?.style.getPropertyValue("--lane-count")).toBe("1");
  stub();
  await act(async () => hub.refetchTopic("agents"));
  expect(grid()?.childElementCount).toBe(0);
  expect(grid()?.style.getPropertyValue("--lane-count")).toBe("0");
});
