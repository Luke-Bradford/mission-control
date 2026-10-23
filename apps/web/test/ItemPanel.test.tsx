import type { AttentionItem, AutonomyQuestion } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { hub, RESOURCES } from "../src/data.ts";
import { FLIGHT_NO_SEAT, FLIGHT_STOPPED } from "../src/flight/flightTypes.ts";
import type { PersonThreadView } from "../src/notifications.ts";
import { navigate } from "../src/router.ts";
import { Dock } from "../src/shell/Dock.tsx";
import { ItemPanel } from "../src/shell/ItemPanel.tsx";
import { installKeys } from "../src/shell/keys.ts";
import { closeItem, openItem, syncItem, toggleDock, useItem } from "../src/shell/overlays.ts";
import { stubFetch } from "./fetchStub.ts";
import { brief, CONFIG, crewRow, escalation, HOUR, item, NOW, SEAT_Q } from "./fixtures.ts";

const KEY = `person:101:${NOW - HOUR}`;
const N = 12;
const URL = `${"https://github.com"}/octo-org/shop-app/issues/${N}`;
const thread = (over: Partial<PersonThreadView> = {}): PersonThreadView => ({
  key: KEY,
  id: "101",
  repoId: "shop-app",
  github: "octo-org/shop-app",
  subjectType: "Issue",
  number: N,
  title: "Fix the stop race",
  reason: "mention",
  reasonText: "mentioned you",
  author: "alice",
  snippet: "can you look?",
  url: URL,
  updatedAt: NOW - HOUR,
  firstSeenAt: NOW - HOUR,
  catchUp: "new",
  ...over,
});
const personItem = item({
  key: KEY,
  kind: "person",
  agentId: null,
  escalationId: null,
  ticket: null,
  url: URL,
  text: "alice mentioned you: Fix the stop race",
});

const QUESTION: AutonomyQuestion = {
  question: "Which eviction policy should the quote cache use?",
  recommendation: "LRU with a 5 minute TTL",
  reasoning_quote: "Two prior tickets chose LRU; nothing here argues against it.",
  effort_sunk: "Three runs, about 40 minutes",
  default_if_ignored: "The loop waits",
  answers: ["LRU with a 5 minute TTL", "LFU", "No cache"],
};

function open(
  items: AttentionItem[],
  escalations = [escalation({ question: QUESTION })],
  key = items[0]?.key ?? "",
) {
  stubFetch({
    "/api/attention": items,
    "/api/escalations": escalations,
    "/api/crew": { rows: [crewRow({ id: "shop-app-ta", index: 2 })], firstRunToday: null },
    "/api/config": CONFIG,
  });
  const view = render(<ItemPanel />);
  act(() => openItem(key));
  return view;
}

let off: () => void;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const noop = () => {};
  off = installKeys({
    navigate: noop,
    toggleDock: noop,
    help: noop,
    selectNext: noop,
    selectPrev: noop,
    toast: noop,
  });
});
afterEach(() => {
  off();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ItemPanel, Ask FLIGHT", () => {
  const withFlight = (flight: unknown) => {
    const fn = stubFetch({
      "/api/attention": [item()],
      "/api/escalations": [escalation({ question: QUESTION })],
      "/api/crew": { rows: [crewRow({ id: "shop-app-ta", index: 2 })], firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": flight,
      "POST /api/seats/flight-1/message": {},
    });
    render(<ItemPanel />);
    act(() => openItem(item().key));
    return fn;
  };

  it("is switched off with no live seat", async () => {
    withFlight({ seat: null, decisions: [] });
    await screen.findByText("Which eviction policy should the quote cache use?");
    expect(
      (screen.getByLabelText("Reply, or ask FLIGHT about this") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Ask FLIGHT" }).getAttribute("title")).toBe(
      FLIGHT_NO_SEAT,
    );
    expect((screen.getByRole("button", { name: "Ask FLIGHT" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("posts the text, led by the item's key and title, to the live FLIGHT seat", async () => {
    const fn = withFlight({
      seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true },
      decisions: [],
    });
    const input = (await screen.findByLabelText(
      "Reply, or ask FLIGHT about this",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: " why? " } });
    fireEvent.click(screen.getByRole("button", { name: "Ask FLIGHT" }));
    await waitFor(() => expect(input.value).toBe(""));
    const call = fn.mock.calls.find(([p]) => p === "/api/seats/flight-1/message");
    const text = JSON.parse(call?.[1]?.body as string).text as string;
    expect(text).toContain("Choose a cache eviction policy");
    expect(text.endsWith("why?")).toBe(true);
  });

  const sent = async (items: AttentionItem[]) => {
    const fn = stubFetch({
      "/api/attention": items,
      "/api/escalations": [],
      "/api/crew": { rows: [crewRow({ id: "shop-app-ta", index: 2 })], firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": {
        seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true },
        decisions: [],
      },
      "POST /api/seats/flight-1/message": {},
    });
    render(<ItemPanel />);
    act(() => openItem(items[0]?.key ?? ""));
    const input = (await screen.findByLabelText(
      "Reply, or ask FLIGHT about this",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: " why? " } });
    fireEvent.click(screen.getByRole("button", { name: "Ask FLIGHT" }));
    await waitFor(() => expect(input.value).toBe(""));
    const call = fn.mock.calls.find(([p]) => p === "/api/seats/flight-1/message");
    expect(call).toBeTruthy();
    return JSON.parse(call?.[1]?.body as string).text as string;
  };

  it("leads with the key alone from an item with no title to quote", async () => {
    expect(await sent([item({ escalationId: null, text: "" })])).toBe(
      "Re: esc:shop-app#4001\n\nwhy?",
    );
  });

  it("a whitespace-only title gets no Re: line either", async () => {
    expect(await sent([item({ escalationId: null, text: "   " })])).toBe(
      "Re: esc:shop-app#4001\n\nwhy?",
    );
  });

  it("leads with Re:, the key, a blank line and the body when the item has text", async () => {
    expect(await sent([item({ escalationId: null, text: "Stalled on tests" })])).toBe(
      "Re: esc:shop-app#4001 · Stalled on tests\n\nwhy?",
    );
  });
});

describe("ItemPanel, an escalation with a question", () => {
  it("heads it with the kind, the agent and when it opened", async () => {
    const { container } = open([item()]);
    await screen.findByText("Which eviction policy should the quote cache use?");
    const head = container.querySelector("#dsHead") as HTMLElement;
    expect(within(head).getByRole("heading").textContent).toBe("Decision");
    expect(within(head).getByText("shop-app-ta")).toBeTruthy();
    await waitFor(() => expect(head.textContent).toContain("opened 3 h ago"));
  });

  it("opens with a catch-up: New under 24 hours, Follow-up after", async () => {
    open([item()]);
    const catchup = (await screen.findByText("Catch-up")).parentElement as HTMLElement;
    expect(within(catchup).getByText("New")).toBeTruthy();
    expect(catchup.textContent).toContain("Opened 17 Oct on shop-app #4001");
  });

  it("is a Follow-up when it is older", async () => {
    open([item()], [escalation({ question: QUESTION, openedAt: NOW - 30 * HOUR })]);
    const catchup = (await screen.findByText("Catch-up")).parentElement as HTMLElement;
    expect(within(catchup).getByText("Follow-up")).toBeTruthy();
    expect(within(catchup).queryByText("New")).toBeNull();
    expect(catchup.textContent).toContain("Opened 16 Oct on shop-app #4001");
  });

  it("renders the question's Markdown", async () => {
    open(
      [item()],
      [escalation({ question: { ...QUESTION, question: "Use **LRU**?\n\n1. yes\n2. no" } })],
    );
    const strong = await screen.findByText("LRU");
    expect(strong.tagName).toBe("STRONG");
    expect(document.querySelectorAll("#dsBrief ol li").length).toBe(2);
  });

  it("renders the reasoning, effort and default parts' Markdown", async () => {
    open(
      [item()],
      [
        escalation({
          question: {
            ...QUESTION,
            reasoning_quote: "Because **prior** tickets",
            effort_sunk: "About `40` minutes",
            default_if_ignored: "- waits\n- retries",
          },
        }),
      ],
    );
    expect((await screen.findByText("prior")).tagName).toBe("STRONG");
    expect(screen.getByText("40").tagName).toBe("CODE");
    expect(document.querySelectorAll("#dsBrief ul li").length).toBe(2);
  });

  it("shows the title and each part of the question", async () => {
    const { container } = open([item()]);
    await screen.findByText(QUESTION.question);
    const brief = container.querySelector("#dsBrief") as HTMLElement;
    expect(brief.textContent).toContain("Choose a cache eviction policy");
    const section = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
    expect(section("What is being asked")).toBe(QUESTION.question);
    expect(section("Why it came to you")).toBe(QUESTION.reasoning_quote);
    expect(section("Effort so far")).toBe(QUESTION.effort_sunk);
    expect(section("If nobody answers")).toBe(QUESTION.default_if_ignored);
  });

  it("lists the answers as cards, Recommended on the one the loop recommended", async () => {
    open([item()]);
    await screen.findByText("LFU");
    const cards = document.querySelectorAll("#dsOpts .opt");
    expect([...cards].map((c) => c.querySelector("b")?.textContent)).toEqual(QUESTION.answers);
    const rec = [...cards].filter((c) => c.textContent?.includes("Recommended"));
    expect(rec).toHaveLength(1);
    expect(rec[0]?.textContent).toContain("LRU with a 5 minute TTL");
    expect(rec[0]?.querySelector(".pill")?.className).toBe("pill plain");
    expect(screen.queryByText(/FLIGHT recommends/)).toBeNull();
  });

  it("keeps a card per answer when two answers say the same thing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    open([item()], [escalation({ question: { ...QUESTION, answers: ["Yes", "Yes", "No"] } })]);
    await screen.findByText("No");
    const cards = document.querySelectorAll("#dsOpts .opt");
    expect([...cards].map((c) => c.querySelector("b")?.textContent)).toEqual(["Yes", "Yes", "No"]);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    errors.mockRestore();
  });

  it("links to the issue on GitHub, in a new tab", async () => {
    open([item()]);
    const a = (await screen.findByRole("link", {
      name: "Reply on GitHub ↗",
    })) as HTMLAnchorElement;
    expect(a.href).toBe("https://github.com/octo-org/shop-app/issues/4001");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
  });

  it("has the chat switched off", async () => {
    open([item()]);
    await screen.findByText(QUESTION.question);
    const input = screen.getByLabelText("Reply, or ask FLIGHT about this") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("Reply, or ask FLIGHT about this…");
    expect(input.title).toBe(FLIGHT_NO_SEAT);
  });
});

describe("ItemPanel, acting on an item", () => {
  const FLIGHT_SEAT = {
    id: "flight-1",
    call: "FLIGHT-1",
    model: "opus",
    state: "idle",
    live: true,
  };
  const ROWS = [
    crewRow({ id: "mc-dev-1", index: 1, kind: "crew" }),
    crewRow({ id: "flight-1", index: 0, kind: "crew" }),
  ];
  const posts = (fn: ReturnType<typeof stubFetch>, path: string) =>
    fn.mock.calls
      .filter(([p, init]) => p === path && init?.method === "POST")
      .map(([, init]) => JSON.parse(init?.body as string));
  const BLOCKED = item({
    key: "note:blocked:r1:0",
    kind: "blocked",
    escalationId: null,
    url: null,
  });
  const DISMISS = "POST /api/attention/note%3Ablocked%3Ar1%3A0/dismiss";

  function acting(items: AttentionItem[], routes: Record<string, unknown> = {}) {
    const fn = stubFetch({
      "/api/attention": items,
      "/api/escalations": [escalation()],
      "/api/crew": { rows: ROWS, firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": { seat: FLIGHT_SEAT, decisions: [] },
      "POST /api/seats/mc-dev-1/message": {},
      "POST /api/seats/flight-1/message": {},
      ...routes,
    });
    render(
      <>
        <Dock />
        <ItemPanel />
      </>,
    );
    act(() => openItem(items[0]?.key ?? ""));
    return fn;
  }
  const panel = () => document.querySelector("#discuss") as HTMLElement;
  const enabled = async (name: string) => {
    const b = (await within(panel()).findByRole("button", { name })) as HTMLButtonElement;
    await waitFor(() => expect(b.disabled).toBe(false));
    return b;
  };

  it("renders FLIGHT's brief: context, recommendation and an option per choice", async () => {
    acting([SEAT_Q]);
    await within(panel()).findByText("The dev seat asks which port to preview on.");
    expect(within(panel()).getByText("Use 5174.")).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "5174" })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "5180" })).toBeTruthy();
  });

  it("an option on a seat's question posts its answer to that seat", async () => {
    const fn = acting([SEAT_Q]);
    fireEvent.click(await enabled("5174"));
    await waitFor(() =>
      expect(posts(fn, "/api/seats/mc-dev-1/message")).toEqual([{ text: "Use port 5174." }]),
    );
    expect(posts(fn, "/api/seats/flight-1/message")).toEqual([]);
  });

  it("an option on FLIGHT's own question posts to FLIGHT and opens the dock", async () => {
    act(() => toggleDock(false));
    const fn = acting([{ ...SEAT_Q, agentId: "flight-1" }]);
    fireEvent.click(await enabled("5180"));
    await waitFor(() =>
      expect(posts(fn, "/api/seats/flight-1/message")).toEqual([
        { text: "Re: ask:7 · Which port?\n\nUse port 5180." },
      ]),
    );
    await waitFor(() =>
      expect(document.querySelector("#dock")?.hasAttribute("hidden")).toBe(false),
    );
  });

  it("an escalation's options are text beside Reply on GitHub, and nothing is posted", async () => {
    const fn = acting([item({ brief: brief() })]);
    const link = (await within(panel()).findByRole("link", {
      name: "Reply on GitHub ↗",
    })) as HTMLAnchorElement;
    expect(link.href).toBe(item().url);
    expect(within(panel()).queryByRole("button", { name: "5174" })).toBeNull();
    expect(document.querySelector("#dsOpts")?.textContent).toContain("Use port 5174.");
    expect(within(panel()).queryByRole("button", { name: "Reply" })).toBeNull();
    expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
  });

  const STOPPED = { "/api/flight": { seat: { ...FLIGHT_SEAT, live: false }, decisions: [] } };

  it("with FLIGHT stopped, a seat's item still replies and Ask FLIGHT is disabled", async () => {
    const fn = acting([SEAT_Q], STOPPED);
    fireEvent.click(await enabled("5174"));
    await waitFor(() =>
      expect(posts(fn, "/api/seats/mc-dev-1/message")).toEqual([{ text: "Use port 5174." }]),
    );
    const ask = within(panel()).getByRole("button", { name: "Ask FLIGHT" }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    expect(ask.title).toBe(FLIGHT_STOPPED);
  });

  it("with FLIGHT stopped, an answer for FLIGHT cannot be sent", async () => {
    acting([{ ...SEAT_Q, agentId: "flight-1" }], STOPPED);
    const opt = (await within(panel()).findByRole("button", { name: "5174" })) as HTMLButtonElement;
    await waitFor(() => expect(opt.title).toBe(FLIGHT_STOPPED));
    expect(opt.disabled).toBe(true);
    expect(
      (within(panel()).getByRole("button", { name: "Reply" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("Dismiss posts the dismiss route, refreshes the list and closes the panel", async () => {
    const fn = acting([BLOCKED], { [DISMISS]: { dismissed: BLOCKED.key } });
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(document.querySelector("#discuss")).toBeNull());
    expect(posts(fn, "/api/attention/note%3Ablocked%3Ar1%3A0/dismiss")).toEqual([{}]);
    expect(fn.mock.calls.filter(([p]) => p === "/api/attention").length).toBeGreaterThanOrEqual(2);
  });

  it("Dismiss shows the refusal text and keeps the panel", async () => {
    acting([BLOCKED], {
      [DISMISS]: () => ({ status: 404, body: { error: "no such open note" } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect((await screen.findByRole("alert")).textContent).toBe("no such open note");
    expect(document.querySelector("#discuss")).toBeTruthy();
  });

  it("an item without a brief still offers Reply, Ask FLIGHT and Dismiss", async () => {
    const fn = acting([{ ...SEAT_Q, brief: undefined }]);
    const input = (await screen.findByLabelText(
      "Reply, or ask FLIGHT about this",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(document.querySelector("#dsOpts")).toBeNull();
    fireEvent.change(input, { target: { value: " port? " } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() =>
      expect(posts(fn, "/api/seats/mc-dev-1/message")).toEqual([{ text: "port?" }]),
    );
    await waitFor(() => expect(input.value).toBe(""));
    fireEvent.change(input, { target: { value: " port? " } });
    fireEvent.click(screen.getByRole("button", { name: "Ask FLIGHT" }));
    await waitFor(() =>
      expect(posts(fn, "/api/seats/flight-1/message")).toEqual([
        { text: "Re: ask:7 · Which port?\n\nport?" },
      ]),
    );
  });
});

describe("ItemPanel, while the escalations load", () => {
  it("holds the escalation view back instead of flashing the generic one", async () => {
    const fetchFn = stubFetch({
      "/api/attention": [item()],
      "/api/escalations": [escalation({ question: QUESTION })],
      "/api/crew": { rows: [crewRow({ id: "shop-app-ta", index: 2 })], firstRunToday: null },
      "/api/config": CONFIG,
    });
    const answer = fetchFn.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fetchFn.mockImplementation(async (...a: unknown[]) => {
      if (a[0] === "/api/escalations") await gate;
      return answer(...a);
    });
    render(<ItemPanel />);
    act(() => openItem("esc:shop-app#4001"));
    await screen.findByText("Decision", { selector: "h2" });
    expect(screen.queryByText("Choose a cache eviction policy")).toBeNull();
    expect(screen.queryByText("Open shop-app-ta")).toBeNull();
    expect(document.querySelector("#dsHead .sub")).toBeNull();
    release();
    await screen.findByText("Which eviction policy should the quote cache use?");
    expect(document.querySelector("#dsHead .sub")).not.toBeNull();
  });

  it("falls back to the generic view when the escalations fail to load", async () => {
    stubFetch({
      "/api/attention": [item()],
      "/api/escalations": () => ({ status: 500, body: { error: "boom" } }),
      "/api/crew": { rows: [crewRow({ id: "shop-app-ta", index: 2 })], firstRunToday: null },
      "/api/config": CONFIG,
    });
    render(<ItemPanel />);
    act(() => openItem("esc:shop-app#4001"));
    await screen.findByText("Choose a cache eviction policy");
    screen.getByText("Open shop-app-ta");
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});

describe("ItemPanel, other items", () => {
  it("an escalation without a question is its title and the link", async () => {
    open([item()], [escalation({ question: null })]);
    await screen.findByRole("link", { name: "Reply on GitHub ↗" });
    const brief = document.querySelector("#dsBrief") as HTMLElement;
    expect(brief.textContent).toContain("Choose a cache eviction policy");
    expect(screen.queryByText("What is being asked")).toBeNull();
    expect(document.querySelector("#dsOpts .opt")).toBeNull();
    expect(screen.queryByText("Recommended")).toBeNull();
  });

  it("a stall is its text and a link to the agent", async () => {
    open([
      item({
        key: "stall:shop-app-ta:r-12",
        kind: "stalled",
        text: "No output for 12:03 in Bash",
        escalationId: null,
        url: null,
      }),
    ]);
    await screen.findByText("No output for 12:03 in Bash");
    expect(
      within(document.querySelector("#dsHead") as HTMLElement).getByRole("heading").textContent,
    ).toBe("Stalled");
    const a = screen.getByRole("link", { name: "Open shop-app-ta" });
    expect(a.getAttribute("href")).toBe("/agent/shop-app-ta");
    expect(screen.queryByRole("link", { name: /GitHub/ })).toBeNull();
  });

  it("a generic brief renders its Markdown, and plain prose comes through unchanged", async () => {
    open([
      item({
        kind: "error",
        escalationId: null,
        url: null,
        text: "Failed: **lint**\n\n1. fix\n2. rerun",
      }),
    ]);
    expect((await screen.findByText("lint")).tagName).toBe("STRONG");
    expect(document.querySelectorAll("#dsBrief ol li").length).toBe(2);
    cleanup();
    const plain = "Edited __init__.py and a*b, step 1. then - done; snake_case.";
    open([item({ kind: "error", escalationId: null, url: null, text: plain })]);
    await screen.findByText(plain);
    expect(document.querySelector("#dsBrief .qtext")?.textContent).toBe(plain);
  });

  it("never links a URL that is not GitHub", async () => {
    open([item({ kind: "error", escalationId: null, url: "javascript:alert(1)", text: "boom" })]);
    await screen.findByText("boom");
    expect(screen.queryByRole("link", { name: /GitHub/ })).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("says so when the item is gone", async () => {
    open([item()], [], "esc:gone");
    await screen.findByText("This item is no longer open.");
  });
});

describe("ItemPanel closing", () => {
  function Probe() {
    return <span data-testid="open">{String(useItem())}</span>;
  }

  it("gives focus back to what had it when it closes", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    open([item()]);
    const close = await screen.findByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("gives focus back to what had it when Esc closes it", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    open([item()]);
    await screen.findByRole("button", { name: "Close" });
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps Tab and Shift+Tab inside the panel", async () => {
    open([item()]);
    await screen.findByRole("button", { name: "Close" });
    const panel = document.querySelector("#discuss") as HTMLElement;
    const stops = [...panel.querySelectorAll<HTMLElement>("button, a[href]")].filter(
      (el) => !el.hasAttribute("disabled"),
    );
    const last = stops.at(-1) as HTMLElement;
    const first = stops[0] as HTMLElement;
    expect(last).not.toBe(first);
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("Close and Esc close it", async () => {
    open([item()]);
    await screen.findByText(QUESTION.question);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.querySelector("#discuss")).toBeNull();
    act(() => openItem("esc:shop-app#4001"));
    expect(document.querySelector("#discuss")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(document.querySelector("#discuss")).toBeNull();
  });

  it("renders nothing while nothing is open", () => {
    stubFetch({ "/api/attention": [], "/api/escalations": [], "/api/crew": { rows: [] } });
    render(
      <>
        <ItemPanel />
        <Probe />
      </>,
    );
    expect(screen.getByTestId("open").textContent).toBe("null");
    expect(document.querySelector("#discuss")).toBeNull();
  });
});

describe("the item URL", () => {
  const param = () => new URLSearchParams(window.location.search).get("item");

  it("opening sets ?item= on the current URL, closing removes it", async () => {
    window.history.replaceState(null, "", "/agent/shop-app-ta?x=1#top");
    open([item()]);
    await screen.findByText(QUESTION.question);
    expect(param()).toBe("esc:shop-app#4001");
    expect(window.location.search).toContain("item=esc%3Ashop-app%234001");
    expect(window.location.pathname).toBe("/agent/shop-app-ta");
    expect(new URLSearchParams(window.location.search).get("x")).toBe("1");
    expect(window.location.hash).toBe("#top");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(param()).toBeNull());
    expect(window.location.search).toBe("?x=1");
    expect(window.location.hash).toBe("#top");
  });

  it("opening pushes a history entry; Esc closes it and removes the param", async () => {
    // a pushed entry drops any Forward entries, so start with none (earlier tests step Back)
    window.history.pushState(null, "", "/");
    const before = window.history.length;
    open([item()]);
    await screen.findByText(QUESTION.question);
    expect(window.history.length).toBe(before + 1);
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    await waitFor(() => expect(param()).toBeNull());
  });

  it("Close undoes the open: one entry added, and Back then goes to the page before", async () => {
    window.history.replaceState(null, "", "/board");
    window.history.pushState(null, "", "/flight");
    const before = window.history.length;
    open([item()]);
    await screen.findByText(QUESTION.question);
    expect(window.history.length).toBe(before + 1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(param()).toBeNull());
    expect(window.location.pathname).toBe("/flight");
    expect(window.history.length).toBe(before + 1);
    act(() => {
      window.history.back();
    });
    await waitFor(() => expect(window.location.pathname).toBe("/board"));
    expect(param()).toBeNull();
  });

  describe("a second item opened over the first", () => {
    const first = () => {
      act(() => syncItem(null)); // nothing left open by an earlier test
      window.history.replaceState(null, "", "/board");
      window.history.pushState(null, "", "/flight");
    };

    it("Close closes the panel for good; one Back goes to the page before the first open", async () => {
      first();
      const before = window.history.length;
      open([item(), item({ key: "esc:shop-app#4002" })]);
      await screen.findByText(QUESTION.question);
      act(() => openItem("esc:shop-app#4002"));
      expect(window.history.length).toBe(before + 1);
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(param()).toBeNull());
      expect(document.querySelector("#discuss")).toBeNull();
      act(() => {
        window.history.back();
      });
      await waitFor(() => expect(window.location.pathname).toBe("/board"));
    });

    it("Esc does the same", async () => {
      first();
      open([item(), item({ key: "esc:shop-app#4002" })]);
      await screen.findByText(QUESTION.question);
      act(() => openItem("esc:shop-app#4002"));
      act(() => {
        fireEvent.keyDown(document.body, { key: "Escape" });
      });
      await waitFor(() => expect(param()).toBeNull());
      expect(document.querySelector("#discuss")).toBeNull();
      act(() => {
        window.history.back();
      });
      await waitFor(() => expect(window.location.pathname).toBe("/board"));
    });

    it("over a panel the page loaded with: Close removes ?item= and adds no entry", async () => {
      first();
      window.history.replaceState(null, "", "/flight?item=esc%3Ashop-app%234001");
      const before = window.history.length;
      open([item(), item({ key: "esc:shop-app#4002" })], undefined, "esc:shop-app#4001");
      await screen.findByText(QUESTION.question);
      act(() => openItem("esc:shop-app#4002"));
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(param()).toBeNull();
      expect(window.history.length).toBe(before);
    });
  });

  it("closing with no param on the URL leaves the URL alone", () => {
    window.history.replaceState(null, "", "/flight");
    act(() => closeItem());
    expect(window.location.pathname + window.location.search).toBe("/flight");
  });

  describe("loading a page with ?item=", () => {
    class StubEventSource {
      addEventListener() {}
      close() {}
    }
    function app(url: string, items: AttentionItem[]) {
      vi.stubGlobal("EventSource", StubEventSource);
      stubFetch({
        "/api/attention": items,
        "/api/escalations": [escalation({ question: QUESTION })],
        "/api/crew": { rows: [crewRow({ id: "shop-app-ta", index: 2 })], firstRunToday: null },
        "/api/config": CONFIG,
        "/api/repos": [],
      });
      window.history.replaceState(null, "", url);
      return render(<App />);
    }

    it("opens that item once the attention list is known", async () => {
      app("/flight?item=esc:shop-app%233227", [item({ key: "esc:shop-app#3227" })]);
      await screen.findByText(QUESTION.question);
      expect(document.querySelector("#discuss")).toBeTruthy();
      expect(window.location.pathname).toBe("/flight");
      expect(param()).toBe("esc:shop-app#3227");
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(param()).toBeNull();
    });

    it("a key that has gone opens nothing, toasts, and drops the param", async () => {
      app("/flight?item=esc:shop-app%239", [item()]);
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toBe("That item is no longer waiting."),
      );
      expect(document.querySelector("#discuss")).toBeNull();
      expect(param()).toBeNull();
    });

    it("in-app navigation closes the panel rather than leaving it open on a URL without ?item=", async () => {
      app("/flight", [item()]);
      await screen.findByRole("navigation", { name: "Pages" });
      act(() => openItem("esc:shop-app#4001"));
      await screen.findByText(QUESTION.question);
      act(() => navigate("/board"));
      await waitFor(() => expect(document.querySelector("#discuss")).toBeNull());
      expect(param()).toBeNull();
    });

    it("Back across pages reopens the panel at ?item=, and Forward goes on to the page", async () => {
      app("/flight", [item()]);
      await screen.findByRole("navigation", { name: "Pages" });
      act(() => openItem("esc:shop-app#4001"));
      await screen.findByText(QUESTION.question);
      act(() => navigate("/board"));
      await waitFor(() => expect(document.querySelector("#discuss")).toBeNull());
      act(() => {
        window.history.back();
      });
      await waitFor(() => expect(document.querySelector("#discuss")).toBeTruthy());
      expect(window.location.pathname).toBe("/flight");
      expect(param()).toBe("esc:shop-app#4001");
      act(() => {
        window.history.forward();
      });
      await waitFor(() => expect(window.location.pathname).toBe("/board"));
      expect(document.querySelector("#discuss")).toBeNull();
    });

    it("closing a panel the page loaded with replaces the URL: Back leaves, not back into it", async () => {
      window.history.replaceState(null, "", "/board");
      window.history.pushState(null, "", "/flight");
      app("/flight?item=esc:shop-app%234001", [item()]);
      await screen.findByText(QUESTION.question);
      const before = window.history.length;
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(param()).toBeNull();
      expect(window.history.length).toBe(before);
      act(() => {
        window.history.back();
      });
      await waitFor(() => expect(window.location.pathname).toBe("/board"));
      expect(document.querySelector("#discuss")).toBeNull();
    });

    it("a gone key is dropped without growing the history", async () => {
      window.history.replaceState(null, "", "/board");
      window.history.pushState(null, "", "/flight");
      const before = window.history.length;
      app("/flight?item=esc:shop-app%239", [item()]);
      await waitFor(() => expect(param()).toBeNull());
      expect(window.history.length).toBe(before);
    });

    it("Back closes the panel and Forward opens it again", async () => {
      app("/flight", [item()]);
      await screen.findByRole("navigation", { name: "Pages" });
      act(() => openItem("esc:shop-app#4001"));
      await screen.findByText(QUESTION.question);
      act(() => {
        window.history.back();
      });
      await waitFor(() => expect(document.querySelector("#discuss")).toBeNull());
      act(() => {
        window.history.forward();
      });
      await waitFor(() => expect(document.querySelector("#discuss")).toBeTruthy());
    });
  });
});

describe("ItemPanel, person variant", () => {
  const openPerson = (post: unknown) => {
    const fn = stubFetch({
      "/api/attention": [personItem],
      "/api/escalations": [],
      "/api/crew": { rows: [crewRow({ id: "shop-app-ta", index: 2 })], firstRunToday: null },
      "/api/config": CONFIG,
      "/api/notifications": { open: [thread()], handledToday: [] },
      [`POST /api/attention/${encodeURIComponent(KEY)}/handled`]: post,
    });
    render(<ItemPanel />);
    act(() => openItem(KEY));
    return fn;
  };

  it("Mark handled posts and keeps the person panel with the server's handled description", async () => {
    let handled = false;
    const t = thread();
    const fn = stubFetch({
      "/api/attention": () => ({ status: 200, body: handled ? [] : [personItem] }),
      "/api/config": CONFIG,
      "/api/notifications": () => ({
        status: 200,
        body: {
          open: handled ? [] : [t],
          handledToday: handled ? [{ ...t, how: "read on GitHub", at: NOW }] : [],
        },
      }),
      [`POST /api/attention/${encodeURIComponent(KEY)}/handled`]: () => {
        handled = true;
        return { status: 200, body: { handled: KEY } };
      },
    });
    render(<ItemPanel />);
    act(() => openItem(KEY));
    await screen.findByText("The message");
    expect(screen.getByText("Asked of you")).toBeTruthy();
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("Catch-up")).toBeTruthy();
    expect(screen.getByText("can you look?")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in GitHub ↗" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark handled" }));
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        `/api/attention/${encodeURIComponent(KEY)}/handled`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await screen.findByText("Handled:", { exact: false });
    await waitFor(() =>
      expect(document.querySelector("#dsPerson")?.textContent).toBe("Handled: read on GitHub"),
    );
    expect(document.querySelector("#discuss")).not.toBeNull();
    expect(screen.getByText("can you look?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark handled" })).toBeNull();
    act(() => {
      closeItem();
      openItem("missing");
    });
    expect(screen.queryByText("can you look?")).toBeNull();
    expect(screen.queryByText("Handled:", { exact: false })).toBeNull();
  });

  it("keeps a successful Mark handled local until the server supplies how, keyed by item", async () => {
    const other = thread({ key: "person:102", id: "102", snippet: "Another message" });
    const notes = { open: [thread(), other], handledToday: [] as { id: string; how: string }[] };
    const fn = stubFetch({
      "/api/attention": [personItem, { ...personItem, key: other.key }],
      "/api/notifications": notes,
      "/api/config": CONFIG,
      [`POST /api/attention/${encodeURIComponent(KEY)}/handled`]: {},
    });
    render(<ItemPanel />);
    act(() => openItem(KEY));
    await screen.findByText("The message");
    fireEvent.click(screen.getByRole("button", { name: "Mark handled" }));
    await waitFor(() =>
      expect(document.querySelector("#dsPerson")?.textContent).toBe("Handled: marked handled"),
    );
    expect(screen.queryByRole("button", { name: "Mark handled" })).toBeNull();
    act(() => openItem(other.key));
    await screen.findByText("Another message");
    expect(screen.getByRole("button", { name: "Mark handled" })).toBeTruthy();
    act(() => openItem(KEY));
    await screen.findByText("can you look?");
    expect(screen.queryByRole("button", { name: "Mark handled" })).toBeNull();
    notes.handledToday.push({ id: "101", how: "read on GitHub" });
    act(() => hub.refetch(RESOURCES.notifications.path));
    await waitFor(() =>
      expect(document.querySelector("#dsPerson")?.textContent).toBe("Handled: read on GitHub"),
    );
    expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("shows No longer open when a person item disappears without being handled", async () => {
    const items = [personItem];
    stubFetch({
      "/api/attention": items,
      "/api/notifications": { open: [thread()], handledToday: [] },
      "/api/config": CONFIG,
    });
    render(<ItemPanel />);
    act(() => openItem(KEY));
    await screen.findByText("The message");
    items.length = 0;
    act(() => hub.refetch(RESOURCES.attention.path));
    await screen.findByText("No longer open");
    expect(screen.queryByRole("button", { name: "Mark handled" })).toBeNull();
  });

  it("highlights mentions in the message as inert text", async () => {
    const snippet =
      '@CAPCOM @OctoCat <img src=x onerror="alert(1)"> @octocat-other @operator @someone @capcom';
    stubFetch({
      "/api/attention": [personItem],
      "/api/notifications": { open: [thread({ snippet })], handledToday: [] },
      "/api/config": { ...CONFIG, githubLogin: "octocat" },
    });
    render(<ItemPanel />);
    act(() => openItem(KEY));
    await screen.findByText("The message");
    const quote = document.querySelector("#discuss blockquote") as HTMLElement;
    expect(quote.textContent).toBe(snippet);
    expect([...quote.querySelectorAll(".mention")].map((el) => el.textContent)).toEqual([
      "@CAPCOM",
      "@OctoCat",
      "@capcom",
    ]);
    expect(quote.querySelector("img")).toBeNull();
  });

  it("a refused Mark handled shows the server's error in the panel", async () => {
    openPerson(() => ({ status: 404, body: { error: "no such open thread" } }));
    await screen.findByText("The message");
    fireEvent.click(screen.getByRole("button", { name: "Mark handled" }));
    expect((await screen.findByRole("alert")).textContent).toBe("no such open thread");
    expect(document.querySelector("#discuss")).not.toBeNull();
  });
});
