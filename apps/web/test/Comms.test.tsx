import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommsConversation } from "../src/comms/Conversation.tsx";
import { Decisions } from "../src/comms/Decisions.tsx";
import { hub } from "../src/data.ts";
import { FLIGHT_NO_SEAT } from "../src/flight/flightTypes.ts";
import { Comms } from "../src/pages/Comms.tsx";
import { stubFetch } from "./fetchStub.ts";
import { brief, CONFIG, crewRow, item, MIN, NOW, seatRow } from "./fixtures.ts";

const ROWS = [
  crewRow(),
  crewRow({ id: "studio", repoId: "site-builder", index: 1, hudState: "idle", run: null }),
];

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
      "/api/comms/agents/alpha?summary=1": {
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
      "/api/crew?shape=summary": { rows: ROWS, firstRunToday: null },
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
    fireEvent.click(screen.getByRole("button", { name: "Ack shop-app-ta" }));
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
      "/api/crew?shape=summary": { rows: [seat], firstRunToday: null },
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
      "/api/comms/agents/alpha?summary=1": {
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

  const stored = (id: string, text: string, at: number) => ({
    id,
    at,
    from: "alpha",
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

  it("loads older messages above the newest page, and drops the control when none remain", async () => {
    const fetch = stubFetch({
      "/api/comms/crew": {
        messages: [stored("comms:50", "Newest page", NOW)],
        hasMore: true,
      },
      "/api/comms/crew?before=comms%3A50": {
        messages: [stored("comms:49", "From the page before", NOW - MIN)],
        hasMore: false,
      },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
      "POST /api/comms/read": { ok: true },
    });
    render(<CommsConversation view={{ kind: "crew" }} row={null} />);
    await screen.findByText("Newest page");
    expect(screen.queryByText("From the page before")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByText("From the page before");
    const texts = [...document.querySelectorAll(".comms-bubble")].map((b) => b.textContent ?? "");
    expect(texts[0]).toContain("From the page before");
    expect(texts[1]).toContain("Newest page");
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    expect(fetch.mock.calls.map(([p]) => p)).toContain("/api/comms/crew?before=comms%3A50");
  });

  it("offers no older messages when the route has none", async () => {
    stubFetch({
      "/api/comms/crew": { messages: [stored("comms:1", "Only one", NOW)], hasMore: false },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
      "POST /api/comms/read": { ok: true },
    });
    render(<CommsConversation view={{ kind: "crew" }} row={null} />);
    await screen.findByText("Only one");
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("says so when older messages cannot be loaded", async () => {
    stubFetch({
      "/api/comms/crew": { messages: [stored("comms:50", "Newest page", NOW)], hasMore: true },
      "/api/comms/crew?before=comms%3A50": () => ({ status: 500, body: { error: "boom" } }),
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
      "POST /api/comms/read": { ok: true },
    });
    render(<CommsConversation view={{ kind: "crew" }} row={null} />);
    await screen.findByText("Newest page");
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByText("Could not load older messages.");
    expect(screen.getByRole("button", { name: "Load older" })).toBeTruthy();
  });

  it("opens on the nav summaries and fetches only the selected conversation's messages", async () => {
    const fetch = stubFetch({
      "/api/attention": [],
      "/api/crew?shape=summary": {
        rows: [
          seatRow({ id: "alpha", displayCallSign: "alpha" }),
          seatRow({ id: "beta", displayCallSign: "beta", index: 1 }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "/api/comms/flight": { messages: [] },
      "/api/comms/crew": { messages: [] },
      "/api/comms/mentions": { mentions: [] },
      "/api/comms/pins": { messages: [] },
      "/api/comms/agents/alpha?summary=1": { contacts: [], unread: 0 },
      "/api/comms/agents/beta?summary=1": { contacts: [], unread: 0 },
    });
    render(<Comms item={null} view={{ kind: "crew" }} />);
    await waitFor(() =>
      expect(fetch.mock.calls.map(([p]) => p)).toContain("/api/comms/agents/beta?summary=1"),
    );
    const asked = fetch.mock.calls.map(([p]) => String(p));
    expect(asked).toContain("/api/comms/agents/alpha?summary=1");
    expect(asked).toContain("/api/comms/agents/beta?summary=1");
    expect(asked).not.toContain("/api/crew");
    expect(asked.filter((p) => /^\/api\/comms\/agents\/[^?/]+$/.test(p))).toEqual([]);
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
      "/api/comms/agents/alpha?summary=1": {
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
      "/api/crew?shape=summary": { rows: ROWS, firstRunToday: null },
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
      "/api/crew?shape=summary": {
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
      "/api/comms/agents/shop-app-ta?summary=1": {
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
      "/api/crew?shape=summary": {
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
      "/api/comms/agents/guido-cx?summary=1": { messages: [], inbox: [], contacts: [], unread: 0 },
      "/api/comms/agents/retro-cx": { messages: [], inbox: [], contacts: [], unread: 0 },
      "/api/comms/agents/retro-cx?summary=1": { messages: [], inbox: [], contacts: [], unread: 0 },
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
      "/api/crew?shape=summary": {
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
      "/api/comms/agents/guido-cx?summary=1": { messages: [], inbox: [], contacts: [], unread: 0 },
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
      "/api/crew?shape=summary": { rows: ROWS, firstRunToday: null },
      "/api/config": CONFIG,
      "/api/flight": { seat: null, decisions: [] },
      "/api/comms/crew": { messages: [] },
    });
    render(<Comms item={null} view={{ kind: "crew" }} />);
    expect(await screen.findByText("No messages yet.")).toBeTruthy();
  });
});

describe("Decisions", () => {
  it("lists a briefed question with a default and counts down to that default", () => {
    const defaultDueAt = NOW + 90_000;
    render(
      <Decisions
        items={[
          item({
            key: "ask:default",
            kind: "question",
            text: "Which cache should we use?",
            brief: brief(),
            defaultDueAt,
            triageDueAt: NOW + 10 * MIN,
          }),
          item({
            key: "decision:triage",
            text: "Current decision deadline",
            triageDueAt: NOW + MIN,
          }),
        ]}
        rows={ROWS}
        flightSeat={null}
        onDiscuss={() => {}}
      />,
    );

    const decisions = screen.getByRole("region", { name: "Decisions" });
    expect(within(decisions).getByText("Which cache should we use?")).toBeTruthy();
    expect(within(decisions).getByText("default in 1:30")).toBeTruthy();
    expect(within(decisions).getByText("default in 1:00")).toBeTruthy();
  });
});
