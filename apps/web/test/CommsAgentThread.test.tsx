import { COMMS_CAPCOM } from "@mc/core";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommsConversation } from "../src/comms/Conversation.tsx";
import { hub } from "../src/data.ts";
import { commsContactPath } from "../src/router.ts";
import { stubFetch } from "./fetchStub.ts";
import { NOW, seatRow } from "./fixtures.ts";

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

const message = (id: string, from: string, to: string, text: string) => ({
  id,
  at: NOW,
  from,
  to,
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

const thread = (contactId: string) => {
  const out = message("comms:1", "alpha", contactId, "From the chosen agent");
  const back = message("comms:2", contactId, "alpha", "From the other agent");
  const summary = {
    messages: [out, back],
    inbox: [],
    contacts: [{ id: contactId, count: 2, unread: 0, lastMessage: back }],
    unread: 0,
    inboxUnread: 0,
  };
  stubFetch({
    "/api/comms/agents/alpha": summary,
    "/api/comms/agents/alpha?summary=1": summary,
    [`/api/comms/agents/alpha/contacts/${contactId}`]: { messages: [out, back] },
    "/api/comms/mentions": { mentions: [] },
    "/api/comms/pins": { messages: [] },
    "/api/flight": { seat: null, decisions: [] },
    "POST /api/comms/read": { ok: true },
  });
  render(
    <CommsConversation
      view={{ kind: "contact", agentId: "alpha", contactId }}
      row={seatRow({ id: "alpha" })}
    />,
  );
};
const bubble = (text: string) =>
  within(document.getElementById("convo") as HTMLElement)
    .getByText(text)
    .closest(".comms-bubble") as HTMLElement;

it("an agent-to-agent thread puts the chosen agent on the right, the other on the left", async () => {
  thread("beta");
  await screen.findByText("From the chosen agent");
  expect(bubble("From the chosen agent").classList.contains("right")).toBe(true);
  expect(bubble("From the other agent").classList.contains("right")).toBe(false);
});

it("an agent-to-agent thread is read-only and links to the operator's own conversation", async () => {
  thread("beta");
  await screen.findByText("From the chosen agent");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Reply to/ })).toBeNull();
  const link = screen.getByRole("link", { name: /your conversation with alpha/i });
  expect(link.getAttribute("href")).toBe(commsContactPath("alpha", COMMS_CAPCOM));
});

it("the operator's own thread with the agent still has its message box and puts the operator on the right", async () => {
  thread(COMMS_CAPCOM);
  await screen.findByText("From the chosen agent");
  expect(screen.getByLabelText("Message alpha as CAPCOM")).toBeTruthy();
  expect(bubble("From the other agent").classList.contains("right")).toBe(true);
  expect(bubble("From the chosen agent").classList.contains("right")).toBe(false);
});
