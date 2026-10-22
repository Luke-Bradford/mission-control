import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AttentionItem,
  FLIGHT_NOT_RUNNING,
  GUARD_NONE_TEXT,
  type GuardHitsView,
  guardSummary,
} from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Comms } from "../src/pages/Comms.tsx";
import { toggleDock, useItem } from "../src/shell/overlays.ts";
import { setSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, crewRow, item, NOW, prView, seatRow, stoppedSeat } from "./fixtures.ts";

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
    stub();
    render(<Comms item={null} />);
    const list = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("#chanList") as HTMLElement;
      expect(within(el).getByText("studio")).toBeTruthy();
      return el;
    });
    const buttons = within(list).getAllByRole("button");
    expect(buttons[0]?.textContent).toContain("Head");
    expect(buttons[0]?.textContent).toContain(FLIGHT_NOT_RUNNING);
    expect(within(list).getByText(/Idle since/)).toBeTruthy();
    expect(within(list).getByText(/^run #12/)).toBeTruthy();
    act(() => setSession("shop-app"));
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

  it("FLIGHT shows its placeholder; an agent shows its head and the mailbox note", async () => {
    stub();
    render(<Comms item={null} />);
    expect((await screen.findAllByText(FLIGHT_NOT_RUNNING)).length).toBe(1); // the thread row
    expect(screen.getByText("FLIGHT's chat is in the dock.")).toBeTruthy();
    const list = document.querySelector("#chanList") as HTMLElement;
    fireEvent.click(await within(list).findByRole("button", { name: /studio/ }));
    expect(screen.getByText("Threads arrive with the mailbox (phase 2).")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See its activity" }).getAttribute("href")).toBe(
      "/agent/studio",
    );
    const head = screen.getByRole("heading", { name: /^Thread ·/ });
    expect(head.textContent).toBe("Thread · studio · Idle");
    screen.getByText("everything studio sent or received: you, FLIGHT and other agents");
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
  it("says the chat is in the dock while it is visible, and repeats the placeholder when it is not", async () => {
    stub();
    render(<Comms item={null} />);
    expect(await screen.findByText("FLIGHT's chat is in the dock.")).toBeTruthy();
    act(() => toggleDock(false));
    await waitFor(() => expect(screen.queryByText("FLIGHT's chat is in the dock.")).toBeNull());
    expect(screen.getAllByText(FLIGHT_NOT_RUNNING).length).toBe(2);
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
