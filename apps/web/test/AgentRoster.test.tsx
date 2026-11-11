import { crewRowSummary, type OverviewTimeline, type RunDigest } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Roster } from "../src/agent/Roster.tsx";
import { hub } from "../src/data.ts";
import { Agent } from "../src/pages/Agent.tsx";
import { getSelectedAgent, setSelectedAgent } from "../src/shell/selection.ts";
import { agentView } from "./agentV2Fixture.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, HOUR, MIN, NOW, seatRow } from "./fixtures.ts";

const digest = (over: Partial<RunDigest> = {}): RunDigest => ({
  toolCalls: 37,
  turns: 21,
  lastEventAt: NOW - MIN,
  model: "claude-opus-4-1",
  contextTokens: 100_000,
  contextWindow: 200_000,
  liveTool: null,
  tools: {},
  subagents: [],
  minuteTokens: [],
  turnUsage: [],
  background: [],
  compactions: 0,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"], now: NOW });
  setSelectedAgent(null);
  window.history.replaceState(null, "", "/agent");
});
afterEach(() => {
  cleanup();
  hub.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const idle = seatRow({ id: "guido-1", hudState: "idle", run: null, digest: digest() });
const busy = seatRow({
  id: "guido-2",
  index: 1,
  hudState: "running",
  digest: digest(),
  contextWindow: 200_000,
  ticket: "mission-control#1771",
  ticketTitle: "Agents page, slice 1a: the roster of every seat and choosing a seat",
});

describe("Roster cards", () => {
  it("shows a dash, not 0%, for an idle seat's context, and the percent for a busy one", () => {
    render(<Roster rows={[idle, busy]} current={null} />);
    const free = screen.getByRole("button", { name: /GUIDO-1/ });
    expect(within(free).getByRole("img", { name: "Context not in use" })).toBeTruthy();
    expect(free.textContent).toContain("—");
    expect(free.textContent).not.toContain("0%");
    const work = screen.getByRole("button", { name: /GUIDO-2/ });
    expect(within(work).getByRole("img", { name: "Context 50 percent used" })).toBeTruthy();
    expect(work.textContent).toContain("50%");
    expect(work.textContent).toContain("#1771");
  });

  it("marks the chosen seat and chooses by click, putting the seat in the address", () => {
    render(<Roster rows={[idle, busy]} current="guido-1" />);
    expect(screen.getByRole("button", { name: /GUIDO-1/ }).getAttribute("aria-current")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /GUIDO-2/ }));
    expect(window.location.pathname).toBe("/agent/guido-2");
    expect(getSelectedAgent()).toBe("guido-2");
  });

  it("folds a repo's seats and opens the group again", () => {
    render(<Roster rows={[idle, busy]} current={null} />);
    const fold = screen.getByRole("button", { name: /shop-app/ });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /GUIDO-1/ })).toBeNull();
    fireEvent.click(fold);
    expect(screen.getByRole("button", { name: /GUIDO-1/ })).toBeTruthy();
  });
});

describe("the last-hour strip", () => {
  const lanes = (agentId: string): OverviewTimeline => ({
    from: NOW - HOUR,
    to: NOW,
    lanes: [
      {
        agentId,
        spans: [{ kind: "checks", from: NOW - 20 * MIN, to: NOW - 10 * MIN }],
        ticks: [NOW - 30 * MIN, NOW - 5 * MIN],
      },
    ],
  });

  it("shows a running seat's lane as marks and says so in words when there is none", async () => {
    stubFetch({
      "/api/overview/timeline": lanes("guido-2"),
      "/api/crew?shape=summary": { rows: [idle, busy].map(crewRowSummary), firstRunToday: null },
    });
    render(<Roster rows={[idle, busy]} current={null} />);
    const work = screen.getByRole("button", { name: /GUIDO-2/ });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const strip = within(work).getByRole("img", { name: /marks of activity/ });
    expect(strip.querySelectorAll("i").length).toBe(3);
    expect(strip.querySelector(".strip-check")).toBeTruthy();
    const free = screen.getByRole("button", { name: /GUIDO-1/ });
    const none = within(free).getByRole("img", { name: "No activity in the last hour" });
    expect(none.getAttribute("title")).toBe("No activity in the last hour");
    expect(none.querySelectorAll("i").length).toBe(0);
  });
});

describe("the Agents page when idle", () => {
  it("makes no timed list requests", async () => {
    const rows = [idle, busy];
    const routes: Record<string, unknown> = {
      "/api/crew?shape=summary": { rows: rows.map(crewRowSummary), firstRunToday: null },
      "/api/overview/timeline": { from: NOW - HOUR, to: NOW, lanes: [] },
      "/api/attention": [],
      "/api/config": CONFIG,
    };
    for (const r of rows) {
      routes[`/api/agents/${r.id}`] = agentView(r);
      routes[`/api/agents/${r.id}/stream?limit=20`] = {
        runId: null,
        events: [],
        tasks: [],
        truncated: false,
        more: false,
      };
    }
    const fetch = stubFetch(routes);
    render(<Agent id="guido-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const before = fetch.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOUR);
    });
    const lists = fetch.mock.calls
      .slice(before)
      .map(([path]) => String(path))
      .filter((p) => /^\/api\/(crew|attention|config|overview\/timeline)/.test(p));
    expect(lists).toEqual([]);
  });
});
