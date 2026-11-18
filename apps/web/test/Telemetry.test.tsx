import {
  type ConfigView,
  LIVE_MINUTES,
  TELEMETRY_POINTS,
  type Telemetry as TelemetryData,
  type TestLockState,
} from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCES } from "../src/data.ts";
import { narrowDay } from "../src/fmt.ts";
import { Telemetry } from "../src/pages/Telemetry.tsx";
import { type TelemetryTab, type TelemetryView, telemetryPath } from "../src/router.ts";
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

function stub(data: TelemetryData = tel(), config: ConfigView = CFG, machine?: unknown) {
  return stubFetch({
    ...(machine === undefined ? {} : { "/api/machine": machine }),
    "/api/telemetry?range=1h": data,
    "/api/telemetry?range=6h": data,
    "/api/telemetry?range=24h": data,
    "/api/telemetry?range=7d": data,
    "/api/telemetry?range=24h&agent=studio": data,
    "/api/telemetry?range=24h&account=codex-main": data,
    "/api/telemetry?range=24h&agent=studio&account=codex-main": data,
    "/api/config": config,
    "/api/metrics": METRICS_VIEW,
  });
}

const panel = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

/** Open the page on a tab, as a deep link does. */
function open(tab: TelemetryTab, view: TelemetryView = "charts") {
  window.history.replaceState(null, "", telemetryPath(tab, view));
}

/** Render the page on a tab and wait until the tab's telemetry has loaded. */
async function show(tab: TelemetryTab, view: TelemetryView = "charts") {
  open(tab, view);
  const view_ = render(<Telemetry />);
  await settled();
  return view_;
}

/** The tab's telemetry has answered: the tab panel is no longer busy. */
const settled = () =>
  waitFor(() =>
    expect(document.getElementById("telemetry-tabpanel")?.getAttribute("aria-busy")).toBe("false"),
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  window.history.replaceState(null, "", "/telemetry");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function loaded(
  data?: TelemetryData,
  config?: ConfigView,
  machine?: unknown,
  tab: TelemetryTab = "cost",
  mode: TelemetryView = "charts",
) {
  const fetch = stub(data, config, machine);
  const view = await show(tab, mode);
  return { fetch, ...view };
}

describe("Telemetry refetch", () => {
  it("claims live only while the telemetry on screen is this range's and fresh", async () => {
    const { fetch } = await loaded();
    expect(document.querySelectorAll(".nowc.live").length).toBeGreaterThan(0);
    const answer = fetch.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fetch.mockImplementation(async (...a: unknown[]) => {
      if (a[0] === "/api/telemetry?range=6h") await gate;
      return answer(...a);
    });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "6h" }),
    );
    await waitFor(() => expect(document.querySelectorAll(".nowc.live")).toHaveLength(0));
    await act(async () => release());
    await waitFor(() => expect(document.querySelectorAll(".nowc.live").length).toBeGreaterThan(0));
  });

  it("keeps the last range on screen, dimmed, while a new one loads", async () => {
    const { fetch } = await loaded();
    const answer = fetch.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fetch.mockImplementation(async (...a: unknown[]) => {
      if (a[0] === "/api/telemetry?range=6h") await gate;
      return answer(...a);
    });
    const page = document.getElementById("page-telemetry") as HTMLElement;
    expect(page.classList.contains("refetching")).toBe(false);
    fireEvent.click(
      within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "6h" }),
    );
    await waitFor(() => expect(page.classList.contains("refetching")).toBe(true));
    expect(screen.getByText("61.2k")).toBeTruthy();
    expect(screen.getByRole("tabpanel").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("region", { name: "Cost and tokens summary" }).className).toContain(
      "refetching",
    );
    release();
    await waitFor(() => expect(page.classList.contains("refetching")).toBe(false));
    expect(screen.getByRole("tabpanel").getAttribute("aria-busy")).toBe("false");
    expect(screen.getByText("61.2k")).toBeTruthy();
  });
});

describe("Telemetry toolbar", () => {
  it("names the tab it shows and, on an unbuilt tab, says what is coming over the current panels", async () => {
    await loaded(undefined, undefined, undefined, "machine");
    expect(screen.getByRole("tab", { name: "Machine" }).getAttribute("aria-selected")).toBe("true");
    screen.getByRole("heading", { level: 2, name: "Machine is coming" });
    // the current panels stay under the note, so nothing disappears meanwhile
    for (const id of ["machP", "tMach", "tLock"]) expect(panel(id)).toBeTruthy();
  });

  it("asks for 24h by default and the picked range on a switch", async () => {
    const { fetch } = await loaded();
    expect(fetch).toHaveBeenCalledWith("/api/telemetry?range=24h", expect.anything());
    const range = screen.getByRole("group", { name: "Range" });
    expect(within(range).getByRole("button", { name: "24h" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(within(range).getByRole("button", { name: "6h" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/telemetry?range=6h", expect.anything()),
    );
    expect(within(range).getByRole("button", { name: "6h" }).getAttribute("aria-pressed")).toBe(
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
      expect(fetch).toHaveBeenCalledWith(
        "/api/telemetry?range=24h&agent=studio",
        expect.anything(),
      ),
    );
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "codex-main" } });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/telemetry?range=24h&agent=studio&account=codex-main",
        expect.anything(),
      ),
    );
  });

  it("choosing All again drops the Agent or Account filter and shows the unscoped numbers", async () => {
    const scoped = tel({ today: { ...tel().today, tokens: 42_100 } });
    stubFetch({
      [RESOURCES.telemetry("24h").path]: tel(),
      [RESOURCES.telemetry("24h", "studio").path]: scoped,
      [RESOURCES.telemetry("24h", "", "codex-main").path]: scoped,
      "/api/config": CFG,
    });
    await show("cost");
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

/** The Quality tab's summary row: label, value and unit of each figure. */
const quality = () =>
  [
    ...within(screen.getByRole("region", { name: "Quality summary" })).getAllByText(/./, {
      selector: ".stat-label",
    }),
  ].map((l) => {
    const stat = l.closest(".stat") as HTMLElement;
    return [
      l.textContent,
      stat.querySelector(".stat-value")?.textContent,
      stat.querySelector(".stat-unit")?.textContent,
    ];
  });

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

  it("Commits per run shows the hub's average on Throughput, and — when no run finished", async () => {
    const stat = (): string | undefined =>
      (
        screen
          .getByText("Commits per run", { selector: ".stat-label" })
          .closest(".stat") as HTMLElement
      ).querySelector(".stat-value")?.textContent ?? undefined;
    const a = await loaded(tel({ quality: Q }), undefined, undefined, "throughput");
    expect(stat()).toBe("2.0");
    a.unmount();
    await loaded(
      tel({ quality: { ...Q, commitsPerRun: null } }),
      undefined,
      undefined,
      "throughput",
    );
    expect(stat()).toBe("—");
  });

  it("a tile with no data source says not tracked yet", async () => {
    stub();
    const { container } = render(<Kpis t={tel()} />);
    // the stub serves no lock history, so that read fails and its tile is not tracked
    await waitFor(() => expect(kpi(container, "Lock wait").value).toBe(NOT_TRACKED));
    for (const label of ["Commits", "Lock wait", "Your response"]) {
      expect(kpi(container, label)).toMatchObject({
        value: NOT_TRACKED,
        title: NOT_TRACKED_TITLE,
        nt: true,
      });
    }
  });

  it("the quality summary reads — for the figures the hub does not send", async () => {
    await loaded(undefined, undefined, undefined, "quality");
    expect(quality().filter(([, v]) => v === "—")).toHaveLength(5);
  });

  it("computed tiles show today's numbers; the others show — with the phase that brings them", async () => {
    stub();
    const { container } = render(<Kpis t={tel()} />);
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
    stub();
    const { container } = render(<Kpis t={tel()} />);
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
    const { container } = render(<Kpis t={undefined} />);
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
    await loaded(data, undefined, undefined, "throughput");
    const svg = within(panel("tMerged")).getByRole("img");
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
    expect(panel("tMerged").querySelector(".tip")?.textContent).toBe("Sat 17 Oct: 4 merged");
  });

  it("cycle time: a row per size, p85 only from five tickets, and the left-out note", async () => {
    await loaded(undefined, undefined, undefined, "throughput");
    const p = panel("tCycleSize");
    screen.getByText("p50 to p85, hours · last 14 days");
    expect(
      [...p.querySelectorAll("li")].map((r) => [
        r.querySelector(".lb")?.textContent,
        r.querySelector(".crew-cell-value")?.textContent,
      ]),
    ).toEqual([
      ["XS · 4 tickets", "p50 6.0 h"],
      ["S · 11 tickets", "35 h–50 h"],
      ["M · 1 ticket", "p50 70 h"],
      ["L · 0 tickets", "no tickets"],
      ["XL · 0 tickets", "no tickets"],
      ["no size · 2 tickets", "p50 72 h"],
    ]);
    expect(p.querySelectorAll(".rng")).toHaveLength(1);
    expect(p.querySelector(".pnote")?.textContent).toContain("7 done tickets left out");
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
      undefined,
      undefined,
      "throughput",
    );
    const rows = [...panel("tCycleSize").querySelectorAll("li")];
    expect(rows[0]?.querySelectorAll(".tr b")).toHaveLength(1);
    expect(rows[1]?.querySelectorAll(".tr b, .tr .rng")).toHaveLength(0);
    expect(panel("tCycleSize").querySelector(".pnote")?.textContent).toContain("0 to 2 hours");
  });

  it("quality: CI green on first push rounded; the rest — with their reasons", async () => {
    await loaded(undefined, undefined, undefined, "quality");
    expect(quality()).toEqual([
      ["CI first push", "94%", "% of merged PRs"],
      ["First-pass review", "—", "% of reviewed PRs"],
      ["Review rounds per PR", "—", "rounds"],
      ["RETRO findings per PR", "—", "findings"],
      ["Human review wait", "—", "min median"],
      ["PRs sent back", "—", "PRs"],
    ]);
  });

  it("quality: review rounds and first-pass rate show the hub's numbers", async () => {
    const a = await loaded(tel({ quality: Q }), undefined, undefined, "quality");
    expect(quality()).toEqual(
      expect.arrayContaining([
        ["Review rounds per PR", "1.5", "rounds"],
        ["RETRO findings per PR", "0.8", "findings"],
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
      undefined,
      undefined,
      "quality",
    );
    expect(quality()).toEqual(
      expect.arrayContaining([
        ["Review rounds per PR", "—", "rounds"],
        ["RETRO findings per PR", "—", "findings"],
      ]),
    );
  });

  it("Your response figures on Crew read — when the hub sends none", async () => {
    await loaded(undefined, undefined, undefined, "crew");
    const summary = within(screen.getByRole("region", { name: "Crew summary" }));
    for (const label of ["Median response", "Slowest 10%", "Runs you stopped"]) {
      const stat = summary.getByText(label).closest(".stat") as HTMLElement;
      expect(within(stat).getByRole("button").textContent).toBe("—");
    }
  });
});

describe("Agents", () => {
  it("tokens per minute: Live is the last 60 minutes, History the range; a series per agent", async () => {
    await loaded();
    const p = panel("tTok");
    within(p).getByText("live · last 60 minutes · top 3 seats and other");
    expect(p.querySelectorAll("path.area")).toHaveLength(3);
    expect([...p.querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "shop-app-ta",
      "studio",
      "codex-ta",
    ]);
    fireEvent.click(within(p).getByRole("button", { name: "History" }));
    within(p).getByText("history · last 24h · top 3 seats and other");
    expect(within(p).getByRole("img").getAttribute("aria-label")).toBe(
      "Tokens per minute, last 24h: shop-app-ta latest 1.2k, peak 1.2k; studio latest 300, peak 300; codex-ta latest 50, peak 50",
    );
  });

  it("the Agent filter limits every agent series to that agent", async () => {
    await loaded();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "studio" } });
    expect(panel("tTok").querySelectorAll("path.area")).toHaveLength(1);
    expect([...panel("tTok").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "studio",
    ]);
    // studio has no totals row in range
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    within(panel("tTotals")).getByText("No usage for this filter in the last 24h.");
  });

  it("the Agent filter on Crew limits time, subagents and the summary to that agent", async () => {
    await loaded(undefined, undefined, undefined, "crew");
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "studio" } });
    expect(panel("tUtil").querySelectorAll("li.row")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect([...panel("tSubs").querySelectorAll("tbody tr")]).toHaveLength(1);
  });

  it("the Account filter limits agents to the account's loops, quota and totals to the account", async () => {
    await loaded();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "codex-main" } });
    expect([...panel("tTok").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual([
      "codex-ta",
    ]);
    expect(panel("tQuotaUsed").querySelectorAll("li.quota-row")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(panel("tQuota").querySelectorAll("path.line")).toHaveLength(1);
    expect([...panel("tQuota").querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual(
      ["codex-main 7d · 41%"],
    );
    expect(panel("tTotals").querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it.each([
    [1, "of 1 agent"],
    [3, "of 3 agents"],
  ])("counts the agents behind a filtered working figure: %s", async (agents, detail) => {
    stub();
    const { container } = render(<Kpis t={tel({ today: { ...tel().today, agents } })} filtered />);
    await screen.findByText("Working · now · filtered");
    expect(kpi(container, "Working · now · filtered").detail).toBe(detail);
  });

  it("where agent time goes: four shares per seat, each on a shape, rounded for display", async () => {
    await loaded(undefined, undefined, undefined, "crew");
    const row = panel("tUtil").querySelector("li.row") as HTMLElement;
    expect(row.querySelector("a")?.textContent).toBe("64% working");
    const bar = row.querySelector(".bar") as HTMLElement;
    expect(bar.getAttribute("aria-label")).toBe(
      "shop-app-ta: Working 64% · Waiting 8% · Parked or stalled 6% · Idle 22%",
    );
    expect(bar.tabIndex).toBe(0);
    expect([...panel("tUtil").querySelectorAll(".readout .nm")].map((x) => x.textContent)).toEqual([
      "Working",
      "Waiting",
      "Parked or stalled",
      "Idle",
      "Unknown",
    ]);
  });

  it("legend names every shape the bar draws, and Unknown differs from Parked", async () => {
    await loaded(
      tel({
        utilisation: [
          { agentId: "shop-app-ta", working: 20, waiting: 10, blocked: 5, idle: 15, unknown: 50 },
        ],
      }),
      undefined,
      undefined,
      "crew",
    );
    const drawn = [...panel("tUtil").querySelectorAll(".bar .share")].map((i) => i.classList[1]);
    expect(drawn).toContain("unknown");
    const legend = [...panel("tUtil").querySelectorAll(".readout .crew-sw")].map(
      (i) => i.classList[2],
    );
    for (const cls of drawn) expect(legend).toContain(cls);
    const shape = (cls: string) =>
      readStyles()
        .match(new RegExp(`\\.share\\.${cls}\\s*\\{([^}]*)\\}`))?.[1]
        ?.trim();
    expect(shape("unknown")).toBeTruthy();
    expect(shape("unknown")).not.toBe(shape("parked"));
  });

  it("tool latency and subagents tables", async () => {
    await loaded(undefined, undefined, undefined, "crew", "table");
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
    await loaded(undefined, undefined, undefined, "cost", "table");
    const p = panel("tQuota");
    expect(p.querySelectorAll("path.line")).toHaveLength(2);
    expect(p.querySelector("line.limit")).not.toBeNull();
    expect([...p.querySelectorAll("text")].map((t) => t.textContent)).toEqual(
      expect.arrayContaining(["0%", "50%", "100%", "-24h", "now"]),
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
    await loaded(undefined, undefined, undefined, "cost", "table");
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
      undefined,
      undefined,
      "cost",
      "table",
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
      undefined,
      undefined,
      "cost",
      "table",
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
      [RESOURCES.telemetry("24h").path]: data,
      [RESOURCES.config.path]: CFG,
      [RESOURCES.metrics().path]: METRICS_VIEW,
      [RESOURCES.limits.path]: [limit5h({ alertAt: 85, stopAt: 95 })],
    });
    open("cost", "table");
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
      [RESOURCES.telemetry("24h").path]: data,
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
    open("cost", "table");
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
    await loaded(data, undefined, undefined, "machine");
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
  });

  it("loop-step spend is not tracked when the hub sends none", async () => {
    await loaded();
    within(panel("tStepBars")).getByText("Spend by step is not tracked yet.");
  });

  describe("machine readout", () => {
    const GIB = 2 ** 30;
    const latest = {
      at: NOW,
      cpuPct: 10,
      cores: 8,
      memUsedBytes: 8 * GIB,
      memTotalBytes: 16 * GIB,
      diskFreeBytes: 40 * GIB,
      diskTotalBytes: 500 * GIB,
      swapUsedBytes: 3.5 * GIB,
      swapTotalBytes: 8 * GIB,
      agents: null,
    };
    const view = (over: Record<string, unknown> = {}) => ({
      latest,
      warning: null,
      maxSeats: 4,
      seats: 1,
      perSessionMax: 2,
      ...over,
    });

    it("normal: swap used of total and disk free, no warning", async () => {
      await loaded(undefined, undefined, view(), "machine");
      const p = panel("tMach");
      await waitFor(() => expect(p.textContent).toContain("Swap 3.5 GB (22% of RAM)"));
      expect(p.textContent).toContain("Disk 40 GB free");
      expect(p.querySelector(".pill")).toBeNull();
    });

    it("constrained: a warn Pill carries the reason", async () => {
      await loaded(undefined, undefined, view({ warning: "swap 21.5 of 22.5 GB used" }), "machine");
      const pill = await waitFor(() => {
        const el = panel("tMach").querySelector<HTMLElement>(".pill");
        if (!el) throw new Error("no pill");
        return el;
      });
      expect(pill.className).toContain("warn");
      expect(pill.textContent).toBe("Holding new work");
      expect(pill.title).toBe("swap 21.5 of 22.5 GB used");
    });

    it("missing fields are dashes", async () => {
      await loaded(
        undefined,
        undefined,
        view({
          latest: { ...latest, swapUsedBytes: null, swapTotalBytes: null, diskFreeBytes: null },
        }),
        "machine",
      );
      const p = panel("tMach");
      await waitFor(() => expect(p.textContent).toContain("Swap —"));
      expect(p.textContent).toContain("Disk — GB free");
    });
  });

  it("tokens by ticket and totals", async () => {
    await loaded();
    // ranked by cost; a ticket with no reported cost shows a dash and sorts last
    expect([...panel("tTicketBars").querySelectorAll(".hrow")].map((r) => r.textContent)).toEqual([
      "shop-app #3349~$1.20220k tok",
      "site-builder #12—55.0k tok",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
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
      [RESOURCES.telemetry("24h").path]: tel({
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
    open("cost");
    render(<Telemetry />);
    await settled();
    await within(panel("tTicketBars")).findByText(items[11]?.title as string);
    const rows = panel("tTicketBars").querySelectorAll(".hrow");
    expect(rows).toHaveLength(12);
    await waitFor(() => {
      items.forEach((item, i) => {
        const title = rows[i]?.querySelector(".ticket-bar-title");
        expect(title?.textContent).toBe(item.title);
        expect(title?.previousElementSibling?.className).toBe("rref");
        expect(title?.parentElement?.className).toBe("ticket-label");
      });
    });
    expect(panel("tTicketBars").querySelector("img")).toBeNull();
  });

  it("fetches ticket titles only for configured repos, leaving unknown tickets visible", async () => {
    const item = boardItem({ repoId: "shop-app", issueNumber: 1, title: "Configured ticket" });
    const fetch = stubFetch({
      [RESOURCES.config.path]: { ...CFG, repos: CFG.repos.filter((r) => r.id === "shop-app") },
      [RESOURCES.telemetry("24h").path]: tel({
        tokensByTicket: [
          { ticket: "shop-app#1", tokens: 1000, costUsd: null },
          { ticket: "site-builder#2", tokens: 500, costUsd: null },
          { ticket: "unknown#3", tokens: 100, costUsd: null },
        ],
      }),
      [RESOURCES.boards("shop-app").path]: [item],
    });
    open("cost");
    render(<Telemetry />);
    await settled();
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
      [RESOURCES.telemetry("24h").path]: tel(),
      [RESOURCES.testLock.path]: lock,
      [RESOURCES.crew.path]: { rows: [seatRow({ id: "inco-1", hudState: "stalled" })] },
    });
    open("machine");
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
  it("Crew says nothing ran, instead of empty panels", async () => {
    stub(EMPTY, { ...CFG, loops: [] });
    await show("crew");
    screen.getByText("Nothing ran in the last 24h.");
    expect(document.getElementById("tCrewState")).toBeNull();
    // the band still answers, with — for each figure that has none
    expect(
      within(screen.getByRole("region", { name: "Health band" })).getAllByRole("link").length,
    ).toBeGreaterThan(0);
  });

  it("Crew tables show their empty states", async () => {
    stub(tel({ toolLatency: [], subagents: [] }));
    await show("crew", "table");
    within(panel("tLat")).getByText("No tool calls in the last 24h.");
    within(panel("tSubs")).getByText("No subagents spawned today.");
  });

  it("every panel on Cost and tokens shows its empty state", async () => {
    stub(EMPTY, { ...CFG, loops: [] });
    await show("cost");
    within(panel("tTok")).getByText("No tokens in the last 60 minutes.");
    within(panel("tQuotaUsed")).getByText("No quota readings in the last 24h.");
    within(panel("tTicketBars")).getByText("No ticket work in the last 24h.");
    cleanup();
    await show("cost", "table");
    within(panel("tQuota")).getByText("No quota readings in the last 24h.");
    within(panel("tTotals")).getByText("No usage for this filter in the last 24h.");
    within(panel("tCostTable")).getByText("No ticket work in the last 24h.");
    // the cost tile is the registry's figure, not this page's
    const costTile = [...document.querySelectorAll(".kpi")].find(
      (k) => k.querySelector(".lbl")?.textContent === "Cost · today",
    );
    expect(costTile).toBeUndefined();
  });

  it("every panel on Throughput, Quality and Machine shows its empty state", async () => {
    stub(EMPTY, { ...CFG, loops: [] });
    await show("throughput");
    await within(panel("tMerged")).findByText("No days to show yet.");
    within(panel("tCycleSize")).getByText("No tickets finished in the last 14 days.");
    cleanup();
    await show("quality");
    expect(quality()[0]).toEqual(["CI first push", "—", "% of merged PRs"]);
    expect(document.getElementById("qCi")?.textContent).toContain(
      "Daily quality is not collected for this window.",
    );
    cleanup();
    await show("machine");
    within(panel("tMach")).getByText("No machine samples in the last 24h.");
  });

  it("all-zero tokens show the empty state, not a flat chart", async () => {
    stub(
      tel({
        liveMinutes: [{ agentId: "shop-app-ta", points: flat(LIVE_MINUTES, 0) }],
      }),
    );
    await show("cost");
    await within(panel("tTok")).findByText("No tokens in the last 60 minutes.");
  });

  it.each([
    ["crew", ["tCrewState"]],
    ["cost", ["tCostMerged"]],
  ] as const)("does not invent v2 history from aggregate telemetry on %s", async (tab, ids) => {
    await loaded(undefined, undefined, undefined, tab, tab === "cost" ? "table" : "charts");
    for (const id of ids) {
      expect(panel(id).textContent).toContain("data is not available for the last 24h yet.");
    }
  });

  it("a failed fetch says so, on Crew and Cost and tokens and on a tab not built yet", async () => {
    stubFetch({ "/api/config": CFG });
    await show("crew");
    screen.getByText("Telemetry did not load.");
    screen.getByRole("button", { name: "Try again" });
    cleanup();
    await show("cost");
    await screen.findByText("Telemetry did not load.");
    cleanup();
    await show("machine");
    await screen.findByText(/^Could not load telemetry:/);
  });
});

describe("engine telemetry", () => {
  const ENGINE = () =>
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
    });
  /** The figure on the stat tile with this label, in the band or the summary row. */
  const statValue = (label: string): string | null =>
    (
      screen.getByText(label, { selector: ".stat-label" }).closest(".stat") as HTMLElement
    ).querySelector(".stat-value")?.textContent ?? null;

  it("shows seeded review figures and the human wait on Quality", async () => {
    await loaded(ENGINE(), undefined, undefined, "quality");
    expect(quality()).toEqual(
      expect.arrayContaining([
        ["RETRO findings per PR", "0.8", "findings"],
        ["PRs sent back", "2", "PRs"],
        ["Human review wait", "2", "min median"],
      ]),
    );
    expect(quality()).toContainEqual(["First-pass review", "50%", "% of reviewed PRs"]);
  });

  it("shows commits on Throughput and loop-step spend on Cost", async () => {
    const a = await loaded(ENGINE(), undefined, undefined, "throughput");
    expect(statValue("Commits per run")).toBe("2.0");
    a.unmount();
    await loaded(ENGINE());
    expect([...panel("tStepBars").querySelectorAll(".hrow")].map((x) => x.textContent)).toEqual([
      "plan~$0.501.0k · 3 runs",
      "build~$0.501.0k · 3 runs",
      "review~$0.501.0k · 3 runs",
    ]);
  });

  it("shows CAPCOM figures in the band and the Crew summary, with the longest wait", async () => {
    await loaded(ENGINE(), undefined, undefined, "crew");
    expect(statValue("Your response")).toBe("4m 00s");
    expect(statValue("Median response")).toBe("4.0");
    expect(statValue("Slowest 10%")).toBe("22.0");
    expect(statValue("Runs you stopped")).toBe("2");
    within(panel("tUtil")).getByText(
      "Longest wait today: INCO-1's question, 38m 00s. Agent time spent waiting on you today: 1h 12m.",
    );
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
            : args[0] === "/api/crew?shape=summary"
              ? { rows: [{ id: "inco-1", hudState: state }] }
              : null;
      return data ? new Response(JSON.stringify(data)) : answer(...args);
    });
    open("machine");
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
    expect(kpi(container, "Lock wait")).toMatchObject({ value: "1:00", detail: "today · 1 run" });
    expect(panel("tMach").querySelectorAll("rect.band")).toHaveLength(2);
    // Lock holds shade the chart; their names stay in the tooltip so the 100% line has no text pile.
    const chartText = [...panel("tMach").querySelectorAll("svg text")].map((t) => t.textContent);
    expect(chartText.filter((t) => t?.includes("suite"))).toEqual([]);
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
      [RESOURCES.telemetry("24h").path]: tel(),
      [RESOURCES.telemetry("24h", "", "", "mission-control#398").path]: EMPTY,
    });
    open("cost", "table");
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
    await within(panel("tTotals")).findByText("No usage for this filter in the last 24h.");
    expect(select.value).toBe("mission-control#398");
  });

  it("selects each ticket, combines and clears filters using response bars and totals", async () => {
    const data = tel();
    const routes: Record<string, unknown> = {
      [RESOURCES.config.path]: CFG,
      "/api/telemetry?range=24h": data,
    };
    for (const row of data.tokensByTicket) {
      routes[`/api/telemetry?range=24h&ticket=${encodeURIComponent(row.ticket)}`] = tel({
        tokensByTicket: [{ ...row, tokens: 123 }],
        totals: [{ ...(data.totals[0] as TelemetryData["totals"][number]), input: 321 }],
      });
    }
    routes["/api/telemetry?range=24h&agent=studio"] = data;
    routes["/api/telemetry?range=24h&agent=studio&ticket=site-builder%2312"] = EMPTY;
    routes["/api/telemetry?range=24h&agent=studio&account=codex-main"] = data;
    routes["/api/telemetry?range=24h&agent=studio&account=codex-main&ticket=site-builder%2312"] =
      EMPTY;
    const fetch = stubFetch(routes);
    open("cost");
    render(<Telemetry />);
    const select = await screen.findByLabelText("Ticket");
    await waitFor(() => expect((select as HTMLSelectElement).options).toHaveLength(3));
    select.focus();
    expect(document.activeElement).toBe(select);
    for (const row of data.tokensByTicket) {
      fireEvent.change(select, { target: { value: row.ticket } });
      await within(panel("tTicketBars")).findByText("123 tok");
      expect(panel("tTicketBars").querySelectorAll(".hrow")).toHaveLength(1);
    }
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    await within(panel("tTotals")).findByText("321");
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "studio" } });
    await within(panel("tTotals")).findByText("No usage for this filter in the last 24h.");
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "codex-main" } });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/telemetry?range=24h&agent=studio&account=codex-main&ticket=site-builder%2312",
        expect.anything(),
      ),
    );
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Charts" }));
    await within(panel("tTicketBars")).findByText("220k tok");
  });

  it("resets a ticket absent from a new range", async () => {
    stubFetch({
      [RESOURCES.config.path]: CFG,
      "/api/telemetry?range=24h": tel(),
      "/api/telemetry?range=24h&ticket=shop-app%233349": tel(),
      "/api/telemetry?range=1h": EMPTY,
      "/api/telemetry?range=1h&ticket=shop-app%233349": EMPTY,
    });
    open("cost");
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
  await loaded(undefined, undefined, undefined, "cost", "table");
  const css = readStyles();
  expect(css.match(/\.toolbar \{([^}]*)\}/)?.[1]).toContain("flex-wrap: wrap");
  expect(css.match(/\.tw \{([^}]*)\}/)?.[1]).toContain("overflow-x: auto");
  expect(readStyle("telemetry/telemetry.css")).toMatch(
    /@media \(max-width: 999px\) \{[^}]*\.tgrid \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
  );
  expect(panel("tTotals").querySelector("table")?.parentElement?.classList.contains("tw")).toBe(
    true,
  );
  cleanup();
  await loaded(undefined, undefined, undefined, "crew", "table");
  expect(panel("tLat").querySelector("table")?.parentElement?.classList.contains("tw")).toBe(true);
});

it("preserves unknown time on Crew and unavailable line and slowest details", async () => {
  const data = tel();
  const unknown = tel({
    utilisation: [
      { agentId: "shop-app-ta", working: 20, waiting: 10, blocked: 5, idle: 15, unknown: 50 },
    ],
    toolLatency: [
      {
        ...(data.toolLatency[0] as TelemetryData["toolLatency"][number]),
        slowest: { detail: null, agentId: "studio", durationMs: 1000 },
      },
    ],
  });
  await loaded(unknown, undefined, undefined, "crew");
  expect(panel("tUtil").querySelector(".bar")?.getAttribute("aria-label")).toContain("Unknown 50%");
  cleanup();
  await loaded(unknown, undefined, undefined, "crew", "table");
  within(panel("tLat")).getByText("— (1.0s, studio)");
  cleanup();
  await loaded(
    tel({
      totals: [
        { ...(data.totals[0] as TelemetryData["totals"][number]), additions: 0, deletions: null },
      ],
    }),
    undefined,
    undefined,
    "cost",
    "table",
  );
  within(panel("tTotals")).getByText("+0");
  expect(panel("tTotals").querySelector(".del")?.textContent).toBe("—");
});

describe("Cost and tokens tab", () => {
  const tile = (label: string) =>
    within(screen.getByRole("region", { name: "Cost and tokens summary" }))
      .getByText(label, { selector: ".stat-label" })
      .closest(".stat") as HTMLElement;
  const value = (label: string) => within(tile(label)).getByRole("button").textContent;
  const link = (label: string) => within(tile(label)).getByRole("link").textContent;

  it("shows the six summary figures, each with its unit and window", async () => {
    await loaded(
      tel({
        tokensByTicket: [
          { ticket: "shop-app#1", tokens: 1, costUsd: 1, totalCostUsd: 10 },
          { ticket: "shop-app#2", tokens: 1, costUsd: 1, totalCostUsd: 20 },
        ],
      }),
    );
    const summary = screen.getByRole("region", { name: "Cost and tokens summary" });
    expect([...summary.querySelectorAll(".stat-label")].map((l) => l.textContent)).toEqual([
      "~Cost",
      "Tokens",
      "Cache hit",
      "~Cost per merged ticket",
      "Cost coverage",
      "Tokens coverage",
    ]);
    expect(value("~Cost")).toBe("~$3.50");
    expect(value("Tokens")).toBe("61.2k");
    // 1.25M cache read of 1.31M input
    expect(value("Cache hit")).toBe("95");
    expect(link("~Cost per merged ticket")).toBe("~$15.00");
    // one of the two usage rows reported no cost; both reported tokens
    expect(value("Cost coverage")).toBe("50");
    expect(value("Tokens coverage")).toBe("100");
    expect(within(tile("Tokens")).getByText("in + out"));
    expect(within(tile("Cost coverage")).getByText("% of usage rows"));
  });

  it("a figure nobody reported is a dash, never zero, and coverage says what is missing", async () => {
    await loaded(tel({ today: { ...tel().today, costUsd: null, tokens: 0, cacheRead: 0 } }));
    expect(value("~Cost")).toBe("—");
    expect(value("Cache hit")).toBe("—");
    expect(link("~Cost per merged ticket")).toBe("—");
    const cover = tile("Cost coverage").querySelector(".stat-cmp")?.textContent ?? "";
    expect(cover).toContain("codex-ta");
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    within(panel("tTotals")).getByText(/No cost reported for codex-ta; not counted as \$0\./);
  });

  it("shows the complete missing-cost explanation on keyboard focus", async () => {
    const totals = tel().totals;
    await loaded(
      tel({
        totals: [
          ...totals,
          { ...totals[0], model: "model-a", costUsd: null },
          { ...totals[0], model: "model-b", costUsd: null },
        ],
      }),
    );
    const coverage = tile("Cost coverage");
    fireEvent.focus(within(coverage).getByRole("button"));
    const tip = within(coverage).getByRole("tooltip").textContent ?? "";
    expect(tip).toContain("not counted as $0.");
    expect(tip).toContain("model-a");
  });

  it("scales spend bars by reported cost, not token volume", async () => {
    await loaded(
      tel({
        tokensByStep: [
          { step: "plan", tokens: 1_000, costUsd: 10, runs: 1 },
          { step: "build", tokens: 100, costUsd: 60, runs: 1 },
          { step: "review", tokens: 10_000, costUsd: null, runs: 1 },
        ],
      }),
    );
    const rows = panel("tStepBars").querySelectorAll(".hrow");
    expect(rows).toHaveLength(3);
    expect(
      [...rows].map((row) => (row.querySelector(".track i") as HTMLElement).style.width),
    ).toEqual(["16.666666666666664%", "100%", "0%"]);
  });

  it.each([
    ["Agent", "studio", ["tStepBars"]],
    ["Account", "codex-main", ["tStepBars"]],
    ["Ticket", "shop-app#3349", ["tStepBars", "tTok"]],
  ])("marks crew-wide charts when the %s filter is active", async (label, choice, ids) => {
    await loaded();
    expect(screen.queryByText("Whole crew, not filtered")).toBeNull();
    fireEvent.change(screen.getByLabelText(label), { target: { value: choice } });
    await waitFor(() => {
      for (const id of ids)
        expect(panel(id).querySelector(".sub")?.textContent).toContain("Whole crew, not filtered");
    });
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    await waitFor(() =>
      expect(panel("tStepTable").querySelector(".sub")?.textContent).toContain(
        "Whole crew, not filtered",
      ),
    );
  });

  it("stacks tokens per minute as the top three seats and Other, summing to the total", async () => {
    const more = ["a", "b", "c", "d"].map((id, i) => ({
      agentId: id,
      points: flat(LIVE_MINUTES, 10 * (i + 1)),
    }));
    const data = tel({ liveMinutes: [...tel().liveMinutes, ...more] });
    stub(data, {
      ...CFG,
      loops: [
        ...CFG.loops,
        ...["a", "b", "c", "d"].map((id) => ({ ...LOOP, id, accountId: "claude-main" })),
      ],
    });
    await show("cost");
    const p = panel("tTok");
    expect([...p.querySelectorAll(".legend span")].map((x) => x.textContent)).toEqual([
      "shop-app-ta",
      "studio",
      "d",
      "Other",
    ]);
    expect(p.querySelectorAll("path.area")).toHaveLength(4);
    // the layers' latest values (900, 150, 40, and Other 20 + 10 + 20 + 30) add up to the seats' 1170
    const label = within(p).getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toContain("shop-app-ta latest 900");
    expect(label).toContain("d latest 40");
    expect(label).toContain("Other latest 80");
  });

  it("draws a meter per account window with the alert and stop ticks and a 24 h line", async () => {
    stubFetch({
      [RESOURCES.telemetry("24h").path]: tel(),
      [RESOURCES.config.path]: CFG,
      [RESOURCES.limits.path]: [limit5h({ used: 85, alertAt: 80, stopAt: 95 })],
    });
    await show("cost");
    const rows = panel("tQuotaUsed").querySelectorAll("li.quota-row");
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    expect(first.dataset.level).toBe("alert");
    expect(first.querySelectorAll(".tick")).toHaveLength(2);
    expect(first.querySelector(".tick.stop")).not.toBeNull();
    expect(first.querySelector("[role=img]")?.getAttribute("aria-label")).toBe(
      "claude-main 5h: 85% used; alert at 80%, stop at 95%",
    );
    expect(first.querySelector(".hist path")).not.toBeNull();
  });

  it("each toolbar filter reaches the request", async () => {
    const fetch = stub();
    await show("cost");
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "studio" } });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/telemetry?range=24h&agent=studio",
        expect.anything(),
      ),
    );
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "codex-main" } });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/telemetry?range=24h&agent=studio&account=codex-main",
        expect.anything(),
      ),
    );
    screen.getByLabelText("Ticket");
  });

  it("gives each ticket row its full title on focus, and ranks by cost", async () => {
    const item = boardItem({ repoId: "shop-app", issueNumber: 3349, title: "Quote cache warmup" });
    stubFetch({
      [RESOURCES.config.path]: CFG,
      [RESOURCES.telemetry("24h").path]: tel(),
      [RESOURCES.boards("shop-app").path]: [item],
    });
    await show("cost");
    await within(panel("tTicketBars")).findByText("Quote cache warmup");
    const label = panel("tTicketBars").querySelector(".ticket-label") as HTMLElement;
    expect(label.tabIndex).toBe(0);
    expect(label.dataset.tip).toBe("shop-app#3349 · Quote cache warmup");
    fireEvent.focus(label);
    expect(document.body.querySelector("[data-ticket-title-tooltip]")?.textContent).toBe(
      "shop-app#3349 · Quote cache warmup",
    );
  });
});
