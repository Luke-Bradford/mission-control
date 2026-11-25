import type { AgentDetailView } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { hub, RESOURCES, RUNS_LIMIT } from "../src/data.ts";
import { kTokens, percent } from "../src/fmt.ts";
import { contextCapacity } from "../src/overview/ContextCapacity.tsx";
import { Agent } from "../src/pages/Agent.tsx";
import { agentDraftKey } from "../src/storage.ts";
import { rosterRows } from "./agentRosterFixture.ts";
import { agentView, populatedAgentView } from "./agentV2Fixture.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, crewRow, run } from "./fixtures.ts";

const MIN = 60_000;

function setup(view = populatedAgentView(), extra: Record<string, unknown> = {}) {
  const fetch = stubFetch({
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: [view.row], firstRunToday: null },
    [RESOURCES.agentDetail(view.row.id).path]: view,
    "/api/attention": [],
    [RESOURCES.runs(view.row.id).path]: [],
    [RESOURCES.stream(view.row.id).path]: {
      runId: view.row.run?.id,
      events: [],
      tasks: [],
      more: false,
      truncated: false,
    },
    ...extra,
  });
  const rendered = render(<Agent id={view.row.id} />);
  return { ...rendered, fetch };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("lays out the roster, identity band, instruments, activity and right column", async () => {
  setup();
  await screen.findByRole("region", { name: "guido-1 details" });
  expect(screen.getByRole("complementary", { name: "Crew roster" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Instruments" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Activity" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Waiting on" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Plan, recent runs, tokens and setup" })).toBeTruthy();
  // What this replaces is gone.
  expect(screen.queryByText("Ask → result → next")).toBeNull();
  expect(screen.queryByRole("region", { name: "Next move" })).toBeNull();
  expect(screen.queryByText("Deliverables")).toBeNull();
});

it("shows Silent for a working seat quiet for ten minutes, and not before", async () => {
  const quiet = (ago: number) => {
    const view = populatedAgentView();
    view.row.hudState = "running";
    view.row.lastOutputAt = Date.now() - ago;
    return view;
  };
  const first = setup(quiet(11 * MIN));
  const band = await first.findByRole("region", { name: "guido-1 details" });
  expect(within(band).getByText(/Silent · 1[01]m/)).toBeTruthy();
  first.unmount();
  const second = setup(quiet(2 * MIN));
  const calm = await second.findByRole("region", { name: "guido-1 details" });
  expect(within(calm).queryByText(/Silent/)).toBeNull();
  expect(within(calm).getByText("last output 2m ago")).toBeTruthy();
});

it("shows why a stopped seat is stopped", async () => {
  const view = populatedAgentView();
  view.row.hudState = "stopped";
  view.row.run = null;
  view.row.crewPause = {
    seats: "all",
    by: "CAPCOM",
    reason: "Claude weekly limit, resets Wed 02:00",
    at: 1,
  };
  setup(view);
  const band = await screen.findByRole("region", { name: "guido-1 details" });
  expect(within(band).getByText(/Claude weekly limit, resets Wed 02:00/)).toBeTruthy();
});

it("says a seat with no ticket is free to take the next one", async () => {
  const view = agentView(
    crewRow({
      id: "guido-1",
      kind: "crew",
      mode: "writer",
      run: null,
      ticket: null,
      hudState: "idle",
    }),
  );
  setup(view);
  expect(
    await screen.findByText("No ticket. Free to take the next Ready ticket in its area."),
  ).toBeTruthy();
  expect(screen.getByText("No run in progress. Recent runs lists the earlier ones.")).toBeTruthy();
});

it("labels a free seat's ticket as its last run, and FLIGHT's line says it watches", async () => {
  setup(
    agentView(
      crewRow({
        id: "guido-1",
        kind: "crew",
        run: null,
        ticket: "shop-app#3349",
        ticketTitle: "Fix checkout",
        hudState: "idle",
      }),
    ),
  );
  const band = await screen.findByRole("region", { name: "guido-1 details" });
  expect(within(band).getByText("Last run:")).toBeTruthy();
  cleanup();
  setup(agentView(crewRow({ id: "flight", role: "FLIGHT", run: null, ticket: null })));
  expect(await screen.findByText("Watching the crew.")).toBeTruthy();
  expect(screen.queryByText(/Free to take the next Ready ticket/)).toBeNull();
});

it("names the effort and CLI version once in the identity strip", async () => {
  const view = populatedAgentView();
  view.row.cli = { ...view.row.cli, effort: "high", version: "2.1.0" };
  setup(view);
  const band = await screen.findByRole("region", { name: `${view.row.id} details` });
  const strip = band.querySelector(".idb-strip")?.textContent ?? "";
  expect(strip.match(/high/g)).toHaveLength(1);
  expect(strip.match(/2\.1\.0/g)).toHaveLength(1);
});

it("Interrupt shows sent, then confirmed; a refusal shows its reason", async () => {
  const view = populatedAgentView();
  view.row.hudState = "running";
  view.row.loop = null;
  let fail = false;
  const { fetch } = setup(view, {
    "POST /api/seats/guido-1/interrupt": () =>
      fail ? { status: 409, body: { error: "Seat is between turns" } } : { status: 200, body: {} },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Interrupt" }));
  expect(await screen.findByText("Interrupt: confirmed")).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith("/api/seats/guido-1/interrupt", expect.anything());
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
  expect(await screen.findByText("Interrupt failed: Seat is between turns")).toBeTruthy();
});

it("Stop asks once, naming the seat, and does nothing when declined", async () => {
  const view = populatedAgentView();
  view.row.hudState = "running";
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const { fetch } = setup(view, { "POST /api/seats/guido-1/end": {} });
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(String(confirm.mock.calls[0]?.[0])).toContain("GUIDO-1");
  expect(fetch).not.toHaveBeenCalledWith("/api/seats/guido-1/end", expect.anything());
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByText("Stop: confirmed")).toBeTruthy();
});

it("Assign is refused mid-turn, with the reason", async () => {
  const view = populatedAgentView();
  view.row.hudState = "running";
  setup(view);
  const assign = await screen.findByRole("button", { name: "Assign" });
  expect((assign as HTMLButtonElement).disabled).toBe(true);
  expect(assign.getAttribute("title")).toContain("Mid-turn");
});

it("keeps a typed message over a refresh and a change of seat, then shows it sent and read", async () => {
  const view = populatedAgentView();
  view.row.run = null;
  view.row.hudState = "idle";
  const first = setup(view, { "POST /api/seats/guido-1/message": {} });
  const box = (await screen.findByRole("textbox", {
    name: "Message this agent",
  })) as HTMLInputElement;
  fireEvent.change(box, { target: { value: "please rebase" } });
  expect(localStorage.getItem(agentDraftKey("guido-1"))).toBe("please rebase");
  first.unmount();
  setup(view, { "POST /api/seats/guido-1/message": {} });
  const again = (await screen.findByRole("textbox", {
    name: "Message this agent",
  })) as HTMLInputElement;
  expect(again.value).toBe("please rebase");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.getByText("sent")).toBeTruthy());
  expect(localStorage.getItem(agentDraftKey("guido-1"))).toBe("");
});

it("every figure has a definition, and Codex cost is never $0", async () => {
  const view = populatedAgentView();
  view.row.accountId = "codex-main";
  const { container } = setup(view, {
    "/api/config": {
      ...CONFIG,
      accounts: [...CONFIG.accounts, { id: "codex-main", vendor: "codex" }],
    },
  });
  await screen.findByRole("region", { name: "Instruments" });
  const defs = container.querySelectorAll(".fig .fig-def");
  expect(defs.length).toBeGreaterThanOrEqual(4);
  for (const d of defs) expect((d.textContent ?? "").length).toBeGreaterThan(10);
  fireEvent.click(screen.getByRole("button", { name: "All time" }));
  const cost = await screen.findByText("Cost");
  expect(cost.closest(".fig")?.textContent).toContain("not recorded");
  expect(cost.closest(".fig")?.textContent).not.toContain("$0");
});

it("shows a named initial error and retries the same agent", async () => {
  const view = populatedAgentView();
  const { fetch } = setup(view, {
    [RESOURCES.agentDetail(view.row.id).path]: () => ({
      status: 503,
      body: { error: "Unavailable" },
    }),
  });
  expect(await screen.findByText("Could not load this agent.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry agent" }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(([path]) => path === RESOURCES.agentDetail(view.row.id).path).length,
    ).toBeGreaterThan(1),
  );
});

it("preserves the previous view with a stale reason and refreshes it", async () => {
  let current: AgentDetailView | null = populatedAgentView();
  const row = current.row;
  setup(current, {
    [RESOURCES.agentDetail(row.id).path]: () =>
      current
        ? { status: 200, body: current }
        : { status: 503, body: { error: "API unavailable" } },
  });
  await screen.findByRole("region", { name: "guido-1 details" });
  current = null;
  act(() => hub.refetchCrew(row.id));
  expect(await screen.findByText(/Showing the last saved agent view/)).toBeTruthy();
});

it("says so and shows the first seat when the chosen seat was removed", async () => {
  const view = populatedAgentView();
  stubFetch({
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: [view.row], firstRunToday: null },
    [RESOURCES.agentDetail(view.row.id).path]: view,
    "/api/attention": [],
    [RESOURCES.runs(view.row.id).path]: [],
    [RESOURCES.stream(view.row.id).path]: {
      runId: null,
      events: [],
      tasks: [],
      more: false,
      truncated: false,
    },
  });
  render(<Agent id="gone-9" />);
  expect(await screen.findByText(/gone-9 is no longer a seat/)).toBeTruthy();
  expect(await screen.findByRole("region", { name: "guido-1 details" })).toBeTruthy();
});

it("says there are no seats, with a way to add one", async () => {
  stubFetch({
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: [], firstRunToday: null },
    "/api/attention": [],
  });
  render(<Agent id={null} />);
  expect(await screen.findByText(/No seats yet/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Add one in Setup" })).toBeTruthy();
});

it("opens on Recent runs when no run is in progress, and Setup links to Setup", async () => {
  const view = populatedAgentView();
  view.row.run = null;
  view.row.hudState = "idle";
  setup(view);
  const side = await screen.findByRole("region", { name: "Plan, recent runs, tokens and setup" });
  expect(
    within(side).getByRole("button", { name: "Recent runs" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(within(side).getByRole("button", { name: "Setup" }));
  expect(within(side).getByRole("link", { name: "Edit in Setup" })).toBeTruthy();
});

const TURNS = [
  { input: 300, output: 120, cacheRead: 9000 },
  { input: 280, output: 400, cacheRead: 12_000 },
];

it("shows tokens per turn for the seat's latest run on its Tokens tab", async () => {
  const view = populatedAgentView();
  const id = view.row.id;
  const { fetch } = setup(view, {
    [RESOURCES.telemetry("1h", id).path]: { turnUsage: [{ agentId: id, turns: TURNS }] },
  });
  const side = await screen.findByRole("region", {
    name: "Plan, recent runs, tokens and setup",
  });
  fireEvent.click(within(side).getByRole("button", { name: "Tokens" }));
  await within(side).findByText(`${id} · latest run · tokens per turn`);
  // two turns × three kinds
  expect(side.querySelectorAll("path.bar")).toHaveLength(6);
  expect([...side.querySelectorAll(".legend span")].map((x) => x.textContent)).toEqual([
    "input",
    "output",
    "cache read",
  ]);
  const hits = within(side).getByRole("img").querySelectorAll("rect.hit");
  TURNS.forEach((turn, i) => {
    fireEvent.pointerEnter(hits[i] as Element);
    expect(side.querySelector(".tip")?.textContent).toBe(
      `turn ${i + 1}cache read${kTokens(turn.cacheRead)}output${kTokens(turn.output)}input${kTokens(turn.input)}`,
    );
  });
  // asked for this seat only
  expect(fetch).toHaveBeenCalledWith(`/api/telemetry?range=1h&agent=${id}`, expect.anything());
});

it("says so when the seat has no turns recorded", async () => {
  const view = populatedAgentView();
  const id = view.row.id;
  setup(view, {
    [RESOURCES.telemetry("1h", id).path]: { turnUsage: [{ agentId: id, turns: [] }] },
  });
  const side = await screen.findByRole("region", {
    name: "Plan, recent runs, tokens and setup",
  });
  fireEvent.click(within(side).getByRole("button", { name: "Tokens" }));
  await within(side).findByText(`No turns recorded for ${id} yet.`);
});

it("the context percent is the Overview's figure for the same seat", async () => {
  const view = populatedAgentView();
  const row = view.row;
  row.hudState = "running";
  row.contextWindow = 200_000;
  const digest = rosterRows(1)[0]?.digest;
  if (!digest) throw new Error("fixture has no digest");
  row.digest = { ...digest, contextTokens: 104_300 };
  const { container } = setup(view);
  const ring = await screen.findByRole("img", { name: /^Context \d+% used$/ });
  const overview = percent(contextCapacity(row).pct);
  expect(ring.getAttribute("aria-label")).toBe(`Context ${overview} used`);
  expect(container.querySelector(".inst.ctx .inst-big")?.textContent).toBe(overview);
});

it("says the all-time figures cover only the newest runs once the list is full", async () => {
  const view = populatedAgentView();
  const runs = Array.from({ length: RUNS_LIMIT }, (_, i) => ({
    ...run({
      id: `r-${i}`,
      seq: i,
      startedAt: 1_000_000 * (i + 1),
      endedAt: 1_000_000 * (i + 1) + 60_000,
    }),
    ticket: `shop-app#${i}`,
  }));
  setup(view, { [RESOURCES.runs(view.row.id).path]: runs });
  await screen.findByRole("region", { name: "Instruments" });
  fireEvent.click(screen.getByRole("button", { name: "All time" }));
  const figure = async (label: string) => (await screen.findByText(label)).closest(".fig");
  const runsFig = await figure("Runs");
  expect(runsFig?.textContent).toContain(`${RUNS_LIMIT}+`);
  expect(runsFig?.textContent).not.toContain("first");
  expect(runsFig?.textContent).toContain(`last ${RUNS_LIMIT} runs`);
  expect((await figure("Tickets"))?.textContent).toContain(`last ${RUNS_LIMIT} runs`);
});

it("keeps exact all-time figures when the run list is short", async () => {
  const view = populatedAgentView();
  setup(view, {
    [RESOURCES.runs(view.row.id).path]: [
      run({ id: "r-1", endedAt: 2_000_000, startedAt: 1_000_000 }),
    ],
  });
  await screen.findByRole("region", { name: "Instruments" });
  fireEvent.click(screen.getByRole("button", { name: "All time" }));
  const runsFig = (await screen.findByText("Runs")).closest(".fig");
  expect(runsFig?.textContent).not.toContain("+");
  expect(runsFig?.textContent).not.toContain("last");
});

it("shows the whole summary in the band and toggles it on click", async () => {
  const view = populatedAgentView();
  view.row.summary = "First line of the summary.\nSecond line goes on and on.\nThird line ends.";
  setup(view);
  const button = await screen.findByRole("button", { name: /In its words/ });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(button.textContent).toContain("Second line goes on and on.");
  expect(button.textContent).toContain("Third line ends.");
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(button.className).toContain("open");
});

function idleSetup(
  events: { id: string; at: number; kind: "op"; text: string }[],
  lastOutputAt?: number,
) {
  const view = populatedAgentView();
  view.row.run = null;
  view.row.hudState = "idle";
  if (lastOutputAt !== undefined) view.row.lastOutputAt = lastOutputAt;
  return setup(view, {
    "POST /api/seats/guido-1/message": {},
    [RESOURCES.stream("guido-1").path]: {
      runId: "r-old",
      events,
      tasks: [],
      more: false,
      truncated: false,
    },
  });
}

async function sendFromBox(text: string) {
  const box = (await screen.findByRole("textbox", {
    name: "Message this agent",
  })) as HTMLInputElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

it("does not hide a new message because an older operator row contains its text", async () => {
  idleSetup([
    { id: "0:0", at: Date.now() - 3_600_000, kind: "op", text: "Please say yes when done" },
  ]);
  await sendFromBox("yes");
  await waitFor(() => expect(screen.getByText("sent")).toBeTruthy());
  // The mark is on the new row, not drawn on the older row that merely contains "yes".
  expect(screen.getByText("sent").closest(".ev")?.textContent).not.toContain("Please say yes");
});

it("changes sent to read on the row that carries the message once the seat writes after it", async () => {
  const sentAfter = Date.now() + 1_000;
  idleSetup([{ id: "1:0", at: sentAfter, kind: "op", text: "yes" }], Date.now() + 60_000);
  await sendFromBox("yes");
  await waitFor(() => expect(screen.getByText("read")).toBeTruthy());
  expect(screen.queryByText("sent")).toBeNull();
});
