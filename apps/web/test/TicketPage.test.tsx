import type { TicketEvent, TicketHistory } from "@mc/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(tl.querySelectorAll(".tk-event")).toHaveLength(5);
    // comms text is inert text, not HTML
    expect(within(tl).getByText(/Please <b>start<\/b>/)).toBeTruthy();
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
    show(history({ timeline: [], body: null, outcome: null, githubError: "rate limited" }));
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
    await waitFor(() => expect(document.querySelectorAll(".tk-event").length).toBe(6));
    expect(fn).toHaveBeenCalledWith(`${PATH}?before=CUR`, expect.anything());
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    const items = [
      ...screen.getByRole("region", { name: "Timeline" }).querySelectorAll(".tk-event"),
    ];
    expect(items).toHaveLength(6);
    expect(items[5]?.textContent).toMatch(/failed/);
  });
});
