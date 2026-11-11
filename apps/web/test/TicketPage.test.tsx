import type { CommsSenderKind, TicketEvent, TicketHistory, TicketQuestion } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { TicketPage } from "../src/pages/TicketPage.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";
import { ticketQaReportFixture } from "./qaReportFixture.ts";

afterEach(() => vi.unstubAllGlobals());

const GH = "https://github.com/octo-org/shop-app/issues/3349";
const PATH = "/api/tickets/shop-app/3349";

const history = (over: Partial<TicketHistory> = {}): TicketHistory => ({
  repoId: "shop-app",
  number: 3349,
  url: GH,
  title: "Quote cache",
  state: "open",
  status: "In progress",
  priority: "p1",
  size: "M",
  labels: ["perf", "type:feature"],
  outcome: "Quotes load from the cache.",
  doneWhen: [
    { text: "Cache hit is under 5 ms", checked: true },
    { text: "Eviction is tested", checked: false },
  ],
  body: "## Outcome\nQuotes load from the cache.",
  bodyTruncated: false,
  githubError: null,
  runs: [],
  prs: [
    {
      number: 40,
      title: "cache it",
      url: "https://github.com/octo-org/shop-app/pull/40",
      branch: "feature/3349-cache",
      state: "open",
      isDraft: false,
      headSha: "abcdef1234567",
      createdAt: 1_000,
      mergedAt: null,
      rounds: [
        {
          reviewId: 7,
          round: 1,
          sha: "abcdef1234567",
          state: "done",
          verdict: "changes" as never,
          summary: null,
          blocking: 1,
          minor: 0,
          at: 5_000,
          findings: [
            {
              pos: 1,
              severity: "Important",
              file: "src/cache.ts",
              line: 12,
              summary: "Evicts the wrong key",
              scenario: "s",
              fix: "f",
              state: "open",
              resolution: null,
              resolvedInReviewId: null,
            },
          ],
        },
      ],
      ci: [],
    },
  ],
  timeline: [
    {
      key: "k5",
      at: 6_000,
      kind: "comms",
      id: "c1",
      from: "flight-1",
      to: "inco-1",
      label: null,
      text: "Please <b>start</b>",
    },
    {
      key: "k4",
      at: 5_000,
      kind: "review",
      prNumber: 40,
      reviewId: 7,
      round: 1,
      state: "done",
      blocking: 1,
      minor: 0,
    },
    {
      key: "k3",
      at: 4_000,
      kind: "ci",
      prNumber: 40,
      sha: "abcdef1234567",
      passing: 3,
      failing: 1,
      pending: 0,
    },
    {
      key: "k2",
      at: 3_000,
      kind: "decision",
      id: 9,
      decisionKind: "start",
      about: "shop-app#3349",
      decision: "Start it",
      basis: "ready",
    },
    {
      key: "k1",
      at: 2_000,
      kind: "run",
      runId: "r1",
      seat: "inco-1",
      status: "ok",
      phase: "build",
    },
  ] as TicketEvent[],
  nextBefore: null,
  ...over,
});

const show = (body: unknown, status = 200) => {
  const fn = stubFetch({
    "/api/config": CONFIG,
    [PATH]: () => ({ status, body }),
  });
  render(<TicketPage repoId="shop-app" number={3349} />);
  return fn;
};

describe("TicketPage", () => {
  it("shows the form fields, the timeline and one GitHub link", async () => {
    show(history());
    await screen.findByRole("heading", { name: "Quote cache" });
    const form = screen.getByRole("region", { name: "Ticket" });
    expect(within(form).getByText("Quotes load from the cache.")).toBeTruthy();
    expect(within(form).getByText("In progress")).toBeTruthy();
    expect(within(form).getByText("p1")).toBeTruthy();
    expect(within(form).getByText("M")).toBeTruthy();
    const list = within(form).getByRole("list", { name: "Done when" });
    expect(
      within(list)
        .getByText(/Cache hit is under 5 ms/)
        .closest("li")?.textContent,
    ).toMatch(/done/i);
    expect(
      within(list)
        .getByText(/Eviction is tested/)
        .closest("li")?.textContent,
    ).toMatch(/open/i);
    const tl = screen.getByRole("region", { name: "Timeline" });
    expect(tl.querySelectorAll(".tk-event")).toHaveLength(6);
    // comms text is inert text, not HTML
    // shown in the line and again whole under "Full text"
    expect(within(tl).getAllByText(/Please <b>start<\/b>/)).toHaveLength(2);
    expect(tl.querySelector("b")).toBeNull();
    expect(within(tl).getByText(/3 passing, 1 failing, 0 pending/)).toBeTruthy();
    expect(within(tl).getByText(/1 blocking, 0 minor/)).toBeTruthy();
    expect(within(tl).getByText(/Evicts the wrong key/)).toBeTruthy();
    const gh = screen.getAllByRole("link", { name: /View on GitHub/ });
    expect(gh).toHaveLength(1);
    expect(gh[0]?.getAttribute("href")).toBe(GH);
  });

  it("says loading while the ticket loads", () => {
    stubFetch({ "/api/config": CONFIG, [PATH]: () => ({ status: 200, body: history() }) });
    render(<TicketPage repoId="shop-app" number={3349} />);
    expect(screen.getByText("Loading ticket…")).toBeTruthy();
  });

  it("says why it failed, and offers a retry", async () => {
    show({ error: "boom" }, 500);
    expect(await screen.findByText(/Could not load the ticket: boom/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says the ticket is not found on a 404", async () => {
    show({ error: "unknown issue" }, 404);
    expect(await screen.findByText(/shop-app#3349 is not a ticket/)).toBeTruthy();
  });

  it("says the crew has not touched an empty timeline, and shows an unreachable GitHub", async () => {
    show(
      history({ timeline: [], prs: [], body: null, outcome: null, githubError: "rate limited" }),
    );
    await screen.findByRole("heading", { name: "Quote cache" });
    expect(screen.getByText("The crew has not touched this ticket yet.")).toBeTruthy();
    expect(screen.getByText(/GitHub could not be reached: rate limited/)).toBeTruthy();
    expect(screen.getByText("The ticket body is not available.")).toBeTruthy();
  });

  it("loads older events with the cursor and keeps what it had", async () => {
    const older: TicketEvent = {
      key: "k0",
      at: 1_000,
      kind: "run",
      runId: "r0",
      seat: "inco-1",
      status: "failed",
      phase: null,
    };
    const fn = stubFetch({
      "/api/config": CONFIG,
      [PATH]: history({ nextBefore: "CUR" }),
      [`${PATH}?before=CUR`]: history({ timeline: [older], nextBefore: null }),
    });
    render(<TicketPage repoId="shop-app" number={3349} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    await waitFor(() => expect(document.querySelectorAll(".tk-event").length).toBe(7));
    expect(fn).toHaveBeenCalledWith(`${PATH}?before=CUR`, expect.anything());
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    const items = [
      ...screen.getByRole("region", { name: "Timeline" }).querySelectorAll(".tk-event"),
    ];
    expect(items).toHaveLength(7);
    expect(items[6]?.textContent).toMatch(/failed/);
  });

  it("keeps events that slide out of the live window after Load older", async () => {
    const msg = (n: number): TicketEvent => ({
      key: `m${String(n).padStart(3, "0")}`,
      at: n * 1000,
      kind: "comms",
      id: `c${n}`,
      from: "a",
      to: "b",
      label: null,
      text: `msg ${n}`,
    });
    const range = (hi: number, lo: number) =>
      Array.from({ length: hi - lo + 1 }, (_, i) => msg(hi - i));
    let live = history({ prs: [], timeline: range(60, 11), nextBefore: "CUR" });
    stubFetch({
      "/api/config": CONFIG,
      [PATH]: () => ({ status: 200, body: live }),
      [`${PATH}?before=CUR`]: history({ prs: [], timeline: range(10, 1), nextBefore: null }),
    });
    render(<TicketPage repoId="shop-app" number={3349} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    await waitFor(() => expect(document.querySelectorAll(".tk-event").length).toBe(60));
    live = history({ prs: [], timeline: range(63, 14), nextBefore: "CUR" });
    await act(async () => {
      hub.refetch(RESOURCES.ticketHistory("shop-app", 3349).path);
    });
    await waitFor(() => expect(document.querySelectorAll(".tk-event").length).toBe(63));
    expect(screen.getAllByText(/msg 12$/).length).toBeGreaterThan(0);
  });

  it("words a finding by how it ended, not by its severity bucket", async () => {
    const base = history();
    const round = (base.prs[0] as TicketHistory["prs"][number]).rounds[0] as never as {
      findings: unknown[];
    };
    round.findings = [
      {
        pos: 1,
        severity: "Important",
        file: "a.ts",
        line: 1,
        summary: "fixed one",
        scenario: "",
        fix: "",
        state: "open",
        resolution: "fixed",
        resolvedInReviewId: 8,
      },
      {
        pos: 2,
        severity: "Minor",
        file: "b.ts",
        line: 2,
        summary: "fresh minor",
        scenario: "",
        fix: "",
        state: "logged",
        resolution: null,
        resolvedInReviewId: null,
      },
    ];
    show(base);
    await screen.findByText(/fixed one/);
    expect(screen.getByText(/fixed one/).closest("li")?.textContent).toMatch(/\(fixed\)/);
    const fresh = screen.getByText(/fresh minor/).closest("li")?.textContent ?? "";
    expect(fresh).not.toMatch(/resolved/);
    expect(fresh).toMatch(/logged in the PR/);
  });

  it("shows PR opened and merged in the timeline", async () => {
    const base = history();
    show({
      ...base,
      prs: [
        {
          ...(base.prs[0] as TicketHistory["prs"][number]),
          createdAt: 2_500,
          mergedAt: 6_500,
          state: "merged",
        },
      ],
    });
    const tl = await screen.findByRole("region", { name: "Timeline" });
    expect(within(tl).getByText(/PR #40 opened: cache it/)).toBeTruthy();
    expect(within(tl).getByText(/PR #40 merged: cache it/)).toBeTruthy();
  });

  it("holds the whole of a long Comms text in a details element", async () => {
    const long = "word ".repeat(200).trim();
    const base = history();
    show({
      ...base,
      timeline: [{ ...(base.timeline[0] as TicketEvent), text: long } as TicketEvent],
    });
    const tl = await screen.findByRole("region", { name: "Timeline" });
    const more = tl.querySelector("details.tk-more");
    expect(more?.querySelector(".tk-text")?.textContent).toBe(long);
  });
});

it("a closed ticket exposes QA for a live closing PR before it reaches the local collector", async () => {
  const r = ticketQaReportFixture();
  stubFetch({
    "/api/config": CONFIG,
    [PATH]: history({
      state: "closed",
      prs: [],
      linkedPullRequests: [
        {
          number: 40,
          title: "cache it",
          url: "https://github.com/octo-org/shop-app/pull/40",
          state: "merged",
          repoId: "shop-app",
        },
      ],
      timeline: [],
    }),
    "/api/qa-reports?repoId=shop-app&prNumber=40": { reports: [r] },
  });
  render(<TicketPage repoId="shop-app" number={3349} />);
  expect(
    (await screen.findByRole("link", { name: "Open QA report · aaaaaaaa" })).getAttribute("href"),
  ).toBe(r.permalink);
});

describe("what was said about the ticket", () => {
  const said = (id: string, from: string, label: string | null): TicketEvent => ({
    key: `c-${id}`,
    at: 9_000,
    kind: "comms",
    id,
    from,
    to: "flight-1",
    label,
    text: `text ${id}`,
  });
  it.each([
    ["question", "inco-1", "question", "Question"],
    ["handoff", "inco-1", "handoff", "Handoff"],
    ["notice", "MC", null, "Notice"],
    ["plain", "flight-1", null, "Message"],
  ])("names a %s in the timeline", async (id, from, label, word) => {
    stubFetch({
      "/api/config": CONFIG,
      [PATH]: { ...history(), timeline: [said(id, from, label)], prs: [], nextBefore: null },
    });
    render(<TicketPage repoId="shop-app" number={3349} />);
    const tl = await screen.findByRole("region", { name: "Timeline" });
    expect(within(tl).getByText(word, { selector: ".pill" })).toBeTruthy();
  });
});

describe("questions on the ticket", () => {
  const question = (id: number, over: Partial<TicketQuestion> = {}): TicketQuestion => ({
    id,
    runId: "r1",
    seat: "inco-1",
    text: `Question ${id}: which cache?`,
    at: 8_000,
    passedAt: null,
    asideAt: null,
    closedAt: null,
    answer: null,
    answerAt: null,
    answerBasis: null,
    ...over,
  });
  const withQuestions = (questions: TicketQuestion[], next: string | null = null) => ({
    ...history(),
    timeline: [],
    prs: [],
    nextBefore: null,
    questions,
    questionsNextBefore: next,
  });
  const panel = async () => screen.findByRole("region", { name: "Questions" });

  it("shows an open question with its asker and says it is waiting", async () => {
    show(withQuestions([question(1)]));
    const p = await panel();
    expect(within(p).getByText("Question 1: which cache?")).toBeTruthy();
    expect(within(p).getByText("Open")).toBeTruthy();
    expect(within(p).getByText(/inco-1/i)).toBeTruthy();
  });

  it("shows an answered question with the answer and its basis", async () => {
    show(
      withQuestions([
        question(2, {
          answer: "Use the LRU cache.",
          answerAt: 9_000,
          answerBasis: "Matches the spec.",
        }),
      ]),
    );
    const p = await panel();
    expect(within(p).getByText("Answered")).toBeTruthy();
    expect(within(p).getByText("Use the LRU cache.")).toBeTruthy();
    expect(within(p).getByText("Matches the spec.")).toBeTruthy();
  });

  it("shows a question closed without an answer", async () => {
    show(withQuestions([question(3, { closedAt: 9_500 })]));
    expect(within(await panel()).getByText("Closed without an answer")).toBeTruthy();
  });

  it("shows a question set aside with Not now", async () => {
    show(withQuestions([question(4, { asideAt: 9_100 })]));
    expect(within(await panel()).getByText("Set aside (Not now)")).toBeTruthy();
  });

  it("pages older questions with their own cursor and keeps the ones it had", async () => {
    const fn = stubFetch({
      "/api/config": CONFIG,
      [PATH]: withQuestions([question(10)], "QCUR"),
      [`${PATH}?questionsBefore=QCUR`]: withQuestions([question(5)], null),
    });
    render(<TicketPage repoId="shop-app" number={3349} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load older questions" }));
    await waitFor(() => expect(screen.getByText("Question 5: which cache?")).toBeTruthy());
    expect(fn).toHaveBeenCalledWith(`${PATH}?questionsBefore=QCUR`, expect.anything());
    expect(screen.getByText("Question 10: which cache?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load older questions" })).toBeNull();
  });

  it("leaves the Questions panel out when the server sends none", async () => {
    show({ ...history(), questions: [] });
    await screen.findByRole("region", { name: "Timeline" });
    expect(screen.queryByRole("region", { name: "Questions" })).toBeNull();
  });
});

describe("sender kind on a ticket's messages", () => {
  const msg = (id: string, from: string, senderKind: CommsSenderKind | null): TicketEvent => ({
    key: `c-${id}`,
    at: 9_000,
    kind: "comms",
    id,
    from,
    to: "flight-1",
    label: null,
    text: `text ${id}`,
    senderKind,
  });
  it.each([
    ["operator", "CAPCOM", "YOU"],
    ["controller", "CONTROLLER", "CONTROLLER"],
    ["flight", "flight-1", "FLIGHT"],
    ["hub", "MC", "HUB"],
  ] as const)("tags a %s message", async (kind, from, tag) => {
    show({ ...history(), timeline: [msg(kind, from, kind)], prs: [], nextBefore: null });
    const tl = await screen.findByRole("region", { name: "Timeline" });
    expect(within(tl).getByTestId("sender-tag").textContent).toBe(tag);
  });
  it("tags a seat message with the seat's name", async () => {
    show({ ...history(), timeline: [msg("s", "inco-1", "seat")], prs: [], nextBefore: null });
    const tl = await screen.findByRole("region", { name: "Timeline" });
    expect(within(tl).getByTestId("sender-tag").getAttribute("data-kind")).toBe("seat");
  });
  it("shows no tag on a legacy message with no stored kind", async () => {
    show({ ...history(), timeline: [msg("old", "CAPCOM", null)], prs: [], nextBefore: null });
    const tl = await screen.findByRole("region", { name: "Timeline" });
    expect(within(tl).queryByTestId("sender-tag")).toBeNull();
  });
});
