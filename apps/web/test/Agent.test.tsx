import {
  ACK_BATCH_MAX,
  type AgentStream,
  type AttentionItem,
  type ChangedFiles,
  type CommsEvent,
  type CrewChanges,
  type CrewLoop,
  type CrewRow,
  DEFAULT_PROFILES,
  type FileDiff,
  type LimitRow,
  type LoopTry,
  METER_FULL_PCT,
  METER_WARN_PCT,
  READONLY_FILES_NOTE,
  type ReviewStatus,
  type RunDigest,
  type RunLoop,
  type RunLoopView,
  type RunView,
  type TicketView,
} from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_LOOP } from "../src/crew.ts";
import { hub } from "../src/data.ts";
import { Agent } from "../src/pages/Agent.tsx";
import { installKeys } from "../src/shell/keys.ts";
import { setSelectedAgent } from "../src/shell/selection.ts";
import { setSession } from "../src/shell/session.ts";
import { Toast, toast } from "../src/shell/Toast.tsx";
import { settled, stubFetch } from "./fetchStub.ts";
import {
  boardItem,
  CONFIG,
  CREW_CONFIG,
  crewRow,
  HOUR,
  item,
  limit5h,
  MIN,
  NOW,
  prView,
  run,
  SESSION_CONFIG,
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

const comms = (over: Partial<CommsEvent> = {}): CommsEvent => ({
  at: NOW,
  kind: "comms",
  who: "guido-1",
  to: "CAPCOM",
  text: "x",
  ref: null,
  url: null,
  status: null,
  prs: [],
  summary: null,
  ...over,
});

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
    stub({ items: [item()], extra: { "/api/config": SESSION_CONFIG } });
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

    act(() => setSession("site-builder-session"));
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

  it("/agent with nothing selected opens on the first running crew seat, else the first crew seat", async () => {
    const rows = [
      studio({ index: 0 }),
      seatRow({ id: "guido-1", index: 1, hudState: "idle" }),
      seatRow({ id: "guido-2", index: 2, hudState: "running" }),
    ];
    stub({ rows });
    act(() => setSelectedAgent(null));
    const running = render(<Agent id={null} />);
    await vi.waitFor(() =>
      expect($(running.container, "#ahead .big")?.textContent).toContain("GUIDO-2"),
    );
    running.unmount();
    hub.clear();
    stub({ rows: rows.map((r) => ({ ...r, hudState: "idle" as const })) });
    act(() => setSelectedAgent(null));
    const idle = render(<Agent id={null} />);
    await vi.waitFor(() =>
      expect($(idle.container, "#ahead .big")?.textContent).toContain("GUIDO-1"),
    );
  });

  it("an agent in the path stays selected over the crew-seat default", async () => {
    stub({ rows: [studio({ index: 0 }), seatRow({ index: 1, hudState: "running" })] });
    act(() => setSelectedAgent(null));
    const { container } = render(<Agent id="studio-builder" />);
    await vi.waitFor(() => expect($(container, "#ahead .big")?.textContent).toBe("studio-builder"));
  });

  it.each([
    [false, "GUIDO-1 · Backend developer", null],
    [true, "GUIDO-1", "Backend developer"],
  ])("the header names a crew seat's role: narrow %s", async (narrow, text, title) => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: narrow,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    stub({ rows: [seatRow({ hudState: "idle" })] });
    const { container } = render(<Agent id="guido-1" />);
    await vi.waitFor(() => expect($(container, "#ahead .idrow .big")?.textContent).toBe(text));
    expect($(container, "#ahead .idrow .big")?.getAttribute("title")).toBe(title);
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

  describe("a stalled crew seat", () => {
    const stall = item({
      key: "stall:guido-1:r-12",
      agentId: "guido-1",
      kind: "stalled",
      at: NOW - 11 * MIN,
      tool: "Bash",
      ticket: null,
      escalationId: null,
    });
    const rows = () => [seat({ hudState: "stalled", lastOutputAt: NOW - 11 * MIN }), studio()];
    const banner = (container: HTMLElement) => $(container, "#needBanner .banner") as HTMLElement;

    it("holding the test lock shows the Overview's line with Stop the run", async () => {
      const fn = stub({
        rows: rows(),
        items: [stall],
        extra: SEAT_ROUTES({
          "/api/test-lock": {
            holder: { runId: "r-12", seatId: "guido-1", command: "pnpm -s test", since: NOW - MIN },
            waiting: [
              { runId: "r-2", seatId: "retro-1", command: "pnpm -s test", since: NOW - MIN },
              { runId: "r-3", seatId: "inco-1", command: "pnpm -s test", since: NOW - MIN },
            ],
          },
        }),
      });
      const { container } = render(<Agent id="guido-1" />);
      await waitFor(() =>
        expect(banner(container).textContent).toContain(
          "Stalled 11:00 and holding the test lock; 2 waiting",
        ),
      );
      fireEvent.click(within(banner(container)).getByRole("button", { name: "Stop the run" }));
      await waitFor(() => expect(bodyOf(fn, "/api/seats/guido-1/interrupt")).toBe("{}"));
    });

    it("holding nothing shows Interrupt", async () => {
      const fn = stub({
        rows: rows(),
        items: [stall],
        extra: SEAT_ROUTES({ "/api/test-lock": { holder: null, waiting: [] } }),
      });
      const { container } = render(<Agent id="guido-1" />);
      await waitFor(() => expect(banner(container).textContent).toContain("Stalled 11:00 in Bash"));
      expect(within(banner(container)).queryByRole("button", { name: "Stop the run" })).toBeNull();
      fireEvent.click(within(banner(container)).getByRole("button", { name: "Interrupt" }));
      await waitFor(() => expect(bodyOf(fn, "/api/seats/guido-1/interrupt")).toBe("{}"));
    });
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

  it("Ack leaves a set-aside run's unacked note alone: the banner does not show it", async () => {
    const ready = {
      ...item({ key: "note:ready:old", ticket: "shop-app#3000", escalationId: null }),
      kind: "ready",
    } as unknown as AttentionItem;
    const fetch = stub({
      items: [
        item({
          key: "stall:shop-app-ta:r-12",
          kind: "stalled",
          at: NOW - 12 * MIN,
          tool: "Bash",
          ticket: null,
          escalationId: null,
        }),
        ready,
      ],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const banner = $(container, "#needBanner .banner") as HTMLElement;
    expect(banner.textContent).toContain("Stalled 12:00 in Bash");
    expect(banner.textContent).not.toContain("Ready to merge");
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
    expect(body.keys).toEqual(["stall:shop-app-ta:r-12"]);
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
          work: { commits: 1, denials: 0 },
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
    expect($(tile("Speed"), ".v")?.textContent).toBe("—tokens/s");
    expect($(tile("Work"), ".v")?.textContent).toBe("37tool calls");
    await waitFor(() =>
      expect($(tile("Work"), ".d")?.textContent).toBe("21 turns · 1 commit · +0 −0 · ⊘0"),
    );
    expect(tile("Quota · claude-main").textContent).toContain("5h 41%");
  });

  const tileOf = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll<HTMLElement>(".tile2")].find((t) =>
      t.querySelector(".lbl")?.textContent?.startsWith(label),
    ) as HTMLElement;

  it("~Cost shows the live estimate while running and costUsd once the run has ended", async () => {
    const base = crewRow().run as NonNullable<CrewRow["run"]>;
    const cases = [
      [{ ...base, costEstimateUsd: 3.1 }, "running", "~$3.10"],
      [
        { ...base, status: "ok", endedAt: NOW - MIN, costEstimateUsd: 3.1, costUsd: 2.4712 },
        "idle",
        "~$2.47",
      ],
      [{ ...base, costEstimateUsd: null }, "running", "~$2.47"],
    ] as const;
    for (const [r, hudState, want] of cases) {
      hub.clear();
      stub({
        rows: [crewRow({ digest: digest(), contextWindow: 200_000, run: r, hudState })],
      });
      const { container, unmount } = render(<Agent id="shop-app-ta" />);
      await screen.findByText(/Quote cache/);
      expect($(tileOf(container, "~Cost"), ".v")?.textContent).toBe(want);
      unmount();
    }
  });

  it("Speed shows tokens/s and the mean turn from digest.speed, — without it", async () => {
    stub({
      rows: [
        crewRow({
          digest: digest({ speed: { tokensPerSec: 64.4, turnMs: 160_000, firstTokenMs: 1200 } }),
          contextWindow: 200_000,
        }),
      ],
    });
    const first = render(<Agent id="shop-app-ta" />);
    await loaded();
    const speed = tileOf(first.container, "Speed");
    expect($(speed, ".v")?.textContent).toBe("64tokens/s");
    expect($(speed, ".d")?.textContent).toBe("first token 1.2s · turn 2m 40s");
    expect(speed.textContent).not.toContain("phase 2");
    first.unmount();
    hub.clear();
    cleanup();
    stub({ rows: [crewRow({ digest: digest(), contextWindow: 200_000 })] });
    const second = render(<Agent id="shop-app-ta" />);
    await loaded();
    expect($(tileOf(second.container, "Speed"), ".v")?.textContent).toBe("—tokens/s");
    expect($(tileOf(second.container, "Speed"), ".d")?.textContent).toBe("first token — · turn —");
  });

  it("Work sums +add −del from the Files list and shows commits and ⊘denials from row.work", async () => {
    stub({
      rows: [
        crewRow({ digest: digest(), contextWindow: 200_000, work: { commits: 2, denials: 3 } }),
      ],
      files: {
        files: [
          { path: "a.ts", add: 10, del: 2, state: "uncommitted" },
          { path: "b.ts", add: 5, del: null, state: "committed" },
          { path: "logo.png", add: null, del: null, state: "committed" },
        ],
        note: null,
        sha: null,
      },
    });
    const first = render(<Agent id="shop-app-ta" />);
    await loaded();
    const work = () => tileOf(first.container, "Work");
    await waitFor(() =>
      expect($(work(), ".d")?.textContent).toBe("21 turns · 2 commits · +15 −2 · ⊘3"),
    );
    expect($(work(), ".add")?.textContent).toBe("+15");
    expect($(work(), ".del")?.textContent).toBe("−2");
    first.unmount();
    hub.clear();
    cleanup();
    stub({ rows: [crewRow({ digest: null, contextWindow: 200_000 })] });
    const second = render(<Agent id="shop-app-ta" />);
    await loaded();
    expect($(tileOf(second.container, "Work"), ".d")?.textContent).toBe("—");
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

  it("a seat's messages since its run started are agents rows under All and Messages", async () => {
    const TAG = "@" + "CAPCOM";
    stub({
      rows: [seatRow({ digest: digest() })],
      extra: {
        "/api/activity": [
          comms({ at: NOW - 5 * MIN, who: "guido-1", text: `Should the cache expire? ${TAG}` }),
          comms({
            at: NOW - 20 * MIN,
            who: "flight",
            to: "guido-1",
            text: "Assigned the quote cache ticket",
          }),
          comms({ at: NOW - 30 * MIN, who: "flight", to: "guido-1", text: "Old line" }),
        ],
      },
    });
    const { container } = render(<Agent id="guido-1" />);
    await loaded();
    const rows = () => [...container.querySelectorAll<HTMLElement>("#stream .ev")];
    const who = () => rows().map((r) => r.querySelector(".who")?.textContent);
    await waitFor(() => expect(who()).toContain("agents"));
    expect(who()).toEqual(["agents", "prompt", "thinking", "tool", "to you", "system", "agents"]);
    expect(rows()[0]?.querySelector(".txt")?.textContent).toBe(
      "← FLIGHT: Assigned the quote cache ticket",
    );
    const last = rows().at(-1)?.querySelector(".txt") as HTMLElement;
    expect(last.textContent).toContain("→ You: Should the cache expire?");
    expect($(last, ".mention")?.textContent).toBe(TAG);
    expect(container.textContent).not.toContain("Old line");
    const seg = screen.getByRole("group", { name: "Activity filter" });
    fireEvent.click(within(seg).getByRole("button", { name: "Messages" }));
    expect(who()).toEqual(["agents", "prompt", "to you", "system", "agents"]);
    fireEvent.click(within(seg).getByRole("button", { name: "Thinking" }));
    expect(who()).toEqual(["thinking"]);
    fireEvent.click(within(seg).getByRole("button", { name: "Tools" }));
    expect(who()).toEqual(["tool"]);
  });

  it("filters: Messages (prompt, to you, agents, system), Thinking, Tools, and Guard's placeholder", async () => {
    stub({
      extra: {
        "/api/activity": [
          comms({ at: NOW - 5 * MIN, who: "flight", to: "shop-app-ta", text: "Report status" }),
        ],
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const who = () => [...container.querySelectorAll("#stream .ev .who")].map((w) => w.textContent);
    await waitFor(() => expect(who()).toContain("agents"));
    const seg = screen.getByRole("group", { name: "Activity filter" });
    fireEvent.click(within(seg).getByRole("button", { name: "Messages" }));
    expect(who()).toEqual(["prompt", "to you", "system", "agents"]);
    fireEvent.click(within(seg).getByRole("button", { name: "Thinking" }));
    expect(who()).toEqual(["thinking"]);
    fireEvent.click(within(seg).getByRole("button", { name: "Tools" }));
    expect(who()).toEqual(["tool"]);
    fireEvent.click(within(seg).getByRole("button", { name: "Guard" }));
    expect(who()).toEqual([]);
    expect($(container, "#stream")?.textContent).toContain("No guard hits in this run.");
    fireEvent.click(within(seg).getByRole("button", { name: "All" }));
    expect(who()).toHaveLength(6);
  });

  it("Guard shows this run's hits for this seat, and All shows them in time order", async () => {
    const hit = (id: number, over: Record<string, unknown> = {}) => ({
      id,
      agentId: "shop-app-ta",
      runId: "r-12",
      rule: "git-write",
      text: `git writes only through the mc tools (${id})`,
      at: NOW - 8.5 * MIN,
      acked: false,
      ...over,
    });
    stub({
      extra: {
        "/api/guard/hits?days=7": {
          hits: [
            hit(1),
            hit(2, { agentId: "studio-builder", text: "another seat's hit" }),
            hit(3, { runId: "r-11", text: "an older run's hit" }),
          ],
          counts: { "git-write": 3 },
        },
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const who = () => [...container.querySelectorAll("#stream .ev .who")].map((w) => w.textContent);
    const seg = screen.getByRole("group", { name: "Activity filter" });
    fireEvent.click(within(seg).getByRole("button", { name: "Guard" }));
    await waitFor(() => expect(who()).toEqual(["guard"]));
    const text = $(container, "#stream")?.textContent ?? "";
    expect(text).toContain("git writes only through the mc tools (1)");
    expect(text).not.toContain("another seat's hit");
    expect(text).not.toContain("an older run's hit");
    fireEvent.click(within(seg).getByRole("button", { name: "All" }));
    expect(who()).toEqual(["prompt", "thinking", "guard", "tool", "to you", "system"]);
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

  it("the live call bar names the waiting suite, command, timer and holder", async () => {
    // the queued Bash call is still the live tool while its hook waits for the lock
    const row = crewRow({
      digest: digest({ liveTool: { name: "Bash", since: NOW - 125_000 } }),
      hudState: "waiting",
    });
    stub({
      rows: [row],
      extra: {
        "/api/test-lock": {
          holder: { runId: "other", seatId: "guido-2", command: "pnpm test", since: NOW },
          waiting: [
            { runId: row.run?.id, seatId: row.id, command: "pnpm -s test", since: NOW - 125_000 },
          ],
        },
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    await waitFor(() =>
      expect($(container, "#liveCall .livecall")?.textContent).toBe(
        "⏸ Waiting for the test lock: shop-app full suite (pnpm -s test) 2:05 behind GUIDO-2",
      ),
    );
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
        "shop-app-ta is an observed loop: Mission Control watches it and does not message it.",
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

  it("a closed run PR shows a Closed pill; an open one shows none", async () => {
    const pull = (number: number, state: "closed" | "open") => ({
      repoId: "shop-app",
      number,
      title: null,
      url: `https://github.com/octo-org/shop-app/pull/${number}`,
      state,
      ticket: "shop-app#3227",
    });
    stub({
      runs: [rv({ ticket: "shop-app#3227", prs: [pull(3240, "closed"), pull(3241, "open")] })],
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await loaded();
    const cell = $(container, "#loopP .runrow:not(.head) .rticket") as HTMLElement;
    const closed = within(cell).getByRole("link", { name: "shop-app PR #3240" }).closest(".rpr");
    const pill = closed?.querySelector(".pill");
    expect(pill?.textContent).toBe("Closed");
    expect(pill?.className).toBe("pill plain");
    const open = within(cell).getByRole("link", { name: "shop-app PR #3241" }).closest(".rpr");
    expect(open?.querySelector(".pill")).toBeNull();
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
    expect(panel.textContent).toContain(NO_LOOP);
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

  it("a bugfix run in CI shows the bugfix profile's steps with the CI step current", async () => {
    const panel = await open(
      loopOf({
        phase: "ci",
        profile: "bugfix",
        step: "verify",
        steps: DEFAULT_PROFILES.find((p) => p.name === "bugfix")?.steps,
        planned: false,
      }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Steps" }));
    expect(dots(panel)).toEqual([
      ["reproduce", "1"],
      ["fix", "✓"],
      ["draft PR", "3"],
      ["verify", "●"],
      ["review", "5"],
      ["merge", "6"],
    ]);
    expect(panel.querySelector('[aria-current="step"] .vname')?.textContent).toBe("verify");
  });

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

  describe("from the run's loop view", () => {
    const LOOP_ROUTE = "/api/runs/r-12/loop";
    const PRS_ROUTE = "/api/repos/shop-app/prs?linked=1";
    const PUSH = "abc1234def5678";
    const triesAt = (
      step: LoopTry["step"],
      n: number,
      outcome: LoopTry["outcome"],
      over: Partial<LoopTry> = {},
    ): LoopTry => ({
      step,
      fix: false,
      n,
      startedAt: NOW - 20 * MIN,
      endedAt: NOW - 10 * MIN,
      outcome,
      reason: null,
      tokens: 0,
      ...over,
    });
    const viewOf = (
      phase: RunLoop["phase"],
      tries: LoopTry[],
      over: Partial<RunLoopView> = {},
    ): RunLoopView => ({
      runId: "r-12",
      loop: { phase, prNumber: 77, pushFor: PUSH, epoch: 1, budgetExtra: 0 } as RunLoop,
      events: [],
      tries,
      round: 1,
      budget: null,
      review: null,
      ...over,
    });
    const pr77 = (over = {}) => prView({ number: 77, headSha: PUSH, ...over });
    const openLoop = async (
      loop: CrewLoop,
      view: RunLoopView | null,
      more: { prs?: unknown[]; runs?: RunView[]; run?: Partial<NonNullable<CrewRow["run"]>> } = {},
    ) => {
      const base = seat(loop);
      const row = more.run ? { ...base, run: { ...(base.run as object), ...more.run } } : base;
      stub({
        rows: [row as CrewRow],
        runs: more.runs ?? [],
        extra: {
          ...(view ? { [LOOP_ROUTE]: view } : {}),
          [PRS_ROUTE]: more.prs ?? [],
        },
      });
      const { container } = render(<Agent id="shop-app-ta" />);
      await loaded();
      return $(container, "#loopP") as HTMLElement;
    };
    const marks = (panel: HTMLElement) =>
      dots(panel)
        .map((d) => d[1])
        .join(" ");
    const checks = (panel: HTMLElement) =>
      [...panel.querySelectorAll<HTMLElement>(".check")].map((c) => c.textContent);

    it("a run in CI", async () => {
      const ci = loopOf({ phase: "ci", text: "CI is running", prNumber: 77 });
      const tries = [triesAt("working", 1, "pass"), triesAt("ci", 1, "running", { endedAt: null })];
      const panel = await openLoop(ci, viewOf("ci", tries), { prs: [pr77({ ci: "pending" })] });
      await waitFor(() => expect(checks(panel)).toEqual(["◌ runningCI on abc1234"]));
      expect(marks(panel)).toBe("✓ ● 3 4");
      cleanup();
      const quiet = await openLoop(ci, viewOf("ci", tries), { prs: [pr77({ ci: null })] });
      await waitFor(() =>
        expect(checks(quiet)).toEqual(["· waitingCI on abc1234: no CI reported yet"]),
      );
    });

    it("review round 2 of 3", async () => {
      const reason = "RETRO-1 reviewed abc1234: 2 blocking, 0 minor";
      const tries = [
        triesAt("working", 1, "pass"),
        triesAt("review", 1, "fail", { reason }),
        triesAt("review", 1, "pass", { fix: true }),
        triesAt("ci", 2, "pass"),
        triesAt("review", 2, "running", { endedAt: null }),
      ];
      const review: ReviewStatus = { state: "pending", description: "QA review running" };
      const panel = await openLoop(
        loopOf({ phase: "review", text: "In review", prNumber: 77 }),
        viewOf("review", tries, { round: 2, review }),
      );
      await waitFor(() => expect(panel.textContent).toContain("Round 2 of 3"));
      const step = [...panel.querySelectorAll<HTMLElement>(".vstep")][2] as HTMLElement;
      expect($(step, ".titer")?.textContent).toBe("×2");
      expect($(step, ".vfail")?.textContent).toBe(`Last failure: ${reason}`);
      expect([...step.querySelectorAll(".att")].map((a) => a.firstChild?.textContent)).toEqual([
        "try 1",
        "fix",
        "try 2",
      ]);
      expect(checks(step)).toEqual(["◌ runningQA review running", "· waitingPR #77 merged"]);
      expect(panel.textContent).not.toContain("—");
    });

    it("parked", async () => {
      const why = "CI failed 3 times; last on abc1234";
      const tries = [
        triesAt("working", 1, "pass"),
        triesAt("ci", 1, "fail"),
        triesAt("ci", 2, "fail"),
        triesAt("ci", 3, "parked", { reason: why }),
      ];
      const panel = await openLoop(
        loopOf({ phase: "parked", text: `Blocked: ${why}`, parked: why, prNumber: 77 }),
        viewOf("parked", tries),
      );
      await waitFor(() => expect(marks(panel)).toBe("✓ ! 3 4"));
      const ci = [...panel.querySelectorAll<HTMLElement>(".vstep")][1] as HTMLElement;
      expect(ci.textContent).toContain(`Blocked: ${why}`);
      expect(ci.textContent).toContain(`parked: ${why}`);
      expect(panel.querySelector(".vhold")).toBeNull();
    });

    it("the run's limits", async () => {
      const profile = DEFAULT_PROFILES.find((p) => p.name === "small-change");
      expect(profile).toBeDefined();
      const panel = await openLoop(
        loopOf({ phase: "ci", text: "CI is running", prNumber: 77 }),
        viewOf("ci", [
          triesAt("working", 1, "pass"),
          triesAt("ci", 1, "running", { endedAt: null }),
        ]),
        {
          runs: [
            rv({
              profile: {
                profile: profile as never,
                route: { by: "label", label: "chore" },
                hash: "h",
              },
            }),
          ],
        },
      );
      await waitFor(() => expect(panel.textContent).toContain("Round 1 of 2"));
      const ci = [...panel.querySelectorAll<HTMLElement>(".vstep")][1] as HTMLElement;
      expect($(ci, ".vrule")?.textContent).toBe(
        "↻ fail → back to Working · parks after 2 failures",
      );
    });

    it("the loop's own counter", async () => {
      const panel = await open(loopOf({ phase: "ci", tries: { n: 2, max: 3 } }));
      const ci = [...panel.querySelectorAll<HTMLElement>(".vstep")][1] as HTMLElement;
      expect($(ci, ".titer")?.textContent).toBe("×2");
    });

    it("budget header", async () => {
      const ci = loopOf({ phase: "ci", text: "CI is running", prNumber: 77 });
      const tries = [triesAt("working", 1, "pass")];
      const tokens = { input: 30_000, output: 20_000, cacheRead: 0, cacheCreate: 0 };
      const panel = await openLoop(ci, viewOf("ci", tries, { budget: 200_000 }), {
        run: { tokens },
      });
      await waitFor(() => expect($(panel, ".budget")).not.toBeNull());
      const header = $(panel, ".budget") as HTMLElement;
      expect(header.textContent).toContain("Tokens 50.0k of 200k");
      expect(($(header, ".mbar i") as HTMLElement).style.width).toBe("25%");
      cleanup();
      const open = await openLoop(ci, viewOf("ci", tries, { budget: null }), { run: { tokens } });
      await waitFor(() => expect($(open, ".budget")).not.toBeNull());
      const bare = $(open, ".budget") as HTMLElement;
      expect(bare.textContent).toContain("Tokens 50.0k");
      expect(bare.textContent).not.toContain(" of 2");
      expect(bare.textContent).not.toMatch(/Tokens 50\.0k of/);
      expect(bare.querySelectorAll(".mbar")).toHaveLength(1);
    });

    it("timeline", async () => {
      const s = NOW - 40 * MIN;
      const tries = [
        triesAt("working", 1, "pass", { startedAt: s, endedAt: s + 10 * MIN }),
        triesAt("ci", 1, "fail", {
          startedAt: s + 10 * MIN,
          endedAt: s + 19 * MIN,
          reason: "CI failed on abc1234",
        }),
        triesAt("ci", 2, "pass", { startedAt: s + 20 * MIN, endedAt: s + 30 * MIN }),
        triesAt("review", 1, "running", { startedAt: s + 30 * MIN, endedAt: null }),
      ];
      const panel = await openLoop(
        loopOf({ phase: "review", text: "In review", prNumber: 77 }),
        viewOf("review", tries),
        { run: { startedAt: s } },
      );
      fireEvent.click(within(panel).getByRole("button", { name: "Timeline" }));
      await waitFor(() => expect(panel.querySelectorAll(".tlrow")).toHaveLength(4));
      const rows = [...panel.querySelectorAll<HTMLElement>(".tlrow")];
      const bars = [...(rows[1] as HTMLElement).querySelectorAll<HTMLElement>(".tlbars i")];
      expect(bars).toHaveLength(2);
      const first = bars[0] as HTMLElement;
      expect(first.style.left).toBe("25%");
      expect(first.style.width).toBe("22.5%");
      expect(first.className).toBe("tl-fail");
      expect(first.title).toBe("CI try 1 · fail: CI failed on abc1234 · 0 tokens · 9 min");
      expect(panel.textContent).toContain("(40 min)");
      expect(panel.textContent).toContain("Round 1 of 3");
    });
  });

  describe("End run on a set-aside run", () => {
    const LOOP_PATH = "/api/runs/r-12/loop";
    const END_PATH = "/api/runs/r-12/end";
    const loopAnswer = (aside: unknown) => ({
      [LOOP_PATH]: { runId: "r-12", loop: { phase: "review", aside }, events: [] },
    });
    const asideRun = async (extra: Record<string, unknown>) => {
      const f = stub({
        rows: [seat(loopOf({ phase: "review", text: "Waiting on review", prNumber: 77 }))],
        runs: [],
        extra,
      });
      render(<Agent id="shop-app-ta" />);
      await loaded();
      return f;
    };

    it("shows only for a set-aside run", async () => {
      const f = await asideRun(loopAnswer(null));
      await settled(f, LOOP_PATH);
      expect(screen.queryByRole("button", { name: "End run" })).toBeNull();
      cleanup();
      const g = await asideRun(loopAnswer({ worktree: "/w/r-12", wake: false }));
      await settled(g, LOOP_PATH);
      expect(await screen.findByRole("button", { name: "End run" })).toBeTruthy();
    });

    it("confirms, then posts {} to the run", async () => {
      const f = await asideRun({
        ...loopAnswer({ worktree: "/w/r-12", wake: false }),
        [`POST ${END_PATH}`]: { ok: true },
      });
      const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
      const end = await screen.findByRole("button", { name: "End run" });
      fireEvent.click(end);
      expect(ask).toHaveBeenCalledOnce();
      expect(bodyOf(f, END_PATH)).toBeUndefined();
      fireEvent.click(end);
      await vi.waitFor(() => expect(bodyOf(f, END_PATH)).toBe("{}"));
      ask.mockRestore();
    });

    it("is in the Runs list for a set-aside run the seat has moved on from", async () => {
      const f = stub({
        rows: [
          {
            ...seat(loopOf({ phase: "working" })),
            run: { ...crewRow().run, id: "r-13", seq: 13 },
          } as CrewRow,
        ],
        runs: [
          rv({
            id: "r-12",
            loop: { phase: "review", aside: { worktree: "/w/r-12", wake: false } } as RunLoop,
          }),
        ],
        extra: { "POST /api/runs/r-12/end": { ok: true } },
      });
      const { container } = render(<Agent id="shop-app-ta" />);
      await loaded();
      const panel = $(container, "#loopP") as HTMLElement;
      fireEvent.click(within(panel).getByRole("button", { name: "Runs" }));
      const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
      fireEvent.click(await within(panel).findByRole("button", { name: "End run" }));
      await vi.waitFor(() => expect(bodyOf(f, "/api/runs/r-12/end")).toBe("{}"));
      ask.mockRestore();
    });

    it("is in the Runs list only for an unended run that is not the seat's current one", async () => {
      const loop = { phase: "review", aside: { worktree: "/w/x", wake: false } } as RunLoop;
      stub({
        rows: [
          {
            ...seat(loopOf({ phase: "working" })),
            run: { ...crewRow().run, id: "r-13", seq: 13 },
          } as CrewRow,
        ],
        runs: [
          rv({ id: "r-13", seq: 13, loop }),
          rv({ id: "r-12", seq: 12, loop, summary: "Did the thing" }),
          rv({ id: "r-11", seq: 11, loop, endedAt: NOW - HOUR }),
        ],
      });
      const { container } = render(<Agent id="shop-app-ta" />);
      await loaded();
      const panel = $(container, "#loopP") as HTMLElement;
      fireEvent.click(within(panel).getByRole("button", { name: "Runs" }));
      const buttons = await within(panel).findAllByRole("button", { name: "End run" });
      expect(buttons).toHaveLength(1);
      const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
      fireEvent.click(buttons[0] as HTMLElement);
      expect(ask).toHaveBeenCalledOnce();
      // the click did not also toggle the row open
      expect($(panel, ".rsummary")?.classList.contains("open")).toBe(false);
      ask.mockRestore();
    });

    it("is not in the Steps view once the run has ended, though its loop still has aside", async () => {
      stub({
        rows: [
          {
            ...seat(loopOf({ phase: "review", text: "Waiting on review", prNumber: 77 })),
            run: { ...crewRow().run, id: "r-12", endedAt: NOW - HOUR, status: "ok" },
          } as CrewRow,
        ],
        runs: [],
        extra: loopAnswer({ worktree: "/w/r-12", wake: false }),
      });
      const { container } = render(<Agent id="shop-app-ta" />);
      await loaded();
      const panel = $(container, "#loopP") as HTMLElement;
      fireEvent.click(within(panel).getByRole("button", { name: "Steps" }));
      await act(async () => {});
      expect(screen.queryByRole("button", { name: "End run" })).toBeNull();
    });

    it("shows the server's refusal text on a 409", async () => {
      await asideRun({
        ...loopAnswer({ worktree: "/w/r-12", wake: false }),
        [`POST ${END_PATH}`]: () => ({ status: 409, body: { error: "NOT_ASIDE" } }),
      });
      const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
      fireEvent.click(await screen.findByRole("button", { name: "End run" }));
      expect((await screen.findByRole("alert")).textContent).toBe("NOT_ASIDE");
      ask.mockRestore();
    });
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

  it("a row with no loop says there is no loop in flight", async () => {
    const panel = await open(null);
    fireEvent.click(within(panel).getByRole("button", { name: "Steps" }));
    expect(panel.textContent).toContain(NO_LOOP);
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

  const ticketOf = (body: string, over: Partial<TicketView> = {}): TicketView => ({
    number: 3349,
    title: "Quote cache",
    url: "https://github.com/octo-org/shop-app/issues/3349",
    state: "open",
    body,
    bodyTruncated: false,
    labels: [],
    milestone: null,
    subIssues: [],
    pullRequests: [],
    ...over,
  });
  const TICKET_ROUTE = "/api/boards/shop-app/items/3349";
  const sideOf = async (row: CrewRow, extra: Record<string, unknown> = {}) => {
    stub({ rows: [row], extra });
    const { container } = render(<Agent id={row.id} />);
    await (row.kind === "crew" ? seatLoaded() : loaded());
    return $(container, "#sideP") as HTMLElement;
  };

  it("Plan never substitutes ticket Markdown for the live list", async () => {
    const side = await sideOf(crewRow({ digest: digest() }), {
      [TICKET_ROUTE]: ticketOf("## Plan\n1. cache the quotes"),
    });
    expect(await within(side).findByText("No task list yet.")).toBeTruthy();
    expect(side.textContent).not.toContain("cache the quotes");
    expect(within(side).getByRole("button", { name: "Plan 0/0" })).toBeTruthy();
  });

  it("Queue shows what the seat holds and what comes next", async () => {
    const loop: CrewLoop = { phase: "ci", text: "CI is running", prNumber: 77, parked: null };
    const side = await sideOf(
      seatRow({
        loop,
        queue: [
          { ref: "shop-app#3", issue: 3, pos: 1 },
          { ref: "shop-app#8", issue: 8, pos: 2 },
        ],
      }),
      SEAT_ROUTES({
        "/api/boards/shop-app": [
          boardItem({ issueNumber: 3, title: "Retry the fetch", priority: "P1" }),
          boardItem({ issueNumber: 8, title: "Fix the typo", priority: "P2" }),
        ],
      }),
    );
    fireEvent.click(within(side).getByRole("button", { name: "Queue" }));
    expect(await within(side).findByText("Retry the fetch")).toBeTruthy();
    const heads = [...side.querySelectorAll(".qsec")].map((h) => h.textContent);
    expect(heads).toEqual(["Now", "Next · from Ready, by priority", "Done"]);
    const rows = [...side.querySelectorAll<HTMLElement>(".qi")].map((r) => r.textContent);
    expect(rows).toEqual([
      "▸#3349 Quote cacheCI",
      "1#3 Retry the fetchP1",
      "2#8 Fix the typoP2",
      "✓#3349 ",
    ]);
    expect(side.textContent).toContain(
      "Each ticket starts as a fresh run on its own branch, with the ticket, the repo's docs and this lane's notes. Earlier tickets' conversations aren't carried over.",
    );
  });

  it("Queue Done lists finished tickets once, excluding unfinished, failed, stopped and unticketed runs", async () => {
    const ok = { status: "ok" as const, endedAt: NOW };
    const side = await sideOf(
      seatRow(),
      SEAT_ROUTES({
        "/api/agents/guido-1/runs?limit=50": [
          rv({ id: "done", ticket: "shop-app#42", ticketTitle: "Finished cache", ...ok }),
          rv({ id: "again", ticket: "shop-app#42", ticketTitle: "Finished cache", ...ok }),
          rv({ id: "active", ticket: "shop-app#43", ticketTitle: "Still working", endedAt: null }),
          rv({
            id: "failed",
            ticket: "shop-app#44",
            ticketTitle: "Fell over",
            status: "failed",
            endedAt: NOW,
          }),
          rv({ id: "scratch", ticket: null, ticketTitle: "Unticketed", ...ok }),
          rv({
            id: "stopped",
            ticket: "shop-app#45",
            ticketTitle: "Stopped by you",
            ...ok,
            endedBy: "operator",
          }),
        ],
      }),
    );
    fireEvent.click(within(side).getByRole("button", { name: "Queue" }));
    expect(await within(side).findByText("Finished cache")).toBeTruthy();
    expect(side.textContent).toContain("✓#42 Finished cache");
    expect(within(side).getAllByText("Finished cache")).toHaveLength(1);
    expect(side.textContent).not.toContain("Still working");
    expect(side.textContent).not.toContain("Fell over");
    expect(side.textContent).not.toContain("Unticketed");
    expect(side.textContent).not.toContain("Stopped by you");
  });

  it("Queue says when it is empty, nothing is held, or the row is no writer seat", async () => {
    const empty = await sideOf(seatRow({ queue: [], run: null, ticket: null }), SEAT_ROUTES());
    fireEvent.click(within(empty).getByRole("button", { name: "Queue" }));
    expect(empty.textContent).toContain("Nothing assigned.");
    expect(empty.textContent).toContain(
      "Empty: the engine queues Ready cards in this seat's area, in merge repos only.",
    );
    cleanup();
    const loopRow = await sideOf(crewRow({ digest: digest() }));
    fireEvent.click(within(loopRow).getByRole("button", { name: "Queue" }));
    expect($(loopRow, "#sideBody")?.textContent).toBe("Only a writer seat has a queue.");
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
    expect(rows.map((r) => r.textContent)).toEqual(["src/a.ts+10 −2uncommitted", "img/logo.png——"]);
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

describe("Agent page: header and tile mockup", () => {
  const changes: CrewChanges = {
    sessions: [
      {
        id: "s1",
        seats: [
          {
            id: "guido-1",
            role: "GUIDO",
            accountId: "claude-main",
            model: "sonnet",
            area: ["apps/web/**"],
          },
          {
            id: "inco-2",
            role: "INCO",
            accountId: "codex-main",
            model: "codex",
            effort: "high",
            area: ["docs/**"],
          },
        ],
      },
    ],
    pending: [],
    restartNeeded: [],
    error: null,
    checkedAt: NOW,
  };
  const removalRoutes = {
    // Applied config still has RETRO-1; config.yaml has INCO-2 and GUIDO-1's new area.
    "/api/config": CREW_CONFIG,
    "/api/crew/changes": changes,
    "POST /api/crew/sessions/s1/seats": { backup: "/tmp/config.bak", changes },
  };

  it.each(["idle", "stopped"] as const)(
    "Remove confirms for a %s seat and preserves the other seat's settings",
    async (hudState) => {
      const f = stub({ rows: [seat({ hudState })], extra: SEAT_ROUTES(removalRoutes) });
      const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
      render(<Agent id="guido-1" />);
      const remove = await screen.findByRole("button", { name: "Remove" });
      await settled(f, "/api/crew/changes");
      expect(screen.queryByText("Not in config.yaml")).toBeNull();
      fireEvent.click(remove);
      expect(ask).toHaveBeenCalledWith(
        "Remove GUIDO-1 from s/s1? Its area will be freed when its run ends.",
      );
      expect(bodyOf(f, "/api/crew/sessions/s1/seats")).toBeUndefined();
      fireEvent.click(remove);
      await vi.waitFor(() =>
        expect(JSON.parse(bodyOf(f, "/api/crew/sessions/s1/seats") as string)).toEqual({
          base: changes.sessions[0]?.seats,
          seats: [changes.sessions[0]?.seats[1]],
        }),
      );
      ask.mockRestore();
    },
  );

  it.each([
    ["idle", true],
    ["stopped", true],
    ["running", false],
    ["stalled", false],
    ["blocked", false],
    ["waiting", false],
    ["parked", false],
    ["error", false],
  ] as const)("Remove visibility for a %s seat", async (hudState, visible) => {
    stub({ rows: [seat({ hudState })], extra: SEAT_ROUTES(removalRoutes) });
    render(<Agent id="guido-1" />);
    await seatLoaded();
    expect(screen.queryByRole("button", { name: "Remove" }) !== null).toBe(visible);
  });

  it.each([
    { id: "s1", seats: [] },
    { id: "other-session", seats: changes.sessions[0]?.seats ?? [] },
  ])("Remove explains when the seat is absent from config.yaml (%j)", async (session) => {
    const f = stub({
      rows: [idleSeat()],
      extra: SEAT_ROUTES({
        ...removalRoutes,
        "/api/crew/changes": { ...changes, sessions: [session] },
      }),
    });
    render(<Agent id="guido-1" />);
    await settled(f, "/api/crew/changes");
    const remove = screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    const note = screen.getByText("Not in config.yaml");
    expect(note.classList.contains("muted")).toBe(true);
    expect(remove.nextElementSibling).toBe(note);
  });

  it("observed loops have neither Remove nor Rename", async () => {
    stub({ rows: [studio()] });
    render(<Agent id="studio-builder" />);
    await screen.findByText(/is an observed loop: Mission Control watches it/);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("Rename explains editable call signs", async () => {
    stub({ rows: [seat()], extra: SEAT_ROUTES() });
    render(
      <>
        <Agent id="guido-1" />
        <Toast />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    expect(
      await screen.findByText(
        "Rename GUIDO-1: call signs default to the role's console plus a number. Any name works.",
      ),
    ).toBeTruthy();
  });

  it("renames a running seat throughout the HUD while retaining its selection and run", async () => {
    const row = seat({ hudState: "running" });
    const rows = [row];
    const f = stub({
      rows,
      extra: SEAT_ROUTES({
        ...removalRoutes,
        "POST /api/crew/sessions/s1/seats": (init: RequestInit) => {
          const body = JSON.parse(init.body as string);
          expect(body).toEqual({
            base: changes.sessions[0]?.seats,
            seats: changes.sessions[0]?.seats.map((s) =>
              s.id === row.id ? { ...s, displayCallSign: "ORBIT" } : s,
            ),
          });
          rows[0] = { ...row, displayCallSign: "ORBIT" };
          return { status: 200, body: { changes } };
        },
      }),
    });
    render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Call sign" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "ORBIT" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Call sign" })).toBeNull());
    await waitFor(() =>
      expect(document.querySelector("#ahead .big")?.textContent).toContain("ORBIT"),
    );
    const picker = within(screen.getByRole("group", { name: "Pick an agent" })).getByRole(
      "button",
      { name: /ORBIT/ },
    );
    expect(picker.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(picker);
    expect(window.location.pathname).toBe("/agent/guido-1");
    expect(rows[0]?.run).toBe(row.run);
    const posts = f.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts.map(([path]) => path)).toEqual(["/api/crew/sessions/s1/seats"]);
    for (const path of ["/api/config", "/api/crew", "/api/crew/changes"]) {
      expect(f.mock.calls.filter(([p]) => p === path).length).toBeGreaterThan(1);
    }
  });

  it("cancels with Escape and rejects blank and overlong names in place", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES(removalRoutes) });
    render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    let input = await screen.findByRole("textbox", { name: "Call sign" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Call sign" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    input = await screen.findByRole("textbox", { name: "Call sign" });
    for (const value of ["   ", "x".repeat(65)]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      expect((await screen.findByRole("alert")).textContent).toContain("1–64");
    }
    expect(f.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it.each([null, { ...changes, sessions: [] }])(
    "disables saving for an empty config response (%j)",
    async (body) => {
      stub({ rows: [seat()], extra: SEAT_ROUTES({ ...removalRoutes, "/api/crew/changes": body }) });
      render(<Agent id="guido-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
      await screen.findByText("Not in config.yaml");
      expect(
        (screen.getByRole("button", { name: "Save call sign" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    },
  );

  it("shows loading until the saved seat list arrives", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES(removalRoutes) });
    const original = f.getMockImplementation();
    let finish: (value: Response) => void = () => {};
    f.mockImplementation(async (path, init) => {
      if (path === "/api/crew/changes")
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return (original as NonNullable<typeof original>)(path, init);
    });
    render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    await screen.findByText("Loading call sign…");
    expect(
      (screen.getByRole("button", { name: "Save call sign" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => finish(new Response(JSON.stringify(changes))));
    expect(
      (screen.getByRole("button", { name: "Save call sign" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows a failed config read in place and keeps saving disabled", async () => {
    stub({
      rows: [seat()],
      extra: SEAT_ROUTES({
        ...removalRoutes,
        "/api/crew/changes": () => ({ status: 503, body: { error: "Config unavailable" } }),
      }),
    });
    render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Config unavailable");
    expect(
      (screen.getByRole("button", { name: "Save call sign" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("disables the editor while saving and handles an empty save response", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES(removalRoutes) });
    let finish: (value: Response) => void = () => {};
    const original = f.getMockImplementation();
    f.mockImplementation(async (path, init) => {
      if (init?.method === "POST")
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return (original as NonNullable<typeof original>)(path, init);
    });
    render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Call sign" });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save call sign" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => finish(new Response(null, { status: 200 })));
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect((input as HTMLInputElement).disabled).toBe(false);
  });

  it("keeps a rejected rename editable and shows the server validation error", async () => {
    stub({
      rows: [seat()],
      extra: SEAT_ROUTES({
        ...removalRoutes,
        "POST /api/crew/sessions/s1/seats": () => ({
          status: 400,
          body: { error: "call signs must be unique" },
        }),
      }),
    });
    render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Call sign" });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save call sign" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.change(input, { target: { value: "ORBIT" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect((await screen.findByRole("alert")).textContent).toContain("call signs must be unique");
    expect((input as HTMLInputElement).value).toBe("ORBIT");
  });

  it("Now shows the template, step, attempt and elapsed time of the latest matching try", async () => {
    const loop: CrewLoop = {
      phase: "ci",
      text: "CI is running",
      prNumber: 77,
      parked: null,
      profile: "bugfix",
      step: "verify",
      tries: { n: 2, max: 3 },
      steps: DEFAULT_PROFILES.find((p) => p.name === "bugfix")?.steps,
    };
    const attempt: LoopTry = {
      step: "ci",
      fix: false,
      n: 1,
      startedAt: NOW - 10 * MIN,
      endedAt: NOW - 5 * MIN,
      outcome: "fail",
      reason: "Check failed",
    };
    const view: RunLoopView = {
      runId: "r-12",
      loop: null,
      events: [],
      round: 1,
      budget: null,
      review: null,
      tries: [
        attempt,
        { ...attempt, n: 2, startedAt: NOW - 92_000, endedAt: null, outcome: "running" },
      ],
    };
    const f = stub({ rows: [seat({ loop })], extra: SEAT_ROUTES({ "/api/runs/r-12/loop": view }) });
    const { container } = render(<Agent id="guido-1" />);
    await settled(f, "/api/runs/r-12/loop");
    const tile = $(container, ".tile2.now") as HTMLElement;
    expect(tile.textContent).toContain("bugfix › verify · try 2 of 3 · 1:32 in this step");
    expect(tile.textContent).not.toContain("in this run");
    expect(tile.querySelector(".stepbar")?.getAttribute("title")).toBe(
      "reproduce → fix → draft PR → verify → review → merge",
    );
    expect([...tile.querySelectorAll(".stepbar i")].map((i) => i.className)).toEqual([
      "",
      "d",
      "d",
      "c",
      "",
      "",
    ]);
  });

  it("Now shows a dash for parked step time even with an earlier CI try", async () => {
    const view: RunLoopView = {
      runId: "r-12",
      loop: null,
      events: [],
      round: 1,
      budget: null,
      review: null,
      tries: [
        {
          step: "ci",
          fix: false,
          n: 1,
          startedAt: NOW - 10 * MIN,
          endedAt: NOW - MIN,
          outcome: "parked",
          reason: "Check failed",
        },
      ],
    };
    const f = stub({
      rows: [
        seat({
          hudState: "parked",
          loop: {
            phase: "parked",
            text: "Held: Check failed",
            parked: "Check failed",
            prNumber: 77,
          },
        }),
      ],
      extra: SEAT_ROUTES({ "/api/runs/r-12/loop": view }),
    });
    const { container } = render(<Agent id="guido-1" />);
    await settled(f, "/api/runs/r-12/loop");
    const tile = $(container, ".tile2.now") as HTMLElement;
    expect(tile.textContent).toContain("— in this step");
    expect(tile.textContent).not.toContain("in this run");
  });

  it.each([
    null,
    { categories: [{ name: "Messages", tokens: 100_000 }], total: 100_000, window: 200_000 },
  ])("Codex context uses a single bar and explains total-only reporting (%j)", async (usage) => {
    stub({
      rows: [seat({ accountId: "provider-account", contextWindow: 200_000, digest: digest() })],
      extra: SEAT_ROUTES({
        "/api/config": { ...CONFIG, accounts: [{ ...CONFIG.accounts[1], id: "provider-account" }] },
        "/api/seats/guido-1/context": usage,
      }),
    });
    render(<Agent id="guido-1" />);
    const note = await screen.findByText(/Codex reports the total, not a breakdown/);
    expect(note.textContent).toContain("0 compactions");
    expect(note.closest(".tile2")?.querySelectorAll(".ctxbar i")).toHaveLength(1);
    expect(note.closest(".tile2")?.textContent).not.toContain("msgs");
  });

  it("Queue Done lists successful completed tickets once, as inert text", async () => {
    const completed = rv({
      id: "done",
      status: "ok",
      endedAt: NOW - MIN,
      ticket: "shop-app#2",
      ticketTitle: "<img src=x onerror=alert(1)>",
    });
    stub({
      rows: [seat()],
      extra: SEAT_ROUTES(),
      runs: [
        rv(),
        completed,
        { ...completed, id: "duplicate" },
        rv({ id: "failed", status: "failed", endedAt: NOW - MIN, ticket: "shop-app#3" }),
        rv({ id: "unticketed", status: "ok", endedAt: NOW - MIN, ticket: null }),
      ],
    });
    const { container } = render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Queue" }));
    const side = $(container, "#sideP") as HTMLElement;
    expect(await within(side).findByText("Done", { exact: true })).toBeTruthy();
    expect(within(side).getAllByRole("link", { name: "shop-app #2" })).toHaveLength(1);
    expect(within(side).queryByRole("link", { name: "shop-app #3" })).toBeNull();
    expect(within(side).getByText(completed.ticketTitle as string)).toBeTruthy();
    expect(side.querySelector("img")).toBeNull();
  });

  it("Queue Done says None yet when there are no completed tickets", async () => {
    stub({ rows: [seat()], runs: [rv()], extra: SEAT_ROUTES() });
    render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Queue" }));
    expect(await screen.findByText("None yet.")).toBeTruthy();
  });

  it.each([49, 50])(
    "Queue Done hints at the limit only for a full page of %i runs",
    async (count) => {
      const f = stub({
        rows: [seat()],
        runs: Array.from({ length: count }, (_, i) =>
          rv({ id: `r-${i}`, status: "ok", endedAt: NOW - MIN, ticket: "shop-app#2" }),
        ),
        extra: SEAT_ROUTES(),
      });
      const { container } = render(<Agent id="guido-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Queue" }));
      await settled(f, "/api/agents/guido-1/runs?limit=50");
      const side = $(container, "#sideP") as HTMLElement;
      expect(within(side).getAllByRole("link", { name: "shop-app #2" })).toHaveLength(1);
      expect(side.textContent?.includes("latest 50")).toBe(count === 50);
    },
  );
});

describe("Agent page: driving a crew seat", () => {
  it("a crew writer's Files tab lists its changed files", async () => {
    stub({
      rows: [seat(), studio()],
      files: {
        files: [{ path: "src/a.ts", add: 3, del: 1, state: "uncommitted" }],
        note: null,
        sha: null,
      },
      extra: SEAT_ROUTES(),
    });
    const { container } = render(<Agent id="guido-1" />);
    await seatLoaded();
    const activity = $(container, "#streamP") as HTMLElement;
    expect(await within(activity).findByText("Work on shop-app#3349")).toBeTruthy();
    expect(within(activity).getByText("The cache is in")).toBeTruthy();
    expect(activity.textContent).not.toContain("Could not load the activity");
    const side = $(container, "#sideP") as HTMLElement;
    fireEvent.click(await within(side).findByRole("button", { name: "Files 1" }));
    await waitFor(() =>
      expect([...side.querySelectorAll(".f")].map((e) => e.textContent)).toEqual([
        "src/a.ts+3 −1uncommitted",
      ]),
    );
  });

  it("a read-only seat's Files tab shows only its note", async () => {
    stub({
      rows: [seat({ mode: "read-only" }), studio()],
      files: { files: [], note: READONLY_FILES_NOTE, sha: null },
      extra: SEAT_ROUTES(),
    });
    const { container } = render(<Agent id="guido-1" />);
    await seatLoaded();
    const side = $(container, "#sideP") as HTMLElement;
    const tab = within(side).getByRole("button", { name: /^Files/ });
    expect(tab.textContent).toBe("Files");
    fireEvent.click(tab);
    const note = await within(side).findByText(READONLY_FILES_NOTE);
    expect(note.className).toContain("note");
    expect($(container, "#sideBody")?.textContent).toBe(READONLY_FILES_NOTE);
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
    await screen.findByText(/is an observed loop: Mission Control watches it/);
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
    await screen.findByText(/is an observed loop: Mission Control watches it/);
    expect(
      screen.getByRole("textbox", {
        name: "Message this agent",
        description: /is an observed loop: Mission Control watches it/,
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
    await screen.findByText(/is an observed loop: Mission Control watches it/);
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

  it("Stop confirms, then posts {hold:true} to keep the area reserved", async () => {
    const f = stub({ rows: [seat()], extra: SEAT_ROUTES() });
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<Agent id="guido-1" />);
    await seatLoaded();
    const end = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(end);
    expect(ask).toHaveBeenCalledWith(
      "Stop GUIDO-1's run? Its area stays reserved until you remove it. The checkout and branch stay; nothing is pushed.",
    );
    expect(bodyOf(f, "/api/seats/guido-1/end")).toBeUndefined();
    fireEvent.click(end);
    await vi.waitFor(() => expect(bodyOf(f, "/api/seats/guido-1/end")).toBe('{"hold":true}'));
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
      items: [
        item({ key: "p:1", kind: "parked", text: "wait for **the operator**", ticket: null }),
      ],
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
      items: [item({ key: "p:1", kind: "parked", text: "1. retry", ticket: null })],
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
      items: [item({ key: "p:1", kind: "parked", text, ticket: null })],
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
