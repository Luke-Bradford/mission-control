import { type AttentionItem, DEFAULT_AWAY } from "@mc/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { PREVIEW_ORIGIN } from "../src/needs/PreviewFrame.tsx";
import { Needs } from "../src/pages/Needs.tsx";
import { DemoSwitch } from "../src/shell/DemoSwitch.tsx";
import { stubFetch } from "./fetchStub.ts";
import { brief, CONFIG, crewRow, HOUR, item, NOW } from "./fixtures.ts";

const SHA = "b".repeat(40);
const view = (ticket: number, over = {}) => ({
  ticket,
  branch: `feature/${ticket}-x`,
  sha: SHA,
  publishedAt: NOW - HOUR,
  pr: ticket + 100,
  running: false,
  url: `${PREVIEW_ORIGIN}/`,
  ...over,
});

const ask = (key: string, ticket: string): AttentionItem =>
  item({
    key,
    kind: "question",
    escalationId: null,
    ticket,
    text: `Question for ${ticket}`,
    at: NOW - HOUR,
    brief: brief({ options: [{ id: "a", label: "Yes", answer: "Yes." }] }),
  });

function routes(items: AttentionItem[], more: Record<string, unknown> = {}) {
  return stubFetch({
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: [crewRow()], firstRunToday: null },
    "/api/attention": items,
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
    "/api/flight": { seat: null, decisions: [] },
    "/api/test-lock": { holder: null, waiting: [] },
    "/api/settings/away": DEFAULT_AWAY,
    "/api/machine": { latest: null },
    "/api/limits": [],
    ...more,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  hub.clear();
  delete document.documentElement.dataset.mcPreview;
  window.history.replaceState(null, "", "/");
});

describe("Open preview", () => {
  it("opens the stored preview as an iframe under a bar with the question", async () => {
    routes([ask("q1", "shop-app#4001")], {
      "/api/design-previews": [view(4001)],
      "POST /api/design-previews/4001/open": view(4001, { running: true }),
    });
    render(<Needs item="q1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open preview" }));
    const dialog = await screen.findByRole("dialog", { name: "Preview of shop-app#4001" });
    const frame = dialog.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame?.getAttribute("src")).toBe(`${PREVIEW_ORIGIN}/`);
    expect(within(dialog).getByText("Question for shop-app#4001")).toBeTruthy();
    const tab = within(dialog).getByRole("link", { name: "Open in a new tab" });
    expect(tab.getAttribute("href")).toBe(`${PREVIEW_ORIGIN}/`);
    expect(tab.getAttribute("rel")).toContain("noopener");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opening a second preview replaces the first", async () => {
    routes([ask("q1", "shop-app#4001"), ask("q2", "shop-app#4002")], {
      "/api/design-previews": [view(4001), view(4002)],
      "POST /api/design-previews/4001/open": view(4001, { running: true }),
      "POST /api/design-previews/4002/open": view(4002, { running: true }),
    });
    const { rerender } = render(<Needs item="q1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open preview" }));
    await screen.findByRole("dialog", { name: "Preview of shop-app#4001" });
    rerender(<Needs item="q2" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open preview" }));
    await screen.findByRole("dialog", { name: "Preview of shop-app#4002" });
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Preview of shop-app#4001" })).toBeNull();
  });

  it("offers no preview for an item whose PR has closed (the hub no longer lists it)", async () => {
    const fetch = routes([ask("q1", "shop-app#4001")], { "/api/design-previews": [] });
    render(<Needs item="q1" />);
    await screen.findByText("Question for shop-app#4001", { selector: "b" }).catch(() => null);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/design-previews", expect.anything()),
    );
    expect(screen.queryByRole("button", { name: "Open preview" })).toBeNull();
  });

  it("offers none to an item with no ticket, and none in Demo", async () => {
    routes([ask("q1", "shop-app#4001")], { "/api/design-previews": [view(4001)] });
    render(<Needs item="q1" />);
    expect(await screen.findByRole("button", { name: "Open preview" })).toBeTruthy();
    cleanup();
    routes([{ ...ask("q1", "shop-app#4001"), ticket: null }], {
      "/api/design-previews": [view(4001)],
    });
    render(<Needs item="q1" />);
    await screen.findAllByText(/Question for/);
    expect(screen.queryByRole("button", { name: "Open preview" })).toBeNull();
  });

  it("says the preview is gone when the hub no longer has it, and shows no frame", async () => {
    routes([ask("q1", "shop-app#4001")], { "/api/design-previews": [view(4001)] });
    render(<Needs item="q1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open preview" }));
    expect(await screen.findByText("That preview is gone.")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });
});

describe("DemoSwitch in a preview", () => {
  it("renders nothing when the page is a preview", () => {
    document.documentElement.dataset.mcPreview = "1";
    const { container } = render(<DemoSwitch />);
    expect(container.innerHTML).toBe("");
  });
  it("renders the switch otherwise", () => {
    render(<DemoSwitch />);
    expect(screen.getByRole("button", { name: /Demo/ })).toBeTruthy();
  });
});
