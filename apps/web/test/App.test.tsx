import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { navigate } from "../src/router.ts";
import { toggleDock } from "../src/shell/overlays.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, crewRow, REPOS } from "./fixtures.ts";

class StubEventSource {
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("EventSource", StubEventSource);
  stubFetch({ "/api/repos": REPOS, "/api/config": CONFIG });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const at = (path: string) => {
  window.history.replaceState(null, "", path);
  return render(<App />);
};

describe("App", () => {
  it("does not re-render the application on a clock tick", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const renders = vi.fn();
    window.history.replaceState(null, "", "/");
    render(<App onRender={renders} />);
    await vi.runOnlyPendingTimersAsync();
    const initial = renders.mock.calls.length;

    await act(async () => vi.advanceTimersByTime(1000));

    expect(renders).toHaveBeenCalledTimes(initial);
    vi.useRealTimers();
  });

  it.each([
    ["/", "Overview"],
    ["/flight", "Flight"],
    ["/board", "Board"],
    ["/agent", "Agents"],
    ["/map/sample", "Crew activity map"],
    ["/comms", "Comms"],
    ["/telemetry", "Telemetry"],
    ["/setup/loops", "Setup"],
  ])("%s has one page heading and the shell landmarks", async (path, heading) => {
    const { container } = at(path);
    await screen.findByRole("heading", { level: 1, name: heading });
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Pages" })).toBeTruthy();
  });

  it("skips from the Board link to the board content", async () => {
    at("/board");
    const board = await screen.findByRole("heading", { level: 2, name: "Work board" });
    fireEvent.click(screen.getByRole("link", { name: "Skip to board" }));
    expect(document.activeElement).toBe(board);
  });

  it.each([
    ["/", "page-overview", "Overview"],
    ["/flight", "page-flight", "Flight"],
    ["/board", "page-board", "Board"],
    ["/agent", "page-agent", "Agents"],
    ["/map/sample", "page-map", "Map"],
    ["/comms", "page-comms", "Comms"],
    ["/telemetry", "page-telemetry", "Telemetry"],
    ["/setup/loops", "page-setup", null],
  ])("%s renders its page and marks its tab", async (path, id, tabName) => {
    const { container } = at(path);
    await waitFor(() => expect(container.querySelector(`main > section#${id}`)).not.toBeNull());
    const nav = screen.getByRole("navigation", { name: "Pages" });
    const current = within(nav)
      .queryAllByRole("link")
      .filter((a) => a.getAttribute("aria-current"));
    expect(current.map((a) => a.textContent)).toEqual(tabName ? [tabName] : []);
  });

  it("an unknown path shows Overview at /", async () => {
    const { container } = at("/nope");
    await vi.waitFor(() => expect(window.location.pathname).toBe("/"));
    await waitFor(() => expect(container.querySelector("#page-overview")).not.toBeNull());
  });

  it.each([
    ["/agents/shop-app-ta", "/agent/shop-app-ta", ""],
    ["/needs/shop-app%233227", "/comms/esc%3Ashop-app%233227", ""],
    ["/config", "/setup/sources", "#glossary"],
    ["/settings#glossary", "/setup/sources", "#glossary"],
    ["/settings", "/setup", ""],
    ["/boards/shop-app", "/board/shop-app", ""],
    ["/metrics", "/telemetry", ""],
  ])("redirects old path %s to %s%s", async (from, to, hash) => {
    Element.prototype.scrollIntoView = vi.fn();
    at(from);
    await vi.waitFor(() => expect(window.location.pathname).toBe(to));
    expect(window.location.hash).toBe(hash);
  });

  it("g then b goes to the Board; ? opens the help", async () => {
    const { container } = at("/");
    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "b" });
    });
    expect(window.location.pathname).toBe("/board");
    await waitFor(() => expect(container.querySelector("#page-board")).not.toBeNull());
    act(() => {
      fireEvent.keyDown(document.body, { key: "?" });
    });
    expect(screen.getByRole("dialog", { name: "Keys and lamps" })).toBeTruthy();
  });

  it("opens FLIGHT in Comms from Setup without changing the unmounted dock state", async () => {
    act(() => toggleDock(false));
    const { container } = at("/setup");
    await waitFor(() => expect(container.querySelector("#page-setup")).not.toBeNull());
    act(() => {
      fireEvent.keyDown(document.body, { key: "f" });
    });
    expect(window.location.pathname).toBe("/comms");
    await waitFor(() => expect(container.querySelector("#page-comms")).not.toBeNull());
    expect(screen.getByRole("button", { name: "FLIGHT chat" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // On Comms, FLIGHT is already open: f must not toggle a dock that is not mounted.
    act(() => {
      fireEvent.keyDown(document.body, { key: "f" });
      navigate("/");
    });
    await waitFor(() => expect(container.querySelector("#page-overview")).not.toBeNull());
    expect(screen.getByRole("button", { name: "FLIGHT chat" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("g then m opens the Map full width, where f opens FLIGHT in Comms like Setup", async () => {
    act(() => toggleDock(true));
    const { container } = at("/");
    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "m" });
    });
    expect(window.location.pathname).toMatch(/^\/map/);
    await waitFor(() => expect(container.querySelector("#page-map")).not.toBeNull());
    expect(container.querySelector(".shell.shell-full")).not.toBeNull();
    expect(container.querySelector(".dock")).toBeNull();
    act(() => {
      fireEvent.keyDown(document.body, { key: "f" });
    });
    expect(window.location.pathname).toBe("/comms");
  });

  it("i off the agent page toasts", () => {
    at("/");
    act(() => {
      fireEvent.keyDown(document.body, { key: "i" });
    });
    expect(screen.getByRole("status").textContent).toBe("Open an agent to interrupt it.");
  });

  it("the footer carries the key hints, Setup included, and no sample-data chip", () => {
    const { container } = at("/");
    const keys = container.querySelector(".keys");
    expect(keys?.textContent).toContain("g then o f b a m c t pages");
    expect(keys?.textContent).toContain("s Setup");
    for (const hint of ["f FLIGHT", "jk next agent", "/ message agent", "i interrupt", "? help"]) {
      expect(keys?.textContent).toContain(hint);
    }
    expect(keys?.textContent).not.toContain("Agent page");
    expect(keys?.textContent).not.toContain("Sample data");
  });

  it("the build-status toggle shows the legend and hides phase badges", () => {
    const { container } = at("/flight");
    const btn = screen.getByRole("button", { name: "Show build status" });
    expect(container.querySelector(".bslegend")?.hasAttribute("hidden")).toBe(true);
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Hide build status");
    expect(container.querySelector(".bslegend")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector(".app")?.classList.contains("bs-on")).toBe(true);
    expect(localStorage.getItem("mc-build-status")).toBe("true");
  });

  it("a popped-out agent (?popout=1) renders only the Agent page, titled with its id", async () => {
    const { container, unmount } = at("/agent/shop-app-ta?popout=1");
    await waitFor(() =>
      expect(container.querySelector("main > section#page-agent")).not.toBeNull(),
    );
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
    expect(container.querySelector(".keys")).toBeNull();
    expect(container.querySelector("#dock")).toBeNull();
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector("footer")).toBeNull();
    expect(document.title).toBe("shop-app-ta · Mission Control");
    unmount();
    const full = at("/agent/shop-app-ta");
    expect(screen.getByRole("navigation", { name: "Pages" })).toBeTruthy();
    expect(full.container.querySelector(".keys")).not.toBeNull();
  });

  it("a pop-out ignores the g page keys and has no Pop out control", async () => {
    stubFetch({
      "/api/repos": REPOS,
      "/api/config": CONFIG,
      "/api/crew": { rows: [crewRow()], firstRunToday: null },
    });
    at("/agent/shop-app-ta?popout=1");
    await screen.findByRole("region", { name: "shop-app-ta details" });
    expect(screen.queryByRole("button", { name: "Pop out" })).toBeNull();
    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "b" });
    });
    expect(window.location.pathname).toBe("/agent/shop-app-ta");
  });

  it("a pop-out stays one when it moves to another agent, which drops ?popout=1", async () => {
    stubFetch({
      "/api/repos": REPOS,
      "/api/config": CONFIG,
      "/api/crew": {
        rows: [crewRow(), crewRow({ id: "other-seat", index: 3 })],
        firstRunToday: null,
      },
    });
    const { container } = at("/agent/shop-app-ta?popout=1");
    await screen.findByRole("region", { name: "shop-app-ta details" });
    act(() => navigate("/agent/other-seat"));
    await screen.findByRole("region", { name: "other-seat details" });
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("button", { name: "Pop out" })).toBeNull();
    expect(container.querySelector(".popout")).not.toBeNull();
    expect(container.querySelector("header")).toBeNull();
  });

  it("the full app's Agent header has Pop out", async () => {
    stubFetch({
      "/api/repos": REPOS,
      "/api/config": CONFIG,
      "/api/crew": { rows: [crewRow()], firstRunToday: null },
    });
    at("/agent/shop-app-ta");
    await screen.findByRole("button", { name: "Pop out" });
  });

  it("the Setup sidebar follows the URL", async () => {
    at("/setup");
    const tabs = await screen.findByRole("navigation", { name: "Setup sections" });
    expect(
      within(tabs).getByRole("button", { name: "Accounts" }).getAttribute("aria-current"),
    ).toBe("page");
    fireEvent.click(within(tabs).getByRole("button", { name: "Loops" }));
    expect(window.location.pathname).toBe("/setup/loops");
  });
});
