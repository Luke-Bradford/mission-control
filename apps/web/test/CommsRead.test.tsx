import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommsConversation } from "../src/comms/Conversation.tsx";
import { hub } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, MIN, NOW } from "./fixtures.ts";

const message = (n: number, from: string, to: string) => ({
  id: `comms:${n}`,
  at: NOW - (10 - n) * MIN,
  from,
  to,
  text: `Message ${n}`,
  ticket: null,
  label: null,
  ref: null,
  replyTo: null,
  mentions: [],
  reactions: [],
  pinned: false,
  operator: false,
});

const FLIGHT_PAGE = {
  messages: [message(1, "CAPCOM", "flight-1"), message(2, "flight-1", "CAPCOM")],
  hasMore: false,
  cursor: null,
  unread: 2,
};

const READ_ERROR = /Could not mark this conversation read/;

const routes = {
  "/api/comms/flight": FLIGHT_PAGE,
  "/api/comms/mentions": { mentions: [] },
  "/api/comms/pins": { messages: [] },
  "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
};

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

describe("opening a Comms conversation marks it read", () => {
  it("renders undated turn text honestly and reads its source id without offering stored-message actions", async () => {
    const id = "stream:flight-run:123:0";
    const fetch = stubFetch({
      ...routes,
      "/api/config": CONFIG,
      "/api/comms/flight": {
        ...FLIGHT_PAGE,
        messages: [{ ...message(2, "flight-1", "CAPCOM"), id, at: null }],
      },
      "POST /api/comms/read": { ok: true },
    });
    render(<CommsConversation view={{ kind: "flight" }} row={null} />);
    const text = await screen.findByText("Message 2");
    const bubble = text.closest("article");
    expect(bubble).not.toBeNull();
    if (!bubble) throw new Error("Missing conversation line");
    expect(within(bubble).getByText("—")).toBeTruthy();
    expect(within(bubble).queryByRole("button", { name: "Pin" })).toBeNull();
    expect(within(bubble).queryByRole("button", { name: /Reply|Ack/ })).toBeNull();
    await waitFor(() => {
      const call = fetch.mock.calls.find(([path]) => path === "/api/comms/read");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ scope: "flight", messageId: id });
    });
    expect(screen.queryByText(READ_ERROR)).toBeNull();
  });

  it("posts the server's read body for the newest message, and shows no error", async () => {
    const fetch = stubFetch({ ...routes, "POST /api/comms/read": { ok: true } });
    render(<CommsConversation view={{ kind: "flight" }} row={null} />);
    await screen.findByText("Message 2");
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/comms/read", expect.anything()));
    const call = fetch.mock.calls.find(([path]) => path === "/api/comms/read");
    expect(call?.[1]?.method).toBe("POST");
    // The server (POST /api/comms/read) takes exactly these two keys and no others.
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ scope: "flight", messageId: "comms:2" });
    await waitFor(() =>
      expect(fetch.mock.calls.filter(([p]) => p === "/api/comms/flight")).toHaveLength(2),
    );
    expect(screen.queryByText(READ_ERROR)).toBeNull();
  });

  it("shows the error line, with Retry, when the server refuses the read", async () => {
    stubFetch({
      ...routes,
      "POST /api/comms/read": () => ({
        status: 400,
        body: { error: "invalid Comms read cursor" },
      }),
    });
    render(<CommsConversation view={{ kind: "flight" }} row={null} />);
    expect(await screen.findByText(READ_ERROR)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows no error when the request never got an answer (a read-only page, a blocked write)", async () => {
    const fetch = stubFetch({ ...routes });
    const answer = fetch.getMockImplementation();
    fetch.mockImplementation(async (input, init) => {
      if (init?.method === "POST") throw new TypeError("Failed to fetch");
      return (answer as NonNullable<typeof answer>)(input, init);
    });
    render(<CommsConversation view={{ kind: "flight" }} row={null} />);
    await screen.findByText("Message 2");
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/comms/read", expect.anything()));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(READ_ERROR)).toBeNull();
  });
});
