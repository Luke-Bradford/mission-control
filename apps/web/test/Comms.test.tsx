import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ActivityRow,
  type AttentionItem,
  type CommsEvent,
  GUARD_NONE_TEXT,
  type GuardHitsView,
  guardSummary,
} from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLIGHT_NO_SEAT } from "../src/flight/flightTypes.ts";
import { Comms } from "../src/pages/Comms.tsx";
import { Dock } from "../src/shell/Dock.tsx";
import { setFlightUnread, toggleDock, useDock, useItem } from "../src/shell/overlays.ts";
import { setSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch } from "./fetchStub.ts";
import {
  brief,
  CONFIG,
  crewRow,
  item,
  itemWithoutOwner,
  MIN,
  NOW,
  prView,
  SEAT_Q,
  SESSION_CONFIG,
  seatRow,
  stoppedSeat,
} from "./fixtures.ts";

function Probe() {
  return <span data-testid="item">{useItem() ?? "none"}</span>;
}

const ITEMS: AttentionItem[] = [
  item({
    key: "esc:shop-app#3227",
    kind: "decision",
    escalationId: "shop-app#3227",
    text: "Pick a policy",
  }),
  item({
    key: "stall:shop-app-ta:r-12",
    kind: "stalled",
    escalationId: null,
    text: "No output",
    tool: "Bash",
    at: NOW - 135_000,
    url: null,
  }),
  item({
    key: "err:shop-app-ta",
    kind: "error",
    escalationId: null,
    text: "Transcript unreadable",
    url: null,
    acked: true,
  }),
];

const ROWS = [
  crewRow(),
  crewRow({ id: "studio", repoId: "site-builder", index: 1, hudState: "idle", run: null }),
];

const hit = (id: number, over: Partial<GuardHitsView["hits"][number]> = {}) => ({
  id,
  agentId: "shop-app-ta",
  runId: "r-12",
  rule: "git-write" as const,
  text: `git writes only through the mc tools: git push (${id})`,
  at: NOW - 5 * 60_000,
  acked: false,
  ...over,
});
const NO_HITS = { hits: [], counts: { "git-write": 0 } };

function stub(items = ITEMS, post: (b: unknown) => void = () => {}, guard: unknown = NO_HITS) {
  return stubFetch({
    "/api/attention": items,
    "/api/guard/hits?days=7": guard,
    "/api/crew": { rows: ROWS, firstRunToday: null },
    "/api/config": CONFIG,
    "/api/flight": { seat: null, decisions: [] },
    "POST /api/attention/ack": (init: RequestInit | undefined) => {
      post(JSON.parse(String(init?.body)));
      return { status: 200, body: { ok: true } };
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Threads", () => {
  it.each([
    ["whose run merged", stoppedSeat({ merged: true }), "Run ended · PR #75 merged"],
    ["stopped by you", stoppedSeat(), "Run ended by you"],
  ])("a stopped seat %s says why", async (_name, row, line) => {
    stubFetch({
      "/api/attention": [],
      "/api/crew": { rows: [row], firstRunToday: null },
      "/api/config": CONFIG,
    });
    render(<Comms item={null} />);
    const doing = await screen.findByText(line);
    expect(doing.getAttribute("title")).toBe(line);
    expect(document.body.textContent).not.toContain("Dead collector fallback");
  });
});

describe("Threads: the FLIGHT entry", () => {
  const flightSeat = { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true };
  const asks = [
    item({ key: "esc:a#1", brief: brief(), text: "first" }),
    item({ key: "esc:a#2", brief: brief(), text: "second" }),
  ];
  const flightStream = (events: { id: string; kind: string; text: string; at: number }[]) => ({
    runId: "f-1",
    events,
    truncated: false,
    lastOutputAt: null,
    reason: null,
  });
  const stubFlight = (flight: unknown, extra: Record<string, unknown> = {}) =>
    stubFetch({
      "/api/attention": asks,
      "/api/crew": {
        rows: [seatRow(), seatRow({ id: "flight-1", index: 1 })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
      "/api/flight": flight,
      ...extra,
    });

  it("shows the asks open, the Head pill and FLIGHT's last message, and no second FLIGHT thread", async () => {
    stubFlight(
      { seat: flightSeat, decisions: [] },
      {
        "/api/agents/flight-1/stream": flightStream([
          { id: "e1", kind: "msg", text: "older words", at: NOW - 2 * MIN },
          { id: "e2", kind: "msg", text: "Latest word from FLIGHT", at: NOW - MIN },
        ]),
      },
    );
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    await waitFor(() => expect(within(list).getByText("2 for you")).toBeTruthy());
    const entry = within(list).getAllByRole("button")[0] as HTMLElement;
    expect(entry.textContent).toContain("Head");
    await waitFor(() => expect(entry.textContent).toContain("Latest word from FLIGHT"));
    expect(within(list).getByText("Latest word from FLIGHT").getAttribute("title")).toBe(
      "Latest word from FLIGHT",
    );
    expect(within(list).queryByRole("button", { name: /^flight-1/i })).toBeNull();
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(document.querySelector("#cThreadsP .phase")).toBeNull();
  });

  it("says who and what state FLIGHT is in before it has said anything", async () => {
    stubFlight({ seat: flightSeat, decisions: [] }, { "/api/attention": [] });
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    await waitFor(() =>
      expect(within(list).getAllByRole("button")[0]?.textContent).toContain(
        "FLIGHT-1 · waiting for a wake",
      ),
    );
    expect(within(list).queryByText(/for you/)).toBeNull();
  });

  it("says no seat is configured when there is none, and shows a dash before it loads", async () => {
    stubFlight({ seat: null, decisions: [] }, { "/api/attention": [] });
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    expect(within(list).getAllByRole("button")[0]?.textContent).toContain("—");
    await waitFor(() =>
      expect(within(list).getAllByRole("button")[0]?.textContent).toContain(
        "No FLIGHT seat is configured.",
      ),
    );
  });
});

const needs = () => document.querySelector<HTMLElement>("#cNeeds") as HTMLElement;

describe("Needs you", () => {
  it("lists by kind order with a subtitle, labels and actions per kind", async () => {
    stub();
    render(<Comms item={null} />);
    await screen.findByText("Pick a policy");
    const rows = [...needs().querySelectorAll<HTMLElement>(".nrow")];
    expect(rows.map((r) => r.dataset.kind)).toEqual(["stalled", "error", "decision"]);
    expect(screen.getByText("3 · 2 not acknowledged")).toBeTruthy();

    const [stall, error, decision] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(stall).getByText("2:15 in Bash")).toBeTruthy();
    expect(within(stall).getByRole("button", { name: "Open" })).toBeTruthy();
    expect(within(stall).getByRole("button", { name: "Ack" })).toBeTruthy();
    expect(within(error).getByRole("button", { name: "Open" })).toBeTruthy();
    expect(within(error).queryByRole("button", { name: "Ack" })).toBeNull();
    expect(error.className).toContain("acked");
    expect(within(error).getByRole("img", { name: "Error" }).className).toContain("crit");
    expect(within(decision).getByRole("button", { name: "Read the brief" })).toBeTruthy();
    const link = within(decision).getByRole("link", { name: "Open on GitHub ↗" });
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/issues/4001");
    expect(decision.className).not.toContain("acked");
  });

  it("counts only the operator's items and lists the rest, labelled, under Being handled", async () => {
    stub([
      item({ key: "a", text: "Mine" }),
      itemWithoutOwner({ key: "b", text: "Old hub" }),
      item({ key: "c", text: "F item", owner: "flight" }),
      item({ key: "d", text: "C item", owner: "controller" }),
      item({ key: "e", text: "L item", owner: "lane:octo" }),
      item({ key: "f", text: "P item", owner: "loop" }),
    ]);
    render(<Comms item={null} />);
    await screen.findByText("Mine");
    expect(needs().querySelectorAll(".nrow")).toHaveLength(2);
    expect(screen.getByText("2 · 2 not acknowledged")).toBeTruthy();
    const drawer = document.querySelector<HTMLDetailsElement>("#cHandled") as HTMLDetailsElement;
    expect(drawer.open).toBe(false);
    expect(within(drawer).getByText("Being handled · 4")).toBeTruthy();
    const rows = [...drawer.querySelectorAll<HTMLElement>(".nrow")];
    const labels = rows.map((r) => r.querySelector(".xs")?.textContent).sort();
    expect(labels).toEqual(["FLIGHT", "controller", "loop", "work lane"]);
    expect(within(drawer).getByText("F item").closest(".nrow")?.textContent).toContain("FLIGHT");
    expect(within(drawer).getByText("L item").closest(".nrow")?.textContent).toContain("work lane");
  });

  it("a row with a brief shows FLIGHT's recommendation and its options send to the seat", async () => {
    const posts: unknown[] = [];
    stubFetch({
      "/api/attention": [SEAT_Q],
      "/api/crew": { rows: [crewRow({ id: "mc-dev-1", kind: "crew" })], firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "POST /api/seats/mc-dev-1/message": (init: RequestInit | undefined) => {
        posts.push(JSON.parse(String(init?.body)));
        return { status: 200, body: {} };
      },
    });
    render(<Comms item={null} />);
    const row = (await within(needs()).findByText("Which port?")).closest(".nrow") as HTMLElement;
    expect(row.textContent).toContain("FLIGHT recommends: Use 5174.");
    const b = within(row).getByRole("button", { name: "5174" }) as HTMLButtonElement;
    await waitFor(() => expect(b.disabled).toBe(false));
    fireEvent.click(b);
    await waitFor(() => expect(posts).toEqual([{ text: "Use port 5174." }]));
  });

  it("every row opens the item panel", async () => {
    stub([ITEMS[1] as AttentionItem, SEAT_Q]);
    render(
      <>
        <Comms item={null} />
        <Probe />
      </>,
    );
    const rows = await waitFor(() => {
      const r = [...needs().querySelectorAll<HTMLElement>(".nrow")];
      expect(r).toHaveLength(2);
      return r as [HTMLElement, HTMLElement];
    });
    const byText = (t: string) => rows.find((r) => r.textContent?.includes(t)) as HTMLElement;
    fireEvent.click(within(byText("Bash")).getByRole("button", { name: "Discuss" }));
    expect(screen.getByTestId("item").textContent).toBe("stall:shop-app-ta:r-12");
    fireEvent.click(within(byText("Which port?")).getByRole("button", { name: "Answer" }));
    expect(screen.getByTestId("item").textContent).toBe("ask:7");
  });

  it("has no Being handled section when every item is the operator's", async () => {
    stub();
    render(<Comms item={null} />);
    await screen.findByText("Pick a policy");
    expect(document.querySelector("#cHandled")).toBeNull();
  });

  it("a row's text renders its Markdown", async () => {
    stub([
      item({ key: "e:1", kind: "error", escalationId: null, text: "Failed: **lint** in `a.ts`" }),
    ]);
    render(<Comms item={null} />);
    const strong = await within(needs()).findByText("lint");
    expect(strong.tagName).toBe("STRONG");
    expect(within(needs()).getByText("a.ts").tagName).toBe("CODE");
  });

  it("a plain row keeps its one-line shape: no block element in its text, prose unchanged", async () => {
    const plain = "Transcript unreadable: __init__.py, a*b, step 1. then - done";
    stub([item({ key: "e:2", kind: "error", escalationId: null, text: plain })]);
    render(<Comms item={null} />);
    const row = (await within(needs()).findByText(plain)).closest(".nrow") as HTMLElement;
    const text = row.querySelector(".kind")?.parentElement as HTMLElement;
    expect(text.textContent).toContain(plain);
    expect(text.querySelector("div, p, ul, ol, pre")).toBeNull();
  });

  it("a long row is cut after parsing, so it never ends in half a marker", async () => {
    stub([
      item({
        key: "e:3",
        kind: "error",
        escalationId: null,
        text: `${"w ".repeat(80)}**bold words here** tail`,
      }),
    ]);
    render(<Comms item={null} />);
    await within(needs()).findByText(/^w w/);
    const text = needs().querySelector(".nrow .kind")?.parentElement as HTMLElement;
    expect(text.textContent).not.toContain("**");
    expect(text.textContent?.endsWith("…")).toBe(true);
  });

  it("a pr row's tail renders its Markdown", async () => {
    stub([
      item({
        key: "pr:shop-app#41:1",
        kind: "pr",
        agentId: null,
        escalationId: null,
        ticket: "shop-app#3349",
        text: "PR #41 · You: ship **now** via `pnpm`",
        url: "https://github.com/octo-org/shop-app/pull/41",
      }),
    ]);
    render(<Comms item={null} />);
    expect((await within(needs()).findByText("now")).tagName).toBe("STRONG");
    expect(within(needs()).getByText("pnpm").tagName).toBe("CODE");
  });

  it("a pr row opens the PR on GitHub", async () => {
    stub([
      item({
        key: "pr:shop-app#40:1",
        kind: "pr",
        agentId: null,
        escalationId: null,
        ticket: "shop-app#3349",
        text: "PR #40 · You: decide on the draft",
        url: "https://github.com/octo-org/shop-app/pull/40",
      }),
    ]);
    render(<Comms item={null} />);
    // the number is its own link; the rest of the sentence stays text
    const num = await within(needs()).findByRole("link", { name: "shop-app PR #40" });
    expect(num.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/pull/40");
    expect(needs().textContent).toContain("PR #40 · You: decide on the draft");
    const link = within(needs()).getByRole("link", { name: "Open PR ↗" });
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/pull/40");
    expect(within(needs()).queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("a stall without a tool reads without output", async () => {
    stub([ITEMS[1] as AttentionItem].map((i) => ({ ...i, tool: null })));
    render(<Comms item={null} />);
    await screen.findByText("2:15 without output");
  });

  it("cuts long text at 170 characters", async () => {
    stub([item({ text: "x".repeat(300) })]);
    render(<Comms item={null} />);
    await waitFor(() => expect(needs().textContent).toContain("x".repeat(169)));
    expect(needs().textContent).not.toContain("x".repeat(170));
  });

  it("nothing waiting", async () => {
    stub([]);
    render(<Comms item={null} />);
    await screen.findByText("nothing waiting");
    expect(screen.getByText("Nothing needs you right now.")).toBeTruthy();
  });

  it("Ack posts that one key", async () => {
    const posts: unknown[] = [];
    stub(ITEMS, (b) => posts.push(b));
    render(<Comms item={null} />);
    await screen.findByText("Pick a policy");
    const stall = needs().querySelector(".nrow") as HTMLElement;
    fireEvent.click(within(stall).getByRole("button", { name: "Ack" }));
    await waitFor(() => expect(posts).toEqual([{ keys: ["stall:shop-app-ta:r-12"] }]));
  });

  it("a failed Ack shows its error, and a retry clears it while the request is in flight", async () => {
    const real = stub();
    let calls = 0;
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      if (init?.method !== "POST") return real(input, init);
      calls++;
      if (calls === 1) {
        return Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
      }
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    render(<Comms item={null} />);
    await screen.findByText("Pick a policy");
    const stall = needs().querySelector(".nrow") as HTMLElement;
    fireEvent.click(within(stall).getByRole("button", { name: "Ack" }));
    await screen.findByText("boom");
    fireEvent.click(within(stall).getByRole("button", { name: "Ack" }));
    await waitFor(() => expect(screen.queryByText("boom")).toBeNull());
    await act(async () => {
      release(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
  });

  it("Acknowledge all posts every unacked key, 50 at a time", async () => {
    const many = Array.from({ length: 120 }, (_, n) =>
      item({ key: `esc:shop-app#${n}`, escalationId: `shop-app#${n}` }),
    );
    const posts: { keys: string[] }[] = [];
    stub(many, (b) => posts.push(b as { keys: string[] }));
    render(<Comms item={null} />);
    await screen.findByText("120 · 120 not acknowledged");
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge all" }));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts.map((p) => p.keys.length)).toEqual([50, 50, 20]);
  });

  it("Acknowledge all is disabled when everything is acked", async () => {
    stub([item({ acked: true })]);
    render(<Comms item={null} />);
    await screen.findByText("1 · 0 not acknowledged");
    expect(
      (screen.getByRole("button", { name: "Acknowledge all" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("renders hostile text inert", async () => {
    stub([item({ text: "<img src=x onerror=alert(1)>" })]);
    render(<Comms item={null} />);
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(needs().querySelector("img")).toBeNull();
  });
});

describe("an item link", () => {
  it("opens that item's panel", async () => {
    stub();
    render(
      <>
        <Comms item="esc:shop-app#3227" />
        <Probe />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("item").textContent).toBe("esc:shop-app#3227"));
    // the link's path gives way to the page, carrying the item as ?item=
    expect(window.location.pathname).toBe("/comms");
    expect(new URLSearchParams(window.location.search).get("item")).toBe("esc:shop-app#3227");
  });

  it("a key that is gone opens nothing and toasts", async () => {
    stub();
    render(
      <>
        <Comms item="esc:shop-app#9" />
        <Probe />
        <Toast />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("That item is no longer waiting."),
    );
    expect(screen.getByTestId("item").textContent).toBe("none");
  });
});

describe("Threads and conversation", () => {
  it("lists FLIGHT then each agent, and filters by session", async () => {
    stubFetch({
      "/api/attention": ITEMS,
      "/api/crew": { rows: ROWS, firstRunToday: null },
      "/api/config": SESSION_CONFIG,
      "/api/flight": { seat: null, decisions: [] },
    });
    render(<Comms item={null} />);
    const list = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("#chanList") as HTMLElement;
      expect(within(el).getByText("studio")).toBeTruthy();
      return el;
    });
    const buttons = within(list).getAllByRole("button");
    expect(buttons[0]?.textContent).toContain("Head");
    await waitFor(() => expect(buttons[0]?.textContent).toContain(FLIGHT_NO_SEAT));
    expect(within(list).getByText(/Idle since/)).toBeTruthy();
    expect(within(list).getByText(/^run #12/)).toBeTruthy();
    act(() => setSession("shop-app-session"));
    await waitFor(() => expect(within(list).queryByText("studio")).toBeNull());
    expect(within(list).getByText("shop-app-ta")).toBeTruthy();
  });

  it("a thread shows its doing text before the timezone has loaded", async () => {
    stubFetch({
      "/api/attention": [],
      "/api/crew": { rows: ROWS, firstRunToday: null },
      "/api/config": () => ({ status: 503, body: { error: "loading" } }),
    });
    render(<Comms item={null} />);
    const list = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("#chanList") as HTMLElement;
      expect(within(el).getByText("studio")).toBeTruthy();
      return el;
    });
    expect(within(list).getByText(/^run #12/)).toBeTruthy();
    const lines = [...list.querySelectorAll(".thread .doing")].map((el) => el.textContent);
    expect(lines).toContain("Idle");
  });

  it("an idle seat's thread says its PR's title, found in the repo's PRs", async () => {
    stubFetch({
      "/api/attention": [],
      "/api/crew": {
        rows: [seatRow({ hudState: "idle", review: { prNumber: 77, state: "draft" }, prs: [] })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
      "/api/repos/shop-app/prs?linked=1": [prView()],
    });
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    await within(list).findByText("guido-1");
    await waitFor(() =>
      expect(
        [...list.querySelectorAll<HTMLElement>(".thread .doing")].map((el) => el.textContent),
      ).toContain("Draft PR #77 · Cache quotes"),
    );
  });

  it("a running seat's thread says its tool and what it touches, as text only", async () => {
    const line = "Edit 0:12 · apps/server/src/backfill.ts";
    stubFetch({
      "/api/attention": [],
      "/api/crew": {
        rows: [
          seatRow({
            hudState: "running",
            digest: {
              toolCalls: 1,
              turns: 1,
              lastEventAt: NOW,
              model: null,
              contextTokens: null,
              contextWindow: null,
              liveTool: {
                name: "Edit",
                since: NOW - 12_000,
                detail: "apps/server/src/backfill.ts",
              },
              tools: {},
              subagents: [],
              minuteTokens: [],
              turnUsage: [],
              background: [],
              compactions: 0,
            },
          }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    await within(list).findByText("guido-1");
    const seat = [...list.querySelectorAll<HTMLElement>(".thread .doing")].find(
      (el) => el.textContent === line,
    ) as HTMLElement;
    expect(seat.title).toBe(line);
  });

  it.each([
    ["open", "In review · PR #77"],
    ["approved", "In review · PR #77"],
    ["draft", "Draft PR #77"],
    ["changes", "Changes requested · PR #77"],
  ] as const)("an idle seat's thread says %s PR, as text only", async (state, line) => {
    stubFetch({
      "/api/attention": [],
      "/api/crew": {
        rows: [seatRow({ hudState: "idle", review: { prNumber: 77, state } })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    await within(list).findByText("guido-1");
    const seat = [...list.querySelectorAll<HTMLElement>(".thread .doing")].find(
      (el) => el.textContent === line,
    ) as HTMLElement;
    expect(seat.title).toBe(line);
    // the thread row is a button: no link inside it, once the config has had time to load too
    await within(list).findByText("guido-1");
    await waitFor(() => expect(seat.textContent).toBe(line));
    expect(list.querySelector("a")).toBeNull();
  });

  it("a thread of an idle seat with no PR stays Idle", async () => {
    stubFetch({
      "/api/attention": [],
      "/api/crew": { rows: [seatRow({ hudState: "idle", review: null })], firstRunToday: null },
      "/api/config": CONFIG,
    });
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    await within(list).findByText("guido-1");
    expect(within(list).getByText(/^Idle since/)).toBeTruthy();
  });

  const TAG = "@" + "CAPCOM";
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
  const stubMessages = (activity?: ActivityRow[], extra: Record<string, unknown> = {}) =>
    stubFetch({
      "/api/attention": [],
      "/api/crew": {
        rows: [seatRow(), seatRow({ id: "retro-1", index: 1 })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      ...(activity ? { "/api/activity": activity } : {}),
      ...extra,
    });
  const MESSAGES = [
    comms({ at: NOW - MIN, who: "guido-1", to: "retro-1", text: `Draft PR is up ${TAG}` }),
    comms({ at: NOW - 2 * MIN, who: "MC", to: "guido-1", text: "CI failed on lint" }),
    comms({ at: NOW - 3 * MIN, who: "CAPCOM", to: "guido-1", text: "Use the quote cache" }),
    comms({ at: NOW - 4 * MIN, who: "retro-1", to: "CAPCOM", text: "Not guido's" }),
  ];

  it("FLIGHT shows its placeholder; an agent's thread opens its messages", async () => {
    stubMessages(MESSAGES);
    render(<Comms item={null} />);
    await waitFor(() => expect(screen.getAllByText(FLIGHT_NO_SEAT)).toHaveLength(2));
    expect(document.querySelector("#chatP #chatMsgs")).toBeNull(); // no seat: no chat
    const list = document.querySelector("#chanList") as HTMLElement;
    fireEvent.click(await within(list).findByRole("button", { name: /^guido-1/ }));
    const msgs = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("#convo .msg")];
      expect(found).toHaveLength(3);
      return found as [HTMLElement, HTMLElement, HTMLElement];
    });
    const [mine, sys, tagged] = msgs;
    expect(mine.classList.contains("mine")).toBe(true);
    for (const part of ["You", "→", "guido-1"]) {
      expect(mine.querySelector(".from")?.textContent, part).toContain(part);
    }
    expect(sys.classList.contains("sys")).toBe(true);
    expect(sys.textContent).toContain("Mission Control");
    expect(tagged.classList.contains("tagged")).toBe(true);
    expect(tagged.textContent).toContain("Tagged you");
    expect(tagged.querySelector(".from")?.textContent).toContain("retro-1");
    expect(tagged.querySelector(".mention")?.textContent).toBe(TAG);
    expect(document.querySelector("#convo")?.textContent).not.toContain("Not guido's");
    expect(document.body.textContent).not.toContain("Threads arrive with the mailbox");
    expect(screen.getByRole("link", { name: "See its activity" }).getAttribute("href")).toBe(
      "/agent/guido-1",
    );
    const head = screen.getByRole("heading", { name: /^Thread ·/ });
    expect(head.textContent?.startsWith("Thread · guido-1")).toBe(true);
    screen.getByText("everything guido-1 sent or received: you, FLIGHT and other agents");
  });

  it("clears the draft when switching agent threads and sends to the selected seat", async () => {
    const fetch = stubMessages([], { "POST /api/seats/retro-1/message": { ok: true } });
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    fireEvent.click(await within(list).findByRole("button", { name: /^guido-1/ }));
    const input = screen.getByLabelText("Message this agent") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft for guido" } });
    expect(input.value).toBe("Draft for guido");

    fireEvent.click(within(list).getByRole("button", { name: /^retro-1/ }));
    const next = screen.getByLabelText("Message this agent") as HTMLInputElement;
    expect(next.value).toBe("");
    fireEvent.change(next, { target: { value: "Message for retro" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/seats/retro-1/message",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ text: "Message for retro" }),
        }),
      ),
    );
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("a thread shows its last message instead of its doing line", async () => {
    stubMessages(MESSAGES);
    render(<Comms item={null} />);
    await waitFor(() => {
      const lines = [...document.querySelectorAll<HTMLElement>("#chanList .thread .doing")];
      const texts = lines.map((el) => el.textContent);
      expect(texts).toContain(`→ RETRO-1: Draft PR is up ${TAG}`);
      expect(texts).toContain(`← GUIDO-1: Draft PR is up ${TAG}`);
      for (const el of lines) expect(el.getAttribute("title")).toBe(el.textContent);
    });
  });

  it("an agent with no messages says No messages yet.", async () => {
    stubMessages([]);
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    fireEvent.click(await within(list).findByRole("button", { name: /^guido-1/ }));
    expect(await screen.findByText("No messages yet.")).toBeTruthy();
  });
});

describe("Threads fit and open", () => {
  it("a long doing line is one ellipsised line, in full in the title, and never widens the panel", async () => {
    stub();
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    await within(list).findByText("studio");
    const doing = list.querySelectorAll<HTMLElement>(".thread .doing");
    expect(doing.length).toBe(ROWS.length + 1); // FLIGHT's too
    for (const el of doing) {
      expect(el.title).toBe(el.textContent);
      expect(el.textContent).not.toBe("");
    }
    // jsdom has no layout: the rules that stop the widening are in the stylesheet
    const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
    const rule = (sel: string) => css.match(new RegExp(`${sel} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule("button\\.nrow\\.thread")).toContain("min-width: 0");
    expect(rule("\\.thread \\.doing")).toMatch(/text-overflow: ellipsis/);
    expect(rule("\\.thread \\.doing")).toMatch(/white-space: nowrap/);
    expect(rule("\\.thread \\.doing")).toMatch(/min-width: 0/);
  });

  it("the config view wraps and Setup tables scroll inside their panel (hud.css)", () => {
    const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
    const rule = (sel: string) => css.match(new RegExp(`${sel} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule("\\.yaml \\.ytx")).toContain("white-space: pre-wrap");
    expect(rule("\\.yaml \\.ytx")).toContain("overflow-wrap: anywhere");
    expect(rule("\\.tw")).toContain("overflow-x: auto");
  });

  function narrow(matches: boolean) {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  }

  it("clicking a thread selects it and, where the conversation stacks, scrolls it into view", async () => {
    stub();
    narrow(true);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    fireEvent.click(await within(list).findByRole("button", { name: /studio/ }));
    expect(screen.getByRole("heading", { name: /^Thread ·/ })).toBeTruthy();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect((scroll.mock.contexts[0] as HTMLElement).id).toBe("chatP");
  });

  it("does not scroll when the conversation sits beside the list", async () => {
    stub();
    narrow(false);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    fireEvent.click(await within(list).findByRole("button", { name: /studio/ }));
    expect(screen.getByRole("heading", { name: /^Thread ·/ })).toBeTruthy();
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe("FLIGHT thread and the dock", () => {
  const seat = { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true };
  const ASK = item({ key: "esc:a#1", brief: brief(), text: "first ask" });
  const stubChat = (post: (b: unknown) => void = () => {}) =>
    stubFetch({
      "/api/attention": [ASK],
      "/api/crew": { rows: ROWS, firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": { seat, decisions: [] },
      "/api/agents/flight-1/stream": {
        runId: "f-1",
        events: [{ id: "e1", kind: "msg", text: "Hello from FLIGHT", at: NOW - MIN }],
        truncated: false,
        lastOutputAt: null,
        reason: null,
      },
      "POST /api/seats/flight-1/message": (init: RequestInit | undefined) => {
        post(JSON.parse(String(init?.body)));
        return { status: 200, body: { ok: true } };
      },
    });

  it("shows FLIGHT's conversation in #chatP whether or not the dock is shown, with unique ids", async () => {
    stubChat();
    render(
      <>
        <Dock />
        <Comms item={null} />
      </>,
    );
    act(() => toggleDock(true));
    const chat = document.querySelector("#chatP") as HTMLElement;
    await within(chat).findByText("Hello from FLIGHT");
    expect(within(chat).getByText("Waiting on you · 1")).toBeTruthy();
    expect(within(chat).getByText("first ask")).toBeTruthy();
    expect(chat.querySelector("#chatMsgs")).toBeTruthy();
    expect(chat.querySelector("#chatInput")).toBeTruthy();
    expect(document.querySelectorAll("#dockMsgs")).toHaveLength(1);
    expect(document.querySelectorAll("#chatMsgs")).toHaveLength(1);
    expect(chat.querySelector("#dockMsgs")).toBeNull();
    act(() => toggleDock(false));
    expect(chat.querySelector("#chatMsgs")).toBeTruthy();
  });

  it("opens a waiting ask from its Open button", async () => {
    stubChat();
    render(
      <>
        <Probe />
        <Comms item={null} />
      </>,
    );
    const chat = document.querySelector("#chatP") as HTMLElement;
    const ask = (await within(chat).findByText("first ask")).closest(".dask") as HTMLElement;
    fireEvent.click(within(ask).getByRole("button", { name: "Open" }));
    expect(screen.getByTestId("item").textContent).toBe("esc:a#1");
  });

  it("posts the message to FLIGHT's seat", async () => {
    const post = vi.fn();
    stubChat(post);
    render(<Comms item={null} />);
    const input = (await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>("#chatInput");
      expect(el?.disabled).toBe(false);
      return el;
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Reprioritise the board" } });
    fireEvent.submit(document.querySelector("#chatForm") as HTMLElement);
    await waitFor(() => expect(post).toHaveBeenCalledWith({ text: "Reprioritise the board" }));
  });

  it("says no seat is configured when there is none", async () => {
    stub();
    render(<Comms item={null} />);
    const chat = document.querySelector("#chatP") as HTMLElement;
    await waitFor(() => expect(within(chat).getByText(FLIGHT_NO_SEAT)).toBeTruthy());
    expect(document.querySelector("#chatMsgs")).toBeNull();
  });
});

describe("An agent's thread: the message box", () => {
  const stubThread = (rows: unknown[], post: (b: unknown) => void = () => {}) =>
    stubFetch({
      "/api/attention": [],
      "/api/crew": { rows, firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "/api/activity": [],
      "POST /api/seats/guido-1/message": (init: RequestInit | undefined) => {
        post(JSON.parse(String(init?.body)));
        return { status: 200, body: { ok: true } };
      },
    });
  const openThread = async (name: RegExp) => {
    const list = document.querySelector("#chanList") as HTMLElement;
    fireEvent.click(await within(list).findByRole("button", { name }));
  };

  it("says a running seat is reached mid-turn", async () => {
    stubThread([seatRow({ hudState: "running" })]);
    render(<Comms item={null} />);
    await openThread(/^guido-1/);
    const input = await screen.findByPlaceholderText("Message GUIDO-1 (reaches it mid-turn)…");
    expect(input).toBeTruthy();
  });

  it("says an idle seat's message is queued, and posts it to the seat", async () => {
    const post = vi.fn();
    stubThread([seatRow({ hudState: "idle" })], post);
    render(<Comms item={null} />);
    await openThread(/^guido-1/);
    const input = await screen.findByPlaceholderText(
      "Message GUIDO-1 (queued until its next turn)…",
    );
    fireEvent.change(input, { target: { value: "Use the cache" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith({ text: "Use the cache" }));
  });

  it("gives an observed loop's thread no box", async () => {
    stubThread([crewRow()]);
    render(<Comms item={null} />);
    await openThread(/^shop-app-ta/);
    await waitFor(() => expect(document.querySelector("#chatP #convo, #chatP .note")).toBeTruthy());
    expect(document.querySelector("#chatP form")).toBeNull();
  });
});

describe("Needs you: row actions", () => {
  const live = { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true };
  const LOCK = {
    holder: { runId: "r-1", seatId: "guido-1", command: "pnpm -s test", since: NOW - 12 * MIN },
    waiting: [{ runId: "r-2", seatId: "guido-2", command: "pnpm -s test", since: NOW - MIN }],
  };
  const stall = (agentId: string) =>
    item({
      key: `stall:${agentId}`,
      kind: "stalled",
      agentId,
      escalationId: null,
      url: null,
      tool: "Bash",
      text: "No output",
      at: NOW - 5 * MIN,
    });
  const stray = item({
    key: "stray:1",
    kind: "stray",
    agentId: "guido-1",
    escalationId: null,
    url: null,
    ticket: null,
    text: "apps/odd.ts sits outside every area.",
  });
  const posts: { path: string; body: unknown }[] = [];
  const route = (path: string, status = 200, body: unknown = { ok: true }) => ({
    [`POST ${path}`]: (init: RequestInit | undefined) => {
      posts.push({ path, body: JSON.parse(String(init?.body)) });
      return { status, body };
    },
  });
  const stubNeeds = (items: AttentionItem[], flight: unknown = { seat: live, decisions: [] }) => {
    posts.length = 0;
    return stubFetch({
      "/api/attention": items,
      "/api/crew": {
        rows: [
          seatRow({ id: "guido-1", hudState: "stalled" }),
          seatRow({ id: "guido-2", index: 1, hudState: "stalled" }),
          seatRow({ id: "flight-1", index: 2 }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
      "/api/flight": flight,
      "/api/test-lock": LOCK,
      ...route("/api/seats/guido-1/interrupt"),
      ...route("/api/seats/guido-2/interrupt"),
      ...route("/api/seats/flight-1/message"),
    });
  };
  const rowOf = async (text: string | RegExp) =>
    (await within(needs()).findByText(text)).closest(".nrow") as HTMLElement;

  it("an approval and a question with no escalation read Answer, and it opens the Item panel", async () => {
    stubNeeds([
      item({
        key: "ap:1",
        kind: "approval",
        escalationId: null,
        url: null,
        text: "Run the migration?",
      }),
      SEAT_Q,
    ]);
    render(
      <>
        <Comms item={null} />
        <Probe />
      </>,
    );
    const ap = await rowOf("Run the migration?");
    expect(within(ap).queryByRole("button", { name: /Read the brief|Discuss/ })).toBeNull();
    fireEvent.click(within(ap).getByRole("button", { name: "Answer" }));
    expect(screen.getByTestId("item").textContent).toBe("ap:1");
  });

  it("a lock item and the stalled holder read Stop the run, which interrupts the holder", async () => {
    stubNeeds([
      item({
        key: "lock:1",
        kind: "lock",
        agentId: "guido-1",
        escalationId: null,
        url: null,
        text: "GUIDO-1 holds the test lock and has printed nothing",
      }),
      stall("guido-1"),
    ]);
    render(<Comms item={null} />);
    await within(needs()).findByText(/holds the test lock/);
    const stops = await within(needs()).findAllByRole("button", { name: "Stop the run" });
    expect(stops).toHaveLength(2);
    expect(within(needs()).queryByRole("button", { name: "Interrupt" })).toBeNull();
    fireEvent.click(stops[0] as HTMLElement);
    await waitFor(() =>
      expect(posts).toContainEqual({ path: "/api/seats/guido-1/interrupt", body: {} }),
    );
  });

  it("another stalled item reads Interrupt", async () => {
    stubNeeds([stall("guido-2")]);
    render(<Comms item={null} />);
    const row = await rowOf(/in Bash/);
    expect(within(row).queryByRole("button", { name: "Stop the run" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Interrupt" }));
    await waitFor(() =>
      expect(posts).toContainEqual({ path: "/api/seats/guido-2/interrupt", body: {} }),
    );
  });

  it("a refused interrupt shows in the error line", async () => {
    stubFetch({
      "/api/attention": [stall("guido-2")],
      "/api/crew": { rows: [seatRow({ id: "guido-2" })], firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": { seat: live, decisions: [] },
      "/api/test-lock": { holder: null, waiting: [] },
      "POST /api/seats/guido-2/interrupt": () => ({
        status: 409,
        body: { error: "no turn to stop" },
      }),
    });
    render(<Comms item={null} />);
    const row = await rowOf(/in Bash/);
    fireEvent.click(within(row).getByRole("button", { name: "Interrupt" }));
    expect(await within(needs()).findByText("no turn to stop")).toBeTruthy();
  });

  it("a stray's Ask FLIGHT posts the question to FLIGHT and selects its thread", async () => {
    stubNeeds([stray]);
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    // its lamp names the thread's button before the call sign
    fireEvent.click(await within(list).findByRole("button", { name: /guido-1/ }));
    await waitFor(() => expect(document.querySelector("#chatP form")).toBeTruthy());
    expect(document.querySelector("#chatMsgs")).toBeNull();
    const row = await rowOf(/outside every area/);
    await waitFor(() =>
      expect(
        (within(row).getByRole("button", { name: "Ask FLIGHT" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(within(row).getByRole("button", { name: "Ask FLIGHT" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      path: "/api/seats/flight-1/message",
      body: { text: "apps/odd.ts sits outside every area. Whose is it?" },
    });
    await waitFor(() => expect(document.querySelector("#chatP #chatMsgs")).toBeTruthy());
  });

  it("Ask FLIGHT is off, with the reason, while FLIGHT is not live", async () => {
    stubNeeds([stray], { seat: { ...live, live: false }, decisions: [] });
    render(<Comms item={null} />);
    const row = await rowOf(/outside every area/);
    const b = within(row).getByRole("button", { name: "Ask FLIGHT" }) as HTMLButtonElement;
    await waitFor(() => expect(b.title).toBe("FLIGHT is stopped."));
    expect(b.disabled).toBe(true);
  });
});

describe("Needs you: the crew's items", () => {
  const strayItem = item({
    key: "stray:s1:shop-app-ta:docs/x.md",
    kind: "stray",
    agentId: "shop-app-ta",
    escalationId: null,
    url: null,
    ticket: null,
    text: "docs/x.md changed outside its area",
  });
  const askItem = item({
    key: "ask:7",
    kind: "question",
    agentId: "shop-app-ta",
    escalationId: null,
    url: null,
    ticket: null,
    text: "GUIDO-1 asks: which cache?",
  });
  const lockItem = item({
    key: "lock:r-12",
    kind: "lock",
    agentId: "shop-app-ta",
    escalationId: null,
    url: null,
    ticket: null,
    text: "1 waiting for the test lock",
  });
  const errItem = item({
    key: "crew-error:4",
    kind: "error",
    agentId: "shop-app-ta",
    escalationId: null,
    url: null,
    ticket: null,
    text: "Seat crashed",
  });

  it("a stray has Ack and no Open", async () => {
    stub([strayItem]);
    render(<Comms item={null} />);
    await screen.findByText("docs/x.md changed outside its area");
    const row = needs().querySelector(".nrow") as HTMLElement;
    expect(within(row).getByText("Stray file")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Ack" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Open" })).toBeNull();
  });

  it.each([
    ["question", askItem, "Question"],
    ["lock", lockItem, "Test lock"],
    ["crew error", errItem, "Error"],
  ])("a %s has Open, to the Agent page, and Ack", async (_n, it_, label) => {
    stub([it_]);
    render(<Comms item={null} />);
    await screen.findByText(it_.text);
    const row = needs().querySelector(".nrow") as HTMLElement;
    expect(within(row).getByText(label)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Ack" })).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Open" }));
    expect(window.location.pathname).toBe("/agent/shop-app-ta");
  });
});

describe("Guard drawer", () => {
  const drawer = () => document.querySelector("details#cGuard") as HTMLDetailsElement;

  describe("opened from a link", () => {
    afterEach(() => {
      window.history.replaceState(null, "", "/");
    });

    it("/comms#cGuard opens the drawer and scrolls to it once it has rendered", async () => {
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      window.history.replaceState(null, "", "/comms#cGuard");
      stub([], () => {}, { hits: [hit(12)], counts: { "git-write": 1 } });
      render(<Comms item={null} />);
      await screen.findByText(guardSummary(1, 1));
      expect(drawer().open).toBe(true);
      expect(scroll).toHaveBeenCalled();
    });

    it("opens and scrolls when the hash changes to #cGuard with Comms already open", async () => {
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      window.history.replaceState(null, "", "/comms");
      stub([], () => {}, { hits: [hit(12)], counts: { "git-write": 1 } });
      render(<Comms item={null} />);
      await screen.findByText(guardSummary(1, 1));
      expect(drawer().open).toBe(false);
      act(() => {
        window.location.hash = "#cGuard";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(drawer().open).toBe(true);
      expect(scroll).toHaveBeenCalled();
    });

    it("stays shut without the hash", async () => {
      window.history.replaceState(null, "", "/comms");
      stub([], () => {}, { hits: [hit(12)], counts: { "git-write": 1 } });
      render(<Comms item={null} />);
      await screen.findByText(guardSummary(1, 1));
      expect(drawer().open).toBe(false);
    });
  });

  it("is a details with the count, the new count, rows and Ack", async () => {
    const posts: unknown[] = [];
    stub([], (b) => posts.push(b), {
      hits: [
        hit(12),
        hit(11, { rule: "network", agentId: "studio", acked: true }),
        hit(10, { rule: "full-suite" }),
      ],
      counts: { "git-write": 1, network: 1, "full-suite": 1 },
    });
    render(<Comms item={null} />);
    await screen.findByText(guardSummary(3, 2));
    const d = drawer();
    expect(d.tagName).toBe("DETAILS");
    expect(d.open).toBe(false);
    const rows = [...d.querySelectorAll<HTMLElement>(".nrow")];
    expect(rows).toHaveLength(3);
    const first = rows[0] as HTMLElement;
    expect(first.textContent).toContain("⊘");
    expect(within(first).getByText("shop-app-ta")).toBeTruthy();
    expect(first.textContent).toContain("git writes only through the mc tools: git push (12)");
    expect(first.textContent).toContain("12:55 · rule: git-write");
    expect(rows[1]?.className).toContain("acked");
    expect(within(rows[1] as HTMLElement).queryByRole("button", { name: /^Ack/ })).toBeNull();
    expect(rows[1]?.textContent).toContain("rule: network");
    fireEvent.click(within(first).getByRole("button", { name: /^Ack/ }));
    await waitFor(() => expect(posts).toEqual([{ keys: ["guard:12"] }]));
  });

  it("an Ack refetches the hits, so the row greys and the new count drops", async () => {
    let acked = false;
    stub([], undefined, () => ({
      status: 200,
      body: { hits: [hit(12, { acked })], counts: { "git-write": 1 } },
    }));
    render(<Comms item={null} />);
    await screen.findByText(guardSummary(1, 1));
    acked = true;
    fireEvent.click(within(drawer()).getByRole("button", { name: /^Ack/ }));
    await screen.findByText(guardSummary(1, 0));
    expect(drawer().querySelector(".nrow")?.className).toContain("acked");
  });

  it("each Ack is named by its hit", async () => {
    stub([], undefined, { hits: [hit(12)], counts: { "git-write": 1 } });
    render(<Comms item={null} />);
    await screen.findByText(guardSummary(1, 1));
    expect(
      within(drawer()).getByRole("button", {
        name: "Ack: git writes only through the mc tools: git push (12)",
      }),
    ).toBeTruthy();
  });

  it("the summary total is the window's count, not the capped list's", async () => {
    stub([], undefined, { hits: [hit(12), hit(11)], counts: { "git-write": 600, network: 40 } });
    render(<Comms item={null} />);
    await screen.findByText("Guard: 640 blocked commands, 2 new (for information)");
  });

  it("the summary is singular for one hit, with no new count once acknowledged", async () => {
    stub([], undefined, { hits: [hit(3, { acked: true })], counts: { "git-write": 1 } });
    render(<Comms item={null} />);
    await screen.findByText("Guard: 1 blocked command (for information)");
    expect(guardSummary(1, 0)).toBe("Guard: 1 blocked command (for information)");
  });

  it("empty: nothing blocked this week", async () => {
    stub();
    render(<Comms item={null} />);
    await screen.findByText(GUARD_NONE_TEXT);
    expect(drawer().tagName).toBe("DETAILS");
    expect(drawer().querySelectorAll(".nrow")).toHaveLength(0);
  });
});

describe("Needs you: FLIGHT replied", () => {
  function DockProbe() {
    const dock = useDock();
    return <span data-testid="dock">{dock.visible ? "visible" : "hidden"}</span>;
  }

  it("shows while a reply is unread, and opens the dock", async () => {
    stub([]);
    render(
      <>
        <DockProbe />
        <Comms item={null} />
      </>,
    );
    await screen.findByText("Nothing needs you right now.");
    act(() => {
      toggleDock(false);
      setFlightUnread(2);
    });
    const row = (await screen.findByText("FLIGHT replied (2)")).closest(".nrow") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "Ack" })).toBeNull();
    expect(screen.getByTestId("dock").textContent).toBe("hidden");
    fireEvent.click(within(row).getByRole("button", { name: "Open the chat" }));
    expect(screen.getByTestId("dock").textContent).toBe("visible");
    act(() => setFlightUnread(0));
    expect(screen.queryByText(/FLIGHT replied/)).toBeNull();
  });
});
