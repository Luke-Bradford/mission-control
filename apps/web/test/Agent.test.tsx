import {
  ACK_BATCH_MAX,
  type AgentStream,
  type AttentionItem,
  type ChangedFiles,
  CREW_FILES_NOTE,
  type CrewLoop,
  type CrewRow,
  ENGINE_NOT_RUNNING,
  type FileDiff,
  type LimitRow,
  METER_FULL_PCT,
  METER_WARN_PCT,
  type RunDigest,
  type RunView,
} from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { Agent } from "../src/pages/Agent.tsx";
import { installKeys } from "../src/shell/keys.ts";
import { setSelectedAgent } from "../src/shell/selection.ts";
import { setSession } from "../src/shell/session.ts";
import { Toast, toast } from "../src/shell/Toast.tsx";
import { settled, stubFetch } from "./fetchStub.ts";
import {
  CONFIG,
  crewRow,
  HOUR,
  item,
  limit5h,
  MIN,
  NOW,
  prView,
  run,
  seatRow,
  stoppedSeat,
} from "./fixtures.ts";

export function digest(over: Partial<RunDigest> = {}): RunDigest {
  return {
    toolCalls: 37,
    turns: 21,
    lastEventAt: NOW - MIN,
    model: "claude-opus-4-1",
    contextTokens: 150_000,
    contextWindow: 200_000,
    liveTool: null,
    tools: {},
    subagents: [],
    minuteTokens: [],
    turnUsage: [],
    background: [],
    compactions: 0,
    ...over,
  };
}

const STREAM: AgentStream = {
  runId: "r-12",
  events: [
    { id: "0:0", at: NOW - 10 * MIN, kind: "op", text: "Work on shop-app#3349" },
    { id: "100:0", at: NOW - 9 * MIN, kind: "think", text: "Considering the cache" },
    {
      id: "200:0",
      at: NOW - 8 * MIN,
      kind: "tool",
      text: "Bash",
      tool: {
        name: "Bash",
        input: '{"command":"pnpm test"}',
        result: "42 passed",
        ms: 3400,
        error: false,
      },
    },
    { id: "300:0", at: NOW - 7 * MIN, kind: "msg", text: "The cache is in" },
    {
      id: "400:0",
      at: NOW - 6 * MIN,
      kind: "sys",
      text: "Subagent started: Explore · find callers",
    },
  ],
  truncated: false,
  lastOutputAt: NOW - MIN,
  reason: null,
};

/** A run as `/api/agents/:id/runs` serves it: PRs joined, ticket resolved. */
const rv = (over: Partial<RunView> = {}): RunView => ({ ...run(), prs: [], ...over });

const studio = (over: Partial<CrewRow> = {}) =>
  crewRow({
    id: "studio-builder",
    repoId: "site-builder",
    index: 1,
    kind: "loop",
    role: null,
    mode: null,
    area: [],
    model: null,
    sessionId: null,
    loopKind: "studio-loop",
    hudState: "idle",
    ticket: null,
    ticketTitle: null,
    run: null,
    ...over,
  });

interface Data {
  rows?: CrewRow[];
  items?: AttentionItem[];
  limits?: LimitRow[];
  stream?: AgentStream;
  /** The stream as of each fetch. */
  streamNow?: () => AgentStream;
  runs?: RunView[];
  files?: ChangedFiles | { status: number; error: string; note?: string };
  /** `/files/diff?path=` answers, by path. */
  diffs?: Record<string, FileDiff>;
  /** More routes, by "METHOD path". */
  extra?: Record<string, unknown>;
}

function stub(d: Data = {}) {
  const rows = d.rows ?? [crewRow({ digest: digest(), contextWindow: 200_000 }), studio()];
  const routes: Record<string, unknown> = {
    "/api/crew": { rows, firstRunToday: null },
    "/api/attention": d.items ?? [],
    "/api/limits": d.limits ?? [limit5h()],
    "/api/config": CONFIG,
    "POST /api/attention/ack": { acked: 1 },
  };
  for (const r of rows) {
    const enc = encodeURIComponent(r.id);
    const streamNow = d.streamNow;
    routes[`/api/agents/${enc}/stream`] = streamNow
      ? () => ({ status: 200, body: streamNow() })
      : (d.stream ?? STREAM);
    routes[`/api/agents/${enc}/runs?limit=50`] = d.runs ?? [
      rv(),
      rv({ id: "r-11", seq: 11, status: "ok", startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR }),
    ];
    const f = d.files ?? { files: [], note: null };
    routes[`/api/agents/${enc}/files`] =
      "status" in f ? () => ({ status: f.status, body: { error: f.error, note: f.note } }) : f;
    for (const [p, diff] of Object.entries(d.diffs ?? {})) {
      routes[`/api/agents/${enc}/files/diff?path=${encodeURIComponent(p)}`] = diff;
    }
  }
  return stubFetch({ ...routes, ...d.extra });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const $ = (c: HTMLElement, sel: string) => c.querySelector<HTMLElement>(sel);
const loaded = () => screen.findByText("Work on shop-app#3349");

describe("Agent page: header before the timezone loads", () => {
  it("shows the doing line without waiting for the config", async () => {
    stub({ extra: { "/api/config": () => ({ status: 503, body: { error: "loading" } }) } });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    expect($(container, "#ahead .doing")?.textContent).toContain("run #12");
  });
});

describe("Agent page: what the seat is doing", () => {
  const tile = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll<HTMLElement>(".tile2")].find((t) =>
      t.querySelector(".lbl")?.textContent?.startsWith(label),
    ) as HTMLElement;

  it("the header and the Now tile say the tool in hand and what it touches", async () => {
    const live = { name: "Edit", since: NOW - 12_000, detail: "apps/server/src/backfill.ts" };
    stub({ rows: [crewRow({ digest: digest({ liveTool: live }) })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    expect($(container, "#ahead .doing")?.textContent).toBe(
      "Edit 0:12 · apps/server/src/backfill.ts",
    );
    expect($(tile(container, "Now"), ".nowdoing")?.textContent).toBe(
      "Edit 0:12 · apps/server/src/backfill.ts",
    );
  });

  it("between tools they say the last text; with no text the Now tile adds nothing", async () => {
    stub({ rows: [crewRow({ digest: digest({ lastText: "I'm editing supervisor.ts now…" }) })] });
    const first = render(<Agent id="shop-app-ta" />);
    await loaded();
    expect($(first.container, "#ahead .doing")?.textContent).toBe("I'm editing supervisor.ts now…");
    expect($(tile(first.container, "Now"), ".nowdoing")?.textContent).toBe(
      "I'm editing supervisor.ts now…",
    );
    first.unmount();
    stub({ rows: [crewRow({ digest: digest() })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    expect($(container, "#ahead .doing")?.textContent).toBe("run #12");
    expect($(tile(container, "Now"), ".nowdoing")).toBeNull();
  });

  it("a running seat's background task comes ahead of its last text in the tile as in the header", async () => {
    const task = { taskId: "t1", description: "Run the full suite", type: "shell" };
    stub({
      rows: [crewRow({ digest: digest({ background: [task], lastText: "Starting the suite." }) })],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    expect($(container, "#ahead .doing")?.textContent).toBe(
      "run #12 · background: Run the full suite",
    );
    expect($(tile(container, "Now"), ".nowdoing")?.textContent).toBe(
      "background: Run the full suite",
    );
  });

  it("the header's PR chip is followed by the PR's title, from the repo's PRs", async () => {
    stub({
      rows: [
        crewRow({ digest: digest(), contextWindow: 200_000 }),
        // as live data is: the run records no PRs
        seatRow({ hudState: "idle", review: { prNumber: 166, state: "draft" }, prs: [] }),
      ],
      extra: {
        "/api/repos/shop-app/prs?linked=1": [
          prView({ number: 166, title: "Backfill the quote cache" }),
        ],
      },
    });
    const { container } = render(<Agent id="guido-1" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")).toBeTruthy());
    await vi.waitFor(() =>
      expect($(container, "#ahead .doing")?.textContent).toBe(
        "Draft PR #166 · Backfill the quote cache",
      ),
    );
  });
});

describe("Agent page: what past runs were", () => {
  const SUMMARY = "Cached the quotes. ".repeat(20).trim();

  it("each run shows its ticket's title beside the number", async () => {
    stub({ runs: [rv({ ticketTitle: "Quote cache", summary: null })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const t = $(container, "#loopP .rticket .rtitle") as HTMLElement;
    expect(t.textContent).toBe("Quote cache");
    expect(t.title).toBe("Quote cache");
    expect($(container, "#loopP .rticket")?.textContent).toBe("#3349Quote cache");
  });

  it("a run without a title shows the number alone", async () => {
    stub({ runs: [rv({ ticketTitle: null })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    expect($(container, "#loopP .rtitle")).toBeNull();
  });

  it("the summary is its own clamped block with the full text on hover", async () => {
    stub({ runs: [rv({ summary: SUMMARY })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const s = $(container, "#loopP .rsummary") as HTMLElement;
    expect(s.title).toBe(SUMMARY);
    expect(s.closest(".rticket")).toBeNull();
    expect(s.className).not.toContain("open");
  });

  it("the full summary opens on a click of the row and closes on the next", async () => {
    stub({ runs: [rv({ summary: SUMMARY })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const row = $(container, "#loopP .runrow:not(.head)") as HTMLElement;
    const s = $(row, ".rsummary") as HTMLElement;
    expect(s.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(s.className).toContain("open");
    expect(s.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(row);
    expect(s.className).not.toContain("open");
    // a link in the row goes where it points: it does not open the summary
    fireEvent.click(within(row).getByRole("link", { name: "shop-app #3349" }));
    expect(s.className).not.toContain("open");
  });

  it("the summary is a native button: a click toggles it once, and focus alone leaves it shut", async () => {
    stub({ runs: [rv({ summary: SUMMARY })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const s = $(container, "#loopP .rsummary") as HTMLElement;
    expect(s.tagName).toBe("BUTTON");
    expect(s.getAttribute("type")).toBe("button");
    expect(s.getAttribute("role")).toBeNull();
    act(() => s.focus());
    expect(s.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(s);
    expect(s.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(s);
    expect(s.getAttribute("aria-expanded")).toBe("false");
  });

  it("a summary with a Markdown link holds no anchor, so nothing interactive is inside the button", async () => {
    stub({ runs: [rv({ summary: "Opened [the PR](https://github.com/x/y/pull/1) for review." })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const s = $(container, "#loopP .rsummary") as HTMLElement;
    expect(s.tagName).toBe("BUTTON");
    expect(s.textContent).toContain("the PR");
    expect(s.querySelector("a, button, [tabindex]")).toBeNull();
  });

  it("Enter or Space with Ctrl or Meta is left to the browser; plain keys are not intercepted", async () => {
    stub({ runs: [rv({ summary: SUMMARY })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const s = $(container, "#loopP .rsummary") as HTMLElement;
    for (const key of ["Enter", " "]) {
      for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
        expect(fireEvent.keyDown(s, { key, ...mod })).toBe(false);
        expect(fireEvent.keyUp(s, { key, ...mod })).toBe(false);
      }
      // the native activation (Enter on keydown, Space on keyup) is left alone
      expect(fireEvent.keyDown(s, { key })).toBe(true);
      expect(fireEvent.keyUp(s, { key })).toBe(true);
    }
    expect(s.getAttribute("aria-expanded")).toBe("false");
  });

  it("every summary is a plain tab stop, with no roving tabindex", async () => {
    stub({
      runs: [
        rv({ id: "r-3", seq: 3, summary: "Three." }),
        rv({ id: "r-2", seq: 2, summary: null }),
        rv({ id: "r-1", seq: 1, summary: "One." }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const all = [...container.querySelectorAll<HTMLButtonElement>("#loopP .rsummary")];
    expect(all.map((e) => e.tabIndex)).toEqual([0, 0]);
  });

  it("a crew run shows its PR, found by branch in the repo's PRs", async () => {
    stub({
      rows: [seatRow({ hudState: "idle" })],
      runs: [rv({ id: "r-5", seq: 5, branch: "feature/77-cache", ticket: null, prs: [] })],
      extra: {
        "/api/repos/shop-app/prs?linked=1": [
          prView({ number: 77, branch: "feature/77-cache" }),
          prView({ number: 9, branch: "other" }),
        ],
      },
    });
    const { container } = render(<Agent id="guido-1" />);
    const chip = await within(container).findByRole("link", { name: "shop-app PR #77" });
    expect(chip.closest(".rref")?.getAttribute("title")).toBe("Cache quotes");
    expect(within(container).queryByRole("link", { name: "shop-app PR #9" })).toBeNull();
  });
});

describe("Agent page: picker and selection", () => {
  it("shows one picker button per agent in the session filter; its lamp is the agent's needs", async () => {
    stub({ items: [item()] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const picker = screen.getByRole("group", { name: "Pick an agent" });
    const buttons = within(picker).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      expect.stringContaining("shop-app-ta"),
      expect.stringContaining("studio-builder"),
    ]);
    expect(buttons[0]?.className).toContain("on");
    expect(within(buttons[0] as HTMLElement).getByRole("img", { name: "Decision" })).toBeTruthy();
    expect(within(buttons[1] as HTMLElement).queryByRole("img", { name: "Decision" })).toBeNull();
    // not a state lamp: the needs lamp does not pulse
    expect($(buttons[0] as HTMLElement, ".lamp")?.className).not.toContain("pulse");
    expect($(container, "#ahead")).toBeTruthy();

    act(() => setSession("site-builder"));
    expect(
      within(picker)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining("studio-builder")]);
  });

  it("/agent with no id shows the selected agent, else the first", async () => {
    stub();
    act(() => setSelectedAgent("studio-builder"));
    const { container, unmount } = render(<Agent id={null} />);
    await loaded();
    expect($(container, "#ahead .big")?.textContent).toBe("studio-builder");
    unmount();
    act(() => setSelectedAgent(null));
    const again = render(<Agent id={null} />);
    await loaded();
    expect($(again.container, "#ahead .big")?.textContent).toBe("shop-app-ta");
  });

  it("picking an agent navigates to its page", async () => {
    stub();
    render(<Agent id="shop-app-ta" />);
    await loaded();
    const picker = screen.getByRole("group", { name: "Pick an agent" });
    fireEvent.click(within(picker).getAllByRole("button")[1] as HTMLElement);
    expect(window.location.pathname).toBe("/agent/studio-builder");
  });
});

describe("Agent page: need banner", () => {
  it("says the agent needs you, with the need line and Ack, which acks its unacked keys", async () => {
    const fetch = stub({
      items: [
        item(),
        item({ key: "stall:shop-app-ta:r-12", kind: "stalled", at: NOW - 12 * MIN, tool: "Bash" }),
        item({ key: "esc:shop-app#1", kind: "question", acked: true }),
        item({ key: "esc:other", agentId: "studio-builder" }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const banner = $(container, "#needBanner .banner") as HTMLElement;
    expect(banner.textContent).toContain("shop-app-ta needs you.");
    expect(banner.textContent).toContain("Stalled 12:00 in Bash");
    expect(banner.textContent).toContain("Decision for you");
    fireEvent.click(within(banner).getByRole("button", { name: "Ack" }));
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/attention/ack",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = JSON.parse(
      (fetch.mock.calls.find(([u]) => u === "/api/attention/ack")?.[1]?.body as string) ?? "{}",
    );
    expect(body.keys.sort()).toEqual(["esc:shop-app#4001", "stall:shop-app-ta:r-12"]);
  });

  it(`Ack sends more than ${ACK_BATCH_MAX} keys in batches the server accepts`, async () => {
    const many = Array.from({ length: 51 }, (_, i) => item({ key: `esc:shop-app#${i + 1}` }));
    const fetch = stub({ items: many });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const banner = $(container, "#needBanner .banner") as HTMLElement;
    fireEvent.click(within(banner).getByRole("button", { name: "Ack" }));
    const posts = () => fetch.mock.calls.filter(([u]) => u === "/api/attention/ack");
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    const sent = posts().map(([, init]) => JSON.parse(init?.body as string).keys as string[]);
    expect(ACK_BATCH_MAX).toBe(50);
    expect(sent.map((k) => k.length)).toEqual([50, 1]);
    expect(new Set(sent.flat()).size).toBe(51);
  });

  it("has no banner without needs, and no Ack when everything is acknowledged", async () => {
    stub({ items: [item({ acked: true })] });
    const { container, unmount } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const banner = $(container, "#needBanner .banner") as HTMLElement;
    expect(within(banner).queryByRole("button", { name: "Ack" })).toBeNull();
    unmount(); // one page at a time: ids are unique on a page
    const none = render(<Agent id="studio-builder" />);
    await vi.waitFor(() => expect($(none.container, "#ahead .big")).toBeTruthy());
    expect($(none.container, "#needBanner .banner")).toBeNull();
  });
});

describe("Agent page: header and tiles", () => {
  it("shows id, state, chips, Pause for a ta-loop and the observed-loop line", async () => {
    stub();
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const head = $(container, "#ahead") as HTMLElement;
    expect($(head, ".big")?.textContent).toBe("shop-app-ta");
    expect(within(head).getByText("Running")).toBeTruthy();
    const chips = [...head.querySelectorAll(".chips span")].map((s) => s.textContent);
    expect(chips).toEqual([
      "observed loop · ta-loop",
      "s/shop-app",
      "claude-main · claude-opus-4-1",
      "feature/3349-quote-cache",
    ]);
    expect(within(head).getByRole("button", { name: "pause" })).toBeTruthy();
    expect(
      within(head)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["pause", "Pop out"]);
    expect(head.textContent).toContain(
      "Observed loop: Mission Control reads it and never drives it.",
    );
  });

  it("a stopped studio loop's header shows the stop line under the call sign", async () => {
    const stop = {
      reason: "7-day quota utilization 88% >= QUOTA_STOP_PCT=80% -- refusing to fire",
      at: NOW - HOUR,
      quota: { usedPct: 88, stopPct: 80 },
      resumesAt: NOW + 2 * 24 * HOUR,
    };
    stub({
      rows: [
        crewRow({ digest: digest(), contextWindow: 200_000 }),
        studio({ hudState: "stopped", stop }),
      ],
    });
    const { container } = render(<Agent id="studio-builder" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")).toBeTruthy());
    expect($(container, "#ahead .doing")?.textContent).toBe(
      "Stopped at the 7-day quota (88% of 80%) · resumes after Mon 13:00",
    );
  });

  it.each([
    ["whose run merged", stoppedSeat({ merged: true }), "Run ended · PR #75 merged"],
    ["stopped by you", stoppedSeat(), "Run ended by you"],
  ])("a stopped seat %s says why in its header", async (_name, seat, line) => {
    stub({ rows: [crewRow({ digest: digest(), contextWindow: 200_000 }), seat] });
    const { container } = render(<Agent id="guido-1" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")).toBeTruthy());
    expect($(container, "#ahead .doing")?.textContent).toBe(line);
  });

  it.each([
    ["open", "In review · PR #77"],
    ["approved", "In review · PR #77"],
    ["draft", "Draft PR #77"],
    ["changes", "Changes requested · PR #77"],
  ] as const)("an idle seat's header says %s PR, linked", async (state, line) => {
    stub({
      rows: [
        crewRow({ digest: digest(), contextWindow: 200_000 }),
        seatRow({ hudState: "idle", review: { prNumber: 77, state } }),
      ],
    });
    const { container } = render(<Agent id="guido-1" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")).toBeTruthy());
    const doing = $(container, "#ahead .doing") as HTMLElement;
    expect(doing.textContent).toBe(line);
    await vi.waitFor(() =>
      expect(
        within(doing).getByRole("link", { name: "shop-app PR #77" }).getAttribute("href"),
      ).toBe("https://github.com/octo-org/shop-app/pull/77"),
    );
  });

  it("an idle seat with no PR stays Idle in its header", async () => {
    stub({
      rows: [
        crewRow({ digest: digest(), contextWindow: 200_000 }),
        seatRow({ hudState: "idle", review: null }),
      ],
    });
    const { container } = render(<Agent id="guido-1" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")).toBeTruthy());
    expect($(container, "#ahead .doing")?.textContent).toMatch(/^Idle/);
  });

  it("a stopped seat's Now tile shows its ticket muted as last, without the title as current work", async () => {
    stub({
      rows: [crewRow({ digest: digest(), contextWindow: 200_000 }), stoppedSeat({ merged: true })],
    });
    const { container } = render(<Agent id="guido-1" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")).toBeTruthy());
    const now = $(container, ".tile2.now .nowt") as HTMLElement;
    // one seat is one repo: the page leaves the repo chip out
    expect(now.textContent).toBe("Last #74");
    expect(now.querySelector(".muted .rref")?.textContent).toBe("#74");
    expect(now.textContent).not.toContain("Dead collector fallback");
    expect(now.querySelector(".muted")?.getAttribute("title")).toBe("Dead collector fallback");
  });

  it("a stopped seat with a ticket but no title has no hover text on its Now line", async () => {
    stub({
      rows: [
        crewRow({ digest: digest(), contextWindow: 200_000 }),
        stoppedSeat({ merged: true, ticketTitle: null, summary: "Some summary" }),
      ],
    });
    const { container } = render(<Agent id="guido-1" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")).toBeTruthy());
    expect($(container, ".tile2.now .nowt")?.getAttribute("title")).toBeNull();
  });

  it("a seat in error says its run failed and shows its ticket muted as last", async () => {
    const failed = stoppedSeat({ hudState: "error", sourceError: "CLI never started" });
    stub({ rows: [crewRow({ digest: digest(), contextWindow: 200_000 }), failed] });
    const { container } = render(<Agent id="guido-1" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")).toBeTruthy());
    expect($(container, "#ahead .doing")?.textContent).toBe("Run failed: CLI never started");
    const now = $(container, ".tile2.now .nowt") as HTMLElement;
    expect(now.textContent).toBe("Last #74");
    expect(now.textContent).not.toContain("Dead collector fallback");
  });

  it("a loop in error still reads Error: … with its current ticket", async () => {
    stub({
      rows: [
        crewRow({
          hudState: "error",
          sourceError: "state dir gone",
          digest: digest(),
          contextWindow: 200_000,
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")).toBeTruthy());
    expect($(container, "#ahead .doing")?.textContent).toBe("Error: state dir gone");
    const now = $(container, ".tile2.now .nowt") as HTMLElement;
    expect(now.textContent).toContain("Quote cache");
    expect(now.textContent).not.toContain("Last");
  });

  it("has no Pause (or any loop control) for a studio loop, only Pop out", async () => {
    stub();
    const { container } = render(<Agent id="studio-builder" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")).toBeTruthy());
    const buttons = within($(container, "#ahead") as HTMLElement).queryAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Pop out"]);
  });

  it("Pop out opens the agent in its own window", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    stub();
    const { container } = render(<Agent id="studio-builder" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")).toBeTruthy());
    const btn = within($(container, "#ahead") as HTMLElement).getByRole("button", {
      name: "Pop out",
    });
    expect(btn.classList.contains("ghost")).toBe(true);
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledWith(
      "/agent/studio-builder?popout=1",
      "mc-agent-studio-builder",
      "popup,width=1200,height=820",
    );
  });

  it("tiles: now, context, tokens with cache hit, cost, speed, work, quota", async () => {
    stub({
      rows: [
        crewRow({
          digest: digest({
            subagents: [
              {
                taskId: "t1",
                type: "Explore",
                description: "find callers",
                status: "running",
                tokens: 12_300,
                toolUses: 5,
                durationMs: 42_000,
              },
            ],
          }),
          contextWindow: 200_000,
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const tile = (label: string) =>
      [...container.querySelectorAll<HTMLElement>(".tile2")].find((t) =>
        t.querySelector(".lbl")?.textContent?.startsWith(label),
      ) as HTMLElement;
    // one seat is one repo: the ticket is the number alone, with no repo chip
    expect($(tile("Now"), ".nowt")?.textContent).toBe("#3349 Quote cache");
    expect(tile("Now").querySelector(".rchip")).toBeNull();
    expect(tile("Now").textContent).toContain("run #12 · 25:00 in this run");
    // 150k of a 200k window
    const ctx = $(tile("Context"), ".v") as HTMLElement;
    expect(ctx.firstChild?.textContent).toBe("75%");
    expect(ctx.querySelector("small")?.textContent?.trim()).toBe("of 200k");
    expect(tile("Context").textContent).toContain(
      "Breakdown arrives with the agent runtime (phase 2) · 0 compactions",
    );
    // 1.2M ÷ (12k + 1.2M + 40k) = 95.8%
    expect($(tile("Tokens this run"), ".v")?.textContent).toBe("15.4k");
    expect($(tile("Tokens this run"), ".d")?.textContent).toBe(
      "12.0k in · 3.4k out · 96% cache hit",
    );
    expect($(tile("~Cost"), ".v")?.textContent).toBe("~$2.47");
    expect($(tile("~Cost"), ".d")?.textContent).toBe("API-equivalent, this run");
    expect($(tile("Speed"), ".v")?.textContent).toContain("—");
    expect($(tile("Speed"), ".v")?.title).toContain("phase 2");
    expect($(tile("Work"), ".v")?.textContent).toBe("37tool calls");
    expect($(tile("Work"), ".d")?.textContent).toBe("21 turns · 1 subagent");
    expect(tile("Quota · claude-main").textContent).toContain("5h 41%");
  });

  it("context tile counts compactions, singular for one", async () => {
    stub({ rows: [crewRow({ digest: digest({ compactions: 1 }), contextWindow: 200_000 })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const ctx = [...container.querySelectorAll<HTMLElement>(".tile2")].find((t) =>
      t.querySelector(".lbl")?.textContent?.startsWith("Context"),
    );
    expect(ctx?.textContent).toContain("(phase 2) · 1 compaction");
    expect(ctx?.textContent).not.toContain("1 compactions");
  });

  it("context tile shows — for compactions when there is no digest, not 0", async () => {
    stub({ rows: [crewRow({ digest: null, contextWindow: 200_000 })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const ctx = [...container.querySelectorAll<HTMLElement>(".tile2")].find((t) =>
      t.querySelector(".lbl")?.textContent?.startsWith("Context"),
    );
    expect(ctx?.textContent).toContain("(phase 2) · —");
    expect(ctx?.textContent).not.toContain("0 compactions");
  });

  it("context is — when the window is unknown; tokens — without counts", async () => {
    stub({
      rows: [
        crewRow({
          digest: digest({ contextWindow: null }),
          contextWindow: null,
          run: { ...(crewRow().run as NonNullable<CrewRow["run"]>), tokens: null, costUsd: null },
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const tile = (label: string) =>
      [...container.querySelectorAll<HTMLElement>(".tile2")].find((t) =>
        t.querySelector(".lbl")?.textContent?.startsWith(label),
      ) as HTMLElement;
    expect($(tile("Context"), ".v")?.textContent).toBe("—");
    expect($(tile("Tokens this run"), ".v")?.textContent).toBe("—");
    expect($(tile("~Cost"), ".v")?.textContent).toBe("—");
  });

  it("the context bar takes the meter tones: amber from METER_WARN_PCT, red from METER_FULL_PCT", async () => {
    const at = (tokens: number) => [
      crewRow({ digest: digest({ contextTokens: tokens }), contextWindow: 200_000 }),
    ];
    for (const [tokens, cls] of [
      [150_000, "ctxbar"],
      [(METER_WARN_PCT / 100) * 200_000, "ctxbar hi"],
      [(METER_FULL_PCT / 100) * 200_000, "ctxbar full"],
    ] as const) {
      hub.clear();
      stub({ rows: at(tokens) });
      const { container, unmount } = render(<Agent id="shop-app-ta" />);
      await loaded();
      expect($(container, ".ctxbar")?.className, String(tokens)).toBe(cls);
      unmount();
    }
  });

  it("a run past an hour reads in hours and minutes, not 160:48", async () => {
    const long = {
      ...(crewRow().run as NonNullable<CrewRow["run"]>),
      startedAt: NOW - 2 * HOUR - 41 * MIN,
    };
    stub({ rows: [crewRow({ run: long, digest: digest() })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const now = [...container.querySelectorAll<HTMLElement>(".tile2")].find((t) =>
      t.querySelector(".lbl")?.textContent?.startsWith("Now"),
    ) as HTMLElement;
    expect(now.textContent).toContain("run #12 · 2h 41m in this run");
  });

  it("the Now tile of a finished run reads last run, how long it took and when it ended", async () => {
    const finished = {
      ...(crewRow().run as NonNullable<CrewRow["run"]>),
      seq: 60,
      status: "ok" as const,
      startedAt: NOW - HOUR - 3 * HOUR - 7 * MIN,
      endedAt: NOW - HOUR,
    };
    stub({
      rows: [
        crewRow({
          hudState: "idle",
          run: finished,
          ticket: null,
          ticketTitle: null,
          summary: "Cached quotes",
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const now = [...container.querySelectorAll<HTMLElement>(".tile2")].find((t) =>
      t.querySelector(".lbl")?.textContent?.startsWith("Now"),
    ) as HTMLElement;
    expect(now.textContent).toContain("last run #60 · took 3h 07m · ended 60 min ago");
    expect(now.textContent).not.toContain("in this run");
    expect($(now, ".nowt")?.textContent).toBe("Cached quotes");
  });

  it.each([
    ["ended just now", NOW - 30_000],
    ["ended 12 min ago", NOW - 12 * MIN],
    ["ended 3 h ago", NOW - 3 * HOUR],
    ["ended 2d ago", NOW - 50 * HOUR],
  ])("the Now tile says how long ago the last run ended: %s", async (expected, endedAt) => {
    const run = {
      ...(crewRow().run as NonNullable<CrewRow["run"]>),
      seq: 60,
      status: "ok" as const,
      startedAt: endedAt - HOUR,
      endedAt,
    };
    stub({
      rows: [
        crewRow({
          hudState: "idle",
          run,
          ticket: null,
          ticketTitle: null,
          summary: "Cached quotes",
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const now = [...container.querySelectorAll<HTMLElement>(".tile2")].find((t) =>
      t.querySelector(".lbl")?.textContent?.startsWith("Now"),
    ) as HTMLElement;
    expect(now.textContent).toContain(expected);
  });

  it("a run that is not running and has no end shows — for its time, not a growing count", async () => {
    const ended = { ...(crewRow().run as NonNullable<CrewRow["run"]>), status: "unknown" as const };
    stub({
      rows: [crewRow({ hudState: "idle", run: ended })],
      runs: [rv({ status: "unknown", endedAt: null })],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const now = [...container.querySelectorAll<HTMLElement>(".tile2")].find((t) =>
      t.querySelector(".lbl")?.textContent?.startsWith("Now"),
    ) as HTMLElement;
    expect(now.textContent).toContain("last run #12 · took — · ended —");
    const first = $(container, "#loopP .runrow:not(.head)") as HTMLElement;
    expect(first.textContent).not.toContain("25m");
    expect(first.querySelector(".num.right")?.textContent).toBe("—");
  });
});

describe("Agent page: activity stream", () => {
  it("shows each event with its time and who; tools expand to input, result and duration", async () => {
    stub();
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const rows = [...container.querySelectorAll<HTMLElement>("#stream .ev")];
    expect(rows.map((r) => $(r, ".who")?.textContent)).toEqual([
      "prompt",
      "thinking",
      "tool",
      "to you",
      "system",
    ]);
    expect($(rows[0] as HTMLElement, ".at")?.textContent).toBe("12:50");
    const tool = $(rows[2] as HTMLElement, "details") as HTMLElement;
    expect($(tool, "summary")?.textContent).toBe("Bash pnpm test · 42 passed");
    expect($(tool, "pre")?.textContent).toBe(
      'input: {"command":"pnpm test"}\nresult: 42 passed\nduration: 3.4s',
    );
  });

  const toolEv = (id: string, input: object, result = "ok"): AgentStream["events"][number] => ({
    id,
    at: NOW,
    kind: "tool",
    text: "x",
    tool: {
      name: id.startsWith("e") ? "Edit" : "Bash",
      input: JSON.stringify(input),
      result,
      ms: 5,
      error: false,
    },
  });

  it("a tool row reads as one line: the tool, its target and the result; the full input stays inside", async () => {
    const long = `pnpm -s lint && ${"x".repeat(100)}\nsecond line`;
    const abs = "/Users/you/code/mc-crew/worktrees/guido-1-167/packages/core/src/loop.ts";
    stub({
      stream: {
        ...STREAM,
        events: [
          STREAM.events[0] as AgentStream["events"][number],
          toolEv("e1", { file_path: abs }, "edited\nmore"),
          toolEv("b1", { command: long }),
        ],
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const [edit, bash] = [...container.querySelectorAll<HTMLElement>("#stream details")] as [
      HTMLElement,
      HTMLElement,
    ];
    expect($(edit, "summary")?.textContent).toBe("Edit packages/core/src/loop.ts · edited");
    expect($(edit, "pre")?.textContent).toContain(abs);
    const line = $(bash, "summary")?.textContent ?? "";
    const target = line.slice("Bash ".length, line.indexOf(" · "));
    expect(target).toBe(`${long.slice(0, 79)}…`);
    expect(target.length).toBe(80);
    expect($(bash, "pre")?.textContent).toContain("second line");
  });

  it("a loop's tool paths are relative to its configured worktree, in the target and the result", async () => {
    stub({
      stream: {
        ...STREAM,
        events: [
          STREAM.events[0] as AgentStream["events"][number],
          toolEv(
            "e1",
            { file_path: "/u/.shop-app-autonomy/app/x.ts" },
            "\nThe file /u/.shop-app-autonomy/app/x.ts has been updated successfully.",
          ),
        ],
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const summary = $(container, "#stream details summary") as HTMLElement;
    await vi.waitFor(() =>
      expect(summary.textContent).toBe(
        "Edit app/x.ts · The file app/x.ts has been updated successfully.",
      ),
    );
    // the result keeps off the page-wide `.res` grid, which would put it on a second line
    expect($(summary, ".res")).toBeNull();
    expect($(summary, ".tres")).not.toBeNull();
  });

  it("the loop's prompt renders its Markdown", async () => {
    stub({
      stream: {
        ...STREAM,
        events: [
          {
            id: "0:0",
            at: NOW,
            kind: "op",
            text: "Work on shop-app#3349\n\n- **first**\n- second",
          },
        ],
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const txt = $(container, "#stream .ev.you .txt") as HTMLElement;
    expect(txt.querySelectorAll("ul li").length).toBe(2);
    expect($(txt, "li strong")?.textContent).toBe("first");
  });

  it("plain messages keep their text exactly", async () => {
    const text = "Edited __init__.py and a*b; step 1. done - 2*3 = 6, snake_case_name.";
    stub({
      stream: {
        ...STREAM,
        events: [
          STREAM.events[0] as AgentStream["events"][number],
          { id: "1:0", at: NOW, kind: "msg", text },
        ],
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const txt = $(container, "#stream .ev.msg .txt");
    expect(txt?.textContent).toBe(text);
    // block elements (paragraphs, code blocks) live inside it, so it is a div, never a span
    expect(txt?.tagName).toBe("DIV");
  });

  it("messages render their Markdown as elements and raw HTML as text", async () => {
    stub({
      stream: {
        ...STREAM,
        events: [
          STREAM.events[0] as AgentStream["events"][number],
          {
            id: "1:0",
            at: NOW,
            kind: "msg",
            text: "Done: **cache** is in\n\n- `a.ts`\n- b\n\n<img src=x onerror=alert(1)>",
          },
        ],
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const txt = $(container, "#stream .ev.msg .txt") as HTMLElement;
    expect($(txt, "strong")?.textContent).toBe("cache");
    expect(txt.querySelectorAll("ul li").length).toBe(2);
    expect($(txt, "li code")?.textContent).toBe("a.ts");
    expect($(txt, "img")).toBeNull();
    expect(txt.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("filters: Messages (prompt, to you, system), Thinking, Tools, and Guard's placeholder", async () => {
    stub();
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const who = () => [...container.querySelectorAll("#stream .ev .who")].map((w) => w.textContent);
    const seg = screen.getByRole("group", { name: "Activity filter" });
    fireEvent.click(within(seg).getByRole("button", { name: "Messages" }));
    expect(who()).toEqual(["prompt", "to you", "system"]);
    fireEvent.click(within(seg).getByRole("button", { name: "Thinking" }));
    expect(who()).toEqual(["thinking"]);
    fireEvent.click(within(seg).getByRole("button", { name: "Tools" }));
    expect(who()).toEqual(["tool"]);
    fireEvent.click(within(seg).getByRole("button", { name: "Guard" }));
    expect(who()).toEqual([]);
    expect($(container, "#stream")?.textContent).toContain(ENGINE_NOT_RUNNING);
    fireEvent.click(within(seg).getByRole("button", { name: "All" }));
    expect(who()).toHaveLength(5);
  });

  it("an open tool call stays open on its own event when the window drops events from the front", async () => {
    const tool = (id: string, name: string, at: number): AgentStream["events"][number] => ({
      id,
      at,
      kind: "tool",
      text: name,
      tool: { name, input: "{}", result: "ok", ms: 1000, error: false },
    });
    let current: AgentStream = {
      ...STREAM,
      events: [tool("0:0", "Alpha", NOW - 3 * MIN), tool("10:0", "Beta", NOW - 2 * MIN)],
    };
    const fetch = stub({ streamNow: () => current });
    const { container } = render(<Agent id="shop-app-ta" />);
    await screen.findByText("Beta");
    const open = () =>
      [...container.querySelectorAll<HTMLDetailsElement>("#stream details")]
        .filter((d) => d.open)
        .map((d) => d.querySelector("summary")?.textContent?.split(" ")[0]);
    const beta = [...container.querySelectorAll<HTMLDetailsElement>("#stream details")][1];
    if (beta) beta.open = true;
    expect(open()).toEqual(["Beta"]);
    current = {
      ...current,
      events: [tool("10:0", "Beta", NOW - 2 * MIN), tool("20:0", "Gamma", NOW - MIN)],
    };
    const before = fetch.mock.calls.length;
    act(() => hub.refetch("/api/agents/shop-app-ta/stream"));
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
    await screen.findByText("Gamma");
    expect(open()).toEqual(["Beta"]);
  });

  it("a run that reuses the previous run's event ids gets fresh rows, not the old ones", async () => {
    const tool = (id: string, name: string, at: number): AgentStream["events"][number] => ({
      id,
      at,
      kind: "tool",
      text: name,
      tool: { name, input: "{}", result: "ok", ms: 1000, error: false },
    });
    let current: AgentStream = { ...STREAM, runId: "r-12", events: [tool("0:0", "Alpha", NOW)] };
    const fetch = stub({ streamNow: () => current });
    const { container } = render(<Agent id="shop-app-ta" />);
    await screen.findByText("Alpha");
    const first = container.querySelector("#stream .ev") as HTMLElement;
    (first.querySelector("details") as HTMLDetailsElement).open = true;
    current = { ...STREAM, runId: "r-13", events: [tool("0:0", "Omega", NOW)] };
    const before = fetch.mock.calls.length;
    act(() => hub.refetch("/api/agents/shop-app-ta/stream"));
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
    await screen.findByText("Omega");
    const rows = container.querySelectorAll<HTMLElement>("#stream .ev");
    expect(rows).toHaveLength(1);
    const next = rows[0] as HTMLElement;
    expect(next).not.toBe(first);
    expect(next.querySelector("details")?.open).toBe(false);
  });

  it("auto-scroll: a refetch never moves a reader who scrolled up; a new event at the bottom follows", async () => {
    let current = STREAM;
    const fetch = stub({ streamNow: () => current });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const box = $(container, "#stream") as HTMLElement;
    let top = 0;
    let height = 1000;
    Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    const streamFetches = () =>
      fetch.mock.calls.filter(([u]) => u === "/api/agents/shop-app-ta/stream").length;
    const refetch = async () => {
      const before = streamFetches();
      act(() => hub.refetch("/api/agents/shop-app-ta/stream"));
      await vi.waitFor(() => expect(streamFetches()).toBe(before + 1));
      await act(async () => {});
    };

    // scrolled up to read: an identical refetch leaves it there
    top = 100;
    fireEvent.scroll(box);
    current = { ...STREAM, events: [...STREAM.events] };
    await refetch();
    expect(top).toBe(100);
    // still scrolled up: a new event does not yank it either
    current = {
      ...STREAM,
      events: [...STREAM.events, { id: "500:0", at: NOW, kind: "msg", text: "newer" }],
    };
    await refetch();
    await screen.findByText("newer");
    expect(top).toBe(100);

    // at the bottom: a new event scrolls to it
    top = 800;
    fireEvent.scroll(box);
    height = 1100;
    current = {
      ...current,
      events: [...current.events, { id: "600:0", at: NOW, kind: "msg", text: "newest" }],
    };
    await refetch();
    await screen.findByText("newest");
    expect(top).toBe(1100);
  });

  it("auto-scroll: a refetch with an unchanged signature does not scroll, even for a reader the panel counts as at the bottom", async () => {
    let current = STREAM;
    const fetch = stub({ streamNow: () => current });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const box = $(container, "#stream") as HTMLElement;
    let top = 800;
    Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    fireEvent.scroll(box); // at the bottom: the panel will follow a changed signature
    top = 790; // still within reach of the bottom, but not on it; no scroll event, so still "at bottom"
    const before = fetch.mock.calls.filter(([u]) => u === "/api/agents/shop-app-ta/stream").length;
    current = { ...STREAM, events: [...STREAM.events] }; // a fresh object, the same content
    act(() => hub.refetch("/api/agents/shop-app-ta/stream"));
    await vi.waitFor(() =>
      expect(fetch.mock.calls.filter(([u]) => u === "/api/agents/shop-app-ta/stream").length).toBe(
        before + 1,
      ),
    );
    await act(async () => {});
    expect(top).toBe(790);
  });

  it("the live call bar shows the running tool and its elapsed time", async () => {
    stub({
      rows: [crewRow({ digest: digest({ liveTool: { name: "Bash", since: NOW - 125_000 } }) })],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const bar = $(container, "#liveCall .livecall") as HTMLElement;
    expect(bar.className).not.toContain("stuck");
    expect(bar.textContent).toBe("▶Bash2:05elapsed");
  });

  it("a stalled run's bar says since when there was no output", async () => {
    stub({
      rows: [
        crewRow({
          hudState: "stalled",
          lastOutputAt: NOW - 12 * MIN,
          digest: digest({ liveTool: { name: "Bash", since: NOW - 15 * MIN } }),
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const bar = $(container, "#liveCall .livecall") as HTMLElement;
    expect(bar.className).toContain("stuck");
    expect(bar.textContent).toContain("Bash");
    expect(bar.textContent).toContain("no output since 12:48 · stall flagged at 10:00");
  });

  it("a stalled run with a background task in flight flags the stall at 60:00", async () => {
    stub({
      rows: [
        crewRow({
          hudState: "stalled",
          lastOutputAt: NOW - 70 * MIN,
          digest: digest({
            liveTool: { name: "Bash", since: NOW - 75 * MIN },
            background: [{ taskId: "t1", description: "sleep", type: "shell" }],
          }),
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const bar = $(container, "#liveCall .livecall") as HTMLElement;
    expect(bar.textContent).toContain("stall flagged at 60:00");
  });

  it("Review Focus 2: an ended run with a dangling tool_use shows no live bar", async () => {
    const ended = { ...(crewRow().run as NonNullable<CrewRow["run"]>) };
    stub({
      rows: [
        crewRow({
          hudState: "idle",
          run: { ...ended, status: "ok", endedAt: NOW - 5 * MIN },
          digest: digest({ liveTool: { name: "Bash", since: NOW - 20 * MIN } }),
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    expect($(container, "#liveCall .livecall")).toBeNull();
  });

  it("Review Focus 2: the stream's reason is the empty text", async () => {
    stub({
      stream: {
        runId: null,
        events: [],
        truncated: false,
        lastOutputAt: null,
        reason: "no runs yet",
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await vi.waitFor(() => expect($(container, "#stream")?.textContent).toBe("no runs yet"));
  });

  it("Review Focus 1: event text is inert", async () => {
    const payload = "<img src=x onerror=alert(1)>";
    stub({
      stream: {
        ...STREAM,
        events: [{ id: "0:0", at: NOW, kind: "msg", text: payload }],
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await screen.findByText(payload);
    expect(container.querySelector("#stream img")).toBeNull();
  });

  it("the composer is disabled with the observed-loop hint", async () => {
    stub();
    render(<Agent id="shop-app-ta" />);
    await loaded();
    const input = screen.getByRole("textbox", { name: "Message this agent" }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("Message shop-app-ta…");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    const intr = screen.getByRole("button", { name: "Interrupt and send" }) as HTMLButtonElement;
    expect(intr.disabled).toBe(true);
    expect(intr.title).toBe("Stop the current turn, then send");
    expect(
      screen.getByText(
        "shop-app-ta is an observed loop; messaging arrives with the engine (phase 2).",
      ),
    ).toBeTruthy();
  });

  it("`i` toasts that an observed loop is not interrupted", async () => {
    stub();
    const off = installKeys({
      navigate: () => {},
      toggleDock: () => {},
      help: () => {},
      selectNext: () => {},
      selectPrev: () => {},
      toast,
    });
    const { unmount } = render(
      <>
        <Agent id="shop-app-ta" />
        <Toast />
      </>,
    );
    await loaded();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "i" }));
    });
    expect(screen.getByRole("status").textContent).toBe(
      "shop-app-ta is an observed loop; Mission Control does not interrupt it.",
    );
    unmount();
    render(<Toast />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "i" }));
    });
    // the page handed `i` back when it unmounted
    expect(screen.getByRole("status").textContent).toBe("Open an agent to interrupt it.");
    off();
  });
});

describe("Agent page: runs", () => {
  it("lists recent runs with status pill, start, duration, tokens, cost and ticket", async () => {
    stub();
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const panel = $(container, "#loopP") as HTMLElement;
    expect(within(panel).getByRole("heading").textContent).toBe("Runs");
    expect(panel.textContent).toContain("2 recent runs");
    const rows = [...panel.querySelectorAll<HTMLElement>(".runrow:not(.head)")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("#12");
    expect(rows[0]?.textContent).toContain("Running");
    expect(rows[0]?.textContent).toContain("12:35");
    expect(rows[0]?.textContent).toContain("25m 00s");
    expect(rows[0]?.textContent).toContain("15.4k");
    expect(rows[0]?.textContent).toContain("~$2.47");
    expect(rows[0]?.querySelector(".rticket")?.textContent).toBe("#3349");
    expect(rows[0]?.querySelector(".rchip")).toBeNull();
    expect(rows[1]?.textContent).toContain("#11");
    expect(rows[1]?.textContent).toContain("Finished");
    expect(rows[1]?.textContent).toContain("1h 00m");
  });

  it("a run summary renders its inline Markdown", async () => {
    stub({ runs: [rv({ summary: "Cached **quotes** via `refresh()`" })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const s = $(container, "#loopP .rsummary") as HTMLElement;
    expect($(s, "strong")?.textContent).toBe("quotes");
    expect($(s, "code")?.textContent).toBe("refresh()");
  });

  it("a row shows its ticket, PR chips and the summary, with the full text in its title", async () => {
    const summary = "Cached quotes for the ranking job and moved the refresh to a background tick";
    stub({
      runs: [
        rv({
          ticket: "shop-app#3227",
          summary,
          prs: [
            {
              repoId: "shop-app",
              number: 3240,
              title: "Quote cache",
              url: "https://github.com/octo-org/shop-app/pull/3240",
              state: "merged",
              ticket: "shop-app#3227",
            },
            {
              repoId: "shop-app",
              number: 3241,
              title: null,
              url: "javascript:alert(1)",
              state: null,
              ticket: null,
            },
          ],
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const row = $(container, "#loopP .runrow:not(.head)") as HTMLElement;
    const cell = $(row, ".rticket") as HTMLElement;
    expect(within(cell).getByRole("link", { name: "shop-app #3227" }).getAttribute("href")).toBe(
      "https://github.com/octo-org/shop-app/issues/3227",
    );
    const chip = within(cell).getByRole("link", { name: "shop-app PR #3240" });
    expect(chip.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/pull/3240");
    expect(chip.closest(".rref")?.getAttribute("title")).toBe("Quote cache");
    expect(cell.textContent).toContain("Merged");
    // the PR link and its pill wrap as one unit
    expect(chip.closest(".rpr")?.textContent).toContain("Merged");
    // the link is built from the configured repo, so the transcript's hostile URL is never used
    expect(within(cell).getByRole("link", { name: "shop-app PR #3241" }).getAttribute("href")).toBe(
      "https://github.com/octo-org/shop-app/pull/3241",
    );
    expect(cell.innerHTML).not.toContain("javascript:");
    const s = $(row, ".rsummary") as HTMLElement;
    expect(s.textContent).toBe(summary);
    expect(s.getAttribute("title")).toBe(summary);
    expect(s.className).toContain("fg2");
  });

  it("a run with only a PR shows the PR's ticket", async () => {
    stub({
      runs: [
        rv({
          ticket: "shop-app#3349",
          prs: [
            {
              repoId: "shop-app",
              number: 3240,
              title: null,
              url: "https://github.com/octo-org/shop-app/pull/3240",
              state: "open",
              ticket: "shop-app#3349",
            },
          ],
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const cell = $(container, "#loopP .runrow:not(.head) .rticket") as HTMLElement;
    expect(cell.textContent).toBe("#3349PR #3240");
    expect(cell.querySelector(".rchip")).toBeNull();
  });

  it("Started is the time today and the date on another day, with both in its title", async () => {
    stub({
      runs: [
        rv(),
        rv({
          id: "r-9",
          seq: 9,
          status: "ok",
          startedAt: NOW - 30 * HOUR,
          endedAt: NOW - 29 * HOUR,
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const cells = [...container.querySelectorAll<HTMLElement>("#loopP .runrow:not(.head)")].map(
      (r) => r.children[2] as HTMLElement,
    );
    expect(cells.map((c) => c.textContent)).toEqual(["12:35", "16 Oct"]);
    expect(cells[1]?.title).toBe("16 Oct 07:00");
  });

  it("the latest running run takes the agent's stall", async () => {
    stub({ rows: [crewRow({ hudState: "stalled", digest: digest() })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const first = $(container, "#loopP .runrow:not(.head)") as HTMLElement;
    expect(first.textContent).toContain("Stalled");
  });

  it("Steps waits on the engine", async () => {
    stub();
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const panel = $(container, "#loopP") as HTMLElement;
    fireEvent.click(within(panel).getByRole("button", { name: "Steps" }));
    expect(panel.textContent).toContain(ENGINE_NOT_RUNNING);
    expect(panel.querySelector(".runrow")).toBeNull();
  });

  it("no runs yet", async () => {
    stub({ runs: [] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    expect($(container, "#loopP")?.textContent).toContain("No runs yet.");
  });
});

describe("Agent page: loop steps", () => {
  const loopOf = (over: Partial<CrewLoop> = {}): CrewLoop => ({
    phase: "working",
    text: "Writing the failing test",
    prNumber: null,
    parked: null,
    ...over,
  });
  const seat = (loop: CrewLoop | null) =>
    crewRow({ digest: digest(), contextWindow: 200_000, loop });
  const open = async (loop: CrewLoop | null, extra?: Record<string, unknown>) => {
    stub({ rows: [seat(loop)], runs: [], extra });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    return $(container, "#loopP") as HTMLElement;
  };
  const dots = (panel: HTMLElement) =>
    [...panel.querySelectorAll(".vstep")].map((s) => [
      s.querySelector(".vname")?.textContent,
      s.querySelector(".tdot")?.textContent,
    ]);

  it.each([
    [
      "working",
      [
        ["Working", "●"],
        ["CI", "2"],
        ["In review", "3"],
        ["Done", "4"],
      ],
    ],
    [
      "ci",
      [
        ["Working", "✓"],
        ["CI", "●"],
        ["In review", "3"],
        ["Done", "4"],
      ],
    ],
    [
      "review",
      [
        ["Working", "✓"],
        ["CI", "✓"],
        ["In review", "●"],
        ["Done", "4"],
      ],
    ],
    [
      "done",
      [
        ["Working", "✓"],
        ["CI", "✓"],
        ["In review", "✓"],
        ["Done", "✓"],
      ],
    ],
  ] as const)("phase %s lists the four steps with their dots", async (phase, expected) => {
    const panel = await open(loopOf({ phase }));
    fireEvent.click(within(panel).getByRole("button", { name: "Steps" }));
    expect(dots(panel)).toEqual(expected);
  });

  it("shows the server's text and the PR on the current step only", async () => {
    const panel = await open(loopOf({ phase: "review", text: "Waiting on review", prNumber: 77 }));
    const steps = [...panel.querySelectorAll<HTMLElement>(".vstep")];
    const withText = steps.filter((s) => s.textContent?.includes("Waiting on review"));
    expect(withText).toHaveLength(1);
    expect(withText[0]?.querySelector(".vname")?.textContent).toBe("In review");
    const withPr = steps.filter((s) => s.querySelector("a[href*='/pull/77']"));
    expect(withPr).toHaveLength(1);
    expect(withPr[0]).toBe(withText[0]);
  });

  it("parked shows a held line and no current step", async () => {
    const panel = await open(
      loopOf({ phase: "parked", text: "Held: CI failed twice", parked: "CI failed twice" }),
    );
    const held = $(panel, ".vhold") as HTMLElement;
    expect(held.textContent).toContain("Held: CI failed twice");
    expect(held.textContent).toContain("!");
    expect(panel.textContent).not.toContain("●");
    expect(panel.querySelectorAll(".vstep")).toHaveLength(4);
    expect(panel.querySelector(".vstep.cur")).toBeNull();
  });

  it("a held current step is marked with ! and no step is current", async () => {
    const loop = loopOf();
    stub({ rows: [{ ...seat(loop), hudState: "stalled" }], runs: [] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const panel = $(container, "#loopP") as HTMLElement;
    expect(dots(panel)).toEqual([
      ["Working", "!"],
      ["CI", "2"],
      ["In review", "3"],
      ["Done", "4"],
    ]);
    expect($(panel, ".vstep.warn")?.textContent).toContain(loop.text);
    expect(panel.querySelector(".vstep.cur")).toBeNull();
  });

  it("the Steps subtitle names the loop and the tokens so far; Runs keeps its count", async () => {
    const panel = await open(loopOf());
    expect(panel.textContent).toContain("build · 15.4k tokens so far");
    fireEvent.click(within(panel).getByRole("button", { name: "Runs" }));
    expect(panel.textContent).toContain("0 recent runs");
    expect(panel.textContent).not.toContain("tokens so far");
  });

  it("the Steps subtitle is the loop's name alone when the run has no tokens", async () => {
    const row = seat(loopOf());
    stub({ rows: [{ ...row, run: row.run && { ...row.run, tokens: null } }], runs: [] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const panel = $(container, "#loopP") as HTMLElement;
    expect(panel.textContent).toContain("build");
    expect(panel.textContent).not.toContain("tokens so far");
  });

  it("a row with no loop keeps the engine-not-running text", async () => {
    const panel = await open(null);
    fireEvent.click(within(panel).getByRole("button", { name: "Steps" }));
    expect(panel.textContent).toContain(ENGINE_NOT_RUNNING);
    expect(panel.querySelector(".vstep")).toBeNull();
  });

  it("opens on Steps, titled Loop, when the loop is in flight", async () => {
    const panel = await open(loopOf());
    expect(within(panel).getByRole("heading").textContent).toBe("Loop");
    expect(within(panel).getByRole("button", { name: "Steps" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(panel.querySelector(".vstep")).not.toBeNull();
  });

  it.each([
    ["a done loop", loopOf({ phase: "done" })],
    ["no loop", null],
  ])("opens on Runs, titled Runs, for %s", async (_name, loop) => {
    const panel = await open(loop);
    expect(within(panel).getByRole("heading").textContent).toBe("Runs");
    expect(within(panel).getByRole("button", { name: "Runs" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  /** The seat's next `/api/crew` answer, delivered and rendered. */
  const swap = async (loop: CrewLoop | null, runId: string) => {
    const live = crewRow().run as NonNullable<CrewRow["run"]>;
    const next = crewRow({
      digest: digest(),
      contextWindow: 200_000,
      loop,
      run: { ...live, id: runId },
    });
    const f = stub({ rows: [next], runs: [] });
    act(() => hub.refetch("/api/crew"));
    await settled(f, "/api/crew");
  };
  const title = (panel: HTMLElement) => within(panel).getByRole("heading").textContent;
  const pick = (panel: HTMLElement, name: "Steps" | "Runs") =>
    fireEvent.click(within(panel).getByRole("button", { name }));

  it("keeps the viewer's choice while the same loop moves between phases", async () => {
    const panel = await open(loopOf());
    pick(panel, "Runs");
    await swap(loopOf({ phase: "ci", text: "CI is running" }), "r-12");
    expect(title(panel)).toBe("Runs");
    pick(panel, "Steps");
    expect(panel.textContent).toContain("CI is running");
  });

  it("forgets the choice once the loop is done, so the next loop opens on Steps", async () => {
    const panel = await open(loopOf());
    pick(panel, "Runs");
    await swap(loopOf({ phase: "done" }), "r-12");
    expect(title(panel)).toBe("Runs");
    await swap(loopOf({ text: "Ticket B" }), "r-13");
    expect(title(panel)).toBe("Loop");
  });

  it("forgets a choice made between loops, so the next loop's end opens on Runs", async () => {
    const panel = await open(loopOf({ phase: "done" }));
    pick(panel, "Steps");
    expect(title(panel)).toBe("Loop");
    await swap(loopOf({ text: "Ticket B" }), "r-13");
    await swap(loopOf({ phase: "done" }), "r-13");
    expect(title(panel)).toBe("Runs");
  });

  it("forgets the choice when the seat goes from one loop straight to another", async () => {
    const panel = await open(loopOf());
    pick(panel, "Runs");
    await swap(loopOf({ text: "Ticket B" }), "r-13");
    expect(title(panel)).toBe("Loop");
    expect(panel.textContent).toContain("Ticket B");
  });

  it("shows the recent-runs subtitle on Runs only", async () => {
    const panel = await open(loopOf());
    expect(panel.textContent).not.toContain("recent runs");
    pick(panel, "Runs");
    await vi.waitFor(() => expect(panel.textContent).toContain("0 recent runs"));
    pick(panel, "Steps");
    expect(panel.textContent).not.toContain("recent runs");
  });

  it("marks the current step with aria-current", async () => {
    const panel = await open(loopOf({ phase: "ci" }));
    const cur = [...panel.querySelectorAll(".vstep")].filter(
      (x) => x.getAttribute("aria-current") === "step",
    );
    expect(cur.map((x) => x.querySelector(".vname")?.textContent)).toEqual(["CI"]);
  });
});

describe("Agent page: side tabs", () => {
  const sub = (over = {}) => ({
    taskId: "t1",
    type: "Explore",
    description: "find callers",
    status: "completed" as const,
    tokens: 12_300,
    toolUses: 5,
    durationMs: 42_000,
    ...over,
  });

  it("Plan shows the runtime placeholder; Queue waits on the engine", async () => {
    stub();
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const side = $(container, "#sideP") as HTMLElement;
    expect($(side, "#sideBody")?.textContent).toBe(
      "The loops' CLI has no task-list tool; the Plan tab fills when the agent runtime reports one (phase 2).",
    );
    fireEvent.click(within(side).getByRole("button", { name: "Queue" }));
    expect($(side, "#sideBody")?.textContent).toBe(ENGINE_NOT_RUNNING);
  });

  it("Subagents {n}: rows with type, task, pill, tokens, tool calls and duration", async () => {
    stub({
      rows: [
        crewRow({
          digest: digest({
            subagents: [sub(), sub({ taskId: "t2", status: "running", tokens: null })],
          }),
        }),
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const side = $(container, "#sideP") as HTMLElement;
    fireEvent.click(within(side).getByRole("button", { name: "Subagents 2" }));
    const rows = [...side.querySelectorAll<HTMLElement>(".subrow")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Explore");
    expect(rows[0]?.textContent).toContain("find callers");
    expect(rows[0]?.textContent).toContain("Done");
    expect(rows[0]?.textContent).toContain("12.3k tokens · 5 tool calls · 42s");
    expect(rows[1]?.textContent).toContain("Running");
    expect(rows[1]?.textContent).toContain("— tokens");
    expect(side.textContent).toContain(
      "Subagents this agent spawned. Their tokens count toward its totals.",
    );
  });

  it("Subagents 0 says none were spawned", async () => {
    stub();
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const side = $(container, "#sideP") as HTMLElement;
    fireEvent.click(within(side).getByRole("button", { name: "Subagents 0" }));
    expect($(side, "#sideBody")?.textContent).toBe("No subagents spawned this run.");
  });

  it("Files {n}: path, +add −del and state, with the note when present", async () => {
    stub({
      files: {
        files: [
          { path: "src/a.ts", add: 10, del: 2, state: "uncommitted" },
          { path: "img/logo.png", add: null, del: null, state: "committed" },
        ],
        note: "no origin/HEAD: showing uncommitted changes only",
        sha: null,
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const side = $(container, "#sideP") as HTMLElement;
    fireEvent.click(await within(side).findByRole("button", { name: "Files 2" }));
    const rows = [...side.querySelectorAll<HTMLElement>(".f")];
    expect(rows.map((r) => r.textContent)).toEqual([
      "src/a.ts+10 −2uncommitted",
      "img/logo.png—committed",
    ]);
    expect(side.textContent).toContain("no origin/HEAD: showing uncommitted changes only");
  });

  it("Files with none: No file changes yet.", async () => {
    stub();
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const side = $(container, "#sideP") as HTMLElement;
    fireEvent.click(await within(side).findByRole("button", { name: "Files 0" }));
    expect($(side, "#sideBody")?.textContent).toBe("No file changes yet.");
  });

  it("clicking a file shows its diff below the list, lines coloured by class; Close hides it", async () => {
    stub({
      files: {
        files: [
          { path: "src/a.ts", add: 1, del: 1, state: "committed" },
          { path: "img/logo.png", add: null, del: null, state: "uncommitted" },
        ],
        note: null,
        sha: null,
      },
      diffs: {
        "src/a.ts": {
          path: "src/a.ts",
          text: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old <b>x</b>\n+new\n same",
          truncated: true,
          binary: false,
          sha: null,
        },
        "img/logo.png": {
          path: "img/logo.png",
          text: "",
          truncated: false,
          binary: true,
          sha: null,
        },
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const side = $(container, "#sideP") as HTMLElement;
    fireEvent.click(await within(side).findByRole("button", { name: "Files 2" }));
    fireEvent.click(await within(side).findByRole("button", { name: /^src\/a\.ts/ }));
    const pre = await vi.waitFor(() => {
      const p = $(side, "pre.diff");
      expect(p).toBeTruthy();
      return p as HTMLElement;
    });
    // below the list
    const rows = side.querySelectorAll(".f");
    expect(
      (rows[rows.length - 1] as HTMLElement).compareDocumentPosition(pre) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const cls = (t: string) =>
      [...pre.querySelectorAll("span")].find((s) => s.textContent?.startsWith(t))?.className;
    expect(cls("@@")).toBe("h");
    expect(cls("-old")).toBe("d");
    expect(cls("+new")).toBe("a");
    expect(cls("+++ b/")).toBe("");
    expect(cls("--- a/")).toBe("");
    expect(cls(" same")).toBe("");
    // inert text, never HTML
    expect(pre.querySelector("b")).toBeNull();
    expect(pre.textContent).toContain("-old <b>x</b>");
    expect(side.textContent).toContain("Cut at 200 000 characters");
    fireEvent.click(within(side).getByRole("button", { name: /^img\/logo\.png/ }));
    expect(await within(side).findByText("Binary file")).toBeTruthy();
    expect($(side, "pre.diff")).toBeNull();
    fireEvent.click(within(side).getByRole("button", { name: "Close" }));
    expect(within(side).queryByText("Binary file")).toBeNull();
  });

  it("Review Focus 2: Files shows worktree missing for a 503", async () => {
    stub({ files: { status: 503, error: "worktree missing" } });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const side = $(container, "#sideP") as HTMLElement;
    fireEvent.click(within(side).getByRole("button", { name: /^Files/ }));
    expect(await within(side).findByText("worktree missing")).toBeTruthy();
  });

  it("Files shows the note under the error of a 502", async () => {
    stub({ files: { status: 502, error: "git failed", note: "Files may be missing: filtered" } });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const side = $(container, "#sideP") as HTMLElement;
    fireEvent.click(within(side).getByRole("button", { name: /^Files/ }));
    expect(await within(side).findByText("git failed")).toBeTruthy();
    expect(within(side).getByText("Files may be missing: filtered").className).toContain("note");
  });
});

const seat = (over: Partial<CrewRow> = {}) =>
  crewRow({
    id: "guido-1",
    repoId: "shop-app",
    index: 2,
    kind: "crew",
    loopKind: "crew",
    role: "GUIDO",
    mode: "writer",
    area: ["apps/web/**", "docs/**"],
    model: "sonnet",
    sessionId: "s1",
    ...over,
  });
const SEAT_ROUTES = (extra: Record<string, unknown> = {}) => ({
  "/api/seats/guido-1/context": null,
  "POST /api/seats/guido-1/message": { ok: true },
  "POST /api/seats/guido-1/interrupt": { ok: true },
  "POST /api/seats/guido-1/end": { ok: true },
  ...extra,
});
const bodyOf = (fn: ReturnType<typeof stub>, path: string) => {
  const call = fn.mock.calls.find((c) => c[0] === path);
  return call?.[1]?.body;
};
const seatLoaded = () => screen.findByText("GUIDO-1");
const idleSeat = () => seat({ hudState: "idle" });

describe("Agent page: driving a crew seat", () => {
  it("a crew seat's Activity panel shows its run's events, and Files a plain note", async () => {
    stub({
      rows: [seat(), studio()],
      files: { files: [], note: CREW_FILES_NOTE, sha: null },
      extra: SEAT_ROUTES(),
    });
    const { container } = render(<Agent id="guido-1" />);
    await seatLoaded();
    const activity = $(container, "#streamP") as HTMLElement;
    expect(await within(activity).findByText("Work on shop-app#3349")).toBeTruthy();
    expect(within(activity).getByText("The cache is in")).toBeTruthy();
    expect(activity.textContent).not.toContain("Could not load the activity");
    const side = $(container, "#sideP") as HTMLElement;
    const tab = within(side).getByRole("button", { name: /^Files/ });
    expect(tab.textContent).toBe("Files");
    fireEvent.click(tab);
    const note = await within(side).findByText(CREW_FILES_NOTE);
    expect(note.className).toContain("note");
    expect(side.querySelector(".crit-t")).toBeNull();
    expect(side.textContent).not.toContain("No file changes yet.");
  });

  it("shows the composer for a crew seat only", async () => {
    stub({ rows: [seat(), studio()], extra: SEAT_ROUTES() });
    const { unmount } = render(<Agent id="guido-1" />);
    await seatLoaded();
    const input = screen.getByLabelText("Message this agent") as HTMLInputElement;
    expect(input.placeholder).toBe("Message GUIDO-1…");
    expect((input as HTMLInputElement).disabled).toBe(false);
    unmount();
    render(<Agent id="studio-builder" />);
    await screen.findByText(/is an observed loop; messaging arrives/);
    expect((screen.getByLabelText("Message this agent") as HTMLInputElement).disabled).toBe(true);
  });

  it("Send posts {text}; Interrupt and send posts {text, interrupt: true}", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES() });
    render(
      <>
        <Agent id="guido-1" />
        <Toast />
      </>,
    );
    await seatLoaded();
    const input = screen.getByLabelText("Message this agent");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Delivered to GUIDO-1.")).toBeTruthy();
    expect(JSON.parse(bodyOf(f, "/api/seats/guido-1/message") as string)).toEqual({
      text: "hello",
    });
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.change(input, { target: { value: "  stop it" } });
    const btn = screen.getByRole("button", { name: "Interrupt and send" });
    expect(btn.getAttribute("title")).toBe("Stop the current turn, then send");
    fireEvent.click(btn);
    await vi.waitFor(() =>
      expect(f.mock.calls.filter((c) => c[0] === "/api/seats/guido-1/message").length).toBe(2),
    );
    const last = f.mock.calls.filter((c) => c[0] === "/api/seats/guido-1/message")[1];
    expect(JSON.parse(last?.[1]?.body as string)).toEqual({ text: "  stop it", interrupt: true });
  });

  it("sends the text exactly as typed, leading spaces included", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES() });
    render(
      <>
        <Agent id="guido-1" />
        <Toast />
      </>,
    );
    await seatLoaded();
    fireEvent.change(screen.getByLabelText("Message this agent"), {
      target: { value: "  - item" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Delivered to GUIDO-1.")).toBeTruthy();
    expect(JSON.parse(bodyOf(f, "/api/seats/guido-1/message") as string)).toEqual({
      text: "  - item",
    });
  });

  it("keeps trailing spaces too", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES() });
    render(<Agent id="guido-1" />);
    await seatLoaded();
    fireEvent.change(screen.getByLabelText("Message this agent"), { target: { value: "ok  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await vi.waitFor(() => expect(bodyOf(f, "/api/seats/guido-1/message")).toBeDefined());
    expect(JSON.parse(bodyOf(f, "/api/seats/guido-1/message") as string)).toEqual({ text: "ok  " });
  });

  it("a whitespace-only input toasts and posts nothing", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES() });
    render(
      <>
        <Agent id="guido-1" />
        <Toast />
      </>,
    );
    await seatLoaded();
    fireEvent.change(screen.getByLabelText("Message this agent"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Type a message first.")).toBeTruthy();
    expect(bodyOf(f, "/api/seats/guido-1/message")).toBeUndefined();
  });

  it("an empty input toasts and posts nothing", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES() });
    render(
      <>
        <Agent id="guido-1" />
        <Toast />
      </>,
    );
    await seatLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("status").textContent).toBe("Type a message first.");
    expect(bodyOf(f, "/api/seats/guido-1/message")).toBeUndefined();
  });

  it("a refusal shows inline", async () => {
    stub({
      rows: [seat()],
      extra: SEAT_ROUTES({
        "POST /api/seats/guido-1/message": () => ({
          status: 409,
          body: { error: "crew is disabled on this server" },
        }),
      }),
    });
    render(<Agent id="guido-1" />);
    await seatLoaded();
    fireEvent.change(screen.getByLabelText("Message this agent"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe("crew is disabled on this server");
  });

  it("the hint follows the state", async () => {
    stub({ rows: [seat()], extra: SEAT_ROUTES() });
    const a = render(<Agent id="guido-1" />);
    await seatLoaded();
    expect(a.container.querySelector(".hint")?.textContent).toBe(
      "Reaches GUIDO-1 mid-turn, alongside its next tool result. Smaller models can ignore a mid-turn note; use Interrupt and send if it matters.",
    );
    a.unmount();
    stub({ rows: [idleSeat()], extra: SEAT_ROUTES() });
    const b = render(<Agent id="guido-1" />);
    await seatLoaded();
    expect(b.container.querySelector(".hint")?.textContent).toBe(
      "GUIDO-1 is idle; your message starts its next turn.",
    );
    b.unmount();
    stub({ rows: [seat({ hudState: "idle", run: null })], extra: SEAT_ROUTES() });
    const c = render(<Agent id="guido-1" />);
    await seatLoaded();
    expect(c.container.querySelector(".hint")?.textContent).toBe(
      "GUIDO-1 has no live session; start it on a ticket from the Board.",
    );
  });

  it("the composer hint is the input's accessible description, for a crew seat and an observed loop", async () => {
    stub({ rows: [seat(), studio()], extra: SEAT_ROUTES() });
    const a = render(<Agent id="guido-1" />);
    await seatLoaded();
    const seatHintText = a.container.querySelector(".hint")?.textContent ?? "";
    expect(seatHintText).toContain("Reaches GUIDO-1 mid-turn");
    expect(
      screen.getByRole("textbox", { name: "Message this agent", description: seatHintText }),
    ).toBeTruthy();
    a.unmount();
    render(<Agent id="studio-builder" />);
    await screen.findByText(/is an observed loop; messaging arrives/);
    expect(
      screen.getByRole("textbox", {
        name: "Message this agent",
        description: /is an observed loop; messaging arrives/,
      }),
    ).toBeTruthy();
  });

  it("the header names role, mode, model, account and area; loops are unchanged", async () => {
    stub({
      rows: [seat({ cli: { version: "2.1.302", effort: "high" } }), studio()],
      extra: SEAT_ROUTES(),
    });
    const a = render(<Agent id="guido-1" />);
    await seatLoaded();
    const chips = a.container.querySelector("#ahead .chips")?.textContent ?? "";
    expect(chips).toContain("GUIDO");
    expect(chips).toContain("writer");
    expect(chips).toContain("claude-main · claude-opus-4-1 · high · CLI 2.1.302");
    expect(chips).toContain("area: apps/web/**, docs/**");
    expect(chips).not.toContain("observed loop");
    a.unmount();
    const b = render(<Agent id="studio-builder" />);
    await screen.findByText(/is an observed loop; messaging arrives/);
    expect(b.container.querySelector("#ahead .chips")?.textContent).toContain("observed loop");
    expect(screen.queryByRole("button", { name: "End the run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Interrupt" })).toBeNull();
  });

  it("a read-only seat's area reads read-only", async () => {
    stub({ rows: [seat({ mode: "read-only", area: [], role: "INCO" })], extra: SEAT_ROUTES() });
    const a = render(<Agent id="guido-1" />);
    await seatLoaded();
    expect(a.container.querySelector("#ahead .chips")?.textContent).toContain("area: read-only");
  });

  it("the header says scratch review copy for a scratch seat", async () => {
    stub({ rows: [seat({ mode: "scratch", area: [], role: "RETRO" })], extra: SEAT_ROUTES() });
    const a = render(<Agent id="guido-1" />);
    await seatLoaded();
    expect(a.container.querySelector("#ahead .chips")?.textContent).toContain(
      "area: scratch review copy",
    );
  });

  it("End the run confirms, then posts {}", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES() });
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<Agent id="guido-1" />);
    await seatLoaded();
    const end = screen.getByRole("button", { name: "End the run" });
    fireEvent.click(end);
    expect(ask).toHaveBeenCalledWith(
      "End GUIDO-1's run? The checkout and branch stay; nothing is pushed.",
    );
    expect(bodyOf(f, "/api/seats/guido-1/end")).toBeUndefined();
    fireEvent.click(end);
    await vi.waitFor(() => expect(bodyOf(f, "/api/seats/guido-1/end")).toBe("{}"));
    ask.mockRestore();
  });

  it("Interrupt posts {}", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES() });
    render(<Agent id="guido-1" />);
    await seatLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    await vi.waitFor(() => expect(bodyOf(f, "/api/seats/guido-1/interrupt")).toBe("{}"));
  });

  it("the Context tile renders the categories from the seat's usage", async () => {
    stub({
      rows: [seat({ contextWindow: 200_000 })],
      extra: SEAT_ROUTES({
        "/api/seats/guido-1/context": {
          categories: [
            { name: "System prompt", tokens: 3000 },
            { name: "System tools", tokens: 12_000 },
            { name: "Messages", tokens: 40_000 },
            { name: "Free space", tokens: 145_000 },
          ],
          total: 55_000,
          window: 200_000,
        },
      }),
    });
    const a = render(<Agent id="guido-1" />);
    await seatLoaded();
    const tile = (await screen.findByText(/msgs 40k/)).closest(".tile2") as HTMLElement;
    expect(tile.textContent).toContain("28% of 200k");
    expect(tile.textContent).toContain("msgs 40k · tools 12k · system 3k · —");
    expect(tile.querySelectorAll(".ctxbar i").length).toBeGreaterThanOrEqual(3);
    a.unmount();
  });

  it("`i` interrupts a crew seat", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES() });
    const off = installKeys({
      navigate: () => {},
      toggleDock: () => {},
      help: () => {},
      selectNext: () => {},
      selectPrev: () => {},
      toast,
    });
    render(<Agent id="guido-1" />);
    await seatLoaded();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "i" }));
    });
    await vi.waitFor(() => expect(bodyOf(f, "/api/seats/guido-1/interrupt")).toBe("{}"));
    off();
  });
});

describe("Agent page: agent text is formatted", () => {
  const nowTile = (c: HTMLElement) => $(c, ".tile2.now .nowt") as HTMLElement;
  const idle = (summary: string) =>
    crewRow({ hudState: "blocked", run: null, ticket: null, ticketTitle: null, summary });

  it("the Now tile's summary is its hover text, as written", async () => {
    stub({ rows: [idle("Cached **quotes** via `refresh()`")] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await waitFor(() => expect(nowTile(container).querySelector("strong")).not.toBeNull());
    expect(nowTile(container).getAttribute("title")).toBe("Cached **quotes** via `refresh()`");
  });

  it("a running row with no ticket has no hover text on its Now line", async () => {
    stub({ rows: [crewRow({ ticket: null, ticketTitle: null, summary: "Cached quotes" })] });
    const { container } = render(<Agent id="shop-app-ta" />);
    await screen.findByText("No ticket");
    expect(nowTile(container).getAttribute("title")).toBeNull();
  });

  it("the Now tile's summary and the banner's Parked reason render Markdown on one line", async () => {
    stub({
      rows: [idle("Cached **quotes** via `refresh()`")],
      items: [item({ key: "p:1", kind: "parked", text: "wait for **the operator**" })],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await screen.findByText("the operator");
    expect(nowTile(container).querySelector("strong")?.textContent).toBe("quotes");
    expect(nowTile(container).querySelector("code")?.textContent).toBe("refresh()");
    expect(nowTile(container).querySelector("p, div")).toBeNull();
    const banner = $(container, "#needBanner .banner") as HTMLElement;
    expect(banner.querySelector("strong")?.textContent).toBe("the operator");
    expect(banner.textContent).toContain("Parked: wait for the operator");
    expect(banner.textContent).not.toContain("**");
  });

  it("keeps the Now tile and the banner to one line: a list marker is not a list", async () => {
    stub({
      rows: [idle("1. retry")],
      items: [item({ key: "p:1", kind: "parked", text: "1. retry" })],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await screen.findByText("Parked: 1. retry");
    expect(nowTile(container).textContent).toBe("1. retry");
    expect(nowTile(container).querySelector("p, ul, ol, pre, .md")).toBeNull();
    for (const part of container.querySelectorAll("#needBanner .needpart")) {
      expect(part.querySelector("p, ul, ol, pre, .md")).toBeNull();
    }
  });

  it.each(["__init__.py", "a*b", "1.", "-"])("plain prose %j is unchanged", async (text) => {
    stub({
      rows: [idle(text)],
      items: [item({ key: "p:1", kind: "parked", text })],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await screen.findByText(`Parked: ${text}`);
    expect(nowTile(container).textContent).toBe(text);
    expect(nowTile(container).children).toHaveLength(0);
  });
});

describe("Agent page: the header pill", () => {
  it("says what a seat is doing, by seatStatus", async () => {
    const loop = { phase: "ci" as const, text: "CI on 08a7cfc", prNumber: 9, parked: null };
    stub({ rows: [seat({ hudState: "idle", loop }), studio()], extra: SEAT_ROUTES() });
    const { container } = render(<Agent id="guido-1" />);
    await seatLoaded();
    expect($(container, "#ahead .pill")?.textContent).toBe("Waiting on CI");
  });
});
