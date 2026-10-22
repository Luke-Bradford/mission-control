import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BriefModal } from "../src/board/BriefModal.tsx";
import { installKeys } from "../src/shell/keys.ts";

let off: () => void;
beforeEach(() => {
  off = installKeys({
    navigate: vi.fn(),
    toggleDock: vi.fn(),
    help: vi.fn(),
    selectNext: vi.fn(),
    selectPrev: vi.fn(),
    toast: vi.fn(),
  });
});
afterEach(() => off());

function open() {
  const onClose = vi.fn();
  render(
    <>
      <button type="button">outside</button>
      <BriefModal open onClose={onClose} text={(m) => m} />
    </>,
  );
  return onClose;
}

const button = (name: string) => screen.getByRole("button", { name });
const panel = () => screen.getByRole("dialog", { name: "Brief" });
/** The brief's text region: focusable, so it is the last stop in the trap. */
const text = () => within(panel()).getByRole("region", { name: "Brief text" });
/** The dark backdrop: a click there focuses it, so it carries the trap. */
const root = () => panel().closest(".modal") as HTMLElement;

describe("BriefModal focus trap", () => {
  it("moves focus into the dialog on open", () => {
    open();
    expect(document.activeElement).toBe(button("Close"));
  });

  it("makes the text region and the backdrop focusable, so a click keeps focus inside", () => {
    open();
    expect(text().tabIndex).toBe(0);
    expect(root().getAttribute("tabindex")).toBe("-1");
  });

  it("Tab on the last stop (the text) wraps to the first control", () => {
    open();
    text().focus();
    const untouched = fireEvent.keyDown(text(), { key: "Tab" });
    expect(untouched).toBe(false); // the browser's own move was prevented
    expect(document.activeElement).toBe(button("Standup"));
  });

  it("Shift+Tab on the first control wraps to the text", () => {
    open();
    const first = button("Standup");
    first.focus();
    const untouched = fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(untouched).toBe(false);
    expect(document.activeElement).toBe(text());
  });

  it("with the backdrop focused (after a click on it), Tab goes to the first control", () => {
    open();
    root().focus();
    expect(document.activeElement).toBe(root());
    expect(fireEvent.keyDown(root(), { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(button("Standup"));
  });

  it("with the backdrop focused, Shift+Tab goes to the last stop", () => {
    open();
    root().focus();
    expect(fireEvent.keyDown(root(), { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(text());
  });

  it("leaves Tab alone between the first and last controls", () => {
    open();
    const copy = button("Copy");
    copy.focus();
    expect(fireEvent.keyDown(copy, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(copy);
  });

  it("Escape still closes it", () => {
    const onClose = open();
    fireEvent.keyDown(button("Close"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
