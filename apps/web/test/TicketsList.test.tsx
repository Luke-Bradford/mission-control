import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

beforeEach(() => {
  hub.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stubFetch({
    "/api/repos": REPOS,
    "/api/boards/shop-app": [
      boardItem({ issueNumber: 3349, title: "Quote cache" }),
      boardItem({ issueNumber: 3350, title: "Checkout totals drift" }),
    ],
    "/api/boards/site-builder": [
      boardItem({ repoId: "site-builder", issueNumber: 12, title: "Header banner" }),
    ],
  });
});
afterEach(() => {
  hub.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(navigate).mockClear();
});

describe("Tickets list", () => {
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
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Show only messages about shop-app#3349" }),
      );
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/comms/tickets/%233349?ticket=shop-app%233349"),
    );
  });

  it("names a ticket's link with its title, and puts the full title in a tooltip", async () => {
    render(<TicketsList />);
    await screen.findByText("Quote cache");
    const open = screen.getByRole("link", { name: "Open shop-app#3349: Quote cache" });
    expect(open.querySelector(".comms-ticket-title")?.getAttribute("title")).toBe("Quote cache");
  });

  it("says loading, not 'No tickets yet.', until the boards have answered", async () => {
    hub.clear();
    const answers: Record<string, unknown> = {
      "/api/repos": REPOS,
      "/api/boards/site-builder": [boardItem({ repoId: "site-builder", issueNumber: 12 })],
    };
    // shop-app's board never answers
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        path in answers
          ? Promise.resolve(new Response(JSON.stringify(answers[path]), { status: 200 }))
          : new Promise<Response>(() => {}),
      ),
    );
    render(<TicketsList />);
    expect(await screen.findByText("Loading tickets…")).toBeTruthy();
    expect(screen.queryByText("No tickets yet.")).toBeNull();
    expect(screen.queryByText(/of \d+$/)).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tickets" }), {
      target: { value: "zzz" },
    });
    expect(screen.queryByText(/No ticket matches/)).toBeNull();
  });

  it("says the repositories could not be read, and not that there are no tickets", async () => {
    hub.clear();
    stubFetch({ "/api/repos": () => ({ status: 500, body: { error: "boom" } }) });
    render(<TicketsList />);
    expect(await screen.findByText("Could not read repositories.")).toBeTruthy();
    expect(screen.queryByText("No tickets yet.")).toBeNull();
    expect(screen.queryByText("Loading tickets…")).toBeNull();
    expect(screen.queryByText(/\d+ of \d+/)).toBeNull();
  });

  it("keeps the rows and warns when a later read of the repositories fails", async () => {
    let fail = false;
    stubFetch({
      "/api/repos": () =>
        fail ? { status: 500, body: { error: "boom" } } : { status: 200, body: REPOS },
      "/api/boards/shop-app": [boardItem({ issueNumber: 3349, title: "Quote cache" })],
      "/api/boards/site-builder": [],
    });
    render(<TicketsList />);
    await screen.findByText("Quote cache");
    fail = true;
    await act(async () => {
      hub.refetch("/api/repos");
      await new Promise((r) => setTimeout(r, 20));
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not read repositories.",
    );
    expect(screen.getByText(/may be out of date/)).toBeTruthy();
    expect(screen.getByText("Quote cache")).toBeTruthy();
  });

  it("names a board that could not be read and keeps the rows that loaded", async () => {
    hub.clear();
    stubFetch({
      "/api/repos": REPOS,
      "/api/boards/shop-app": () => ({ status: 500, body: { error: "boom" } }),
      "/api/boards/site-builder": [
        boardItem({ repoId: "site-builder", issueNumber: 12, title: "Header banner" }),
      ],
    });
    render(<TicketsList />);
    expect(await screen.findByText("Header banner")).toBeTruthy();
    expect(await screen.findByText("Could not read the board for shop-app.")).toBeTruthy();
  });
});
