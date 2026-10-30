import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/shell/CommandPalette.tsx";
import { installKeys } from "../src/shell/keys.ts";
import { openPalette } from "../src/shell/overlays.ts";
import { PALETTE_RECENT_KEY, readKey } from "../src/storage.ts";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, crewRow, item } from "./fixtures.ts";

const noop = () => {};
let off: () => void = noop;
afterEach(() => {
  off();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const api = () =>
  stubFetch({
    "/api/repos": [{ id: "shop-app", github: "octo-org/shop-app", project: 1 }],
    "/api/crew": {
      rows: [
        crewRow(),
        crewRow({ id: "shop-app-dev", kind: "crew", loopKind: "crew", role: "dev" }),
      ],
      firstRunToday: null,
    },
    "/api/config": {
      crew: {
        sessions: [{ id: "s1", repoId: "shop-app", seats: [{ id: "shop-app-dev", role: "dev" }] }],
      },
    },
    "/api/comms/agents/shop-app-dev": {
      messages: [],
      inbox: [],
      contacts: [
        { id: "CAPCOM", lastMessage: { text: "Ship the quote cache" }, count: 1, unread: 0 },
      ],
    },
    "/api/attention": [item()],
    "/api/boards/shop-app": [boardItem()],
    "/api/repos/shop-app/prs": [
      {
        repoId: "shop-app",
        number: 88,
        title: "Tidy the footer",
        url: "https://github.com/octo-org/shop-app/pull/88",
        ticket: null,
        state: "open",
      },
    ],
    "POST /api/agents/shop-app-ta/pause": { ok: true },
  });

const box = () => screen.getByRole("combobox");
const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...init });
  });

describe("CommandPalette", () => {
  it("⌘K and Ctrl+K open it, even while typing; the focus returns on Esc", () => {
    api();
    off = installKeys({
      navigate: noop,
      toggleDock: noop,
      help: noop,
      selectNext: noop,
      selectPrev: noop,
      toast: noop,
    });
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    render(<CommandPalette />);
    expect(screen.queryByRole("dialog")).toBeNull();
    key("k", { metaKey: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(document.activeElement).toBe(box());
    key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(field);
    key("k", { ctrlKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    field.remove();
  });

  it("types to a ticket, moves with the arrows and goes there on Enter", async () => {
    api();
    render(<CommandPalette />);
    act(() => openPalette());
    fireEvent.change(box(), { target: { value: "3349" } });
    const rows = await screen.findAllByRole("option");
    expect(rows[0]?.textContent).toContain("shop-app#3349");
    key("Enter");
    expect(window.location.pathname).toBe("/board/shop-app/3349");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(JSON.parse(readKey(PALETTE_RECENT_KEY) ?? "[]")).toEqual(["ticket:shop-app#3349"]);
  });

  it("moves the selection with the arrows, wrapping at both ends", async () => {
    api();
    render(<CommandPalette />);
    act(() => openPalette());
    fireEvent.change(box(), { target: { value: "cache" } });
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
    const selected = () =>
      screen.getAllByRole("option").findIndex((o) => o.getAttribute("aria-selected") === "true");
    expect(selected()).toBe(0);
    key("ArrowDown");
    expect(selected()).toBe(1);
    key("ArrowUp");
    key("ArrowUp");
    expect(selected()).toBe(screen.getAllByRole("option").length - 1);
  });

  it("lists the recent picks first when nothing is typed", async () => {
    api();
    localStorage.setItem(PALETTE_RECENT_KEY, JSON.stringify(["page:audit"]));
    render(<CommandPalette />);
    act(() => openPalette());
    const rows = await screen.findAllByRole("option");
    expect(rows[0]?.textContent).toContain("Audit");
    expect(rows[0]?.textContent).toContain("Recent");
  });

  it("runs the pause action through the pause endpoint", async () => {
    const fetch = api();
    render(<CommandPalette />);
    act(() => openPalette());
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/crew", expect.anything()));
    fireEvent.change(box(), { target: { value: "pause" } });
    await waitFor(() => expect(screen.getAllByRole("option")[0]?.textContent).toMatch(/Pause/));
    key("Enter");
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/agents/shop-app-ta/pause",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("finds an unlinked open PR by number, and a Comms conversation with no attention item", async () => {
    api();
    render(<CommandPalette />);
    act(() => openPalette());
    fireEvent.change(box(), { target: { value: "88" } });
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]?.textContent).toContain("Tidy the footer"),
    );
    fireEvent.change(box(), { target: { value: "quote cache" } });
    await waitFor(() =>
      expect(screen.getAllByRole("option").some((o) => o.textContent?.includes("↔"))).toBe(true),
    );
    key("Enter");
    expect(window.location.pathname).toMatch(
      /^\/comms\/agents\/shop-app-dev\/contacts\/CAPCOM$|^\/board\//,
    );
  });

  it("names what is still loading, and does not say nothing matches", async () => {
    const fetch_ = stubFetch({
      "/api/repos": [{ id: "shop-app", github: "octo-org/shop-app", project: 1 }],
      "/api/crew": { rows: [], firstRunToday: null },
      "/api/config": { crew: null },
      "/api/attention": [],
      "/api/repos/shop-app/prs": [],
    });
    // the board request never answers
    const answered = fetch_.getMockImplementation();
    fetch_.mockImplementation((input: string, init?: RequestInit) =>
      input === "/api/boards/shop-app" ? new Promise(() => {}) : (answered?.(input, init) as never),
    );
    render(<CommandPalette />);
    act(() => openPalette());
    fireEvent.change(box(), { target: { value: "zzzqq" } });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(
        /^Still loading: tickets of shop-app\.$/,
      ),
    );
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
  });

  it("names a source that failed, and does not say nothing matches", async () => {
    stubFetch({
      "/api/repos": [{ id: "shop-app", github: "octo-org/shop-app", project: 1 }],
      "/api/crew": { rows: [], firstRunToday: null },
      "/api/config": { crew: null },
      "/api/attention": [],
      "/api/boards/shop-app": () => ({ status: 500, body: { error: "boom" } }),
      "/api/repos/shop-app/prs": () => ({ status: 500, body: { error: "boom" } }),
    });
    render(<CommandPalette />);
    act(() => openPalette());
    fireEvent.change(box(), { target: { value: "zzzqq" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("tickets of shop-app");
    expect(alert.textContent).toContain("PRs of shop-app");
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
  });

  it("says when nothing matches", async () => {
    api();
    render(<CommandPalette />);
    act(() => openPalette());
    fireEvent.change(box(), { target: { value: "zzzqq" } });
    expect(await screen.findByText(/Nothing matches/)).toBeTruthy();
  });
});
