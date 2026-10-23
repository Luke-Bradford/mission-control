import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConfigView,
  LIVE_MINUTES,
  TELEMETRY_POINTS,
  type Telemetry as TelemetryData,
  type TestLockState,
} from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCES } from "../src/data.ts";
import { Telemetry } from "../src/pages/Telemetry.tsx";
import { setSelectedAgent } from "../src/shell/selection.ts";
import { NOT_TRACKED, NOT_TRACKED_TITLE } from "../src/telemetry/common.ts";
import { Kpis } from "../src/telemetry/Kpis.tsx";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, CONFIG, HOUR, MIN, NOW, seatRow } from "./fixtures.ts";

const LOOP = CONFIG.loops[0] as ConfigView["loops"][number];
const CFG: ConfigView = {
  ...CONFIG,
  loops: [
    LOOP,
    { ...LOOP, id: "studio", repoId: "site-builder", kind: "studio-loop" },
    { ...LOOP, id: "codex-ta", accountId: "codex-main" },
  ],
};

const flat = (n: number, v: number): number[] => Array<number>(n).fill(v);

function tel(over: Partial<TelemetryData> = {}): TelemetryData {
  return {
    today: {
      tokens: 61_234,
      cacheRead: 1_250_000,
      costUsd: 3.5,
      toolCalls: 812,
      turns: 64,
      working: 2,
      agents: 3,
      merged7d: 5,
    },
    throughput: Array.from({ length: 14 }, (_, i) => ({
      day: `2026-10-${String(4 + i).padStart(2, "0")}`,
      merged: i === 13 ? 4 : i % 2,
    })),
    cycleTime: {
      rows: [
        { size: "XS", medianDays: 0.6, tickets: 4 },
        { size: "S", medianDays: 1.44, tickets: 11 },
        { size: "M", medianDays: 2.9, tickets: 1 },
        { size: "L", medianDays: 0, tickets: 0 }, // 0 tickets reads —, whatever the median says
        { size: "XL", medianDays: null, tickets: 0 },
        { size: "none", medianDays: 3, tickets: 2 },
      ],
      excluded: 7,
    },
    quality: { ciGreenFirstPushPct: 93.75, prs: 16 },
    tokensPerMinute: [
      { agentId: "shop-app-ta", points: flat(TELEMETRY_POINTS, 1200) },
      { agentId: "studio", points: flat(TELEMETRY_POINTS, 300) },
      { agentId: "codex-ta", points: flat(TELEMETRY_POINTS, 50) },
    ],
    liveMinutes: [
      { agentId: "shop-app-ta", points: flat(LIVE_MINUTES, 900) },
      { agentId: "studio", points: flat(LIVE_MINUTES, 150) },
      { agentId: "codex-ta", points: flat(LIVE_MINUTES, 20) },
    ],
    utilisation: [
      { agentId: "shop-app-ta", working: 63.6, waiting: 8.2, blocked: 6, idle: 22.2 },
      { agentId: "studio", working: 10, waiting: 0, idle: 90 },
      { agentId: "codex-ta", working: 0, waiting: 0, idle: 100 },
    ],
    turnUsage: [
      {
        agentId: "shop-app-ta",
        turns: [
          { input: 300, output: 120, cacheRead: 9000 },
          { input: 280, output: 400, cacheRead: 12_000 },
        ],
      },
      { agentId: "studio", turns: [{ input: 10, output: 20, cacheRead: 30 }] },
      { agentId: "codex-ta", turns: [] },
    ],
    toolLatency: [
      {
        tool: "Bash",
        calls: 212,
        p50Ms: 2800,
        p95Ms: 41_000,
        failed: 6,
        slowest: { detail: "just test", agentId: "studio", durationMs: 660000 },
      },
      { tool: "Read", calls: 611, p50Ms: 100, p95Ms: null, failed: 0 },
    ],
    subagents: [
      {
        agentId: "shop-app-ta",
        taskId: "t1",
        type: "Explore",
        description: "Find the quote cache",
        status: "completed",
        tokens: 41_000,
        toolUses: 12,
        durationMs: 65_000,
      },
      {
        agentId: "studio",
        taskId: "t2",
        type: "general-purpose",
        description: "Draft the plan",
        status: "running",
        tokens: null,
        toolUses: null,
        durationMs: null,
      },
    ],
    quota: [
      {
        accountId: "claude-main",
        window: "5h",
        points: [
          { at: NOW - 5 * HOUR, pct: 10 },
          { at: NOW - MIN, pct: 62.4 },
        ],
      },
      {
        accountId: "codex-main",
        window: "7d",
        points: [
          { at: NOW - 4 * HOUR, pct: 30 },
          { at: NOW - MIN, pct: 41 },
        ],
      },
    ],
    machine: [
      { at: NOW - 3 * HOUR, cpuPct: 20, memPct: 40 },
      { at: NOW - 2 * HOUR, cpuPct: null, memPct: 41 },
      { at: NOW - MIN, cpuPct: 35, memPct: 42 },
    ],
    tokensByTicket: [
      { ticket: "shop-app#3349", tokens: 220_000, costUsd: 1.2 },
      { ticket: "site-builder#12", tokens: 55_000, costUsd: null },
    ],
    totals: [
      {
        agentId: "shop-app-ta",
        accountId: "claude-main",
        model: "claude-opus-4-1",
        input: 12_000,
        output: 3_400,
        cacheRead: 1_200_000,
        cacheHitPct: 96.4,
        turns: 40,
        toolCalls: 500,
        additions: 42,
        deletions: 7,
        costUsd: 2.47,
      },
      {
        agentId: "codex-ta",
        accountId: "codex-main",
        model: null,
        input: 900,
        output: 100,
        cacheRead: 0,
        cacheHitPct: null,
        turns: 3,
        toolCalls: 4,
        costUsd: null,
      },
    ],
    ...over,
  };
}

const EMPTY: TelemetryData = {
  today: {
    tokens: 0,
    cacheRead: 0,
    costUsd: null,
    toolCalls: 0,
    turns: 0,
    working: 0,
    agents: 0,
    merged7d: 0,
  },
  throughput: [],
  cycleTime: {
    rows: ["XS", "S", "M", "L", "XL", "none"].map((size) => ({
      size,
      medianDays: null,
      tickets: 0,
    })),
    excluded: 0,
  },
  quality: { ciGreenFirstPushPct: null, prs: 0 },
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
};

function stub(data: TelemetryData = tel(), config: ConfigView = CFG) {
  return stubFetch({
    "/api/telemetry?range=1h": data,
    "/api/telemetry?range=6h": data,
    "/api/telemetry?range=24h": data,
    "/api/telemetry?range=7d": data,
    "/api/telemetry?range=6h&agent=studio": data,
    "/api/telemetry?range=6h&account=codex-main": data,
    "/api/telemetry?range=6h&agent=studio&account=codex-main": data,
    "/api/config": config,
  });
}

const panel = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function loaded(data?: TelemetryData, config?: ConfigView) {
  const fetch = stub(data, config);
  const view = render(<Telemetry />);
  await screen.findByText("61.2k");
  return { fetch, ...view };
}

describe("Telemetry refetch", () => {
  it("keeps the last range on screen, dimmed, while a new one loads", async () => {
    const { fetch } = await loaded();
    const answer = fetch.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fetch.mockImplementation(async (...a: unknown[]) => {
      if (a[0] === "/api/telemetry?range=24h") await gate;
      return answer(...a);
    });
    const page = document.getElementById("page-telemetry") as HTMLElement;
    expect(page.classList.contains("refetching")).toBe(false);
    fireEvent.click(
      within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "24h" }),
    );
    await waitFor(() => expect(page.classList.contains("refetching")).toBe(true));
    expect(screen.getByText("61.2k")).toBeTruthy();
    release();
    await waitFor(() => expect(page.classList.contains("refetching")).toBe(false));
    expect(screen.getByText("61.2k")).toBeTruthy();
  });
});

describe("Telemetry toolbar", () => {
  it("asks for 6h by default and the picked range on a switch", async () => {
    const { fetch } = await loaded();
    expect(fetch).toHaveBeenCalledWith("/api/telemetry?range=6h", expect.anything());
    const range = screen.getByRole("group", { name: "Range" });
    expect(within(range).getByRole("button", { name: "6h" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(within(range).getByRole("button", { name: "24h" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/telemetry?range=24h", expect.anything()),
    );
    expect(within(range).getByRole("button", { name: "24h" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("Agent and Account selects list All plus each from config; Ticket select; the note", async () => {
    await loaded();
    const agent = screen.getByLabelText("Agent") as HTMLSelectElement;
    expect([...agent.options].map((o) => o.textContent)).toEqual([
      "All",
      "shop-app-ta",
      "studio",
      "codex-ta",
    ]);
    const account = screen.getByLabelText("Account") as HTMLSelectElement;
    expect([...account.options].map((o) => o.textContent)).toEqual([
      "All",
      "claude-main",
      "codex-main",
    ]);
    expect(screen.getByLabelText("Ticket")).toBeInstanceOf(HTMLSelectElement);
    screen.getByText(
      "Token counts come from each provider's usage events. Costs marked ~ are API-equivalent estimates; a subscription isn't billed per token.",
    );
  });
});

describe("scoped telemetry", () => {
  it("passes the Agent and Account selects into the resource path", async () => {
    const { fetch } = await loaded();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "studio" } });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/telemetry?range=6h&agent=studio", expect.anything()),
    );
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "codex-main" } });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/telemetry?range=6h&agent=studio&account=codex-main",
        expect.anything(),
      ),
    );
  });

  it("choosing All again drops the Agent or Account filter and shows the unscoped numbers", async () => {
    const scoped = tel({ today: { ...tel().today, tokens: 42_100 } });
    stubFetch({
      [RESOURCES.telemetry("6h").path]: tel(),
      [RESOURCES.telemetry("6h", "studio").path]: scoped,
      [RESOURCES.telemetry("6h", "", "codex-main").path]: scoped,
      "/api/config": CFG,
    });
    render(<Telemetry />);
    await screen.findByText("61.2k");
    for (const [label, value] of [
      ["Agent", "studio"],
      ["Account", "codex-main"],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      await screen.findByText("42.1k");
      fireEvent.change(screen.getByLabelText(label), { target: { value: "" } });
      await screen.findByText("61.2k");
      expect(screen.queryByText("42.1k")).toBeNull();
    }
  });
});

const Q = {
  ciGreenFirstPushPct: 93.75,
  prs: 16,
  reviewRoundsPerPr: 1.5,
  firstPassReviewPct: 50,
  retroFindingsPerPr: 0.8,
  sentBackPrs: 2,
  humanReviewWaitMs: 120000,
  reviewedPrs: 2,
  commitsPerRun: 2,
};

const kpi = (container: HTMLElement, label: string) => {
  const k = [...container.querySelectorAll(".kpi")].find(
    (x) => x.querySelector(".lbl")?.textContent === label,
  ) as Element;
  return {
    value: k.querySelector(".v")?.textContent,
    detail: k.querySelector(".d")?.textContent,
    title: k.querySelector(".v")?.getAttribute("title") ?? null,
    nt: k.querySelector(".v")?.classList.contains("nt"),
  };
};

const quality = () =>
  [...panel("tQual").querySelectorAll(".stat2")].map((s) => [
    s.querySelector("span")?.textContent,
    s.querySelector("b")?.textContent,
    s.querySelector("b")?.getAttribute("title"),
  ]);

describe("KPI tiles", () => {
  it.each([false, true])("animates changed live values only (reduced motion: %s)", (reduced) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: reduced })),
    );
    stub();
    const data = tel();
    const { container, rerender } = render(<Kpis t={data} />);
    expect(container.querySelector(".kpi-change")).toBeNull();
    const changed = tel({ today: { ...data.today, tokens: 72_000 } });
    rerender(<Kpis t={changed} />);
    expect(screen.getByText("72.0k").classList.contains("kpi-change")).toBe(!reduced);
    expect(container.querySelectorAll(".kpi-change")).toHaveLength(reduced ? 0 : 1);
    fireEvent.animationEnd(screen.getByText("72.0k"));
    // jsdom has no AnimationEvent, so React subscribes to the prefixed event.
    fireEvent(screen.getByText("72.0k"), new Event("webkitAnimationEnd", { bubbles: true }));
    expect(container.querySelector(".kpi-change")).toBeNull();
    rerender(<Kpis t={{ ...changed }} />);
    expect(container.querySelector(".kpi-change")).toBeNull();
    rerender(<Kpis t={data} />);
    expect(screen.getByText("61.2k").classList.contains("kpi-change")).toBe(!reduced);
  });

  it("Commits shows today’s count with commits per run in its title", async () => {
    const a = await loaded(tel({ today: { ...tel().today, commits: 7 }, quality: Q }));
    expect(kpi(a.container, "Commits")).toEqual({
      value: "7",
      detail: "today",
      title: "2.0 per run, last 14 days",
      nt: false,
    });
    a.unmount();
    const b = await loaded(
      tel({ today: { ...tel().today, commits: 0 }, quality: { ...Q, commitsPerRun: null } }),
    );
    expect(kpi(b.container, "Commits")).toMatchObject({
      value: "0",
      title: "No finished crew runs in the last 14 days.",
    });
  });

  it("a tile with no data source says not tracked yet", async () => {
    const { container } = await loaded();
    for (const label of ["Commits", "Lock wait", "Your response"]) {
      expect(kpi(container, label)).toMatchObject({
        value: NOT_TRACKED,
        title: NOT_TRACKED_TITLE,
        nt: true,
      });
    }
    const notTracked = [
      ...panel("tQual").querySelectorAll(".stat2 b"),
      ...panel("tCapcom").querySelectorAll(".stat2 b"),
    ].filter((b) => b.textContent === NOT_TRACKED);
    expect(notTracked).toHaveLength(9);
    for (const b of notTracked) expect(b.classList.contains("nt")).toBe(true);
  });

  it("computed tiles show today's numbers; the others show — with the phase that brings them", async () => {
    const { container } = await loaded();
    const tiles = [...container.querySelectorAll(".kpi")].map((k) => ({
      label: k.querySelector(".lbl")?.textContent,
      value: k.querySelector(".v")?.textContent,
      detail: k.querySelector(".d")?.textContent,
      title: k.querySelector(".v")?.getAttribute("title") ?? null,
    }));
    expect(tiles).toEqual([
      {
        label: "Tokens",
        value: "61.2k",
        detail: "today, in + out · 1.25M cache read",
        title: null,
      },
      { label: "~Cost", value: "~$3.50", detail: "today, API-equivalent", title: null },
      { label: "Tool calls", value: "812", detail: "today · 64 turns", title: null },
      { label: "Commits", value: NOT_TRACKED, detail: "today", title: NOT_TRACKED_TITLE },
      { label: "Working", value: "2", detail: "now, of 3 agents", title: null },
      { label: "Merged", value: "5", detail: "PRs, last 7 days", title: null },
      { label: "Lock wait", value: NOT_TRACKED, detail: "today", title: NOT_TRACKED_TITLE },
      {
        label: "Your response",
        value: NOT_TRACKED,
        detail: "median, today",
        title: NOT_TRACKED_TITLE,
      },
      // the stub serves no guard routes: both read — until the hub answers
      { label: "Guard", value: "—", detail: "", title: null },
      { label: "Test lock", value: "—", detail: "", title: null },
    ]);
  });

  it("Commits, Lock wait and Your response read — until the hub answers", async () => {
    const fetch = stub();
    const answer = fetch.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    fetch.mockImplementation(async (...a: unknown[]) => {
      const url = String(a[0]);
      if (url.startsWith("/api/telemetry") || url === "/api/test-lock/history")
        await new Promise(() => {});
      return answer(...a);
    });
    const { container } = render(<Telemetry />);
    await waitFor(() => expect(container.querySelector(".kpi")).toBeTruthy());
    expect(["Commits", "Lock wait", "Your response"].map((l) => kpi(container, l).value)).toEqual([
      "—",
      "—",
      "—",
    ]);
  });
});

describe("Flow of work", () => {
  it("throughput: 14 bars, the last in the accent", async () => {
    await loaded();
    const svg = within(panel("tThru")).getByRole("img");
    expect(svg.getAttribute("aria-label")).toMatch(/^Tickets merged per day: /);
    const bars = svg.querySelectorAll("path.bar");
    expect(bars).toHaveLength(7); // the odd days and the last; the even days are 0
    expect(bars[bars.length - 1]?.getAttribute("fill")).toBe("var(--accent)");
    expect(svg.querySelectorAll("rect.hit")).toHaveLength(14);
    fireEvent.pointerEnter(svg.querySelectorAll("rect.hit")[13] as Element);
    expect(panel("tThru").querySelector(".tip")?.textContent).toBe("Sat 17 Oct: 4 merged");
  });

  it("cycle time: a row per size, — where none, and the measurement note", async () => {
    await loaded();
    const p = panel("tCycle");
    screen.getByText("Ready to Done, median days by size");
    expect([...p.querySelectorAll(".hrow")].map((r) => r.textContent)).toEqual([
      "XS0.6 d4 tickets",
      "S1.4 d11 tickets",
      "M2.9 d1 ticket",
      "L—0 tickets",
      "XL—0 tickets",
      "no size3.0 d2 tickets",
    ]);
    within(p).getByText(
      "Measured from the board: when a ticket entered Ready to when it reached Done. 7 done tickets left out because they have no Ready entry or their timestamps are out of order.",
    );
  });

  it("cycle time: a row with 0 tickets draws no bar, and does not set the scale", async () => {
    await loaded(
      tel({
        cycleTime: {
          rows: [
            { size: "XS", medianDays: 2, tickets: 4 },
            { size: "L", medianDays: 8, tickets: 0 },
          ],
          excluded: 0,
        },
      }),
    );
    const widths = [...panel("tCycle").querySelectorAll<HTMLElement>(".hrow .track i")].map(
      (i) => i.style.width,
    );
    expect(widths).toEqual(["100%", "0%"]);
  });

  it("quality: CI green on first push rounded; the rest — with their reasons", async () => {
    await loaded();
    const stats = [...panel("tQual").querySelectorAll(".stat2")].map((s) => [
      s.querySelector("span")?.textContent,
      s.querySelector("b")?.textContent,
      s.querySelector("b")?.getAttribute("title"),
    ]);
    expect(stats).toEqual([
      ["verify passed first try", NOT_TRACKED, NOT_TRACKED_TITLE],
      ["review rounds per PR", NOT_TRACKED, NOT_TRACKED_TITLE],
      ["RETRO findings per PR", NOT_TRACKED, NOT_TRACKED_TITLE],
      ["median wait for a human review", NOT_TRACKED, NOT_TRACKED_TITLE],
      ["PRs sent back by reviewers", NOT_TRACKED, NOT_TRACKED_TITLE],
      ["CI green on first push", "94%", "16 merged PRs with a known first-push CI result"],
    ]);
  });

  it("quality: review rounds and first-pass rate show the hub's numbers", async () => {
    const a = await loaded(tel({ quality: Q }));
    expect(quality()).toEqual(
      expect.arrayContaining([
        ["review rounds per PR", "1.5", "2 merged PRs with a review"],
        ["RETRO findings per PR", "0.8", "2 merged PRs with a review"],
      ]),
    );
    a.unmount();
    await loaded(
      tel({
        quality: {
          ...Q,
          reviewRoundsPerPr: null,
          firstPassReviewPct: null,
          retroFindingsPerPr: null,
        },
      }),
    );
    const none = "No merged PRs with a review in the last 14 days.";
    expect(quality()).toEqual(
      expect.arrayContaining([
        ["review rounds per PR", "—", none],
        ["RETRO findings per PR", "—", none],
      ]),
    );
  });

  it("You as CAPCOM: omitted fields are not tracked", async () => {
    await loaded();
    const stats = [...panel("tCapcom").querySelectorAll(".stat2")];
    expect(stats.map((s) => s.querySelector("span")?.textContent)).toEqual([
      "decisions today",
      "median response",
      "slowest 10%",
      "runs you stopped",
    ]);
    for (const s of stats) {
      expect(s.querySelector("b")?.textContent).toBe(NOT_TRACKED);
      expect(s.querySelector("b")?.getAttribute("title")).toBe(NOT_TRACKED_TITLE);
    }
  });
});

describe("Agents", () => {
  it("tokens per minute: Live is the last 60 minutes, History the range; a series per agent", async () => {
    await loaded();
    const p = panel("tTok");
    within(p).getByText("live · last 60 minutes, by agent");
    expect(p.querySelectorAll("path.area")).toHaveLength(3);
    expect([...p.querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "shop-app-ta",
      "studio",
      "codex-ta",
    ]);
    fireEvent.click(within(p).getByRole("button", { name: "History" }));
    within(p).getByText("history · last 6h, by agent");
    expect(within(p).getByRole("img").getAttribute("aria-label")).toBe(
      "Tokens per minute, last 6h: shop-app-ta latest 1.2k, peak 1.2k; studio latest 300, peak 300; codex-ta latest 50, peak 50",
    );
  });

  it("the Agent filter limits every agent series to that agent", async () => {
    await loaded();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "studio" } });
    expect(panel("tTok").querySelectorAll("path.area")).toHaveLength(1);
    expect([...panel("tTok").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "studio",
    ]);
    expect(panel("tUtil").querySelectorAll(".hrow")).toHaveLength(1);
    within(panel("tTurn")).getByText("studio · latest run");
    expect([...panel("tSubs").querySelectorAll("tbody tr")]).toHaveLength(1);
    // studio has no totals row in range
    within(panel("tTotals")).getByText("No usage for this filter in the last 6h.");
  });

  it("the Account filter limits agents to the account's loops, quota and totals to the account", async () => {
    await loaded();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "codex-main" } });
    expect([...panel("tTok").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "codex-ta",
    ]);
    expect(panel("tQuota").querySelectorAll("path.line")).toHaveLength(1);
    expect([...panel("tQuota").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual(
      ["codex-main 7d · 41%"],
    );
    expect(panel("tTotals").querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("where agent time goes: four labelled shares, rounded for display", async () => {
    await loaded();
    const row = panel("tUtil").querySelector(".hrow") as HTMLElement;
    expect(row.textContent).toBe("shop-app-ta64%");
    expect([...row.querySelectorAll(".ubar i")].map((i) => i.getAttribute("title"))).toEqual([
      "working 64%",
      "waiting (lock, reviews) 8%",
      "blocked, parked or stalled 6%",
      "idle 22%",
    ]);
    expect([...panel("tUtil").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "working",
      "waiting (lock, reviews)",
      "blocked, parked or stalled",
      "idle",
    ]);
  });

  it("tokens per turn: the selected agent's latest run, else the first", async () => {
    await loaded();
    within(panel("tTurn")).getByText("shop-app-ta · latest run");
    // two turns × three kinds
    expect(panel("tTurn").querySelectorAll("path.bar")).toHaveLength(6);
    expect([...panel("tTurn").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "input",
      "output",
      "cache read",
    ]);
    setSelectedAgent("codex-ta");
    await within(panel("tTurn")).findByText("codex-ta · latest run");
    within(panel("tTurn")).getByText("No turns recorded for codex-ta yet.");
  });

  it("tool latency and subagents tables", async () => {
    await loaded();
    const lat = panel("tLat");
    expect([...lat.querySelectorAll("th")].map((t) => t.textContent)).toEqual([
      "Tool",
      "Calls",
      "p50",
      "p95",
      "Failed",
      "Slowest",
    ]);
    expect([...lat.querySelectorAll("tbody tr")].map((r) => r.textContent)).toEqual([
      "Bash2122.8s41s6just test (11m 00s, studio)",
      "Read6110.1s—0—",
    ]);
    const subs = panel("tSubs");
    expect([...subs.querySelectorAll("th")].map((t) => t.textContent)).toEqual([
      "Agent",
      "Type",
      "Task",
      "Tokens",
      "Tools",
      "Took",
    ]);
    expect([...subs.querySelectorAll("tbody tr")].map((r) => r.textContent)).toEqual([
      "shop-app-taExploreFind the quote cache41.0k121m 05s",
      "studiogeneral-purposeDraft the plan——Running",
    ]);
  });
});

describe("Capacity and cost", () => {
  it("quota: a line per account window, y to 110 %, the 100 % limit dashed", async () => {
    await loaded();
    const p = panel("tQuota");
    expect(p.querySelectorAll("path.line")).toHaveLength(2);
    expect(p.querySelector("line.limit")).not.toBeNull();
    expect([...p.querySelectorAll("text")].map((t) => t.textContent)).toEqual(
      expect.arrayContaining(["0%", "50%", "100%", "-6h", "now"]),
    );
    // Room above the limit line, but no tick past 100 %.
    expect([...p.querySelectorAll("text")].map((t) => t.textContent)).not.toContain("110%");
    expect([...p.querySelectorAll("text")].map((t) => t.textContent)).not.toContain("55%");
    expect([...p.querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "claude-main 5h · 62%",
      "codex-main 7d · 41%",
    ]);
  });

  it("machine: CPU and Memory lines with the lock legend; omitted history and steps are not tracked", async () => {
    await loaded();
    expect(panel("tMach").querySelectorAll("path.line")).toHaveLength(2);
    expect([...panel("tMach").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "CPU",
      "Memory",
      "test lock held",
    ]);
    within(panel("tLock")).getByText(NOT_TRACKED);
    within(panel("tStepBars")).getByText(NOT_TRACKED);
  });

  it("tokens by ticket and totals", async () => {
    await loaded();
    expect([...panel("tTicketBars").querySelectorAll(".hrow")].map((r) => r.textContent)).toEqual([
      "shop-app #3349220k~$1.20",
      "site-builder #1255.0k—",
    ]);
    const t = panel("tTotals");
    expect([...t.querySelectorAll("th")].map((h) => h.textContent)).toEqual([
      "Agent",
      "Account",
      "Model",
      "Input",
      "Output",
      "Cache read",
      "Cache hit",
      "Turns",
      "Tool calls",
      "Lines (+/−)",
      "~Cost",
    ]);
    expect([...t.querySelectorAll("tbody tr")].map((r) => r.textContent)).toEqual([
      "shop-app-taclaude-mainclaude-opus-4-112.0k3.4k1.20M96%40500+42 −7~$2.47",
      "codex-tacodex-main—9001000—34— ——",
    ]);
  });

  it("renders all twelve ticket rows with titles joined by repo and issue, as inert text", async () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      boardItem({
        repoId: i % 2 === 0 ? "shop-app" : "site-builder",
        issueNumber: Math.floor(i / 2) + 1,
        title: i === 11 ? '<img src=x onerror="alert(1)">' : `Ticket title ${i}`,
      }),
    );
    stubFetch({
      [RESOURCES.config.path]: CFG,
      [RESOURCES.telemetry("6h").path]: tel({
        tokensByTicket: items.map((item) => ({
          ticket: `${item.repoId}#${item.issueNumber}`,
          tokens: 1000,
          costUsd: null,
        })),
      }),
      ...Object.fromEntries(
        ["shop-app", "site-builder"].map((id) => [
          RESOURCES.boards(id).path,
          items.filter((item) => item.repoId === id),
        ]),
      ),
    });
    render(<Telemetry />);
    await within(panel("tTicketBars")).findByText(items[11]?.title as string);
    const rows = panel("tTicketBars").querySelectorAll(".hrow");
    expect(rows).toHaveLength(12);
    await waitFor(() => {
      items.forEach((item, i) => {
        const title = rows[i]?.querySelector(".ticket-bar-title");
        expect(title?.textContent).toBe(item.title);
        expect(title?.previousElementSibling?.className).toBe("rref");
        expect(title?.parentElement?.className).toBe("ellip");
      });
    });
    expect(panel("tTicketBars").querySelector("img")).toBeNull();
  });

  it("fetches ticket titles only for configured repos, leaving unknown tickets visible", async () => {
    const item = boardItem({ repoId: "shop-app", issueNumber: 1, title: "Configured ticket" });
    const fetch = stubFetch({
      [RESOURCES.config.path]: { ...CFG, repos: CFG.repos.filter((r) => r.id === "shop-app") },
      [RESOURCES.telemetry("6h").path]: tel({
        tokensByTicket: [
          { ticket: "shop-app#1", tokens: 1000, costUsd: null },
          { ticket: "site-builder#2", tokens: 500, costUsd: null },
          { ticket: "unknown#3", tokens: 100, costUsd: null },
        ],
      }),
      [RESOURCES.boards("shop-app").path]: [item],
    });
    render(<Telemetry />);
    await within(panel("tTicketBars")).findByText(item.title);
    expect(panel("tTicketBars").querySelectorAll(".hrow")).toHaveLength(3);
    within(panel("tTicketBars")).getByText("site-builder");
    within(panel("tTicketBars")).getByText("unknown");
    expect(
      fetch.mock.calls.map(([url]) => url).filter((url) => url.startsWith("/api/boards/")),
    ).toEqual([RESOURCES.boards("shop-app").path]);
  });

  it("shows the live holder and queue without history, with a ticking elapsed time", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const lock: TestLockState = {
      holder: {
        runId: "live",
        seatId: "inco-1",
        command: "pnpm test <script>agent text</script>",
        since: NOW - MIN,
      },
      waiting: [{ runId: "queued", seatId: "guido-1", command: "pnpm test", since: NOW - 30_000 }],
    };
    stubFetch({
      [RESOURCES.config.path]: CFG,
      [RESOURCES.telemetry("6h").path]: tel(),
      [RESOURCES.testLock.path]: lock,
      [RESOURCES.crew.path]: { rows: [seatRow({ id: "inco-1", hudState: "stalled" })] },
    });
    render(<Telemetry />);
    const p = within(panel("tLock"));
    const row = (await p.findByText("no output")).closest("tr") as HTMLTableRowElement;
    expect([...row.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
      "12:59",
      "inco-1",
      lock.holder?.command,
      "—",
      "1:00",
      "no output",
    ]);
    expect(panel("tLock").querySelector("script")).toBeNull();
    p.getByText("GUIDO-1 waiting · 0:30");
    p.getByText("History: not tracked yet");
    act(() => vi.advanceTimersByTime(1000));
    expect(row.querySelectorAll("td")[4]?.textContent).toBe("1:01");
    p.getByText("GUIDO-1 waiting · 0:31");
  });
});

describe("empty and failing telemetry", () => {
  it("every panel shows its empty state", async () => {
    stub(EMPTY, { ...CFG, loops: [] });
    render(<Telemetry />);
    await within(panel("tThru")).findByText("No days to show yet.");
    within(panel("tTok")).getByText("No tokens in the last 60 minutes.");
    within(panel("tUtil")).getByText("No agents configured.");
    within(panel("tTurn")).getByText("No agents configured.");
    within(panel("tLat")).getByText("No tool calls in the last 6h.");
    within(panel("tSubs")).getByText("No subagents spawned today.");
    within(panel("tQuota")).getByText("No quota readings in the last 6h.");
    within(panel("tMach")).getByText("No machine samples in the last 6h.");
    within(panel("tTicketBars")).getByText("No ticket work in the last 6h.");
    within(panel("tTotals")).getByText("No usage for this filter in the last 6h.");
    expect([...panel("tCycle").querySelectorAll(".hrow")].map((r) => r.textContent)).toContain(
      "XS—0 tickets",
    );
    const ci = [...panel("tQual").querySelectorAll(".stat2")].at(-1);
    expect(ci?.querySelector("b")?.textContent).toBe("—");
    expect(ci?.querySelector("b")?.getAttribute("title")).toBe(
      "No merged PRs with a known first-push CI result in the last 14 days.",
    );
    expect(screen.getAllByText("~Cost")[0]?.parentElement?.querySelector(".v")?.textContent).toBe(
      "—",
    );
  });

  it("all-zero tokens show the empty state, not a flat chart", async () => {
    stub(
      tel({
        liveMinutes: [{ agentId: "shop-app-ta", points: flat(LIVE_MINUTES, 0) }],
      }),
    );
    render(<Telemetry />);
    await within(panel("tTok")).findByText("No tokens in the last 60 minutes.");
  });

  it("a failed fetch says so", async () => {
    stubFetch({ "/api/config": CFG });
    render(<Telemetry />);
    await screen.findByText(/^Could not load telemetry:/);
  });
});

describe("engine telemetry", () => {
  it("shows seeded review, CAPCOM, commits and loop-step figures", async () => {
    const { container } = await loaded(
      tel({
        today: { ...tel().today, commits: 7 },
        quality: Q,
        capcom: {
          answered: 11,
          medianMs: 240000,
          p90Ms: 1320000,
          stopped: 2,
          longest: { agentId: "inco-1", ms: 2280000 },
          agentWaitMs: 4320000,
        },
        tokensByStep: ["plan", "build", "review"].map((step) => ({
          step: step as "plan" | "build" | "review",
          tokens: 1000,
          costUsd: 0.5,
          runs: 3,
        })),
      }),
    );
    expect(kpi(container, "Your response").value).toBe("4m 00s");
    expect(kpi(container, "Commits").value).toBe("7");
    expect(quality()).toEqual(
      expect.arrayContaining([
        ["RETRO findings per PR", "0.8", "2 merged PRs with a review"],
        ["PRs sent back by reviewers", "2", "50% passed the first review round"],
        [
          "median wait for a human review",
          "2m 00s",
          "How long a finished PR waited for your review, median, last 14 days.",
        ],
      ]),
    );
    expect([...panel("tCapcom").querySelectorAll("b")].map((x) => x.textContent)).toEqual([
      "11",
      "4m 00s",
      "22m 00s",
      "2",
    ]);
    within(panel("tCapcom")).getByText(
      "Longest wait today: INCO-1's question, 38m 00s. Agent time spent waiting on you today: 1h 12m.",
    );
    expect([...panel("tStepBars").querySelectorAll(".hrow")].map((x) => x.textContent)).toEqual([
      "plan1.0k~$0.50 · 3 runs",
      "build1.0k~$0.50 · 3 runs",
      "review1.0k~$0.50 · 3 runs",
    ]);
  });
  it.each(["running", "stalled"])("shows stored runs and a %s live holder", async (state) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const fetch = stub();
    const answer = fetch.getMockImplementation() as (
      ...args: Parameters<typeof fetch>
    ) => Promise<Response>;
    fetch.mockImplementation(async (...args) => {
      const data =
        args[0] === "/api/test-lock/history"
          ? {
              runs: [
                {
                  runId: "old",
                  seatId: "guido-1",
                  command: "pnpm test",
                  queuedAt: NOW - 660000,
                  startedAt: NOW - 600000,
                  endedAt: NOW - 120000,
                  outcome: "freed",
                  ticket: null,
                },
              ],
              today: { runs: 1, waitMs: 60000 },
              usualMs: {},
            }
          : args[0] === "/api/test-lock"
            ? {
                holder: {
                  runId: "live",
                  seatId: "inco-1",
                  command: "just test",
                  since: NOW - 60000,
                },
                waiting: [],
              }
            : args[0] === "/api/crew"
              ? { rows: [{ id: "inco-1", hudState: state }] }
              : null;
      return data ? new Response(JSON.stringify(data)) : answer(...args);
    });
    const { container } = render(<Telemetry />);
    await within(panel("tLock")).findByText("freed with its run");
    expect([...panel("tLock").querySelectorAll("th")].map((x) => x.textContent)).toEqual([
      "Started",
      "Agent",
      "Run",
      "Waited",
      "Took",
      "Result",
    ]);
    const row = within(panel("tLock"))
      .getByText("freed with its run")
      .closest("tr") as HTMLTableRowElement;
    expect([...row.querySelectorAll("td")].map((x) => x.textContent)).toEqual([
      "12:50",
      "guido-1",
      "pnpm test",
      "1:00",
      "8:00",
      "freed with its run",
    ]);
    expect(row.querySelector(".warn-t")).toBeTruthy();
    within(panel("tLock")).getByText(state === "stalled" ? "no output" : "running");
    expect(kpi(container, "Lock wait")).toMatchObject({ value: "1:00", detail: "today · 1 runs" });
    expect(panel("tMach").querySelectorAll("rect.band")).toHaveLength(2);
    const live = within(panel("tLock"))
      .getByText(state === "stalled" ? "no output" : "running")
      .closest("tr") as HTMLTableRowElement;
    expect(live.querySelectorAll("td")[4]?.textContent).toBe("1:00");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(live.querySelectorAll("td")[4]?.textContent).toBe("1:02");
  });
});

describe("ticket scope", () => {
  it("merges held tickets with usage tickets, sorted without duplicates, and keeps a held selection", async () => {
    stubFetch({
      [RESOURCES.config.path]: CFG,
      [RESOURCES.crew.path]: {
        rows: [
          seatRow({ id: "held", ticket: "mission-control#398" }),
          seatRow({ id: "duplicate", ticket: "mission-control#398" }),
          seatRow({ id: "used", ticket: "shop-app#3349" }),
          seatRow({ id: "free", ticket: null }),
        ],
        firstRunToday: null,
      },
      [RESOURCES.telemetry("6h").path]: tel(),
      [RESOURCES.telemetry("6h", "", "", "mission-control#398").path]: EMPTY,
    });
    render(<Telemetry />);
    const select = screen.getByLabelText("Ticket") as HTMLSelectElement;
    await waitFor(() =>
      expect([...select.options].map((o) => o.textContent)).toEqual([
        "All",
        "mission-control#398",
        "shop-app#3349",
        "site-builder#12",
      ]),
    );
    fireEvent.change(select, { target: { value: "mission-control#398" } });
    await within(panel("tTotals")).findByText("No usage for this filter in the last 6h.");
    expect(select.value).toBe("mission-control#398");
  });

  it("selects each ticket, combines and clears filters using response bars and totals", async () => {
    const data = tel();
    const routes: Record<string, unknown> = {
      [RESOURCES.config.path]: CFG,
      "/api/telemetry?range=6h": data,
    };
    for (const row of data.tokensByTicket) {
      routes[`/api/telemetry?range=6h&ticket=${encodeURIComponent(row.ticket)}`] = tel({
        tokensByTicket: [{ ...row, tokens: 123 }],
        totals: [{ ...(data.totals[0] as TelemetryData["totals"][number]), input: 321 }],
      });
    }
    routes["/api/telemetry?range=6h&agent=studio"] = data;
    routes["/api/telemetry?range=6h&agent=studio&ticket=site-builder%2312"] = EMPTY;
    routes["/api/telemetry?range=6h&agent=studio&account=codex-main"] = data;
    routes["/api/telemetry?range=6h&agent=studio&account=codex-main&ticket=site-builder%2312"] =
      EMPTY;
    const fetch = stubFetch(routes);
    render(<Telemetry />);
    const select = await screen.findByLabelText("Ticket");
    await waitFor(() => expect((select as HTMLSelectElement).options).toHaveLength(3));
    select.focus();
    expect(document.activeElement).toBe(select);
    for (const row of data.tokensByTicket) {
      fireEvent.change(select, { target: { value: row.ticket } });
      await within(panel("tTicketBars")).findByText("123");
      expect(panel("tTicketBars").querySelectorAll(".hrow")).toHaveLength(1);
      within(panel("tTotals")).getByText("321");
    }
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "studio" } });
    await within(panel("tTotals")).findByText("No usage for this filter in the last 6h.");
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "codex-main" } });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/telemetry?range=6h&agent=studio&account=codex-main&ticket=site-builder%2312",
        expect.anything(),
      ),
    );
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "" } });
    await within(panel("tTicketBars")).findByText("220k");
  });

  it("resets a ticket absent from a new range", async () => {
    stubFetch({
      [RESOURCES.config.path]: CFG,
      "/api/telemetry?range=6h": tel(),
      "/api/telemetry?range=6h&ticket=shop-app%233349": tel(),
      "/api/telemetry?range=1h": EMPTY,
      "/api/telemetry?range=1h&ticket=shop-app%233349": EMPTY,
    });
    render(<Telemetry />);
    const select = await screen.findByLabelText("Ticket");
    await waitFor(() => expect((select as HTMLSelectElement).options).toHaveLength(3));
    fireEvent.change(select, { target: { value: "shop-app#3349" } });
    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe(""));
    await within(panel("tTicketBars")).findByText("No ticket work in the last 1h.");
  });
});

it("keeps telemetry controls and wide tables usable on narrow screens", async () => {
  await loaded();
  const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
  expect(css.match(/\.toolbar \{([^}]*)\}/)?.[1]).toContain("flex-wrap: wrap");
  expect(css.match(/\.tw \{([^}]*)\}/)?.[1]).toContain("overflow-x: auto");
  expect(css).toMatch(
    /@media \(max-width: 999px\) \{[^}]*\.tgrid,[^}]*grid-template-columns: minmax\(0, 1fr\)/,
  );
  for (const id of ["tLat", "tTotals"]) {
    expect(panel(id).querySelector("table")?.parentElement?.classList.contains("tw")).toBe(true);
  }
});

it("preserves unknown time and independently unavailable line and slowest details", async () => {
  const data = tel();
  await loaded(
    tel({
      utilisation: [
        { agentId: "shop-app-ta", working: 20, waiting: 10, blocked: 5, idle: 15, unknown: 50 },
      ],
      totals: [
        { ...(data.totals[0] as TelemetryData["totals"][number]), additions: 0, deletions: null },
      ],
      toolLatency: [
        {
          ...(data.toolLatency[0] as TelemetryData["toolLatency"][number]),
          slowest: { detail: null, agentId: "studio", durationMs: 1000 },
        },
      ],
    }),
  );
  within(panel("tLat")).getByText("— (1.0s, studio)");
  expect(panel("tUtil").querySelector('[title="unknown 50%"]')).toBeTruthy();
  within(panel("tTotals")).getByText("+0");
  expect(panel("tTotals").querySelector(".del")?.textContent).toBe("—");
});
