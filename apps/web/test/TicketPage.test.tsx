import type { TicketEvent, TicketHistory } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { TicketPage } from "../src/pages/TicketPage.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";

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
