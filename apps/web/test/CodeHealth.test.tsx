import type {
  CodeHealthCoverage,
  CodeHealthEvidenceRef,
  CodeHealthRecommendation,
  CodeHealthView,
  ConfigView,
} from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { CodeHealth } from "../src/code-health/CodeHealth.tsx";
import { hub, streamStatus } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";

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
        ? { tab, recommendations: [proposal], review: { ...review, rounds: [...review.rounds] } }
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
async function ready() {
  await screen.findByText(proposal.proposal);
}
it("fetches only the selected tab and uses keyboard tab navigation", async () => {
  const fetch = setup();
  render(<CodeHealth />);
  await ready();
  expect(screen.getByText("70.0%")).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => url.includes("tab=review"))).toBe(false);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "ArrowRight" });
  await screen.findByText("Recurring correction categories");
  expect(screen.getByRole("tab", { name: "Review quality" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(fetch.mock.calls.some(([url]) => url.includes("tab=review"))).toBe(true);
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
