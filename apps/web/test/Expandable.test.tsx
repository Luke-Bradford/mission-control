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
