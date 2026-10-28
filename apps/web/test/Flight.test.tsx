import { readFileSync } from "node:fs";
import {
  type CrewLoop,
  FLIGHT_BRIEF_SECTIONS,
  FLIGHT_BRIEF_TITLES,
  type FlightBriefSectionKey,
  type FlightBriefView,
} from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { NOBODY_WAITING } from "../src/flight/AskedOfYou.tsx";
import { BRIEF_EMPTY, WATCH_EMPTY } from "../src/flight/Brief.tsx";
import { overturnText } from "../src/flight/conversation.ts";
import { Drafts, postedText } from "../src/flight/Drafts.tsx";
import { FLIGHT_NO_SEAT, type FlightDecision, type FlightView } from "../src/flight/flightTypes.ts";
import { NO_INCOMING } from "../src/flight/Incoming.tsx";
import { SUMMARY_EMPTY } from "../src/flight/Summary.tsx";
import { NO_CREW_RUNS } from "../src/flight/WorkInFlight.tsx";
import { NOTHING_LOGGED } from "../src/flight/WorkingLog.tsx";
import { rel } from "../src/fmt.ts";
import { type PersonThreadView, whereOf } from "../src/notifications.ts";
import { Flight } from "../src/pages/Flight.tsx";
import { agentPath, PAGE_PATHS } from "../src/router.ts";
import { useItem } from "../src/shell/overlays.ts";
import { resetSession, setSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch as fetchStub } from "./fetchStub.ts";
import { flightSummary, ledgerEntry, summaryItem } from "./flightSummaryFixture.ts";

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
  seatRow,
  stoppedSeat,
} from "./fixtures.ts";

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

describe("Decided without you", () => {
  it("lists today's answers newest first with tag, time, about, decision and basis, and no kind pill", async () => {
    stubDecided(
      flightView({
        decisions: [
          decided("d1", NOW - 2 * HOUR),
          decided("d2", NOW - HOUR),
          decided("d3", NOW - 26 * HOUR),
          decided("d4", NOW - HOUR, { kind: "brief" }),
        ],
      }),
    );
    render(<Flight />);
    const rows = await screen.findAllByTestId("decided-row");
    expect(rows).toHaveLength(2);
    const first = rows[0]?.textContent ?? "";
    expect(first).toContain("GUIDO-1");
    expect(first).toContain("question d2");
    expect(first).toContain("yes d2 · because d2");
    expect(first).toMatch(/\d\d:\d\d/);
    expect(first).not.toContain("Answered");
    expect(rows[1]?.textContent).toContain("question d1");
  });

  it("says so when nothing was decided without you today", async () => {
    stubDecided(flightView({ decisions: [decided("d1", NOW - 2 * HOUR, { kind: "pass" })] }));
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector("#decidedP")?.textContent).toContain(
        "Nothing decided without you today.",
      ),
    );
  });

  it("shows a dash before FLIGHT loads, and says no seat is configured with none", async () => {
    stubDecided({ seat: null, decisions: [] });
    const { container } = render(<Flight />);
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
    fireEvent.click(screen.getByRole("tab", { name: "Record" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "Record" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "Record" }));
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
    for (const id of ["sitP", "watchP"]) {
      await waitFor(() =>
        expect(container.querySelector(`#${id}`)?.textContent, id).toContain(FLIGHT_NO_SEAT),
      );
    }
    expect(container.querySelector("#draftsP")?.textContent).toContain("No drafts to send.");
  });

  it("Work in flight is empty without crew runs, and does not list loops", async () => {
    stubFetch({ "/api/crew": { rows: [crewRow()], firstRunToday: null }, "/api/config": CONFIG });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector("#wifP")?.textContent).toContain(
        "No crew runs. Start a seat from a ticket on the Board.",
      ),
    );
    expect(container.querySelector("#wifP")?.textContent).not.toContain("shop-app-ta");
  });

  it("Work in flight has one row per active crew run", async () => {
    const run = { ...(crewRow().run as NonNullable<ReturnType<typeof crewRow>["run"]>) };
    stubFetch({
      "/api/crew": {
        rows: [
          crewRow(),
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
    const list = await screen.findByRole("list", { name: "Crew runs" });
    const rows = list.querySelectorAll("li");
    expect(rows).toHaveLength(1);
    const text = rows[0]?.textContent ?? "";
    expect(text).toContain("guido-1");
    expect(text).toContain("Running");
    expect(text).toContain("shop-app #5");
    expect(text).toContain("12m 00s");
    expect(text).toContain("run #12");
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
    const list = await screen.findByRole("list", { name: "Crew runs" });
    // the ticket's title is an ellipsised span too: the doing line is the grey one
    const doing = list.querySelector("li .wif-doing") as HTMLElement;
    const line = "Draft PR #166 · Backfill the quote cache";
    await waitFor(() => expect(doing.textContent).toBe(line));
    expect(doing.title).toBe(line);
    expect(doing.querySelector("a")?.textContent).toBe("PR #166");
  });

  it("Work in flight leaves out stopped seats, whether their run merged or you ended it", async () => {
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
    const list = await screen.findByRole("list", { name: "Crew runs" });
    expect(list.textContent).toContain("guido-2");
    expect(list.textContent).not.toContain("guido-1");
    expect(list.textContent).not.toContain("retro-1");
    expect(list.textContent).not.toContain("Run ended");
  });

  it("Work in flight has a row per looped run: ticket, phase and a linked PR", async () => {
    const loop = { phase: "review" as const, text: "In review · PR #9", prNumber: 9, parked: null };
    stubFetch({
      "/api/crew": {
        rows: [
          seatRow({ hudState: "idle", ticket: "shop-app#5", loop }),
          seatRow({ id: "guido-2", run: null, hudState: "idle", ticket: "shop-app#6", loop: null }),
        ],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const list = await screen.findByRole("list", { name: "Crew runs" });
    const rows = list.querySelectorAll("li");
    expect(rows).toHaveLength(1);
    const text = rows[0]?.textContent ?? "";
    expect(text).toContain("guido-1");
    expect(text).toContain("shop-app #5");
    expect(text).toContain("In review");
    expect(text).toContain("PR #9");
    expect(rows[0]?.querySelector('a[href$="/pull/9"]')).not.toBeNull();
    expect(rows[0]?.querySelector('a[href$="/issues/5"]')).not.toBeNull();
  });

  it("Work in flight shows a looped run without a PR, and a blocked one as Blocked", async () => {
    const parked = {
      phase: "parked" as const,
      text: "Blocked: needs you",
      prNumber: null,
      parked: "needs you",
    };
    stubFetch({
      "/api/crew": {
        rows: [seatRow({ hudState: "blocked", ticket: "shop-app#5", loop: parked })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    const list = await screen.findByRole("list", { name: "Crew runs" });
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(list.textContent).toContain("Blocked");
    expect(list.textContent).not.toContain("PR #");
    expect(list.querySelector(".wsteps .w")).not.toBeNull();
  });

  it("Work in flight leaves out a looped run whose loop is done", async () => {
    const done = { phase: "done" as const, text: "Done", prNumber: 9, parked: null };
    stubFetch({
      "/api/crew": {
        rows: [seatRow({ run: null, hudState: "idle", ticket: "shop-app#5", loop: done })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    expect(await screen.findByText(NO_CREW_RUNS)).toBeTruthy();
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
      const list = await screen.findByRole("list", { name: "Crew runs" });
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
        const list = await screen.findByRole("list", { name: "Crew runs" });
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
      const list = await screen.findByRole("list", { name: "Crew runs" });
      const link = within(list).getByRole("link", { name: /^guido-2/ });
      const row = link.closest(".row") as HTMLElement;
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
      const list = await screen.findByRole("list", { name: "Crew runs" });
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
      const list = await screen.findByRole("list", { name: "Crew runs" });
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
      const list = await screen.findByRole("list", { name: "Crew runs" });
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
      const list = await screen.findByRole("list", { name: "Crew runs" });
      await waitFor(() => expect(cells(list)[1]?.cls).toBe("w"));
      expect(cells(list).map((c) => c.cls)).toEqual(["d", "w", "", ""]);
    });

    it("leaves out a row with no ticket, such as FLIGHT's seat", async () => {
      const loop = { phase: "working" as const, text: "Working", prNumber: null, parked: null };
      stubWith([
        seatRow({ id: "flight-1", ticket: null, ticketTitle: null, hudState: "running", loop }),
        seatRow({ hudState: "running", ticket: "shop-app#5", loop }),
      ]);
      render(<Flight />);
      const list = await screen.findByRole("list", { name: "Crew runs" });
      expect(list.querySelectorAll("li")).toHaveLength(1);
      expect(list.textContent).not.toContain("flight-1");
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
    const list = await screen.findByRole("list", { name: "Crew runs" });
    const rows = list.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("guido-1");
    expect(rows[1]?.textContent).toContain("guido-2");
  });

  it("Work in flight does not list an observed loop that carries a loop", async () => {
    const loop = { phase: "working" as const, text: "Working on #5", prNumber: null, parked: null };
    stubFetch({
      "/api/crew": { rows: [crewRow({ loop })], firstRunToday: null },
      "/api/config": CONFIG,
    });
    render(<Flight />);
    expect(await screen.findByText(NO_CREW_RUNS)).toBeTruthy();
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
    await screen.findByRole("list", { name: "Crew runs" });
    act(() => setSession("site-builder"));
    expect(await screen.findByText(NO_CREW_RUNS)).toBeTruthy();
    act(() => setSession("s1"));
    expect(await screen.findByRole("list", { name: "Crew runs" })).toBeTruthy();
  });

  it("Work in flight shows the doing text before the timezone has loaded", async () => {
    stubFetch({
      "/api/crew": { rows: [seatRow({ hudState: "running" })], firstRunToday: null },
      "/api/config": () => ({ status: 503, body: { error: "loading" } }),
    });
    render(<Flight />);
    const list = await screen.findByRole("list", { name: "Crew runs" });
    expect(list.textContent).toContain("run #12");
  });

  it("does not duplicate Board counts, metrics or future schedule in Command", async () => {
    stubFetch({
      "/api/flight/summary": flightSummary(),
      "/api/attention": [],
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector("#sitP .sittext")?.textContent).toBe(flightSummary().headline),
    );
    expect(container.querySelector("#sitP .sitstats")).toBeNull();
    expect(container.querySelector("#sitP #timeline")).toBeNull();
    expect(container.querySelector("#sitP .flight-tiles")).toBeNull();
  });

  it("puts the live stand-up, next commitment and investigation on Command", async () => {
    const next = ledgerEntry({
      kind: "commitment",
      key: "commitment:release",
      title: "Prepare the release",
      next: "Confirm the migration window",
      due: NOW + 2 * HOUR,
    });
    const watch = ledgerEntry({
      kind: "watch",
      key: "watch:cache",
      title: "Spike cache pressure",
      next: "Compare the next load run",
    });
    const work = ledgerEntry({
      key: "work:5",
      refs: ["#5"],
      next: "Get RETRO's verdict",
      due: NOW + HOUR,
    });
    stubFetch({
      "/api/flight": flightView(),
      "/api/flight/summary": flightSummary({ next: [summaryItem(next)] }),
      "/api/flight/ledger?status=open": {
        session: "s1",
        entries: [work, watch, next],
        more: false,
        nextOffset: null,
      },
      "/api/crew": {
        rows: [seatRow({ hudState: "blocked" })],
        firstRunToday: null,
      },
      "/api/attention": [item({ key: "decision:release", text: "Choose a release window" })],
      "/api/notifications": { open: [], handledToday: [] },
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    const pulses = () => [...container.querySelectorAll(".flight-pulse")];
    await waitFor(() =>
      expect(
        pulses()
          .find((pulse) => pulse.querySelector(".flight-pulse-label")?.textContent === "Blocked")
          ?.querySelector(".flight-pulse-value")?.textContent,
      ).toBe("1"),
    );
    expect(container.querySelector("#wifP")?.textContent).toContain("Get RETRO's verdict");
    expect(container.querySelector("#wifP")?.textContent).toContain("Checkpoint in 1h 00m");
    expect(container.querySelector("#controlP")?.textContent).toContain("Choose a release window");
    expect(container.querySelector("#controlP")?.textContent).toContain("Prepare the release");
    expect(container.querySelector("#controlP")?.textContent).toContain("Spike cache pressure");
    fireEvent.click(screen.getByRole("button", { name: "Needs you: 1 decisions or replies" }));
    expect(window.location.pathname).toBe(PAGE_PATHS.comms);
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
  it.each([
    {
      name: "awaiting a reply",
      events: [{ id: "1:0", at: NOW - HOUR, kind: "op", text: "Did you see the blocker?" }],
      state: "Awaiting reply",
      latest: "You: Did you see the blocker?",
    },
    {
      name: "replied after the operator's message",
      events: STREAM.events,
      state: "Reply received",
      latest: "FLIGHT: hello",
    },
  ])("shows contact as $name", async ({ events, state, latest }) => {
    stubFetch({
      "/api/flight": flightView(),
      "/api/agents/flight-1/stream": { ...STREAM, events },
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector(".flight-contact")?.textContent).toContain(state),
    );
    expect(container.querySelector(".flight-contact")?.textContent).toContain(latest);
  });

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
    const log = container.querySelector("#workLog") as HTMLDetailsElement;
    expect(log.tagName).toBe("DETAILS");
    expect(log.open).toBe(false);
    expect(log.querySelector("summary")?.textContent).toContain("1 entry");
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

  it("opens on Command and keeps writable context in Notebook", async () => {
    stubFetch({
      "/api/flight/brief": briefView({
        project: { text: "Ship the brief." },
        crew: { text: "Wiring the page." },
      }),
      "/api/flight/summary": flightSummary(),
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector("#sitP .sittext")?.textContent).toBe(flightSummary().headline),
    );
    const situation = container.querySelector("#sitP") as HTMLElement;
    expect(situation.textContent).not.toContain("Ship the brief.");
    expect(situation.textContent).not.toContain("Wiring the page.");
    expect((container.querySelector("#flight-command") as HTMLElement).hidden).toBe(false);
    expect((container.querySelector("#flight-queue") as HTMLElement).hidden).toBe(true);
    expect((container.querySelector("#flight-notebook") as HTMLElement).hidden).toBe(true);
    expect((container.querySelector("#flight-record") as HTMLElement).hidden).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Notebook" }));
    expect((container.querySelector("#flight-command") as HTMLElement).hidden).toBe(true);
    expect((container.querySelector("#flight-notebook") as HTMLElement).hidden).toBe(false);
    const notes = container.querySelector("#briefP") as HTMLElement;
    const memory = container.querySelector("#memoryP") as HTMLElement;
    expect(notes.querySelector(":scope > details")).toBeNull();
    expect(memory.querySelector("details")).toBeNull();
    expect(notes.textContent).toContain("Ship the brief.");
    expect(notes.textContent).toContain("Wiring the page.");
  });

  it("opens Notebook for a copied working-context section link", async () => {
    window.history.replaceState(null, "", "/flight#flight-note-project");
    stubFetch({
      "/api/flight/brief": briefView({ project: { text: "Linked context." } }),
      "/api/config": CONFIG,
    });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect((container.querySelector("#flight-notebook") as HTMLElement).hidden).toBe(false),
    );
    expect(container.querySelector("#flight-note-project")?.textContent).toContain(
      "Linked context.",
    );
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

  it("Situation says so with an empty headline", async () => {
    stubFetch({ "/api/flight/summary": flightSummary({ headline: "" }), "/api/config": CONFIG });
    const { container } = render(<Flight />);
    await waitFor(() =>
      expect(container.querySelector("#sitP .sittext")?.textContent).toBe(SUMMARY_EMPTY),
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
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
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

  it("Asked of you shows a person card for each open GitHub thread, with FLIGHT's take when briefed", async () => {
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
    stubFetch({
      "/api/attention": [
        { ...personItem, brief: brief({ recommendation: "Reply that the fix is in review." }) },
      ],
      "/api/notifications": { open: [thread(), t2], handledToday: [] },
      "/api/config": CONFIG,
    });
    render(
      <>
        <Probe />
        <Flight />
      </>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    const cards = await screen.findAllByTestId("person-card");
    expect(cards).toHaveLength(2);
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
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
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
    const css = readFileSync(new globalThis.URL("../src/hud.css", import.meta.url), "utf8");
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
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
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
      fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
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
      fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Post on GitHub" }));
    expect((await screen.findByRole("alert")).textContent).toBe("mentions are refused");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("Discarded", { selector: ".pill" })).toBeTruthy();
    expect(screen.getByText("PR reply")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });
});
