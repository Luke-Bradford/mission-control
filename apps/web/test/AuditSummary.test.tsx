import type { CodeHealthCoverage, CodeHealthOverview, CodeHealthView, ConfigView } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { CodeHealth } from "../src/code-health/CodeHealth.tsx";
import { hub, streamStatus } from "../src/data.ts";
import {
  OVERVIEW_NOW as NOW,
  overviewFixture,
  overviewRowId,
} from "./codeHealthOverviewFixtures.ts";
import { stubFetch } from "./fetchStub.ts";

const config = {
  operator: { id: "operator" },
  repos: [
    { id: "sample", github: "example/sample" },
    { id: "other", github: "example/other" },
  ],
} as ConfigView;
const OVERVIEW = (repo = "sample", window = "30d") =>
  `/api/code-health/overview?repo=${repo}&window=${window}`;
const coverage: CodeHealthCoverage = {
  state: "not-collected",
  requestedWindow: "30d",
  from: NOW - 30 * 86400000,
  until: NOW,
  observedFrom: null,
  observedUntil: null,
  collectedAt: null,
  analysedSha: null,
  source: "named tests",
  complete: false,
  note: "Not collected.",
};
function fullRead(over: CodeHealthOverview): CodeHealthView {
  const ref = {
    id: "ch_row_evidence",
    repoId: over.repoId,
    label: "Reported review cohort",
    definition: "Distinct reviewed PRs.",
    coverage,
  };
  return {
    repoId: over.repoId,
    window: over.window,
    generatedAt: NOW,
    coverage: [coverage],
    evidence: [ref],
    data: {
      tab: "overview",
      // The server's full read carries evidence for only the top three rows.
      recommendations: over.rows.slice(0, 3).map((r) => ({ ...r, evidence: [ref] })),
      review: {
        reviewedPrs: 0,
        rounds: [
          { round: 1, prs: 0 },
          { round: 2, prs: 0 },
          { round: 3, prs: 0 },
          { round: 4, prs: 0 },
        ],
        rework: { numerator: 0, denominator: 0, percent: null },
        threeOrMoreRounds: { numerator: 0, denominator: 0, percent: null },
        categories: [],
        uncategorised: { numerator: 0, denominator: 0, percent: null },
      },
    },
  } as CodeHealthView;
}
function setup(over: CodeHealthOverview = overviewFixture(), extra: Record<string, unknown> = {}) {
  return stubFetch({
    "/api/config": config,
    "/api/operator/bootstrap": { token: "fixture-token" },
    [OVERVIEW()]: over,
    [OVERVIEW("other")]: overviewFixture({ repo: "other", rows: 2 }),
    [OVERVIEW("sample", "7d")]: overviewFixture({ window: "7d", rows: 1 }),
    "/api/code-health?repo=sample&window=30d&tab=overview": fullRead(over),
    "/api/code-health/recommendations?repo=sample&cursor=0": {
      recommendations: [],
      nextCursor: null,
    },
    ...extra,
  });
}
beforeEach(() => {
  hub.clear();
  forgetOperatorToken();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW });
});
afterEach(() => {
  cleanup();
  hub.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const rowButtons = () => [...document.querySelectorAll<HTMLButtonElement>("button.as-rt")];
async function ready() {
  await screen.findByRole("button", { name: /^Change number 1:/ });
}

it("shows the verdict, then Do next and New outside beside the three right-hand panels, from one read", async () => {
  const fetch = setup();
  render(<CodeHealth />);
  await ready();
  expect(screen.getByText(/Reviews almost stopped being recorded/)).toBeTruthy();
  for (const name of [
    "Do next",
    "New outside",
    "How we build",
    "Where findings land",
    "What past recommendations achieved",
  ])
    expect(screen.getByRole("heading", { name })).toBeTruthy();
  expect(rowButtons()).toHaveLength(8);
  expect(screen.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe("true");
  // The first row is open, as in the approved layout; the rest are closed.
  expect(rowButtons()[0].getAttribute("aria-expanded")).toBe("true");
  expect(rowButtons()[1].getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("What could be wrong")).toBeTruthy();
  const calls = fetch.mock.calls.filter(([url]) => String(url).startsWith("/api/code-health"));
  expect(calls.map(([url]) => url)).toEqual([OVERVIEW()]);
});

it("refetches the one summary when the server says it changed, and not otherwise", async () => {
  const fetch = setup();
  render(<CodeHealth />);
  await ready();
  const reads = () => fetch.mock.calls.filter(([url]) => url === OVERVIEW()).length;
  expect(reads()).toBe(1);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1200));
  });
  expect(reads()).toBe(1);
  act(() => hub.refetchTopic("health"));
  await waitFor(() => expect(reads()).toBe(2));
});

it("states what each row measures, who decides, its state and its real review date", async () => {
  setup(
    overviewFixture({
      rows: 4,
      rowOver: (n) =>
        n === 2
          ? {
              state: {
                kind: "accepted",
                owner: "operator",
                reviewAt: Date.UTC(2026, 10, 18),
                linkedWork: null,
              },
            }
          : n === 3
            ? { state: { kind: "snoozed", until: Date.UTC(2026, 11, 2) } }
            : n === 4
              ? { measure: undefined, decision: undefined }
              : {},
    }),
  );
  render(<CodeHealth />);
  await ready();
  const rows = document.querySelectorAll("tr.as-rec");
  expect(within(rows[0] as HTMLElement).getByText("4")).toBeTruthy();
  expect(rows[0].textContent).toContain("→");
  expect(rows[0].textContent).toContain("95");
  expect(rows[0].textContent).toContain("Review date unset");
  expect(rows[1].textContent).toContain("Accepted");
  expect(rows[1].textContent).toContain("Review 18 Nov 2026");
  expect(rows[2].textContent).toContain("Until 2 Dec 2026");
  expect(rows[2].textContent).toContain("You");
  expect(rows[0].textContent).toContain("FLIGHT");
  expect(rows[3].textContent).toContain("unknown");
  expect(rows[3].textContent).toContain("decider not recorded");
});

it("shows the true count for none, one and fifty rows, and keeps every row reachable", async () => {
  for (const [n, expectText] of [
    [0, /No open proposal meets/],
    [1, /^1 ranked/],
    [50, /^50 ranked/],
  ] as const) {
    hub.clear();
    cleanup();
    setup(overviewFixture({ rows: n }));
    render(<CodeHealth />);
    if (n === 0) await screen.findByText(expectText);
    else {
      await ready();
      expect(screen.getByRole("region", { name: "Recommendations" }).tabIndex).toBe(0);
      expect(document.querySelector(".as-do .sub")?.textContent).toMatch(expectText);
    }
    expect(rowButtons()).toHaveLength(n);
  }
});

it("keeps long titles and long evidence whole in the page text", async () => {
  const long = `${"Settle the shared cause once. ".repeat(20)}end-of-title`;
  const evidence = `${"Evidence sentence that keeps going. ".repeat(30)}end-of-evidence`;
  setup(
    overviewFixture({
      rows: 2,
      rowOver: (n) => (n === 1 ? { title: long, observation: evidence } : {}),
    }),
  );
  render(<CodeHealth />);
  await screen.findByRole("button", { name: /end-of-title/ });
  expect(screen.getAllByText(/end-of-evidence/).length).toBeGreaterThan(0);
});

it("expands a row on click and filters by the server's decision facts", async () => {
  setup(overviewFixture({ rows: 8, rowOver: (n) => (n === 8 ? { decision: undefined } : {}) }));
  render(<CodeHealth />);
  await ready();
  fireEvent.click(rowButtons()[1]);
  expect(rowButtons()[1].getAttribute("aria-expanded")).toBe("true");
  expect(rowButtons()[0].getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(rowButtons()[1]);
  expect(rowButtons()[1].getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("button", { name: "All 8" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "You 2" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "FLIGHT 5" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "You 2" }));
  expect(rowButtons()).toHaveLength(2);
  expect(screen.getByRole("button", { name: "You 2" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "FLIGHT 5" }));
  expect(rowButtons()).toHaveLength(5);
  expect(document.querySelectorAll('tr.as-rec[data-who="you"]')).toHaveLength(0);
});

it("changes repo and window with their own read, dropping an open dialog", async () => {
  const fetch = setup();
  render(<CodeHealth />);
  await ready();
  fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);
  await screen.findByRole("dialog", { name: "Accept proposal" });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  await waitFor(() => expect(rowButtons()).toHaveLength(1));
  expect(fetch.mock.calls.some(([url]) => url === OVERVIEW("sample", "7d"))).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "Repo" }), { target: { value: "other" } });
  await screen.findByRole("button", { name: /^Change number 1:/ }).catch(() => undefined);
  await waitFor(() =>
    expect(fetch.mock.calls.some(([url]) => url === OVERVIEW("other", "7d"))).toBe(true),
  );
});

it("holds decisions while disconnected, stale or in error, and releases them on reconnect", async () => {
  setup();
  render(<CodeHealth />);
  await ready();
  const accept = () => screen.getAllByRole("button", { name: "Accept" })[0] as HTMLButtonElement;
  expect(accept().disabled).toBe(false);
  act(() => streamStatus.set({ connected: false, reconnecting: true, lastMessageAt: NOW }));
  expect(accept().disabled).toBe(true);
  expect(screen.getByText("Disconnected")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Recommendation history" })).toBeTruthy();
  act(() => streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW }));
  expect(accept().disabled).toBe(false);
});

it("shows an old summary as stale and refuses decisions until it is read again", async () => {
  setup(overviewFixture({ generatedAt: NOW - 30 * 60_000 }));
  render(<CodeHealth />);
  await ready();
  expect(screen.getByText("Stale snapshot")).toBeTruthy();
  expect((screen.getAllByRole("button", { name: "Accept" })[0] as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("keeps the last summary visible, with an error notice and held decisions, when a refresh fails", async () => {
  let fail = false;
  setup(overviewFixture(), {
    [OVERVIEW()]: () =>
      fail
        ? { status: 503, body: { error: "Collection unavailable" } }
        : { status: 200, body: overviewFixture() },
  });
  render(<CodeHealth />);
  await ready();
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("alert");
  expect(rowButtons()).toHaveLength(8);
  expect((screen.getAllByRole("button", { name: "Accept" })[0] as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("shows loading and an initial failure in words", async () => {
  setup(overviewFixture(), {
    [OVERVIEW()]: () => ({ status: 503, body: { error: "Collection unavailable" } }),
  });
  render(<CodeHealth />);
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
});

it("names partial and unknown figures instead of showing zero", async () => {
  const over = overviewFixture();
  over.figures[3] = {
    ...over.figures[3],
    state: "partial",
    value: 2.5,
    unit: "USD, median of priced PRs",
  };
  over.figures.push({
    ...over.figures[0],
    id: "x",
    label: "Unknowable",
    value: null,
    state: "unknown",
    comparison: null,
  });
  setup(over);
  render(<CodeHealth />);
  await ready();
  const table = screen.getByRole("region", { name: "Health measures" });
  expect(within(table).getByText("Unknowable").closest("tr")?.textContent).toContain("unknown");
  expect(within(table).getByText("Median cost per merged PR").closest("tr")?.textContent).toContain(
    "partial",
  );
  expect(within(table).getByText("Median cost per merged PR").closest("tr")?.textContent).toContain(
    "$2.50",
  );
});

it("shows accepted rows as recorded and opens history from them", async () => {
  setup(
    overviewFixture({
      rows: 2,
      rowOver: (n) =>
        n === 1
          ? {
              state: {
                kind: "accepted",
                owner: "operator",
                reviewAt: Date.UTC(2026, 10, 25),
                linkedWork: "#12",
              },
            }
          : {},
    }),
  );
  render(<CodeHealth />);
  await ready();
  const first = document.querySelectorAll("tr.as-rec")[0] as HTMLElement;
  expect(within(first).queryByRole("button", { name: "Accept" })).toBeNull();
  expect(within(first).getByText("Decision recorded")).toBeTruthy();
  fireEvent.click(within(first).getByRole("button", { name: "History" }));
  await screen.findByRole("dialog");
});

it("records a decision with the row's own version, shows failure and success receipts", async () => {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const id = overviewRowId(1);
  setup(overviewFixture(), {
    [`POST /api/code-health/recommendations/${id}?repo=sample`]: (
      init: RequestInit | undefined,
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      calls++;
      return calls === 1
        ? { status: 503, body: { error: "Temporary collection failure" } }
        : {
            status: 200,
            body: {
              ...overviewFixture().rows[0],
              state: {
                kind: "accepted",
                owner: "operator",
                reviewAt: NOW + 7 * 86400000,
                linkedWork: null,
              },
            },
          };
    },
  });
  render(<CodeHealth />);
  await ready();
  fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
  await screen.findByText(/not confirmed/);
  fireEvent.click(screen.getByRole("button", { name: "Retry this decision" }));
  await screen.findByText(/Decision recorded: accepted/);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({
    expectedUpdatedAt: NOW - 3600_000,
    basis: expect.stringContaining("fixture-1"),
  });
});

it("marks protected and FLIGHT-owned decisions apart", async () => {
  setup();
  render(<CodeHealth />);
  await ready();
  const rows = [...document.querySelectorAll<HTMLElement>("tr.as-rec")];
  expect(rows[2].dataset.who).toBe("you");
  expect(rows[0].dataset.who).toBe("flight");
  expect(within(rows[2]).getAllByText("You")[0].className).toContain("as-you");
  expect(within(rows[0]).getAllByText("FLIGHT").length).toBeGreaterThan(0);
});

it("opens evidence for a row from the full read, only when asked", async () => {
  const fetch = setup(overviewFixture(), {
    "/api/code-health/evidence/ch_row_evidence?repo=sample&cursor=0": {
      reference: fullRead(overviewFixture()).evidence[0],
      rows: [{ reviewId: 1, pr: 1, round: 1, state: "reported" }],
      nextCursor: null,
      truncated: false,
    },
  });
  render(<CodeHealth />);
  await ready();
  expect(fetch.mock.calls.some(([url]) => String(url).includes("tab=overview"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Inspect evidence" }));
  await screen.findByRole("dialog", { name: "Recommendation evidence" });
  expect(fetch.mock.calls.some(([url]) => String(url).includes("tab=overview"))).toBe(true);
});

it("keeps every earlier Audit view one click away", async () => {
  setup(overviewFixture(), {
    "/api/code-health?repo=sample&window=30d&tab=review": {
      ...fullRead(overviewFixture()),
      data: {
        tab: "review",
        review: (fullRead(overviewFixture()).data as { review: unknown }).review,
      },
    },
    "/api/code-health?repo=sample&window=30d&tab=risk": {
      ...fullRead(overviewFixture()),
      data: { tab: "risk", files: [], sizeHistory: [], coupling: [] },
    },
  });
  render(<CodeHealth />);
  await ready();
  for (const name of [
    "Review quality",
    "Code risk",
    "Test health",
    "Tokens",
    "Workflow history and earlier proposals",
    "Summary",
  ]) {
    fireEvent.click(screen.getByRole("tab", { name }));
    expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true");
  }
  await ready();
  expect(
    screen.getByRole("link", { name: "PR readiness and tests in QA" }).getAttribute("href"),
  ).toBe("/qa");
  expect(screen.getByRole("link", { name: "Cost and flow context" }).getAttribute("href")).toBe(
    "/telemetry",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Workflow history and earlier proposals" }));
  await screen.findByRole("heading", { name: "Workflow history", level: 2 });
  fireEvent.click(screen.getByRole("tab", { name: "Summary" }));
  fireEvent.click(screen.getByRole("button", { name: "Recommendation history" }));
  await screen.findByRole("dialog");
});

it("shows waste alarms from the summary, or says they are not yet supplied", async () => {
  const withAlarm = overviewFixture();
  withAlarm.wasteAlarms = {
    state: "available",
    note: "",
    rows: [
      {
        id: "cost-without-output:T1",
        check: "cost-without-output",
        title: "Spent $40 with nothing merged",
        scope: { repoId: "sample", ticket: "T1", runId: null, seatId: null },
        evidence: "Four runs, no merged PR.",
        measure: { value: 40, unit: "USD" },
        threshold: "Over $25 with no output",
        costUsd: 40,
        owner: "FLIGHT",
        state: "open",
        openedAt: NOW,
      },
    ],
  };
  setup(withAlarm);
  render(<CodeHealth />);
  await screen.findByText("Spent $40 with nothing merged");
  cleanup();
  hub.clear();
  const old = overviewFixture() as Partial<CodeHealthOverview>;
  old.wasteAlarms = undefined;
  setup(old as CodeHealthOverview);
  render(<CodeHealth />);
  await screen.findByText(/Waste alarms: not yet supplied/);
});

it("says outside items are not collected, and lists them when they are", async () => {
  setup(overviewFixture());
  render(<CodeHealth />);
  await screen.findByText(/Not collected yet\. No outside source/);
  cleanup();
  hub.clear();
  setup(overviewFixture({ outside: 12 }));
  render(<CodeHealth />);
  await screen.findByText(/Outside item 0/);
  expect(screen.getByRole("region", { name: "External items" }).tabIndex).toBe(0);
});

it("holds a drafted decision when the page is disconnected mid-way", async () => {
  setup();
  render(<CodeHealth />);
  await ready();
  fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);
  const owner = await screen.findByRole("textbox", { name: "Owner" });
  fireEvent.change(owner, { target: { value: "me" } });
  act(() => streamStatus.set({ connected: false, reconnecting: true, lastMessageAt: NOW }));
  expect(
    (screen.getByRole("button", { name: "Record decision" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect((screen.getByRole("textbox", { name: "Owner" }) as HTMLInputElement).value).toBe("me");
});

it("shows each row's measurement window and unit, and says so when there is no measure", async () => {
  setup(
    overviewFixture({
      rows: 2,
      rowOver: (n) =>
        n === 1
          ? {
              measure: {
                current: null,
                unit: "findings a week",
                window: "7d",
                sourceAt: null,
                coverage: "none",
              },
            }
          : { measure: undefined },
    }),
  );
  render(<CodeHealth />);
  await ready();
  const rows = document.querySelectorAll("tr.as-rec");
  expect(rows[0].textContent).toContain("— unknown");
  expect(rows[0].textContent).toContain("findings a week · over 7d");
  expect(rows[1].textContent).toContain("unit not recorded · no measure yet");
});

it("shows each figure's own window, unit and state in the table, not in a hover title", async () => {
  const over = overviewFixture();
  over.figures = [
    {
      ...over.figures[0],
      id: "a",
      label: "Alpha",
      unit: "merged PRs",
      window: { ...over.figures[0].window, label: "7d" },
    },
    {
      ...over.figures[1],
      id: "b",
      label: "Beta",
      unit: "% of merged PRs",
      window: { ...over.figures[1].window, label: "90d" },
    },
    {
      ...over.figures[3],
      id: "c",
      label: "Gamma",
      unit: "USD, median of priced PRs",
      state: "partial",
      value: null,
      comparison: null,
      window: { ...over.figures[3].window, label: "30d" },
    },
  ];
  setup(over);
  render(<CodeHealth />);
  await ready();
  const table = screen.getByRole("region", { name: "Health measures" });
  const text = (name: string) => within(table).getByText(name).closest("tr")?.textContent ?? "";
  expect(text("Alpha")).toContain("merged PRs · 7d");
  expect(text("Beta")).toContain("% of merged PRs · 90d");
  expect(text("Gamma")).toContain("USD, median of priced PRs · 30d");
  expect(text("Gamma")).toContain("partial");
  expect(text("Gamma")).toContain("—");
});

it("shows a count scale and each day's merged count, reachable by keyboard, crossing into November", async () => {
  setup();
  render(<CodeHealth />);
  await ready();
  fireEvent.click(screen.getByText("Count for each day"));
  const region = screen.getByRole("region", {
    name: /Merged PRs per day, count by day, over 14 days/,
  });
  expect(region.getAttribute("tabindex")).toBe("0");
  const items = within(region).getAllByRole("listitem");
  expect(items).toHaveLength(14);
  expect(items[0].textContent).toBe("10-22 10");
  expect(items[10].textContent).toContain("11-01");
  expect(document.querySelector(".as-yscale")?.textContent).toMatch(/^\d+0$/);
});

it("shows a file path in full when its button is pressed", async () => {
  setup();
  render(<CodeHealth />);
  await ready();
  const b = screen.getAllByRole("button", { name: /file-number-0\.ts/ })[0];
  expect(b.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(b);
  expect(b.getAttribute("aria-expanded")).toBe("true");
  expect(b.textContent).toBe("apps/server/src/very/long/path/to/a/file-number-0.ts");
});

it("sorts landing files by findings with a visible cue, and shows a figure's definition by keyboard", async () => {
  setup();
  render(<CodeHealth />);
  await ready();
  const th = screen.getByRole("columnheader", { name: /Findings/ });
  expect(th.getAttribute("aria-sort")).toBe("descending");
  expect(th.textContent).toContain("▼");
  const how = screen.getAllByRole("button", { name: /^Show how .* is measured$/ })[0];
  how.focus();
  expect(document.activeElement).toBe(how);
  expect(how.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(how);
  expect(how.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".as-fdef")?.textContent).toMatch(/\w/);
});

it("words the verdict chip for what is measured, never as Healthy", async () => {
  setup(overviewFixture({ tone: "ok" }));
  render(<CodeHealth />);
  await ready();
  const chip = document.querySelector(".as-tone");
  expect(chip?.textContent).toBe("Steady");
  expect(document.body.textContent).not.toMatch(/Healthy/);
});

it("lets an operator decide again on a row whose snooze has ended", async () => {
  setup(
    overviewFixture({
      rows: 2,
      rowOver: (n) => (n === 2 ? { state: { kind: "snoozed", until: Date.UTC(2026, 9, 1) } } : {}),
    }),
  );
  render(<CodeHealth />);
  await ready();
  const row = document.querySelectorAll("tr.as-rec")[1] as HTMLElement;
  expect(row.textContent).toContain("Snooze ended 1 Oct 2026");
  for (const name of ["Accept", "Dismiss", "Snooze"])
    expect((within(row).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
});

it("says plainly when a row beyond the top three has no evidence in the read", async () => {
  setup(overviewFixture({ rows: 5 }));
  render(<CodeHealth />);
  await ready();
  fireEvent.click(rowButtons()[3]);
  fireEvent.click(screen.getByRole("button", { name: "Inspect evidence" }));
  const dialog = await screen.findByRole("dialog", { name: "Recommendation evidence" });
  expect(within(dialog).getByText(/This row's evidence is not in the current read/)).toBeTruthy();
  expect(within(dialog).queryByText(/Requested/)).toBeNull();
});
