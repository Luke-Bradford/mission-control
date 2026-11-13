import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommsConversation } from "../src/comms/Conversation.tsx";
import { hub } from "../src/data.ts";
import { DockSummary } from "../src/shell/DockSummary.tsx";
import { Header } from "../src/shell/Header.tsx";
import { markMentionsSeen, resetMarkedSeen } from "../src/shell/operatorMessages.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, crewRow, NOW } from "./fixtures.ts";

const message = (id: string) => ({
  id,
  at: NOW,
  from: "alpha",
  to: "crew",
  text: `@CAPCOM please look at ${id}`,
  ticket: null,
  label: null,
  ref: null,
  replyTo: null,
  mentions: ["CAPCOM"],
  reactions: [],
  pinned: false,
  operator: false,
});

beforeEach(() => {
  hub.clear();
  resetMarkedSeen();
});
afterEach(() => {
  hub.clear();
  vi.unstubAllGlobals();
});

/** The hub's mention list never changes here: only the shared read state can lower a count. */
function stubHub() {
  return stubFetch({
    "/api/attention": [],
    "/api/crew?shape=summary": { rows: [crewRow()], firstRunToday: null },
    "/api/config": CONFIG,
    "/api/flight": { seat: null, decisions: [] },
    "/api/flight/summary": { headline: null, headlineAgeMin: 0, session: null },
    "/api/comms/crew": { messages: [message("comms:1")] },
    "/api/comms/mentions": {
      mentions: [
        { message: message("comms:1"), seen: false },
        { message: message("comms:2"), seen: false },
      ],
    },
    "/api/comms/pins": { messages: [] },
    "POST /api/comms/read": { ok: true },
    "POST /api/comms/mentions/seen": { ok: true },
  });
}

describe("one read state for mentions", () => {
  it("lowers the header chat badge and the dock list when the Comms bell marks one read", async () => {
    stubHub();
    render(
      <>
        <Header page="comms" />
        <DockSummary canMessage />
        <CommsConversation view={{ kind: "crew" }} row={null} />
      </>,
    );
    const bell = await screen.findByRole("button", { name: "Mentions, 2 new" });
    expect(screen.getByRole("button", { name: "FLIGHT chat, 2 unread to you" })).toBeTruthy();
    fireEvent.click(bell);
    const panel = screen.getByRole("region", { name: "Mentions" });
    fireEvent.click(within(panel).getByText("@CAPCOM please look at comms:1"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "FLIGHT chat, 1 unread to you" })).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Mentions, 1 new" })).toBeTruthy();
    expect(screen.getByText("Messages to you · 1")).toBeTruthy();
  });

  it("lowers the bell when the dock's Mark all read marks them", async () => {
    stubHub();
    render(
      <>
        <DockSummary canMessage />
        <CommsConversation view={{ kind: "crew" }} row={null} />
      </>,
    );
    await screen.findByRole("button", { name: "Mentions, 2 new" });
    await act(async () => {
      await markMentionsSeen(["comms:1", "comms:2"]);
    });
    expect(screen.getByRole("button", { name: "Mentions, 0 new" })).toBeTruthy();
    expect(screen.queryByText(/Messages to you/)).toBeNull();
  });
});
