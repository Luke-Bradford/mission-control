import type { AttentionItem, CrewRow, LimitRow, RunDigest } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { crewOrder, isCurrentWork, MAX_STATE_PILL_LENGTH } from "../src/crew.ts";
import { AgentsPanel } from "../src/overview/AgentsPanel.tsx";
import { activityLive, activityValues } from "../src/overview/agentActivity.ts";
import { QuotaMeter } from "../src/overview/QuotaMeter.tsx";
import { nextAgent, setSelectedAgent } from "../src/shell/selection.ts";
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
  limits: LimitRow[] = [limit5h({ used: 14 })],
  overrides: Record<string, unknown> = {},
) {
  return stubFetch({
    "/api/crew": { rows, firstRunToday: null },
    "/api/config": {
      ...CONFIG,
      crew: { sessions: [{ id: "s1", seats: [{ id: "flight", loop: "watch" }] }] },
    },
    "/api/attention": items,
    "/api/limits": limits,
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
    ...overrides,
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

const rowsIn = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>(".trow:not(.head)"),
];

it("shows FLIGHT and the crew in seven columns with a live Work line, and observed loops in the Loops strip", async () => {
  const loop = {
    phase: "working" as const,
    profile: "feature",
    step: "implement",
    text: "Implementing",
    prNumber: null,
    parked: null,
  };
  const rows = [
    seatRow({ id: "free", index: 4, hudState: "idle" }),
    crewRow({ id: "observed-running", index: 6 }),
    seatRow({ id: "running", index: 3 }),
    seatRow({ id: "flight", index: 0 }),
    crewRow({ id: "observed-waiting", index: 5, hudState: "waiting" }),
    seatRow({ id: "parked", index: 2, hudState: "parked" }),
    seatRow({ id: "need", index: 1, hudState: "idle" }),
  ].map((row) => ({ ...row, loop, digest: digest([[NOW, 1200]]), contextWindow: 1000 }));
  stub(rows);
  const { container } = render(<AgentsPanel />);
  await screen.findByRole("navigation", { name: "Loops" });
  const table = screen.getByRole("table", { name: "Crew" });
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent),
  ).toEqual(["Agent", "State", "Work", "Tokens", "Cost", "Context", "In state"]);
  expect(within(table).getAllByRole("row")).toHaveLength(6);
  const rendered = rowsIn(container);
  expect(rendered.map((row) => row.querySelector(".rowlink")?.textContent)).toEqual([
    "FLIGHT",
    "need",
    "running",
    "parked",
    "free",
  ]);
  const strip = screen.getByRole("navigation", { name: "Loops" });
  expect(
    within(strip)
      .getAllByRole("link")
      .map((a) => a.querySelector(".ellip")?.textContent),
  ).toEqual(["observed-running · Implementing", "observed-waiting · Implementing"]);
  for (const row of rendered) {
    expect(row.querySelector(".agent-identity")?.getAttribute("title")).toContain("opus");
    expect(row.lastElementChild?.textContent).toContain("25m");
    expect(row.querySelector(".state-cell")?.textContent).not.toContain("25m");
    expect(row.textContent).toContain("#3349");
    expect(row.querySelectorAll(".doing, .need")).toHaveLength(
      row.querySelector(".rowlink")?.textContent === "need" ? 1 : 0,
    );
    const name = row.querySelector(".rowlink")?.textContent;
    // The Loop column is gone from the roster: no step bar, and no Model column either.
    expect(row.querySelector(".loopstep, .stepbar, .agent-model")).toBeNull();
    expect(name).toBeTruthy();
    expect(row.querySelector(".spark")).toBeTruthy();
    expect(row.querySelector(".tok")?.textContent).toContain("40/min");
    expect(row.textContent).toContain("~$2.47");
    expect(row.querySelectorAll(".meter")).toHaveLength(1);
  }
  expect(container.querySelector("details, summary, .agent-group, .scroll")).toBeNull();
  expect(screen.queryByText("Run details")).toBeNull();
  expect(screen.queryByText(/^Crew ·/)).toBeNull();
  expect(container.querySelector("#agentsP .ph .meter")).toBeNull();
});

it("keeps a long latest message clipped inside its Crew Work cell", async () => {
  const latestMessage = "evidence note ".repeat(55);
  stub([seatRow({ hudState: "blocked", note: latestMessage })]);
  const { container } = render(<AgentsPanel />);

  await screen.findByText("guido-1");
  const work = [...container.querySelectorAll<HTMLElement>(".ticket-cell")].find(
    (cell) => cell.querySelector<HTMLElement>("[title]")?.title === latestMessage,
  );
  expect(work?.classList.contains("ticket-cell")).toBe(true);
  expect(work?.classList.contains("work-cell")).toBe(true);
  expect(work?.querySelector("[title]")?.classList.contains("ellip")).toBe(true);
  expect(
    screen.getByRole("table", { name: "Crew" }).querySelectorAll("[role=columnheader]"),
  ).toHaveLength(7);
});

it("names and confirms the waiver for a review-parked seat", async () => {
  const loop = {
    phase: "parked" as const,
    text: "Blocked: RETRO finding",
    prNumber: 9,
    parked: "RETRO finding",
  };
  const row = seatRow({ hudState: "parked", loop, ticket: "shop-app#9" });
  const f = stub([row], true, [], "CI", undefined, {
    "/api/runs/r-12/loop": {
      loop: {
        parked: { kind: "review", reason: "RETRO finding", ended: false },
        pushFor: "abc1234def",
      },
    },
    "POST /api/runs/r-12/resume": { ok: true },
  });
  render(<AgentsPanel />);
  const waive = await screen.findByRole("button", { name: "Waive findings on abc1234 and resume" });
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  fireEvent.click(waive);
  expect(f.mock.calls.some(([path]) => path === "/api/runs/r-12/resume")).toBe(false);
  fireEvent.click(waive);
  await waitFor(() =>
    expect(f.mock.calls.some(([path]) => path === "/api/runs/r-12/resume")).toBe(true),
  );
  confirm.mockRestore();
});

it("waives the run chosen from the menu when a seat has several review-parked runs", async () => {
  const loop = (reason: string) => ({
    phase: "parked" as const,
    text: reason,
    prNumber: 9,
    parked: reason,
  });
  const park = (sha: string, reason: string) => ({
    loop: { parked: { kind: "review", reason, ended: false }, pushFor: sha },
  });
  const run = seatRow().run as NonNullable<CrewRow["run"]>;
  const row = seatRow({
    hudState: "parked",
    loop: loop("first"),
    run: { ...run, id: "r-20" },
    asideRuns: ["r-21", "r-22"].map((runId) => ({
      runId,
      ticket: null,
      ticketTitle: null,
      loop: loop("aside"),
    })),
  });
  const f = stub([row], true, [], "CI", undefined, {
    "/api/runs/r-20/loop": park("aaa1111000", "finding on r-20"),
    "/api/runs/r-21/loop": park("bbb2222000", "finding on r-21"),
    "/api/runs/r-22/loop": park("ccc3333000", "finding on r-22"),
    "POST /api/runs/r-20/resume": { ok: true },
    "POST /api/runs/r-21/resume": { ok: true },
    "POST /api/runs/r-22/resume": { ok: true },
  });
  render(<AgentsPanel />);
  const menu = await screen.findByRole("combobox", { name: /Waive review findings/ });
  const resumed = () =>
    f.mock.calls.filter(([path]) => String(path).endsWith("/resume")).map(([path]) => path);
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  fireEvent.change(menu, { target: { value: "r-21" } });
  expect(resumed()).toEqual([]);
  fireEvent.change(menu, { target: { value: "r-21" } });
  await waitFor(() => expect(resumed()).toEqual(["/api/runs/r-21/resume"]));
  expect(confirm.mock.calls[1]?.[0]).toContain("bbb2222");
  expect(confirm.mock.calls[1]?.[0]).toContain("finding on r-21");
  confirm.mockRestore();
});

it("shows a need and its action inline, leaves a quiet row clear, and keeps row navigation", async () => {
  stub([seatRow({ id: "need" }), seatRow({ id: "quiet" })]);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("quiet");
  const needy = rowsIn(container)[1] as HTMLElement;
  const quiet = rowsIn(container)[2] as HTMLElement;
  expect(needy.querySelector(".need")?.textContent).toContain("Decision for you");
  fireEvent.click(within(needy).getByRole("button", { name: "Answer" }));
  expect(window.location.pathname).toBe("/");
  expect(quiet.querySelector(".need")).toBeNull();
  fireEvent.click(quiet);
  expect(window.location.pathname).toBe("/agent/quiet");
});

it("says in words that an observed loop needs you, in the Loops strip", async () => {
  stub([crewRow({ id: "need" })], true, [item({ agentId: "need", ticket: null })]);
  render(<AgentsPanel />);
  const link = await screen.findByRole("link", { name: /need.*needs you/ });
  expect(link.className).toContain("tone-warn");
  expect(link.getAttribute("href")).toBe("/agent/need");
});

it.each(["stopped", "flight"])("keeps needs visible for a %s agent", async (kind) => {
  const row = seatRow({ id: kind === "flight" ? "flight" : "need", hudState: "stopped" });
  stub([row], true, [item({ agentId: row.id, ticket: null })]);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("Decision for you");
  expect(container.querySelector("details")).toBeNull();
  const answer = screen.getByRole("button", { name: "Answer" });
  expect(answer.classList.contains("sm")).toBe(true);
  expect(answer.classList.contains("primary")).toBe(false);
});

it("shows Tagged you and Read unless an ask supplies the need action", async () => {
  stub([seatRow({ id: "tag" }), seatRow({ id: "ask" })], true, [
    item({ key: "tag:1", agentId: "tag", ticket: null, kind: "tag" }),
    item({ key: "tag:2", agentId: "ask", ticket: null, kind: "tag" }),
    item({ key: "ask:1", agentId: "ask", ticket: null }),
  ]);
  render(<AgentsPanel />);
  await screen.findByText("Tagged you");
  expect(screen.getAllByRole("button", { name: "Read" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Answer" })).toHaveLength(1);
});

it("keeps live tool prose in the row tooltip and only the loop node in the cell", async () => {
  const tool = { name: "Bash", detail: "pnpm test", since: NOW - 65_000 };
  stub([
    seatRow({
      digest: { ...digest([]), liveTool: tool },
      loop: { phase: "working", text: "Working", prNumber: null, parked: null },
    }),
  ]);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("guido-1");
  const row = rowsIn(container)[1];
  expect(row?.querySelector(".process-line, .doing")).toBeNull();
});

it("labels Context, leaves quota in Systems and preserves paused state", async () => {
  stub(
    [
      seatRow({ id: "a", digest: digest([]), contextWindow: 1000, hudState: "idle", run: null }),
      seatRow({ id: "b" }),
    ],
    false,
  );
  const { container } = render(<AgentsPanel />);
  await screen.findByText("ctx 40%");
  expect(screen.queryByText("14%")).toBeNull();
  const paused = await screen.findByText("Idle");
  expect(paused.closest(".state-cell")?.getAttribute("title")).toBe("Crew is paused");
  expect(paused.closest<HTMLElement>(".trow")?.title).toBe("Crew is paused");
  expect(paused.closest(".trow")?.querySelector(".doing")).toBeNull();
  expect(rowsIn(container)[1]?.lastElementChild?.textContent).toContain("25m");
});

it("keeps thirty idle minutes flat, excludes old/future buckets and shares the vertical scale", async () => {
  const end = Math.floor(NOW / MIN) * MIN;
  const quiet = digest([
    [end - 100 * MIN, 120],
    [end - 121 * MIN, 9999],
    [end + MIN, 9999],
  ]);
  expect(activityValues(quiet, NOW)).toHaveLength(30);
  expect(activityValues(quiet, NOW)).toEqual(Array(30).fill(0));
  stub([
    seatRow({ id: "quiet", digest: quiet }),
    seatRow({ id: "busy", digest: digest([[end, 1200]]) }),
  ]);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("quiet");
  const sparks = [...container.querySelectorAll("svg.spark")];
  expect(sparks).toHaveLength(2);
  expect(sparks.map((s) => s.getAttribute("data-max"))).toEqual(["1200", "1200"]);
  expect(container.textContent).toContain("0/min");
});

it.each([
  ["idle", "Watching"],
  ["running", "Thinking"],
  ["parked", "Held"],
  ["stopped", "Stopped"],
] as const)("FLIGHT %s is labelled %s", async (hudState, label) => {
  stub([seatRow({ id: "flight", hudState })]);
  const { container } = render(<AgentsPanel />);
  await within(container.querySelector(".flight") as HTMLElement).findByText(label);
});

it.each([
  ["running engine", () => seatRow({ id: "short-state", hudState: "running" }), "Running"],
  ["stalled engine", () => seatRow({ id: "short-state", hudState: "stalled" }), "Stalled"],
  ["blocked engine", () => seatRow({ id: "short-state", hudState: "blocked" }), "Blocked"],
  ["parked engine", () => seatRow({ id: "short-state", hudState: "parked" }), "Parked"],
  ["waiting engine", () => seatRow({ id: "short-state", hudState: "waiting" }), "Waiting"],
  ["idle engine", () => seatRow({ id: "short-state", hudState: "idle" }), "Idle"],
  ["free seat", () => seatRow({ id: "short-state", hudState: "idle", run: null }), "Free"],
  ["stopped engine", () => seatRow({ id: "short-state", hudState: "stopped" }), "Stopped"],
  ["error engine", () => seatRow({ id: "short-state", hudState: "error" }), "Error"],
  [
    "working loop",
    () =>
      seatRow({
        id: "short-state",
        hudState: "idle",
        loop: { phase: "working", text: "Working", prNumber: null, parked: null },
      }),
    "Idle",
  ],
  [
    "CI loop",
    () =>
      seatRow({
        id: "short-state",
        hudState: "idle",
        loop: { phase: "ci", text: "CI", prNumber: null, parked: null },
      }),
    "Watching",
  ],
  [
    "review loop",
    () =>
      seatRow({
        id: "short-state",
        hudState: "idle",
        loop: { phase: "review", text: "Review", prNumber: null, parked: null },
      }),
    "Review",
  ],
  [
    "parked loop",
    () =>
      seatRow({
        id: "short-state",
        hudState: "idle",
        loop: { phase: "parked", text: "Parked", prNumber: null, parked: "Waiting" },
      }),
    "Parked",
  ],
  [
    "done loop",
    () =>
      seatRow({
        id: "short-state",
        hudState: "idle",
        loop: { phase: "done", text: "Done", prNumber: null, parked: null },
      }),
    "Idle",
  ],
] as const)("renders a short one-word pill for %s", async (_name, makeRow, label) => {
  stub([makeRow()], true, []);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("short-state");
  const pill = rowsIn(container)[1]?.querySelector(".state-cell .pill");
  expect(pill?.textContent).toBe(label);
  expect(pill?.textContent).toMatch(/^\S+$/);
  expect(pill?.textContent?.length).toBeLessThanOrEqual(MAX_STATE_PILL_LENGTH);
});

it("renders the Overview crew-pause override as a short pill", async () => {
  stub([seatRow({ id: "short-state", hudState: "idle", run: null })], false, []);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("short-state");
  const pill = rowsIn(container)[1]?.querySelector(".state-cell .pill");
  expect(pill?.textContent).toBe("Idle");
  expect(pill?.textContent).toMatch(/^\S+$/);
  expect(pill?.textContent?.length).toBeLessThanOrEqual(MAX_STATE_PILL_LENGTH);
});

it.each([
  [1, "1 open ask ·"],
  [2, "2 open asks ·"],
])("counts FLIGHT's open asks in the coverage line: %s", async (count, text) => {
  stub(
    [seatRow({ id: "flight", hudState: "idle" })],
    true,
    Array.from({ length: count }, (_, i) =>
      item({ key: `ask-${i}`, kind: "decision", agentId: "need", ticket: null }),
    ),
  );
  render(<AgentsPanel />);
  await screen.findByText("Watching");
  const link = screen.getByRole("link", { name: "head agent" });
  await waitFor(() => expect(link.title).toContain(text));
});

it("keeps FLIGHT coverage, the latest decision and session turns on the head-agent link", async () => {
  stub([seatRow({ id: "flight", hudState: "idle" })]);
  render(<AgentsPanel />);
  await screen.findByText("Watching");
  const link = screen.getByRole("link", { name: "head agent" });
  await waitFor(() => expect(link.title).toContain("watching 1 · triaging"));
  expect(link.title).toContain("last action 3m ago (CI)");
  expect(link.title).toContain("next check within 5m");
  expect(link.title).toContain("Asked GUIDO to check CI");
  expect(link.title).toContain("Turns this session: 3");
  expect(link.getAttribute("href")).toBe("/flight");
});

it.each(["running", "stalled"] as const)(
  "omits next check while FLIGHT is %s mid-turn",
  async (hudState) => {
    stub([seatRow({ id: "flight", hudState })]);
    render(<AgentsPanel />);
    await screen.findByText("Thinking");
    expect(screen.getByRole("link", { name: "head agent" }).title).not.toContain("next check");
  },
);

it.each([
  [80, "hi"],
  [100, "full"],
] as const)("colours context at %s%% with %s", async (pct, level) => {
  stub(
    [seatRow({ digest: { ...digest([]), contextTokens: pct * 10 }, contextWindow: 1000 })],
    true,
    [],
    "CI",
    [limit5h({ used: pct })],
  );
  const { container } = render(<AgentsPanel />);
  await screen.findByText(`ctx ${pct}%`);
  const meters = rowsIn(container)[1]?.querySelectorAll(".meter");
  expect(meters).toHaveLength(1);
  for (const meter of meters ?? []) expect(meter.classList.contains(level)).toBe(true);
});

it("keeps full text in titles on compact row labels and doing lines", async () => {
  const role = "builder-with-a-long-role";
  const loop = {
    phase: "working" as const,
    profile: "feature",
    step: "implement",
    text: "Implementing",
    prNumber: null,
    parked: null,
  };
  stub([seatRow({ id: "running", role, mode: "writer", loop })]);
  const { container } = render(<AgentsPanel />);
  await screen.findByText(role);
  const labels = container.querySelectorAll<HTMLElement>(
    ".trow.head > span, .agent-identity > :nth-child(2), .state-cell .pill > span, .doing",
  );
  expect(labels.length).toBeGreaterThan(8);
  for (const label of labels) {
    const title = label.closest<HTMLElement>("[title]")?.title;
    expect(title, label.outerHTML).toContain(label.textContent);
  }
});

it("uses the live FLIGHT seat while config is unavailable, without a duplicate or loading row", async () => {
  stub(
    [
      seatRow({ id: "flight-1", digest: digest([]), contextWindow: 1000 }),
      seatRow({ id: "guido-1" }),
    ],
    true,
    [],
    "CI",
    [],
    {
      "/api/config": () => ({ status: 503, body: { error: "loading" } }),
      "/api/flight": { seat: { id: "flight-1", turns: { n: 23, max: 41 } }, decisions: [] },
    },
  );
  const { container } = render(<AgentsPanel />);
  await screen.findByText("guido-1");
  await waitFor(() => expect(rowsIn(container)).toHaveLength(2));
  const flight = rowsIn(container)[0] as HTMLElement;
  expect(flight.querySelector(".rowlink")?.textContent).toBe("FLIGHT");
  expect(flight.querySelector(".agent-identity")?.getAttribute("title")).toContain("opus");
  expect(flight.lastElementChild?.getAttribute("title")).toContain("Turns this session: 23");
  expect(flight.textContent).toContain("~$2.47");
  expect(flight.textContent).toContain("ctx 40%");
  expect(container.textContent).not.toContain("Loading…");
  expect(screen.queryByText("flight-1")).toBeNull();
});

it("keeps a second Work line for free seats", async () => {
  stub([seatRow({ id: "free", hudState: "idle", run: null, ticket: null, loop: null })], true, []);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("free");
  const row = rowsIn(container)[1] as HTMLElement;
  expect(row.querySelector(".ticket-cell > :first-child")?.textContent).toBe("Free for work");
  expect(row.querySelector(".doing, .need")).toBeNull();
  expect(container.querySelector("#agentsList")?.classList.contains("no-steps")).toBe(false);
});

it("keeps seven cells with the need on the second Work line", async () => {
  stub([
    seatRow({
      id: "need",
      loop: {
        phase: "working",
        text: "Implementing",
        step: "implement",
        prNumber: null,
        parked: null,
      },
    }),
  ]);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("Decision for you");
  const row = rowsIn(container)[1] as HTMLElement;
  expect(row.querySelectorAll(".doing, .need")).toHaveLength(1);
  expect(row.querySelector(".need")?.parentElement).toBe(row.querySelector(".ticket-cell"));
  expect(within(row).getAllByRole("cell")).toHaveLength(7);
  expect(row.querySelector(".need")?.getAttribute("aria-colspan")).toBeNull();
});

it("retains a stale quota reading with its age and the collector note", async () => {
  stub(
    [seatRow({ id: "a" })],
    true,
    [],
    "CI",
    [limit5h({ used: 86, stale: true, sampledAt: NOW - 8 * 60 * MIN })],
    {
      "/api/health": [
        {
          collector: "usage:claude-main",
          ok: false,
          error: "Rate limited; retry later",
          at: NOW,
          lastOkAt: NOW - 8 * 60 * MIN,
        },
      ],
    },
  );
  const { container } = render(
    <QuotaMeter
      row={limit5h({ used: 86, stale: true, sampledAt: NOW - 8 * 60 * MIN })}
      now={NOW}
      compact
    />,
  );
  await screen.findByText("86%");
  expect(
    container.querySelector('[title*="Last reading 8h 0m ago"]')?.classList.contains("stale"),
  ).toBe(true);
  await waitFor(() =>
    expect(container.querySelector('[title*="Rate limited; retry later"]')).toBeTruthy(),
  );
});

it("advances the 30 minute window and live indicator with the panel clock", async () => {
  const end = Math.floor(NOW / MIN) * MIN;
  expect(
    activityValues(
      digest([
        [end - 29 * MIN, 7],
        [end, 90],
      ]),
      NOW,
    )[0],
  ).toBe(7);
  expect(
    activityValues(
      digest([
        [end - 29 * MIN, 7],
        [end, 90],
      ]),
      NOW + MIN,
    )[0],
  ).toBe(0);
  expect(activityLive(digest([[end, 90]]), end + 59_999)).toBe(true);
  expect(activityLive(digest([[end, 90]]), end + MIN)).toBe(false);
  expect(activityLive(digest([]), NOW)).toBe(false);

  stub([seatRow({ id: "live", digest: digest([[end, 90]]), lastOutputAt: null })], true, []);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("live");
  expect(screen.getByRole("img", { name: "Live token activity" })).toBeTruthy();
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(61_000);
  });
  // The shared clock was subscribed before timers were faked; allow its next real tick.
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW + 61_000);
  await waitFor(() => expect(container.querySelector(".activity-live")).toBeNull(), {
    timeout: 2000,
  });
});

it("sorts working crew and observed loops by the last ten minutes and shares j/k order", async () => {
  const end = Math.floor(NOW / MIN) * MIN;
  const rows = [
    seatRow({
      id: "slow",
      index: 1,
      digest: digest([
        [end - MIN, 20],
        [end - 11 * MIN, 99999],
      ]),
    }),
    crewRow({ id: "fast-loop", index: 2, digest: digest([[end - 9 * MIN, 80]]) }),
    seatRow({ id: "flight", index: 9, hudState: "idle" }),
    seatRow({ id: "need", index: 4, hudState: "stopped" }),
    seatRow({ id: "idle", index: 0, hudState: "idle", loop: null }),
    crewRow({ id: "waiting", index: 5, hudState: "waiting" }),
    seatRow({ id: "stopped", index: 3, hudState: "stopped" }),
  ];
  stub(rows);
  const { container } = render(<AgentsPanel />);
  await screen.findByRole("navigation", { name: "Loops" });
  const order = rowsIn(container).map((r) => r.querySelector(".rowlink")?.textContent);
  expect(order).toEqual(["FLIGHT", "need", "slow", "idle", "stopped"]);
  const strip = within(screen.getByRole("navigation", { name: "Loops" }));
  expect(strip.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
    "/agent/fast-loop",
    "/agent/waiting",
  ]);
  const { nextAgent } = await import("../src/shell/selection.ts");
  // j/k keeps its own order, with the loops among the seats by activity
  const ids = ["flight", "need", "fast-loop", "slow", "waiting", "idle", "stopped"] as string[];
  for (let i = 0; i < ids.length; i++) {
    expect(
      nextAgent(
        rows,
        [item({ agentId: "need", ticket: null })],
        "all",
        ids[i] ?? null,
        1,
        "all",
        "flight",
        NOW,
      ),
    ).toBe(ids[(i + 1) % ids.length]);
  }
});

it("keeps the full model id, CLI version and effort in the identity tooltip", async () => {
  const base = seatRow();
  if (!base.run) throw new Error("fixture needs a run");
  stub(
    [
      seatRow({
        id: "model",
        run: { ...base.run, model: "claude-sonnet-5-5[1m]" },
        cli: { version: "2.1.302", effort: "high" },
      }),
    ],
    true,
    [],
  );
  const { container } = render(<AgentsPanel />);
  await screen.findByText("model");
  const row = rowsIn(container)[1];
  const title = row?.querySelector<HTMLElement>(".agent-identity")?.title;
  expect(title).toContain("claude-sonnet-5-5[1m]");
  expect(title).toContain("CLI 2.1.302");
  expect(title).toContain("high");
  expect(row?.querySelector(".agent-model")).toBeNull();
});

it.each(["idle", "parked", "stopped"] as const)(
  "keeps a quiet %s row to one line with prose in its title",
  async (hudState) => {
    stub([seatRow({ id: "quiet", hudState, paused: hudState === "parked" })], true, []);
    const { container } = render(<AgentsPanel />);
    await screen.findByText("quiet");
    const row = rowsIn(container)[1];
    expect(row?.querySelector(".doing, .need, .process-line")).toBeNull();
    expect(row?.title).toBeTruthy();
    expect(row?.children).toHaveLength(7);
  },
);

it.each([
  { hudState: "idle", run: null },
  { hudState: "idle" },
  { hudState: "stopped" },
  { hudState: "parked", paused: true },
  { hudState: "running", paused: true },
] satisfies Partial<CrewRow>[])(
  "marks inactive work as last without a title: %j",
  async (state) => {
    stub(
      [
        seatRow({
          id: "last-work",
          ticket: "shop-app#460",
          ticketTitle: "Old title",
          review: { prNumber: 524, state: "open" as const },
          ...state,
        }),
      ],
      true,
      [],
    );
    const { container } = render(<AgentsPanel />);
    await screen.findByText("last-work");
    const cell = rowsIn(container)[1]?.querySelector(".ticket-cell");
    expect(cell?.firstElementChild?.textContent).toBe("last #460 · PR #524");
    expect(cell?.classList.contains("muted")).toBe(true);
    expect(cell?.hasAttribute("title")).toBe(false);
  },
);

it.each(["running", "waiting", "parked", "blocked", "stalled"] as const)(
  "keeps full current work for %s",
  async (hudState) => {
    stub(
      [
        seatRow({
          id: "current-work",
          hudState,
          ticket: "shop-app#460",
          ticketTitle: "Current title",
          review: { prNumber: 524, state: "open" as const },
        }),
      ],
      true,
      [],
    );
    const { container } = render(<AgentsPanel />);
    await screen.findByText("current-work");
    const cell = rowsIn(container)[1]?.querySelector(".ticket-cell");
    expect(cell?.firstElementChild?.textContent).toBe("#460 · PR #524 · Current title");
    expect(cell?.classList.contains("muted")).toBe(false);
  },
);

it.each(["ci", "review", "parked"] as const)(
  "keeps current work while an idle engine is in %s",
  async (phase) => {
    stub(
      [
        seatRow({
          id: "waiting-work",
          hudState: "idle",
          loop: { phase, text: "Waiting", prNumber: 524, parked: null },
        }),
      ],
      true,
      [],
    );
    const { container } = render(<AgentsPanel />);
    await screen.findByText("waiting-work");
    expect(rowsIn(container)[1]?.querySelector(".ticket-cell > :first-child")?.textContent).toBe(
      "#3349 · PR #524 · Quote cache",
    );
  },
);

it.each([
  // no references: the status line leads, rather than a dash pushing it to the right edge
  { ticket: null, review: null, expected: "Run ended" },
  { ticket: "shop-app#460", review: null, expected: "last #460" },
  { ticket: null, review: { prNumber: 524, state: "open" as const }, expected: "last PR #524" },
])("handles inactive work references: $expected", async ({ expected, ...refs }) => {
  stub([seatRow({ id: "refs", hudState: "stopped", ...refs })], true, []);
  const { container } = render(<AgentsPanel />);
  await screen.findByText("refs");
  expect(rowsIn(container)[1]?.querySelector(".ticket-cell > :first-child")?.textContent).toBe(
    expected,
  );
});

it("highlights FLIGHT when j/k selects it", async () => {
  const rows = [seatRow({ id: "flight" }), seatRow({ id: "other" })];
  stub(rows, true, []);
  render(<AgentsPanel />);
  await screen.findByText("other");
  for (const dir of [1, -1] as const) {
    act(() => setSelectedAgent(nextAgent(rows, [], "all", "other", dir, "all", "flight", NOW)));
    expect(
      screen
        .getByRole("button", { name: "FLIGHT, open the dock" })
        .closest('[role="row"]')
        ?.classList.contains("sel"),
    ).toBe(true);
  }
  act(() => setSelectedAgent(null));
});

it("keeps working order stable during partial minute updates and retains index ties", () => {
  const end = Math.floor(NOW / MIN) * MIN;
  const rows = [
    seatRow({
      id: "a",
      index: 1,
      digest: digest([
        [end - 10 * MIN, 50],
        [end, 1],
      ]),
    }),
    seatRow({
      id: "b",
      index: 2,
      digest: digest([
        [end - MIN, 50],
        [end, 100],
      ]),
    }),
  ];
  expect(crewOrder(rows, [], NOW).map((r) => r.id)).toEqual(["a", "b"]);
  const second = rows[1];
  if (!second) throw new Error("missing fixture row");
  second.digest = digest([
    [end - MIN, 50],
    [end, 100000],
  ]);
  expect(crewOrder(rows, [], NOW + 1000).map((r) => r.id)).toEqual(["a", "b"]);
});

it.each([
  [60 * MIN, false],
  [60 * MIN + 1, true],
])("mutes a compact quota at age %s only after the stale limit", async (age, stale) => {
  stub([seatRow({ id: "a" })], true, [], "CI", [
    limit5h({ used: 86, stale: false, sampledAt: NOW - age }),
  ]);
  render(
    <QuotaMeter
      row={limit5h({ used: 86, stale: false, sampledAt: NOW - age })}
      now={NOW}
      compact
    />,
  );
  const reading = await screen.findByText("86%");
  expect(!!reading.closest(".stale")).toBe(stale);
});

it("uses engine state and loop phase for current work", () => {
  const row = seatRow({
    hudState: "idle",
    loop: { phase: "ci", text: "CI", prNumber: 1, parked: null },
  });
  expect(isCurrentWork(row)).toBe(true);
  expect(isCurrentWork({ ...row, paused: true })).toBe(false);
  expect(isCurrentWork({ ...row, hudState: "stopped" })).toBe(false);
  expect(isCurrentWork({ ...row, loop: null })).toBe(false);
});

it("mutes a fresh quota when its collector reports a note", async () => {
  stub(
    [seatRow({ id: "a" })],
    true,
    [],
    "CI",
    [limit5h({ used: 86, stale: false, sampledAt: NOW })],
    {
      "/api/health": [
        { collector: "usage:claude-main", ok: false, error: "Retry later", at: NOW, lastOkAt: NOW },
      ],
    },
  );
  render(
    <QuotaMeter row={limit5h({ used: 86, stale: false, sampledAt: NOW })} now={NOW} compact />,
  );
  const reading = await screen.findByText("86%");
  await waitFor(() => expect(reading.closest(".stale")).toBeTruthy());
});

it("does not light the token dot for output without digest token evidence", async () => {
  stub([seatRow({ id: "quiet", digest: digest([]), lastOutputAt: NOW - 1000 })], true, []);
  render(<AgentsPanel />);
  await screen.findByText("quiet");
  expect(screen.queryByRole("img", { name: "Live token activity" })).toBeNull();
});

it.each([
  [[], false],
  [["one", "one"], false],
  [["one", "two"], false],
])("keeps quota out of Crew regardless of visible accounts: %j", async (accounts, hidden) => {
  stub(
    accounts.map((accountId, i) => seatRow({ id: i === 0 ? "flight" : `seat-${i}`, accountId })),
  );
  const { container } = render(<AgentsPanel />);
  await waitFor(() => expect(container.textContent).not.toContain("Loading…"));
  expect(container.querySelector("#agentsList")?.classList.contains("no-quota")).toBe(hidden);
});

it.each(["blocked", "parked", "stopped", "idle"] as const)(
  "has no loop column or step bar for a %s seat",
  async (hudState) => {
    stub(
      [
        seatRow({
          id: "guido-cx",
          hudState,
          paused: true,
          loop: { phase: "parked", text: "Blocked", prNumber: null, parked: "Waiting" },
        }),
      ],
      true,
      [],
    );
    const { container } = render(<AgentsPanel />);
    await screen.findByText("guido-cx");
    expect(container.querySelector(".loopstep, .stepbar")).toBeNull();
    expect(
      [...container.querySelectorAll("[role=columnheader]")].map((h) => h.textContent),
    ).not.toContain("Loop");
  },
);

it.each(["idle", "running", "stopped"] as const)(
  "shows FLIGHT's crew pause while %s",
  async (hudState) => {
    stub([
      seatRow({
        id: "flight",
        hudState,
        crewPause: {
          seats: ["flight"],
          reason: "Save tokens",
          at: NOW,
          by: "operator",
        },
      }),
    ]);
    const { container } = render(<AgentsPanel />);
    const row = container.querySelector(".flight") as HTMLElement;
    await within(row).findByText("Paused");
    expect(row.querySelector(".state-cell")?.getAttribute("title")).toBe("Save tokens");
    expect(within(row).getByText("head agent").getAttribute("title")).toContain(
      "next check paused",
    );
  },
);

it("keeps a parked FLIGHT reason in the Overview state tooltip", async () => {
  stub([seatRow({ id: "flight", hudState: "parked", note: "Needs operator approval" })]);
  const { container } = render(<AgentsPanel />);
  const row = container.querySelector(".flight") as HTMLElement;
  await within(row).findByText("Held");
  expect(row.querySelector(".state-cell")?.getAttribute("title")).toBe("Needs operator approval");
});
