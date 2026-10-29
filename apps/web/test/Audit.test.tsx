import { AUDIT_PR_OUTLIER_LINES, type AuditView, type ConfigView } from "@mc/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { Audit } from "../src/pages/Audit.tsx";
import { stubFetch } from "./fetchStub.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28, 12);
const auditChangeWith = (text: string) => (_: string, element: Element | null) =>
  element?.classList.contains("audit-change") === true &&
  element.textContent?.includes(text) === true;

const AUDIT = {
  range: { since: NOW - 30 * 24 * HOUR, until: NOW },
  longRunners: [
    {
      runId: "run/alpha",
      agentId: "inco-cx",
      ticket: "mission-control#770",
      startedAt: NOW - 9 * HOUR,
      durationMs: 9 * HOUR,
    },
  ],
  deathLoops: [{ runId: "run/death", agentId: "retro-cx", parks: 4 }],
  reworkRounds: [{ runId: "run/rework", agentId: "guido-cx", rounds: 3, maxRound: 4 }],
  refusalsByRule: [{ rule: "no-network", count: 8 }],
  refusals: [
    { agentId: "inco-cx", runId: "run/alpha", rule: "no-network", count: 8 },
    { agentId: "retro-cx", runId: null, rule: "read-only", count: 2 },
  ],
  refusalSpikes: [{ agentId: "retro-cx", day: NOW - 2 * 24 * HOUR, count: 12 }],
  spendOutliers: [
    { runId: "run/expensive", agentId: "guido-cx", ticket: "mission-control#700", costUsd: 42.5 },
  ],
  costPerMergedTicket: [{ ticket: "mission-control#700", costUsd: 42.5 }],
  prSizes: {
    prs: [
      {
        repoId: "mission-control",
        number: 770,
        ticket: "mission-control#770",
        mergedAt: NOW - 3 * HOUR,
        additions: 120,
        deletions: 40,
        changedFiles: 4,
      },
      {
        repoId: "mission-control",
        number: 701,
        ticket: "mission-control#701",
        mergedAt: NOW - 2 * HOUR,
        additions: 1800,
        deletions: 200,
        changedFiles: 25,
      },
    ],
    outliers: [
      {
        repoId: "mission-control",
        number: 701,
        ticket: "mission-control#701",
        mergedAt: NOW - 2 * HOUR,
        additions: 1800,
        deletions: 200,
        changedFiles: 25,
      },
    ],
  },
  modelPromptTimeline: [],
  questions: { asked: 7, answered: 5, answerMs: HOUR },
  chatter: [{ from: "inco-cx", to: "retro-cx", ticket: "mission-control#862", rounds: 12 }],
  flakes: [{ key: "web:unit/Audit", count: 3, lastAt: NOW - HOUR }],
  changes: [
    {
      kind: "prompt",
      agentId: "inco-cx",
      at: NOW - HOUR,
      from: "before",
      to: "after",
      windowMs: 7 * 24 * HOUR,
      before: { merged: 1, reviewFailRate: 0.5, medianCostPerMergedTicket: 2, reworkRounds: 1 },
      after: { merged: 3, reviewFailRate: 0, medianCostPerMergedTicket: 1, reworkRounds: 0 },
    },
    {
      kind: "model",
      agentId: "retro-cx",
      at: NOW - 2 * HOUR,
      from: "gpt-5.6",
      to: "gpt-6",
      windowMs: 7 * 24 * HOUR,
      before: { merged: 4, reviewFailRate: 0.25, medianCostPerMergedTicket: 4, reworkRounds: 2 },
      after: { merged: 2, reviewFailRate: null, medianCostPerMergedTicket: null, reworkRounds: 5 },
    },
  ],
  surgeonProposals: [],
} satisfies AuditView;

const CONFIG = {
  loops: [{ id: "studio-builder" }],
  crew: {
    sessions: [{ seats: [{ id: "flight-1", retiring: false, loop: "watch" }] }],
  },
} as ConfigView;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stubFetch({ "/api/audit?range=30d": AUDIT, "/api/config": CONFIG });
});

afterEach(() => vi.restoreAllMocks());

it("shows loading until the initial range arrives", async () => {
  hub.clear();
  let resolve: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) =>
      input === "/api/config"
        ? Promise.resolve(new Response(JSON.stringify(CONFIG), { status: 200 }))
        : new Promise<Response>((done) => {
            resolve = done;
          }),
    ),
  );
  render(<Audit />);
  expect(screen.getByText("Loading audit…")).toBeTruthy();
  await act(async () => resolve(new Response(JSON.stringify(AUDIT), { status: 200 })));
  expect(await screen.findByText(auditChangeWith("Prompt change · before → after"))).toBeTruthy();
});

it("fails closed while crew classification is loading or unavailable", async () => {
  hub.clear();
  let resolveConfig: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) =>
      input === "/api/config"
        ? new Promise<Response>((done) => {
            resolveConfig = done;
          })
        : Promise.resolve(
            new Response(
              JSON.stringify({
                ...AUDIT,
                longRunners: [
                  ...AUDIT.longRunners,
                  { ...AUDIT.longRunners[0], runId: "run/observed", agentId: "studio-builder" },
                  { ...AUDIT.longRunners[0], runId: "run/watch", agentId: "flight-1" },
                ],
              }),
              { status: 200 },
            ),
          ),
    ),
  );
  render(<Audit />);

  expect(await screen.findByText("Loading crew classification…")).toBeTruthy();
  expect(screen.queryByText(/run\/(observed|watch)/)).toBeNull();
  await act(async () =>
    resolveConfig(new Response(JSON.stringify({ error: "config unavailable" }), { status: 500 })),
  );
  expect(
    await screen.findByText("Could not load crew classification: config unavailable"),
  ).toBeTruthy();
  expect(screen.queryByText(/run\/(observed|watch)/)).toBeNull();
});

it("renders empty audit panels and an initial API failure", async () => {
  hub.clear();
  stubFetch({
    "/api/config": CONFIG,
    "/api/audit?range=30d": {
      range: { since: NOW - 30 * 24 * HOUR, until: NOW },
      longRunners: [],
      deathLoops: [],
      reworkRounds: [],
      refusalsByRule: [],
      refusals: [],
      refusalSpikes: [],
      spendOutliers: [],
      questions: { asked: 0, answered: 0, answerMs: null },
      costPerMergedTicket: [],
      modelPromptTimeline: [],
      prSizes: { prs: [], outliers: [] },
      chatter: [],
      flakes: [],
      changes: [],
      surgeonProposals: [],
    } satisfies AuditView,
  });
  const empty = render(<Audit />);
  await screen.findByText("Unanswered questions · 0");
  expect(screen.getAllByText("No findings in this range.")).toHaveLength(3);
  expect(screen.getAllByText("Not collected yet.")).toHaveLength(1);
  empty.unmount();

  hub.clear();
  stubFetch({
    "/api/audit?range=30d": () => ({ status: 500, body: { error: "audit unavailable" } }),
  });
  render(<Audit />);
  expect(await screen.findByText("Could not load audit: audit unavailable")).toBeTruthy();
});

it("labels retained evidence as stale and reports a failed newly-selected range", async () => {
  hub.clear();
  stubFetch({
    "/api/audit?range=30d": AUDIT,
    "/api/audit?range=7d": () => ({ status: 500, body: { error: "audit unavailable" } }),
  });
  render(<Audit />);
  await screen.findByText(auditChangeWith("Prompt change · before → after"));

  fireEvent.click(
    within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "7d" }),
  );
  expect(await screen.findByText("Could not load audit: audit unavailable")).toBeTruthy();
  expect(screen.getByText("Showing 30d data while 7d is unavailable.")).toBeTruthy();
});

it("renders the audit panels, links each trace, and keeps the selected range shared", async () => {
  render(<Audit />);

  await screen.findByRole("heading", { level: 1, name: "Audit" });
  for (const name of [
    "Improvements to consider",
    "PR size",
    "Prompt & model changes",
    "Things to check",
    "SURGEON proposals",
  ]) {
    expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
  }
  expect(
    screen.getByRole("link", { name: "Long runner · 9h 0m · run/alpha" }).getAttribute("href"),
  ).toBe("/agent/inco-cx?trace=run%2Falpha");
  expect(screen.getByRole("link", { name: /PR #701/i }).getAttribute("href")).toBe(
    "/board/mission-control",
  );
  expect(
    screen.getByRole("link", { name: "Death loop · 4 parks · run/death" }).getAttribute("href"),
  ).toBe("/agent/retro-cx?trace=run%2Fdeath");
  expect(
    screen.getByRole("link", { name: "Rework · 3 rounds · run/rework" }).getAttribute("href"),
  ).toBe("/agent/guido-cx?trace=run%2Frework");
  expect(
    screen
      .getByRole("link", { name: "Guard refusal · no-network · 8 · run/alpha" })
      .getAttribute("href"),
  ).toBe("/agent/inco-cx?trace=run%2Falpha");
  expect(
    screen
      .getByRole("link", { name: "Spend outlier · mission-control#700 · $42.50 · run/expensive" })
      .getAttribute("href"),
  ).toBe("/agent/guido-cx?trace=run%2Fexpensive");
  expect(screen.getByText(auditChangeWith("Prompt change · before → after"))).toBeTruthy();
  expect(
    screen.getByText(
      auditChangeWith(
        "effect · merged 1 → 3 · review fail 50% → 0% · median cost $2.00 → $1.00 · rework 1 → 0",
      ),
    ),
  ).toBeTruthy();
  expect(screen.getByText(auditChangeWith("Model change · gpt-5.6 → gpt-6"))).toBeTruthy();
  expect(
    screen.getByText(
      auditChangeWith(
        "effect · merged 4 → 2 · review fail 25% → — · median cost $4.00 → — · rework 2 → 5",
      ),
    ),
  ).toBeTruthy();
  expect(screen.getByText("Unanswered questions · 2")).toBeTruthy();
  expect(
    screen.getByText("Chatter · inco-cx ↔ retro-cx · mission-control#862 · 12 rounds"),
  ).toBeTruthy();
  expect(screen.getByText("Flake · web:unit/Audit · 3")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Guard refusal spike · 12" }).getAttribute("href")).toBe(
    "/agent/retro-cx",
  );
  expect(screen.getByText("Guard refusal spike · no-network · 8")).toBeTruthy();

  fireEvent.click(
    within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "7d" }),
  );
  await vi.waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/audit?range=7d", expect.anything()),
  );
});

it("scales PR bars, applies the fixed outlier threshold, and names repos across the range", async () => {
  hub.clear();
  stubFetch({
    "/api/config": CONFIG,
    "/api/audit?range=30d": {
      ...AUDIT,
      prSizes: {
        prs: [
          {
            ...AUDIT.prSizes.prs[0],
            repoId: "small-repo",
            number: 1,
            additions: 665_702,
            deletions: 0,
          },
          {
            ...AUDIT.prSizes.prs[1],
            repoId: "other-repo",
            number: 2,
            additions: 2_833,
            deletions: 0,
          },
          {
            ...AUDIT.prSizes.prs[0],
            repoId: "small-repo",
            number: 3,
            additions: 799,
            deletions: 0,
          },
        ],
        // The client must not label a below-threshold row merely because a stale payload says so.
        outliers: [
          {
            ...AUDIT.prSizes.prs[0],
            repoId: "small-repo",
            number: 1,
            additions: 665_702,
            deletions: 0,
          },
          {
            ...AUDIT.prSizes.prs[1],
            repoId: "other-repo",
            number: 2,
            additions: 2_833,
            deletions: 0,
          },
          {
            ...AUDIT.prSizes.prs[0],
            repoId: "small-repo",
            number: 3,
            additions: 799,
            deletions: 0,
          },
        ],
      },
    } satisfies AuditView,
  });
  const { container } = render(<Audit />);

  await screen.findByText(
    `Log scale · ${AUDIT_PR_OUTLIER_LINES.toLocaleString()}+ changed lines are outliers.`,
  );
  const bars = container.querySelectorAll<HTMLElement>(".audit-bar");
  const [widestBar, smallerBar] = bars;
  if (!widestBar || !smallerBar) throw new Error("expected two PR size bars");
  const widest = window.getComputedStyle(widestBar).width;
  const smaller = window.getComputedStyle(smallerBar).width;
  expect(widest).toBe("100%");
  expect(Number.parseFloat(smaller)).toBeCloseTo(
    (Math.log1p(2_833) / Math.log1p(665_702)) * 100,
    8,
  );
  expect(screen.getByText(/665,702 lines · outlier/)).toBeTruthy();
  expect(screen.getByText(/2,833 lines · outlier/)).toBeTruthy();
  expect(
    [...container.querySelectorAll(".audit-size")].find((row) =>
      row.textContent?.includes("799 lines"),
    )?.textContent,
  ).not.toContain("outlier");
  expect(screen.getByText("small-repo · PR #1")).toBeTruthy();
  expect(screen.getByText("other-repo · PR #2")).toBeTruthy();
});

it("does not present stale, observed-loop, or FLIGHT watch runs as improvements", async () => {
  hub.clear();
  stubFetch({
    "/api/config": CONFIG,
    "/api/audit?range=30d": {
      ...AUDIT,
      longRunners: [
        ...AUDIT.longRunners,
        { ...AUDIT.longRunners[0], runId: "run/stale", actionable: false },
        { ...AUDIT.longRunners[0], runId: "run/observed", agentId: "studio-builder" },
        { ...AUDIT.longRunners[0], runId: "run/watch", agentId: "flight-1" },
      ],
    } as AuditView,
  });
  render(<Audit />);

  await screen.findByRole("link", { name: "Long runner · 9h 0m · run/alpha" });
  expect(screen.queryByText(/run\/stale/)).toBeNull();
  expect(screen.queryByText(/run\/observed/)).toBeNull();
  expect(screen.queryByText(/run\/watch/)).toBeNull();
});
