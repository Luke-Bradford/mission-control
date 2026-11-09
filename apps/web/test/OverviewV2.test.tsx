import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { ActivityPanel } from "../src/overview/ActivityPanel.tsx";
import { MachinePanel } from "../src/overview/MachinePanel.tsx";
import { MacRow } from "../src/overview/MacRow.tsx";
import { PipelinePanel } from "../src/overview/PipelinePanel.tsx";
import { QuotaMeter } from "../src/overview/QuotaMeter.tsx";
import { TokensPanel } from "../src/overview/TokensPanel.tsx";
import { settled, stubFetch } from "./fetchStub.ts";
import { CONFIG, HOUR, limit7d, NOW, OVERVIEW } from "./fixtures.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
it.each([false, true])(
  "renders the first full activity load and deltas, including an empty list: %s",
  async (empty) => {
    const at = Date.now();
    const row = (text: string, time: number) => ({
      at: time,
      who: "seat",
      kind: "run-start",
      text,
      ref: null,
      url: null,
      prs: [],
      status: null,
      summary: null,
    });
    const since = empty ? 0 : at - 1;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = stubFetch({
      "/api/activity": empty ? [] : [row("First activity", at)],
      [`/api/activity?since=${since}`]: empty
        ? []
        : [row("First activity", at), row("Delta activity", at + 1)],
      "/api/crew?shape=summary": { rows: [] },
      "/api/config": CONFIG,
      "/api/attention": [],
    });
    const answer = fetch.getMockImplementation();
    if (!answer) throw new Error("Missing fetch stub");
    fetch.mockImplementation(async (...args) => {
      if (args[0].startsWith("/api/activity?")) await pending;
      return answer(...args);
    });
    render(<ActivityPanel />);
    expect(screen.getByText("Loading activity…")).toBeTruthy();
    const visible = empty ? "No events yet." : "First activity";
    expect(await screen.findByText(visible)).toBeTruthy();
    expect(
      fetch.mock.calls
        .filter(([path]) => path.startsWith(RESOURCES.activity.path))
        .map(([path]) => path),
    ).toEqual([RESOURCES.activity.path]);
    act(() => hub.refetchTopic("agents"));
    expect(screen.getByText(visible)).toBeTruthy();
    expect(screen.queryByText("Loading activity…")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText(empty ? "No events yet." : "Delta activity")).toBeTruthy();
    expect(screen.queryByText("Loading activity…")).toBeNull();
    expect(fetch).toHaveBeenCalledWith(`/api/activity?since=${since}`, expect.anything());
  },
);

it("filters each live log chip and remembers the selection", async () => {
  const kinds = ["run-start", "pr-opened", "pr-merged", "loop", "guard"];
  stubFetch({
    "/api/activity": kinds.map((kind, i) => ({
      at: NOW - i,
      who: "seat",
      kind,
      text: kind === "loop" ? "merge: started" : kind,
      ref: null,
      url: null,
      prs: [],
      status: null,
      summary: null,
    })),
    "/api/crew?shape=summary": { rows: [] },
    "/api/config": CONFIG,
    "/api/attention": [
      { key: "a", at: NOW, text: "Operator call", owner: "operator", agentId: null, repoId: null },
    ],
  });
  const view = render(<ActivityPanel />);
  await screen.findByText("run-start");
  for (const [chip, count] of [
    ["All", 5],
    ["Steps", 5],
    ["Reviews", 2],
    ["Merges", 2],
    ["Guard", 1],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name: chip }));
    expect(screen.getByRole("button", { name: chip }).getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelectorAll(".arow")).toHaveLength(count);
  }
  expect(screen.queryByRole("button", { name: "Needs you" })).toBeNull();
  view.unmount();
  render(<ActivityPanel />);
  expect(screen.getByRole("button", { name: "Guard" }).getAttribute("aria-pressed")).toBe("true");
});
it("falls back to the default filter when Needs you was remembered, and lists no waiting item", async () => {
  localStorage.setItem("overview.live-log.filter", "needs");
  stubFetch({
    "/api/activity": [],
    "/api/crew?shape=summary": { rows: [] },
    "/api/config": CONFIG,
    "/api/attention": [
      { key: "a", at: NOW, text: "Operator call", owner: "operator", agentId: null, repoId: null },
    ],
  });
  render(<ActivityPanel />);
  expect(screen.getByRole("button", { name: "Steps" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  await screen.findByText("No events yet.");
  expect(screen.queryByText("Operator call")).toBeNull();
});
it("shows machine history as CPU and memory graphs", async () => {
  stubFetch({
    "/api/machine": { latest: null },
    "/api/overview": { ...OVERVIEW, machine: { cpu: [10, 30], mem: [40, 50], diskFreeGb: 80 } },
    "/api/test-lock": { holder: null, waiting: [] },
  });
  render(<MachinePanel />);
  expect(await screen.findByRole("img", { name: "CPU history" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Memory history" })).toBeTruthy();
});
it("marks the projected quota at reset", async () => {
  stubFetch({ "/api/health": [] });
  const { container } = render(<QuotaMeter row={limit7d({ projected: 84 })} now={NOW} />);
  await waitFor(() =>
    expect(container.querySelector<HTMLElement>(".projection-tick")?.style.left).toBe("84%"),
  );
});

it("shows a backed-off quota row's next try beside its stale age", async () => {
  stubFetch({ "/api/health": [] });
  render(
    <QuotaMeter
      row={limit7d({ stale: true, sampledAt: NOW - 3 * HOUR, nextTryAt: NOW + 2 * 60_000 })}
      now={NOW}
      showAge
    />,
  );
  expect(await screen.findByText(/3h 0m ago · next try in 2m/)).toBeTruthy();
});

it.each([
  {},
  { pipeline: [] },
  { machine: {}, kpis: {}, pipeline: [{ stage: "ready" }] },
  { machine: { cpu: [10, 20] }, kpis: { working: {}, spendToday: {} } },
])("renders overview panels safely with missing or partial sections: %j", async (overview) => {
  const fetch = stubFetch({
    "/api/overview": overview,
    "/api/machine": { latest: null },
    "/api/test-lock": { holder: null, waiting: [] },
  });
  const { container } = render(
    <>
      <MachinePanel />
      <MacRow />
      <TokensPanel />
      <PipelinePanel />
    </>,
  );
  await settled(fetch, "/api/overview");
  expect(container.querySelector("#machP")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Memory history" })).toBeNull();
  // The Mac row has no reading (the lock is free), and the Board's head figures have no registry
  // value: dashes.
  expect(
    [...container.querySelectorAll("#macP .mac-measure b")].map((el) => el.textContent),
  ).toEqual(["—", "—", "—", "—", "free"]);
  expect(
    [...container.querySelectorAll("#pipelineP .ph b[data-metric]")].map((el) => el.textContent),
  ).toEqual(["—", "—", "—"]);
  // Stages with no cards hold none; the Board still shows all five.
  expect(container.querySelectorAll(".board-stage")).toHaveLength(5);
  expect(container.querySelectorAll(".board-card")).toHaveLength(0);
  expect(container.querySelector(".token-spend")).toBeNull();
});
