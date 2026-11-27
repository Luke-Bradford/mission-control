import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { MachineReadout } from "../src/telemetry/MachineReadout.tsx";
import { stubFetch } from "./fetchStub.ts";

const GIB = 2 ** 30;

afterEach(() => {
  cleanup();
  hub.clear();
  vi.unstubAllGlobals();
});

describe("Machine cleanup footprint", () => {
  it("shows every store measured by the hourly leftovers pass", async () => {
    stubFetch({
      "/api/machine": {
        latest: null,
        warning: null,
        leftovers: {
          claudeProjectsBytes: 1 * GIB,
          codexSessionsBytes: 2 * GIB,
          browserProfilesBytes: 3 * GIB,
          chromeTempBytes: 4 * GIB,
          worktreesBytes: 5 * GIB,
          previewsBytes: 6 * GIB,
        },
      },
    });
    render(<MachineReadout />);

    const footprint = await screen.findByTestId("cleanup-footprint");
    expect(footprint.textContent).toContain("Claude projects 1 GB");
    expect(footprint.textContent).toContain("Codex sessions 2 GB");
    expect(footprint.textContent).toContain("Browser profiles 3 GB");
    expect(footprint.textContent).toContain("Chrome temp 4 GB");
    expect(footprint.textContent).toContain("Seat worktrees 5 GB");
    expect(footprint.textContent).toContain("Preview clones 6 GB");
  });
});
