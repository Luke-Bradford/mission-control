import type { AttentionItem, CrewRow, RunDigest } from "@mc/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsPanel } from "../src/overview/AgentsPanel.tsx";
import { activityValues } from "../src/overview/agentActivity.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, crewRow, item, limit5h, MIN, NOW, seatRow } from "./fixtures.ts";

const digest = (minuteTokens: [number, number][]): RunDigest => ({
  toolCalls: 0,
  turns: 8,
  lastEventAt: NOW,
  model: "opus",
  contextTokens: 400,
  contextWindow: 1000,
  liveTool: null,
  tools: {},
  subagents: [],
  minuteTokens,
  turnUsage: [],
  background: [],
  compactions: 0,
});
function stub(
  rows: CrewRow[],
  enabled = true,
  items: AttentionItem[] = [item({ agentId: "need", ticket: null })],
  about = "CI",
) {
  stubFetch({
    "/api/crew": { rows, firstRunToday: null },
    "/api/config": {
      ...CONFIG,
      crew: { sessions: [{ id: "s1", seats: [{ id: "flight", loop: "watch" }] }] },
    },
    "/api/attention": items,
    "/api/limits": [limit5h({ used: 14 })],
    "/api/test-lock": { holder: null, waiting: [] },
    "/api/crew/status": { enabled, note: null },
    "/api/flight": {
      seat: { id: "flight", state: "idle", live: true, turns: { n: 3, max: 41 } },
      decisions: [
        {
          id: 1,
          at: NOW - 3 * MIN,
          kind: "message",
          about,
          decision: "Asked GUIDO to check CI",
        },
      ],
    },
    "/api/flight/brief": { session: "s1", sections: [], watch: [{ id: "ci" }] },
    "/api/repos/shop-app/prs?linked=1": [],
  });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("pins Watching FLIGHT with coverage, a last action and a decision link", async () => {
  stub([seatRow({ id: "worker" }), seatRow({ id: "flight", hudState: "idle" })]);
  const { container } = render(<AgentsPanel />);
  const flight = container.querySelector(".flight") as HTMLElement;
  await within(flight).findByText("Watching");
  await within(flight).findByText(/watching 1 · triaging/);
  expect(flight.textContent).toContain("last action 3m ago (CI)");
  expect(flight.textContent).toContain("next check within 5m");
  expect(
    within(flight)
      .getByRole("link", { name: /Asked GUIDO/ })
      .getAttribute("href"),
  ).toBe("/flight");
  expect(container.querySelector(".trow:not(.head)")).toBe(flight);
});

it("groups crew, observed and off, sorting by attention before blocked, work, wait and free", async () => {
  stub([
    seatRow({ id: "free", hudState: "idle", run: null }),
    crewRow({ id: "observed" }),
    seatRow({ id: "off", hudState: "stopped" }),
    seatRow({
      id: "wait",
      hudState: "idle",
      loop: { phase: "ci", text: "CI", prNumber: null, parked: null },
    }),
    seatRow({ id: "work", hudState: "running" }),
    seatRow({ id: "blocked", hudState: "parked" }),
    seatRow({ id: "need", hudState: "idle", run: null }),
  ]);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("observed");
  const groups = [...container.querySelectorAll(".agent-group")];
  expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
    "Crew",
    "Observed loops",
    "Off",
  ]);
  expect([...(groups[0]?.querySelectorAll(".rowlink") ?? [])].map((el) => el.textContent)).toEqual([
    "need",
    "blocked",
    "work",
    "wait",
    "free",
  ]);
  expect((groups[2] as HTMLDetailsElement).open).toBe(false);
  expect(groups[1]?.querySelector("summary")?.textContent).toContain("1");
});

it("labels Context, puts quota once in the header and shows elapsed state and expandable metadata", async () => {
  stub(
    [
      seatRow({ id: "a", digest: digest([]), contextWindow: 1000, hudState: "idle", run: null }),
      seatRow({ id: "b" }),
    ],
    false,
  );
  const { container } = render(<AgentsPanel />);
  await screen.findByText("Context 40%");
  expect(screen.getByText("Context 40%").closest("[title]")?.getAttribute("title")).toBe(
    "how full this agent's context window is",
  );
  expect(screen.getAllByText("5h 14%")).toHaveLength(1);
  expect(container.querySelector(".ph")?.textContent).toContain("5h 14%");
  const paused = await screen.findByText("Idle (crew paused)");
  expect(paused.closest(".trow")?.querySelector(".doing")?.textContent).toBe("Crew is paused");
  expect(container.querySelector(".state-cell")?.textContent).toContain("25m");
  const detail = screen
    .getByText("Context 40%")
    .closest(".trow")
    ?.querySelector("details.agent-metadata") as HTMLDetailsElement;
  fireEvent.click(detail.querySelector("summary") as HTMLElement);
  expect(detail.open).toBe(true);
  await waitFor(() => expect(detail.textContent).toContain("8 turns"));
});

it("keeps ninety idle minutes flat, excludes old/future buckets and shares the vertical scale", async () => {
  const end = Math.floor(NOW / MIN) * MIN;
  const quiet = digest([
    [end - 100 * MIN, 120],
    [end - 121 * MIN, 9999],
    [end + MIN, 9999],
  ]);
  expect(activityValues(quiet, NOW)).toHaveLength(120);
  expect(activityValues(quiet, NOW).slice(-90)).toEqual(Array(90).fill(0));
  stub([
    seatRow({ id: "quiet", digest: quiet }),
    seatRow({ id: "busy", digest: digest([[end, 1200]]) }),
  ]);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("quiet");
  const sparks = [...container.querySelectorAll("svg.spark")];
  expect(sparks).toHaveLength(2);
  expect(sparks.map((s) => s.getAttribute("data-max"))).toEqual(["1200", "1200"]);
  expect(container.textContent).toContain("1/min");
});

it("renders one positioned heartbeat tick per event kind and aligns set-aside cells", async () => {
  const kinds = ["commit", "push", "test", "pr-opened", "review", "park", "message"] as const;
  stub([
    seatRow({
      events: kinds.map((kind, i) => ({ kind, at: NOW - (i + 1) * MIN })),
      asideRuns: [
        {
          runId: "aside",
          ticket: "shop-app#9",
          ticketTitle: "Aside",
          loop: { phase: "review", text: "Review", prNumber: 9, parked: null },
        },
      ],
    }),
  ]);
  const { container } = render(<AgentsPanel />);
  await waitFor(() => expect(container.querySelectorAll(".heartbeat-tick")).toHaveLength(7));
  expect(
    [...container.querySelectorAll(".heartbeat-tick")].map((t) => t.getAttribute("data-kind")),
  ).toEqual([...kinds]);
  expect(container.textContent).toContain("last event 1m ago");
  expect(container.querySelector(".asideline")?.children).toHaveLength(6);
});

it.each([
  ["running", "Thinking"],
  ["parked", "Held"],
  ["stopped", "Stopped"],
] as const)("FLIGHT %s is labelled %s", async (hudState, label) => {
  stub([seatRow({ id: "flight", hudState })]);
  const { container } = render(<AgentsPanel />);
  await within(container.querySelector(".flight") as HTMLElement).findByText(label);
});

it("leaves an idle heartbeat empty and hides future or expired events", async () => {
  stub([
    seatRow({
      events: [
        { kind: "commit", at: NOW - 121 * MIN },
        { kind: "push", at: NOW + MIN },
      ],
    }),
  ]);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("No events in 2h");
  expect(container.querySelectorAll(".heartbeat-tick")).toHaveLength(0);
});

it.each(["stopped", "observed"])(
  "opens the %s group for operator questions and counts rows, not items",
  async (kind) => {
    const makeRow =
      kind === "stopped"
        ? (id: string) => seatRow({ id, hudState: "stopped" })
        : (id: string) => crewRow({ id });
    stub([makeRow("need"), makeRow("second"), makeRow("auto")], true, [
      item({ key: "ask:1", agentId: "need", kind: "question", text: "Which port?", ticket: null }),
      item({ key: "ask:2", agentId: "need", kind: "question", ticket: null }),
      item({ key: "ask:3", agentId: "second", kind: "question", ticket: null, owner: undefined }),
      item({ key: "ask:4", agentId: "auto", kind: "question", ticket: null, owner: "flight" }),
    ]);
    const { container } = render(<AgentsPanel />);
    await screen.findByText("Needs you · 2");
    const group = container.querySelector("details.agent-group") as HTMLDetailsElement;
    expect(group.open).toBe(true);
    expect(within(group).getByRole("link", { name: "need" })).toBeTruthy();
    expect(within(group).getAllByText("Question for you")).toHaveLength(3);
    expect(
      within(group.querySelector("summary") as HTMLElement).getByText("Needs you · 2"),
    ).toBeTruthy();
    expect(container.querySelectorAll(".agent-group")).toHaveLength(1);
  },
);

it("hides empty groups", async () => {
  stub([]);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("0 working · 0 agents · FLIGHT not counted");
  expect(container.querySelectorAll(".agent-group")).toHaveLength(0);
});

it("shows FLIGHT turns for the whole session, even when it started yesterday", async () => {
  const row = seatRow({ id: "flight", hudState: "idle" });
  if (!row.run) throw new Error("fixture needs a run");
  row.run.startedAt = NOW - 2 * 24 * 60 * MIN;
  stub([row]);
  const { container } = render(<AgentsPanel />);
  const flight = container.querySelector(".flight") as HTMLElement;
  await within(flight).findByText("Watching");
  fireEvent.click(within(flight).getByText("Run details"));
  await within(flight).findByText(/Turns this session: 3/);
  expect(flight.textContent).not.toContain("Wakes today");
});

it.each(["running", "stalled"] as const)(
  "omits next check while FLIGHT is %s mid-turn",
  async (hudState) => {
    stub([seatRow({ id: "flight", hudState })]);
    const { container } = render(<AgentsPanel />);
    const flight = container.querySelector(".flight") as HTMLElement;
    await within(flight).findByText("Thinking");
    expect(flight.querySelector(".flight-coverage")?.textContent).not.toContain("next check");
  },
);

it("cuts the latest decision's about to 60 characters in coverage", async () => {
  stub([seatRow({ id: "flight", hudState: "idle" })], true, [], "a".repeat(80));
  const { container } = render(<AgentsPanel />);
  const flight = container.querySelector(".flight") as HTMLElement;
  await within(flight).findByText("Watching");
  expect(flight.querySelector(".flight-coverage")?.textContent).toContain(
    `last action 3m ago (${"a".repeat(59)}…)`,
  );
});

it("keeps the FLIGHT placeholder's full title in the ticket column", async () => {
  stub([]);
  const { container } = render(<AgentsPanel />);
  const text = await screen.findByText("No FLIGHT seat is configured.");
  expect(text.title).toBe("No FLIGHT seat is configured.");
  expect(container.querySelector(".flight > .agent-doing")?.contains(text)).toBe(true);
});
