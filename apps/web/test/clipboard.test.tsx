import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../src/clipboard.ts";
import { clearToast, Toast } from "../src/shell/Toast.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => clearToast());
});

describe("copyText", () => {
  it("writes the text and toasts the ok line", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Toast />);
    await act(async () => copyText("hello", "Copied.", "Blocked."));
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(screen.getByRole("status").textContent).toBe("Copied.");
  });

  it("toasts the blocked line when the write is refused", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: async () => Promise.reject(new Error("no")) },
    });
    render(<Toast />);
    await act(async () => copyText("hello", "Copied.", "Blocked."));
    expect(screen.getByRole("status").textContent).toBe("Blocked.");
  });

  it("toasts the blocked line when there is no clipboard", async () => {
    vi.stubGlobal("navigator", {});
    render(<Toast />);
    await act(async () => copyText("hello", "Copied.", "Blocked."));
    expect(screen.getByRole("status").textContent).toBe("Blocked.");
  });
});
