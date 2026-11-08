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
    const open = screen.getByRole("link", { name: "Open shop-app#3349" });
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
});
