import { COMMS_CAPCOM } from "@mc/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommsConversation } from "../src/comms/Conversation.tsx";
import { isSendKey, SEND_HINT } from "../src/components/sendKey.ts";
import { hub } from "../src/data.ts";
import { COMMS_INBOX_HEADING } from "../src/flight/conversation.ts";
import { MC_LINE_PREFIX } from "../src/flight/flightTypes.ts";
import { Dock } from "../src/shell/Dock.tsx";
import { flyoutContext, stripContext, withContext } from "../src/shell/flyoutContext.ts";
import { resetOverlays } from "../src/shell/overlays.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, NOW } from "./fixtures.ts";
import { flightSummary } from "./flightSummaryFixture.ts";

const key = (over: Partial<Parameters<typeof isSendKey>[0]>) => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

describe("the one send rule", () => {
  it("Enter and Ctrl or Cmd+Enter send; Shift+Enter, other keys and composing Enter do not", () => {
    expect(isSendKey(key({}))).toBe(true);
    expect(isSendKey(key({ ctrlKey: true }))).toBe(true);
    expect(isSendKey(key({ metaKey: true }))).toBe(true);
    expect(isSendKey(key({ shiftKey: true }))).toBe(false);
    expect(isSendKey(key({ key: "a" }))).toBe(false);
    expect(isSendKey({ ...key({}), nativeEvent: { isComposing: true } })).toBe(false);
    expect(SEND_HINT).toBe("Enter to send · Shift+Enter for a new line");
  });
});

describe("where the operator is", () => {
  it("names the page, and the ticket or seat open on it", () => {
    expect(flyoutContext("/")).toBe("Overview");
    expect(flyoutContext("/needs-you")).toBe("Needs you");
    expect(flyoutContext("/flight")).toBe("FLIGHT");
    expect(flyoutContext("/comms")).toBe("Comms");
    expect(flyoutContext("/tickets/shop-app/12")).toBe("Board · shop-app#12");
    expect(flyoutContext("/agent/inco-1")).toBe("Agents · inco-1");
  });

  it("puts a line before the message that stripping takes off again", () => {
    expect(withContext("Board · shop-app#12", "why?")).toBe(
      "[Operator is on: Board · shop-app#12]\nwhy?",
    );
    expect(withContext(null, "why?")).toBe("why?");
    expect(stripContext(withContext("Board · shop-app#12", "why?"))).toBe("why?");
    expect(stripContext("plain")).toBe("plain");
  });
});

const SEAT = {
  id: "flight-1",
  call: "FLIGHT-1",
  model: "opus",
  state: "idle",
  live: true,
  turns: null,
};
const stored: Record<string, unknown>[] = [];
let nextId = 1;
let seat: Record<string, unknown> = SEAT;
let events: Record<string, unknown>[] = [];

const message = (from: string, to: string, text: string) => ({
  id: `comms:${nextId++}`,
  at: NOW + nextId,
  from,
  to,
  text,
  ticket: null,
  label: null,
  ref: null,
  replyTo: null,
  mentions: [],
  reactions: [],
  operator: from === COMMS_CAPCOM,
});

function stub() {
  return stubFetch({
    "/api/attention": [],
    "/api/escalations": [],
    "/api/crew?shape=summary": { rows: [] },
    "/api/config": CONFIG,
    "/api/flight": () => ({ status: 200, body: { seat, decisions: [] } }),
    "/api/flight/summary": flightSummary(),
    "/api/agents/flight-1/stream?limit=20": () => ({
      status: 200,
      body: { runId: "r1", truncated: false, lastOutputAt: null, reason: null, events },
    }),
    "/api/comms/flight": () => ({ status: 200, body: { messages: stored, hasMore: false } }),
    "/api/comms/mentions": { mentions: [] },
    "/api/comms/pins": { messages: [] },
    "POST /api/comms": (init: RequestInit | undefined) => {
      const body = JSON.parse(init?.body as string) as { to: string; text: string };
      const m = message(COMMS_CAPCOM, body.to, body.text);
      stored.push(m);
      return { status: 200, body: { message: m } };
    },
  });
}

beforeEach(() => {
  stored.length = 0;
  events = [];
  seat = SEAT;
  window.history.replaceState(null, "", "/");
  resetOverlays();
});
afterEach(() => {
  hub.clear();
  vi.unstubAllGlobals();
});

const box = () => screen.getByLabelText("Message FLIGHT") as HTMLTextAreaElement;
const send = async (text: string) => {
  await waitFor(() =>
    expect(document.querySelector("#dockState")?.textContent).not.toContain("Checking FLIGHT"),
  );
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(box().value).toBe(""));
};

describe("what the line under the box says", () => {
  it("says sent while FLIGHT has not picked the message up, then delivered when it has", async () => {
    stub();
    const { container } = render(<Dock />);
    await send("status?");
    const state = () => container.querySelector("#dockState")?.textContent ?? "";
    await waitFor(() => expect(state()).toContain("Sent."));
    // What the hub really writes into FLIGHT's stream when it hands the message over.
    const stored1 = stored[0] as { id: string; text: string };
    events = [
      {
        id: "1:0",
        at: NOW + 100_000,
        kind: "op",
        text: `${COMMS_INBOX_HEADING} the operator's own messages and replies):\n${JSON.stringify([stored1])}`,
      },
    ];
    await waitFor(() => hub.refetchAll());
    await waitFor(() => expect(state()).toContain("Delivered to FLIGHT."));
    // The JSON dump is not a message from the operator: the conversation shows the one they typed.
    expect(container.querySelectorAll(".dmsg.you")).toHaveLength(1);
    expect(container.querySelector(".dmsg.you")?.textContent).toContain("status?");
    expect(container.textContent).not.toContain("Comms inbox");
  });

  it.each([
    ["the wake the hub sends an idle FLIGHT", "Wake: 1 operator message"],
    ["the start brief after Start FLIGHT", "You are FLIGHT. Your brief follows."],
  ])("says delivered once %s carries the stored message", async (_name, lead) => {
    stub();
    const { container } = render(<Dock />);
    await send("status?");
    const state = () => container.querySelector("#dockState")?.textContent ?? "";
    await waitFor(() => expect(state()).toContain("Sent."));
    const stored1 = stored[0] as { id: string };
    events = [
      {
        id: "1:0",
        at: NOW + 100_000,
        kind: "op",
        text: `${MC_LINE_PREFIX} ${lead}\n\n${COMMS_INBOX_HEADING} the operator's own messages and replies):\n${JSON.stringify([stored1])}`,
      },
    ];
    await waitFor(() => hub.refetchAll());
    await waitFor(() => expect(state()).toContain("Delivered to FLIGHT."));
    expect(container.querySelectorAll(".dmsg.you")).toHaveLength(1);
  });

  it("says delivered once FLIGHT has answered, whatever the stream shows of the hand-over", async () => {
    stub();
    const { container } = render(<Dock />);
    await send("status?");
    const state = () => container.querySelector("#dockState")?.textContent ?? "";
    await waitFor(() => expect(state()).toContain("Sent."));
    events = [{ id: "2:0", at: NOW + 200_000, kind: "msg", text: "All seats busy." }];
    await waitFor(() => hub.refetchAll());
    await waitFor(() => expect(state()).toContain("Delivered to FLIGHT."));
    expect(container.textContent).toContain("All seats busy.");
  });

  it("says waiting while FLIGHT is stopped, with Start FLIGHT beside it", async () => {
    seat = { ...SEAT, state: "stopped", live: false };
    stub();
    const { container } = render(<Dock />);
    await send("when you are up");
    await waitFor(() =>
      expect(container.querySelector("#dockState")?.textContent).toContain(
        "Waiting: FLIGHT is stopped",
      ),
    );
    expect(screen.getByRole("button", { name: "Start FLIGHT" })).toBeTruthy();
  });
});

describe("one FLIGHT conversation", () => {
  it("a message sent from the fly-out shows in Comms' FLIGHT thread, and one sent from Comms shows in the fly-out", async () => {
    stub();
    render(
      <>
        <Dock />
        <CommsConversation view={{ kind: "flight" }} row={null} />
      </>,
    );
    await send("from the fly-out");
    const thread = () => document.querySelector(".comms-messages")?.textContent ?? "";
    await waitFor(() => expect(thread()).toContain("from the fly-out"));

    const comms = (await screen.findByLabelText(/Message FLIGHT as CAPCOM/)) as HTMLTextAreaElement;
    fireEvent.change(comms, { target: { value: "from Comms" } });
    fireEvent.keyDown(comms, { key: "Enter" });
    await waitFor(() =>
      expect(document.querySelector("#dockMsgs")?.textContent).toContain("from Comms"),
    );
    expect(document.querySelector("#dockMsgs")?.textContent).toContain("from the fly-out");
    // The fly-out shows what was typed; the stored text, with the context line, is what Comms keeps.
    expect(document.querySelector("#dockMsgs")?.textContent).not.toContain("Operator is on");
  });
});
