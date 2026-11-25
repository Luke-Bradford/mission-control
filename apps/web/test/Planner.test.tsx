import type { PlansView, TicketPlan } from "@mc/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { hub, streamStatus } from "../src/data.ts";
import { Planner } from "../src/pages/Planner.tsx";
import { route } from "../src/router.ts";
import { stubFetch } from "./fetchStub.ts";

const HASH = "a".repeat(64);
const NOW = 1_700_000_000_000;
const plan = (over: Partial<TicketPlan> = {}): TicketPlan => ({
  repoId: "mc",
  issue: 7,
  ref: "mc#7",
  title: "Retry webhooks",
  state: "awaiting-signoff",
  marked: true,
  asks: "Failed webhooks are dropped.",
  proposal: "Queue and retry with backoff.",
  sizeEstimate: "M",
  risks: "A retry could double-charge.",
  mockups: [
    { id: HASH, url: `/api/plan-assets/${HASH}`, caption: "Retry queue", mediaType: "image/png" },
  ],
  note: null,
  requestedAt: NOW,
  plannedAt: NOW,
  decidedAt: null,
  ...over,
});
let view: PlansView;
let fetcher: ReturnType<typeof stubFetch>;
const load = (extra: Record<string, unknown> = {}) => {
  fetcher = stubFetch({
    "/api/operator/bootstrap": { token: "t" },
    "/api/plans": () => ({ status: 200, body: view }),
    ...extra,
  });
  vi.stubGlobal("fetch", fetcher);
};
beforeEach(() => {
  hub.clear();
  forgetOperatorToken();
  window.history.replaceState({}, "", "/planner");
  streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW });
  view = { waiting: [plan()], history: [plan({ state: "signed-off", decidedAt: NOW })] };
});
afterEach(() => vi.unstubAllGlobals());

describe("Planner tab", () => {
  it("says so inside the panel, with an alert and a retry, when the plans fail to load", async () => {
    load({ "/api/plans": () => ({ status: 500, body: { error: "down" } }) });
    render(<Planner />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText("No plans to show until they load.")).toBeTruthy();
    expect(screen.queryByText("No plan is waiting for you")).toBeNull();
  });
  it("says no plan is waiting, not that loading failed, for a true empty list", async () => {
    view = { waiting: [], history: [] };
    load();
    render(<Planner />);
    expect(await screen.findByText("No plan is waiting for you")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No plans to show until they load.")).toBeNull();
  });
  it("routes to Planner and shows waiting and history", async () => {
    expect(route("/planner")).toEqual({ page: "planner" });
    load();
    render(<Planner />);
    expect(await screen.findByRole("heading", { name: "To plan and sign off" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "History" })).toBeTruthy();
    expect(screen.getAllByText("Retry webhooks")).toHaveLength(2);
  });
  it("renders the five plan parts and its stored mockup", async () => {
    load();
    render(<Planner />);
    for (const heading of [
      "What the ticket asks for",
      "What is proposed",
      "Mockups and pictures",
      "Size estimate",
      "Complications and risks",
    ])
      expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.getByText("Retry queue")).toBeTruthy();
  });
  it("posts an approval to the core route and refreshes the waiting list", async () => {
    let approved = false;
    load({
      "/api/plans": () => ({
        status: 200,
        body: approved ? { waiting: [], history: view.history } : view,
      }),
      "POST /api/plans/mc/7/approve": () => {
        approved = true;
        return { status: 200, body: { plan: plan(), moved: true, moveError: null } };
      },
    });
    render(<Planner />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([path]) => path === "/api/plans/mc/7/approve")).toBe(true),
    );
    expect(await screen.findByText("No plan is waiting for you")).toBeTruthy();
  });
  it("with a repo filter, Try again and a decision read the plans path the page shows", async () => {
    window.history.replaceState({}, "", "/planner?repo=mc");
    let fail = true;
    load({
      "/api/plans": () =>
        fail ? { status: 500, body: { error: "down" } } : { status: 200, body: view },
      "POST /api/plans/mc/7/approve": () => ({
        status: 200,
        body: { plan: plan(), moved: true, moveError: null },
      }),
    });
    render(<Planner />);
    await screen.findByRole("alert");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([path]) => path === "/api/plans/mc/7/approve")).toBe(true),
    );
    await waitFor(() =>
      expect(fetcher.mock.calls.filter(([path]) => path === "/api/plans").length).toBeGreaterThan(
        2,
      ),
    );
    // The page subscribes to the bare path; a filtered path would refetch nothing it shows.
    expect(fetcher.mock.calls.some(([path]) => String(path).startsWith("/api/plans?"))).toBe(false);
  });
  it("says history holds the plans you signed off", async () => {
    window.history.replaceState({}, "", "/planner?view=history");
    load();
    render(<Planner />);
    expect(await screen.findByText("Plans you signed off, newest first.")).toBeTruthy();
    expect(screen.getByText("1 signed off")).toBeTruthy();
  });
  it("requires a note before it sends a plan back", async () => {
    load({
      "POST /api/plans/mc/7/send-back": () => ({
        status: 200,
        body: { plan: plan(), moved: false, moveError: null },
      }),
    });
    render(<Planner />);
    fireEvent.click(await screen.findByRole("button", { name: "Send back" }));
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    expect(
      screen.getAllByRole("alert").some((node) => node.textContent?.includes("Say what to change")),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Note for the planner"), {
      target: { value: "Show the queue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    await waitFor(() => {
      const call = fetcher.mock.calls.find(([path]) => path === "/api/plans/mc/7/send-back");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ note: "Show the queue" });
    });
  });
});
