import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommsConversation } from "../src/comms/Conversation.tsx";
import { seatName } from "../src/crew.ts";
import { hub } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { crewRow, MIN, NOW } from "./fixtures.ts";

const message = (id: string, from: string, senderKind: string | null) => ({
  id,
  at: NOW - MIN,
  from,
  to: "crew",
  text: `text of ${id}`,
  ticket: null,
  label: null,
  ref: null,
  replyTo: null,
  mentions: [],
  reactions: [],
  pinned: false,
  operator: false,
  senderKind,
});

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

async function show(messages: ReturnType<typeof message>[]) {
  stubFetch({
    "/api/comms/crew": { messages },
    "/api/comms/mentions": { mentions: [] },
    "/api/comms/pins": { messages: [] },
    "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
    "/api/crew?shape=summary": { rows: [crewRow()], firstRunToday: null },
    "POST /api/comms/read": { ok: true },
  });
  render(<CommsConversation view={{ kind: "crew" }} row={null} onJumped={() => {}} />);
  await screen.findByText(`text of ${messages[0]?.id}`);
}

const tagOf = (id: string) =>
  within(document.getElementById(`comms-message-${id}`) as HTMLElement).getByTestId("sender-tag");

describe("sender tags", () => {
  it.each([
    ["operator", "CAPCOM", "YOU"],
    ["controller", "controller", "CONTROLLER"],
    ["flight", "flight-1", "FLIGHT"],
    ["hub", "MC", "HUB"],
  ])("tags a %s message %s", async (kind, from, tag) => {
    await show([message("m1", from, kind)]);
    expect(tagOf("m1").textContent).toBe(tag);
    expect(tagOf("m1").getAttribute("data-kind")).toBe(kind);
  });

  it("tags a seat message with the seat's name", async () => {
    const row = crewRow();
    await show([message("m1", row.id, "seat")]);
    expect(tagOf("m1").getAttribute("data-kind")).toBe("seat");
    expect(tagOf("m1").textContent).not.toBe("");
    expect(tagOf("m1").textContent).toBe(seatName(row.id, [row]));
  });

  it("shows no new tag on an older message with no stored kind, only its end label", async () => {
    await show([message("m1", "CAPCOM", null)]);
    const bubble = document.getElementById("comms-message-m1") as HTMLElement;
    expect(within(bubble).queryByTestId("sender-tag")).toBeNull();
    expect(within(bubble).getByText("You")).toBeTruthy();
  });
});
