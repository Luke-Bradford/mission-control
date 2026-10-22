import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HelpModal } from "../src/shell/HelpModal.tsx";
import { installKeys } from "../src/shell/keys.ts";
import { openHelp } from "../src/shell/overlays.ts";

let off: () => void;
const noop = () => {};

beforeEach(() => {
  off = installKeys({
    navigate: noop,
    toggleDock: noop,
    help: openHelp,
    selectNext: noop,
    selectPrev: noop,
    toast: noop,
  });
});

afterEach(() => off());

describe("HelpModal", () => {
  it("? opens it, Esc closes it", () => {
    render(<HelpModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      fireEvent.keyDown(document.body, { key: "?" });
    });
    expect(screen.getByRole("dialog", { name: "Keys and lamps" })).toBeTruthy();
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives focus back to what had it when it closes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    render(<HelpModal />);
    act(() => openHelp());
    expect(document.activeElement?.textContent).toBe("Close");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.activeElement).toBe(opener);
    act(() => openHelp());
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps Tab inside: Close is the only stop, so Tab and Shift+Tab stay on it", () => {
    render(<HelpModal />);
    act(() => openHelp());
    const close = screen.getByRole("button", { name: "Close" });
    expect(fireEvent.keyDown(close, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(close);
  });

  it("the backdrop is focusable and carries the trap: Tab and Shift+Tab from it go to Close", () => {
    render(<HelpModal />);
    act(() => openHelp());
    const root = screen.getByRole("dialog").closest(".modal") as HTMLElement;
    expect(root.getAttribute("tabindex")).toBe("-1");
    const close = screen.getByRole("button", { name: "Close" });
    root.focus();
    expect(document.activeElement).toBe(root);
    expect(fireEvent.keyDown(root, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(close);
    root.focus();
    expect(fireEvent.keyDown(root, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(close);
  });

  it("Close closes it", () => {
    render(<HelpModal />);
    act(() => openHelp());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says the catalogue's text, without the mockup sentence", () => {
    render(<HelpModal />);
    act(() => openHelp());
    const text = screen.getByRole("dialog").textContent ?? "";
    for (const line of [
      "g then o Overview · f FLIGHT · b Board · a Agent · c Comms · t Telemetry · s Setup",
      "f show or hide FLIGHT · j k next or previous agent · / message the selected agent · i interrupt it · Esc close",
      "Amber breathes slowly where something waits on you; green breathes where an agent is working. Acknowledge an item to stop its pulse; it clears when you act. Colour always comes with a word, so nothing depends on colour alone. @CAPCOM marks a message addressed to you.",
      "Answer, Open and Read the brief all open one panel for that item: what is asked, why, what FLIGHT checked, your choices, and a chat about it. Every item FLIGHT brings starts with a catch-up: new or follow-up, the story so far, and what to be aware of. Show build status (bottom left) marks every panel with how buildable it is today.",
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toContain("mockup");
    expect(text).not.toContain("invented");
  });
});
