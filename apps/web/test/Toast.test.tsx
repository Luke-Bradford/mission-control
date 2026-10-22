import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { clearToast, Toast, toast } from "../src/shell/Toast.tsx";

afterEach(() => {
  act(() => clearToast());
});

describe("Toast", () => {
  it("keeps its status region in the accessibility tree while empty, so the first message is heard", () => {
    render(<Toast />);
    const region = screen.getByRole("status");
    expect(region.hasAttribute("hidden")).toBe(false);
    expect(region.textContent).toBe("");
    act(() => toast("Saved."));
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("Saved.");
  });
});
