import {
  type CrewLoop,
  FLIGHT_BRIEF_SECTIONS,
  FLIGHT_BRIEF_TITLES,
  FLIGHT_VIEW_LIMIT,
  type FlightBriefSectionKey,
  type FlightBriefView,
} from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { NOBODY_WAITING } from "../src/flight/AskedOfYou.tsx";
import { BRIEF_EMPTY, WATCH_EMPTY } from "../src/flight/Brief.tsx";
import { overturnText } from "../src/flight/conversation.ts";
import { Drafts, draftRowId, postedText } from "../src/flight/Drafts.tsx";
import { FLIGHT_NO_SEAT, type FlightDecision, type FlightView } from "../src/flight/flightTypes.ts";
import { NO_INCOMING } from "../src/flight/Incoming.tsx";
import { SUMMARY_EMPTY } from "../src/flight/Summary.tsx";
import { NO_SEATS } from "../src/flight/WorkInFlight.tsx";
import { NOTHING_LOGGED } from "../src/flight/WorkingLog.tsx";
import { rel } from "../src/fmt.ts";
import { type PersonThreadView, whereOf } from "../src/notifications.ts";
import { Flight } from "../src/pages/Flight.tsx";
import { agentPath, PAGE_PATHS } from "../src/router.ts";
import { Header } from "../src/shell/Header.tsx";
import { useItem } from "../src/shell/overlays.ts";
import { resetSession, setSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch as fetchStub } from "./fetchStub.ts";
import { flightSummary, ledgerEntry } from "./flightSummaryFixture.ts";

const stubFetch = (routes: Parameters<typeof fetchStub>[0]) =>
  fetchStub({
    "/api/repos": [],
    "/api/flight/memory?repo=shop-app": { notes: [] },
    "/api/flight/memory?repo=site-builder": { notes: [] },
    "/api/drafts": [],
    "/api/drafts/history": [],
    "/api/flight/incoming": { entries: [] },
    "/api/flight/brief": { session: null, sections: [] },
    "/api/flight/summary": flightSummary({ session: null }),
    "/api/flight/ledger?status=open": { session: null, entries: [], more: false, nextOffset: null },
    "/api/flight/ledger?status=all": { session: null, entries: [] },
    "/api/flight/schedule": { session: null, entries: [] },
    // The status strip reads it on every render of the page.
    "/api/flight": { seat: null, decisions: [] },
    ...routes,
  });

import {
  boardItem,
  brief,
  CONFIG,
  crewRow,
  HOUR,
  item,
  MIN,
  NOW,
  prView,
  REPOS,
  SESSION_CONFIG,
  seatRow,
  stoppedSeat,
} from "./fixtures.ts";
import { readStyles } from "./styles.ts";

/** The Seats table, on the Crew & board tab. */
async function findSeats(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("tab", { name: "Crew & board" }));
  return screen.findByRole("table", { name: "Seats" });
}

const KEY = `person:101:${NOW - HOUR}`;
const N = 12;
const URL = `${"https://github.com"}/octo-org/shop-app/issues/${N}`;
const thread = (over: Partial<PersonThreadView> = {}): PersonThreadView => ({
  key: KEY,
  id: "101",
  repoId: "shop-app",
  github: "octo-org/shop-app",
  subjectType: "Issue",
  number: N,
  title: "Fix the stop race",
  reason: "mention",
  reasonText: "mentioned you",
  author: "alice",
  snippet: "can you look?",
  url: URL,
  updatedAt: NOW - HOUR,
  firstSeenAt: NOW - HOUR,
  catchUp: "new",
  ...over,
});
const personItem = item({
  key: KEY,
  kind: "person",
  agentId: null,
  escalationId: null,
  ticket: null,
  url: URL,
  text: "alice mentioned you: Fix the stop race",
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  hub.clear();
  resetSession();
  window.history.replaceState(null, "", "/");
});

const decided = (id: string, at: number, over: Partial<FlightDecision> = {}): FlightDecision => ({
  id: Number(id.replace(/\D/g, "")),
  targetRunId: null,
  ref: null,
  questionId: null,
  at,
  seatId: "guido-1",
  kind: "answer",
  about: `question ${id}`,
  decision: `yes ${id}`,
  basis: `because ${id}`,
  ...over,
});
const flightView = (over: Partial<FlightView> = {}): FlightView => ({
  seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true },
  decisions: [decided("d1", NOW - 2 * HOUR), decided("d2", NOW - HOUR)],
  ...over,
});
function stubDecided(view: FlightView, extra: Record<string, unknown> = {}) {
  return stubFetch({
    "/api/flight": view,
    "/api/config": CONFIG,
    "/api/crew": { rows: [seatRow()], firstRunToday: null },
    ...extra,
  });
}

describe("What FLIGHT did: decisions", () => {
  it("lists every decision of the last day, any kind, newest first, with tag, time, about, decision and basis", async () => {
    stubDecided(
      flightView({
        decisions: [
          decided("d1", NOW - 2 * HOUR),
          decided("d2", NOW - HOUR),
          decided("d4", NOW - 30 * MIN, { kind: "brief" }),
        ],
      }),
    );
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
    const rows = await screen.findAllByTestId("decided-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("question d4");
    const second = rows[1]?.textContent ?? "";
    expect(second).toContain("GUIDO-1");
    expect(second).toContain("question d2");
    expect(second).toContain("yes d2 · because d2");
    expect(second).toMatch(/\d\d:\d\d/);
    expect(rows[2]?.textContent).toContain("question d1");
  });

  it("groups decisions by wake: a gap over ten minutes starts a new group", async () => {
    stubDecided(
      flightView({
        decisions: [
          decided("d1", NOW - 3 * HOUR),
          decided("d2", NOW - 3 * HOUR + 4 * MIN),
          decided("d3", NOW - HOUR),
        ],
      }),
    );
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
    const groups = await screen.findAllByTestId("wake-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toContain("1 decision");
    expect(groups[0]?.textContent).toContain("question d3");
    expect(groups[1]?.textContent).toContain("2 decisions");
    expect(groups[1]?.textContent).toContain("question d2");
    expect(groups[1]?.textContent).toContain("question d1");
  });

  it("filters decisions by kind, seat and text", async () => {
    stubDecided(
      flightView({
        decisions: [
          decided("d1", NOW - 5 * HOUR, { kind: "pass", seatId: "guido-1" }),
          decided("d2", NOW - 4 * HOUR, { kind: "answer", seatId: "guido-2", about: "the cache" }),
          decided("d3", NOW - 3 * HOUR, { kind: "answer", seatId: "guido-1" }),
        ],
      }),
    );
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
    expect(await screen.findAllByTestId("decided-row")).toHaveLength(3);
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), {
      target: { value: "answer" },
    });
    expect(screen.getAllByTestId("decided-row")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "Seat" }), {
      target: { value: "guido-2" },
    });
    expect(screen.getAllByTestId("decided-row")).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search decisions" }), {
      target: { value: "nothing like it" },
    });
    expect(screen.queryAllByTestId("decided-row")).toHaveLength(0);
    expect(screen.getByText("No decision matches those filters.")).toBeTruthy();
  });

  it("lists closed and reordered tickets, with the ref linked to its issue", async () => {
    stubDecided(
      flightView({
        decisions: [
          decided("d1", NOW - HOUR, {
            kind: "close",
            ref: "shop-app#7",
            about: "shop-app#7: Old (replaced by shop-app#8)",
            decision: "Closed as duplicate: https://github.com/octo-org/shop-app/issues/7",
          }),
          decided("d2", NOW - 2 * HOUR, {
            kind: "reorder",
            ref: "shop-app#2",
            about: "shop-app#2 above shop-app#1",
            decision: "Reordered queue",
          }),
        ],
      }),
    );
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
    const rows = await screen.findAllByTestId("decided-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Closed as duplicate");
    const link = rows[0]?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/issues/7");
    expect(link?.textContent).toBe("shop-app#7");
    expect(rows[1]?.textContent).toContain("Reordered queue");
  });

  it("says so when FLIGHT decided nothing in the last day", async () => {
    stubDecided(flightView({ decisions: [] }));
    const { container } = render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
    await waitFor(() =>
      expect(container.querySelector("#decidedP")?.textContent).toContain(
        "FLIGHT has decided nothing in the last 24 hours.",
      ),
    );
  });

  it("shows a dash before FLIGHT loads, and says no seat is configured with none", async () => {
    stubDecided({ seat: null, decisions: [] });
    const { container } = render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
    expect(container.querySelector("#decidedP .pb")?.textContent).toBe("—");
    await waitFor(() =>
      expect(container.querySelector("#decidedP")?.textContent).toContain(FLIGHT_NO_SEAT),
    );
  });

  it("Overturn posts the exact text, then shows You overturned it", async () => {
    const d = decided("d2", NOW - HOUR);
    const fn = stubDecided(flightView({ decisions: [d] }), {
      "POST /api/seats/flight-1/message": {},
    });
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
    fireEvent.click(await screen.findByRole("button", { name: "Overturn" }));
    expect(await screen.findByText("You overturned it")).toBeTruthy();
    const post = fn.mock.calls.find(([p]) => p === "/api/seats/flight-1/message");
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({
      text: overturnText(d, "GUIDO-1"),
    });
    expect(screen.queryByRole("button", { name: "Overturn" })).toBeNull();
  });

  it("shows a failed Overturn under the row and keeps the button", async () => {
    stubDecided(flightView({ decisions: [decided("d1", NOW - HOUR)] }), {
      "POST /api/seats/flight-1/message": () => ({ status: 409, body: { error: "seat busy" } }),
    });
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
    fireEvent.click(await screen.findByRole("button", { name: "Overturn" }));
    expect((await screen.findByRole("alert")).textContent).toBe("seat busy");
    expect(screen.getByRole("button", { name: "Overturn" })).toBeTruthy();
  });

  it("disables Overturn when FLIGHT is not live", async () => {
    stubDecided(
      flightView({
        seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "stopped", live: false },
      }),
    );
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
    const [btn] = await screen.findAllByRole("button", { name: "Overturn" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("FLIGHT page", () => {
  it("without a FLIGHT seat, the brief's panels say FLIGHT is not running", async () => {
    stubFetch({
      "/api/flight/brief": { session: null, sections: [] },
      "/api/attention": [],
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    for (const selector of [".flight-strip-headline", "#watchP"]) {
      await waitFor(() =>
        expect(container.querySelector(selector)?.textContent, selector).toContain(FLIGHT_NO_SEAT),
      );
    }
    expect(container.querySelector("#draftsP")?.textContent).toContain("No drafts to send.");
  });

  it("Seats says no seats are configured when the crew has none", async () => {
    stubFetch({ "/api/crew": { rows: [], firstRunToday: null }, "/api/config": CONFIG });
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "Crew & board" }));
    expect(await screen.findByText(NO_SEATS)).toBeTruthy();
  });

  it("Seats lists an observed loop, marked as one, with its ticket", async () => {
    stubFetch({ "/api/crew": { rows: [crewRow()], firstRunToday: null }, "/api/config": CONFIG });
    render(<Flight />);
    const list = await findSeats();
    const rows = list.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("shop-app-ta");
    expect(rows[0]?.textContent).toContain("observed loop");
    expect(rows[0]?.textContent).toContain("Quote cache");
  });

  it("Seats has one row per seat: owner, state, ticket, age cells and the seat's link", async () => {
    const run = { ...(crewRow().run as NonNullable<ReturnType<typeof crewRow>["run"]>) };
    stubFetch({
      "/api/crew": {
        rows: [
          seatRow({
            run: { ...run, startedAt: NOW - 12 * MIN, branch: "feature/5-stop-race" },
            ticket: "shop-app#5",
            hudState: "running",
          }),
          seatRow({ id: "retro-1", role: "RETRO", run: { ...run, status: "ok", endedAt: NOW } }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    const list = await findSeats();
    const rows = list.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    const text = rows[0]?.textContent ?? "";
    expect(text).toContain("guido-1");
    expect(text).toContain("Running");
    expect(text).toContain("shop-app #5");
    expect(text).toContain("run #12");
    expect(rows[1]?.textContent).toContain("retro-1");
    expect(
      within(list)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "Seat",
      "Workstream",
      "Stage",
      "Stuck / waiting on",
      "FLIGHT's next action",
      "Last instruction",
    ]);
    expect(within(rows[0] as HTMLElement).getAllByRole("cell")).toHaveLength(6);
    const branch = rows[0]?.querySelector(".wif-branch") as HTMLElement;
    expect(branch.textContent).toBe("feature/5-stop-race");
    expect(branch.title).toBe("feature/5-stop-race");
    expect(container.querySelector("#wifP a")?.getAttribute("href")).toBe("/agent/guido-1");
  });

  it("Work in flight's doing line is the Overview's: the PR linked, its title, and the line as hover text", async () => {
    stubFetch({
      "/api/crew": {
        rows: [seatRow({ hudState: "idle", review: { prNumber: 166, state: "draft" } })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
      "/api/repos/shop-app/prs?linked=1": [
        prView({ number: 166, title: "Backfill the quote cache" }),
      ],
    });
    render(<Flight />);
    const list = await findSeats();
    // the ticket's title is an ellipsised span too: the doing line is the grey one
    const doing = list.querySelector("tbody tr .wif-doing") as HTMLElement;
    const line = "Draft PR #166 · Backfill the quote cache";
    await waitFor(() => expect(doing.textContent).toBe(line));
    expect(doing.title).toBe(line);
    expect(doing.querySelector("a")?.textContent).toBe("PR #166");
  });

  it("Seats keeps a stopped seat, with its state, whether its run merged or you ended it", async () => {
    stubFetch({
      "/api/crew": {
        rows: [
          stoppedSeat({ merged: true }),
          stoppedSeat({ id: "retro-1", role: "RETRO" }),
          seatRow({ id: "guido-2", hudState: "running" }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const list = await findSeats();
    expect(list.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(list.textContent).toContain("guido-1");
    expect(list.textContent).toContain("retro-1");
    expect(list.textContent).toContain("guido-2");
  });

  it("Seats shows a looped run's ticket, phase and a linked PR; a seat with no ticket shows a dash", async () => {
    const loop = { phase: "review" as const, text: "In review · PR #9", prNumber: 9, parked: null };
    stubFetch({
      "/api/crew": {
        rows: [
          seatRow({ hudState: "idle", ticket: "shop-app#5", loop }),
          seatRow({ id: "guido-2", run: null, hudState: "idle", ticket: null, loop: null }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const list = await findSeats();
    const rows = list.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    const text = rows[0]?.textContent ?? "";
    expect(text).toContain("guido-1");
    expect(text).toContain("shop-app #5");
    expect(text).toContain("In review");
    expect(text).toContain("PR #9");
    expect(rows[0]?.querySelector('a[href$="/pull/9"]')).not.toBeNull();
    expect(rows[0]?.querySelector('a[href$="/issues/5"]')).not.toBeNull();
    expect(rows[1]?.querySelector("a[href$='/issues/5']")).toBeNull();
  });

  it("Seats shows a looped run without a PR, and a blocked one as Blocked with why and since when", async () => {
    const parked = {
      phase: "parked" as const,
      text: "Blocked: needs you",
      prNumber: null,
      parked: "needs you",
      wait: "operator" as const,
    };
    stubFetch({
      "/api/crew": {
        rows: [
          seatRow({
            hudState: "blocked",
            stateSince: NOW - 90 * MIN,
            ticket: "shop-app#5",
            loop: parked,
          }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const list = await findSeats();
    expect(list.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(list.textContent).toContain("Blocked");
    expect(list.textContent).not.toContain("PR #");
    expect(list.querySelector(".wsteps .w")).not.toBeNull();
    const stuck = list.querySelector(".wif-stuck") as HTMLElement;
    expect(stuck.textContent).toContain("waiting on you: needs you");
    expect(stuck.textContent).toContain("since 1h 30m");
  });

  it("Seats says a blocked seat with no recorded reason is blocked, since when, and a dash for its stage", async () => {
    stubFetch({
      "/api/crew": {
        rows: [seatRow({ hudState: "blocked", stateSince: NOW - 5 * MIN, loop: null })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const list = await findSeats();
    expect((list.querySelector(".wif-stuck") as HTMLElement).textContent).toContain(
      "blocked · since 5m 00s ago",
    );
    expect((list.querySelector(".wif-stage") as HTMLElement).textContent).toBe("—");
  });

  it("Seats shows a paused seat as stuck with the pause's reason", async () => {
    stubFetch({
      "/api/crew": {
        rows: [
          seatRow({
            crewPause: { seats: "all", reason: "quota low", at: NOW - 10 * MIN, by: "operator" },
          }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const list = await findSeats();
    expect((list.querySelector(".wif-stuck") as HTMLElement).textContent).toContain(
      "paused: quota low",
    );
  });

  it("Seats shows FLIGHT's last message to a seat as its last instruction", async () => {
    stubFetch({
      "/api/flight": flightView({
        decisions: [
          decided("d1", NOW - 3 * HOUR, { kind: "message", seatId: "guido-1", decision: "old" }),
          decided("d2", NOW - HOUR, { kind: "message", seatId: "guido-1", decision: "rebase now" }),
          decided("d3", NOW - HOUR, { kind: "answer", seatId: "guido-1", decision: "yes" }),
        ],
      }),
      "/api/crew": { rows: [seatRow(), seatRow({ id: "guido-2" })], firstRunToday: null },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const list = await findSeats();
    const cells = [...list.querySelectorAll(".wif-said")].map((c) => c.textContent);
    await waitFor(() => expect(cells).toEqual(["rebase now", "—"]));
  });

  it("Seats keeps a seat whose loop is done, with its Done step", async () => {
    const done = { phase: "done" as const, text: "Done", prNumber: 9, parked: null };
    stubFetch({
      "/api/crew": {
        rows: [seatRow({ run: null, hudState: "idle", ticket: "shop-app#5", loop: done })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const list = await findSeats();
    expect(list.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(list.textContent).toContain("Done");
  });

  describe("Work in flight's step cells", () => {
    const aTry = (step: "working" | "ci" | "review", n: number, outcome: "pass" | "fail") => ({
      step,
      fix: false,
      n,
      startedAt: NOW - 30 * MIN,
      endedAt: NOW - 20 * MIN,
      outcome,
      reason: outcome === "fail" ? "lint" : null,
    });
    const runLoop = (tries: unknown[]) => ({
      "/api/runs/r-12/loop": {
        runId: "r-12",
        loop: null,
        events: [],
        tries,
        round: null,
        budget: null,
        review: null,
      },
    });
    const stubWith = (rows: unknown[], extra: Record<string, unknown> = {}) =>
      stubFetch({
        "/api/crew": { rows, firstRunToday: null },
        "/api/config": CONFIG,
        ...extra,
      });
    const cells = (list: HTMLElement) =>
      [...list.querySelectorAll<HTMLElement>(".wsteps .wstep")].map((c) => ({
        text: c.textContent,
        cls: c.className.replace("wstep", "").trim(),
        title: c.title,
      }));

    const profileLoop: CrewLoop = {
      phase: "ci",
      text: "Verifying",
      prNumber: null,
      parked: null,
      profile: "ticket-template",
      step: "verify",
      steps: [
        { name: "plan", phase: null },
        { name: "implement", phase: "working" },
        { name: "verify", phase: "ci" },
        { name: "review", phase: "review" },
        { name: "draft PR", phase: null },
      ],
      planned: true,
    };

    it("renders the run's five template steps and marks the current step", async () => {
      stubWith([seatRow({ hudState: "running", loop: profileLoop })]);
      render(<Flight />);
      const list = await findSeats();
      expect(cells(list)).toEqual([
        { text: "plan", cls: "d", title: "" },
        { text: "implement", cls: "d", title: "" },
        { text: "verify", cls: "c", title: "" },
        { text: "review", cls: "", title: "" },
        { text: "draft PR", cls: "", title: "" },
      ]);
      expect(list.querySelector('[aria-current="step"]')?.textContent).toBe(profileLoop.step);
    });

    it.each([false, true])(
      "counts fixes under their own step when present (%s)",
      async (ownFix) => {
        const steps = profileLoop.steps?.map((s) =>
          ownFix && s.phase === "working" ? { ...s, name: "fix" } : s,
        );
        stubWith(
          [seatRow({ loop: { ...profileLoop, steps, phase: "review", step: "review" } })],
          runLoop([
            aTry("working", 1, "pass"),
            ...(!ownFix ? [aTry("review", 1, "fail")] : []),
            { ...aTry("review", 1, "pass"), fix: true },
          ]),
        );
        render(<Flight />);
        const list = await findSeats();
        const repeated = ownFix ? "fix" : "review";
        await waitFor(() => expect(cells(list).some((c) => c.text === `${repeated}×2`)).toBe(true));
        expect(cells(list)[ownFix ? 1 : 3]?.title).toBe(`${repeated} · 2 tries`);
        expect(cells(list)[ownFix ? 3 : 1]?.text).toBe(ownFix ? "review" : "implement");
        expect(cells(list)[ownFix ? 3 : 1]?.title).toBe(ownFix ? "" : "implement · 1 try");
      },
    );

    it.each(["click", "Enter"])("opens the run's seat from a row %s", async (action) => {
      window.history.replaceState(null, "", PAGE_PATHS.flight);
      stubWith([seatRow({ id: "guido-2", loop: profileLoop })]);
      render(<Flight />);
      const list = await findSeats();
      const link = within(list).getByRole("link", { name: /^guido-2/ });
      const row = link.closest(".row") as HTMLElement;
      // A table row, not a control: only its links act.
      expect(row.tagName).toBe("TR");
      expect(row.getAttribute("role")).toBeNull();
      expect(row.getAttribute("aria-label")).toBeNull();
      expect(row.hasAttribute("tabindex")).toBe(false);
      expect(
        within(row)
          .getAllByRole("link")
          .every((el) => el.tagName === "A"),
      ).toBe(true);
      expect(row.querySelectorAll(`a[href="${agentPath("guido-2")}"]`)).toHaveLength(1);
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe(agentPath("guido-2"));
      expect(link.getAttribute("aria-label")).toBeNull();
      link.focus();
      expect(document.activeElement).toBe(link);
      if (action === "Enter") {
        expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(true);
        // jsdom does not synthesize a native anchor's Enter activation click.
        fireEvent.click(link, { detail: 0 });
      } else fireEvent.click(link);
      expect(window.location.pathname).toBe(agentPath("guido-2"));
      expect(link.tabIndex).toBe(0);
    });

    it("leaves ticket and PR links to their own destinations", async () => {
      window.history.replaceState(null, "", PAGE_PATHS.flight);
      stubWith([seatRow({ loop: { ...profileLoop, prNumber: 9 } })]);
      render(<Flight />);
      const list = await findSeats();
      const links = list.querySelectorAll<HTMLAnchorElement>('a[href^="https://github.com/"]');
      expect(links.length).toBeGreaterThanOrEqual(2);
      for (const link of links) {
        fireEvent.click(link);
        fireEvent.keyDown(link, { key: "Enter" });
        expect(window.location.pathname).toBe(PAGE_PATHS.flight);
      }
    });

    it("a run in review after two CI tries: Working and CI done, In review current, Done to do", async () => {
      const loop = {
        phase: "review" as const,
        text: "In review · PR #9",
        prNumber: 9,
        parked: null,
      };
      stubWith(
        [seatRow({ hudState: "idle", ticket: "shop-app#5", ticketTitle: "Stop the race", loop })],
        runLoop([aTry("working", 1, "pass"), aTry("ci", 1, "fail"), aTry("ci", 2, "pass")]),
      );
      render(<Flight />);
      const list = await findSeats();
      await waitFor(() => expect(cells(list)[1]?.text).toBe("CI×2"));
      expect(cells(list)).toEqual([
        { text: "Working", cls: "d", title: "Working · 1 try" },
        { text: "CI×2", cls: "d", title: "CI · 2 tries" },
        { text: "In review", cls: "c", title: "" },
        { text: "Done", cls: "", title: "" },
      ]);
      expect(list.textContent).toContain("Stop the race");
      expect(list.querySelector('a[href$="/pull/9"]')).not.toBeNull();
    });

    it("shows the marks without counts until the run's tries load", async () => {
      const loop = { phase: "ci" as const, text: "CI on abc1234", prNumber: null, parked: null };
      stubWith([seatRow({ hudState: "running", ticket: "shop-app#5", loop })]);
      render(<Flight />);
      const list = await findSeats();
      expect(cells(list)).toEqual([
        { text: "Working", cls: "d", title: "" },
        { text: "CI", cls: "c", title: "" },
        { text: "In review", cls: "", title: "" },
        { text: "Done", cls: "", title: "" },
      ]);
    });

    it("a parked run marks the step it was held at amber", async () => {
      const parked = {
        phase: "parked" as const,
        text: "Blocked: CI failed 3 times",
        prNumber: null,
        parked: "CI failed 3 times",
      };
      stubWith(
        [seatRow({ hudState: "blocked", ticket: "shop-app#5", loop: parked })],
        runLoop([aTry("working", 1, "pass"), aTry("ci", 1, "fail")]),
      );
      render(<Flight />);
      const list = await findSeats();
      await waitFor(() => expect(cells(list)[1]?.cls).toBe("w"));
      expect(cells(list).map((c) => c.cls)).toEqual(["d", "w", "", ""]);
    });

    it("keeps a row with no ticket, such as FLIGHT's seat, with no ticket reference", async () => {
      const loop = { phase: "working" as const, text: "Working", prNumber: null, parked: null };
      stubWith([
        seatRow({ id: "flight-1", ticket: null, ticketTitle: null, hudState: "running", loop }),
        seatRow({ hudState: "running", ticket: "shop-app#5", loop }),
      ]);
      render(<Flight />);
      const list = await findSeats();
      const rows = list.querySelectorAll("tbody tr");
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain("flight-1");
      expect(rows[0]?.querySelector('a[href$="/issues/5"]')).toBeNull();
      expect(rows[1]?.querySelector('a[href$="/issues/5"]')).not.toBeNull();
    });
  });

  it("Work in flight lists a seat with an active run and a loop once; a done loop with an active run stays", async () => {
    const live = crewRow().run as NonNullable<ReturnType<typeof crewRow>["run"]>;
    const loop = { phase: "working" as const, text: "Working on #5", prNumber: null, parked: null };
    const done = { phase: "done" as const, text: "Done", prNumber: 9, parked: null };
    stubFetch({
      "/api/crew": {
        rows: [
          seatRow({ run: live, hudState: "running", ticket: "shop-app#5", loop }),
          seatRow({
            id: "guido-2",
            run: live,
            hudState: "running",
            ticket: "shop-app#6",
            loop: done,
          }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const list = await findSeats();
    const rows = list.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("guido-1");
    expect(rows[1]?.textContent).toContain("guido-2");
  });

  it("Seats lists an observed loop that carries a loop once", async () => {
    const loop = { phase: "working" as const, text: "Working on #5", prNumber: null, parked: null };
    stubFetch({
      "/api/crew": { rows: [crewRow({ loop })], firstRunToday: null },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const list = await findSeats();
    expect(list.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("the session filter applies to a looped row", async () => {
    const loop = { phase: "working" as const, text: "Working on #5", prNumber: null, parked: null };
    stubFetch({
      "/api/crew": {
        rows: [seatRow({ hudState: "idle", ticket: "shop-app#5", loop })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    await findSeats();
    act(() => setSession("site-builder"));
    expect(await screen.findByText(NO_SEATS)).toBeTruthy();
    act(() => setSession("s1"));
    expect(await findSeats()).toBeTruthy();
  });

  it("Work in flight shows the doing text before the timezone has loaded", async () => {
    stubFetch({
      "/api/crew": { rows: [seatRow({ hudState: "running" })], firstRunToday: null },
      "/api/config": () => ({ status: 503, body: { error: "loading" } }),
    });
    render(<Flight />);
    const list = await findSeats();
    expect(list.textContent).toContain("run #12");
  });

  it("carries no pulse rail, tiles or timeline: the strip is one line", async () => {
    stubFetch({
      "/api/flight": flightView(),
      "/api/flight/summary": flightSummary(),
      "/api/attention": [],
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector(".flight-strip-headline")?.textContent).toContain(
        flightSummary().headline,
      ),
    );
    expect(container.querySelector(".flight-pulse")).toBeNull();
    expect(container.querySelector("#timeline")).toBeNull();
  });

  it("puts FLIGHT's next action and checkpoint on Crew & board, and the Needs you counter on its tab", async () => {
    const work = ledgerEntry({
      key: "work:3349",
      refs: ["#3349"],
      next: "Get RETRO's verdict",
      due: NOW + HOUR,
    });
    stubFetch({
      "/api/flight": flightView(),
      "/api/flight/summary": flightSummary(),
      "/api/flight/ledger?status=open": {
        session: "s1",
        entries: [work],
        more: false,
        nextOffset: null,
      },
      "/api/crew": { rows: [seatRow({ hudState: "blocked" })], firstRunToday: null },
      "/api/attention": [item({ key: "decision:release", text: "Choose a release window" })],
      "/api/notifications": { open: [], handledToday: [] },
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    await findSeats();
    expect(container.querySelector("#wifP")?.textContent).toContain("Get RETRO's verdict");
    expect(container.querySelector("#wifP")?.textContent).toContain("Checkpoint in 1h 00m");
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
    fireEvent.click(await screen.findByRole("button", { name: "Needs you: 1" }));
    expect(screen.getByRole("tab", { name: "Needs you" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect((container.querySelector("#flight-needs") as HTMLElement).hidden).toBe(false);
    expect(container.querySelector("#askP")?.textContent).toContain("Choose a release window");
  });

  describe("a delivery-board row's next action", () => {
    const openLedger = (entries: ReturnType<typeof ledgerEntry>[]) => ({
      session: "s1",
      entries,
      more: false,
      nextOffset: null,
    });
    const renderRow = async (
      row: ReturnType<typeof seatRow>,
      entries: ReturnType<typeof ledgerEntry>[],
    ) => {
      stubFetch({
        "/api/crew": { rows: [row], firstRunToday: null },
        "/api/flight/ledger?status=open": openLedger(entries),
        "/api/config": CONFIG,
      });
      const { container } = render(<Flight />);
      await findSeats();
      return container.querySelector("#wifP .wif-next") as HTMLElement;
    };

    it("is not another ticket's entry that the same seat owns", async () => {
      const next = await renderRow(seatRow({ hudState: "running", ticket: "shop-app#9" }), [
        ledgerEntry({
          key: "work:5",
          owner: "guido-1",
          refs: ["#5"],
          next: "Act on five",
          due: NOW + HOUR,
        }),
      ]);
      await waitFor(() => expect(next.textContent).toBe("Not recorded"));
      expect(next.textContent).not.toContain("Act on five");
      expect(next.textContent).not.toContain("Checkpoint");
    });

    it("is not an entry for the same number in another repo", async () => {
      // FLIGHT's `#N` refs name an issue in its session's repo (shop-app), not other-app.
      const next = await renderRow(seatRow({ hudState: "running", ticket: "other-app#9" }), [
        ledgerEntry({
          key: "work:9",
          owner: "retro-1",
          refs: ["#9"],
          next: "Act on shop-app nine",
        }),
      ]);
      await waitFor(() => expect(next.textContent).toBe("Not recorded"));
    });

    it("is the entry naming its ticket, or the owner's only entry when that names no ticket", async () => {
      const exact = await renderRow(seatRow({ hudState: "running", ticket: "shop-app#9" }), [
        ledgerEntry({ key: "work:other", owner: "guido-1", refs: [], next: "Owner's note" }),
        ledgerEntry({
          key: "work:9",
          owner: "retro-1",
          refs: ["PR #10", "#9"],
          next: "Act on nine",
        }),
      ]);
      await waitFor(() => expect(exact.textContent).toContain("Act on nine"));
      cleanup();
      hub.clear();
      const owned = await renderRow(seatRow({ hudState: "running", ticket: "shop-app#9" }), [
        ledgerEntry({
          key: "work:loose",
          owner: "guido-1",
          refs: ["PR #10"],
          next: "Owner's note",
        }),
      ]);
      await waitFor(() => expect(owned.textContent).toContain("Owner's note"));
    });
  });

  describe("the status strip", () => {
    const strip = () => screen.findByTestId("flight-strip");

    it("marks a headline over an hour old stale, and a fresh one not", async () => {
      stubFetch({
        "/api/flight": flightView(),
        "/api/flight/summary": flightSummary({ headlineAgeMin: 75 }),
        "/api/config": CONFIG,
      });
      const { unmount } = render(<Flight />);
      await waitFor(async () => expect((await strip()).textContent).toContain("1h 15m old"));
      expect((await strip()).textContent).toContain("stale");
      unmount();
      hub.clear();
      stubFetch({
        "/api/flight": flightView(),
        "/api/flight/summary": flightSummary({ headlineAgeMin: 5 }),
        "/api/config": CONFIG,
      });
      render(<Flight />);
      await waitFor(async () => expect((await strip()).textContent).toContain("5m 00s old"));
      expect((await strip()).textContent).not.toContain("stale");
    });

    it("shows Running with FLIGHT's state in words, and a dash for the wake times", async () => {
      stubFetch({ "/api/flight": flightView(), "/api/config": CONFIG });
      render(<Flight />);
      await waitFor(async () => expect((await strip()).textContent).toContain("Running"));
      expect((await strip()).textContent).toContain("waiting for a wake");
      expect((await strip()).textContent).toContain("Last wake — · next — · woken by —");
    });

    it.each([
      [
        "not live",
        flightView({
          seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: false },
        }),
        "FLIGHT is stopped.",
      ],
      ["absent", flightView({ seat: null }), FLIGHT_NO_SEAT],
    ])("says Down and why when its seat is %s, and still shows live work", async (_, view, why) => {
      stubFetch({
        "/api/flight": view,
        "/api/crew": { rows: [seatRow({ hudState: "running" })], firstRunToday: null },
        "/api/config": CONFIG,
      });
      render(<Flight />);
      await waitFor(async () => expect((await strip()).textContent).toContain("Down"));
      expect((await strip()).textContent).toContain(why);
      expect(await findSeats()).toBeTruthy();
    });

    it("says Held when the crew pause covers FLIGHT, and Crew paused beside it", async () => {
      stubFetch({
        "/api/flight": flightView(),
        "/api/settings/crew-pause": { seats: "all", reason: "quota low", at: NOW - MIN, by: "o" },
        "/api/config": CONFIG,
      });
      render(<Flight />);
      await waitFor(async () => expect((await strip()).textContent).toContain("Held"));
      expect((await strip()).textContent).toContain("crew paused: quota low");
      expect((await strip()).textContent).toContain("Crew paused");
    });

    it("says Held when FLIGHT's seat is rate-limited", async () => {
      stubFetch({
        "/api/flight": flightView({
          seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "parked", live: false },
        }),
        "/api/config": CONFIG,
      });
      render(<Flight />);
      await waitFor(async () => expect((await strip()).textContent).toContain("rate-limited"));
      expect((await strip()).textContent).toContain("Held");
      expect((await strip()).textContent).not.toContain("Down");
    });

    it("says Held, not Down, when the crew pause covers a FLIGHT seat that is no longer live", async () => {
      stubFetch({
        "/api/flight": flightView({
          seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "stopped", live: false },
        }),
        "/api/settings/crew-pause": { seats: ["flight-1"], reason: "quota low", at: NOW, by: "o" },
        "/api/config": CONFIG,
      });
      render(<Flight />);
      await waitFor(async () => expect((await strip()).textContent).toContain("Held"));
      expect((await strip()).textContent).toContain("crew paused: quota low");
      expect((await strip()).textContent).not.toContain("Down");
    });

    it("shows FLIGHT_VIEW_LIMIT decisions as a floor, and the decisions tab says the list is cut", async () => {
      const many = Array.from({ length: FLIGHT_VIEW_LIMIT }, (_, i) =>
        decided(`d${i + 1}`, NOW - (i + 1) * 20 * MIN),
      );
      stubFetch({ "/api/flight": flightView({ decisions: many }), "/api/config": CONFIG });
      render(<Flight />);
      expect(await screen.findByRole("button", { name: "decided 24 h: 100+" })).toBeTruthy();
      fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
      expect(
        screen.getByText("newest 100 shown · the hub serves no older decisions of the last 24 h"),
      ).toBeTruthy();
      expect(screen.queryByText(/100 of 100/)).toBeNull();
    });

    it("reports a failed summary while live work stays", async () => {
      stubFetch({
        "/api/flight": flightView(),
        "/api/flight/summary": () => ({ status: 500, body: { error: "Summary unavailable" } }),
        "/api/crew": { rows: [seatRow({ hudState: "running" })], firstRunToday: null },
        "/api/config": CONFIG,
      });
      render(<Flight />);
      const alert = await within(await strip()).findByRole("alert");
      expect(alert.textContent).toBe("FLIGHT summary unavailable: Summary unavailable");
      expect(await findSeats()).toBeTruthy();
    });

    it("loads with dashes, not zeros, until the data arrives", async () => {
      stubFetch({ "/api/flight": flightView(), "/api/config": CONFIG });
      render(<Flight />);
      const loading = screen.getByTestId("flight-strip");
      expect(
        within(loading).getByRole("button", { name: "FLIGHT handling: loading" }),
      ).toBeTruthy();
      expect(within(loading).getByRole("button", { name: "decided 24 h: loading" })).toBeTruthy();
      expect(await screen.findByRole("button", { name: "decided 24 h: 2" })).toBeTruthy();
    });

    it("counts the whole inbox whatever the session filter, and each counter opens its tab", async () => {
      stubFetch({
        "/api/config": SESSION_CONFIG,
        "/api/flight": flightView(),
        "/api/attention": [
          item({ key: "a" }),
          item({ key: "b", repoId: "site-builder" }),
          item({ key: "h", owner: "flight", flightTriage: "handling" }),
        ],
      });
      render(<Flight />);
      const needs = await screen.findByRole("button", { name: "Needs you: 2" });
      expect(screen.getByRole("button", { name: "FLIGHT handling: 1" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "decided 24 h: 2" })).toBeTruthy();
      act(() => setSession("site-builder-session"));
      expect(screen.getByRole("button", { name: "Needs you: 2" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "decided 24 h: 2" }));
      expect(
        screen.getByRole("tab", { name: "What FLIGHT did" }).getAttribute("aria-selected"),
      ).toBe("true");
      fireEvent.click(needs);
      expect(screen.getByRole("tab", { name: "Needs you" }).getAttribute("aria-selected")).toBe(
        "true",
      );
    });
  });

  it("counts Needs you once: the header and the strip agree, one per key", async () => {
    stubFetch({
      "/api/config": CONFIG,
      "/api/test-lock": { holder: null, waiting: [] },
      "/api/settings/away": { on: false },
      "/api/machine": { latest: null },
      "/api/limits": [],
      "/api/attention": [
        item({ key: "a", text: "Same words" }),
        item({ key: "a", text: "Same words" }),
        item({ key: "b", text: "Same words" }),
        item({ key: "c", text: "FLIGHT's to clear", owner: "flight" }),
      ],
    });
    render(
      <>
        <Header page="flight" />
        <Flight />
      </>,
    );
    expect(await screen.findByRole("button", { name: /^Needs you 2:/ })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Needs you: 2" })).toBeTruthy();
    // What FLIGHT owns is its own group, never counted as Needs you.
    expect(screen.getByRole("button", { name: "FLIGHT handling: 1" })).toBeTruthy();
    expect(screen.getByTestId("needs-line").textContent).toContain("FLIGHT's to clear");
  });
});

const briefView = (
  over: Partial<Record<FlightBriefSectionKey, { text?: string; updatedAt?: number }>> = {},
  session: string | null = "s1",
): FlightBriefView => ({
  session,
  sections: FLIGHT_BRIEF_SECTIONS.map((section) => ({
    section,
    title: FLIGHT_BRIEF_TITLES[section],
    text: over[section]?.text ?? "",
    updatedAt: over[section]?.updatedAt ?? null,
    updatedBy: null,
  })),
});

const STREAM = {
  runId: "r1",
  truncated: false,
  lastOutputAt: null,
  reason: null,
  events: [
    { id: "0:0", at: NOW - 3 * HOUR, kind: "op", text: "[Mission Control] Wake: 2 questions\n{}" },
    { id: "1:0", at: NOW - 2 * HOUR, kind: "op", text: "hi" },
    { id: "2:0", at: NOW - HOUR, kind: "msg", text: "hello" },
  ],
};

describe("FLIGHT's brief", () => {
  it("the Notebook renders only FLIGHT's four writable sections with live Markdown source", async () => {
    stubFetch({
      "/api/flight/brief": briefView({
        project: { text: "Ship the **brief**.", updatedAt: NOW - 5 * MIN },
      }),
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const secs = await screen.findAllByTestId("brief-section");
    expect(secs).toHaveLength(4);
    expect(secs.map((e) => e.querySelector("h3")?.textContent)).toEqual(
      ["project", "crew", "operator", "lessons"].map(
        (k) => FLIGHT_BRIEF_TITLES[k as FlightBriefSectionKey],
      ),
    );
    expect(secs[0]?.textContent).toContain("updated 5 min ago");
    expect(secs[0]?.querySelector(".md strong")?.textContent).toBe("brief");
    expect(secs[0]?.id).toBe("flight-note-project");
    expect(within(secs[0] as HTMLElement).getByText("Markdown source")).toBeTruthy();
    expect(secs[1]?.textContent).toContain("never updated");
    expect(secs[1]?.textContent).toContain(BRIEF_EMPTY);
  });

  it("the brief panel says FLIGHT is not running with no session", async () => {
    stubFetch({ "/api/flight/brief": briefView({}, null), "/api/config": CONFIG });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector("#briefP")?.textContent).toContain(FLIGHT_NO_SEAT),
    );
    expect(screen.queryAllByTestId("brief-section")).toHaveLength(0);
  });

  it("the system log excludes decisions because Record presents them once", async () => {
    stubDecided(flightView(), { "/api/agents/flight-1/stream": STREAM });
    const { container } = render(<Flight />);
    await waitFor(() => expect(container.querySelectorAll("#workLog .dmsg")).toHaveLength(1));
    const log = container.querySelector("#workLog") as HTMLElement;
    expect(container.querySelector("#logP .ph")?.textContent).toContain("1 entry");
    expect(log.querySelectorAll(".dmsg.hub")).toHaveLength(1);
    expect(log.querySelectorAll(".dmsg.decision")).toHaveLength(0);
    expect(log.querySelector(".dmsg.you")).toBeNull();
    expect(log.querySelector(".dmsg.flight")).toBeNull();
  });

  it("the working log is absent with no seat", async () => {
    stubDecided({ seat: null, decisions: [] });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector("#logP")?.textContent).toContain(FLIGHT_NO_SEAT),
    );
    expect(container.querySelector("#workLog")).toBeNull();
  });

  it("the working log says so when nothing is logged", async () => {
    stubDecided(flightView({ decisions: [] }), {
      "/api/agents/flight-1/stream": { ...STREAM, events: [] },
    });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector("#workLog")?.textContent).toContain(NOTHING_LOGGED),
    );
  });

  it("opens on Needs you and keeps writable context, collapsed and dated, on What FLIGHT knows", async () => {
    const updatedAt = NOW - 2 * HOUR;
    stubFetch({
      "/api/flight": flightView(),
      "/api/flight/brief": briefView({
        project: { text: "Ship the brief.", updatedAt },
        crew: { text: "Wiring the page.", updatedAt: NOW - 3 * HOUR },
      }),
      "/api/flight/summary": flightSummary(),
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector(".flight-strip-headline")?.textContent).toContain(
        flightSummary().headline,
      ),
    );
    const strip = container.querySelector(".flight-strip") as HTMLElement;
    expect(strip.textContent).not.toContain("Ship the brief.");
    expect((container.querySelector("#flight-needs") as HTMLElement).hidden).toBe(false);
    for (const id of ["did", "crew", "knows"]) {
      expect((container.querySelector(`#flight-${id}`) as HTMLElement).hidden, id).toBe(true);
    }
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT knows" }));
    expect((container.querySelector("#flight-needs") as HTMLElement).hidden).toBe(true);
    expect((container.querySelector("#flight-knows") as HTMLElement).hidden).toBe(false);
    const notes = container.querySelector("#briefP") as HTMLElement;
    const details = notes.querySelector(":scope > details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // dated while collapsed: the newest section's update time is in the summary
    expect(details.querySelector("summary")?.textContent).toContain(
      `updated ${rel(updatedAt, NOW, "UTC")}`,
    );
    expect(notes.textContent).toContain("Ship the brief.");
    expect(notes.textContent).toContain("Wiring the page.");
    // durable knowledge stays open
    expect(
      (container.querySelector("#memoryP") as HTMLElement).querySelector("details"),
    ).toBeNull();
  });

  it("What FLIGHT knows says standing orders and seat instructions are not available yet", async () => {
    stubFetch({ "/api/config": CONFIG });
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT knows" }));
    expect(screen.getByText(/^Standing orders: not available yet/)).toBeTruthy();
    expect(screen.getByText(/^Per-seat instructions: not available yet/)).toBeTruthy();
  });

  it("What FLIGHT knows opens repo memory on the session's repo", async () => {
    stubFetch({
      "/api/repos": [
        { id: "shop-app", github: "octo-org/shop-app" },
        { id: "site-builder", github: "octo-org/site-builder" },
      ],
      "/api/config": SESSION_CONFIG,
    });
    act(() => setSession("site-builder-session"));
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT knows" }));
    const select = (await screen.findByRole("combobox", { name: "Repo" })) as HTMLSelectElement;
    expect(select.value).toBe("site-builder");
  });

  it("opens What FLIGHT knows for a copied working-context section link, folded section open", async () => {
    window.history.replaceState(null, "", "/flight#flight-note-project");
    stubFetch({
      "/api/flight/brief": briefView({ project: { text: "Linked context." } }),
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect((container.querySelector("#flight-knows") as HTMLElement).hidden).toBe(false),
    );
    await waitFor(() =>
      expect((container.querySelector("#briefP details") as HTMLDetailsElement).open).toBe(true),
    );
    expect(container.querySelector("#flight-note-project")?.textContent).toContain(
      "Linked context.",
    );
  });

  it("opens Needs you with the draft in view for an away digest's draft link", async () => {
    const id = draftRowId(7, "shop-app#12");
    window.history.replaceState(null, "", `/flight#${id}`);
    stubFetch({
      "/api/drafts": [
        {
          id: 7,
          target: "shop-app#12",
          kind: "issue",
          text: "Linked reply",
          state: "pending",
          createdAt: NOW,
        },
      ],
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    expect((container.querySelector("#flight-needs") as HTMLElement).hidden).toBe(false);
    expect(screen.getByRole("tab", { name: "Needs you" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await waitFor(() => expect(document.getElementById(id)?.textContent).toContain("Linked reply"));
    expect((document.getElementById(id) as HTMLElement).closest("[hidden]")).toBeNull();
  });

  it.each([
    ["#askP", "flight-needs"],
    ["#heldP", "flight-needs"],
    ["#decidedP", "flight-did"],
    ["#logP", "flight-did"],
    ["#wifP", "flight-crew"],
    ["#ledgerP", "flight-crew"],
    ["#memoryP", "flight-knows"],
    ["#elsewhere", "flight-needs"],
  ])("a %s link opens its tab, on load and on hashchange", async (hash, panel) => {
    window.history.replaceState(null, "", `/flight${hash}`);
    stubFetch({ "/api/config": CONFIG });
    const { container, unmount } = render(<Flight />);
    expect((container.querySelector(`#${panel}`) as HTMLElement).hidden).toBe(false);
    unmount();
    window.history.replaceState(null, "", "/flight#flight-note-crew");
    const live = render(<Flight />).container;
    expect((live.querySelector("#flight-knows") as HTMLElement).hidden).toBe(false);
    act(() => {
      window.history.replaceState(null, "", `/flight${hash}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect((live.querySelector(`#${panel}`) as HTMLElement).hidden).toBe(false);
  });

  it("names the four tabs for the operator's questions, in order", async () => {
    stubFetch({ "/api/config": CONFIG });
    render(<Flight />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "01Needs you",
      "02What FLIGHT did",
      "03Crew & board",
      "04What FLIGHT knows",
    ]);
  });

  it("moves between tabs from the keyboard with one tab stop, and each panel takes focus", async () => {
    stubFetch({ "/api/config": CONFIG });
    render(<Flight />);
    const tabs = screen.getAllByRole("tab");
    const selected = () => tabs.find((t) => t.getAttribute("aria-selected") === "true");
    const stops = () => tabs.map((t) => t.tabIndex);
    expect(selected()?.id).toBe("flight-tab-needs");
    expect(stops()).toEqual([0, -1, -1, -1]);
    for (const [key, id, roving] of [
      ["ArrowRight", "flight-tab-did", [-1, 0, -1, -1]],
      ["End", "flight-tab-knows", [-1, -1, -1, 0]],
      ["ArrowRight", "flight-tab-needs", [0, -1, -1, -1]],
      ["ArrowLeft", "flight-tab-knows", [-1, -1, -1, 0]],
      ["ArrowLeft", "flight-tab-crew", [-1, -1, 0, -1]],
      ["Home", "flight-tab-needs", [0, -1, -1, -1]],
    ] as const) {
      fireEvent.keyDown(
        document.activeElement === document.body
          ? (selected() as HTMLElement)
          : (document.activeElement as HTMLElement),
        { key },
      );
      expect(selected()?.id, key).toBe(id);
      expect(document.activeElement?.id, key).toBe(id);
      expect(stops(), key).toEqual(roving);
    }
    for (const panel of screen.getAllByRole("tabpanel", { hidden: true })) {
      expect(panel.tabIndex).toBe(0);
      expect(
        document
          .getElementById(panel.getAttribute("aria-labelledby") as string)
          ?.getAttribute("aria-controls"),
      ).toBe(panel.id);
    }
  });

  it("keeps the selected tab when live data refreshes", async () => {
    stubFetch({ "/api/flight": flightView(), "/api/config": CONFIG });
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "Crew & board" }));
    act(() => hub.refetchTopic("agents"));
    act(() => hub.refetchTopic("flight"));
    await screen.findByRole("button", { name: "decided 24 h: 2" });
    expect(screen.getByRole("tab", { name: "Crew & board" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("the system log leaves out every decision: yesterday's answers and other kinds too", async () => {
    stubDecided(
      flightView({
        decisions: [
          decided("d3", NOW - 26 * HOUR),
          decided("d4", NOW - MIN, { kind: "start", about: "Started guido-1", decision: "on #5" }),
        ],
      }),
      { "/api/agents/flight-1/stream": { ...STREAM, events: [] } },
    );
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector("#workLog")?.textContent).toContain(NOTHING_LOGGED),
    );
    expect(container.querySelector("#logP .ph")?.textContent).toContain("0 entries");
    expect(container.querySelector("#workLog")?.textContent).not.toContain("question d3");
    expect(container.querySelector("#workLog")?.textContent).not.toContain("Started guido-1");
  });

  it("lists items FLIGHT is handling with its note", async () => {
    stubFetch({
      "/api/attention": [
        item({
          key: "kept",
          text: "Parked PR",
          owner: "flight",
          flightTriage: "handling",
          brief: brief({ assessment: "I asked the author to fix CI." }),
        }),
      ],
      "/api/config": CONFIG,
    });
    render(<Flight />);
    expect(await screen.findByText("FLIGHT is handling")).toBeTruthy();
    expect(await screen.findByText("I asked the author to fix CI.")).toBeTruthy();
    expect(screen.queryAllByTestId("ask-row")).toHaveLength(0);
  });

  it("does not render an empty assessment for an item FLIGHT is handling", async () => {
    stubFetch({
      "/api/attention": [
        item({
          key: "kept",
          text: "Handling",
          owner: "flight",
          flightTriage: "handling",
          brief: undefined,
        }),
      ],
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const section = await screen.findByRole("region", { name: "FLIGHT is handling" });
    expect(section.querySelector("p")).toBeNull();
  });

  it("the strip says so with an empty headline", async () => {
    stubFetch({
      "/api/flight": flightView(),
      "/api/flight/summary": flightSummary({ headline: "" }),
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector(".flight-strip-headline")?.textContent).toContain(
        SUMMARY_EMPTY,
      ),
    );
  });

  it("Asked of you lists the operator's items, with FLIGHT's take where it briefed one", async () => {
    function Probe() {
      return <span data-testid="item">{useItem() ?? "none"}</span>;
    }
    const items = [
      item({ key: "b", kind: "approval", text: "Merge b?" }),
      item({
        key: "a",
        kind: "decision",
        text: "Pick a cache",
        brief: brief({ recommendation: "Use LRU." }),
      }),
      item({ key: "c", kind: "stalled", owner: "flight" }),
    ];
    stubFetch({ "/api/attention": items, "/api/config": CONFIG });
    render(
      <>
        <Probe />
        <Flight />
      </>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Needs you" }));
    const rows = await screen.findAllByTestId("ask-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Pick a cache");
    expect(rows[0]?.textContent).toContain("FLIGHT's take:");
    expect(rows[0]?.textContent).toContain("Use LRU.");
    expect(rows[1]?.textContent).toContain("Merge b?");
    expect(rows[1]?.textContent).not.toContain("FLIGHT's take:");
    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: "Open" }));
    expect(screen.getByTestId("item").textContent).toBe("a");
  });

  it("Asked of you shows FLIGHT not triaging as one item with what waits on it listed under it (#758)", async () => {
    stubFetch({
      "/api/attention": [
        item({
          key: "flight:not-triaging",
          kind: "blocked",
          agentId: "flight-1",
          escalationId: null,
          text: "FLIGHT is not triaging: 1 waiting since 12:55. FLIGHT has not triaged them within its window.",
          notTriaging: { cause: "late", keys: ["ask:1"], since: NOW - 5 * 60_000 },
        }),
        item({
          key: "ask:1",
          kind: "question",
          escalationId: null,
          text: "GUIDO-1 asks: Which lane?",
          owner: "flight",
          flightTriage: "missed",
        }),
      ],
      "/api/config": CONFIG,
    });
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "Needs you" }));
    const row = await screen.findByTestId("not-triaging");
    expect(row.textContent).toContain("FLIGHT is not triaging: 1 waiting since 12:55.");
    // Needs you's home shows them at once; the item stays FLIGHT's, so it is no row of its own
    expect(within(row).getByText("GUIDO-1 asks: Which lane?")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Hide them" })).toBeTruthy();
    expect(screen.queryAllByTestId("ask-row")).toHaveLength(0);
    expect(screen.queryByText(NOBODY_WAITING)).toBeNull();
  });

  it("keeps person notifications out of Asked of you until FLIGHT passes them up", async () => {
    stubFetch({
      "/api/attention": [{ ...personItem, owner: "flight", flightTriage: "waiting" }],
      "/api/notifications": { open: [thread()], handledToday: [] },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    expect(await screen.findByText(NOBODY_WAITING)).toBeTruthy();
    expect(screen.queryByTestId("person-card")).toBeNull();
  });

  it("Asked of you shows a person card for each GitHub thread in Needs you, with FLIGHT's take when briefed", async () => {
    function Probe() {
      return <span data-testid="item">{useItem() ?? "none"}</span>;
    }
    const t2 = thread({
      key: "person:202:1",
      id: "202",
      author: null,
      number: 7,
      catchUp: "follow-up",
    });
    // An open thread Needs you does not hold (a digested one) is not asked of you.
    const digested = thread({ key: "person:303:1", id: "303", title: "Digested" });
    stubFetch({
      "/api/attention": [
        { ...personItem, brief: brief({ recommendation: "Reply that the fix is in review." }) },
        { ...personItem, key: t2.key, text: "Someone: thread 7" },
      ],
      "/api/notifications": { open: [thread(), t2, digested], handledToday: [] },
      "/api/config": CONFIG,
    });
    render(
      <>
        <Probe />
        <Flight />
      </>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Needs you" }));
    const cards = await screen.findAllByTestId("person-card");
    expect(cards).toHaveLength(2);
    expect(screen.queryByText(/Digested/)).toBeNull();
    const first = cards[0]?.textContent ?? "";
    for (const part of [
      "alice",
      whereOf(thread()),
      rel(NOW - HOUR, NOW, "Europe/London"),
      "New",
      "mentioned you: Fix the stop race",
      "can you look?",
      "FLIGHT'S TAKE",
      "Reply that the fix is in review.",
    ])
      expect(first).toContain(part);
    expect(
      within(cards[0] as HTMLElement)
        .getByRole("link", { name: "Open in GitHub ↗" })
        .getAttribute("href"),
    ).toBe(URL);
    const second = cards[1]?.textContent ?? "";
    expect(second).toContain("Someone");
    expect(second).toContain(whereOf(t2));
    expect(second).toContain("Follow-up");
    expect(second).not.toContain("FLIGHT'S TAKE");
    expect(screen.queryAllByTestId("ask-row")).toHaveLength(0);
    fireEvent.click(
      within(cards[0] as HTMLElement).getByRole("button", { name: "Read the brief and reply" }),
    );
    expect(screen.getByTestId("item").textContent).toBe(KEY);
  });

  it("omits the quote when a source snippet is empty", async () => {
    stubFetch({
      "/api/attention": [personItem],
      "/api/notifications": { open: [thread({ snippet: null })], handledToday: [] },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const card = await screen.findByTestId("person-card");
    expect(card.querySelector("blockquote")).toBeNull();
  });

  it("Asked of you highlights mentions and keeps the message inert", async () => {
    const snippet =
      '@CAPCOM @OctoCat <img src=x onerror="alert(1)"> @octocat-other @operator @someone @capcom';
    stubFetch({
      "/api/attention": [personItem],
      "/api/notifications": { open: [thread({ snippet })], handledToday: [] },
      "/api/config": { ...CONFIG, githubLogin: "octocat" },
    });
    render(<Flight />);
    const card = await screen.findByTestId("person-card");
    const quote = card.querySelector("blockquote") as HTMLElement;
    expect(quote.textContent).toBe(snippet);
    expect([...quote.querySelectorAll(".mention")].map((el) => el.textContent)).toEqual([
      "@CAPCOM",
      "@OctoCat",
      "@capcom",
    ]);
    expect(quote.querySelector("img")).toBeNull();
  });

  it("the Handled today footer lists each handled thread with its how", async () => {
    const h = {
      id: "9",
      repoId: "shop-app",
      number: 3,
      title: "t",
      author: "bob",
      how: "marked handled",
      at: NOW - MIN,
      firstSeenAt: NOW - HOUR,
    };
    stubFetch({
      "/api/attention": [],
      "/api/config": CONFIG,
      "/api/notifications": {
        open: [],
        handledToday: [h, { ...h, id: "8", author: null, how: "read on GitHub" }],
      },
    });
    const { container } = render(<Flight />);
    expect((await screen.findByTestId("handled-today")).textContent).toBe(
      "Handled today: bob (marked handled) · Someone (read on GitHub)",
    );
    expect(container.querySelector("#askP")?.textContent).toContain(NOBODY_WAITING);
  });

  it("Incoming renders Teams matches as Asked of you", async () => {
    stubFetch({
      "/api/repos": REPOS,
      "/api/boards/shop-app": [],
      "/api/boards/site-builder": [],
      "/api/flight/brief": briefView(),
      "/api/config": CONFIG,
      "/api/flight/incoming": {
        entries: [
          {
            id: "teams-fictional",
            source: "Teams",
            arrivalId: "fictional",
            version: "v1",
            repoId: "shop-app",
            sourceRef: {
              kind: "teams",
              url: "https://teams.microsoft.com/l/message/fictional",
            },
            arrivedAt: NOW,
            at: NOW,
            outcome: "Asked of you",
            text: "Finch: Review requested",
            detail: "Teams message",
          },
        ],
      },
      "/api/notifications": {
        open: [
          thread({
            number: null,
            message: {
              source: { kind: "teams", messageId: "fictional", revision: "v1" },
              author: "Finch",
              at: NOW,
              text: "Review requested",
              url: "https://teams.microsoft.com/l/message/fictional",
            },
          }),
        ],
        handledToday: [],
      },
    });
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "What FLIGHT did" }));
    const rows = await screen.findAllByTestId("incoming-row");
    expect(rows[0]?.textContent).toContain("Teams");
    expect(rows[0]?.textContent).toContain("Asked of you");
    expect(rows[0]?.textContent).not.toContain("GitHub");
    expect(screen.getByRole("link", { name: "Finch: Review requested" }).getAttribute("href")).toBe(
      "https://teams.microsoft.com/l/message/fictional",
    );
  });

  it("Incoming lists recorded GitHub and Board arrivals newest first", async () => {
    const old = thread({ key: "person:303:1", id: "303", updatedAt: NOW - 30 * HOUR });
    const entries = [
      {
        id: "person",
        source: "GitHub",
        arrivalId: "101",
        version: "1",
        arrivedAt: NOW - HOUR,
        at: NOW,
        outcome: "Asked of you",
        text: "alice mentioned you: Fix the stop race",
        detail: `#${N}`,
      },
      {
        id: "board",
        source: "Board",
        arrivalId: "shop-app#10",
        version: "1",
        arrivedAt: NOW - 2 * HOUR,
        at: NOW,
        outcome: "Queued",
        text: "#10",
        detail: "Waiting for a seat",
      },
    ];
    stubFetch({
      "/api/repos": REPOS,
      "/api/boards/shop-app": [
        boardItem({ issueNumber: 10, status: "Backlog", createdAt: NOW - 2 * HOUR }),
      ],
      "/api/boards/site-builder": [],
      "/api/flight/brief": briefView(),
      "/api/config": CONFIG,
      "/api/notifications": { open: [thread(), old], handledToday: [] },
      "/api/flight/incoming": { entries },
    });
    render(<Flight />);
    const rows = await screen.findAllByTestId("incoming-row");
    expect(rows).toHaveLength(2);
    const first = rows[0]?.textContent ?? "";
    expect(first).toContain("GitHub");
    expect(first).toContain("Asked of you");
    expect(first).toContain(`#${N}`);
    expect(first).toContain("alice mentioned you: Fix the stop race");
    expect(rows[1]?.textContent).toContain("#10");
    expect(rows[1]?.textContent).toContain("Queued");
  });

  it("Asked of you says nobody is waiting with no items", async () => {
    stubFetch({ "/api/attention": [], "/api/config": CONFIG });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector("#askP")?.textContent).toContain(NOBODY_WAITING),
    );
  });

  it("Incoming keeps recorded outcomes; revisit triggers and Notebook context stay distinct", async () => {
    const cards = [
      boardItem({ issueNumber: 12, status: "Backlog", createdAt: NOW - 30 * HOUR }),
      boardItem({ issueNumber: 11, status: "Refinement", createdAt: NOW - 2 * HOUR }),
      boardItem({ issueNumber: 10, status: "Backlog", createdAt: NOW - HOUR }),
      boardItem({ issueNumber: 13, status: "Ready", createdAt: NOW - HOUR }),
    ];
    stubFetch({
      "/api/repos": REPOS,
      "/api/boards/shop-app": cards,
      "/api/boards/site-builder": [],
      "/api/flight/incoming": {
        entries: [
          {
            id: "10",
            source: "Board",
            arrivalId: "shop-app#10",
            version: "1",
            arrivedAt: NOW - HOUR,
            at: NOW,
            outcome: "Queued",
            text: "#10",
            detail: "Waiting for a seat",
          },
          {
            id: "11",
            source: "Board",
            arrivalId: "shop-app#11",
            version: "1",
            arrivedAt: NOW - 2 * HOUR,
            at: NOW,
            outcome: "No action",
            text: "#11",
            detail: "Refinement needs more context",
          },
        ],
      },
      "/api/flight/brief": {
        ...briefView({ project: { text: "The cache may thrash." } }),
        watch: [
          {
            id: "cache",
            state: "info",
            title: "Cache performance",
            detail: "Observe the next run",
            catchUp: { kind: "new", line: "First check" },
            next: "Read timings",
          },
        ],
      },
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    const rows = await screen.findAllByTestId("incoming-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("#10");
    expect(rows[1]?.textContent).toContain("#11");
    expect(rows[1]?.textContent).toContain("Refinement");
    expect(rows[0]?.textContent).toContain("Queued");
    expect(rows[1]?.textContent).toContain("No action");
    await waitFor(() =>
      expect(container.querySelector("#watchP")?.textContent).toContain("Cache performance"),
    );
    expect(container.querySelector("#briefP")?.textContent).toContain("The cache may thrash.");
    expect(container.querySelector("#draftsP")?.textContent).toContain("No drafts to send.");
  });

  it("Incoming and Watch list say so when empty", async () => {
    stubFetch({
      "/api/repos": REPOS,
      "/api/boards/shop-app": [],
      "/api/boards/site-builder": [],
      "/api/flight/brief": briefView(),
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector("#incP")?.textContent).toContain(NO_INCOMING),
    );
    await waitFor(() =>
      expect(container.querySelector("#watchP")?.textContent).toContain(WATCH_EMPTY),
    );
  });
});

describe("Draft replies", () => {
  it("wraps long destinations and preserves multiline draft text on narrow screens", () => {
    const css = readStyles();
    expect(css).toMatch(/\.draft-row \.chipref\s*\{[^}]*white-space: normal/);
    expect(css).toMatch(/\.draft-row \.pre\s*\{[^}]*white-space: pre-wrap/);
    expect(css).toMatch(/\.draft-row\s*\{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.row\s*\{[^}]*flex-wrap: wrap/);
  });

  it("shows loading until both resources arrive, then the empty state", async () => {
    let resolveHistory!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/api/drafts/history"
          ? new Promise<Response>((resolve) => {
              resolveHistory = resolve;
            })
          : new Response("[]"),
      ),
    );
    render(<Drafts />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("No drafts to send.")).toBeNull();
    await act(async () => resolveHistory(new Response("[]")));
    expect(await screen.findByText("No drafts to send.")).toBeTruthy();
  });

  it.each(["/api/drafts", "/api/drafts/history"])(
    "shows failed %s responses while retaining available rows",
    async (path) => {
      let failed = false;
      stubFetch({
        "/api/drafts": () =>
          failed && path === "/api/drafts"
            ? { status: 503, body: { error: "Drafts unavailable" } }
            : {
                status: 200,
                body: [
                  {
                    id: 12,
                    target: "garden#12",
                    kind: "issue",
                    text: "Retained reply",
                    state: "pending",
                    createdAt: NOW,
                  },
                ],
              },
        "/api/drafts/history": () =>
          failed && path === "/api/drafts/history"
            ? { status: 503, body: { error: "Drafts unavailable" } }
            : { status: 200, body: [] },
      });
      render(<Drafts />);
      expect(await screen.findByText("Retained reply")).toBeTruthy();
      failed = true;
      act(() => hub.refetchTopic("flight"));
      expect((await screen.findByRole("alert")).textContent).toBe("Drafts unavailable");
      expect(screen.getByText("Retained reply")).toBeTruthy();
    },
  );

  it("renders recipient, context and faded history without active controls", async () => {
    stubFetch({
      "/api/drafts": [
        {
          id: 8,
          target: "garden#8",
          kind: "issue",
          text: "Pending reply",
          state: "pending",
          createdAt: NOW,
          to: "Garden reviewer",
          via: "GitHub",
          where: "garden#8",
          context: "Asked about the seed cache",
        },
      ],
      "/api/drafts/history": [
        {
          id: 9,
          target: "garden#9",
          kind: "pr",
          text: "Sent reply",
          state: "posted",
          createdAt: NOW,
        },
        {
          id: 10,
          target: "garden#10",
          kind: "issue",
          text: "Dropped reply",
          state: "discarded",
          createdAt: NOW,
        },
      ],
    });
    const { container } = render(<Flight />);
    expect(await screen.findByText("To Garden reviewer")).toBeTruthy();
    expect(screen.getByText("GitHub · garden#8")).toBeTruthy();
    expect(screen.getByText("Asked about the seed cache")).toBeTruthy();
    expect(await screen.findByText("Posted")).toBeTruthy();
    expect(screen.getByText("Discarded")).toBeTruthy();
    expect(screen.getByText("PR garden#9")).toBeTruthy();
    for (const row of container.querySelectorAll(".draft-row.acked")) {
      expect(row.querySelector("button, textarea")).toBeNull();
    }
    expect(container.querySelectorAll(".draft-row.acked")).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: "Needs you" }));
    expect(
      within(container.querySelector("#draftsP") as HTMLElement).getByRole("button", {
        name: "Post on GitHub",
      }),
    ).toBeTruthy();
  });

  it.each([false, true])(
    "Teams copies only and retains Copied after refresh (blocked: %s)",
    async (blocked) => {
      const writeText = vi.fn().mockImplementation(async () => {
        if (blocked) throw new Error("blocked");
      });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      let recorded = false;
      const fn = stubFetch({
        "POST /api/drafts/11/copied": () => {
          recorded = true;
          return { status: 200, body: { ok: true } };
        },
        "/api/drafts": () => ({
          status: 200,
          body: recorded
            ? []
            : [
                {
                  id: 11,
                  target: "garden#11",
                  kind: "issue",
                  text: "Teams reply",
                  state: "pending",
                  createdAt: NOW,
                  to: "Garden team",
                  via: "Teams",
                  where: "Seed channel",
                },
              ],
        }),
        "/api/drafts/history": () => ({
          status: 200,
          body: recorded
            ? [
                {
                  id: 11,
                  target: "garden#11",
                  kind: "issue",
                  text: "Teams reply",
                  state: "copied",
                  createdAt: NOW,
                  via: "Teams",
                },
              ]
            : [],
        }),
      });
      render(
        <>
          <Flight />
          <Toast />
        </>,
      );
      fireEvent.click(screen.getByRole("tab", { name: "Needs you" }));
      const button = await screen.findByRole("button", { name: "Copy for Teams" });
      button.focus();
      expect(document.activeElement).toBe(button);
      expect(screen.queryByRole("button", { name: "Post on GitHub" })).toBeNull();
      fireEvent.click(button);
      expect(
        await screen.findByText(
          blocked
            ? "Copy was blocked here; select the text and copy it."
            : "Copied. Paste it into Teams.",
        ),
      ).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith("Teams reply");
      if (!blocked) {
        expect(await screen.findByText("Copied", { selector: ".pill" })).toBeTruthy();
        act(() => hub.refetchTopic("flight"));
        await waitFor(() =>
          expect(fn.mock.calls.filter(([p]) => p === "/api/drafts").length).toBeGreaterThan(1),
        );
        expect(screen.queryByRole("button", { name: "Copy for Teams" })).toBeNull();
      }
      expect(
        fn.mock.calls.filter(([, init]) => init?.method === "POST").map(([path]) => path),
      ).toEqual(blocked ? [] : ["/api/drafts/11/copied"]);
    },
  );

  it.each([false, true])(
    "records Teams copies and refreshes history and Situation (failure: %s)",
    async (failed) => {
      const draft = {
        id: 21,
        target: "garden#21",
        kind: "issue",
        text: "Copy me",
        state: "pending",
        createdAt: NOW,
        via: "Teams",
      };
      let copied = false;
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const fn = stubFetch({
        "/api/drafts": () => ({ status: 200, body: copied ? [] : [draft] }),
        "/api/drafts/history": () => ({
          status: 200,
          body: copied
            ? [{ ...draft, state: "copied", text: "History copy", completedAt: NOW }]
            : [],
        }),
        "POST /api/drafts/21/copied": () => {
          expect(writeText).toHaveBeenCalledWith("Copy me");
          copied = !failed;
          return {
            status: failed ? 500 : 200,
            body: failed ? { error: "record failed" } : { ok: true },
          };
        },
      });
      const { container } = render(<Flight />);
      fireEvent.click(screen.getByRole("tab", { name: "Needs you" }));
      fireEvent.click(await screen.findByRole("button", { name: "Copy for Teams" }));
      if (failed) {
        expect(await screen.findByRole("alert")).toHaveProperty(
          "textContent",
          expect.stringContaining("Copy worked but couldn't be recorded"),
        );
        expect(screen.getByRole("button", { name: "Copy for Teams" })).toBeTruthy();
      } else {
        expect(await screen.findByText("History copy")).toBeTruthy();
        expect(container.querySelector(".draft-row.acked")?.textContent).toContain("Copied");
        expect(screen.queryByRole("button", { name: "Copy for Teams" })).toBeNull();
      }
      expect(
        fn.mock.calls.filter(([, init]) => init?.method === "POST").map(([path]) => path),
      ).toEqual(["/api/drafts/21/copied"]);
    },
  );

  it("shows the panel and count, and posts edited text only after Post", async () => {
    let drafts = [
      {
        id: 1,
        target: "shop-app#12",
        kind: "issue",
        text: "Prepared reply",
        createdAt: NOW,
        state: "pending",
      },
    ];
    const fn = stubFetch({
      "/api/drafts": () => ({ status: 200, body: drafts }),
      "/api/config": CONFIG,
      "POST /api/drafts/1/post": () => {
        drafts = [];
        return { status: 200, body: { ok: true } };
      },
    });
    render(
      <>
        <Flight />
        <Toast />
      </>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Needs you" }));
    expect(await screen.findByText("Prepared reply")).toBeTruthy();
    expect(screen.getByText("To shop-app#12")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Draft for shop-app#12" }), {
      target: { value: "Approved reply" },
    });
    expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Post on GitHub" }));
    expect(await screen.findByText("Posted", { selector: ".pill" })).toBeTruthy();
    expect(screen.getByText("Approved reply")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Post on GitHub" })).toBeNull();
    expect(screen.getByText(postedText("shop-app#12"))).toBeTruthy();
    const post = fn.mock.calls.find(([p]) => p === "/api/drafts/1/post");
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({ text: "Approved reply" });
  });

  it("discards a draft and displays posting failures", async () => {
    let drafts = [
      {
        id: 2,
        target: "shop-app#4",
        kind: "pr",
        text: "PR reply",
        createdAt: NOW,
        state: "pending",
      },
    ];
    stubFetch({
      "/api/drafts": () => ({ status: 200, body: drafts }),
      "POST /api/drafts/2/post": () => ({ status: 400, body: { error: "mentions are refused" } }),
      "POST /api/drafts/2/discard": () => {
        drafts = [];
        return { status: 200, body: {} };
      },
    });
    render(<Flight />);
    fireEvent.click(screen.getByRole("tab", { name: "Needs you" }));
    fireEvent.click(await screen.findByRole("button", { name: "Post on GitHub" }));
    expect((await screen.findByRole("alert")).textContent).toBe("mentions are refused");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("Discarded", { selector: ".pill" })).toBeTruthy();
    expect(screen.getByText("PR reply")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });
});
