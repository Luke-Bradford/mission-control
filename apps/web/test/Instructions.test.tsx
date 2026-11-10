import {
  INSTRUCTION_TEXT_MAX,
  OPERATOR_HEADER,
  OPERATOR_TOKEN_REQUIRED,
  type StandingInstruction,
} from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { hub, RESOURCES, streamStatus } from "../src/data.ts";
import { FlightTabs } from "../src/flight/FlightTabs.tsx";
import { tabForHash } from "../src/flight/tabs.ts";
import {
  GlobalOrdersPanel,
  InstructionManager,
  instructionDrafts,
} from "../src/instructions/Instructions.tsx";
import { setSession } from "../src/shell/session.ts";
import { agentDensityFixture } from "./agentDensityFixture.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, CREW_CONFIG, NOW } from "./fixtures.ts";
import { flightSummary } from "./flightSummaryFixture.ts";

const order = (id: number, text: string, revokedAt: number | null = null): StandingInstruction => ({
  id,
  seatId: null,
  kind: "text",
  text,
  by: "operator",
  at: NOW - id,
  revokedAt,
  source: "saved",
});
const focus = (
  id: number,
  value: string | null,
  by: "operator" | "flight",
): StandingInstruction => ({
  id,
  seatId: "guido-1",
  kind: "focus",
  focus: value,
  by,
  at: NOW - id,
  revokedAt: null,
  source: "saved",
});
const EMPTY = { active: [], history: [], nextCursor: null };
const base = {
  "/api/config": CONFIG,
  "/api/operator/bootstrap": { token: "fixture-operator" },
  "/api/flight/orders?limit=1": EMPTY,
  "/api/flight/orders?limit=50": EMPTY,
  "/api/flight/instructions": { seats: [] },
  "/api/flight": { seat: null, decisions: [] },
  "/api/flight/summary": flightSummary({ session: null }),
  "/api/attention": [],
  "/api/settings/crew-pause": null,
  "/api/crew?shape=summary": { rows: [], firstRunToday: null },
};
beforeEach(() => {
  hub.clear();
  instructionDrafts.set({});
  forgetOperatorToken();
  setSession("all");
  window.history.replaceState(null, "", "/flight");
  streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW });
});
afterEach(() => {
  cleanup();
  hub.clear();
  instructionDrafts.set({});
  vi.unstubAllGlobals();
  forgetOperatorToken();
  window.history.replaceState(null, "", "/");
});

it("persists add, replacement and revoke through the authenticated UI actions, retaining history", async () => {
  const rows = [order(1, "Original order")];
  const list = () => ({
    active: rows.filter((entry) => entry.revokedAt === null),
    history: rows.filter((entry) => entry.revokedAt !== null),
    nextCursor: null,
  });
  const fn = stubFetch({
    ...base,
    "/api/flight/orders?limit=1": () => ({ status: 200, body: list() }),
    "/api/flight/orders?limit=50": () => ({ status: 200, body: list() }),
    "POST /api/flight/orders": (init: RequestInit) => {
      if (new Headers(init.headers).get(OPERATOR_HEADER) !== "fixture-operator")
        return { status: 401, body: { error: OPERATOR_TOKEN_REQUIRED } };
      const body = JSON.parse(init.body as string);
      if (body.replacesId) {
        const old = rows.find((entry) => entry.id === body.replacesId);
        if (old) old.revokedAt = NOW;
      }
      const entry = order(rows.length + 1, body.text);
      rows.push(entry);
      return { status: 200, body: { entry, changed: true } };
    },
    "POST /api/flight/orders/3/revoke": (init: RequestInit) => {
      if (new Headers(init.headers).get(OPERATOR_HEADER) !== "fixture-operator")
        return { status: 401, body: { error: OPERATOR_TOKEN_REQUIRED } };
      rows[2].revokedAt = NOW;
      return { status: 200, body: { entry: rows[2], changed: true } };
    },
  });
  render(<GlobalOrdersPanel />);
  await screen.findByText("Original order");
  fireEvent.click(screen.getByRole("button", { name: "Add order" }));
  fireEvent.change(screen.getByLabelText("Instruction text"), { target: { value: "New order" } });
  fireEvent.click(screen.getByRole("button", { name: "Save instruction" }));
  fireEvent.click(await screen.findByRole("button", { name: "Replace #2" }));
  fireEvent.change(screen.getByLabelText("Instruction text"), {
    target: { value: "Replacement order" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save instruction" }));
  const revokeNew = await screen.findByRole("button", { name: "Revoke #3" });
  expect(
    within(screen.getByRole("region", { name: "Active instructions" })).queryByText("New order"),
  ).toBeNull();
  fireEvent.click(revokeNew);
  fireEvent.click(screen.getByRole("button", { name: "Confirm revoke #3" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Active instructions" })).queryByText(
        "Replacement order",
      ),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByText("Revoked history"));
  await screen.findByText("New order");
  await screen.findByText("Replacement order");
  const attempts = fn.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(attempts).toHaveLength(4); // One unauthenticated attempt is refused, bootstrap retries it once.
  expect(new Headers(attempts[0][1]?.headers).get(OPERATOR_HEADER)).toBeNull();
  const writes = attempts.filter(
    ([, init]) => new Headers(init?.headers).get(OPERATOR_HEADER) === "fixture-operator",
  );
  expect(writes.map(([path, init]) => [path, JSON.parse(init?.body as string)])).toEqual([
    ["/api/flight/orders", { text: "New order" }],
    ["/api/flight/orders", { text: "Replacement order", replacesId: 2 }],
    ["/api/flight/orders/3/revoke", {}],
  ]);
  for (const [, init] of writes)
    expect(new Headers(init?.headers).get(OPERATOR_HEADER)).toBe("fixture-operator");
});

it("retains the draft, target and named focused error across failure, disconnect and lazy unmount", async () => {
  let refused = true;
  const fn = stubFetch({
    ...base,
    "/api/seats/guido-1/instructions?limit=1": {
      ...EMPTY,
      effectiveFocus: null,
      focusInstructionId: null,
    },
    "POST /api/seats/guido-1/instructions": () => ({
      status: refused ? 409 : 200,
      body: refused
        ? { error: "Active instruction capacity exceeded" }
        : {
            entry: { ...order(8, "Keep this draft"), seatId: "guido-1" },
            changed: true,
            delivery: "inbox",
          },
    }),
  });
  const panel = render(<InstructionManager seatId="guido-1" />);
  const add = await screen.findByRole("button", { name: "Add seat instruction" });
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(add);
  fireEvent.change(screen.getByLabelText("Instruction text"), {
    target: { value: "Keep this draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save instruction" }));
  const alert = await screen.findByRole("alert", { name: "Instruction action failed" });
  expect(alert.textContent).toContain("Active instruction capacity exceeded");
  await waitFor(() => expect(document.activeElement).toBe(alert));
  fireEvent.click(screen.getByRole("link", { name: "Return to Instruction text" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Instruction text"));
  expect(window.location.hash).toBe("");
  expect((screen.getByLabelText("Instruction text") as HTMLTextAreaElement).value).toBe(
    "Keep this draft",
  );
  act(() => streamStatus.set({ connected: false, reconnecting: true, lastMessageAt: NOW }));
  expect(screen.getByText(/Disconnected/)).toBeTruthy();
  panel.unmount();
  render(<InstructionManager seatId="guido-1" />);
  expect(((await screen.findByLabelText("Instruction text")) as HTMLTextAreaElement).value).toBe(
    "Keep this draft",
  );
  expect(screen.getByText("Target: guido-1")).toBeTruthy();
  refused = false;
  fireEvent.click(screen.getByRole("button", { name: "Save instruction" }));
  await screen.findByText(/Instruction #8 saved/);
  expect(
    fn.mock.calls.filter(
      ([path, init]) => path === "/api/seats/guido-1/instructions" && init?.method === "POST",
    ),
  ).toHaveLength(2);
});

it("deduplicates a pending write across an unmount and remount, then restores focus on Cancel", async () => {
  const fn = stubFetch({
    ...base,
    "POST /api/flight/orders": { entry: order(1, "Pending order"), changed: true },
  });
  const original = fn.getMockImplementation();
  if (!original) throw new Error("Missing fetch fixture");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fn.mockImplementation(async (path, init) => {
    if (path === "/api/flight/orders" && init?.method === "POST") await held;
    return original(path, init);
  });
  const first = render(<GlobalOrdersPanel />);
  const add = await screen.findByRole("button", { name: "Add order" });
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(add);
  fireEvent.change(screen.getByLabelText("Instruction text"), {
    target: { value: "Pending order" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Add instruction" }));
  first.unmount();
  render(<GlobalOrdersPanel />);
  fireEvent.submit(screen.getByRole("form", { name: "Add instruction" }));
  await waitFor(() =>
    expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1),
  );
  expect(
    (screen.getByRole("button", { name: "Saving instruction…" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => {
    release();
    await held;
  });
  await screen.findByText(/Instruction #1 saved/);
  fireEvent.click(screen.getByRole("button", { name: "Add order" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add order" })),
  );
});

it("keeps an existing replacement draft and target while another row remains visible", async () => {
  stubFetch({
    ...base,
    "/api/flight/orders?limit=1": {
      ...EMPTY,
      active: [order(1, "First order"), order(2, "Second order")],
    },
  });
  render(<GlobalOrdersPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Replace #1" }));
  fireEvent.change(screen.getByLabelText("Instruction text"), {
    target: { value: "Unsent replacement" },
  });
  const other = screen.getByRole("button", { name: "Replace #2" }) as HTMLButtonElement;
  expect(other.disabled).toBe(true);
  fireEvent.click(other);
  expect(screen.getByRole("form", { name: "Replace instruction #1" })).toBeTruthy();
  expect((screen.getByLabelText("Instruction text") as HTMLTextAreaElement).value).toBe(
    "Unsent replacement",
  );
});

it("retains over-limit text without a write or silent shortening", async () => {
  const fn = stubFetch(base);
  render(<GlobalOrdersPanel />);
  const add = await screen.findByRole("button", { name: "Add order" });
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(add);
  const text = "x".repeat(INSTRUCTION_TEXT_MAX + 1);
  fireEvent.change(screen.getByLabelText("Instruction text"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Save instruction" }));
  expect((screen.getByLabelText("Instruction text") as HTMLTextAreaElement).value).toBe(text);
  expect(screen.getByRole("alert", { name: "Instruction action failed" }).textContent).toContain(
    "1 to 4000",
  );
  expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  const summary = screen.getByRole("alert", { name: "Instruction action failed" });
  await waitFor(() => expect(document.activeElement).toBe(summary));
  expect((screen.getByRole("button", { name: "Add order" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("link", { name: "Return to Instruction text" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Instruction text"));
  fireEvent.click(screen.getByRole("button", { name: "Save instruction" }));
  await waitFor(() => expect(document.activeElement).toBe(summary));
  expect((screen.getByLabelText("Instruction text") as HTMLTextAreaElement).value).toBe(text);
});

it("keeps all 64 active rows and resolves a revoked deep link beyond page one", async () => {
  window.history.replaceState(null, "", "/flight#order-7");
  const active = Array.from({ length: 64 }, (_, i) => order(1000 + i, `Active order ${i}`));
  const selected = order(7, "Old retained order beyond page one", NOW);
  const fn = stubFetch({
    ...base,
    "/api/flight/orders?limit=1": { active, history: [], nextCursor: 500 },
    "/api/flight/orders/7": selected,
    "/api/flight/orders?limit=50": {
      active,
      history: Array.from({ length: 50 }, (_, i) => order(500 - i, `History ${500 - i}`, NOW)),
      nextCursor: 451,
    },
    "/api/flight/orders?limit=50&before=451": {
      active,
      history: [order(450, "Older history page", NOW)],
      nextCursor: null,
    },
  });
  render(<GlobalOrdersPanel />);
  expect(tabForHash("#order-7")).toBe("knows");
  await screen.findByText("Old retained order beyond page one");
  expect(
    within(screen.getByRole("region", { name: "Active instructions" })).getAllByRole("article"),
  ).toHaveLength(64);
  const retained = screen.getByRole("region", { name: "Referenced revoked order" });
  expect(retained.textContent).toContain("Revoked");
  expect((screen.getByText("Revoked history").closest("details") as HTMLDetailsElement).open).toBe(
    true,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Older history" }));
  await screen.findByText("Older history page");
  expect(fn.mock.calls.some(([path]) => path === "/api/flight/orders/7")).toBe(true);
});

it("shows an unknown retained order as unavailable without inventing content", async () => {
  window.history.replaceState(null, "", "/flight#order-999");
  stubFetch({
    ...base,
    "/api/flight/orders/999": () => ({ status: 404, body: { error: "Order unavailable." } }),
  });
  render(<GlobalOrdersPanel />);
  expect((await screen.findByRole("alert")).textContent).toContain("Order unavailable.");
  expect(screen.queryByRole("region", { name: "Referenced order" })).toBeNull();
});

it("previews revocation revealing FLIGHT focus, keeps explicit null clear and imported provenance honest", async () => {
  const flight = focus(1, "label:flight", "flight"),
    clear = focus(2, null, "operator");
  const imported = {
    ...focus(3, "label:config", "operator"),
    source: "legacy-config" as const,
    revokedAt: NOW,
  };
  let active = [flight, clear];
  stubFetch({
    ...base,
    "/api/seats/guido-1/instructions?limit=1": () => ({
      status: 200,
      body: {
        active,
        history: [],
        nextCursor: null,
        effectiveFocus: active.length === 2 ? null : "label:flight",
        focusInstructionId: active.length === 2 ? 2 : 1,
      },
    }),
    "/api/seats/guido-1/instructions?limit=50": { active, history: [imported], nextCursor: null },
    "POST /api/seats/guido-1/instructions/2/revoke": () => {
      active = [flight];
      return {
        status: 200,
        body: {
          entry: { ...clear, revokedAt: NOW },
          changed: true,
          effectiveFocus: "label:flight",
          focusInstructionId: 1,
        },
      };
    },
  });
  render(<InstructionManager seatId="guido-1" />);
  await screen.findByText(/explicit clear/);
  expect(screen.queryByLabelText("Focus")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Revoke #2" }));
  expect(screen.getByText(/Resulting focus/).textContent).toContain(
    "Focus: label:flight · FLIGHT #1",
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm revoke #2" }));
  await waitFor(() =>
    expect(screen.getByText(/Effective focus/).closest("p")?.textContent).toContain("FLIGHT #1"),
  );
  fireEvent.click(screen.getByText("Revoked history"));
  await screen.findByText(/Imported from config/);
  expect(screen.getByText(/Imported from config/).textContent).toContain("imported");
});

it("reads status on Flight but no seat detail or full history before the owning panel opens", async () => {
  const fn = stubFetch({
    ...base,
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
    "/api/flight/instructions": {
      seats: [{ seatId: "guido-1", active: [], effectiveFocus: null, focusInstructionId: null }],
    },
    "/api/seats/guido-1/instructions?limit=1": {
      ...EMPTY,
      effectiveFocus: null,
      focusInstructionId: null,
    },
    "/api/repos": [],
    "/api/prs/flow": { repos: [], generatedAt: NOW },
  });
  render(<FlightTabs />);
  await screen.findByRole("button", { name: "Active orders: 0" });
  expect(fn.mock.calls.some(([path]) => path === "/api/flight/instructions")).toBe(false);
  expect(
    fn.mock.calls.some(([path]) => path.includes("/instructions?") || path.includes("limit=50")),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Active orders: 0" }));
  const summary = await screen.findByText(/guido-1 · 0 active/);
  expect(fn.mock.calls.some(([path]) => path.includes("/seats/guido-1/instructions"))).toBe(false);
  fireEvent.click(summary);
  await screen.findByRole("button", { name: "Add seat instruction" });
  expect(fn.mock.calls.some(([path]) => path === "/api/seats/guido-1/instructions?limit=1")).toBe(
    true,
  );
  expect(fn.mock.calls.some(([path]) => path.includes("limit=50"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Add seat instruction" }));
  for (const text of ["One", "One saved", "One saved draft"])
    fireEvent.change(screen.getByLabelText("Instruction text"), { target: { value: text } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(
    fn.mock.calls.filter(([path]) => path === "/api/seats/guido-1/instructions?limit=1"),
  ).toHaveLength(1);
});

it("keeps loading, failed and stale reads distinct from an empty active set", async () => {
  let fail = false;
  stubFetch({
    ...base,
    "/api/flight/orders?limit=1": () => ({
      status: fail ? 503 : 200,
      body: fail ? { error: "Orders offline" } : EMPTY,
    }),
  });
  render(<GlobalOrdersPanel />);
  await screen.findByText("No active orders.");
  fail = true;
  act(() => hub.refetch(RESOURCES.flightOrders.path));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Showing saved orders; refresh failed: Orders offline",
  );
  expect(screen.getByText("No active orders.")).toBeTruthy();
});

it("follows a filtered re-plan link into its retained revoked order through the actual Flight tabs", async () => {
  const selected = order(7, "Saved order from an older history page", NOW);
  const fn = stubFetch({
    ...base,
    "/api/flight": {
      seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", live: true, state: "idle" },
      decisions: [
        {
          id: 10,
          kind: "re-plan",
          at: NOW,
          seatId: "flight-1",
          targetRunId: null,
          ref: null,
          questionId: null,
          about: "Change the work sequence",
          decision: "Run the smaller fix first",
          basis: "Saved operator guidance",
          orderId: 7,
        },
      ],
    },
    "/api/flight/orders/7": selected,
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
    "/api/repos": [],
    "/api/prs/flow": { repos: [], generatedAt: NOW },
  });
  render(<FlightTabs />);
  fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
  const link = await screen.findByRole("link", { name: "Saved order #7 · retained reference" });
  fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), {
    target: { value: "re-plan" },
  });
  expect(screen.getByRole("option", { name: "Re-planned" })).toBeTruthy();
  fireEvent.click(link);
  await screen.findByText("Saved order from an older history page");
  expect(screen.getByRole("tab", { name: "What FLIGHT knows" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(
    within(screen.getByRole("region", { name: "Referenced revoked order" })).getByText("Revoked"),
  ).toBeTruthy();
  expect(fn.mock.calls.some(([path]) => path === "/api/flight/orders/7")).toBe(true);
});

it("names initial loading and failed reads without presenting either as no active orders", async () => {
  let finish: (response: Response) => void = () => {};
  const fn = stubFetch(base),
    original = fn.getMockImplementation();
  if (!original) throw new Error("Missing fixture");
  fn.mockImplementation((path, init) =>
    path === "/api/flight/orders?limit=1"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : original(path, init),
  );
  render(<GlobalOrdersPanel />);
  expect(screen.getByRole("status").textContent).toBe("Loading orders…");
  expect(screen.queryByText("No active orders.")).toBeNull();
  await act(async () => {
    finish(new Response(JSON.stringify({ error: "Orders could not be read" }), { status: 503 }));
  });
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Could not load orders: Orders could not be read",
  );
  expect(screen.queryByText("No active orders.")).toBeNull();
});

it("uses configured writer capability for Queue links while watch seats keep text actions", async () => {
  let watching = false;
  let active = [
    { ...order(8, "Original seat guidance"), seatId: "guido-1" },
    focus(9, "label:cache", "flight"),
  ];
  const fn = stubFetch({
    ...base,
    "/api/config": () => ({
      status: 200,
      body: {
        ...CREW_CONFIG,
        crew: {
          ...CREW_CONFIG.crew,
          sessions: CREW_CONFIG.crew?.sessions.map((session) => ({
            ...session,
            seats: session.seats.map((seat) =>
              seat.id === "guido-1"
                ? {
                    ...seat,
                    mode: watching ? "read-only" : "writer",
                    loop: watching ? "watch" : "build",
                  }
                : seat,
            ),
          })),
        },
      },
    }),
    "/api/seats/guido-1/instructions?limit=1": () => ({
      status: 200,
      body: { ...EMPTY, active, effectiveFocus: "label:cache", focusInstructionId: 9 },
    }),
    "POST /api/seats/guido-1/instructions": (init: RequestInit) => {
      if (new Headers(init.headers).get(OPERATOR_HEADER) !== "fixture-operator")
        return { status: 401, body: { error: OPERATOR_TOKEN_REQUIRED } };
      expect(JSON.parse(init.body as string)).toEqual({
        kind: "text",
        text: "Watch guidance",
        replacesId: 8,
      });
      const entry = { ...order(10, "Watch guidance"), seatId: "guido-1" };
      active = [entry, active[1]];
      return { status: 200, body: { entry, changed: true } };
    },
  });
  render(<InstructionManager seatId="guido-1" />);
  const queue = await screen.findByRole("link", { name: "Edit focus or Clear in Queue" });
  expect(queue.getAttribute("href")).toBe("/agent/guido-1?side=queue");
  expect(screen.getByRole("link", { name: "Change focus in Queue" })).toBeTruthy();
  expect(screen.getByText(/Clear in Queue saves an operator instruction/)).toBeTruthy();
  watching = true;
  act(() => hub.refetch(RESOURCES.config.path));
  await waitFor(() => expect(screen.queryByRole("link", { name: /Queue/ })).toBeNull());
  expect(screen.queryByText(/Clear in Queue saves an operator instruction/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Replace #8" }));
  fireEvent.change(screen.getByLabelText("Instruction text"), {
    target: { value: "Watch guidance" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save instruction" }));
  await screen.findByRole("button", { name: "Replace #10" });
  expect(screen.getByRole("button", { name: "Add seat instruction" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Revoke #10" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Queue/ })).toBeNull();
  expect(
    fn.mock.calls.filter(
      ([, init]) =>
        init?.method === "POST" &&
        new Headers(init.headers).get(OPERATOR_HEADER) === "fixture-operator",
    ),
  ).toHaveLength(1);
});

it("opens Crew instructions as an alternative body while preserving the default Seats reader", async () => {
  const fixture = agentDensityFixture();
  const fn = stubFetch({
    ...fixture.api,
    ...base,
    "/api/crew?shape=summary": fixture.api["/api/crew?shape=summary"],
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
    "/api/flight/instructions": {
      seats: [{ seatId: "guido-1", active: [], effectiveFocus: null, focusInstructionId: null }],
    },
  });
  render(<FlightTabs />);
  fireEvent.click(screen.getByRole("tab", { name: "Crew & board" }));
  await screen.findByRole("table", { name: "Seats" });
  expect(fn.mock.calls.some(([path]) => path === "/api/flight/instructions")).toBe(false);
  const context = screen.getByRole("group", { name: "Crew context" });
  fireEvent.click(within(context).getByRole("button", { name: "Instructions" }));
  await screen.findByText(/guido-1 · 0 active/);
  expect(screen.queryByRole("table", { name: "Seats" })).toBeNull();
  expect(fn.mock.calls.some(([path]) => path.includes("/seats/guido-1/instructions"))).toBe(false);
  fireEvent.click(within(context).getByRole("button", { name: "Seats" }));
  await screen.findByRole("table", { name: "Seats" });
});
