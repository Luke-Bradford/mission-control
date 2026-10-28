import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KpiStrip } from "../src/overview/KpiStrip.tsx";
import { NeedsBanner } from "../src/overview/NeedsBanner.tsx";
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
  OVERVIEW,
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
 * The operator's items, some twice, beside items others own. The canonical set is: the #1
 * decision (listed twice), a PR on site-builder#2, an ownerless question on #3, a stall from the
 * seat running #6 (no ticket, so it rides #6's card) and that seat's question about #3 (so it rides
 * #3's card, not #6's). The #4 item is FLIGHT's and the #5 PR a work lane's: they count nowhere.
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
    key: "stall:sa-ta",
    kind: "stalled",
    text: "No output",
    agentId: "sa-ta",
    escalationId: null,
    ticket: null,
  }),
  item({
    key: "ask:7",
    kind: "question",
    text: "Should #3 wait for #6?",
    agentId: "sa-ta",
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
const N = 5;

function stub() {
  return stubFetch({
    "/api/attention": ATTENTION,
    "/api/config": CONFIG,
    "/api/repos": REPOS,
    // a seat in each session: sa-ta (s-shop) runs #6, so a session on site-builder hides #6's card
    "/api/crew": {
      rows: [
        crewRow({ id: "sb-ta", repoId: "site-builder", sessionId: "s-site", ticket: null }),
        crewRow({ id: "sa-ta", repoId: "shop-app", sessionId: "s-shop", ticket: "shop-app#6" }),
      ],
      firstRunToday: null,
    },
    "/api/overview": OVERVIEW,
    "/api/overview?session=s-site": OVERVIEW,
    "/api/flight": { seat: SEAT, decisions: [] },
    "/api/agents/flight-1/stream": {
      runId: "f-1",
      events: [],
      truncated: false,
      lastOutputAt: null,
      reason: null,
    },
    "/api/boards/shop-app": [
      ...[1, 3, 4, 5].map((n) => ticket("shop-app", n)),
      boardItem({ issueNumber: 6, title: "Ticket 6", status: "In Progress", state: "in progress" }),
    ],
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
        <NeedsBanner />
        <KpiStrip />
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
      const chips = [...container.querySelectorAll<HTMLElement>(".kcard .kyou")];
      // every canonical item here is on a card: the chips plus their "+N" account for all of them
      const onCards = chips.reduce(
        (n, c) =>
          n + 1 + Number(c.querySelector(".kyou-more")?.textContent?.replace(/\D/g, "") || 0),
        0,
      );
      const banner = container.querySelector("#nbanner .num")?.textContent;
      const kpi = container.querySelector('.overview-kpi[href="/flight#askP"] .v')?.textContent;
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
        banner,
        kpi,
        onCards,
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
      banner: String(N),
      kpi: String(N),
      onCards: N,
      pulse: String(N),
      clearNow: `${N} need you`,
      asks: N,
    };
    await waitFor(() => expect(counts()).toEqual(expected));

    // The seat's question about #3 chips #3 (with the ownerless one: "+1"), not the #6 it runs.
    const chipOf = (ref: string) =>
      container.querySelector(`[data-card="${ref}"] .kyou`)?.getAttribute("aria-label");
    expect(chipOf("shop-app#3")).toBe(
      "You: answer · waiting 3 hours, and 1 more. Opens its brief.",
    );
    expect(chipOf("shop-app#6")).toBe("You: check · waiting 3 hours. Opens its brief.");

    // Board › Needs me selects the cards that carry a canonical item, and nothing else.
    fireEvent.click(screen.getByRole("button", { name: "Needs me" }));
    const cards = () =>
      [...container.querySelectorAll<HTMLElement>(".kcard")].map((c) => c.dataset.card).sort();
    expect(cards()).toEqual(["shop-app#1", "shop-app#3", "shop-app#6", "site-builder#2"]);

    // The inbox is never narrowed by the session filter; the Board is, so #6 (run in s-shop) goes.
    act(() => setSession("s-site"));
    await waitFor(() => expect(cards()).toEqual(["shop-app#1", "shop-app#3", "site-builder#2"]));
    const { onCards: _onCards, ...inbox } = expected;
    const { onCards, ...now } = counts();
    expect(now).toEqual(inbox);
    expect(onCards).toBe(N - 1);
  });
});
