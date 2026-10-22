import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockLines } from "../src/components/LockLines.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LockLines", () => {
  it("lists two waiting calls from one run as two rows, without a duplicate-key warning", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const now = Date.now();
    render(
      <LockLines
        lock={{
          holder: { runId: "inco-1:x", seatId: "inco-1", command: "pnpm -s test", since: now },
          waiting: [
            { runId: "guido-1:x", seatId: "guido-1", since: now },
            { runId: "guido-1:x", seatId: "guido-1", since: now },
          ],
        }}
      />,
    );
    expect(screen.getAllByText(/GUIDO-1/)).toHaveLength(2);
    expect(errors.mock.calls.map((c) => c.map(String).join(" ")).join("\n")).not.toMatch(
      /same key/,
    );
  });
});
