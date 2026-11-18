import type { Telemetry as TelemetryData } from "@mc/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Telemetry } from "../src/pages/Telemetry.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, METRICS_VIEW, NOW } from "./fixtures.ts";

const DAY = 86_400_000;
const START = NOW - 13 * DAY;

/** Fourteen days; the first two have no PRs, then CI 100, 50, no PRs, 100, 100. */
const CI = [null, null, 100, 50, null, 100, 100, 100, 50, 100, 100, 50, 100, 100];
const FIRST = [null, null, null, 0, 100, null, 100, 100, 0, 100, 100, 0, 100, 100];
const ROUNDS = [null, null, null, 2, 1.5, null, 1, 1, 2, 1, 1, 2, 1, 1];

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
      quality: [],
    },
    quality14: CI.map((ci, i) => ({
      day: new Date(START + i * DAY).toISOString().slice(0, 10),
      ciPrs: ci === null ? 0 : i === 3 ? 100 : 10,
      ciGreenPrs: ci === null ? 0 : i === 3 ? 50 : ci === 50 ? 5 : 10,
      reviewedPrs: FIRST[i] === null ? 0 : 10,
      firstPassPrs: FIRST[i] === null ? 0 : (FIRST[i] as number) / 10,
      roundsSum: ROUNDS[i] === null ? 0 : (ROUNDS[i] as number) * 10,
    })),
  } as unknown as TelemetryData;
}

function open(
  search = "",
  over: Record<string, unknown> = {},
  quality?: Record<string, unknown> | null,
) {
  window.history.replaceState(null, "", `/telemetry?tab=quality${search}`);
  const data = tel();
  if (quality !== undefined) (data as unknown as { quality: unknown }).quality = quality;
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
  Object.assign(routes, over);
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
    // days 3 to 14: twelve slots, with one gap day inside the plot
    expect(document.querySelectorAll("#qCi g[data-day]")).toHaveLength(12);
    expect(document.querySelectorAll("#qCi .bar")).toHaveLength(11);
    expect(document.getElementById("qCi")?.textContent).toMatch(/Not collected before \d+ \w+\./);
    expect(document.querySelector("#qCi path.rolling")).not.toBeNull();
  });

  it("breaks the rolling line at a day with no data instead of drawing through it", async () => {
    open();
    await waitLoaded();
    const d = document.querySelector("#qCi path.rolling")?.getAttribute("d") ?? "";
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it("shows a day's value and the rolling rate on hover and on focus, and no data on a gap", async () => {
    open();
    await waitLoaded();
    const slots = [...document.querySelectorAll("#qCi g[data-day]")];
    fireEvent.pointerEnter(slots[1]?.querySelector(".hit") as Element);
    const tip = document.querySelector("#qCi .tip") as HTMLElement;
    expect(within(tip).getByText("Green on first push").textContent).toContain("");
    expect(tip.textContent).toContain("50%");
    // pooled: 10/10 and 50/100 = 60/110
    expect(tip.textContent).toContain("55%");
    expect(tip.textContent).toContain("50 of 100 PRs");
    fireEvent.pointerEnter(slots[2]?.querySelector(".hit") as Element);
    expect(document.querySelector("#qCi .tip")?.textContent).toContain("No data");
    fireEvent.pointerLeave(slots[2]?.querySelector(".hit") as Element);
    fireEvent.focus(document.querySelector("#qCi svg") as Element);
    expect(document.querySelector("#qCi .tip")?.textContent).toContain("100%");
    expect(document.querySelector("#qCi .tip")?.textContent).toContain("10 of 10 PRs");
  });

  it("states that daily quality is not collected when quality14 is absent", async () => {
    const data = tel();
    delete (data as { quality14?: unknown }).quality14;
    open("", { "/api/telemetry?range=7d": data });
    await waitFor(() =>
      expect(document.getElementById("qCi")?.textContent).toContain("not collected"),
    );
    expect(document.querySelector("#qCi .bar")).toBeNull();
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
    expect(document.querySelector("#qGuard .agent-list-scroll-cue")?.hasAttribute("hidden")).toBe(
      true,
    );
  });

  it("lists escaped defects in the Table view", async () => {
    open("&view=table");
    await waitFor(() => expect(screen.getByRole("link", { name: "shop-app#41" })).toBeTruthy());
    expect(screen.getByRole("link", { name: "shop-app#41" }).getAttribute("href")).toBe(
      "/tickets/shop-app/41",
    );
  });

  it("gives each missing summary figure its reason, on focus and in its name", async () => {
    open(
      "",
      {},
      {
        ciGreenFirstPushPct: null,
        prs: 0,
        firstPassReviewPct: null,
        reviewedPrs: 0,
        reviewRoundsPerPr: null,
        retroFindingsPerPr: null,
        humanReviewWaitMs: null,
        sentBackPrs: null,
      },
    );
    await waitLoaded();
    const tiles = [...document.querySelectorAll(".summary .stat")];
    expect(tiles).toHaveLength(6);
    for (const tile of tiles) {
      const value = tile.querySelector(".stat-value") as HTMLElement;
      expect(value.textContent).toBe("—");
      expect(value.getAttribute("aria-label")).toMatch(/No .* in the last 14 days\./);
      expect(tile.querySelector(".stat-def")?.textContent).toMatch(/No .* in the last 14 days\./);
    }
  });

  it("says not collected when the server sends no quality figures", async () => {
    open("", {}, null);
    await waitLoaded();
    for (const tile of document.querySelectorAll(".summary .stat"))
      expect(tile.querySelector(".stat-value")?.getAttribute("aria-label")).toContain(
        "Not collected",
      );
  });

  it("says a failed guard read did not load, offers a retry, and keeps the rest", async () => {
    open("", { "/api/guard/hits?days=14": () => ({ status: 500, body: { error: "down" } }) });
    await waitLoaded();
    const panel = document.getElementById("qGuard") as HTMLElement;
    await waitFor(() =>
      expect(within(panel).getByRole("alert").textContent).toContain("did not load"),
    );
    expect(within(panel).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(panel.textContent).not.toContain("Loading…");
    expect(document.getElementById("qCi")).not.toBeNull();
  });

  it("says a failed escaped-defects read did not load, with a retry", async () => {
    open("&view=table", {
      "/api/qa/flow?days=14": () => ({ status: 500, body: { error: "down" } }),
    });
    const panel = await waitFor(() => {
      const p = document.getElementById("qEscaped") as HTMLElement;
      expect(within(p).getByRole("alert").textContent).toContain("did not load");
      return p;
    });
    expect(within(panel).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(panel.textContent).not.toContain("Loading…");
  });
});
