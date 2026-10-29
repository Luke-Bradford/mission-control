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
import { kTokens, narrowDay } from "../src/fmt.ts";
import { Telemetry } from "../src/pages/Telemetry.tsx";
import { setSelectedAgent } from "../src/shell/selection.ts";
import { resetSession, setSession } from "../src/shell/session.ts";
import { NOT_TRACKED, NOT_TRACKED_TITLE } from "../src/telemetry/common.ts";
import { Kpis } from "../src/telemetry/Kpis.tsx";
import { stubFetch } from "./fetchStub.ts";
import {
  boardItem,
  CONFIG,
  HOUR,
  limit5h,
  limit7d,
  METRICS_VIEW,
  MIN,
  NOW,
  seatRow,
} from "./fixtures.ts";
import { readStyle, readStyles } from "./styles.ts";

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
    },
    throughput: Array.from({ length: 14 }, (_, i) => ({
      day: `2026-10-${String(4 + i).padStart(2, "0")}`,
      merged: i === 13 ? 4 : i % 2,
    })),
    cycleTime: {
      rows: [
        { size: "XS", p50Ms: 6 * HOUR, p85Ms: 9.5 * HOUR, tickets: 4 },
        { size: "S", p50Ms: 34.6 * HOUR, p85Ms: 50 * HOUR, tickets: 11 },
        { size: "M", p50Ms: 69.6 * HOUR, p85Ms: 69.6 * HOUR, tickets: 1 },
        { size: "L", p50Ms: 0, p85Ms: 0, tickets: 0 }, // 0 tickets reads —, whatever p50 says
        { size: "XL", p50Ms: null, p85Ms: null, tickets: 0 },
        { size: "none", p50Ms: 72 * HOUR, p85Ms: 80 * HOUR, tickets: 2 },
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
  },
  throughput: [],
  cycleTime: {
    rows: ["XS", "S", "M", "L", "XL", "none"].map((size) => ({
      size,
      p50Ms: null,
      p85Ms: null,
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
    "/api/metrics": METRICS_VIEW,
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
  it("claims live only while the telemetry on screen is this range's and fresh", async () => {
    const { fetch } = await loaded();
    expect(document.querySelectorAll(".kpi.live").length).toBeGreaterThan(0);
    const answer = fetch.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fetch.mockImplementation(async (...a: unknown[]) => {
      if (a[0] === "/api/telemetry?range=24h") await gate;
      return answer(...a);
    });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "24h" }),
    );
    await waitFor(() => expect(document.querySelectorAll(".kpi.live")).toHaveLength(0));
    expect(document.querySelectorAll(".nowc.live")).toHaveLength(0);
    await act(async () => release());
    await waitFor(() => expect(document.querySelectorAll(".kpi.live").length).toBeGreaterThan(0));
  });

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
  it("uses h2 headings for its top-level data groups", async () => {
    await loaded();
    for (const name of ["Flow of work", "Agents", "Capacity", "Cost"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    }
  });

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
    await screen.findByText("~$24.31");
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
      // the registry's cost, merged and working; the stub serves no crew, so working reads —
      { label: "Cost · today", value: "~$24.31", detail: "API-equivalent", title: null },
      { label: "Tool calls", value: "812", detail: "today · 64 turns", title: null },
      { label: "Commits", value: NOT_TRACKED, detail: "today", title: NOT_TRACKED_TITLE },
      { label: "Agents working · now", value: "—", detail: "", title: null },
      { label: "Merged · 24h", value: "6", detail: "PRs · +2 loops", title: null },
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

  it("names the session a registry tile follows, since Telemetry's own figures ignore it", async () => {
    const { container } = await loaded();
    act(() => setSession("shop-app-session"));
    const labels = () =>
      [...container.querySelectorAll(".kpi .lbl")].map((l) => l.textContent ?? "");
    await waitFor(() => expect(labels()).toContain("Cost · today · s/shop-app-session"));
    expect(labels()).toContain("Merged · 24h · s/shop-app-session");
    expect(labels()).toContain("Tokens");
    const merged = [...container.querySelectorAll(".kpi .lbl")].find((l) =>
      l.textContent?.startsWith("Merged"),
    );
    expect(merged?.getAttribute("title")).toContain(
      "On Telemetry this follows the header's session filter (s/shop-app-session)",
    );
    act(() => resetSession());
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
    const data = tel();
    await loaded(data);
    const svg = within(panel("tThru")).getByRole("img");
    expect(svg.getAttribute("aria-label")).toBe(
      `PRs merged per day: ${data.throughput
        .map((day) => `${narrowDay(day.day)} ${day.merged}`)
        .join(", ")}`,
    );
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
    screen.getByText("Ready to Done, p50 and p85 hours by size · last 14 days");
    expect([...p.querySelectorAll(".hrow")].map((r) => r.textContent)).toEqual([
      // p85 only from five tickets
      "XS6.0 h4 tickets",
      "S35 hp85 50 h · 11 tickets",
      "M70 h1 ticket",
      "L—0 tickets",
      "XL—0 tickets",
      "no size72 h2 tickets",
    ]);
    // the registry's cycle time over all sizes, with its window in the label
    await waitFor(() =>
      expect(p.querySelector(".tcycle-all")?.textContent).toBe(
        "Cycle time p50 · 14d 1.2 h p85 30 h · 8 tickets · 1 left out",
      ),
    );
    within(p).getByText(
      "Measured from the board: when a ticket entered Ready to when it reached Done. Sizes cover every repo; the p50 line above follows the header's session filter. 7 done tickets left out because they have no Ready entry or their timestamps are out of order.",
    );
  });

  it("cycle time: a row with 0 tickets draws no bar, and does not set the scale", async () => {
    await loaded(
      tel({
        cycleTime: {
          rows: [
            { size: "XS", p50Ms: 2 * HOUR, p85Ms: 2 * HOUR, tickets: 4 },
            { size: "L", p50Ms: 8 * HOUR, p85Ms: 8 * HOUR, tickets: 0 },
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
    const data = tel();
    await loaded(data);
    within(panel("tTurn")).getByText("shop-app-ta · latest run");
    // two turns × three kinds
    expect(panel("tTurn").querySelectorAll("path.bar")).toHaveLength(6);
    expect([...panel("tTurn").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "input",
      "output",
      "cache read",
    ]);
    const svg = within(panel("tTurn")).getByRole("img");
    const turns = data.turnUsage[0]?.turns ?? [];
    const hits = svg.querySelectorAll("rect.hit");
    turns.forEach((turn, i) => {
      fireEvent.pointerEnter(hits[i] as Element);
      expect(panel("tTurn").querySelector(".tip")?.textContent).toBe(
        `turn ${i + 1}cache read${kTokens(turn.cacheRead)}output${kTokens(turn.output)}input${kTokens(turn.input)}`,
      );
    });
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

  it("quota tooltip only reports an account's API reading at the selected sample time", async () => {
    await loaded();
    const svg = within(panel("tQuota")).getByRole("img");
    fireEvent.keyDown(svg, { key: "Home" });
    const tip = panel("tQuota").querySelector(".tip") as HTMLElement;
    expect(tip.textContent).toContain("claude-main 5h10%");
    expect(tip.textContent).toContain("codex-main 7d—");
  });

  it("keeps an unexplained quota drop as a gap rather than inventing a reset", async () => {
    await loaded(
      tel({
        quota: [
          {
            accountId: "claude-main",
            window: "5h",
            points: [
              { at: NOW - HOUR, pct: 80 },
              { at: NOW - MIN, pct: 12 },
            ],
          },
        ],
      }),
    );
    expect(panel("tQuota").querySelector(".annotation")).toBeNull();
  });

  it("labels only a provider-recorded quota reset", async () => {
    await loaded(
      tel({
        series: {
          stateSpans: [],
          tickets: [],
          annotations: [],
          quota: [
            {
              accountId: "claude-main",
              window: "5h",
              alertAt: 80,
              stopAt: 95,
              points: [
                { at: NOW - HOUR, pct: 80 },
                { at: NOW - MIN, pct: 12 },
              ],
              resets: [{ at: NOW - MIN, resetAt: NOW, cause: "provider" }],
            },
          ],
        },
      }),
    );
    expect(panel("tQuota").querySelector(".annotation")?.textContent).toBe("");
    expect(panel("tQuota").querySelector("svg")?.getAttribute("aria-label")).toContain(
      "claude-main 5h reset",
    );
  });

  it("breaks a reset and labels the configured alert and stop thresholds", async () => {
    const data = tel({
      quota: [
        {
          accountId: "claude-main",
          window: "5h",
          points: [
            { at: NOW - HOUR, pct: 80 },
            { at: NOW - MIN, pct: 12 },
          ],
        },
      ],
    });
    stubFetch({
      [RESOURCES.telemetry("6h").path]: data,
      [RESOURCES.config.path]: CFG,
      [RESOURCES.metrics().path]: METRICS_VIEW,
      [RESOURCES.limits.path]: [limit5h({ alertAt: 85, stopAt: 95 })],
    });
    render(<Telemetry />);
    await screen.findByText("61.2k");
    const quota = panel("tQuota");
    expect(quota.querySelector("path.line")?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
    expect(quota.textContent).toContain("claude-main alert 85%");
    expect(quota.textContent).toContain("claude-main stop 95%");
  });

  it("draws the server projection through reset and labels its forecasts", async () => {
    const data = tel({
      quota: [{ accountId: "codex-main", window: "7d", points: [{ at: NOW - MIN, pct: 41 }] }],
    });
    stubFetch({
      [RESOURCES.telemetry("6h").path]: data,
      [RESOURCES.config.path]: CFG,
      [RESOURCES.metrics().path]: METRICS_VIEW,
      [RESOURCES.limits.path]: [
        limit7d({
          accountId: "codex-main",
          projected: 84,
          stopForecast: NOW + HOUR,
          fullAt: NOW + 2 * HOUR,
        }),
      ],
    });
    render(<Telemetry />);
    await screen.findByText("61.2k");
    const quota = panel("tQuota");
    expect(quota.querySelectorAll("path.line")).toHaveLength(2);
    expect(quota.querySelectorAll("path.line")[1]?.getAttribute("stroke-dasharray")).toBe("4 3");
    expect(quota.querySelector("svg")?.getAttribute("aria-label")).toContain("codex-main 7d reset");
    expect(quota.querySelector("svg")?.getAttribute("aria-label")).toContain(
      "codex-main 7d stop forecast",
    );
    expect(quota.querySelector("svg")?.getAttribute("aria-label")).toContain(
      "codex-main 7d full forecast",
    );
  });

  it("machine: CPU and Memory lines with the lock legend; omitted history and steps are not tracked", async () => {
    const data = tel();
    await loaded(data);
    const p = panel("tMach");
    expect(p.querySelectorAll("path.line")).toHaveLength(2);
    expect([...p.querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "CPU",
      "Memory",
      "test lock held",
    ]);
    const svg = within(p).getByRole("img");
    data.machine.forEach((sample, i) => {
      fireEvent.keyDown(svg, { key: i === 0 ? "Home" : "ArrowRight" });
      const percent = (value: number | null): string => (value === null ? "—" : `${value}%`);
      expect(p.querySelector(".tip")?.textContent).toContain(`CPU${percent(sample.cpuPct)}`);
      expect(p.querySelector(".tip")?.textContent).toContain(`Memory${percent(sample.memPct)}`);
    });
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
    // the cost tile is the registry's figure, not this page's
    const costTile = [...document.querySelectorAll(".kpi")].find(
      (k) => k.querySelector(".lbl")?.textContent === "Cost · today",
    );
    expect(costTile?.querySelector(".v")?.getAttribute("data-metric")).toBe("cost");
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

  it("does not invent v2 history from aggregate telemetry", async () => {
    await loaded();
    for (const id of ["tCrewState", "tFlow", "tCycleControl", "tQualityTrend", "tCostMerged"]) {
      expect(panel(id).textContent).toContain("data is not available for the last 6h yet.");
    }
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
  const css = readStyles();
  expect(css.match(/\.toolbar \{([^}]*)\}/)?.[1]).toContain("flex-wrap: wrap");
  expect(css.match(/\.tw \{([^}]*)\}/)?.[1]).toContain("overflow-x: auto");
  expect(readStyle("telemetry/telemetry.css")).toMatch(
    /@media \(max-width: 999px\) \{[^}]*\.tgrid \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
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
