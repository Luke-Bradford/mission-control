import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installKeys, setPageKey } from "../src/shell/keys.ts";
import { pushOverlay } from "../src/shell/overlays.ts";
import { nextAgent } from "../src/shell/selection.ts";
import { crewRow, item } from "./fixtures.ts";

const press = (key: string, target: Element = document.body) => fireEvent.keyDown(target, { key });

let app: {
  navigate: ReturnType<typeof vi.fn>;
  toggleDock: ReturnType<typeof vi.fn>;
  help: ReturnType<typeof vi.fn>;
  selectNext: ReturnType<typeof vi.fn>;
  selectPrev: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
};
let off: () => void;

beforeEach(() => {
  app = {
    navigate: vi.fn(),
    toggleDock: vi.fn(),
    help: vi.fn(),
    selectNext: vi.fn(),
    selectPrev: vi.fn(),
    toast: vi.fn(),
  };
  off = installKeys(app);
});

afterEach(() => {
  off();
  setPageKey("i", null);
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("installKeys", () => {
  it.each([
    ["o", "/"],
    ["f", "/flight"],
    ["b", "/board"],
    ["a", "/agent"],
    ["c", "/comms"],
    ["t", "/telemetry"],
    ["s", "/setup"],
  ])("g then %s goes to %s", (key, to) => {
    press("g");
    press(key);
    expect(app.navigate).toHaveBeenCalledWith(to);
    expect(app.toggleDock).not.toHaveBeenCalled(); // g f is a page, not the dock
  });

  it("forgets g after 900 ms", () => {
    vi.useFakeTimers();
    press("g");
    vi.advanceTimersByTime(800);
    press("b");
    expect(app.navigate).toHaveBeenCalledWith("/board");
    app.navigate.mockClear();
    press("g");
    vi.advanceTimersByTime(1000);
    press("b");
    expect(app.navigate).not.toHaveBeenCalled();
  });

  it("f toggles the dock, j/k select, / opens the agent page, ? opens help", () => {
    press("f");
    expect(app.toggleDock).toHaveBeenCalledTimes(1);
    press("j");
    press("k");
    expect(app.selectNext).toHaveBeenCalledTimes(1);
    expect(app.selectPrev).toHaveBeenCalledTimes(1);
    press("/");
    expect(app.navigate).toHaveBeenCalledWith("/agent");
    press("?");
    expect(app.help).toHaveBeenCalledTimes(1);
  });

  it("i toasts off the agent page, or runs the page's own handler", () => {
    press("i");
    expect(app.toast).toHaveBeenCalledWith("Open an agent to interrupt it.");
    const fn = vi.fn();
    setPageKey("i", fn);
    press("i");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(app.toast).toHaveBeenCalledTimes(1);
    setPageKey("i", null);
    press("i");
    expect(app.toast).toHaveBeenCalledTimes(2);
  });

  it("ignores every key while typing; Esc blurs the field", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    for (const k of ["f", "j", "g", "?", "/", "i"]) press(k, input);
    press("b", input);
    expect(app.toggleDock).not.toHaveBeenCalled();
    expect(app.selectNext).not.toHaveBeenCalled();
    expect(app.navigate).not.toHaveBeenCalled();
    expect(app.help).not.toHaveBeenCalled();
    expect(app.toast).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    press("Escape", input);
    expect(document.activeElement).not.toBe(input);
  });

  it("ignores keys with Ctrl, Cmd or Alt", () => {
    fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    fireEvent.keyDown(document.body, { key: "j", ctrlKey: true });
    expect(app.toggleDock).not.toHaveBeenCalled();
    expect(app.selectNext).not.toHaveBeenCalled();
  });

  it("Esc closes only the topmost overlay", () => {
    const below = vi.fn();
    const top = vi.fn();
    pushOverlay("below", below);
    pushOverlay("top", top);
    press("Escape");
    expect(top).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
  });

  it("stops listening once removed", () => {
    off();
    press("f");
    expect(app.toggleDock).not.toHaveBeenCalled();
    off = () => {};
  });
});

describe("nextAgent", () => {
  const rows = [
    crewRow({ id: "a", index: 0, repoId: "shop-app", hudState: "running" }),
    crewRow({ id: "b", index: 1, repoId: "site-builder", hudState: "running" }),
    crewRow({ id: "c", index: 2, repoId: "shop-app", hudState: "running" }),
  ];

  it("j wraps within the session filter", () => {
    expect(nextAgent(rows, [], "shop-app", "a", 1)).toBe("c");
    expect(nextAgent(rows, [], "shop-app", "c", 1)).toBe("a");
    expect(nextAgent(rows, [], "shop-app", "a", -1)).toBe("c");
    expect(nextAgent(rows, [], "all", "a", 1)).toBe("b");
  });

  it("starts at the first (j) or last (k) agent when nothing in view is selected", () => {
    expect(nextAgent(rows, [], "shop-app", null, 1)).toBe("a");
    expect(nextAgent(rows, [], "shop-app", "b", -1)).toBe("c");
  });

  it("follows crewOrder: an agent that needs you comes first", () => {
    expect(nextAgent(rows, [item({ agentId: "c", ticket: null })], "all", null, 1)).toBe("c");
  });

  it("is null when no agent is in view", () => {
    expect(nextAgent(rows, [], "nope", "a", 1)).toBeNull();
    expect(nextAgent([], [], "all", null, 1)).toBeNull();
  });
});
