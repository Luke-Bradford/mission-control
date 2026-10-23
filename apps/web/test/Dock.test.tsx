import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as markdown from "../src/components/Markdown.tsx";
import { hub } from "../src/data.ts";
import * as conversation from "../src/flight/conversation.ts";
import { FLIGHT_NO_SEAT, type FlightView } from "../src/flight/flightTypes.ts";
import { Dock } from "../src/shell/Dock.tsx";
import { ItemPanel } from "../src/shell/ItemPanel.tsx";
import { installKeys } from "../src/shell/keys.ts";
import {
  openItem,
  toggleDock,
  useBuildStatus,
  useFlightUnread,
  useItem,
} from "../src/shell/overlays.ts";
import { DOCK_KEY } from "../src/storage.ts";
import { stubFetch } from "./fetchStub.ts";
import { brief, CONFIG, crewRow, HOUR, item, NOW } from "./fixtures.ts";

const noop = () => {};
let off: () => void;
let breakpointListeners: (() => void)[] = [];

/** `matchMedia` for a window at least (or less than) 1200px wide. */
function stubWidth(wide: boolean) {
  breakpointListeners = [];
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: wide,
    media: q,
    addEventListener: (_: string, fn: () => void) => breakpointListeners.push(fn),
    removeEventListener: noop,
  }));
}

const dockEl = (container: HTMLElement) => container.querySelector<HTMLElement>("#dock");
const esc = () =>
  act(() => {
    fireEvent.keyDown(document.body, { key: "Escape" });
  });

beforeEach(() => {
  stubFetch({
    "/api/attention": [],
    "/api/escalations": [],
    "/api/crew": { rows: [] },
    "/api/flight": { seat: null, decisions: [] },
  });
  off = installKeys({
    navigate: noop,
    toggleDock: () => toggleDock(),
    help: noop,
    selectNext: noop,
    selectPrev: noop,
    toast: noop,
  });
});

afterEach(() => {
  off();
  vi.unstubAllGlobals();
  hub.clear();
});

describe("Dock content", () => {
  it("says no FLIGHT seat is configured, with no conversation and the input switched off", async () => {
    const { container } = render(<Dock />);
    const dock = dockEl(container) as HTMLElement;
    expect(dock.querySelector(".meta")?.textContent).toBe("Loading…");
    await waitFor(() => expect(dock.querySelector(".meta")?.textContent).toBe(FLIGHT_NO_SEAT));
    expect(dock.getAttribute("aria-label")).toBe("FLIGHT");
    expect(dock.querySelector(".dh")?.textContent).toContain("FLIGHT");
    expect(screen.getByText("Head agent").className).toBe("pill neutral");
    expect(container.querySelector("#dockWaiting")).toBeNull();
    expect(container.querySelector("#dockMsgs")?.children.length).toBe(0);
    const input = screen.getByLabelText("Message FLIGHT") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("Ask FLIGHT to assign, reprioritise or report…");
    expect(input.title).toBe(FLIGHT_NO_SEAT);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("carries no P2 badge in its header; the build-status chips show when on", () => {
    function On() {
      const [, set] = useBuildStatus();
      return (
        <button type="button" onClick={() => set(true)}>
          on
        </button>
      );
    }
    const { container } = render(
      <>
        <On />
        <Dock />
      </>,
    );
    expect(container.querySelector("#dockHead .phase")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "on" }));
    expect(container.querySelector("#dockHead .phase")).toBeNull();
    const chip = screen.getByText("P2");
    expect(chip.className).toContain("bs-later");
    expect(chip.getAttribute("title")).toBe("FLIGHT itself, with structured decision briefs.");
  });
});

describe("Dock on a wide screen", () => {
  it("is shown by default; Hide hides it and remembers, showing again remembers that", () => {
    stubWidth(true);
    const { container } = render(<Dock />);
    expect(dockEl(container)?.hidden).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(dockEl(container)?.hidden).toBe(true);
    expect(localStorage.getItem(DOCK_KEY)).toBe("false");
    act(() => toggleDock());
    expect(dockEl(container)?.hidden).toBe(false);
    expect(localStorage.getItem(DOCK_KEY)).toBe("true");
  });

  it("starts hidden when it was hidden last time", () => {
    stubWidth(true);
    localStorage.setItem(DOCK_KEY, "false");
    const { container } = render(<Dock />);
    expect(dockEl(container)?.hidden).toBe(true);
  });

  it("has no scrim", () => {
    stubWidth(true);
    render(<Dock />);
    expect(screen.queryByTestId("dock-scrim")).toBeNull();
  });

  it("does not trap Tab: it is a column, not a drawer", () => {
    stubWidth(true);
    const { container } = render(<Dock />);
    const hide = screen.getByRole("button", { name: "Hide" });
    const last = document.createElement("button");
    dockEl(container)?.querySelector(".panel")?.append(last);
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(last);
    hide.focus();
    expect(fireEvent.keyDown(hide, { key: "Tab", shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(hide);
  });
});

describe("Dock on a narrow screen", () => {
  it("is a drawer, closed by default, that Esc closes and nothing remembers", () => {
    stubWidth(false);
    const { container } = render(<Dock />);
    expect(dockEl(container)?.hidden).toBe(true);
    expect(screen.queryByTestId("dock-scrim")).toBeNull();
    act(() => toggleDock());
    expect(dockEl(container)?.hidden).toBe(false);
    expect(screen.getByTestId("dock-scrim")).toBeTruthy();
    expect(localStorage.getItem(DOCK_KEY)).toBeNull();
    esc();
    expect(dockEl(container)?.hidden).toBe(true);
    expect(localStorage.getItem(DOCK_KEY)).toBeNull();
  });

  it("closes when the scrim or Hide is pressed", () => {
    stubWidth(false);
    const { container } = render(<Dock />);
    act(() => toggleDock());
    fireEvent.click(screen.getByTestId("dock-scrim"));
    expect(dockEl(container)?.hidden).toBe(true);
    act(() => toggleDock());
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(dockEl(container)?.hidden).toBe(true);
  });

  it("gives focus back to the control that opened it, on Hide and on Esc", () => {
    stubWidth(false);
    const opener = document.createElement("button");
    document.body.append(opener);
    render(<Dock />);
    for (const close of [
      () => fireEvent.click(screen.getByRole("button", { name: "Hide" })),
      esc,
    ]) {
      opener.focus();
      act(() => toggleDock());
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide" }));
      close();
      expect(document.activeElement).toBe(opener);
    }
    opener.remove();
  });

  it("keeps Tab and Shift+Tab inside the drawer, wrapping between its first and last stop", () => {
    stubWidth(false);
    const { container } = render(<Dock />);
    act(() => toggleDock());
    const hide = screen.getByRole("button", { name: "Hide" });
    const dock = dockEl(container) as HTMLElement;
    // Send and the input are switched off, so add a second stop after Hide.
    const last = document.createElement("button");
    dock.querySelector(".panel")?.append(last);
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false); // prevented: the trap moved focus
    expect(document.activeElement).toBe(hide);
    expect(fireEvent.keyDown(hide, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
    // Between the edges Tab is left to the browser.
    hide.focus();
    expect(fireEvent.keyDown(hide, { key: "Tab" })).toBe(true);
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab", shiftKey: true })).toBe(true);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    fireEvent.keyDown(dock, { key: "Tab" });
    expect(document.activeElement).toBe(hide);
    outside.remove();
  });

  it("closes when the window crosses the breakpoint", () => {
    stubWidth(false);
    const { container } = render(<Dock />);
    act(() => toggleDock());
    expect(dockEl(container)?.hidden).toBe(false);
    act(() => {
      for (const fn of breakpointListeners) fn();
    });
    expect(dockEl(container)?.hidden).toBe(true);
  });
});

const flightSeat = (over: Partial<NonNullable<FlightView["seat"]>> = {}) => ({
  id: "flight-1",
  call: "FLIGHT-1",
  model: "opus",
  state: "idle" as const,
  live: true,
  turns: null,
  ...over,
});
const STREAM = {
  runId: "r1",
  truncated: false,
  lastOutputAt: null,
  reason: null,
  events: [
    { id: "0:0", at: NOW - 600_000, kind: "op", text: "[Mission Control] Wake: 2 questions\n{}" },
    { id: "1:0", at: NOW - 500_000, kind: "op", text: "<b>hi</b> FLIGHT" },
    { id: "2:0", at: NOW - 400_000, kind: "msg", text: "Over to you @CAPCOM, please." },
    { id: "2:1", at: NOW - 350_000, kind: "msg", text: "Done: **both** merged\n\n- one\n- two" },
    { id: "3:0", at: NOW - 300_000, kind: "tool", text: "ls" },
  ],
};
const DECISION = {
  id: 1,
  targetRunId: null,
  ref: null,
  questionId: null,
  at: NOW - 450_000,
  seatId: null,
  kind: "answer",
  about: "Which branch?",
  decision: "main",
  basis: "the spec",
};

function stubFlight(view: FlightView, extra: Record<string, unknown> = {}) {
  return stubFetch({
    "/api/attention": [],
    "/api/escalations": [],
    "/api/crew": { rows: [] },
    "/api/config": CONFIG,
    "/api/flight": view,
    "/api/agents/flight-1/stream": STREAM,
    ...extra,
  });
}

const form = (c: HTMLElement) => c.querySelector("#dockForm") as HTMLFormElement;
const bodyOf = (fn: ReturnType<typeof stubFetch>, path: string) => {
  const call = fn.mock.calls.find(([p]) => p === path);
  return call ? JSON.parse(call[1]?.body as string) : undefined;
};

describe("live FLIGHT", () => {
  it("shows the account, model, turns, context and doing line in its meta line", async () => {
    stubFlight(
      { seat: flightSeat({ turns: { n: 4, max: 41 } }), decisions: [] },
      {
        "/api/crew": {
          rows: [
            crewRow({ id: "other", accountId: "other-account" }),
            crewRow({
              id: "flight-1",
              accountId: "claude-main",
              contextWindow: 200_000,
              digest: {
                toolCalls: 0,
                turns: 4,
                lastEventAt: NOW,
                model: null,
                contextTokens: 50_000,
                contextWindow: null,
                liveTool: null,
                tools: {},
                subagents: [],
                minuteTokens: [],
                turnUsage: [],
                background: [],
                compactions: 0,
              },
            }),
          ],
        },
      },
    );
    const { container } = render(<Dock />);
    await waitFor(() =>
      expect(container.querySelector(".meta")?.textContent).toBe(
        "claude-main · opus · turn 4 of 41, then a fresh session · context 25% · run #12",
      ),
    );
  });

  it("omits missing turns, account and context without empty separators", async () => {
    stubFlight({ seat: flightSeat(), decisions: [] });
    const { container } = render(<Dock />);
    await waitFor(() =>
      expect(container.querySelector(".meta")?.textContent).toBe("opus · waiting for a wake"),
    );
  });

  it("the dock shows no decisions and no wake lines, and has no tabs", async () => {
    stubFlight({ seat: flightSeat(), decisions: [DECISION as FlightView["decisions"][number]] });
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelectorAll(".dmsg")).toHaveLength(3));
    const rows = [...container.querySelectorAll(".dmsg")];
    expect(rows.map((r) => r.className)).toEqual(["dmsg you", "dmsg flight", "dmsg flight"]);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("shows its state, the conversation in order, and sends a message", async () => {
    const fn = stubFlight(
      { seat: flightSeat(), decisions: [DECISION as FlightView["decisions"][number]] },
      { "POST /api/seats/flight-1/message": {} },
    );
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelectorAll(".dmsg")).toHaveLength(3));
    expect(container.querySelector(".meta")?.textContent).toBe("opus · waiting for a wake");
    const rows = [...container.querySelectorAll(".dmsg")];
    expect(rows.map((r) => r.className)).toEqual(["dmsg you", "dmsg flight", "dmsg flight"]);
    expect(rows[0]?.querySelector(".txt")?.textContent).toBe("<b>hi</b> FLIGHT");
    expect(rows[0]?.querySelector("b")).toBeNull();
    const input = screen.getByLabelText("Message FLIGHT") as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "  assign it  " } });
    fireEvent.submit(form(container));
    await waitFor(() => expect(input.value).toBe(""));
    expect(bodyOf(fn, "/api/seats/flight-1/message")).toEqual({ text: "assign it" });
  });

  it("does not send a blank message", async () => {
    const fn = stubFlight({ seat: flightSeat(), decisions: [] });
    const { container } = render(<Dock />);
    const input = screen.getByLabelText("Message FLIGHT") as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(form(container));
    expect(fn.mock.calls.some(([p]) => p === "/api/seats/flight-1/message")).toBe(false);
  });

  it("shows a failure and keeps the text", async () => {
    stubFlight(
      { seat: flightSeat(), decisions: [] },
      { "POST /api/seats/flight-1/message": () => ({ status: 409, body: { error: "seat busy" } }) },
    );
    const { container } = render(<Dock />);
    const input = screen.getByLabelText("Message FLIGHT") as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.submit(form(container));
    expect((await screen.findByRole("alert")).textContent).toBe("seat busy");
    expect(input.value).toBe("go");
  });

  it("highlights @CAPCOM in a FLIGHT row", async () => {
    stubFlight({ seat: flightSeat(), decisions: [] });
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelector(".dmsg.flight .md strong")).toBeTruthy());
    expect(container.querySelector(".dmsg.flight .md strong")?.textContent).toBe("@CAPCOM");
  });
});

describe("Waiting on you", () => {
  const ask = (over: Parameters<typeof item>[0] = {}) =>
    item({ kind: "decision", text: "Which?", brief: brief(), ...over });

  it("shows Waiting on you with Open on each ask FLIGHT has put to you", async () => {
    function Probe() {
      return <span data-testid="item">{useItem() ?? "none"}</span>;
    }
    stubFlight(
      {
        seat: flightSeat(),
        decisions: [
          { ...DECISION, id: 2, kind: "pass", questionId: 7 } as FlightView["decisions"][number],
        ],
      },
      {
        "/api/attention": [
          ask({ key: "b", at: NOW - HOUR }),
          ask({ key: "ask:7", brief: undefined, kind: "question", at: NOW - 2 * HOUR }),
          ask({ key: "c", brief: undefined }),
          ask({ key: "d", owner: "flight" }),
        ],
      },
    );
    const { container } = render(
      <>
        <Probe />
        <Dock />
      </>,
    );
    const rows = await screen.findAllByTestId("waiting-ask");
    expect(container.querySelector("#dockWaiting .dwh")?.textContent).toBe("Waiting on you · 2");
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]?.querySelector("button") as HTMLElement);
    expect(screen.getByTestId("item").textContent).toBe("ask:7");
    expect(rows[1]?.textContent).toContain("Which?");
  });

  it("shows no band with nothing to wait on", async () => {
    stubFlight({ seat: flightSeat(), decisions: [] });
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelectorAll(".dmsg")).toHaveLength(3));
    expect(container.querySelector("#dockWaiting")).toBeNull();
  });
});

describe("stopped FLIGHT", () => {
  it("switches the input off and offers Start FLIGHT", async () => {
    const fn = stubFlight(
      { seat: flightSeat({ state: "stopped", live: false }), decisions: [] },
      { "POST /api/seats/flight-1/start": { runId: "r2" } },
    );
    const { container } = render(<Dock />);
    const input = screen.getByLabelText("Message FLIGHT") as HTMLInputElement;
    await waitFor(() => expect(input.placeholder).toBe("FLIGHT is stopped"));
    expect(input.disabled).toBe(true);
    expect(container.querySelector(".meta")?.textContent).toBe("opus · stopped");
    fireEvent.click(screen.getByRole("button", { name: "Start FLIGHT" }));
    await waitFor(() => expect(bodyOf(fn, "/api/seats/flight-1/start")).toEqual({}));
  });

  it("shows a failed start", async () => {
    stubFlight(
      { seat: flightSeat({ state: "stopped", live: false }), decisions: [] },
      { "POST /api/seats/flight-1/start": () => ({ status: 500, body: { error: "no slot" } }) },
    );
    render(<Dock />);
    fireEvent.click(await screen.findByRole("button", { name: "Start FLIGHT" }));
    expect((await screen.findByRole("alert")).textContent).toBe("no slot");
  });
});

describe("Esc", () => {
  it("closes only the topmost overlay: the Item panel over the dock drawer", () => {
    stubWidth(false);
    const { container } = render(
      <>
        <Dock />
        <ItemPanel />
      </>,
    );
    act(() => toggleDock());
    act(() => openItem("esc:shop-app#1"));
    expect(container.querySelector("#discuss")).toBeTruthy();
    esc();
    expect(container.querySelector("#discuss")).toBeNull();
    expect(dockEl(container)?.hidden).toBe(false);
    esc();
    expect(dockEl(container)?.hidden).toBe(true);
  });
});

describe("the conversation", () => {
  const sendText = (container: HTMLElement, value: string) => {
    const input = screen.getByLabelText("Message FLIGHT") as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(form(container));
    return input;
  };

  it("shows a sent message at once, marked you and pending, and keeps it", async () => {
    stubFlight({ seat: flightSeat(), decisions: [] }, { "POST /api/seats/flight-1/message": {} });
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelectorAll(".dmsg")).toHaveLength(3));
    sendText(container, "assign it");
    const mine = [...container.querySelectorAll(".dmsg.you")].at(-1) as HTMLElement;
    expect(mine.querySelector(".txt")?.textContent).toBe("assign it");
    expect(mine.classList.contains("pending")).toBe(true);
    expect(mine.querySelector(".who")?.textContent).toContain("pending");
    await waitFor(() =>
      expect((screen.getByLabelText("Message FLIGHT") as HTMLInputElement).value).toBe(""),
    );
    expect(container.querySelectorAll(".dmsg.you.pending")).toHaveLength(1);
  });

  it("settles a pending message once FLIGHT's stream has it", async () => {
    let events = STREAM.events;
    stubFlight(
      { seat: flightSeat(), decisions: [] },
      {
        "POST /api/seats/flight-1/message": {},
        "/api/agents/flight-1/stream": () => ({ status: 200, body: { ...STREAM, events } }),
      },
    );
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelectorAll(".dmsg")).toHaveLength(3));
    const input = sendText(container, "assign it");
    await waitFor(() => expect(input.value).toBe(""));
    expect(container.querySelectorAll(".dmsg.you.pending")).toHaveLength(1);
    events = [...STREAM.events, { id: "5:0", at: NOW, kind: "op", text: "assign it" }];
    await act(async () => {
      hub.refetch("/api/agents/flight-1/stream");
    });
    await waitFor(() => expect(container.querySelectorAll(".dmsg.you.pending")).toHaveLength(0));
    const mine = [...container.querySelectorAll(".dmsg.you")].filter(
      (r) => r.querySelector(".txt")?.textContent === "assign it",
    );
    expect(mine).toHaveLength(1);
  });

  it("drops the pending message when the send fails", async () => {
    stubFlight(
      { seat: flightSeat(), decisions: [] },
      { "POST /api/seats/flight-1/message": () => ({ status: 409, body: { error: "seat busy" } }) },
    );
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelectorAll(".dmsg")).toHaveLength(3));
    sendText(container, "go");
    expect(container.querySelectorAll(".dmsg.you.pending")).toHaveLength(1);
    await screen.findByRole("alert");
    expect(container.querySelectorAll(".dmsg.you.pending")).toHaveLength(0);
  });

  it("keeps only the operator's and FLIGHT's messages on Chat", async () => {
    stubFlight({ seat: flightSeat(), decisions: [DECISION as FlightView["decisions"][number]] });
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelectorAll(".dmsg")).toHaveLength(3));
    for (const r of container.querySelectorAll(".dmsg")) {
      expect(r.classList.contains("you") || r.classList.contains("flight")).toBe(true);
    }
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("renders a reply as Markdown", async () => {
    stubFlight({ seat: flightSeat(), decisions: [] });
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelector(".dmsg.flight .md strong")).toBeTruthy());
    const md = container.querySelectorAll(".dmsg.flight .md")[1] as HTMLElement;
    expect(md.querySelector("strong")?.textContent).toBe("both");
    expect(md.querySelectorAll("li")).toHaveLength(2);
  });

  it("counts a new reply as unread while the dock is hidden, and clears it once shown", async () => {
    stubWidth(true);
    const reply = { id: "4:0", at: NOW - 100_000, kind: "msg", text: "A new answer" };
    let events = STREAM.events;
    stubFlight(
      { seat: flightSeat(), decisions: [] },
      { "/api/agents/flight-1/stream": () => ({ status: 200, body: { ...STREAM, events } }) },
    );
    function Unread() {
      return <span data-testid="unread">{useFlightUnread()}</span>;
    }
    const { container } = render(
      <>
        <Unread />
        <Dock />
      </>,
    );
    await waitFor(() => expect(container.querySelectorAll(".dmsg")).toHaveLength(3));
    expect(screen.getByTestId("unread").textContent).toBe("0");
    act(() => toggleDock(false));
    events = [...STREAM.events, reply];
    await act(async () => {
      hub.refetch("/api/agents/flight-1/stream");
    });
    await waitFor(() => expect(screen.getByTestId("unread").textContent).toBe("1"));
    act(() => toggleDock(true));
    await waitFor(() => expect(screen.getByTestId("unread").textContent).toBe("0"));
    expect(container.querySelectorAll(".dmsg.flight")).toHaveLength(3);
  });

  it("keeps the scroll position while reading up, and follows again near the bottom", async () => {
    let events = STREAM.events;
    stubFlight(
      { seat: flightSeat(), decisions: [] },
      { "/api/agents/flight-1/stream": () => ({ status: 200, body: { ...STREAM, events } }) },
    );
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelectorAll(".dmsg")).toHaveLength(3));
    const log = screen.getByRole("log");
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
    const reply = async (id: string, n: number) => {
      events = [...events, { id, at: NOW - 100_000 + n, kind: "msg", text: `reply ${id}` }];
      await act(async () => {
        hub.refetch("/api/agents/flight-1/stream");
      });
      await waitFor(() => expect(container.querySelectorAll(".dmsg")).toHaveLength(3 + n));
    };
    log.scrollTop = 100;
    fireEvent.scroll(log);
    await reply("4:0", 1);
    expect(log.scrollTop).toBe(100);
    log.scrollTop = 800;
    fireEvent.scroll(log);
    await reply("5:0", 2);
    expect(log.scrollTop).toBe(1000);
  });

  it("does not rebuild the conversation while the operator types", async () => {
    stubFlight({ seat: flightSeat(), decisions: [] });
    const spy = vi.spyOn(conversation, "dockRows");
    const md = vi.spyOn(markdown, "Markdown");
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelectorAll(".dmsg")).toHaveLength(3));
    const before = spy.mock.calls.length;
    const mdBefore = md.mock.calls.length;
    expect(mdBefore).toBeGreaterThan(0); // the spy sees renders at all
    const input = screen.getByLabelText("Message FLIGHT") as HTMLInputElement;
    for (const v of ["a", "ab", "abc"]) fireEvent.change(input, { target: { value: v } });
    expect(input.value).toBe("abc");
    expect(spy.mock.calls.length).toBe(before);
    expect(md.mock.calls.length).toBe(mdBefore);
    md.mockRestore();
    spy.mockRestore();
  });
});
