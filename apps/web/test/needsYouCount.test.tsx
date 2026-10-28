import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardPage } from "../src/pages/BoardPage.tsx";
import { Comms } from "../src/pages/Comms.tsx";
import { Flight } from "../src/pages/Flight.tsx";
import { Dock } from "../src/shell/Dock.tsx";
import { Header } from "../src/shell/Header.tsx";
import { resetSession, setSession } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";
import {
  boardItem,
  brief,
  CONFIG,
  crewRow,
  HOUR,
  item,
  itemWithoutOwner,
  NOW,
  REPOS,
} from "./fixtures.ts";
import { flightSummary } from "./flightSummaryFixture.ts";

const SEAT = { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true };

const ticket = (repoId: string, n: number) =>
  boardItem({
    repoId,
    issueNumber: n,
    title: `Ticket ${n}`,
    status: "Todo",
    state: "planned",
  });

/**
 * The operator's items, some twice, beside items others own: the canonical set is a (decision,
 * listed twice), b (a PR in another session's repo) and c (no owner, so the operator's). d and e
 * are FLIGHT's and a work lane's, and must count nowhere.
 */
const ATTENTION = [
  item({ key: "esc:shop-app#1", ticket: "shop-app#1", escalationId: "shop-app#1", brief: brief() }),
  item({ key: "esc:shop-app#1", ticket: "shop-app#1", escalationId: "shop-app#1", brief: brief() }),
  item({
    key: "pr:site-builder#9:1",
    kind: "pr",
    repoId: "site-builder",
    text: "PR #9 · You: review",
    agentId: null,
    escalationId: null,
    ticket: "site-builder#2",
    at: NOW - 2 * HOUR,
  }),
  itemWithoutOwner({
    key: "ask:3",
    kind: "question",
    text: "Which port?",
    escalationId: null,
    ticket: "shop-app#3",
  }),
  item({
    key: "esc:shop-app#4",
    ticket: "shop-app#4",
    escalationId: "shop-app#4",
    owner: "flight",
  }),
  item({
    key: "pr:shop-app#5:1",
    kind: "pr",
    text: "PR #5 · You: decide on the draft",
    agentId: null,
    escalationId: null,
    ticket: "shop-app#5",
    owner: "lane:octo",
  }),
];
const N = 3;

function stub() {
  return stubFetch({
    "/api/attention": ATTENTION,
    "/api/config": CONFIG,
    "/api/repos": REPOS,
    // a seat in a session on site-builder, so the session filter below has something to narrow
    "/api/crew": {
      rows: [crewRow({ id: "sb-ta", repoId: "site-builder", sessionId: "s-site", ticket: null })],
      firstRunToday: null,
    },
    "/api/flight": { seat: SEAT, decisions: [] },
    "/api/agents/flight-1/stream": {
      runId: "f-1",
      events: [],
      truncated: false,
      lastOutputAt: null,
      reason: null,
    },
    "/api/boards/shop-app": [1, 3, 4, 5].map((n) => ticket("shop-app", n)),
    "/api/boards/site-builder": [ticket("site-builder", 2)],
    "/api/repos/shop-app/prs?linked=1": [],
    "/api/repos/site-builder/prs?linked=1": [],
    "/api/notifications": { open: [], handledToday: [] },
    "/api/flight/summary": flightSummary({ session: null }),
    "/api/flight/brief": { session: null, sections: [] },
    "/api/flight/ledger?status=open": { session: null, entries: [], more: false, nextOffset: null },
    "/api/flight/ledger?status=all": { session: null, entries: [] },
    "/api/flight/schedule": { session: null, entries: [] },
    "/api/flight/incoming": { entries: [] },
    "/api/flight/memory?repo=shop-app": { notes: [] },
    "/api/flight/memory?repo=site-builder": { notes: [] },
    "/api/drafts": [],
    "/api/drafts/history": [],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  resetSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("one Needs-you count", () => {
  it("header, dock, Comms, Board and FLIGHT all count the same set, whatever the session filter", async () => {
    stub();
    const { container } = render(
      <>
        <Header page="board" />
        <Dock />
        <Comms item={null} view={{ kind: "flight" }} />
        <BoardPage repoId={null} ticket={null} />
        <Flight />
      </>,
    );
    await screen.findByRole("button", { name: /^Needs you \d/ });
    await screen.findByText("Ticket 5");

    const counts = () => {
      const header = screen.getByRole("button", { name: /^Needs you \d+:/ });
      const chat = screen.getByRole("button", { name: /^FLIGHT chat/ });
      const dock = container.querySelector("#dockWaiting .dwh")?.textContent;
      const comms = within(
        screen.getByRole("region", { name: "Decisions" }) as HTMLElement,
      ).getByRole("link", { name: /^Needs you/ }).textContent;
      const chips = container.querySelectorAll(".kcard .kyou");
      const pulse = screen
        .getByRole("button", { name: /^Needs you: \d+ decisions or replies/ })
        .querySelector(".flight-pulse-value")?.textContent;
      const clearNow = container.querySelector("#flight-clear-now + span > span")?.textContent;
      const asks = container.querySelectorAll('#askP [data-testid="ask-row"]');
      return {
        header: header.querySelector("b")?.textContent,
        chat: chat.getAttribute("aria-label"),
        dock,
        comms,
        chips: chips.length,
        pulse,
        clearNow,
        asks: asks.length,
      };
    };
    const expected = {
      header: String(N),
      chat: `FLIGHT chat, ${N} waiting on you`,
      dock: `Waiting on you · ${N}`,
      comms: `Needs you ${N}`,
      chips: N,
      pulse: String(N),
      clearNow: `${N} need you`,
      asks: N,
    };
    await waitFor(() => expect(counts()).toEqual(expected));

    // The inbox is never narrowed by the session filter: a session on site-builder hides nothing.
    act(() => setSession("s-site"));
    await waitFor(() => expect(counts()).toEqual(expected));

    // Board › Needs me selects the cards that carry a canonical item, and nothing else.
    fireEvent.click(screen.getByRole("button", { name: "Needs me" }));
    const cards = [...container.querySelectorAll<HTMLElement>(".kcard")].map((c) => c.dataset.card);
    expect(cards.sort()).toEqual(["shop-app#1", "shop-app#3", "site-builder#2"]);
  });
});
