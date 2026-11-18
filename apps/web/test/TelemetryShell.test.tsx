import { type ConfigView, METRICS, type Telemetry as TelemetryData } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamStatus } from "../src/data.ts";
import { Telemetry } from "../src/pages/Telemetry.tsx";
import { TELEMETRY_TABS } from "../src/router.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, crewRow, HOUR, item, METRICS_VIEW, MIN, NOW } from "./fixtures.ts";
import { readStyle } from "./styles.ts";

const LOOP = CONFIG.loops[0] as ConfigView["loops"][number];
const CFG: ConfigView = {
  ...CONFIG,
  loops: [LOOP, { ...LOOP, id: "studio", repoId: "site-builder", kind: "studio-loop" }],
};

function tel(over: Partial<TelemetryData> = {}): TelemetryData {
  return {
    today: {
      tokens: 61_234,
      cacheRead: 0,
      costUsd: 3.5,
      toolCalls: 12_400,
      turns: 64,
      working: 2,
      agents: 2,
    },
    throughput: Array.from({ length: 14 }, (_, i) => ({
      day: `2026-10-${String(4 + i).padStart(2, "0")}`,
      merged: i === 13 ? 7 : 3,
    })),
    cycleTime: { rows: [], excluded: 0 },
    quality: {
      ciGreenFirstPushPct: 88,
      prs: 16,
      firstPassReviewPct: 70,
      reviewedPrs: 10,
    },
    capcom: {
      answered: 14,
      medianMs: 260_000,
      p90Ms: 19 * MIN,
      stopped: 2,
      longest: null,
      agentWaitMs: 0,
    },
    tokensPerMinute: [],
    liveMinutes: [],
    utilisation: [
      { agentId: "shop-app-ta", working: 60, waiting: 10, blocked: 5, idle: 25 },
      { agentId: "studio", working: 30, waiting: 0, idle: 70 },
    ],
    turnUsage: [],
    toolLatency: [{ tool: "Bash", calls: 5, p50Ms: 100, p95Ms: 900, failed: 1 }],
    subagents: [],
    quota: [],
    machine: [],
    tokensByTicket: [],
    totals: [
      {
        agentId: "shop-app-ta",
        accountId: "claude-main",
        model: null,
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheHitPct: null,
        turns: 1,
        toolCalls: 1,
        costUsd: 70,
      },
    ],
    series: {
      stateSpans: [
        {
          agentId: "shop-app-ta",
          state: "running",
          startedAt: NOW - 20 * HOUR,
          endedAt: NOW - 10 * HOUR,
        },
        { agentId: "shop-app-ta", state: "waiting", startedAt: NOW - 10 * HOUR, endedAt: NOW },
        { agentId: "studio", state: "idle", startedAt: NOW - 24 * HOUR, endedAt: NOW },
      ],
      quota: [
        {
          accountId: "claude-main",
          window: "7d",
          alertAt: 80,
          stopAt: 95,
          points: [{ at: NOW - HOUR, pct: 78 }],
          resets: [{ at: NOW - 5 * HOUR, resetAt: NOW + 52 * HOUR, cause: "provider" }],
        },
      ],
      tickets: [],
      annotations: [],
    },
    ...over,
  };
}

const MACHINE = {
  latest: {
    at: NOW,
    cpuPct: 41,
    cores: 8,
    memUsedBytes: 4,
    memTotalBytes: 10,
    memoryPressureFreePct: 62,
    diskFreeBytes: null,
    diskTotalBytes: null,
    agents: null,
  },
  warning: null,
  maxSeats: 4,
  seats: 2,
  perSessionMax: 2,
  transcripts: null,
};

function stub(
  data: TelemetryData = tel(),
  machine: unknown = MACHINE,
  attention: unknown[] = [item()],
) {
  const routes: Record<string, unknown> = {
    "/api/config": CFG,
    "/api/machine": machine,
    "/api/metrics": METRICS_VIEW,
    "/api/attention": attention,
  };
  for (const r of ["1h", "6h", "24h", "7d"]) routes[`/api/telemetry?range=${r}`] = data;
  routes["/api/telemetry?range=24h&agent=studio"] = data;
  routes["/api/crew?shape=summary"] = {
    rows: [
      crewRow({ id: "shop-app-ta", hudState: "running" }),
      crewRow({ id: "studio", hudState: "waiting" }),
    ],
    firstRunToday: null,
  };
  return stubFetch(routes);
}

async function open(search = "", data?: TelemetryData) {
  window.history.replaceState(null, "", `/telemetry${search}`);
  const fetch = stub(data);
  const view = render(<Telemetry />);
  await waitFor(() =>
    expect(document.getElementById("telemetry-tabpanel")?.getAttribute("aria-busy")).toBe("false"),
  );
  return { fetch, ...view };
}

const stat = (label: string) =>
  screen.getByText(label, { selector: ".stat-label" }).closest(".stat") as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  streamStatus.set({ connected: false, reconnecting: false, lastMessageAt: null });
});

describe("the health band", () => {
  it("shows the eight figures, each with its unit and window", async () => {
    await open();
    const tiles = [...document.querySelectorAll(".band .stat")].map((s) => ({
      label: s.querySelector(".stat-label")?.textContent,
      value: s.querySelector(".stat-value")?.textContent,
      unit: s.querySelector(".stat-unit")?.textContent,
      window: s.querySelector(".stat-window")?.textContent,
    }));
    expect(tiles).toEqual([
      { label: "Crew health", value: "Watch", unit: "verdict", window: "now" },
      { label: "Your response", value: "4m 20s", unit: "median", window: "today" },
      { label: "~Cost", value: "~$24.31", unit: "USD", window: METRICS.cost.window },
      { label: "Merged", value: "6", unit: "PRs", window: METRICS.merged.window },
      { label: "CI first push", value: "88%", unit: "% of merged PRs", window: "14d" },
      { label: "First-pass review", value: "70%", unit: "% of reviewed PRs", window: "14d" },
      { label: "Tightest quota", value: "78%", unit: "% used", window: "now" },
      { label: "Machine", value: "62%", unit: "% memory free", window: "now" },
    ]);
  });

  it("explains the verdict, the cost and merged comparisons and the quota's reset", async () => {
    await open();
    expect(stat("Crew health").querySelector(".stat-sub")?.textContent).toBe(
      "now · 1 of 2 running · 1 question waiting",
    );
    // 7-day total $70 over 7 days
    expect(stat("~Cost").querySelector(".stat-sub")?.textContent).toBe(
      "today · vs ~$10.00 7-day average",
    );
    // (13 × 3 + 7) / 14
    expect(stat("Merged").querySelector(".stat-sub")?.textContent).toBe("24h · vs 3.3 14-day mean");
    expect(stat("Tightest quota").querySelector(".stat-sub")?.textContent).toBe(
      "now · claude-main · 7d · resets in 2d 4h",
    );
    expect(stat("Machine").querySelector(".stat-sub")?.textContent).toBe(
      "now · CPU 41% · no warning",
    );
  });

  it("marks a verdict with a shape beside its colour", async () => {
    await open();
    expect(stat("Crew health").className).toContain("v-watch");
    expect(readStyle("telemetry/telemetry.css")).toMatch(
      /\.stat\.v-watch \.stat-value::before \{\s*content: "◆ "/,
    );
    expect(readStyle("telemetry/telemetry.css")).toMatch(
      /\.stat\.v-attention \.stat-value::before \{\s*content: "▲ "/,
    );
  });

  it("gives every number a definition on hover and focus, and a name that says where it goes", async () => {
    await open();
    const tiles = [...document.querySelectorAll(".band .stat")];
    expect(tiles).toHaveLength(8);
    for (const tile of tiles) {
      const value = tile.querySelector(".stat-value") as HTMLElement;
      const def = tile.querySelector(".stat-def") as HTMLElement;
      expect(def.getAttribute("role")).toBe("tooltip");
      expect(def.textContent?.length).toBeGreaterThan(20);
      expect(value.getAttribute("aria-describedby")).toBe(def.id);
      expect(value.getAttribute("aria-label")).toMatch(/\. (Opens|Needs a new route:) /);
    }
    const css = readStyle("telemetry/telemetry.css");
    expect(css).toMatch(
      /\.stat:hover \.stat-def,\s*\.stat:focus-within \.stat-def \{\s*display: block/,
    );
  });

  it("opens a page that exists, and 'Runs behind this number' where no route exists", async () => {
    await open();
    const link = within(stat("Merged")).getByRole("link");
    expect(link.getAttribute("href")).toBe("/board");
    const needs = within(stat("Your response")).getByRole("button");
    fireEvent.click(needs);
    const dialog = screen.getByRole("dialog", { name: "Runs behind this number" });
    within(dialog).getByText(/Needs a new route/);
    within(dialog).getByText(/the runs for each answered question/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reads — for a figure the hub has not sent, and Needs attention at a stop level", async () => {
    const stopped = tel({
      series: {
        ...(tel().series as NonNullable<TelemetryData["series"]>),
        quota: [
          {
            accountId: "claude-main",
            window: "5h",
            alertAt: 80,
            stopAt: 95,
            points: [{ at: NOW - MIN, pct: 97 }],
            resets: [],
          },
        ],
      },
      capcom: undefined,
    });
    await open("", stopped);
    expect(within(stat("Crew health")).getByRole("link").textContent).toBe("Needs attention");
    expect(stat("Crew health").className).toContain("v-attention");
    expect(within(stat("Your response")).getByRole("button").textContent).toBe("—");
  });
});

describe("questions waiting on you", () => {
  async function openWith(attention: unknown[]) {
    window.history.replaceState(null, "", "/telemetry");
    stub(tel(), MACHINE, attention);
    render(<Telemetry />);
    await waitFor(() =>
      expect(document.getElementById("telemetry-tabpanel")?.getAttribute("aria-busy")).toBe(
        "false",
      ),
    );
    // the verdict waits for the Needs you data
    await waitFor(() =>
      expect(stat("Crew health").querySelector(".stat-value")?.textContent).not.toBe("—"),
    );
  }
  const waitingOnYou = () =>
    screen
      .getByText("Waiting on you", { selector: ".stat-label" })
      .closest(".stat")
      ?.querySelector(".stat-value")?.textContent;

  it("does not count a seat queued for the test lock: no questions reads 0 and Healthy", async () => {
    // studio is at hudState "waiting" in the stub, which is a lock queue, not a question
    await openWith([]);
    expect(waitingOnYou()).toBe("0");
    expect(stat("Crew health").querySelector(".stat-value")?.textContent).toBe("Healthy");
  });

  it("counts open questions, not the hub's alerts, and turns the verdict to Watch", async () => {
    await openWith([
      item({ key: "a" }),
      item({ key: "b" }),
      item({ key: "c", alert: true, kind: "decision" }),
    ]);
    expect(waitingOnYou()).toBe("2");
    expect(stat("Crew health").querySelector(".stat-value")?.textContent).toBe("Watch");
    expect(stat("Crew health").querySelector(".stat-sub")?.textContent).toContain(
      "2 questions waiting",
    );
  });
});

describe("the tabs", () => {
  it.each([
    ["", "crew"],
    ["?tab=crew", "crew"],
    ["?tab=cost", "cost"],
    ["?tab=throughput", "throughput"],
    ["?tab=quality", "quality"],
    ["?tab=machine", "machine"],
    ["?tab=nonsense", "crew"],
  ])("a deep link %s opens the %s tab", async (search, tab) => {
    await open(search);
    const selected = screen
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected.map((t) => t.id)).toEqual([`telemetry-tab-${tab}`]);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      `telemetry-tab-${tab}`,
    );
  });

  it("lists the five tabs in order", async () => {
    await open();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Crew",
      "Cost and tokens",
      "Throughput",
      "Quality",
      "Machine",
    ]);
    expect(TELEMETRY_TABS).toHaveLength(5);
  });

  it("writes the tab into the URL when one is clicked, and keeps the view", async () => {
    await open("?view=table");
    fireEvent.click(screen.getByRole("tab", { name: "Quality" }));
    expect(window.location.search).toBe("?tab=quality&view=table");
    fireEvent.click(screen.getByRole("tab", { name: "Crew" }));
    expect(window.location.search).toBe("?view=table");
  });

  it("moves between tabs with the arrow keys, Home and End, and opens the one it lands on", async () => {
    await open();
    const tab = (name: string) => screen.getByRole("tab", { name });
    tab("Crew").focus();
    fireEvent.keyDown(tab("Crew"), { key: "ArrowRight" });
    expect(window.location.search).toBe("?tab=cost");
    expect(document.activeElement).toBe(tab("Cost and tokens"));
    expect(tab("Cost and tokens").tabIndex).toBe(0);
    expect(tab("Crew").tabIndex).toBe(-1);
    fireEvent.keyDown(tab("Cost and tokens"), { key: "End" });
    expect(document.activeElement).toBe(tab("Machine"));
    fireEvent.keyDown(tab("Machine"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Crew"));
    fireEvent.keyDown(tab("Crew"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Machine"));
    fireEvent.keyDown(tab("Machine"), { key: "Home" });
    expect(document.activeElement).toBe(tab("Crew"));
    expect(window.location.search).toBe("");
  });

  it("hides the Range buttons on the fixed 14-day tabs", async () => {
    await open();
    expect(screen.getByRole("group", { name: "Range" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Throughput" }));
    expect(screen.queryByRole("group", { name: "Range" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Quality" }));
    expect(screen.queryByRole("group", { name: "Range" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Machine" }));
    expect(screen.getByRole("group", { name: "Range" })).toBeTruthy();
  });

  it("shows a short coming note, never an empty chart, on each tab not built yet", async () => {
    for (const [tab, name] of [
      ["cost", "Cost and tokens is coming"],
      ["machine", "Machine is coming"],
    ] as const) {
      await open(`?tab=${tab}`);
      screen.getByRole("heading", { level: 2, name });
      cleanup();
    }
  });

  it("keeps each earlier panel on the tab that will take it", async () => {
    const expected: Record<string, string[]> = {
      cost: ["tTok", "tQuota", "tTicketBars", "tStepBars", "tTotals", "tCostMerged"],
      // built: its panels are the Quality tab's own, and the earlier two are gone
      quality: [],
      machine: ["tMach", "tLock"],
    };
    const all = [...Object.values(expected).flat(), "tQual", "tQualityTrend"];
    for (const [tab, ids] of Object.entries(expected)) {
      await open(`?tab=${tab}`);
      for (const id of all)
        expect(document.getElementById(id) !== null, `${tab}: ${id}`).toBe(ids.includes(id));
      // moved to the Crew tab, or to the seat's Agent page
      for (const id of [
        "tCrewState",
        "tUtil",
        "tLat",
        "tSubs",
        "tCapcom",
        "tTurn",
        // moved to the Throughput tab, which draws its own (the forecast is dropped)
        "tThru",
        "tCycle",
        "tFlow",
        "tCycleControl",
        "tForecast",
      ])
        expect(document.getElementById(id), `${tab}: ${id}`).toBeNull();
      cleanup();
    }
  });
});

describe("the Charts and Table switch", () => {
  it("shows lanes and agent time as charts and tool latency and subagents as tables", async () => {
    await open();
    expect(document.getElementById("tCrewState")).toBeTruthy();
    expect(document.getElementById("tUtil")).toBeTruthy();
    expect(document.getElementById("tLat")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(window.location.search).toBe("?view=table");
    expect(document.getElementById("tLat")).toBeTruthy();
    expect(document.getElementById("tSubs")).toBeTruthy();
    expect(document.getElementById("tCrewState")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Charts" }));
    expect(window.location.search).toBe("");
  });

  it("opens in the table view from a deep link", async () => {
    await open("?view=table");
    expect(screen.getByRole("button", { name: "Table" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("tLat")).toBeTruthy();
  });
});

describe("the Crew tab", () => {
  it("draws a lane per seat, each state with its own shape, and counts the seats in each state", async () => {
    await open();
    const lanes = [...document.querySelectorAll("#tCrewState .lane")];
    // the last recorded spans (waiting, idle) ended earlier; the live rows say running, waiting
    expect(lanes.map((l) => l.textContent)).toEqual([
      "shop-app-tanow running",
      "studionow waiting",
    ]);
    const spans = [...(lanes[0] as Element).querySelectorAll(".span")].map((s) => s.className);
    expect(spans).toEqual(["span running", "span waiting"]);
    const first = (lanes[0] as Element).querySelector(".span") as HTMLElement;
    // 10 h of the last 24 h starting 4 h in
    expect(Number.parseFloat(first.style.left)).toBeCloseTo((4 / 24) * 100, 1);
    expect(Number.parseFloat(first.style.width)).toBeCloseTo((10 / 24) * 100, 1);
    expect(
      [...document.querySelectorAll("#tCrewState .readout li")].map(
        (li) => `${li.querySelector(".nm")?.textContent} ${li.querySelector("a")?.textContent}`,
      ),
    ).toEqual(["Running 1 now", "Waiting 1 now", "Parked 0 now", "Idle 0 now"]);
    const css = readStyle("telemetry/telemetry.css");
    for (const state of ["running", "waiting", "parked", "idle"])
      expect(css).toContain(`.span.${state}`);
  });

  it("carries today's Your response figures and the tool calls in its summary row", async () => {
    await open();
    const summary = within(screen.getByRole("region", { name: "Crew summary" }));
    const read = (label: string) =>
      (
        summary.getByText(label, { selector: ".stat-label" }).closest(".stat") as HTMLElement
      ).querySelector(".stat-value")?.textContent;
    expect(read("Seats running")).toBe("1 of 2");
    // one open question on the Needs you list; the seat queued for the test lock is not one
    expect(read("Waiting on you")).toBe("1");
    expect(read("Median response")).toBe("4.3");
    expect(read("Slowest 10%")).toBe("19.0");
    expect(read("Runs you stopped")).toBe("2");
    expect(read("Tool calls")).toBe("12.4k");
  });

  it("filters by agent, asking the hub for that agent", async () => {
    const { fetch } = await open();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "studio" } });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/telemetry?range=24h&agent=studio",
        expect.anything(),
      ),
    );
    expect(screen.queryByLabelText("Account")).toBeNull();
    expect(screen.queryByLabelText("Ticket")).toBeNull();
  });
});

describe("figures that cannot be opened and figures in the readouts", () => {
  it("blocks click and Enter on a value with no figure, and opens again once one arrives", async () => {
    await open("", tel({ capcom: undefined }));
    const value = within(stat("Your response")).getByRole("button");
    expect(value.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(value);
    fireEvent.keyDown(value, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // a link value is blocked the same way
    const link = within(stat("Merged")).getByRole("link");
    expect(link.getAttribute("aria-disabled")).toBeNull();
    cleanup();
    await open("", tel());
    const ready = within(stat("Your response")).getByRole("button");
    expect(ready.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(ready);
    screen.getByRole("dialog", { name: "Runs behind this number" });
  });

  it("keeps a figure's element, and its focus, when its value arrives", async () => {
    const { fetch } = await open("", tel({ capcom: undefined }));
    const value = within(stat("Your response")).getByRole("button");
    value.focus();
    expect(document.activeElement).toBe(value);
    expect(value.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(
      within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "6h" }),
    );
    expect(fetch).toBeTruthy();
    expect(document.activeElement).toBe(value);
  });

  it("makes every Crew readout value a focusable link with its definition", async () => {
    await open();
    const counts = [...document.querySelectorAll("#tCrewState .readout a")] as HTMLAnchorElement[];
    expect(counts).toHaveLength(4);
    for (const a of counts) {
      expect(a.getAttribute("href")).toBe("/agent");
      expect(a.tabIndex).toBe(0);
      const def = document.getElementById(a.getAttribute("aria-describedby") as string);
      expect(def?.getAttribute("role")).toBe("tooltip");
    }
    const shares = [...document.querySelectorAll("#tUtil li.row a")] as HTMLAnchorElement[];
    expect(shares.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["60% working", "/agent/shop-app-ta"],
      ["30% working", "/agent/studio"],
    ]);
    fireEvent.click(shares[0] as HTMLAnchorElement);
    expect(window.location.pathname).toBe("/agent/shop-app-ta");
    const css = readStyle("telemetry/telemetry.css");
    expect(css).toMatch(
      /\.crew-cell:hover \.crew-cell-def,\s*\.crew-cell:focus-within \.crew-cell-def \{\s*display: block/,
    );
  });
});

describe("seats in a state the lanes do not draw", () => {
  it.each([
    ["stalled", "Stalled"],
    ["blocked", "Blocked"],
    ["error", "Error"],
    ["stopped", "Stopped"],
  ] as const)("shows a %s seat by name and in the totals", async (state, label) => {
    window.history.replaceState(null, "", "/telemetry");
    const fetch = stub();
    const answer = fetch.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    fetch.mockImplementation(async (...a: unknown[]) =>
      a[0] === "/api/crew?shape=summary"
        ? new Response(
            JSON.stringify({
              rows: [
                crewRow({ id: "shop-app-ta", hudState: "running" }),
                crewRow({ id: "studio", hudState: state }),
              ],
              firstRunToday: null,
            }),
          )
        : answer(...a),
    );
    render(<Telemetry />);
    await waitFor(() =>
      expect(document.querySelector("#tCrewState .lane .lane-state")).toBeTruthy(),
    );
    const lanes = [...document.querySelectorAll("#tCrewState .lane")];
    // visible on the seat's own lane, not only in its accessible text
    expect(lanes[1]?.querySelector(".lane-state")?.textContent).toBe(state);
    expect(lanes[0]?.querySelector(".lane-state")).toBeNull();
    const rows = [...document.querySelectorAll("#tCrewState .readout li")].map(
      (li) => `${li.textContent?.replace(/Seats .*$/, "").trim()}`,
    );
    const counts = [...document.querySelectorAll("#tCrewState .readout li")].map((li) =>
      Number.parseInt(li.querySelector("a")?.textContent ?? "0", 10),
    );
    // every seat in view is counted once
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(rows.some((r) => r.includes(label))).toBe(true);
  });
});

describe("states", () => {
  it("is busy with a loading panel while the hub has not answered", async () => {
    window.history.replaceState(null, "", "/telemetry");
    stubFetch({ "/api/config": CFG });
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    render(<Telemetry />);
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-busy")).toBe("true");
    within(panel).getByText("Loading…");
    // the band shows — until its figures arrive
    expect(within(stat("Your response")).getByRole("button").textContent).toBe("—");
  });

  it("says nothing ran, with no empty chart", async () => {
    await open(
      "",
      tel({
        today: { ...tel().today, toolCalls: 0 },
        toolLatency: [],
        series: { ...(tel().series as NonNullable<TelemetryData["series"]>), stateSpans: [] },
      }),
    );
    screen.getByText("Nothing ran in the last 24h.");
    expect(document.querySelector(".lane")).toBeNull();
  });

  it("says it did not load, and tries again", async () => {
    window.history.replaceState(null, "", "/telemetry");
    const fetch = stubFetch({ "/api/config": CFG });
    render(<Telemetry />);
    await screen.findByText("Telemetry did not load.");
    const before = fetch.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
  });

  it("flags figures that are old when a refresh fails, keeping them on screen dimmed", async () => {
    const { fetch } = await open();
    const answer = fetch.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    fetch.mockImplementation(async (...a: unknown[]) => {
      if (a[0] === "/api/telemetry?range=6h") return new Response("{}", { status: 500 });
      return answer(...a);
    });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "6h" }),
    );
    const chip = await screen.findByRole("status");
    expect(chip.textContent).toMatch(/^Figures are .* old\.$/);
    expect(document.querySelector("#tabpanel .grid.dim, .tabpanel .grid.dim")).toBeTruthy();
    expect(document.getElementById("tUtil")).toBeTruthy();
  });

  it("says it is not connected, and from when the figures are", async () => {
    await open();
    act(() => streamStatus.set({ connected: false, reconnecting: true, lastMessageAt: null }));
    const chip = await screen.findByRole("status");
    expect(chip.className).toContain("crit");
    expect(chip.textContent).toBe("Not connected to the hub. These figures are from 13:00.");
    expect(document.getElementById("tUtil")).toBeTruthy();
  });
});
