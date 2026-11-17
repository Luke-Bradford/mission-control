import type { Telemetry as TelemetryData } from "@mc/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Telemetry } from "../src/pages/Telemetry.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, METRICS_VIEW, NOW } from "./fixtures.ts";

const DAY = 86_400_000;
const START = NOW - 6 * DAY;

/** Seven days; the first two have no PRs, then CI 100, 50, no PRs, 100, 100. */
const CI = [null, null, 100, 50, null, 100, 100];
const FIRST = [null, null, null, 0, 100, null, 100];
const ROUNDS = [null, null, null, 2, 1.5, null, 1];

function tel(): TelemetryData {
  return {
    today: {
      tokens: 0,
      cacheRead: 0,
      costUsd: null,
      toolCalls: 0,
      turns: 0,
      working: 0,
      agents: 0,
    },
    throughput: [],
    cycleTime: { rows: [], excluded: 0 },
    quality: {
      ciGreenFirstPushPct: 88,
      prs: 16,
      firstPassReviewPct: 70,
      reviewedPrs: 10,
      reviewRoundsPerPr: 1.7,
      retroFindingsPerPr: 4.2,
      humanReviewWaitMs: 52 * 60_000,
      sentBackPrs: 6,
    },
    tokensPerMinute: [],
    liveMinutes: [],
    utilisation: [],
    turnUsage: [],
    toolLatency: [],
    subagents: [],
    quota: [],
    machine: [],
    tokensByTicket: [],
    totals: [],
    series: {
      stateSpans: [],
      quota: [],
      tickets: [],
      annotations: [],
      quality: CI.map((ci, i) => ({
        at: START + i * DAY,
        ciGreenFirstPushPct: ci,
        firstPassReviewPct: FIRST[i] ?? null,
        reviewRoundsPerPr: ROUNDS[i] ?? null,
      })),
    },
  } as unknown as TelemetryData;
}

function open(search = "") {
  window.history.replaceState(null, "", `/telemetry?tab=quality${search}`);
  const data = tel();
  const routes: Record<string, unknown> = {
    "/api/config": CONFIG,
    "/api/metrics": METRICS_VIEW,
    "/api/machine": null,
    "/api/attention": [],
    "/api/crew?shape=summary": { rows: [], firstRunToday: null },
    "/api/guard/hits?days=14": {
      hits: [],
      counts: { "git-write": 12, network: 3, background: 0 },
    },
    "/api/qa/flow?days=14": {
      days: 14,
      escapedDefects: [
        {
          repoId: "shop-app",
          issueNumber: 41,
          prNumber: 30,
          via: "file",
          filedAt: NOW - DAY,
          mergedAt: NOW - 3 * DAY,
          seat: "dev-1",
          model: null,
        },
      ],
    },
  };
  for (const r of ["1h", "6h", "24h", "7d"]) routes[`/api/telemetry?range=${r}`] = data;
  stubFetch(routes);
  return render(<Telemetry />);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const waitLoaded = () => waitFor(() => expect(document.querySelector("#qCi .bar")).not.toBeNull());

describe("Telemetry, Quality tab", () => {
  it("shows the six summary figures over the fixed 14-day window", async () => {
    open();
    await waitLoaded();
    const tiles = [...document.querySelectorAll(".summary .stat")].map((s) => ({
      label: s.querySelector(".stat-label")?.textContent,
      value: s.querySelector(".stat-value")?.textContent,
      window: s.querySelector(".stat-window")?.textContent,
    }));
    expect(tiles).toEqual([
      { label: "CI first push", value: "88%", window: "14d" },
      { label: "First-pass review", value: "70%", window: "14d" },
      { label: "Review rounds per PR", value: "1.7", window: "14d" },
      { label: "RETRO findings per PR", value: "4.2", window: "14d" },
      { label: "Human review wait", value: "52", window: "14d" },
      { label: "PRs sent back", value: "6", window: "14d" },
    ]);
    expect(screen.queryByRole("group", { name: "Range" })).toBeNull();
  });

  it("starts the plot at the first collected day, names the earlier days, and leaves gaps empty", async () => {
    open();
    await waitLoaded();
    // days 3 to 7 of 7: five slots, bars on four of them
    expect(document.querySelectorAll("#qCi g[data-day]")).toHaveLength(5);
    expect(document.querySelectorAll("#qCi .bar")).toHaveLength(4);
    expect(document.getElementById("qCi")?.textContent).toMatch(/Not collected before \d+ \w+\./);
    expect(document.querySelector("#qCi path.rolling")).not.toBeNull();
  });

  it("shows a day's value and the rolling rate on hover and on focus, and no data on a gap", async () => {
    open();
    await waitLoaded();
    const slots = [...document.querySelectorAll("#qCi g[data-day]")];
    fireEvent.pointerEnter(slots[1]?.querySelector(".hit") as Element);
    const tip = document.querySelector("#qCi .tip") as HTMLElement;
    expect(within(tip).getByText("Green on first push").textContent).toContain("");
    expect(tip.textContent).toContain("50%");
    // the mean of the daily rates so far: 100 and 50
    expect(tip.textContent).toContain("75%");
    fireEvent.pointerEnter(slots[2]?.querySelector(".hit") as Element);
    expect(document.querySelector("#qCi .tip")?.textContent).toContain("No data");
    fireEvent.pointerLeave(slots[2]?.querySelector(".hit") as Element);
    fireEvent.focus(document.querySelector("#qCi svg") as Element);
    expect(document.querySelector("#qCi .tip")?.textContent).toContain("100%");
  });

  it("ranks guard blocks by rule and says test attempts are not collected", async () => {
    open();
    await waitFor(() => expect(document.querySelectorAll("#qGuard .hrow")).toHaveLength(2));
    const rows = [...document.querySelectorAll("#qGuard .hrow")].map((r) => r.textContent);
    expect(rows[0]).toContain("git-write");
    expect(rows[0]).toContain("12");
    expect(rows[1]).toContain("network");
    expect(document.getElementById("qRounds")?.textContent).toContain(
      "Test attempts: not collected yet.",
    );
  });

  it("lists escaped defects in the Table view", async () => {
    open("&view=table");
    await waitFor(() => expect(screen.getByRole("link", { name: "shop-app#41" })).toBeTruthy());
    expect(screen.getByRole("link", { name: "shop-app#41" }).getAttribute("href")).toBe(
      "/tickets/shop-app/41",
    );
  });
});
