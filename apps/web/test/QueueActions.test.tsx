import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SideTabs } from "../src/agent/SideTabs.tsx";
import { hub } from "../src/data.ts";
import { ItemPanel } from "../src/shell/ItemPanel.tsx";
import { closeItem, openItem } from "../src/shell/overlays.ts";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, brief, crewRow, item } from "./fixtures.ts";

const proposal = item({
  key: "note:queue-reorder:fiction",
  kind: "approval",
  agentId: null,
  escalationId: null,
  text: "Move shop-app#2 above shop-app#1 in GUIDO-2's queue? That swaps their Priority on the delivery board (P2 ↔ P1).",
  brief: brief({
    options: [
      { id: "approve", label: "Approve", answer: "Approve" },
      { id: "deny", label: "Deny", answer: "Deny" },
    ],
  }),
});
const row = crewRow({
  id: "guido-2",
  kind: "crew",
  mode: "writer",
  queue: [
    { ref: "shop-app#1", issue: 1, pos: 1 },
    { ref: "shop-app#2", issue: 2, pos: 2 },
  ],
});
const focusPath = "/api/seats/guido-2/focus";
const actionPath = `/api/queue/reorder/${encodeURIComponent(proposal.key)}`;
afterEach(() => {
  cleanup();
  hub.clear();
  closeItem();
  vi.unstubAllGlobals();
});
function setup(extra = {}) {
  const fn = stubFetch({
    [focusPath]: { focus: "label:catalog" },
    [`POST ${focusPath}`]: { focus: "label:bugs" },
    "/api/boards/shop-app": [
      boardItem({ issueNumber: 1, priority: "P1" }),
      boardItem({ issueNumber: 2, priority: "P2" }),
    ],
    "/api/attention": [proposal],
    "/api/escalations": [],
    "/api/crew": { rows: [row] },
    "/api/flight": { seat: null },
    ...extra,
  });
  render(
    <>
      <SideTabs row={row} />
      <ItemPanel />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Queue" }));
  return fn;
}
it("saves Focus and cancels without a write using keyboard form submission", async () => {
  const fn = setup();
  await screen.findByText("label:catalog");
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  const input = screen.getByRole("textbox", { name: "Focus" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "label:bugs" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Focus" }), {
    target: { value: "label:bugs" },
  });
  fireEvent.submit(
    screen.getByRole("textbox", { name: "Focus" }).closest("form") as HTMLFormElement,
  );
  await waitFor(() =>
    expect(fn).toHaveBeenCalledWith(
      focusPath,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ focus: "label:bugs" }) }),
    ),
  );
});
it("opens the returned approval without any board write", async () => {
  const fn = setup({ "POST /api/seats/guido-2/queue/reorder": { item: proposal } });
  const up = await screen.findByTitle("Ask FLIGHT to move this up");
  fireEvent.click(up);
  await screen.findByRole("heading", { name: "Approval" });
  expect(fn.mock.calls.filter(([, init]) => init?.method === "POST").map(([path]) => path)).toEqual(
    ["/api/seats/guido-2/queue/reorder"],
  );
  expect(fn).toHaveBeenCalledWith(
    "/api/seats/guido-2/queue/reorder",
    expect.objectContaining({ body: JSON.stringify({ move: "shop-app#2", above: "shop-app#1" }) }),
  );
});
it.each(["Approve", "Deny"])(
  "%s uses only the server action and refreshes board and queue",
  async (label) => {
    const fn = setup({
      [`POST ${actionPath}`]: {
        ok: true,
        text: label === "Deny" ? "Left the order as it is." : "Changed Priority on the board.",
      },
    });
    act(() => openItem(proposal.key));
    fireEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        actionPath,
        expect.objectContaining({ body: JSON.stringify({ action: label.toLowerCase() }) }),
      ),
    );
    expect(
      await screen.findByText(
        label === "Deny" ? "Left the order as it is." : "Changed Priority on the board.",
      ),
    ).toBeTruthy();
    expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await waitFor(() =>
      expect(
        fn.mock.calls.filter(([path, init]) => path === "/api/boards/shop-app" && !init?.method)
          .length,
      ).toBeGreaterThan(1),
    );
    expect(row.queue?.map((q) => q.ref)).toEqual(["shop-app#1", "shop-app#2"]);
  },
);
it("retains the proposal and server explanation on failure", async () => {
  setup({
    [`POST ${actionPath}`]: () => ({
      status: 409,
      body: { ok: false, text: "Priority swap unconfirmed. Check both cards." },
    }),
  });
  act(() => openItem(proposal.key));
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(
    (await screen.findByText("Priority swap unconfirmed. Check both cards.")).getAttribute("role"),
  ).toBe("alert");
  expect(screen.getByText(proposal.text)).toBeTruthy();
});

it("keeps the ask visible and disables both choices while the server action is pending", async () => {
  const fn = setup({ [`POST ${actionPath}`]: { ok: true, text: "Left the order as it is." } });
  const respond = fn.getMockImplementation();
  if (!respond) throw new Error("Missing fetch stub");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fn.mockImplementation(async (path, init) => {
    if (path === actionPath) await gate;
    return respond(path, init);
  });
  act(() => openItem(proposal.key));
  fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
  expect(screen.getByText(proposal.text)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    release();
    await gate;
  });
  await screen.findByText("Left the order as it is.");
});

it("retains edited Focus and validation explanation after a failed save", async () => {
  setup({ [`POST ${focusPath}`]: () => ({ status: 400, body: { error: "Use selectors." } }) });
  await screen.findByText("label:catalog");
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Focus" }), {
    target: { value: "catalog bugs" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Use selectors.");
  expect((screen.getByRole("textbox", { name: "Focus" }) as HTMLInputElement).value).toBe(
    "catalog bugs",
  );
});

it("shows Focus load failures and preserves the queue and Done empty states", async () => {
  stubFetch({
    [focusPath]: () => ({ status: 503, body: { error: "Unavailable" } }),
    "/api/agents/guido-2/runs?limit=50": [],
  });
  render(<SideTabs row={{ ...row, queue: [], run: null, ticket: null }} />);
  fireEvent.click(screen.getByRole("button", { name: "Queue" }));
  expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
  expect(screen.getByText("Nothing assigned.")).toBeTruthy();
  expect(screen.getByText("Empty: FLIGHT fills this from the focus.")).toBeTruthy();
  await screen.findByText("Could not load Focus: Unavailable");
  expect((screen.getByRole("button", { name: "Change" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("None yet.")).toBeTruthy();
});

it("shows proposal failures without changing the queue", async () => {
  const fn = setup({
    "POST /api/seats/guido-2/queue/reorder": () => ({
      status: 409,
      body: { error: "Queue changed; refresh the queue." },
    }),
  });
  fireEvent.click(await screen.findByTitle("Ask FLIGHT to move this up"));
  await screen.findByText("Queue changed; refresh the queue.");
  expect(screen.queryByRole("heading", { name: "Approval" })).toBeNull();
  expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("does not offer a Priority swap for equal Priority cards", async () => {
  setup({
    "/api/boards/shop-app": [
      boardItem({ issueNumber: 1, priority: "P1" }),
      boardItem({ issueNumber: 2, priority: "P1" }),
    ],
  });
  await screen.findByText("label:catalog");
  expect(screen.queryByTitle("Ask FLIGHT to move this up")).toBeNull();
});

it("cancels Focus with Escape and returns keyboard focus to Change", async () => {
  setup();
  await screen.findByText("label:catalog");
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Focus" }), { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Focus" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change" }));
});

it("keeps the returned approval actionable when the attention refresh fails", async () => {
  let reads = 0;
  const fn = setup({
    "/api/attention": () =>
      ++reads === 1 ? [] : { status: 503, body: { error: "Attention unavailable" } },
    "POST /api/seats/guido-2/queue/reorder": { item: proposal },
    [`POST ${actionPath}`]: () => ({
      status: 409,
      body: { ok: false, text: "Priority swap unconfirmed. Check both cards." },
    }),
  });
  fireEvent.click(await screen.findByTitle("Ask FLIGHT to move this up"));
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  expect(await screen.findByText(proposal.text)).toBeTruthy();
  expect(screen.queryByText("This item is no longer open.")).toBeNull();
  expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await screen.findByText("Priority swap unconfirmed. Check both cards.");
  expect(screen.getByText(proposal.text)).toBeTruthy();
  expect(fn).toHaveBeenCalledWith(
    actionPath,
    expect.objectContaining({ body: JSON.stringify({ action: "approve" }) }),
  );
});
