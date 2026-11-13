import type {
  CodeHealthCoverage,
  CodeHealthEvidenceRef,
  CodeHealthRecommendation,
  CodeHealthView,
  ConfigView,
} from "@mc/core";
import { OPERATOR_HEADER } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { CodeHealth } from "../src/code-health/CodeHealth.tsx";
import { hub, streamStatus } from "../src/data.ts";
import { codeRiskFixture } from "./codeRiskFixtures.ts";
import { stubFetch } from "./fetchStub.ts";
import { testHealthFixture } from "./testHealthFixtures.ts";

const NOW = Date.UTC(2026, 10, 2, 12),
  ID = `chr_${"a".repeat(32)}`;
const config = {
  operator: { id: "operator" },
  repos: [
    { id: "sample", github: "example/sample" },
    { id: "other", github: "example/other" },
  ],
} as ConfigView;
const coverage: CodeHealthCoverage = {
  state: "available",
  requestedWindow: "30d",
  from: NOW - 30 * 86400000,
  until: NOW,
  observedFrom: NOW - 10 * 86400000,
  observedUntil: NOW,
  collectedAt: NOW,
  analysedSha: null,
  source: "reported review cohort",
  complete: false,
  note: "Earlier periods are unobserved.",
};
const evidence: CodeHealthEvidenceRef = {
  id: "ch_reviews",
  repoId: "sample",
  label: "Reported review cohort",
  definition: "Distinct observed reviewed PRs.",
  coverage,
};
const proposal: CodeHealthRecommendation = {
  id: ID,
  repoId: "sample",
  rule: "repeated-rounds",
  ruleVersion: 1,
  evidenceFingerprint: "fixture-evidence",
  observation: "A sample PR reached three reported rounds.",
  uncertainty: "Rounds do not establish a production defect.",
  proposal: "Inspect planning and review corrections",
  rankingReason: "Measured conservative threshold met.",
  target: { metric: "reported review rounds", direction: "decrease", baseline: 3 },
  createdAt: NOW,
  updatedAt: NOW,
  state: { kind: "proposed" },
  evidence: [evidence],
};
const review = {
  reviewedPrs: 10,
  rounds: [
    { round: 1, prs: 3 },
    { round: 2, prs: 5 },
    { round: 3, prs: 2 },
    { round: 4, prs: 0 },
  ] as const,
  rework: { numerator: 7, denominator: 10, percent: 70 },
  threeOrMoreRounds: { numerator: 2, denominator: 10, percent: 20 },
  categories: [
    { category: "spec", findings: 3 },
    { category: "test-missing", findings: 2 },
  ],
  uncategorised: { numerator: 2, denominator: 7, percent: 28.6 },
};
function view(tab: "overview" | "review" = "overview", repo = "sample"): CodeHealthView {
  return {
    repoId: repo,
    window: "30d",
    generatedAt: NOW,
    coverage: [coverage],
    evidence: [evidence],
    data:
      tab === "overview"
        ? {
            tab,
            recommendations: [
              {
                ...proposal,
                repoId: repo,
                id: repo === "sample" ? ID : `chr_${"d".repeat(32)}`,
                proposal: repo === "sample" ? proposal.proposal : "Other scope proposal",
              },
            ],
            review: { ...review, rounds: [...review.rounds] },
          }
        : { tab, review: { ...review, rounds: [...review.rounds] } },
  };
}
function setup(extra: Parameters<typeof stubFetch>[0] = {}) {
  return stubFetch({
    "/api/config": config,
    "/api/operator/bootstrap": { token: "fixture-token" },
    "/api/code-health?repo=sample&window=30d&tab=overview": view(),
    "/api/code-health?repo=sample&window=30d&tab=review": view("review"),
    "/api/code-health?repo=sample&window=7d&tab=overview": view(),
    "/api/code-health?repo=other&window=30d&tab=overview": view("overview", "other"),
    ...extra,
  });
}
it("fetches Code risk on selection and preserves repo/window while inspecting evidence", async () => {
  const fixture = codeRiskFixture(NOW);
  const fetch = setup(fixture.api);
  render(<CodeHealth />);
  await screen.findByRole("tab", { name: "Code risk" });
  expect(fetch.mock.calls.some(([url]) => String(url).includes("tab=risk"))).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "Code risk" }));
  await screen.findByRole("region", { name: "File risk measurements" });
  fireEvent.click(screen.getAllByRole("button", { name: "src/domain/state.ts" })[0]);
  await screen.findByRole("dialog", { name: "src/domain/state.ts" });
  expect(
    screen.getByRole("link", { name: "Open analysed commit bbbbbbbb" }).getAttribute("href"),
  ).toBe(`https://github.com/example/sample/commit/${"b".repeat(40)}`);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("tab", { name: "Code risk" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("button", { name: "30 days" }).getAttribute("aria-pressed")).toBe("true");
});
beforeEach(() => {
  hub.clear();
  forgetOperatorToken();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  hub.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function ready() {
  await screen.findByText(proposal.proposal);
}
it("opens on Code risk when it arrives at /audit?tab=risk", async () => {
  const fixture = codeRiskFixture(NOW);
  const fetch = setup(fixture.api);
  window.history.replaceState(null, "", "/audit?tab=risk");
  try {
    render(<CodeHealth />);
    await screen.findByRole("region", { name: "File risk measurements" });
    expect(screen.getByRole("tab", { name: "Code risk" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(fetch.mock.calls.some(([url]) => String(url).includes("tab=risk"))).toBe(true);
  } finally {
    window.history.replaceState(null, "", "/");
  }
});
it("fetches only the selected tab and uses keyboard tab navigation", async () => {
  const fetch = setup();
  render(<CodeHealth />);
  await ready();
  expect(screen.getByText("70%")).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => url.includes("tab=review"))).toBe(false);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "ArrowRight" });
  await screen.findByText("Recurring correction categories");
  expect(screen.getByRole("tab", { name: "Review quality" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(fetch.mock.calls.some(([url]) => url.includes("tab=review"))).toBe(true);
});
it("loads Test health on demand and pages explicit exact-head attempts through authenticated evidence", async () => {
  const fixture = testHealthFixture(NOW);
  const evidencePath = "/api/code-health/evidence/ch_test_ordered?repo=sample&cursor=";
  const firstPage = fixture.api[`${evidencePath}0`] as {
    reference: CodeHealthEvidenceRef;
    rows: Record<string, unknown>[];
  };
  const orderedRows = Array.from({ length: 60 }, (_, i) => ({
    ...firstPage.rows[0],
    attemptId: `ordered-${i}`,
    state: i ? "passed" : "failed",
    executionOrder: i,
    executionOrderStatus: "explicit",
    completedAt: NOW - 60000 + i * 1000,
  }));
  for (const cursor of [0, 50])
    fixture.api[`${evidencePath}${cursor}`] = {
      reference: firstPage.reference,
      rows: orderedRows.slice(cursor, cursor + 50),
      nextCursor: cursor ? null : "50",
      truncated: false,
    };
  // Supply the modified responses after constructing the explicit multipage cohort.
  const fetch = setup(fixture.api);
  render(<CodeHealth />);
  await screen.findByRole("tab", { name: "Test health" });
  await screen.findByText("Inspect planning and corrections before extending the same work.");
  expect(fetch.mock.calls.some(([url]) => url.includes("tab=test"))).toBe(false);
  // Test health is the tab after Code risk; Tokens now ends the row.
  fireEvent.keyDown(screen.getByRole("tab", { name: "Code risk" }), { key: "ArrowRight" });
  await screen.findByRole("region", { name: "Ranked test disruption" });
  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  await waitFor(() =>
    expect(fetch.mock.calls.some(([url]) => url.includes("window=7d&tab=test"))).toBe(true),
  );
  await screen.findByRole("button", { name: fixture.data.disruption[0].label });
  const opener = screen.getByRole("button", { name: fixture.data.disruption[0].label });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(/execution 0/);
  const first = within(dialog).getByText(/Record 1 · test-0/);
  fireEvent.click(first);
  const firstDetails = first.closest("details");
  if (!firstDetails) throw new Error("Attempt details missing");
  expect(
    within(firstDetails)
      .getByRole("link", { name: "Open exact head aaaaaaaa" })
      .getAttribute("href"),
  ).toBe(`https://github.com/example/sample/commit/${"a".repeat(40)}`);
  expect(
    within(firstDetails).getByRole("link", { name: "Open workflow result" }).getAttribute("href"),
  ).toBe("https://github.com/example/sample/actions/runs/1234/job/5678");
  fireEvent.click(within(dialog).getByRole("button", { name: "Next 50 rows" }));
  await within(dialog).findByText(/execution 50/);
  expect(within(dialog).queryByText(/execution 0$/)).toBeNull();
  const request = fetch.mock.calls.find(
    ([url]) => url.includes("ch_test_ordered") && url.includes("cursor=50"),
  );
  expect(new Headers(request?.[1]?.headers).get(OPERATOR_HEADER)).toBe("fictional-operator-token");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(screen.getByRole("tab", { name: "Test health" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(screen.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Open recommendations" }));
  await screen.findByText("Inspect planning and corrections before extending the same work.");
  expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Overview" }));
  expect(screen.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed")).toBe("true");
  expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
it("keeps uncertain retry positions and original QA/spec provenance distinct", async () => {
  const fixture = testHealthFixture(NOW);
  const page = fixture.api["/api/code-health/evidence/ch_test_ordered?repo=sample&cursor=0"] as {
    rows: Record<string, unknown>[];
  };
  page.rows[0].executionOrderStatus = "tied";
  setup(fixture.api);
  render(<CodeHealth />);
  await screen.findByRole("tab", { name: "Test health" });
  fireEvent.click(screen.getByRole("tab", { name: "Test health" }));
  fireEvent.click(await screen.findByRole("button", { name: fixture.data.disruption[0].label }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(/retry order uncertain \(tied\)/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "test-0" }));
  const qa = await screen.findByRole("dialog");
  const row = await within(qa).findByText(/Record 1 · test-0/);
  fireEvent.click(row);
  const qaDetails = row.closest("details");
  if (!qaDetails) throw new Error("QA details missing");
  expect(within(qaDetails).getByText("reviewer-0")).toBeTruthy();
  expect(within(qaDetails).getByText("operator-fixture")).toBeTruthy();
  expect(within(qaDetails).getByText(/docs\/drafts.md: retained drafts/)).toBeTruthy();
  expect(
    within(qaDetails)
      .getByRole("link", { name: "Open code at reviewed head" })
      .getAttribute("href"),
  ).toBe(`https://github.com/example/sample/blob/${"a".repeat(40)}/tests/account-0.test.ts#L12`);
});
it("keeps disconnected decisions disabled through range changes", async () => {
  setup();
  render(<CodeHealth />);
  await ready();
  act(() => streamStatus.set({ connected: false, reconnecting: true, lastMessageAt: NOW }));
  expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  await ready();
  expect(screen.getByText("Disconnected")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(true);
});
it("validates trimmed reasons and resets validation when switching actions", async () => {
  const fetch = setup();
  render(<CodeHealth />);
  await ready();
  const dismiss = screen.getByRole("button", { name: "Dismiss" });
  dismiss.focus();
  fireEvent.click(dismiss);
  fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "   " } });
  fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
  await screen.findByText("Enter a reason before dismissing.");
  expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(document.activeElement).toBe(dismiss));
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  expect(screen.queryByText("Enter a reason before dismissing.")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Owner" }), { target: { value: " " } });
  fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
  await screen.findByText("Enter an owner before accepting.");
});
it("waits for the server and retries an unconfirmed decision with the same request payload", async () => {
  const bodies: unknown[] = [];
  let attempts = 0;
  setup({
    [`POST /api/code-health/recommendations/${ID}?repo=sample`]: (
      init: RequestInit | undefined,
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      attempts++;
      return attempts === 1
        ? { status: 503, body: { error: "Temporary collection failure" } }
        : {
            status: 200,
            body: {
              ...proposal,
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
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
  await screen.findByRole("alert");
  expect(screen.queryByText(/Decision recorded: accepted/)).toBeNull();
  expect((screen.getByRole("textbox", { name: "Owner" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry this decision" }));
  await screen.findByText(/Decision recorded: accepted/);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
});
it("pages evidence at 50 rows and restores focus when closed", async () => {
  setup({
    "/api/code-health/evidence/ch_reviews?repo=sample&cursor=0": {
      reference: evidence,
      rows: Array.from({ length: 50 }, (_, i) => ({
        reviewId: i + 1,
        pr: i + 1,
        round: 1,
        state: "reported",
      })),
      nextCursor: "50",
      truncated: false,
    },
    "/api/code-health/evidence/ch_reviews?repo=sample&cursor=50": {
      reference: evidence,
      rows: [{ reviewId: 51, pr: 51, round: 3 }],
      nextCursor: null,
      truncated: false,
    },
  });
  render(<CodeHealth />);
  await ready();
  const opener = screen.getByRole("button", { name: "Inspect evidence" });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByText(/50 rows on this page/);
  expect(screen.getByRole("dialog").querySelectorAll("details")).toHaveLength(50);
  fireEvent.click(screen.getByRole("button", { name: "Next 50 rows" }));
  await screen.findByText(/1 row on this page/);
  expect(screen.getByRole("dialog").querySelectorAll("details")).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
});
it("does not display the previous repo while a new scoped read fails", async () => {
  setup({
    "/api/code-health?repo=other&window=30d&tab=overview": () => ({
      status: 503,
      body: { error: "Collection unavailable" },
    }),
  });
  render(<CodeHealth />);
  await ready();
  fireEvent.change(screen.getByRole("combobox", { name: "Repo" }), { target: { value: "other" } });
  await screen.findByRole("alert");
  expect(screen.queryByText(proposal.proposal)).toBeNull();
  expect(screen.getByRole("combobox", { name: "Repo" }).getAttribute("value")).not.toBe("sample");
});
it("names missing and empty collection without turning it into a health score", async () => {
  const empty = view();
  if (empty.data.tab !== "overview") throw Error("fixture");
  empty.data.recommendations = [];
  empty.data.review = { ...empty.data.review, reviewedPrs: 0 };
  empty.coverage = [
    {
      ...coverage,
      state: "not-collected",
      source: "named tests",
      observedFrom: null,
      observedUntil: null,
    },
  ];
  setup({ "/api/code-health?repo=sample&window=30d&tab=overview": empty });
  render(<CodeHealth />);
  await screen.findByText(/No open proposal/);
  expect(screen.getByText(/No reported reviews/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Inspect coverage" }));
  await screen.findByText("named tests · not collected");
});
it("ignores stream timestamps when connection state has not changed", async () => {
  setup();
  let renders = 0;
  render(
    <Profiler id="code-health" onRender={() => renders++}>
      <CodeHealth />
    </Profiler>,
  );
  await ready();
  await act(async () => {});
  const count = renders;
  act(() => {
    for (let i = 0; i < 20; i++)
      streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW + i + 1 });
  });
  expect(renders).toBe(count);
});
it("allows correction after a definitive validation failure using a fresh request ID", async () => {
  const bodies: { requestId: string }[] = [];
  setup({
    [`POST /api/code-health/recommendations/${ID}?repo=sample`]: (
      init: RequestInit | undefined,
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { status: 400, body: { error: "Owner needs correction" } };
    },
  });
  render(<CodeHealth />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
  await screen.findByRole("alert");
  const owner = screen.getByRole("textbox", { name: "Owner" }) as HTMLInputElement;
  expect(owner.disabled).toBe(false);
  fireEvent.change(owner, { target: { value: "new-owner" } });
  fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[0]?.requestId).not.toBe(bodies[1]?.requestId);
});
it("shows a later assessment without promising another board handoff", async () => {
  setup({
    "/api/code-health/recommendations?repo=sample&cursor=0": {
      recommendations: [
        {
          ...proposal,
          state: {
            kind: "no-effect",
            reason: "Compared with the saved baseline",
            assessedAt: NOW,
            evidenceId: "fixture-evidence",
          },
          linkedWork: "https://github.com/example/sample/issues/123",
          workReady: false,
        },
      ],
      nextCursor: null,
    },
  });
  render(<CodeHealth />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Recommendation history" }));
  await screen.findByText(/Assessment recorded/);
  expect(screen.queryByText(/Board handoff pending/)).toBeNull();
});
it("keeps keyboard focus in the named dialog while a decision is pending", async () => {
  setup();
  let finish: (response: Response) => void = () => {};
  const previousFetch = fetch;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : previousFetch(input, init),
  );
  render(<CodeHealth />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
  const dialog = screen.getByRole("dialog");
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  for (const shiftKey of [false, true]) {
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey });
    expect(document.activeElement).toBe(dialog);
  }
  expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/Decision recorded/)).toBeNull();
  await act(async () =>
    finish(
      new Response(
        JSON.stringify({
          ...proposal,
          state: { kind: "accepted", owner: "operator", reviewAt: NOW + 10000, linkedWork: null },
        }),
        { status: 200 },
      ),
    ),
  );
  await screen.findByText(/Decision recorded: accepted/);
});
it("releases a stalled decision as unconfirmed and ignores a late success", async () => {
  setup();
  let finish: (response: Response) => void = () => {};
  const previousFetch = fetch;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : previousFetch(input, init),
  );
  render(<CodeHealth />);
  await ready();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15001);
  });
  expect(screen.getByRole("alert").textContent).toContain("not confirmed");
  expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("textbox", { name: "Owner" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () =>
    finish(
      new Response(
        JSON.stringify({
          ...proposal,
          state: { kind: "accepted", owner: "operator", reviewAt: NOW + 10000, linkedWork: null },
        }),
        { status: 200 },
      ),
    ),
  );
  expect(screen.queryByText(/Decision recorded/)).toBeNull();
});
it("ignores an old scope's completion without closing a newer action dialog", async () => {
  setup();
  let finish: (response: Response) => void = () => {};
  const previousFetch = fetch;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : previousFetch(input, init),
  );
  render(<CodeHealth />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
  fireEvent.change(screen.getByRole("combobox", { name: "Repo" }), { target: { value: "other" } });
  await screen.findByText("Other scope proposal");
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  const newer = screen.getByRole("dialog");
  await act(async () =>
    finish(
      new Response(
        JSON.stringify({
          ...proposal,
          state: { kind: "accepted", owner: "operator", reviewAt: NOW + 10000, linkedWork: null },
        }),
        { status: 200 },
      ),
    ),
  );
  expect(screen.getByRole("dialog")).toBe(newer);
  expect(screen.queryByText(/Decision recorded/)).toBeNull();
  expect((screen.getByRole("combobox", { name: "Repo" }) as HTMLSelectElement).value).toBe("other");
});
it("never enables an initially expired response in any committed render", async () => {
  const expired = view();
  expired.generatedAt = NOW - 180000;
  expired.coverage = [
    { ...coverage, observedUntil: expired.generatedAt, collectedAt: expired.generatedAt },
  ];
  setup({ "/api/code-health?repo=sample&window=30d&tab=overview": expired });
  const states: { disabled: boolean; status: string }[] = [];
  render(
    <Profiler
      id="expiry"
      onRender={() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (b) => b.textContent === "Accept",
        );
        if (button)
          states.push({
            disabled: button.disabled,
            status: document.querySelector(".ch-coverage strong")?.textContent ?? "",
          });
      }}
    >
      <CodeHealth />
    </Profiler>,
  );
  await ready();
  expect(states.length).toBeGreaterThan(0);
  expect(states.every((row) => row.disabled && row.status === "Stale snapshot")).toBe(true);
});
it("clears a removed repo and its actions when configuration becomes empty", async () => {
  const routes = { "/api/config": config };
  const fetch = setup(routes);
  render(<CodeHealth />);
  await ready();
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
    input === "/api/config"
      ? Promise.resolve(new Response(JSON.stringify({ ...config, repos: [] }), { status: 200 }))
      : fetch(input, init),
  );
  act(() => hub.refetch("/api/config"));
  await screen.findByText(/No repos are configured/);
  expect(screen.queryByText(proposal.proposal)).toBeNull();
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
});
