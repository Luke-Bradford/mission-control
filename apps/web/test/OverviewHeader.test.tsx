import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamStatus } from "../src/data.ts";
import { OverviewHeader } from "../src/overview/OverviewHeader.tsx";
import { SESSION_ALL, setSession } from "../src/shell/session.ts";
import { settled, stubFetch } from "./fetchStub.ts";
import { NOW, OVERVIEW } from "./fixtures.ts";

const status = (connected: boolean, reconnecting: boolean) =>
  act(() => streamStatus.set({ connected, reconnecting, lastMessageAt: null }));

async function show(overview: unknown) {
  const fetch = stubFetch({
    "/api/overview": overview,
    "/api/attention": [],
  });
  const view = render(<OverviewHeader />);
  await settled(fetch, "/api/overview");
  return view;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  setSession(SESSION_ALL);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("OverviewHeader status", () => {
  it("shows no banner over fresh data while the stream is still opening", async () => {
    status(false, false);
    const { container } = await show({ ...OVERVIEW, at: NOW });
    expect(container.querySelector(".overview-status")).toBeNull();
    expect(screen.queryByText("Connecting")).toBeNull();
  });

  it("still says Disconnected once the open timed out or the stream dropped", async () => {
    status(false, true);
    await show({ ...OVERVIEW, at: NOW });
    expect(screen.getByRole("status").textContent).toBe("Disconnected");
  });

  it("still says Stale snapshot for old data while the stream opens", async () => {
    status(true, false);
    await show({ ...OVERVIEW, at: NOW - 5 * 60_000 });
    expect(screen.getByRole("status").textContent).toBe("Stale snapshot");
  });

  it("still says Refresh failed when the overview cannot load", async () => {
    status(true, false);
    await show(() => ({ status: 500, body: { error: "boom" } }));
    expect(screen.getByRole("status").textContent).toBe("Refresh failed");
  });
});
