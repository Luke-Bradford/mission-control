import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { NextActionsPanel } from "../src/overview/NextActionsPanel.tsx";
import { useItem } from "../src/shell/overlays.ts";
import { stubFetch } from "./fetchStub.ts";
import { HOUR, item, itemWithoutOwner, NOW } from "./fixtures.ts";

function Probe() {
  return <span data-testid="item">{useItem() ?? "none"}</span>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
  cleanup();
  hub.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rows = (container: HTMLElement) => [...container.querySelectorAll(".needs-row")];

describe("NextActionsPanel", () => {
  it("says Nothing is waiting for your decision when the list is empty", async () => {
    stubFetch({ "/api/attention": [] });
    const { container } = render(<NextActionsPanel />);
    expect(await screen.findByText("Nothing is waiting for your decision.")).toBeTruthy();
    expect(rows(container)).toHaveLength(0);
    expect(container.querySelector(".ph")?.textContent).toContain("0 waiting on you");
    expect(container.querySelector(".needs-more")).toBeNull();
  });

  it("says Loading your items… until the list arrives", async () => {
    let finish!: (response: Response) => void;
    const fetch = stubFetch({ "/api/attention": [] });
    const original = fetch.getMockImplementation();
    if (!original) throw new Error("Missing fetch stub");
    fetch.mockImplementation((path, init) =>
      path === "/api/attention"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(path, init),
    );
    const { container } = render(<NextActionsPanel />);
    expect(screen.getByText("Loading your items…")).toBeTruthy();
    // no figure before there is a list to count
    expect(container.querySelector(".ph")?.textContent).not.toContain("waiting on you");
    expect(screen.queryByText("Nothing is waiting for your decision.")).toBeNull();
    await act(async () => {
      finish(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    });
    expect(await screen.findByText("Nothing is waiting for your decision.")).toBeTruthy();
    expect(screen.queryByText("Loading your items…")).toBeNull();
  });

  it("says Could not load your items when the first load fails", async () => {
    stubFetch({ "/api/attention": () => ({ status: 500, body: { error: "down" } }) });
    render(<NextActionsPanel />);
    expect((await screen.findByRole("status")).textContent).toBe("Could not load your items.");
    expect(screen.queryByText("Loading your items…")).toBeNull();
    expect(screen.queryByText("Nothing is waiting for your decision.")).toBeNull();
  });

  it("keeps the last items and says the refresh failed when a later load fails", async () => {
    stubFetch({ "/api/attention": [item({ text: "Pick a port" })] });
    const { container } = render(<NextActionsPanel />);
    await screen.findByText("Pick a port");
    stubFetch({ "/api/attention": () => ({ status: 500, body: { error: "down" } }) });
    await act(async () => {
      hub.refetch("/api/attention");
    });
    expect((await screen.findByRole("status")).textContent).toBe(
      "Refresh failed. Showing the last items.",
    );
    expect(rows(container)).toHaveLength(1);
    expect(screen.getByText("Pick a port")).toBeTruthy();
  });

  it("lists each waiting item as a row of its kind, its text and how long it has waited", async () => {
    stubFetch({
      "/api/attention": [
        item({ key: "k1", kind: "decision", text: "Choose a cache policy", at: NOW - 3 * HOUR }),
      ],
    });
    const { container } = render(<NextActionsPanel />);
    await screen.findByText("Choose a cache policy");
    const [row] = rows(container) as [HTMLElement];
    expect(row.tagName).toBe("BUTTON");
    expect(row.querySelector(".needs-kind")?.textContent).toBe("decision");
    expect(row.querySelector(".needs-text")?.getAttribute("title")).toBe("Choose a cache policy");
    expect(row.querySelector(".needs-age")?.textContent).toBe("3h 0m");
    expect(container.querySelector(".ph")?.textContent).toContain("1 waiting on you");
  });

  it("opens the item on the Needs you page when its row is chosen", async () => {
    stubFetch({ "/api/attention": [item({ key: "esc:shop-app#4001" })] });
    const { container } = render(
      <>
        <NextActionsPanel />
        <Probe />
      </>,
    );
    await screen.findByText("Choose a cache eviction policy");
    expect(screen.getByTestId("item").textContent).toBe("none");
    fireEvent.click(rows(container)[0] as HTMLElement);
    expect(window.location.pathname).toBe("/needs-you/esc%3Ashop-app%234001");
    expect(screen.getByTestId("item").textContent).toBe("none");
  });

  it("shows the operator's items, and leaves out FLIGHT's and the lanes'", async () => {
    stubFetch({
      "/api/attention": [
        item({ key: "mine", text: "For you" }),
        item({ key: "flights", text: "For FLIGHT", owner: "flight" }),
        item({ key: "lanes", text: "For a lane", owner: "lane:octo" }),
        itemWithoutOwner({ key: "nobodys", text: "Ownerless" }),
      ],
    });
    const { container } = render(<NextActionsPanel />);
    await screen.findByText("For you");
    expect(rows(container).map((row) => row.querySelector(".needs-text")?.textContent)).toEqual(
      expect.arrayContaining(["For you", "Ownerless"]),
    );
    expect(screen.queryByText("For FLIGHT")).toBeNull();
    expect(screen.queryByText("For a lane")).toBeNull();
  });

  it("orders the items by kind, the most urgent first", async () => {
    stubFetch({
      "/api/attention": [
        item({ key: "a", kind: "pr", text: "PR #1 · You: review", agentId: null }),
        item({ key: "b", kind: "decision", text: "A decision" }),
      ],
    });
    const { container } = render(<NextActionsPanel />);
    await screen.findByText("A decision");
    const order = rows(container).map((row) => row.querySelector(".needs-kind")?.textContent);
    expect(order).toEqual(["decision", "pr"]);
  });

  it("shows four rows and links the rest to Needs you with their count", async () => {
    stubFetch({
      "/api/attention": Array.from({ length: 7 }, (_, i) =>
        item({ key: `k${i}`, text: `Item ${i}`, at: NOW - (i + 1) * HOUR }),
      ),
    });
    const { container } = render(<NextActionsPanel />);
    await screen.findByText("Item 0");
    expect(rows(container)).toHaveLength(4);
    expect(container.querySelector(".ph")?.textContent).toContain("7 waiting on you");
    const more = within(container.querySelector(".needs-more") as HTMLElement).getByRole("link", {
      name: "3 more waiting on you",
    });
    expect(more.getAttribute("href")).toBe("/needs-you");
    expect(screen.queryByText("Item 4")).toBeNull();
  });

  it("shows exactly four items without a more link", async () => {
    stubFetch({
      "/api/attention": Array.from({ length: 4 }, (_, i) =>
        item({ key: `k${i}`, text: `Item ${i}` }),
      ),
    });
    const { container } = render(<NextActionsPanel />);
    await screen.findByText("Item 3");
    expect(rows(container)).toHaveLength(4);
    expect(container.querySelector(".needs-more")).toBeNull();
  });

  it("links the title to Needs you's home", async () => {
    stubFetch({ "/api/attention": [] });
    const { container } = render(<NextActionsPanel />);
    await screen.findByText("Nothing is waiting for your decision.");
    expect(
      within(container.querySelector("#overviewNextP") as HTMLElement)
        .getByRole("link", { name: "Needs you" })
        .getAttribute("href"),
    ).toBe("/needs-you");
  });
});
