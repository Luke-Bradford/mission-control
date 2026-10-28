import type { AttentionItem, AwaySettings, Crew, LimitRow } from "@mc/core";
import { DEFAULT_AWAY, LOCK_HEADER_TITLE, type TestLockState } from "@mc/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Header } from "../src/shell/Header.tsx";
import { setFlightUnread } from "../src/shell/overlays.ts";
import { useSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { THEME_KEY } from "../src/storage.ts";
import { setTheme } from "../src/theme.ts";
import { stubFetch } from "./fetchStub.ts";
import {
  brief,
  CONFIG,
  CREW_CONFIG,
  crewRow,
  HOUR,
  item,
  itemWithoutOwner,
  limit7d,
  MIN,
  NOW,
  REPOS,
} from "./fixtures.ts";

const crew = (over: Partial<Crew> = {}): Crew => ({
  rows: [crewRow()],
  firstRunToday: null,
  ...over,
});

function routes(
  over: {
    config?: typeof CONFIG;
    attention?: AttentionItem[];
    crew?: Crew;
    away?: AwaySettings;
    machine?: unknown;
    lock?: TestLockState;
    limits?: LimitRow[];
  } = {},
) {
  return stubFetch({
    "/api/test-lock": over.lock ?? { holder: null, waiting: [] },
    "/api/crew": over.crew ?? crew(),
    "/api/attention": over.attention ?? [],
    "/api/settings/away": over.away ?? DEFAULT_AWAY,
    "/api/machine": over.machine ?? { latest: null },
    "/api/limits": over.limits ?? [],
    "/api/repos": REPOS,
    "/api/config": over.config ?? CONFIG,
    "/api/flight": { seat: null, decisions: [] },
  });
}

const tab = (name: RegExp) =>
  within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", { name });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe("Header chat button", () => {
  it("badges the asks FLIGHT has put to you and names the count", async () => {
    routes({
      attention: [
        item({ key: "esc:a#1", brief: brief() }),
        item({ key: "esc:a#2", brief: brief() }),
        item({ key: "esc:a#3" }),
      ],
    });
    render(<Header page="board" />);
    const btn = await screen.findByRole("button", { name: "FLIGHT chat, 2 waiting on you" });
    expect(btn.querySelector(".dock-unread")?.textContent).toBe("2");
  });

  it("shows no badge for unread replies alone", async () => {
    routes();
    render(<Header page="board" />);
    act(() => setFlightUnread(2));
    const quiet = await screen.findByRole("button", { name: "FLIGHT chat" });
    expect(quiet.querySelector(".dock-unread")).toBeNull();
    act(() => setFlightUnread(0));
  });
});

describe("Header", () => {
  it("shows the brand, the pages in order and marks the current one", () => {
    routes();
    render(<Header page="board" />);
    expect(screen.getByText("MISSION CONTROL")).toBeTruthy();
    const links = within(screen.getByRole("navigation", { name: "Pages" })).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      "Overview",
      "Flight",
      "Board",
      "Agents",
      "Map",
      "Comms",
      "Telemetry",
    ]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/",
      "/flight",
      "/board",
      "/agent",
      "/map",
      "/comms",
      "/telemetry",
    ]);
    expect(tab(/^Board/).getAttribute("aria-current")).toBe("page");
    expect(tab(/^Board/).className).toBe("on");
  });

  it("shows the highest 7-day usage across a provider's accounts", async () => {
    routes({
      config: {
        ...CONFIG,
        accounts: [
          ...CONFIG.accounts,
          { id: "codex-backup", vendor: "codex", alertAt: 70, stopAt: 80 },
        ],
      },
      limits: [
        limit7d({ accountId: "codex-main", used: 18 }),
        limit7d({ accountId: "codex-backup", used: 92 }),
      ],
    });
    render(<Header page="overview" />);
    expect(await screen.findByRole("img", { name: "Claude —; Codex 92%" })).toBeTruthy();
  });

  it("puts lamps on the tabs from the attention list", async () => {
    routes({
      attention: [
        item({ key: "esc:1", kind: "decision", escalationId: "shop-app#1" }),
        item({ key: "error:x", kind: "error", escalationId: null, acked: true }),
      ],
    });
    render(<Header page="overview" />);
    const comms = await within(tab(/^Comms/)).findByRole("img");
    expect(comms.className).toBe("lamp crit"); // tab lamps never pulse (cat 1.1)
    expect(comms.getAttribute("aria-label")).toBe("Error, Decision");
    const board = within(tab(/^Board/)).getByRole("img");
    expect(board.getAttribute("aria-label")).toBe("Decision");
    expect(within(tab(/^Overview/)).queryByRole("img")).toBeNull();
  });

  it("Comms and Board show their attention lamps; acked items hold still", async () => {
    routes({
      attention: [
        item({ key: "stall:a:r", kind: "stalled", escalationId: null, acked: true }),
        item({ key: "esc:2", kind: "question", escalationId: "shop-app#2", acked: true }),
      ],
    });
    render(<Header page="overview" />);
    const comms = await within(tab(/^Comms/)).findByRole("img");
    expect(comms.className).toBe("lamp warn");
    expect(comms.getAttribute("aria-label")).toBe("Stalled, Question");
    expect(
      within(tab(/^Board/))
        .getByRole("img")
        .getAttribute("aria-label"),
    ).toBe("Question");
  });

  it("counts what needs you and says whether any is unacknowledged", async () => {
    routes({ attention: [item({ key: "a" }), item({ key: "b", acked: true })] });
    render(<Header page="overview" />);
    const btn = await screen.findByRole("button", {
      name: "Needs you 2: 2 things, some not yet acknowledged. Opens Comms.",
    });
    expect(btn.textContent).toBe("Needs you 2");
    expect(btn.className).toBe("needs-btn has");
    expect(btn.title).toBe("Everything waiting on you (on Comms) · 1 not acknowledged");
    fireEvent.click(btn);
    expect(window.location.pathname).toBe("/comms");
  });

  it("counts only the operator's items; one with no owner counts", async () => {
    routes({
      attention: [
        item({ key: "a" }),
        itemWithoutOwner({ key: "b" }),
        item({ key: "c", owner: "flight" }),
        item({ key: "d", owner: "lane:octo" }),
      ],
    });
    render(<Header page="overview" />);
    const btn = await screen.findByRole("button", { name: /^Needs you 2:/ });
    expect(btn.textContent).toBe("Needs you 2");
  });

  it("the Needs-you pill exposes one title: the lamp inside adds none", async () => {
    routes({ attention: [item({ key: "a" })] });
    const { unmount } = render(<Header page="overview" />);
    const btn = await screen.findByRole("button", { name: /^Needs you 1/ });
    expect(btn.querySelector(".lamp.warn")).not.toBeNull();
    expect(btn.querySelectorAll("[title]")).toHaveLength(0);
    unmount();
    routes({ attention: [] });
    render(<Header page="overview" />);
    const zero = await screen.findByRole("button", { name: /^Needs you 0/ });
    expect(zero.querySelector(".lamp.off")).not.toBeNull();
    expect(zero.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("all acknowledged, and nothing at all", async () => {
    routes({ attention: [item({ acked: true })] });
    const { unmount } = render(<Header page="overview" />);
    const acked = await screen.findByRole("button", { name: "Needs you 1: 1 thing. Opens Comms." });
    expect(acked.title).toBe("Everything waiting on you (on Comms)"); // none to explain
    unmount();
    routes({ attention: [] });
    render(<Header page="overview" />);
    const zero = await screen.findByRole("button", { name: "Needs you 0: nothing. Opens Comms." });
    expect(zero.className).toBe("needs-btn");
    expect(within(zero).getByRole("img").className).toBe("lamp off");
  });

  it("MET is a dash before the first run today", async () => {
    routes({ crew: crew({ firstRunToday: null }) });
    render(<Header page="overview" />);
    await vi.waitFor(() =>
      expect(screen.getByTitle(/^Mission elapsed time/).textContent).toBe("MET —"),
    );
  });

  it("MET counts from the first run today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    routes({ crew: crew({ firstRunToday: NOW - (HOUR + 2 * MIN + 3000) }) });
    render(<Header page="overview" />);
    const met = screen.getByTitle("Mission elapsed time: since the first agent started today");
    await vi.waitFor(() => expect(met.textContent).toBe("MET 01:02:03"));
  });

  it("keeps machine status reachable by keyboard and opens Overview", async () => {
    routes({
      machine: {
        latest: {
          at: NOW,
          cpuPct: 12.4,
          cores: 10,
          memUsedBytes: 32e9,
          memTotalBytes: 64e9,
          diskFreeBytes: null,
          diskTotalBytes: null,
          agents: null,
        },
      },
    });
    render(<Header page="flight" />);
    const btn = await screen.findByRole("button", {
      name: "Machine status: CPU 12%, RAM 50%, Lock: free. Opens Overview.",
    });
    expect(btn.closest(".top-status")).not.toBeNull();
    expect(btn.closest(".sr-only")).toBeNull();
    const tooltip = within(btn).getByRole("tooltip");
    expect(btn.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.textContent).toBe(`CPU 12%, RAM 50%, Lock: free${LOCK_HEADER_TITLE}`);
    expect(btn.hasAttribute("title")).toBe(false);
    btn.focus();
    expect(document.activeElement).toBe(btn);
    expect(tooltip.className).toBe("mach-tooltip");
    fireEvent.click(btn);
    expect(window.location.pathname).toBe("/");
  });

  it("the Lock span names the holder and the queue", async () => {
    routes({
      lock: {
        holder: { runId: "r-1", seatId: "guido-2", command: "pnpm test", since: NOW },
        waiting: [{ runId: "r-2", seatId: "guido-3", command: "pnpm -s test", since: NOW }],
      },
    });
    render(<Header page="flight" />);
    const btn = await screen.findByRole("button", { name: /Lock: GUIDO-2 \+1/ });
    expect(btn).toBeTruthy();
  });

  it("puts a stalled lock warning in the machine tooltip", async () => {
    routes({
      crew: crew({ rows: [crewRow({ id: "guido-2", hudState: "stalled" })] }),
      lock: {
        holder: { runId: "r-1", seatId: "guido-2", command: "pnpm test", since: NOW },
        waiting: [{ runId: "r-2", seatId: "guido-3", command: "pnpm -s test", since: NOW }],
      },
    });
    render(<Header page="flight" />);
    const btn = await screen.findByRole("button", { name: /Lock: guido-2 \+1/ });
    expect(within(btn).getByRole("tooltip").textContent).toContain(
      "The run holding the lock is stalled",
    );
  });

  it("the machine button shows dashes without a sample", async () => {
    routes();
    render(<Header page="overview" />);
    const btn = await screen.findByRole("button", {
      name: "Machine status: CPU —, RAM —, Lock: free. Opens Overview.",
    });
    expect(btn).toBeTruthy();
  });

  it.each([
    [DEFAULT_AWAY, "Away mode", "ghost"],
    [{ ...DEFAULT_AWAY, on: true, until: "2026-10-28" }, "Away · 28 Oct", "warn"],
    [{ ...DEFAULT_AWAY, on: true, until: "2026-09-08" }, "Away · 8 Sep", "warn"],
    [{ ...DEFAULT_AWAY, on: true, until: "" }, "Away · on", "warn"],
  ])("away button %#", async (away, text, cls) => {
    routes({ away });
    render(<Header page="overview" />);
    const btn = screen.getByTitle("Away mode: what Mission Control may do while you're away");
    await vi.waitFor(() => expect(btn.textContent).toBe(text));
    expect(btn.className).toBe(cls);
  });

  it("the theme button cycles system → light → dark → system, remembers it and toasts", () => {
    routes();
    render(
      <>
        <Header page="overview" />
        <Toast />
      </>,
    );
    const btn = screen.getByRole("button", { name: "Theme: follow the system. Click to change." });
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-label")).toBe("Theme: light. Click to change.");
    expect(btn.title).toBe("Theme: light. Click to change.");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    expect(screen.getByRole("status").textContent).toBe("Theme: light.");
    fireEvent.click(btn);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("status").textContent).toBe("Theme: dark.");
    fireEvent.click(btn);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem(THEME_KEY)).toBe("system");
    expect(screen.getByRole("status").textContent).toBe("Theme: follows the system.");
    expect(btn.getAttribute("aria-label")).toBe("Theme: follow the system. Click to change.");
  });

  it("starts the theme button from the stored choice", () => {
    localStorage.setItem(THEME_KEY, "dark");
    routes();
    render(<Header page="overview" />);
    expect(screen.getByRole("button", { name: "Theme: dark. Click to change." })).toBeTruthy();
  });

  it("a theme change made after the first render but before the button subscribes still shows", () => {
    routes();
    // effects run in tree order: this one fires before the theme button's effect subscribes
    function ChangesTheme() {
      useEffect(() => setTheme("dark"), []);
      return null;
    }
    render(
      <>
        <ChangesTheme />
        <Header page="overview" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Theme: dark. Click to change." })).toBeTruthy();
  });

  it("the same gap with storage blocked still shows the choice made in it", () => {
    routes();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    function ChangesTheme() {
      useEffect(() => setTheme("dark"), []);
      return null;
    }
    render(
      <>
        <ChangesTheme />
        <Header page="overview" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Theme: dark. Click to change." })).toBeTruthy();
  });

  it("the theme button follows a change made in another tab", () => {
    routes();
    render(<Header page="overview" />);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "light" }));
    });
    expect(screen.getByRole("button", { name: "Theme: light. Click to change." })).toBeTruthy();
  });

  it("offers All sessions and each configured crew session, and sets the session filter", async () => {
    routes({ config: CREW_CONFIG });
    let seen = "";
    function Probe() {
      seen = useSession()[0];
      return null;
    }
    render(
      <>
        <Header page="overview" />
        <Probe />
      </>,
    );
    const select = screen.getByRole("combobox", { name: "Session" }) as HTMLSelectElement;
    await vi.waitFor(() =>
      expect([...select.options].map((o) => o.textContent)).toEqual(["All sessions", "s/s1"]),
    );
    expect(seen).toBe("all");
    act(() => {
      fireEvent.change(select, { target: { value: "s1" } });
    });
    expect(seen).toBe("s1");
  });

  it("keeps Setup in the top-right settings button and opens FLIGHT from it", () => {
    routes();
    const { unmount } = render(<Header page="setup" />);
    expect(
      within(screen.getByRole("navigation", { name: "Pages" })).queryByText("Setup"),
    ).toBeNull();
    const setup = screen.getByRole("button", { name: "Setup" });
    expect(setup.className).toContain("on");
    expect(setup.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(setup);
    expect(window.location.pathname).toBe("/setup");
    const chat = screen.getByRole("button", { name: "FLIGHT chat" });
    expect(chat.title).toBe("Open FLIGHT chat in Comms (f)");
    expect(chat.getAttribute("aria-pressed")).toBeNull();
    expect(chat.querySelector(".badge")).toBeNull();
    fireEvent.click(chat);
    expect(window.location.pathname).toBe("/comms");
    unmount();
    render(<Header page="comms" />);
    const open = screen.getByRole("button", { name: "FLIGHT chat" });
    expect(open.title).toBe("FLIGHT chat is open in Comms");
    expect(open.getAttribute("aria-pressed")).toBe("true");
  });
});
