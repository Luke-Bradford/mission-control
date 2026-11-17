import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { hub, streamStatus } from "../src/data.ts";
import { Planner } from "../src/pages/Planner.tsx";
import type { Plan, PlansView } from "../src/plans/types.ts";
import { route } from "../src/router.ts";
import { Header } from "../src/shell/Header.tsx";
import { stubFetch } from "./fetchStub.ts";

afterEach(() => vi.unstubAllGlobals());

const PNG = "a".repeat(64);
const plan = (over: Partial<Plan> = {}): Plan => ({
  id: "p1",
  repoId: "mc",
  ticket: "mc#7",
  title: "Retry webhooks",
  asks: "Failed webhooks are dropped.",
  proposed: "Queue and retry with backoff.",
  pictures: [{ url: `/api/attention-material-assets/${PNG}`, caption: "Retry queue" }],
  size: "M",
  risks: "A retry could double-charge.",
  status: "pending",
  ...over,
});

let view: PlansView;
let fetcher: ReturnType<typeof stubFetch>;
const NOW = Date.now();

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** The plan routes; a picture route answers PNG bytes. */
const load = (extra: Record<string, unknown> = {}) => {
  const fn = stubFetch({
    "/api/operator/bootstrap": { token: "t" },
    "/api/plans": () => ({ status: 200, body: view }),
    ...extra,
  });
  const inner = fn.getMockImplementation() as (i: string, init?: RequestInit) => Promise<Response>;
  fetcher = vi.fn(async (input: string, init?: RequestInit) =>
    input.startsWith("/api/attention-material-assets/")
      ? new Response(BYTES, { status: 200, headers: { "content-type": "image/png" } })
      : inner(input, init),
  ) as unknown as ReturnType<typeof stubFetch>;
  vi.stubGlobal("fetch", fetcher);
};

beforeEach(() => {
  hub.clear();
  forgetOperatorToken();
  window.history.replaceState({}, "", "/planner");
  streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW });
  view = { pending: [plan()], history: [] };
});

describe("Planner tab", () => {
  it("routes /planner and sits in the header between QA and Telemetry", () => {
    expect(route("/planner")).toEqual({ page: "planner" });
    stubFetch({});
    render(<Header page="planner" />);
    const link = within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", {
      name: /^Planner/,
    });
    expect(link.getAttribute("href")).toBe("/planner");
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("has the two sections, To plan and sign off and History", async () => {
    load();
    render(<Planner />);
    const nav = screen.getByRole("navigation", { name: "Planner views" });
    expect(within(nav).getByRole("link", { name: "To plan and sign off" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "History" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "To plan and sign off" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Planner" })).toBeTruthy();
  });

  it("shows the five parts of a plan, with its picture on the page", async () => {
    load();
    render(<Planner />);
    for (const part of [
      "What the ticket asks for",
      "What is proposed",
      "Mockups and pictures",
      "Size estimate",
      "Complications and risks",
    ])
      expect(await screen.findByRole("heading", { name: part })).toBeTruthy();
    expect(screen.getByText("Failed webhooks are dropped.")).toBeTruthy();
    expect(screen.getByText("Queue and retry with backoff.")).toBeTruthy();
    expect(screen.getByText("A retry could double-charge.")).toBeTruthy();
    const img = await screen.findByRole("img", { name: "Retry queue" });
    expect(img.getAttribute("src")).toMatch(/^data:image\/png/);
  });

  it("shows plan text as text, never as HTML", async () => {
    view = { pending: [plan({ proposed: "Do <b>this</b>" })], history: [] };
    load();
    render(<Planner />);
    expect(await screen.findByText("Do <b>this</b>")).toBeTruthy();
    expect(document.querySelector(".plan-text b")).toBeNull();
  });

  it("says so when no plan is waiting", async () => {
    view = { pending: [], history: [] };
    load();
    render(<Planner />);
    expect(await screen.findByText("No plan is waiting for you")).toBeTruthy();
  });

  it("approves a plan through its route and the list updates", async () => {
    let approved = false;
    load({
      "/api/plans": () => ({
        status: 200,
        body: approved
          ? { pending: [], history: [plan({ status: "approved", decidedAt: NOW })] }
          : view,
      }),
      "POST /api/plans/p1/approve": () => {
        approved = true;
        return { status: 200, body: { ok: true } };
      },
    });
    render(<Planner />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("No plan is waiting for you")).toBeTruthy();
    expect(
      fetcher.mock.calls.some(([p, i]) => p === "/api/plans/p1/approve" && i?.method === "POST"),
    ).toBe(true);
  });

  it("asks for a note before sending back, then posts it", async () => {
    let sent = false;
    load({
      "/api/plans": () => ({
        status: 200,
        body: sent
          ? {
              pending: [],
              history: [plan({ status: "sent-back", note: "Use a queue", decidedAt: NOW })],
            }
          : view,
      }),
      "POST /api/plans/p1/send-back": () => {
        sent = true;
        return { status: 200, body: { ok: true } };
      },
    });
    render(<Planner />);
    fireEvent.click(await screen.findByRole("button", { name: "Send back" }));
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Say what to change/);
    expect(fetcher.mock.calls.some(([p]) => p === "/api/plans/p1/send-back")).toBe(false);
    fireEvent.change(screen.getByLabelText("Note for the planner"), {
      target: { value: "Use a queue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    await waitFor(() => {
      const call = fetcher.mock.calls.find(([p]) => p === "/api/plans/p1/send-back");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ note: "Use a queue" });
    });
    expect(await screen.findByText("No plan is waiting for you")).toBeTruthy();
  });

  it("lists past plans in History, with the note on one sent back", async () => {
    view = {
      pending: [],
      history: [
        plan({ id: "p2", status: "sent-back", note: "Keep the lookup", decidedAt: NOW }),
        plan({ id: "p3", ticket: "mc#8", title: "Other", status: "approved", decidedAt: NOW }),
      ],
    };
    window.history.replaceState({}, "", "/planner?view=history");
    load();
    render(<Planner />);
    const list = await screen.findByRole("list", { name: "Decided plans" });
    expect(within(list).getAllByRole("link")).toHaveLength(2);
    expect(screen.getByText("Keep the lookup")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    await act(async () => {});
  });
});
