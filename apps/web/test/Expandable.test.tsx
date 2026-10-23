import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Expandable } from "../src/components/Expandable.tsx";

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
