import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ActivityRow,
  type AttentionItem,
  COMMS_CAPCOM,
  COMMS_MC,
  type CommsEvent,
  type CommsThreadMessage,
  GUARD_NONE_TEXT,
  type GuardHitsView,
  guardSummary,
} from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommsConversation } from "../src/comms/Conversation.tsx";
import { hub } from "../src/data.ts";
import { FLIGHT_NO_SEAT } from "../src/flight/flightTypes.ts";
import { Comms } from "../src/pages/Comms.tsx";
import { Dock } from "../src/shell/Dock.tsx";
import { setFlightUnread, toggleDock, useDock, useItem } from "../src/shell/overlays.ts";
import { setSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch } from "./fetchStub.ts";
import {
  boardItem,
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
  hub.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  hub.clear();
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

  it("shows a paused agent's reason in the thread and conversation state tooltips", async () => {
    const paused = seatRow({
      crewPause: { seats: ["shop-app-ta"], reason: "Save tokens", at: NOW, by: "operator" },
    });
    stubFetch({
      "/api/attention": [],
      "/api/crew": { rows: [paused], firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
    });
    render(<Comms item={null} />);
    const list = document.querySelector("#chanList") as HTMLElement;
    const pill = await within(list).findByText("Paused");
    expect(pill.parentElement?.getAttribute("title")).toBe("Save tokens");
    fireEvent.click(pill.closest("button") as HTMLButtonElement);
    const conversationPill = await within(
      document.querySelector("#chatP") as HTMLElement,
    ).findByText("Paused");
    expect(conversationPill.parentElement?.getAttribute("title")).toBe("Save tokens");
  });
});

describe("Comms routes", () => {
  it("keeps the reader's place when the conversation rerenders", async () => {
    const message = {
      id: "comms:older",
      at: NOW - MIN,
      from: "alpha",
      to: "crew",
      text: "Read this older message",
      ticket: null,
      label: null,
      ref: null,
      replyTo: null,
      mentions: [],
      reactions: [],
      pinned: false,
      operator: false,
    };
    stubFetch({
      "/api/comms/crew": { messages: [message] },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
      "POST /api/comms/read": { ok: true },
    });
    const { rerender } = render(
      <CommsConversation view={{ kind: "crew" }} row={null} onJumped={() => {}} />,
    );
    await screen.findByText("Read this older message");
    const pane = document.querySelector(".comms-messages") as HTMLElement;
    Object.defineProperties(pane, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
    });
    pane.scrollTop = 200;
    fireEvent.scroll(pane);

    rerender(<CommsConversation view={{ kind: "crew" }} row={null} onJumped={() => {}} />);

    expect(pane.scrollTop).toBe(200);
  });

  it("brings the reader back to the latest when CAPCOM sends, after they scrolled up", async () => {
    const message = (id: string, from: string, text: string) => ({
      id,
      at: NOW - MIN,
      from,
      to: "crew",
      text,
      ticket: null,
      label: null,
      ref: null,
      replyTo: null,
      mentions: [],
      reactions: [],
      pinned: false,
      operator: false,
    });
    const messages = [message("comms:older", "alpha", "Read this older message")];
    stubFetch({
      "/api/comms/crew": () => ({ status: 200, body: { messages } }),
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
      "POST /api/comms/read": { ok: true },
      "POST /api/comms": () => {
        const sent = message("comms:sent", "CAPCOM", "On my way");
        messages.push(sent);
        return { status: 200, body: { message: sent } };
      },
    });
    render(<CommsConversation view={{ kind: "crew" }} row={null} onJumped={() => {}} />);
    await screen.findByText("Read this older message");
    const pane = document.querySelector(".comms-messages") as HTMLElement;
    Object.defineProperties(pane, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
    });
    pane.scrollTop = 200;
    fireEvent.scroll(pane);

    fireEvent.change(screen.getByLabelText(/Post to #crew/), { target: { value: "On my way" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("On my way")).toBeTruthy();
    expect(pane.scrollTop).toBe(1_000);
  });

  it("waits for a jumped message to render, and routes peer quotes to their actual conversation", async () => {
    const original = {
      id: "comms:peer",
      at: NOW - MIN,
      from: "alpha",
      to: "beta",
      text: "Peer handoff",
      ticket: null,
      label: null,
      ref: null,
      replyTo: null,
      mentions: [],
      reactions: [],
      pinned: false,
      operator: false,
    };
    const reply = { ...original, id: "comms:reply", from: "beta", replyTo: original.id };
    const onJumped = vi.fn();
    const onOpenMessage = vi.fn();
    stubFetch({
      "/api/comms/crew": { messages: [original, reply] },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
      "POST /api/comms/read": { ok: true },
    });
    render(
      <CommsConversation
        view={{ kind: "crew" }}
        row={null}
        jumpId={original.id}
        onJumped={onJumped}
        onOpenMessage={onOpenMessage}
      />,
    );
    expect(onJumped).not.toHaveBeenCalled();
    const quote = await screen.findByRole("button", { name: /alpha.*Peer handoff/ });
    expect(onJumped).toHaveBeenCalledOnce();
    fireEvent.click(quote);
    expect(onOpenMessage).toHaveBeenCalledWith(
      { kind: "contact", agentId: "alpha", contactId: "beta" },
      original.id,
    );
  });

  it("keys drafts and replies by scope, consumes a prefill once, and includes a ticket ref", async () => {
    const ticketMessages = [
      {
        id: "comms:later",
        at: NOW,
        from: "alpha",
        to: "crew",
        text: "Crew discussion for #707",
        ticket: "shop-app#707",
        label: null,
        ref: "#707",
        replyTo: null,
        mentions: [],
        reactions: [],
        pinned: false,
        operator: false,
      },
      {
        id: "comms:earlier",
        at: NOW - MIN,
        from: "beta",
        to: "alpha",
        text: "Handoff on PR 44",
        ticket: "shop-app#707",
        label: null,
        ref: "PR 44",
        replyTo: null,
        mentions: [],
        reactions: [],
        pinned: false,
        operator: false,
      },
    ];
    const sent = {
      id: "comms:sent",
      at: NOW,
      from: "CAPCOM",
      to: "crew",
      text: "sent",
      ticket: null,
      label: null,
      ref: "#707",
      replyTo: null,
      mentions: [],
      reactions: [],
      pinned: false,
      operator: true,
    };
    const fetch = stubFetch({
      "/api/comms/crew": { messages: [] },
      "/api/comms/tickets/%23707?ticket=shop-app%23707": {
        messages: ticketMessages,
        ticket: {
          ref: "#707",
          linkedPr: "PR 44",
          title: "Comms ticket",
          status: "In progress",
          owner: "Agent",
          repoId: "shop-app",
          issueNumber: 707,
        },
      },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/flight": { seat: null, decisions: [] },
      "POST /api/comms": { message: sent },
    });
    const consumed = vi.fn();
    const { rerender } = render(
      <CommsConversation
        view={{ kind: "crew" }}
        row={null}
        prefill={{ token: 7, text: "Re #707: " }}
        onPrefillConsumed={consumed}
      />,
    );
    const crewComposer = await screen.findByLabelText(
      "Post to #crew as CAPCOM · @name pings one agent",
    );
    expect((crewComposer as HTMLInputElement).value).toBe("Re #707: ");
    expect(consumed).toHaveBeenCalledWith(7);
    fireEvent.change(crewComposer, { target: { value: "crew draft" } });
    rerender(
      <CommsConversation
        view={{ kind: "ticket", ref: "#707", ticket: "shop-app#707" }}
        row={null}
      />,
    );
    const ticketComposer = await screen.findByLabelText("Post to #crew as CAPCOM · tagged #707");
    expect((ticketComposer as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Comms ticket")).toBeTruthy();
    expect(screen.getByText("In progress")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open on Board" }).getAttribute("href")).toBe(
      "/board/shop-app/707",
    );
    const earlier = document.getElementById("comms-message-comms:earlier") as HTMLElement;
    const later = document.getElementById("comms-message-comms:later") as HTMLElement;
    expect(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(earlier).getAllByRole("button", { name: "PR 44" })[0]);
    expect(window.location.pathname).toBe("/comms/tickets/PR%2044");
    fireEvent.change(ticketComposer, { target: { value: "Ticket update" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      const sentCall = fetch.mock.calls.find(([path]) => path === "/api/comms");
      expect(JSON.parse(String(sentCall?.[1]?.body))).toMatchObject({
        to: "crew",
        text: "Ticket update",
        ref: "#707",
      });
    });
  });

  it("shows an empty ticket view and posts its ref to crew", async () => {
    const fetch = stubFetch({
      "/api/comms/tickets/%23999": {
        messages: [],
        ticket: {
          ref: "#999",
          linkedPr: null,
          title: "Empty ticket",
          status: "Ready",
          owner: "CAPCOM",
          repoId: "shop-app",
          issueNumber: 999,
        },
      },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/flight": { seat: null, decisions: [] },
      "POST /api/comms": { ok: true },
    });
    render(<CommsConversation view={{ kind: "ticket", ref: "#999" }} row={null} />);
    expect(await screen.findByText("Empty ticket")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("CAPCOM")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open on Board" }).getAttribute("href")).toBe(
      "/board/shop-app/999",
    );
    expect(screen.getByText("No messages yet.")).toBeTruthy();
    const composer = screen.getByLabelText("Post to #crew as CAPCOM · tagged #999");
    fireEvent.change(composer, { target: { value: "Starting now" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      const sent = fetch.mock.calls.find(([path]) => path === "/api/comms");
      expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({
        to: "crew",
        text: "Starting now",
        ref: "#999",
      });
    });
  });

  it("shows per-contact unread, retries a failed read, unpins, and does not send to a missing FLIGHT seat", async () => {
    const pin = {
      id: "comms:pin",
      at: NOW,
      from: "beta",
      to: "alpha",
      text: "Standing order",
      ticket: null,
      label: null,
      ref: null,
      replyTo: null,
      mentions: [],
      reactions: [],
      pinned: true,
      operator: false,
    };
    let reads = 0;
    const fetch = stubFetch({
      "/api/comms/agents/alpha": {
        messages: [pin],
        inbox: [],
        contacts: [{ id: "beta", count: 1, unread: 3, lastMessage: pin }],
        unread: 1,
        inboxUnread: 0,
      },
      "/api/comms/agents/alpha/contacts/beta": { messages: [pin] },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [pin] },
      "/api/flight": { seat: null, decisions: [] },
      "POST /api/comms/read": () => ({ status: ++reads === 1 ? 500 : 200, body: { ok: true } }),
      "DELETE /api/comms/comms%3Apin/pin": { pinned: false },
    });
    const { rerender } = render(
      <CommsConversation
        view={{ kind: "contact", agentId: "alpha", contactId: "beta" }}
        row={seatRow({ id: "alpha" })}
      />,
    );
    expect(await screen.findByText(/3 unread/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(reads).toBe(2));
    rerender(<CommsConversation view={{ kind: "crew" }} row={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Unpin" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/comms/comms%3Apin/pin", expect.anything()),
    );
    rerender(<CommsConversation view={{ kind: "flight" }} row={null} />);
    expect(await screen.findByText(FLIGHT_NO_SEAT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("shows Comms metadata, marks mentions seen, and writes CAPCOM's Ack as seen", async () => {
    const message = {
      id: "comms:9",
      at: NOW,
      from: "shop-app-ta",
      to: "crew",
      text: "@CAPCOM please check #707",
      ticket: "#707",
      label: "question",
      ref: "#707",
      replyTo: null,
      mentions: ["CAPCOM"],
      reactions: [],
      pinned: false,
      operator: false,
    };
    const fetch = stubFetch({
      "/api/attention": [],
      "/api/crew": { rows: ROWS, firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "/api/comms/crew": { messages: [message], unread: 3 },
      "/api/comms/mentions": { mentions: [{ message, seen: false }] },
      "/api/comms/pins": { messages: [message] },
      "POST /api/comms/read": { ok: true },
      "POST /api/comms/mentions/seen": { ok: true },
      "POST /api/comms/comms%3A9/reactions": { reaction: { reaction: "seen" } },
    });
    render(<Comms item={null} view={{ kind: "crew" }} />);
    expect(await screen.findByText("question")).toBeTruthy();
    expect(screen.getByText("Pinned")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Comms" });
    expect(
      within(nav).getByTitle("3 unread messages").querySelector("[aria-hidden]")?.textContent,
    ).toBe("3");
    expect(
      within(nav).getByTitle("1 new mention").querySelector("[aria-hidden]")?.textContent,
    ).toBe("@1");
    const bell = await screen.findByRole("button", { name: "Mentions, 1 new" });
    expect(bell.closest(".act")).toBeTruthy();
    fireEvent.click(bell);
    const panel = screen.getByRole("region", { name: "Mentions" });
    fireEvent.click(within(panel).getByText("@CAPCOM please check #707"));
    expect(screen.queryByRole("region", { name: "Mentions" })).toBeNull();
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/comms/mentions/seen", expect.anything()),
    );
    fireEvent.click(bell);
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Mentions" }).querySelector("button.seen"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Mark all read"));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/comms/mentions/seen", expect.anything()),
    );
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge shop-app-ta" }));
    await waitFor(() => {
      const hit = fetch.mock.calls.find(([path]) => path === "/api/comms/comms%3A9/reactions");
      expect(JSON.parse(String(hit?.[1]?.body))).toEqual({ reaction: "seen" });
    });
  });

  it("keeps mentions unread when marking them seen fails and lets CAPCOM retry", async () => {
    const message = {
      id: "comms:mention",
      at: NOW,
      from: "alpha",
      to: "crew",
      text: "@CAPCOM check this",
      ticket: null,
      label: null,
      ref: null,
      replyTo: null,
      mentions: ["CAPCOM"],
      reactions: [],
      pinned: false,
      operator: false,
    };
    let attempts = 0;
    stubFetch({
      "/api/comms/crew": { messages: [message] },
      "/api/comms/mentions": { mentions: [{ message, seen: false }] },
      "/api/comms/pins": { messages: [] },
      "/api/flight": { seat: null, decisions: [] },
      "POST /api/comms/read": { ok: true },
      "POST /api/comms/mentions/seen": () => ({
        status: ++attempts === 1 ? 500 : 200,
        body: { ok: true },
      }),
    });
    render(<CommsConversation view={{ kind: "crew" }} row={null} />);
    const bell = await screen.findByRole("button", { name: "Mentions, 1 new" });
    fireEvent.click(bell);
    fireEvent.click(screen.getByText("@CAPCOM check this"));
    expect(screen.queryByRole("region", { name: "Mentions" })).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not mark mentions read.",
    );
    fireEvent.click(bell);
    expect(
      screen.getByRole("region", { name: "Mentions" }).querySelector("button.seen"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(
      screen.getByRole("region", { name: "Mentions" }).querySelector("button.seen"),
    ).toBeTruthy();
  });

  it("counts an agent's unread replies to CAPCOM on its nav row", async () => {
    const seat = crewRow({ id: "alpha", kind: "crew", index: 2 });
    stubFetch({
      "/api/attention": [],
      "/api/crew": { rows: [seat], firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "/api/comms/crew": { messages: [], unread: 0 },
      "/api/comms/flight": { messages: [], unread: 0 },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/comms/agents/alpha": {
        messages: [],
        inbox: [],
        contacts: [],
        unread: 0,
        inboxUnread: 0,
        directUnread: 2,
      },
    });
    render(<Comms item={null} view={{ kind: "crew" }} />);
    const nav = await screen.findByRole("navigation", { name: "Comms" });
    const badge = await within(nav).findByTitle("2 unread replies to you");
    expect(badge.querySelector("[aria-hidden]")?.textContent).toBe("↩2");
  });

  it("returns CAPCOM to its contact after sending from an agent-to-agent conversation", async () => {
    const message = {
      id: "comms:peer",
      at: NOW,
      from: "alpha",
      to: "beta",
      text: "handoff",
      ticket: null,
      label: null,
      ref: null,
      replyTo: null,
      mentions: [],
      reactions: [],
      pinned: false,
      operator: false,
    };
    const fetch = stubFetch({
      "/api/comms/agents/alpha": {
        messages: [message],
        inbox: [],
        contacts: [{ id: "beta", count: 1, unread: 0, lastMessage: message }],
        unread: 0,
        inboxUnread: 0,
      },
      "/api/comms/agents/alpha/contacts/beta": { messages: [message] },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/flight": { seat: null, decisions: [] },
      "POST /api/comms/read": { ok: true },
      "POST /api/comms": { message: { ...message, from: "CAPCOM", to: "alpha" } },
    });
    window.history.replaceState(null, "", "/comms/agents/alpha/contacts/beta");
    render(
      <CommsConversation
        view={{ kind: "contact", agentId: "alpha", contactId: "beta" }}
        row={seatRow({ id: "alpha" })}
      />,
    );
    const composer = await screen.findByLabelText("Message alpha as CAPCOM");
    fireEvent.change(composer, { target: { value: "Operator reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      const sent = fetch.mock.calls.find(([path]) => path === "/api/comms");
      expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({ to: "alpha" });
      expect(window.location.pathname).toBe("/comms/agents/alpha/contacts/CAPCOM");
    });
  });

  it("replies with a quote, pins messages, and keeps the fixed reaction choices", async () => {
    const original = {
      id: "comms:8",
      at: NOW - MIN,
      from: "shop-app-ta",
      to: "crew",
      text: "Please check #707",
      ticket: "#707",
      label: null,
      ref: "#707",
      replyTo: null,
      mentions: [],
      reactions: [],
      pinned: false,
      operator: false,
    };
    const reply = {
      ...original,
      id: "comms:9",
      at: NOW,
      from: "CAPCOM",
      text: "I am on it.",
      replyTo: original.id,
      operator: true,
    };
    const fetch = stubFetch({
      "/api/attention": [],
      "/api/crew": { rows: ROWS, firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "/api/comms/crew": { messages: [original, reply] },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "POST /api/comms/read": { ok: true },
      "POST /api/comms": { message: reply },
      "PUT /api/comms/comms%3A8/pin": { pinned: true },
    });
    render(<Comms item={null} view={{ kind: "crew" }} />);
    await screen.findByText("I am on it.");
    expect(screen.getAllByText("seen").length).toBeGreaterThan(0);
    expect(screen.getAllByText("on it").length).toBeGreaterThan(0);
    expect(screen.getAllByText("done").length).toBeGreaterThan(0);
    expect(screen.getAllByText("can't").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Reply to shop-app-ta" })[0]);
    expect(screen.getByText(/Replying to shop-app-ta/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Post to #crew as CAPCOM · @name pings one agent"), {
      target: { value: "Acknowledged" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      const sent = fetch.mock.calls.find(([path]) => path === "/api/comms");
      expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
        to: "crew",
        text: "Acknowledged",
        replyTo: "comms:8",
      });
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Pin" })[0]);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/comms/comms%3A8/pin", expect.anything()),
    );
    fireEvent.click(screen.getByRole("button", { name: /shop-app-ta.*Please check/ }));
    await waitFor(() =>
      expect(document.getElementById("comms-message-comms:8")?.className).toContain("highlighted"),
    );
  });

  it("shows live agent navigation and drills into an agent contact", async () => {
    stubFetch({
      "/api/attention": [],
      "/api/crew": {
        rows: [
          seatRow({
            id: "shop-app-ta",
            displayCallSign: "shop-app-ta",
            area: ["area:web"],
            role: "web",
          }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "/api/comms/agents/shop-app-ta": {
        messages: [
          {
            id: "comms:1",
            from: "shop-app-ta",
            to: "studio",
            text: "handoff",
            at: NOW,
            ticket: null,
            label: "handoff",
            ref: null,
            replyTo: null,
            mentions: [],
            reactions: [],
            operator: false,
          },
        ],
        inbox: [],
        contacts: [],
        unread: 0,
        inboxUnread: 0,
      },
      "/api/comms/agents/shop-app-ta/contacts/studio": {
        messages: [
          {
            id: "comms:1",
            from: "shop-app-ta",
            to: "studio",
            text: "handoff",
            at: NOW,
            ticket: null,
            label: "handoff",
            ref: null,
            replyTo: null,
            mentions: [],
            reactions: [],
            operator: false,
          },
        ],
      },
      "POST /api/comms/read": { ok: true },
    });
    render(
      <Comms item={null} view={{ kind: "contact", agentId: "shop-app-ta", contactId: "studio" }} />,
    );
    const nav = await screen.findByRole("navigation", { name: "Comms" });
    expect(within(nav).getByText("FLIGHT ↔ CAPCOM")).toBeTruthy();
    // The Comms graph names the #crew hub too; the nav entry is the one asserted here.
    expect(within(nav).getByText("#crew")).toBeTruthy();
    expect((await screen.findAllByText("handoff")).length).toBe(2);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain(
      "shop-app-ta›studio",
    );
  });

  it("uses a crew seat's area label or role in the agent nav, never its path globs", async () => {
    const mention = {
      id: "comms:direct-mention",
      at: NOW,
      from: "guido-cx",
      to: "CAPCOM",
      text: "@CAPCOM can you check this?",
      ticket: null,
      label: "question",
      ref: null,
      replyTo: null,
      mentions: ["CAPCOM"],
      reactions: [],
      operator: false,
    };
    stubFetch({
      "/api/attention": [],
      "/api/crew": {
        rows: [
          seatRow({
            id: "guido-cx",
            displayCallSign: "guido-cx",
            area: ["area:core", "packages/core/**"],
            role: "builder",
          }),
          seatRow({
            id: "retro-cx",
            displayCallSign: "retro-cx",
            area: ["apps/review/**"],
            role: "review",
            hudState: "idle",
          }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "/api/comms/flight": { messages: [] },
      "/api/comms/mentions": { mentions: [{ message: mention, seen: false }] },
      "/api/comms/pins": { messages: [] },
      "/api/comms/agents/guido-cx": { messages: [], inbox: [], contacts: [], unread: 0 },
      "/api/comms/agents/retro-cx": { messages: [], inbox: [], contacts: [], unread: 0 },
    });
    render(<Comms item={null} view={{ kind: "flight" }} />);
    expect(await screen.findByText("core · running")).toBeTruthy();
    expect(screen.getByText("review · idle")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Comms" });
    const guido = within(nav).getByText("guido-cx").closest("button");
    const retro = within(nav).getByText("retro-cx").closest("button");
    expect(guido && within(guido).getByTitle("1 new mention")).toBeTruthy();
    expect(retro && within(retro).queryByTitle("1 new mention")).toBeNull();
    expect(screen.queryByText("packages/core/**")).toBeNull();
    expect(screen.queryByText("apps/review/**")).toBeNull();
  });

  it("does not request stored Comms for observed loops", async () => {
    const fetch = stubFetch({
      "/api/attention": [],
      "/api/crew": {
        rows: [
          crewRow({ id: "studio-builder", repoId: "site-builder", kind: "loop", role: null }),
          seatRow({
            id: "guido-cx",
            displayCallSign: "guido-cx",
            area: ["area:core"],
            role: "core",
          }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "/api/comms/flight": { messages: [] },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/comms/agents/guido-cx": { messages: [], inbox: [], contacts: [], unread: 0 },
    });
    render(<Comms item={null} view={{ kind: "flight" }} />);
    await screen.findByText("core · running");
    expect(fetch.mock.calls.some(([path]) => path === "/api/comms/agents/studio-builder")).toBe(
      false,
    );
    // The loop sits on the graph's loops spoke (#790), but has no conversation of its own.
    expect(
      screen.queryAllByText("studio-builder").filter((el) => !el.closest(".comms-spider")),
    ).toEqual([]);
  });

  it("shows the stored-Comms empty state for crew", async () => {
    stubFetch({
      "/api/attention": [],
      "/api/crew": { rows: ROWS, firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "/api/comms/crew": { messages: [] },
    });
    render(<Comms item={null} view={{ kind: "crew" }} />);
    expect(await screen.findByText("No messages yet.")).toBeTruthy();
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

  it("a person row links to its source", async () => {
    stub([item({ kind: "person", agentId: null, escalationId: null })]);
    render(<Comms item={null} />);
    const link = await within(needs()).findByRole("link", { name: "Open in GitHub ↗" });
    expect(link.getAttribute("href")).toBe(item().url);
  });

  it("a stall queued for the lock names the seat holding it", async () => {
    stubFetch({
      "/api/attention": [ITEMS[1]],
      "/api/test-lock": {
        holder: { seatId: "studio", runId: "r-12", command: "pnpm test", since: NOW - MIN },
        waiting: [{ runId: "r-13", seatId: "shop-app-ta", since: NOW - MIN }],
      },
    });
    render(<Comms item={null} />);
    await within(needs()).findByText("2:15 in Bash · waiting on the test lock (studio)");
  });

  it("a stall that isn't queued for the lock says nothing about it", async () => {
    stubFetch({
      "/api/attention": [ITEMS[1]],
      "/api/test-lock": {
        holder: { seatId: "studio", runId: "r-12", command: "pnpm test", since: NOW - MIN },
        waiting: [],
      },
    });
    render(<Comms item={null} />);
    await within(needs()).findByText("2:15 in Bash");
  });

  it("a PR names its ticket, title and wait time", async () => {
    stubFetch({
      "/api/attention": [
        item({
          kind: "pr",
          escalationId: null,
          agentId: null,
          ticket: "shop-app#3349",
          text: "PR #40 · You: decide on the draft",
          at: NOW - 5 * MIN,
          url: "https://github.com/octo-org/shop-app/pull/40",
        }),
      ],
      "/api/boards/shop-app": [boardItem({ title: "Quote <img src=x> cache" })],
      "/api/config": CONFIG,
    });
    render(<Comms item={null} />);
    await waitFor(() =>
      expect(needs().textContent).toContain(
        "shop-app#3349 · PR #40 · Quote <img src=x> cache: waiting 5m 00s for you to decide on the draft",
      ),
    );
    expect(needs().querySelector("img")).toBeNull();
  });

  it("shows every operator item with FLIGHT stopped", async () => {
    stub([item({ key: "a", text: "First" }), item({ key: "b", text: "Second" })]);
    render(<Comms item={null} />);
    await within(needs()).findByText("First");
    expect(within(needs()).getByText("Second")).toBeTruthy();
    expect(needs().querySelectorAll(":scope > .nrow")).toHaveLength(2);
  });

  it("marks a missed triage and leaves waiting items out of Needs you", async () => {
    stub([
      item({ key: "missed", flightTriage: "missed" }),
      item({ key: "waiting", text: "Waiting item", owner: "flight", flightTriage: "waiting" }),
    ]);
    render(<Comms item={null} />);
    expect(await screen.findByText("FLIGHT hasn't triaged this")).toBeTruthy();
    expect(needs().querySelectorAll(":scope > .nrow")).toHaveLength(1);
    expect(screen.queryByText("Waiting item")).toBeNull();
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

  it("lists FLIGHT's items as waiting on FLIGHT, not being handled, while FLIGHT is down", async () => {
    stub([
      item({ key: "a", text: "Mine" }),
      item({ key: "t", kind: "tag", text: "@CAPCOM key?", owner: "flight", flightTriage: "down" }),
      item({ key: "c", text: "C item", owner: "controller" }),
    ]);
    render(<Comms item={null} />);
    await screen.findByText("Mine");
    const down = document.querySelector<HTMLDetailsElement>("#cFlightDown") as HTMLDetailsElement;
    expect(within(down).getByText("Waiting on FLIGHT — FLIGHT is down · 1")).toBeTruthy();
    expect(within(down).getByText("@CAPCOM key?")).toBeTruthy();
    const handled = document.querySelector<HTMLDetailsElement>("#cHandled") as HTMLDetailsElement;
    expect(within(handled).getByText("Being handled · 1")).toBeTruthy();
    expect(within(handled).queryByText("@CAPCOM key?")).toBeNull();
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
    fireEvent.click(within(list).getByRole("button", { name: /^studio/ }));
    expect(document.querySelector("#chatP")?.textContent).toContain("Thread · studio");
    act(() => setSession("shop-app-session"));
    await waitFor(() => expect(within(list).queryByText("studio")).toBeNull());
    expect(within(list).getByText("shop-app-ta")).toBeTruthy();
    expect(document.querySelector("#chatP")?.textContent).toContain(FLIGHT_NO_SEAT);
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
  const stubMessages = (activity: ActivityRow[] = [], extra: Record<string, unknown> = {}) => {
    const read = new Set<string>();
    const messages = (id: string): CommsThreadMessage[] =>
      activity
        .map((m, index) => ({ m, index }))
        .filter(
          (entry): entry is { m: CommsEvent; index: number } =>
            entry.m.kind === "comms" && (entry.m.who === id || entry.m.to === id),
        )
        .sort((a, b) => a.m.at - b.m.at)
        .map(({ m, index }) => ({
          id: String(index),
          at: m.at,
          from: m.who,
          to: m.to,
          ticket: null,
          text: m.text,
          tagged: m.who === id && m.text.includes(TAG),
          direct: m.who === id && m.to === COMMS_CAPCOM,
          seen: read.has(`${id}:${index}`),
        }));
    return stubFetch({
      "/api/attention": () => ({
        status: 200,
        body: ["guido-1", "retro-1"].flatMap((id) => {
          const unread = messages(id).filter((m) => !m.seen);
          return (["tag", "message"] as const).flatMap((kind) => {
            const matching = unread.filter((m) => (kind === "tag" ? m.tagged : m.direct));
            const last = matching.at(-1);
            return last
              ? [
                  item({
                    key: `${kind}:${id}:${last.id}`,
                    kind,
                    agentId: id,
                    escalationId: null,
                    text: kind === "tag" ? last.text : `${matching.length} new on your direct line`,
                    at: last.at ?? 0,
                  }),
                ]
              : [];
          });
        }),
      }),
      "/api/crew": {
        rows: [seatRow(), seatRow({ id: "retro-1", index: 1 })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "/api/activity": activity,
      ...Object.fromEntries(
        ["guido-1", "retro-1"].flatMap((id) => [
          [`/api/comms/${id}`, () => ({ status: 200, body: { messages: messages(id) } })],
          [
            `POST /api/comms/${id}/read`,
            (init: RequestInit | undefined) => {
              const { messageIds } = JSON.parse(String(init?.body)) as { messageIds: string[] };
              for (const messageId of messageIds) read.add(`${id}:${messageId}`);
              return { status: 200, body: { ok: true } };
            },
          ],
        ]),
      ),
      ...extra,
    });
  };
  const MESSAGES = [
    comms({ at: NOW - MIN, who: "guido-1", to: "retro-1", text: `Draft PR is up ${TAG}` }),
    comms({ at: NOW - 2 * MIN, who: "MC", to: "guido-1", text: "CI failed on lint" }),
    comms({ at: NOW - 3 * MIN, who: "CAPCOM", to: "guido-1", text: "Use the quote cache" }),
    comms({ at: NOW - 4 * MIN, who: "retro-1", to: "CAPCOM", text: "Not guido's" }),
  ];

  it("agent tags and direct replies count, Read opens their thread and seen state survives a revisit", async () => {
    const messages = [
      comms({ to: "retro-1", text: `Please check ${TAG}` }),
      comms({ who: "retro-1", text: "One reply" }),
      comms({ who: "retro-1", text: "Another reply", at: NOW + 1 }),
      comms({ who: COMMS_CAPCOM, to: "guido-1", text: TAG }),
      comms({ who: COMMS_MC, to: "guido-1", text: TAG }),
    ];
    stubMessages(messages);
    const view = render(<Comms item={null} />);
    await screen.findByText("2 · 2 not acknowledged");
    const list = document.querySelector("#chanList") as HTMLElement;
    const guido = within(list).getByText("guido-1").closest("button") as HTMLButtonElement;
    expect(within(guido).getByText("Tagged you")).toBeTruthy();
    expect(guido.classList.contains("tagged")).toBe(true);
    const tag = needs().querySelector('[data-kind="tag"]') as HTMLElement;
    fireEvent.click(within(tag).getByRole("button", { name: "Read" }));
    expect(guido.getAttribute("aria-pressed")).toBe("true");
    await screen.findByText("1 · 1 not acknowledged");
    expect(within(guido).queryByText("Tagged you")).toBeNull();
    const reply = within(needs())
      .getByText("2 new on your direct line")
      .closest(".nrow") as HTMLElement;
    fireEvent.click(within(reply).getByRole("button", { name: "Read" }));
    expect(within(list).getByText("retro-1").closest("button")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    await screen.findByText("nothing waiting");
    view.unmount();
    render(<Comms item={null} />);
    expect(needs().querySelector(".nrow")).toBeNull();
    messages.push(comms({ text: "A fresh reply", at: NOW + MIN }));
    act(() => {
      hub.refetchTopic("agents");
      hub.refetchTopic("attention");
    });
    await within(needs()).findByText("1 new on your direct line");
  });

  it("a reply with the same timestamp becomes unread and stays seen after reading", async () => {
    const messages = [comms({ text: "First reply" })];
    stubMessages(messages);
    const view = render(<Comms item={null} />);
    fireEvent.click(await within(needs()).findByRole("button", { name: "Read" }));
    await screen.findByText("nothing waiting");
    const list = document.querySelector("#chanList") as HTMLElement;
    fireEvent.click(within(list).getByRole("button", { name: /retro-1/ }));
    messages.push(comms({ text: "Same-time reply" }));
    act(() => {
      hub.refetchTopic("agents");
      hub.refetchTopic("attention");
    });
    await within(needs()).findByText("1 new on your direct line");
    fireEvent.click(within(needs()).getByRole("button", { name: "Read" }));
    await screen.findByText("nothing waiting");
    view.unmount();
    render(<Comms item={null} />);
    expect(needs().querySelector(".nrow")).toBeNull();
  });

  it("Read opens a thread from another session", async () => {
    setSession("site-builder");
    stubMessages([comms({ text: "Reply from another session" })]);
    render(<Comms item={null} />);
    fireEvent.click(await within(needs()).findByRole("button", { name: "Read" }));
    await waitFor(() =>
      expect(document.querySelector("#convo")?.textContent).toContain("Reply from another session"),
    );
    await screen.findByText("nothing waiting");
  });

  it("messages arriving in the open thread stay seen after switching threads", async () => {
    const messages = [comms({ text: "First reply" })];
    stubMessages(messages);
    render(<Comms item={null} />);
    fireEvent.click(await within(needs()).findByRole("button", { name: "Read" }));
    await within(document.querySelector("#chatP") as HTMLElement).findByText("First reply");
    await screen.findByText("nothing waiting");
    messages.push(comms({ text: "Live reply", at: NOW }));
    act(() => {
      hub.refetchTopic("agents");
      hub.refetchTopic("attention");
    });
    await within(document.querySelector("#convo") as HTMLElement).findByText("Live reply");
    await screen.findByText("nothing waiting");
    const list = document.querySelector("#chanList") as HTMLElement;
    fireEvent.click(within(list).getByRole("button", { name: /retro-1/ }));
    expect(needs().querySelector(".nrow")).toBeNull();
  });

  it.each(["tag", "message"] as const)(
    "Read on a server %s item selects and clears its thread",
    async (kind) => {
      let read = false;
      stubMessages([comms({ text: "Read this thread" })], {
        "/api/attention": () => ({
          status: 200,
          body: read
            ? []
            : [
                item({
                  kind,
                  agentId: "guido-1",
                  escalationId: null,
                  text: "Read this thread",
                }),
              ],
        }),
        "POST /api/comms/guido-1/read": () => {
          read = true;
          return { status: 200, body: { ok: true } };
        },
      });
      render(<Comms item={null} />);
      fireEvent.click(await within(needs()).findByRole("button", { name: "Read" }));
      const list = document.querySelector("#chanList") as HTMLElement;
      expect(
        within(list)
          .getByRole("button", { name: /guido-1/ })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      await screen.findByText("nothing waiting");
    },
  );

  it("FLIGHT shows its placeholder; an agent's thread opens its messages", async () => {
    stubMessages(MESSAGES);
    render(<Comms item={null} />);
    await waitFor(() => expect(screen.getAllByText(FLIGHT_NO_SEAT)).toHaveLength(2));
    expect(document.querySelector("#chatP #chatMsgs")).toBeNull(); // no seat: no chat
    const list = document.querySelector("#chanList") as HTMLElement;
    fireEvent.click(
      (await within(list).findByText("guido-1")).closest("button") as HTMLButtonElement,
    );
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
    fireEvent.click(
      (await within(list).findByText("guido-1")).closest("button") as HTMLButtonElement,
    );
    const input = screen.getByLabelText("Message this agent") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft for guido" } });
    expect(input.value).toBe("Draft for guido");

    fireEvent.click(within(list).getByRole("button", { name: /retro-1/ }));
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
    fireEvent.click(
      (await within(list).findByText("guido-1")).closest("button") as HTMLButtonElement,
    );
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

  it("keeps each desktop Comms column scrollable without clipping the stacked layout", () => {
    const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
    const rule = (sel: string) => css.match(new RegExp(`${sel} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule("\\.comms-page")).toContain("overflow: hidden");
    expect(rule("\\.comms-grid")).toContain("overflow: hidden");
    expect(rule("\\.comms-agent")).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(rule("\\.comms-agent")).toContain("height: 100%");
    expect(rule("\\.comms-messages")).toContain("overflow-y: auto");
    expect(rule("\\.comms-messages")).toContain("scrollbar-gutter: stable");
    expect(rule("\\.comms-message-stack")).not.toContain("justify-content: flex-end");
    expect(rule("\\.comms-message-stack > :first-child")).toContain("margin-top: auto");
    expect(css).toMatch(/\.comms-left,\s*\.comms-right \{[^}]*overflow-y: auto/);
    expect(css).toMatch(
      /@media \(max-width: 999px\), \(max-height: 559px\) \{[\s\S]*?\.comms-page,[\s\S]*?\.comms-grid \{[\s\S]*?overflow: visible/,
    );
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
    expect(await within(needs()).findAllByText(/holds the test lock/)).toHaveLength(2);
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
    fireEvent.click(
      (await within(list).findByText("guido-1")).closest("button") as HTMLButtonElement,
    );
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
