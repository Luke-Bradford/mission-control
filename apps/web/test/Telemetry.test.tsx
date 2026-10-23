import {
  type ConfigView,
  ENGINE_NOT_RUNNING,
  FLIGHT_NOT_RUNNING,
  LIVE_MINUTES,
  NO_REVIEWS,
  TELEMETRY_POINTS,
  type Telemetry as TelemetryData,
} from "@mc/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCES } from "../src/data.ts";
import { Telemetry } from "../src/pages/Telemetry.tsx";
import { setSelectedAgent } from "../src/shell/selection.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, HOUR, MIN, NOW } from "./fixtures.ts";

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
      { agentId: "shop-app-ta", working: 63.6, waiting: 8.2, idle: 28.2 },
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
      { tool: "Bash", calls: 212, p50Ms: 2800, p95Ms: 41_000, failed: 6 },
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

  it("Agent and Account selects list All plus each from config; no Ticket select; the note", async () => {
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
    expect(screen.queryByLabelText("Ticket")).toBeNull();
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

describe("KPI tiles", () => {
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
      { label: "Commits", value: "—", detail: "today", title: ENGINE_NOT_RUNNING },
      { label: "Working", value: "2", detail: "now, of 3 agents", title: null },
      { label: "Merged", value: "5", detail: "PRs, last 7 days", title: null },
      { label: "Lock wait", value: "—", detail: "today", title: ENGINE_NOT_RUNNING },
      { label: "Your response", value: "—", detail: "median, today", title: FLIGHT_NOT_RUNNING },
      // the stub serves no guard routes: both read — until the hub answers
      { label: "Guard", value: "—", detail: "", title: null },
      { label: "Test lock", value: "—", detail: "", title: null },
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
    screen.getByText("Ready (or In progress) to Done, median days by size");
    expect([...p.querySelectorAll(".hrow")].map((r) => r.textContent)).toEqual([
      "XS0.6 d4 tickets",
      "S1.4 d11 tickets",
      "M2.9 d1 ticket",
      "L—0 tickets",
      "XL—0 tickets",
      "no size3.0 d2 tickets",
    ]);
    within(p).getByText(
      "Measured from the board: from the first move into Ready, In progress, In review or Ready for QA to when the ticket reached Done. 7 done tickets went straight to Done.",
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
      ["verify passed first try", "—", ENGINE_NOT_RUNNING],
      ["fix rounds per ticket", "—", ENGINE_NOT_RUNNING],
      ["median wait for a human review", "—", NO_REVIEWS],
      ["RETRO findings per PR", "—", ENGINE_NOT_RUNNING],
      ["PRs sent back by reviewers", "—", NO_REVIEWS],
      ["CI green on first push", "94%", "16 merged PRs with a known first-push CI result"],
    ]);
  });

  it("You as CAPCOM: four — tiles, phase 3", async () => {
    await loaded();
    const stats = [...panel("tCapcom").querySelectorAll(".stat2")];
    expect(stats.map((s) => s.querySelector("span")?.textContent)).toEqual([
      "decisions today",
      "median response",
      "slowest 10%",
      "runs you stopped or interrupted",
    ]);
    for (const s of stats) {
      expect(s.querySelector("b")?.textContent).toBe("—");
      expect(s.querySelector("b")?.getAttribute("title")).toBe(FLIGHT_NOT_RUNNING);
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

  it("where agent time goes: working / waiting on you / idle, rounded for display", async () => {
    await loaded();
    const row = panel("tUtil").querySelector(".hrow") as HTMLElement;
    expect(row.textContent).toBe("shop-app-ta64%");
    expect([...row.querySelectorAll(".ubar i")].map((i) => i.getAttribute("title"))).toEqual([
      "working 64%",
      "waiting on you 8%",
      "idle 28%",
    ]);
    expect([...panel("tUtil").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "working",
      "waiting on you",
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
    ]);
    expect([...lat.querySelectorAll("tbody tr")].map((r) => r.textContent)).toEqual([
      "Bash2122.8s41s6",
      "Read6110.1s—0",
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

  it("machine: CPU and Memory lines; test lock and loop steps wait for the engine", async () => {
    await loaded();
    expect(panel("tMach").querySelectorAll("path.line")).toHaveLength(2);
    expect([...panel("tMach").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "CPU",
      "Memory",
    ]);
    within(panel("tLock")).getByText(ENGINE_NOT_RUNNING);
    within(panel("tStepBars")).getByText(ENGINE_NOT_RUNNING);
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
      "~Cost",
    ]);
    expect([...t.querySelectorAll("tbody tr")].map((r) => r.textContent)).toEqual([
      "shop-app-taclaude-mainclaude-opus-4-112.0k3.4k1.20M96%40500~$2.47",
      "codex-tacodex-main—9001000—34—",
    ]);
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
