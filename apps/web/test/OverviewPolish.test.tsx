import type { ActivityRow, AttentionItem, BoardItem, CrewRow } from "@mc/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { Overview } from "../src/pages/Overview.tsx";
import { stubFetch } from "./fetchStub.ts";
import {
  CONFIG,
  HOUR,
  item,
  METRICS_VIEW,
  MIN,
  NOW,
  OVERVIEW,
  seatRow,
  stoppedSeat,
} from "./fixtures.ts";

const flightConfig = {
  ...CONFIG,
  crew: {
    sessions: [{ id: "s1", repoId: "shop-app", seats: [{ id: "flight-1", loop: "watch" }] }],
  },
};

function stub(d: {
  rows?: CrewRow[];
  activity?: ActivityRow[];
  board?: BoardItem[];
  extra?: Record<string, unknown>;
  items?: AttentionItem[];
}) {
  return stubFetch({
    ...d.extra,
    "/api/overview": OVERVIEW,
    "/api/metrics": METRICS_VIEW,
    "/api/overview/timeline": { from: NOW - HOUR, to: NOW, lanes: [] },
    "/api/crew?shape=summary": { rows: d.rows ?? [], firstRunToday: null },
    "/api/attention": d.items ?? [],
    "/api/machine": { latest: null, warning: null },
    "/api/limits": [],
    "/api/limits/github": { queries: {}, pollCost: null },
    "/api/health": [],
    "/api/activity": d.activity ?? [],
    "/api/settings/away": { on: false, until: "", may: {} },
    "/api/settings/crew-pause": null,
    "/api/config": flightConfig,
    "/api/test-lock": { holder: null, waiting: [] },
    "/api/crew/status": { enabled: true, note: null },
    "/api/boards/mission-control": d.board ?? [],
    "/api/repos/shop-app/prs?linked=1&shape=summary": [],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  hub.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const crewRows = (c: HTMLElement) => [
  ...c.querySelectorAll<HTMLElement>("#agentsList .trow:not(.head):not(.flight)"),
];

describe("Overview polish", () => {
  it("says how many agents are working once, without a second count of seats", async () => {
    stub({ rows: [seatRow({ id: "flight-1" }), seatRow({ id: "inco-1" })] });
    const { container } = render(<Overview />);
    await waitFor(() => expect(container.querySelector(".crew-working")).not.toBeNull());
    await screen.findByText("INCO-1");
    const sub = container.querySelector("#agentsP .ph .sub")?.textContent ?? "";
    expect(sub).toContain("agents working");
    expect(sub).not.toMatch(/\d+ seats?/);
  });

  it("spells every seat as its call sign, FLIGHT's row and the Live log included", async () => {
    const at = NOW - MIN;
    const event = (who: string): ActivityRow => ({
      at,
      who,
      kind: "run-start",
      text: "started",
      ref: null,
      url: null,
      status: null,
      prs: [],
      summary: null,
      runId: undefined,
    });
    stub({
      rows: [seatRow({ id: "flight-1" }), seatRow({ id: "inco-1", index: 1 })],
      activity: [event("flight-1"), event("inco-1")],
    });
    const { container } = render(<Overview />);
    await screen.findAllByText("INCO-1");
    const spelled = [
      ...container.querySelectorAll(".ag, .log-who, .free-seats .muted, .rowlink"),
    ].map((el) => el.textContent ?? "");
    expect(spelled.join(" ")).toContain("FLIGHT-1");
    expect(spelled.join(" ")).toContain("INCO-1");
    expect(container.textContent).not.toMatch(/\b(?:flight-1|inco-1)\b/);
    expect(
      within(container.querySelector(".trow.flight") as HTMLElement).getByText("FLIGHT-1"),
    ).toBeTruthy();
  });

  it("shows a stopped seat whose ticket and PR are closed as stopped, with no current work", async () => {
    stub({
      rows: [stoppedSeat({ merged: true })],
      board: [{ repoId: "mission-control", issueNumber: 74, state: "done" } as BoardItem],
    });
    const { container } = render(<Overview />);
    await screen.findAllByText("Stopped");
    await waitFor(() => expect(crewRows(container)[0]?.textContent).toContain("No current work"));
    const row = crewRows(container)[0] as HTMLElement;
    expect(row.textContent).not.toContain("#74");
    expect(row.textContent).not.toContain("PR #75");
  });

  it("keeps a stopped seat's last work while its ticket is still open", async () => {
    stub({
      rows: [stoppedSeat({ merged: true })],
      board: [{ repoId: "mission-control", issueNumber: 74, state: "in progress" } as BoardItem],
    });
    const { container } = render(<Overview />);
    await screen.findAllByText("Stopped");
    expect(crewRows(container)[0]?.textContent).toContain("#74");
    expect(crewRows(container)[0]?.textContent).not.toContain("No current work");
  });

  it("leaves the stop button plain, so the amber highlight is never on End", async () => {
    stub({
      rows: [seatRow({ hudState: "running" })],
      items: [item({ key: "k-seat", agentId: "guido-1", kind: "decision" })],
    });
    const { container } = render(<Overview />);
    const end = await screen.findByRole("button", { name: "End the run" });
    expect(end.className).not.toContain("warn");
    expect(container.querySelector("#agentsList button.warn")).toBeNull();
  });

  it("gives the token figures a unit", async () => {
    stub({ rows: [seatRow()], extra: {} });
    const { container } = render(<Overview />);
    await screen.findByText("GUIDO-1");
    await waitFor(() => expect(container.querySelector("#tokensP .plot-reading")).not.toBeNull());
    const readings = [
      ...container.querySelectorAll("#tokensP .plot-reading span, #tokensP .plot-axis span"),
    ]
      .map((el) => el.textContent ?? "")
      .filter((text) => /^(?:last hour|peak|now) /.test(text));
    expect(readings.length).toBeGreaterThan(0);
    for (const reading of readings) expect(reading).toContain("tokens");
  });

  it("links a ticket once for a run of rows from one agent", async () => {
    const row = (at: number, text: string): ActivityRow => ({
      at,
      who: "flight-1",
      kind: "run-end",
      text,
      ref: "shop-app#1845",
      url: null,
      status: "ok",
      prs: [],
      summary: null,
      runId: undefined,
    });
    stub({
      rows: [seatRow({ id: "flight-1" })],
      activity: [row(NOW - MIN, "idle"), row(NOW - 2 * MIN, "running"), row(NOW - 3 * MIN, "idle")],
    });
    const { container } = render(<Overview />);
    const log = container.querySelector("#actP") as HTMLElement;
    await within(log).findAllByRole("link", { name: /1845/ });
    expect(within(log).getAllByRole("link", { name: "shop-app #1845" })).toHaveLength(1);
  });
});
