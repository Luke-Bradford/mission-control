import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SideTabs } from "../src/agent/SideTabs.tsx";
import { resetChoiceAttempts } from "../src/comms/briefChoice.ts";
import { hub } from "../src/data.ts";
import { ItemPanel } from "../src/shell/ItemPanel.tsx";
import { closeItem, openItem } from "../src/shell/overlays.ts";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, boundBrief, crewRow, item } from "./fixtures.ts";

const proposal = item({
  key: "note:queue-reorder:fiction",
  kind: "approval",
  agentId: null,
  escalationId: null,
  text: "Move shop-app#2 above shop-app#1 in GUIDO-2's queue? That swaps their Priority on the delivery board (P2 ↔ P1).",
  brief: boundBrief(
    {
      id: 77,
      ask: "Move shop-app#2 above shop-app#1?",
      recommendedOptionId: "approve",
      recommendation: "Approve the swap; the cards are the displayed ones.",
      options: [
        {
          id: "approve",
          label: "Approve",
          answer: "Approve",
          consequence: "Swaps the two cards' Priority on the board.",
          reversibility: { kind: "reversible", detail: "Swap them back." },
          action: { kind: "queue-proposal", key: "note:queue-reorder:fiction", action: "approve" },
        },
        {
          id: "deny",
          label: "Deny",
          answer: "Deny",
          consequence: "Leaves the order as it is.",
          reversibility: { kind: "reversible", detail: "FLIGHT can propose it again." },
          action: { kind: "queue-proposal", key: "note:queue-reorder:fiction", action: "deny" },
        },
      ],
    },
    "Priority swapped",
  ),
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
const actionPath = `/api/attention/${encodeURIComponent(proposal.key)}/choice`;
afterEach(() => {
  resetChoiceAttempts();
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
    "/api/crew?shape=summary": { rows: [row] },
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
const choose = async (label: "Approve" | "Deny") => {
  if (label === "Deny") fireEvent.click(await screen.findByRole("radio", { name: /Deny/ }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: label === "Approve" ? /^Accept recommendation: Approve/ : /^Choose: Deny/,
    }),
  );
};
it.each(["Approve", "Deny"] as const)(
  "%s sends only the bound choice and shows its receipt",
  async (label) => {
    const text = label === "Deny" ? "Left the order as it is." : "Changed Priority on the board.";
    const fn = setup({
      [`POST ${actionPath}`]: {
        epoch: "epoch-1",
        requestId: "r",
        optionId: label.toLowerCase(),
        at: 1,
        state: "applied",
        text,
        actor: { operator: true },
      },
    });
    act(() => openItem(proposal.key));
    await choose(label);
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        actionPath,
        expect.objectContaining({
          body: expect.stringContaining(`"optionId":"${label.toLowerCase()}"`),
        }),
      ),
    );
    const sent = JSON.parse(
      fn.mock.calls.find(([path]) => path === actionPath)?.[1]?.body as string,
    );
    expect(sent).toMatchObject({ briefId: 77, sourceRevision: "a".repeat(64) });
    expect((await screen.findByTestId("choice-receipt")).textContent).toContain(text);
    expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fn).not.toHaveBeenCalledWith(
      `/api/queue/reorder/${encodeURIComponent(proposal.key)}`,
      expect.anything(),
    );
    expect(row.queue?.map((q) => q.ref)).toEqual(["shop-app#1", "shop-app#2"]);
  },
);
it("retains the proposal and the server's refusal on failure", async () => {
  setup({
    [`POST ${actionPath}`]: () => ({
      status: 409,
      body: {
        epoch: "epoch-1",
        requestId: "r",
        optionId: "approve",
        at: 1,
        state: "refused",
        text: "Priority swap unconfirmed. Check both cards.",
        actor: { operator: true },
        status: 409,
      },
    }),
  });
  act(() => openItem(proposal.key));
  await choose("Approve");
  expect((await screen.findByTestId("choice-receipt")).textContent).toContain(
    "Priority swap unconfirmed. Check both cards.",
  );
  expect(screen.getAllByText(/Move shop-app#2 above shop-app#1/).length).toBeGreaterThan(0);
});

it("keeps the ask visible and disables both choices while the server action is pending", async () => {
  const fn = setup({
    [`POST ${actionPath}`]: {
      epoch: "epoch-1",
      requestId: "r",
      optionId: "deny",
      at: 1,
      state: "applied",
      text: "Left the order as it is.",
      actor: { operator: true },
    },
  });
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
  await choose("Deny");
  expect(screen.getAllByText(/Move shop-app#2 above shop-app#1/).length).toBeGreaterThan(0);
  await screen.findByText("Sending your choice…");
  const buttons = screen
    .getAllByRole("button")
    .filter((b) => /^(Accept recommendation|Choose):/.test(b.textContent ?? ""));
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    release();
    await gate;
  });
  await screen.findByText("Left the order as it is.", { exact: false });
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

it("keeps the returned approval readable but unsendable when the attention refresh fails", async () => {
  let reads = 0;
  const fn = setup({
    "/api/attention": () =>
      ++reads === 1 ? [proposal] : { status: 503, body: { error: "Attention unavailable" } },
    "POST /api/seats/guido-2/queue/reorder": { item: proposal },
  });
  fireEvent.click(await screen.findByTitle("Ask FLIGHT to move this up"));
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  expect((await screen.findAllByText(/Move shop-app#2 above shop-app#1/)).length).toBeGreaterThan(
    0,
  );
  const button = (await screen.findByRole("button", {
    name: /^Accept recommendation: Approve/,
  })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(true));
  expect(screen.getByTestId("choice-blocked").textContent).toContain("could not be loaded");
  fireEvent.click(button);
  expect(fn.mock.calls.filter(([path]) => path === actionPath)).toEqual([]);
});
