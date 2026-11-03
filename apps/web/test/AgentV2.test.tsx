import type { AgentDetailView } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { Agent } from "../src/pages/Agent.tsx";
import { agentView, populatedAgentView } from "./agentV2Fixture.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, crewRow } from "./fixtures.ts";

function setup(view = populatedAgentView(), extra: Record<string, unknown> = {}) {
  const fetch = stubFetch({
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: [view.row], firstRunToday: null },
    [RESOURCES.agentDetail(view.row.id).path]: view,
    "/api/attention": [],
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
it("leads with the saved awaiting reason, owner, five figures and every profile step", async () => {
  const view = populatedAgentView();
  const { container } = setup(view);
  await screen.findByRole("region", { name: "guido-1 details" });
  expect(container.querySelector(".agent-v2-state")?.textContent).toContain("Review round 2 of 3");
  expect(screen.getByText("For the controller")).toBeTruthy();
  expect(container.querySelectorAll(".agent-v2-stat")).toHaveLength(5);
  expect(container.querySelectorAll(".agent-v2-steps li")).toHaveLength(6);
  expect(screen.getByText(/2 rounds of 3/)).toBeTruthy();
  expect(screen.getByText(/1 failure of 3 allowed/)).toBeTruthy();
  expect(container.querySelector(".agent-v2-stats")?.textContent).not.toContain("Quota");
  expect(container.querySelector(".agent-v2-stats")?.textContent).not.toContain("Speed");
  expect(container.querySelector(".agent-v2-stats")?.textContent).not.toContain("Now");
});
it("uses server-computed ownership and links without requesting every board or PR", async () => {
  const { fetch } = setup();
  await screen.findByText("For the controller");
  expect(
    screen.getByRole("link", { name: "PR #77 · Agent page v2" }).getAttribute("href"),
  ).toContain("/pull/77");
  const paths = fetch.mock.calls.map(([path]) => String(path));
  expect(paths.some((path) => path.includes("/boards") || path.includes("/prs?"))).toBe(false);
});
it("loads files and history only after opening them", async () => {
  const view = populatedAgentView();
  view.row.loop = null;
  const { fetch } = setup(view, {
    [RESOURCES.files(view.row.id).path]: { files: [], note: null },
    [RESOURCES.runs(view.row.id).path]: [],
  });
  await screen.findByRole("region", { name: "guido-1 details" });
  const asked = () => fetch.mock.calls.map(([path]) => String(path));
  expect(asked()).not.toContain(RESOURCES.files(view.row.id).path);
  expect(asked()).not.toContain(RESOURCES.runs(view.row.id).path);
  expect(asked()).not.toContain(RESOURCES.runLoop(view.row.run?.id ?? "").path);
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  await waitFor(() => expect(asked()).toContain(RESOURCES.files(view.row.id).path));
  const summary = screen.getByText("Attempts and previous runs"),
    details = summary.closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle", { bubbles: true }));
  await waitFor(() => expect(asked()).toContain(RESOURCES.runs(view.row.id).path));
});
it("keeps missing measurements distinct from zero and labels reported acceptance", async () => {
  const view = populatedAgentView();
  view.tools = { total: null, failed: null, byTool: [] };
  view.cost.totalUsd = 0;
  view.cost.meanPerReportedTurnUsd = 0;
  view.context.percent = null;
  const { container } = setup(view);
  await screen.findByText("Failures not recorded");
  expect(container.querySelector(".agent-v2-stats")?.textContent).toContain("$0.00");
  expect(screen.getByText(/checks reported met/)).toBeTruthy();
  expect(screen.getByText(/Left: Check the More menu/)).toBeTruthy();
});
it.each(["operator", "flight", "controller", "loop"] as const)(
  "names the %s next owner",
  async (owner) => {
    const view = populatedAgentView();
    if (view.nextMove) view.nextMove.owner = owner;
    const { container } = setup(view);
    await screen.findByRole("region", { name: "guido-1 details" });
    expect(container.querySelector(".agent-v2-next")?.textContent).toContain(
      {
        operator: "Your next move",
        flight: "Waiting on FLIGHT",
        controller: "For the controller",
        loop: "For this loop",
      }[owner],
    );
  },
);
it("keeps 50 deliverable links and exposes empty states without zero subagent tabs", async () => {
  const view = populatedAgentView();
  view.deliverables = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    kind: "file",
    label: `src/${"long/".repeat(20)}${i}.ts`,
    href: `/agent/guido-1?side=files&path=${i}`,
  }));
  const { container } = setup(view);
  await screen.findByRole("region", { name: "guido-1 details" });
  expect(container.querySelectorAll(".agent-v2-deliverables a")).toHaveLength(50);
  expect(screen.queryByRole("button", { name: "Subagents 0" })).toBeNull();
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
it("preserves the previous view with a stale reason and refreshes it without SSE", async () => {
  let current: AgentDetailView | null = populatedAgentView();
  const row = current.row;
  setup(current, {
    [RESOURCES.agentDetail(row.id).path]: () =>
      current
        ? { status: 200, body: current }
        : { status: 503, body: { error: "API unavailable" } },
  });
  await screen.findByText("For the controller");
  current = null;
  act(() => hub.refetchCrew(row.id));
  expect(await screen.findByText(/Showing the last saved agent view/)).toBeTruthy();
  current = populatedAgentView();
  current.awaiting.reason = "Refresh reached the new endpoint";
  fireEvent.click(screen.getByRole("button", { name: "Retry agent" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "guido-1 details" })).getByText(
        /Refresh reached the new endpoint/,
      ),
    ).toBeTruthy(),
  );
  expect(
    within(screen.getByRole("region", { name: "What is happening now?" })).getByText(
      /Refresh reached the new endpoint/,
    ),
  ).toBeTruthy();
});
it("keeps the composer and queue for a seat with no run", async () => {
  const view = agentView(
    crewRow({ id: "guido-1", kind: "crew", mode: "writer", run: null, ticket: null }),
  );
  setup(view);
  expect(await screen.findByRole("textbox", { name: "Message this agent" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
});
it("refreshes the Agent response after Interrupt without an SSE message", async () => {
  const view = populatedAgentView();
  view.row.hudState = "running";
  view.row.loop = null;
  let current = view;
  setup(view, {
    [RESOURCES.agentDetail(view.row.id).path]: () => ({ status: 200, body: current }),
    "POST /api/seats/guido-1/interrupt": () => {
      current = {
        ...view,
        awaiting: { ...view.awaiting, label: "Stopped", reason: "Interrupted by you" },
      };
      return { status: 200, body: {} };
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Interrupt" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "guido-1 details" })).getByText(
        /Interrupted by you/,
      ),
    ).toBeTruthy(),
  );
  expect(
    within(screen.getByRole("region", { name: "What is happening now?" })).getByText(
      /Interrupted by you/,
    ),
  ).toBeTruthy();
});

it("falls back to Plan for a link to an empty Subagents tab", async () => {
  window.history.replaceState(null, "", "/agent/guido-1?side=subs");
  setup();
  const side = await screen.findByRole("region", {
    name: "Plan, queue, subagents, files and context",
  });
  await waitFor(() =>
    expect(within(side).getByRole("button", { name: /^Plan/ }).getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
  expect(within(side).queryByRole("button", { name: /Subagents/ })).toBeNull();
});

it("keeps ask/result and the next decision before context without losing run or loop facts", async () => {
  const { container } = setup();
  await screen.findByRole("region", { name: "guido-1 details" });
  const story = screen.getByText("Ask → result → next").closest("section") as HTMLElement;
  const next = screen.getByRole("region", { name: "Next move" });
  const facts = screen.getByRole("region", { name: "Run figures" });
  expect(story.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(next.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.querySelectorAll(".agent-v2-stat")).toHaveLength(5);
  expect(container.querySelectorAll(".agent-v2-steps li")).toHaveLength(6);
});

it.each(["stopped", "idle"] as const)(
  "retains the oldest queued current-head review on a %s seat",
  async (state) => {
    const view = populatedAgentView();
    view.row.hudState = state;
    view.row.crewPause = { seats: "all", by: "CAPCOM", reason: "Account limit reached", at: 1 };
    view.row.queuedReview = {
      repoId: "shop-app",
      prNumber: 92,
      sha: "b".repeat(40),
      ref: "feature/92",
      position: 2,
      reason: "Waiting for this seat to resume",
    };
    view.awaiting = {
      label: state === "stopped" ? "Stopped" : "Crew paused",
      reason: "Account limit reached",
      since: 1,
    };
    view.row.reviewing = { prNumber: 90, sha: "a".repeat(40), ref: "review/90" };
    setup(view);
    const evidence = await screen.findByRole("link", { name: "Review evidence for this head" });
    expect(evidence.getAttribute("href")).toBe(`/qa?repo=shop-app&pr=92&head=${"b".repeat(40)}`);
    expect(screen.getByText("Waiting for this seat to resume")).toBeTruthy();
    expect(screen.getByText(/Assigned review PR #90/)).toBeTruthy();
    expect(screen.queryByText(/Checking PR #90/)).toBeNull();
  },
);

it.each(["original ask", "reported result", "current state reason"] as const)(
  "keeps every character of a long %s behind its named keyboard disclosure",
  async (label) => {
    const view = populatedAgentView();
    const full =
      "A recorded operator requirement with its complete reason and recovery evidence. ".repeat(30);
    if (label === "original ask") view.story.title = full;
    else if (label === "reported result") view.story.report = full;
    else view.awaiting.reason = full;
    setup(view);
    const read = await screen.findByRole("button", { name: `Read full ${label}` });
    expect(read.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(read);
    const region = screen.getByRole("region", { name: `Full ${label}` });
    expect(region.textContent).toBe(full);
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(read.getAttribute("aria-controls")).toBe(region.id);
  },
);
