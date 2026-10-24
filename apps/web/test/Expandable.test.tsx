import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Expandable } from "../src/components/Expandable.tsx";
import { trapTab } from "../src/shell/overlays.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("has no control for fitting text", () => {
  render(<Expandable lines={2}>Short</Expandable>);
  expect(screen.queryByRole("button")).toBeNull();
});
it("measures overflow and toggles the full text in its own bounded row", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
  const { container } = render(<Expandable lines={2}>{"Long text ".repeat(100)}</Expandable>);
  const button = screen.getByRole("button", { name: "Show more" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(container.querySelector(".expandable.open")).toBeTruthy();
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("false");
});

it("removes the control and collapses when refreshed text fits while open", () => {
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
  const { container, rerender } = render(<Expandable lines={2}>Long text</Expandable>);
  const content = container.querySelector(".expandable-content") as HTMLElement;
  content.style.lineHeight = "20px";
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  height.mockReturnValue(40);
  rerender(<Expandable lines={2}>Short</Expandable>);
  expect(screen.queryByRole("button")).toBeNull();
  expect(container.querySelector(".expandable.open")).toBeNull();
  expect(content.style.webkitLineClamp).toBe("2");
});

it("measures open text against the line limit after resizing wider", () => {
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
  const { container } = render(<Expandable lines={2}>Long text</Expandable>);
  const content = container.querySelector(".expandable-content") as HTMLElement;
  content.style.lineHeight = "20px";
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  // An open box's client height no longer represents the clamped height.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  fireEvent(window, new Event("resize"));
  expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  height.mockReturnValue(40);
  fireEvent(window, new Event("resize"));
  expect(screen.queryByRole("button")).toBeNull();
  expect(container.querySelector(".expandable.open")).toBeNull();
  expect(content.style.webkitLineClamp).toBe("2");
});

it("keeps observers for the mount and measures refreshed children with the latest threshold", () => {
  const observe = vi.fn();
  const disconnect = vi.fn();
  let resize = () => {};
  const observer = vi.fn((callback: () => void) => {
    resize = callback;
    return { observe, disconnect };
  });
  vi.stubGlobal("ResizeObserver", observer);
  const mutations = vi.spyOn(MutationObserver.prototype, "observe");
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
  const { container, rerender, unmount } = render(
    <Expandable lines={2} foldAfter={4}>
      <span>Long</span>
    </Expandable>,
  );
  const content = container.querySelector(".expandable-content") as HTMLElement;
  content.style.lineHeight = "20px";
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  rerender(
    <Expandable lines={2} foldAfter={6}>
      <span>Refreshed</span>
    </Expandable>,
  );
  expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  height.mockReturnValue(100);
  act(() => resize());
  expect(screen.queryByRole("button")).toBeNull();
  expect(observer).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(1);
  expect(mutations).toHaveBeenCalledTimes(1);
  unmount();
  expect(disconnect).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});

it("keeps folded text accessible and clickable but removes controls from Tab until expanded", () => {
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
  const click = vi.fn();
  const content = (refreshed = false) => (
    <aside onKeyDown={trapTab}>
      <Expandable lines={2} of="Evidence">
        <p>Visible first lines</p>
        <a href="https://github.com/a/b" onClick={(event) => event.preventDefault()}>
          Source
        </a>
        <button type="button" tabIndex={0} onClick={click}>
          Action
        </button>
        <input aria-label="Details" />
        <span tabIndex={-1}>Already skipped</span>
        {refreshed && <a href="https://github.com/a/c">New source</a>}
      </Expandable>
    </aside>
  );
  const { rerender } = render(content());
  const paragraph = screen.getByRole("paragraph");
  expect(paragraph.textContent).toBe("Visible first lines");
  expect(paragraph.closest("[inert], [aria-hidden=true], [hidden]")).toBeNull();
  const source = screen.getByRole("link", { name: "Source" });
  const action = screen.getByRole("button", { name: "Action" });
  const input = screen.getByRole("textbox", { name: "Details" });
  for (const control of [source, action, input, screen.getByText("Already skipped")])
    expect(control.getAttribute("tabindex")).toBe("-1");
  fireEvent.click(action);
  expect(click).toHaveBeenCalledTimes(1);
  const toggle = screen.getByRole("button", { name: "Show more, Evidence" });
  toggle.focus();
  fireEvent.keyDown(toggle, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(toggle);
  rerender(content(true));
  const refreshed = screen.getByRole("link", { name: "New source" });
  expect(refreshed.getAttribute("tabindex")).toBe("-1");
  fireEvent.click(toggle);
  expect(source.getAttribute("tabindex")).toBeNull();
  expect(action.getAttribute("tabindex")).toBe("0");
  expect(input.getAttribute("tabindex")).toBeNull();
  expect(refreshed.getAttribute("tabindex")).toBeNull();
  expect(screen.getByText("Already skipped").getAttribute("tabindex")).toBe("-1");
  fireEvent.click(toggle);
  expect(action.getAttribute("tabindex")).toBe("-1");
  height.mockReturnValue(20);
  rerender(content(true));
  expect(screen.queryByRole("button", { name: "Show more, Evidence" })).toBeNull();
  expect(action.getAttribute("tabindex")).toBe("0");
  expect(refreshed.getAttribute("tabindex")).toBeNull();
});
