import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as crewModule from "../src/crew.ts";
import { AgentsPanel } from "../src/overview/AgentsPanel.tsx";
import { settled, stubFetch } from "./fetchStub.ts";
import { CONFIG, NOW, seatRow } from "./fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("updates the accessible State lock-wait duration without rebuilding the roster", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  const row = seatRow({
    id: "lock-review",
    hudState: "running",
    loop: { phase: "working", text: "Working", prNumber: null, parked: null, wait: "lock" },
  });
  const fetch = stubFetch({
    "/api/crew?shape=summary": { rows: [row], firstRunToday: null },
    "/api/config": { ...CONFIG, crew: { sessions: [{ id: "s1", seats: [] }] } },
    "/api/attention": [],
    "/api/test-lock": { holder: null, waiting: [{ runId: row.run!.id, since: NOW - 5_000 }] },
    "/api/crew/status": { enabled: true, note: null },
    "/api/flight": { seat: null, decisions: [] },
    "/api/flight/brief": { session: null, sections: [], watch: [] },
    "/api/settings/crew-pause": null,
    "/api/limits": [],
    "/api/repos/shop-app/prs?linked=1&shape=summary": [],
  });
  const order = vi.spyOn(crewModule, "crewOrder");
  render(<AgentsPanel />);
  await screen.findByText("lock-review");
  await settled(fetch, "/api/crew?shape=summary");
  const element = screen.getByText("lock-review").closest(".trow")!;
  const state = element.querySelector(".state-cell")!;
  expect(state.getAttribute("title")).toContain("0:05");
  order.mockClear();
  fetch.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(Date.now()).toBe(NOW + 20_000);
  expect(state.getAttribute("title")).toContain("0:25");
  expect(state.getAttribute("aria-label")).toContain("0:25");
  expect(element.querySelector(".state-cell")).toBe(state);
  expect(order).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("updates set-aside lock-wait details while the current seat is idle without rebuilding or fetching", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  const row = seatRow({
    id: "aside-clock",
    hudState: "idle",
    run: null,
    asideRuns: [
      {
        runId: "aside-wait",
        ticket: "shop-app#100",
        ticketTitle: "Recorded set-aside task",
        loop: {
          phase: "working",
          text: "Waiting for checks",
          prNumber: null,
          parked: null,
          wait: "lock",
        },
      },
    ],
  });
  const fetch = stubFetch({
    "/api/crew?shape=summary": { rows: [row], firstRunToday: null },
    "/api/config": { ...CONFIG, crew: { sessions: [{ id: "s1", seats: [] }] } },
    "/api/attention": [],
    "/api/test-lock": {
      holder: null,
      waiting: [
        { runId: "aside-wait", seatId: row.id, command: "fixture check", since: NOW - 5000 },
      ],
    },
    "/api/crew/status": { enabled: true, note: null },
    "/api/flight": { seat: null, decisions: [] },
    "/api/flight/brief": { session: null, sections: [], watch: [] },
    "/api/settings/crew-pause": null,
    "/api/limits": [],
    "/api/repos/shop-app/prs?linked=1&shape=summary": [],
  });
  const order = vi.spyOn(crewModule, "crewOrder");
  render(<AgentsPanel />);
  await screen.findByText("aside-clock");
  await settled(fetch, "/api/crew?shape=summary");
  const element = screen.getByText("aside-clock").closest(".trow")!;
  const identity = element.querySelector(".agent-identity")!;
  const link = identity.querySelector(".rowlink");
  expect(identity.getAttribute("title")).toContain("0:05");
  order.mockClear();
  fetch.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(identity.getAttribute("title")).toContain("0:25");
  expect(element.querySelector(".agent-identity")).toBe(identity);
  expect(identity.querySelector(".rowlink")).toBe(link);
  expect(order).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
