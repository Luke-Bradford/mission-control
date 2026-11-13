import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TicketsList } from "../src/comms/TicketsList.tsx";
import { hub } from "../src/data.ts";
import { navigate } from "../src/router.ts";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, NOW, REPOS } from "./fixtures.ts";

vi.mock("../src/router.ts", async (orig) => ({
  ...(await orig<typeof import("../src/router.ts")>()),
  navigate: vi.fn(),
}));

const COUNTS = "/api/comms/ticket-counts";
const counts = (tickets: { ticket: string; count: number }[]) => ({ tickets, unassignedCount: 0 });
const BOARDS = {
  "/api/repos": REPOS,
  "/api/boards/shop-app": [
    boardItem({ issueNumber: 3349, title: "Quote cache" }),
    boardItem({ issueNumber: 3350, title: "Checkout totals drift" }),
    boardItem({ issueNumber: 3351, title: "Nobody talked about this" }),
  ],
  "/api/boards/site-builder": [
    boardItem({ repoId: "site-builder", issueNumber: 12, title: "Header banner" }),
  ],
};
const TALKED = counts([
  { ticket: "shop-app#3349", count: 3 },
  { ticket: "shop-app#3350", count: 1 },
  { ticket: "site-builder#12", count: 7 },
  { ticket: "shop-app#3351", count: 0 },
]);

beforeEach(() => {
  hub.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stubFetch({ ...BOARDS, [COUNTS]: TALKED });
});
afterEach(() => {
  hub.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(navigate).mockClear();
});

/** A fetch where some paths never answer. */
function fetchWith(answers: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) =>
      path in answers
        ? Promise.resolve(new Response(JSON.stringify(answers[path]), { status: 200 }))
        : new Promise<Response>(() => {}),
    ),
  );
}

describe("Tickets list", () => {
  it("lists only tickets with stored messages, each with its message count", async () => {
    render(<TicketsList />);
    await screen.findByText("Quote cache");
    expect(screen.queryByText("Nobody talked about this")).toBeNull();
    const row = (title: string) => screen.getByText(title).closest("li") as HTMLElement;
    expect(within(row("Quote cache")).getByText("3 messages")).toBeTruthy();
    expect(within(row("Checkout totals drift")).getByText("1 message")).toBeTruthy();
    expect(within(row("Header banner")).getByText("7 messages")).toBeTruthy();
    expect(screen.getByText("3 of 3")).toBeTruthy();
  });

  it("finds a ticket by text in its title", async () => {
    render(<TicketsList />);
    await screen.findByText("Quote cache");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tickets" }), {
      target: { value: "totals" },
    });
    expect(screen.getByText("Checkout totals drift")).toBeTruthy();
    expect(screen.queryByText("Quote cache")).toBeNull();
    expect(screen.queryByText("Header banner")).toBeNull();
  });

  it("finds a ticket by its number and says when nothing matches", async () => {
    render(<TicketsList />);
    await screen.findByText("Quote cache");
    const box = screen.getByRole("searchbox", { name: "Search tickets" });
    fireEvent.change(box, { target: { value: "#12" } });
    expect(screen.getByText("Header banner")).toBeTruthy();
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText("No ticket matches “zzz”.")).toBeTruthy();
  });

  it("opens the Ticket page from the number and filters the chat from a separate control", async () => {
    render(<TicketsList />);
    await screen.findByText("Quote cache");
    const open = screen.getByRole("link", { name: "Open shop-app#3349: Quote cache" });
    expect(open.getAttribute("href")).toBe("/tickets/shop-app/3349");
    expect(open.querySelector(".comms-ticket-title")?.getAttribute("title")).toBe("Quote cache");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Show only messages about shop-app#3349" }),
      );
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/comms/tickets/%233349?ticket=shop-app%233349"),
    );
  });

  it("says no tickets have messages when none do", async () => {
    stubFetch({ ...BOARDS, [COUNTS]: counts([]) });
    render(<TicketsList />);
    expect(await screen.findByText("No ticket has messages yet.")).toBeTruthy();
  });

  it("says loading until the boards and the counts have answered", async () => {
    hub.clear();
    fetchWith({
      "/api/repos": REPOS,
      "/api/boards/site-builder": BOARDS["/api/boards/site-builder"],
      [COUNTS]: TALKED,
    });
    render(<TicketsList />);
    expect(await screen.findByText("Loading tickets…")).toBeTruthy();
    expect(screen.queryByText("No ticket has messages yet.")).toBeNull();
    expect(screen.queryByText(/\d+ of \d+/)).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tickets" }), {
      target: { value: "zzz" },
    });
    expect(screen.queryByText(/No ticket matches/)).toBeNull();
  });

  it("says the counts could not be read, and shows no list, when they never loaded", async () => {
    hub.clear();
    stubFetch({ ...BOARDS, [COUNTS]: () => ({ status: 500, body: { error: "boom" } }) });
    render(<TicketsList />);
    expect(await screen.findByText("Could not read message counts.")).toBeTruthy();
    expect(screen.queryByText("Quote cache")).toBeNull();
    expect(screen.queryByText("No ticket has messages yet.")).toBeNull();
  });

  it("keeps the rows and warns when a later read of the counts fails", async () => {
    let fail = false;
    stubFetch({
      ...BOARDS,
      [COUNTS]: () =>
        fail ? { status: 500, body: { error: "boom" } } : { status: 200, body: TALKED },
    });
    render(<TicketsList />);
    await screen.findByText("Quote cache");
    fail = true;
    await act(async () => {
      hub.refetch(COUNTS);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect((await screen.findByRole("alert")).textContent).toContain("may be out of date");
    expect(screen.getByText("Quote cache")).toBeTruthy();
  });

  it("says the repositories could not be read, and not that there are no tickets", async () => {
    hub.clear();
    stubFetch({ [COUNTS]: TALKED, "/api/repos": () => ({ status: 500, body: { error: "boom" } }) });
    render(<TicketsList />);
    expect(await screen.findByText("Could not read repositories.")).toBeTruthy();
    expect(screen.queryByText("No ticket has messages yet.")).toBeNull();
    expect(screen.queryByText("Loading tickets…")).toBeNull();
  });

  it("keeps the rows and warns when a later read of the repositories fails", async () => {
    let fail = false;
    stubFetch({
      ...BOARDS,
      [COUNTS]: TALKED,
      "/api/repos": () =>
        fail ? { status: 500, body: { error: "boom" } } : { status: 200, body: REPOS },
    });
    render(<TicketsList />);
    await screen.findByText("Quote cache");
    fail = true;
    await act(async () => {
      hub.refetch("/api/repos");
      await new Promise((r) => setTimeout(r, 20));
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not read repositories. These tickets may be out of date.",
    );
    expect(screen.getByText("Quote cache")).toBeTruthy();
  });

  it("names a board that could not be read and keeps the rows that loaded", async () => {
    hub.clear();
    stubFetch({
      ...BOARDS,
      [COUNTS]: TALKED,
      "/api/boards/shop-app": () => ({ status: 500, body: { error: "boom" } }),
    });
    render(<TicketsList />);
    expect(await screen.findByText("Header banner")).toBeTruthy();
    expect(await screen.findByText("Could not read the board for shop-app.")).toBeTruthy();
  });

  it("warns when a board refresh fails but keeps its older rows", async () => {
    let fail = false;
    stubFetch({
      ...BOARDS,
      [COUNTS]: TALKED,
      "/api/boards/shop-app": () =>
        fail
          ? { status: 500, body: { error: "boom" } }
          : { status: 200, body: BOARDS["/api/boards/shop-app"] },
    });
    render(<TicketsList />);
    await screen.findByText("Quote cache");
    fail = true;
    await act(async () => {
      hub.refetch("/api/boards/shop-app");
      await new Promise((r) => setTimeout(r, 20));
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not refresh the board for shop-app; these tickets may be out of date.",
    );
    expect(screen.getByText("Quote cache")).toBeTruthy();
  });

  it("shows a ticket with messages that is on no board by its reference", async () => {
    stubFetch({ ...BOARDS, [COUNTS]: counts([{ ticket: "shop-app#99", count: 2 }]) });
    render(<TicketsList />);
    const row = (
      await screen.findByText("shop-app#99", { selector: ".comms-ticket-title" })
    ).closest("li") as HTMLElement;
    expect(within(row).getByText("2 messages")).toBeTruthy();
  });
});
