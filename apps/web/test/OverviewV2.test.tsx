import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { ActivityPanel } from "../src/overview/ActivityPanel.tsx";
import { KpiStrip } from "../src/overview/KpiStrip.tsx";
import { MachinePanel } from "../src/overview/MachinePanel.tsx";
import { PipelinePanel } from "../src/overview/PipelinePanel.tsx";
import { QuotaMeter } from "../src/overview/QuotaMeter.tsx";
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
      "/api/crew": { rows: [] },
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
    "/api/crew": { rows: [] },
    "/api/config": CONFIG,
    "/api/attention": [
      { key: "a", at: NOW, text: "Operator call", owner: "operator", agentId: null, repoId: null },
    ],
  });
  const view = render(<ActivityPanel />);
  await screen.findByText("run-start");
  for (const [chip, count] of [
    ["All", 6],
    ["Steps", 5],
    ["Reviews", 2],
    ["Merges", 2],
    ["Guard", 1],
    ["Needs you", 1],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name: chip }));
    expect(screen.getByRole("button", { name: chip }).getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelectorAll(".arow")).toHaveLength(count);
  }
  view.unmount();
  render(<ActivityPanel />);
  expect(screen.getByRole("button", { name: "Needs you" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
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
  expect(await screen.findByText(/3h ago · next try in 2m/)).toBeTruthy();
});

const attentionItem = {
  key: "esc:shop:42",
  kind: "decision",
  at: NOW,
  text: "Operator decision",
  owner: "operator",
  agentId: null,
  repoId: "shop",
  ticket: "shop#42",
  escalationId: "shop:42",
  url: "https://github.com/example/shop/issues/42",
};
function logRoutes(attention: unknown) {
  return {
    "/api/activity": [],
    "/api/crew": { rows: [] },
    "/api/config": CONFIG,
    "/api/attention": attention,
  };
}
it("reports attention loading, first-load failure, and stale refetch failure", async () => {
  localStorage.setItem("overview.live-log.filter", "needs");
  let finish!: (response: Response) => void;
  const fetch = stubFetch(logRoutes([]));
  const original = fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch stub");
  fetch.mockImplementation((path, init) =>
    path === "/api/attention"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : original(path, init),
  );
  render(<ActivityPanel />);
  expect(screen.getByText("Loading attention…")).toBeTruthy();
  await act(async () => {
    finish(new Response("{}", { status: 500 }));
  });
  expect(await screen.findByText("Could not load attention.")).toBeTruthy();
  expect(screen.queryByText("No events yet.")).toBeNull();
  stubFetch(logRoutes([attentionItem]));
  await act(async () => {
    hub.refetch("/api/attention");
  });
  await screen.findByText("Operator decision");
  stubFetch(logRoutes(() => ({ status: 500, body: {} })));
  await act(async () => {
    hub.refetch("/api/attention");
  });
  expect(
    await screen.findByText("Could not refresh attention. Showing last known items."),
  ).toBeTruthy();
  expect(screen.getByText("Operator decision")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(screen.getByText("Could not refresh attention. Showing last known items.")).toBeTruthy();
});
it("reconciles All escalations by ticket identity", async () => {
  const routes = logRoutes([
    attentionItem,
    { ...attentionItem, text: "Updated decision", at: NOW + 1 },
    { ...attentionItem, key: "other", ticket: "shop#43", text: "Different issue" },
  ]);
  stubFetch({
    ...routes,
    "/api/activity": [
      {
        at: NOW - 100,
        who: "shop",
        kind: "escalation",
        text: "Original decision",
        ref: "shop#42",
        url: attentionItem.url,
        status: null,
        prs: [],
        summary: null,
      },
    ],
  });
  const view = render(<ActivityPanel />);
  await screen.findByText("Original decision");
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(view.container.querySelectorAll(".arow")).toHaveLength(2);
  expect(screen.getByText("Different issue")).toBeTruthy();
});
it("links attention without a ticket to its external URL or detail page", async () => {
  localStorage.setItem("overview.live-log.filter", "needs");
  stubFetch(
    logRoutes([
      { ...attentionItem, ticket: null },
      { ...attentionItem, key: "notice:one", ticket: null, url: null, text: "Local notice" },
    ]),
  );
  render(<ActivityPanel />);
  const external = await screen.findByRole("link", { name: "Operator decision" });
  expect(external.getAttribute("href")).toBe(attentionItem.url);
  expect(external.getAttribute("target")).toBe("_blank");
  expect(external.getAttribute("rel")).toContain("noreferrer");
  expect(screen.getByRole("link", { name: "Local notice" }).getAttribute("href")).toBe(
    "/comms/notice%3Aone",
  );
});

it("reconciles ticketless attention by key without collapsing matching text", async () => {
  localStorage.setItem("overview.live-log.filter", "all");
  const item = { ...attentionItem, escalationId: null, ticket: null };
  stubFetch(logRoutes([item, { ...item, at: NOW + 1 }, { ...item, key: "another" }]));
  const view = render(<ActivityPanel />);
  await screen.findAllByText("Operator decision");
  expect(view.container.querySelectorAll(".arow")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Needs you" }));
  expect(view.container.querySelectorAll(".arow")).toHaveLength(2);
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
      <KpiStrip />
      <PipelinePanel />
    </>,
  );
  await settled(fetch, "/api/overview");
  expect(container.querySelector("#machP")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Memory history" })).toBeNull();
  expect([...container.querySelectorAll(".overview-kpi .v")].map((el) => el.textContent)).toEqual(
    Array(8).fill("—"),
  );
  expect(container.querySelectorAll(".pipeline-stage")).toHaveLength(0);
  expect(container.querySelectorAll(".pipeline-chip")).toHaveLength(0);
});
