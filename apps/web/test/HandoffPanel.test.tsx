import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HandoffPanel } from "../src/agent/HandoffPanel.tsx";
import { hub } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { handoffFixture } from "./handoffFixture.ts";

afterEach(() => {
  cleanup();
  hub.clear();
  vi.unstubAllGlobals();
});
it("shows the source and expands a keyboard-scrollable saved note", async () => {
  stubFetch({ "/api/runs/old/handoff": handoffFixture });
  render(<HandoffPanel runId="old" />);
  const summary = await screen.findByText("Handed off from GUIDO-CX");
  expect(summary.closest("details")?.open).toBe(false);
  fireEvent.click(summary);
  expect(summary.closest("details")?.open).toBe(true);
  expect(screen.getByRole("region", { name: "Saved ticket handoff" }).tabIndex).toBe(0);
  for (const text of [
    handoffFixture.goal,
    handoffFixture.next,
    handoffFixture.done[0],
    handoffFixture.left[0],
    handoffFixture.findings[0],
    "flight: Keep the existing branch",
  ])
    expect(screen.getByRole("region", { name: "Saved ticket handoff" }).textContent).toContain(
      text,
    );
  expect(screen.getByText(/taken by GUIDO-1/)).toBeTruthy();
});
it("keeps missing old-hub notes quiet and reports a real read failure", async () => {
  stubFetch({ "/api/runs/old/handoff": () => ({ status: 502, body: { error: "offline" } }) });
  render(<HandoffPanel runId="old" />);
  expect((await screen.findByRole("alert")).textContent).toContain("offline");
});
