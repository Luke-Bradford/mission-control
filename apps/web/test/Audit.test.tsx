import type { AuditView, ConfigView, WasteAlarm, WasteReport } from "@mc/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../src/hud.css";
import { hub } from "../src/data.ts";
import { Audit } from "../src/pages/Audit.tsx";
import { stubFetch } from "./fetchStub.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28, 12);

const alarm = (id: number, check: WasteAlarm["check"], subject: string): WasteAlarm => ({
  id,
  check,
  subject,
  repoId: "mission-control",
  ticket: subject,
  seatId: "guido-cx",
  runId: `run/${id}`,
  level: 1,
  evidence: `evidence for ${subject}`,
  openedAt: NOW - HOUR,
  closedAt: null,
  resolvedAt: null,
  basis: null,
});
const WASTE: WasteReport = {
  at: NOW,
  spend: ["day", "week"].map((window, i) => ({
    window: window as "day" | "week",
    since: NOW - (i + 1) * 24 * HOUR,
    merged: 4,
    costUsd: 20,
    runs: 8,
    runsWithCost: 8,
    tokens: 1000,
    perMergeUsd: i === 0 ? 5 : 6.5,
    perMergeTokens: 250,
    buildingShareUsd: i === 0 ? 0.5 : 0.62,
    buildingShareTokens: 0.5,
    vendors: [],
  })),
  alarms: [
    alarm(1, "retry-loop", "mission-control#10"),
    alarm(2, "retry-loop", "mission-control#11"),
  ],
  checks: [],
  flight: [],
  counts: null,
};

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
  refusalsByRule: [{ rule: "full-suite", count: 8 }],
  refusals: [
    { agentId: "inco-cx", runId: "run/alpha", rule: "full-suite", count: 8 },
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
  mergedPerDay: [
    { day: NOW - 3 * 24 * HOUR, merged: 70, noReview: 10, round1: 40, round2: 15, round3: 5 },
    { day: NOW - 24 * HOUR, merged: 50, noReview: 0, round1: 30, round2: 12, round3: 8 },
  ],
  findingFiles: [
    {
      file: "apps/web/src/pages/a-very-long-directory-name/another-long-directory/File.tsx",
      findings: 6,
      touches: 3,
    },
    { file: "apps/server/src/store.ts", findings: 5, touches: 10 },
    { file: "apps/server/src/untouched.ts", findings: 4, touches: 0 },
  ],
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
  stubFetch({ "/api/audit?range=30d": AUDIT, "/api/config": CONFIG, "/api/waste": WASTE });
});

afterEach(() => vi.restoreAllMocks());

it("shows loading until the initial range arrives", async () => {
  hub.clear();
  let resolve: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) =>
      input === "/api/audit?range=30d"
        ? new Promise<Response>((done) => {
            resolve = done;
          })
        : Promise.resolve(
            new Response(JSON.stringify(input === "/api/waste" ? WASTE : CONFIG), { status: 200 }),
          ),
    ),
  );
  render(<Audit />);
  expect(screen.getByText("Loading audit…")).toBeTruthy();
  await act(async () => resolve(new Response(JSON.stringify(AUDIT), { status: 200 })));
  expect(await screen.findByRole("heading", { level: 2, name: "Do next" })).toBeTruthy();
});

it("leads with a one-sentence verdict, then ranked rows with a number now, a target and a decider", async () => {
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "Do next" });
  expect(screen.getByText(/changes to make in the last 30d\./)).toBeTruthy();
  const rows = document.querySelectorAll("tr.rec");
  expect(rows.length).toBeGreaterThanOrEqual(5);
  const all = [...rows].map((r) => r.querySelector(".audit-rt")?.textContent);
  expect(new Set(all).size).toBe(all.length);
  for (const r of rows) {
    expect(r.querySelector(".meas .v")?.textContent).toMatch(/\d+ → \d+ /);
    expect(r.querySelector(".dec b")?.textContent).toMatch(/^(FLIGHT|You)$/);
  }
  // Waste alarms are grouped into one row, ranked first.
  expect(rows[0]?.textContent).toContain("Fix what makes a ticket fail again and again");
  expect(rows[0]?.querySelector(".meas .v")?.textContent).toBe("1 → 1 failed attempts");
});

it("opens the first row, toggles rows, and filters by decider", async () => {
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "Do next" });
  const buttons = () =>
    screen.getAllByRole("button").filter((b) => b.classList.contains("audit-rt"));
  expect(buttons()[0]?.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".audit-fulltitle")).toBeNull();
  expect(screen.getByText("What this does not show")).toBeTruthy();
  fireEvent.click(buttons()[1] as HTMLElement);
  expect(buttons()[0]?.getAttribute("aria-expanded")).toBe("false");
  expect(buttons()[1]?.getAttribute("aria-expanded")).toBe("true");

  fireEvent.click(
    within(screen.getByRole("group", { name: "Decider" })).getByRole("button", { name: "FLIGHT" }),
  );
  const flight = document.querySelectorAll("tr.rec");
  expect(flight.length).toBeGreaterThan(0);
  for (const r of flight) expect(r.querySelector(".dec b")?.textContent).toBe("FLIGHT");
});

it("links each row's detail to the seat and run, in words rather than raw ids", async () => {
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "Do next" });
  const link = screen.getAllByRole("link", { name: "mission-control#10" })[0];
  expect(link?.getAttribute("href")).toBe("/agent/guido-cx?trace=run%2F1");
  for (const a of screen.getAllByRole("link"))
    expect(a.textContent, "no raw run id in link text").not.toMatch(/run\//);
});

it("fills the right-hand panels from the audit and the waste report", async () => {
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "Do next" });
  for (const name of [
    "New outside",
    "How we build",
    "Where findings land",
    "What past recommendations achieved",
  ])
    expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
  expect(screen.getByText("~$5.00 day · ~$6.50 week")).toBeTruthy();
  expect(screen.getByText("50% day · 62% week")).toBeTruthy();
  expect(
    screen.getByText(/Prompt change · before → after · inco-cx/).parentElement?.textContent,
  ).toContain("merged 1 → 3 · review fail 50% → 0% · median cost ~$2.00 → ~$1.00 · rework 1 → 0");
  expect(screen.getByText(/Nothing is collected from outside sources yet/)).toBeTruthy();
  expect(screen.queryByRole("tab")).toBeNull();
});

it("splits How we build by review round, with totals that match the merges", async () => {
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "How we build" });
  const legend = screen.getByRole("list", { name: /Review rounds/ });
  expect(legend.textContent).toContain("No hub review 10");
  expect(legend.textContent).toContain("Round 1 70");
  expect(legend.textContent).toContain("Round 2 27");
  expect(legend.textContent).toContain("Round 3+ 13");
  expect(
    screen.getByRole("img", {
      name: /120 in all.*10 with no hub review, 70 round 1, 27 round 2, 13 round 3 or later/,
    }),
  ).toBeTruthy();
});

it("ranks Where findings land by findings per touch, with a dash where no touch is stored", async () => {
  render(<Audit />);
  const heading = await screen.findByRole("heading", { level: 2, name: "Where findings land" });
  const panel = heading.closest("section") as HTMLElement;
  const rows = Array.from(panel.querySelectorAll("tbody tr")).map((r) =>
    Array.from(r.querySelectorAll("td")).map((c) => c.textContent),
  );
  expect(rows).toEqual([
    [
      "apps/web/src/pages/a-very-long-directory-name/another-long-directory/File.tsx",
      "6",
      "3",
      "2.00",
    ],
    ["apps/server/src/store.ts", "5", "10", "0.50"],
    ["apps/server/src/untouched.ts", "4", "–", "–"],
  ]);
  expect(Array.from(panel.querySelectorAll("th")).map((h) => h.textContent)).toEqual([
    "File",
    "Findings",
    "Touches",
    "Per touch",
  ]);
  const longPath = panel.querySelector(".audit-path") as HTMLElement;
  expect(longPath.title).toBe(
    "apps/web/src/pages/a-very-long-directory-name/another-long-directory/File.tsx",
  );
});

it("leaves out stale, observed-loop and FLIGHT watch runs", async () => {
  hub.clear();
  stubFetch({
    "/api/config": CONFIG,
    "/api/waste": WASTE,
    "/api/audit?range=30d": {
      ...AUDIT,
      longRunners: [
        { ...AUDIT.longRunners[0], runId: "run/stale", actionable: false },
        { ...AUDIT.longRunners[0], runId: "run/observed", agentId: "studio-builder" },
        { ...AUDIT.longRunners[0], runId: "run/watch", agentId: "flight-1" },
      ],
    } as AuditView,
  });
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "Do next" });
  expect(document.querySelector('[title^="Split the work that keeps one run open"]')).toBeNull();
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
            new Response(JSON.stringify(input === "/api/waste" ? WASTE : AUDIT), { status: 200 }),
          ),
    ),
  );
  render(<Audit />);
  expect(await screen.findByText("Loading crew classification…")).toBeTruthy();
  expect(document.querySelectorAll("tr.rec")).toHaveLength(0);
  await act(async () =>
    resolveConfig(new Response(JSON.stringify({ error: "config unavailable" }), { status: 500 })),
  );
  expect(
    await screen.findByText("Could not load crew classification: config unavailable"),
  ).toBeTruthy();
  expect(document.querySelectorAll("tr.rec")).toHaveLength(0);
});

it("says plainly when there is nothing to do, and reports an API failure", async () => {
  hub.clear();
  stubFetch({
    "/api/config": CONFIG,
    "/api/waste": { ...WASTE, alarms: [] },
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
  expect(await screen.findByText("Nothing in the last 30d is past a limit.")).toBeTruthy();
  expect(screen.getByText("No change is called for in this range.")).toBeTruthy();
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
    "/api/config": CONFIG,
    "/api/waste": WASTE,
    "/api/audit?range=7d": () => ({ status: 500, body: { error: "audit unavailable" } }),
  });
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "Do next" });
  fireEvent.click(
    within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "7d" }),
  );
  expect(await screen.findByText(/Showing 30d data while 7d is unavailable\./)).toBeTruthy();
});

it("asks for the new range when it changes", async () => {
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "Do next" });
  fireEvent.click(
    within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "7d" }),
  );
  await vi.waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/audit?range=7d", expect.anything()),
  );
});

it("counts every merge in the chart and says what it covers", async () => {
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "How we build" });
  // 120 merges are served although the PR list is cut to 50.
  expect(
    screen.getByRole("img", { name: /one bar per day, 120 in all, most 70 in one bar/ }),
  ).toBeTruthy();
  expect(screen.getByText("Merged PRs").nextSibling?.textContent).toBe("120");
  expect(screen.getByText(/120 in 30 days, all counted/)).toBeTruthy();
});

it("keeps the range-start date and the next date as separate bars", async () => {
  hub.clear();
  const start = Math.floor((NOW - 30 * 24 * HOUR) / (24 * HOUR)) * 24 * HOUR;
  stubFetch({
    "/api/config": CONFIG,
    "/api/waste": WASTE,
    "/api/audit?range=30d": {
      ...AUDIT,
      mergedPerDay: [
        { day: start, merged: 4, noReview: 4, round1: 0, round2: 0, round3: 0 },
        { day: start + 24 * HOUR, merged: 6, noReview: 6, round1: 0, round2: 0, round3: 0 },
      ],
    } satisfies AuditView,
  });
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "How we build" });
  // 31 UTC dates, one bar each: 4 and 6 are not folded into one bar of 10.
  expect(
    screen.getByRole("img", { name: /one bar per day, 10 in all, most 6 in one bar/ }),
  ).toBeTruthy();
  expect(screen.getByText(/^28 Sep/)).toBeTruthy();
});

it("shows a past change's own comparison window, partial near the range edge", async () => {
  hub.clear();
  const first = AUDIT.changes[0];
  const second = AUDIT.changes[1];
  stubFetch({
    "/api/config": CONFIG,
    "/api/waste": WASTE,
    "/api/audit?range=30d": {
      ...AUDIT,
      changes: [
        { ...first, windowMs: 3 * 24 * HOUR },
        { ...second, windowMs: 7 * 24 * HOUR },
      ],
    } satisfies AuditView,
  });
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "What past recommendations achieved" });
  expect(screen.getByText("3 days each side, partial: the range ends there")).toBeTruthy();
  expect(screen.getByText("7 days each side")).toBeTruthy();
});

it("does not call a failed waste read zero alarms", async () => {
  hub.clear();
  stubFetch({
    "/api/config": CONFIG,
    "/api/audit?range=30d": {
      ...AUDIT,
      longRunners: [],
      deathLoops: [],
      reworkRounds: [],
      refusals: [],
      refusalsByRule: [],
      refusalSpikes: [],
      spendOutliers: [],
      questions: { asked: 0, answered: 0, answerMs: null },
      chatter: [],
      flakes: [],
      prSizes: { prs: [], outliers: [] },
    },
    "/api/waste": () => ({ status: 500, body: { error: "waste unavailable" } }),
  });
  render(<Audit />);
  expect(await screen.findByText(/Could not load waste alarms: waste unavailable/)).toBeTruthy();
  expect(screen.queryByText(/Nothing in the last 30d is past a limit/)).toBeNull();
  expect(screen.getByText(/No other change is called for in the last 30d/)).toBeTruthy();
  expect(screen.getByText(/Waste alarms are not loaded, so there may be more/)).toBeTruthy();
  const before = vi.mocked(fetch).mock.calls.filter((c) => c[0] === "/api/waste").length;
  fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0] as HTMLElement);
  await vi.waitFor(() =>
    expect(vi.mocked(fetch).mock.calls.filter((c) => c[0] === "/api/waste").length).toBeGreaterThan(
      before,
    ),
  );
});

it("keeps recommendation results separate from prompt and model comparisons", async () => {
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "What past recommendations achieved" });
  expect(
    screen.getByText(/No proposal is stored, so no recommendation has a result to show/),
  ).toBeTruthy();
  expect(
    screen.getByText(/not recommendation results and do not show what caused a change/),
  ).toBeTruthy();
});

it("keeps an open row's title in its trigger and shows its detail once", async () => {
  render(<Audit />);
  await screen.findByRole("heading", { level: 2, name: "Do next" });
  expect(document.querySelector(".audit-fulltitle")).toBeNull();
  expect(screen.getByRole("button", { expanded: true }).textContent).toMatch(/Fix what makes/);
  expect(screen.getByRole("heading", { level: 3, name: "Evidence" })).toBeTruthy();
  expect(screen.getByText(/End of list: \d+ rows\./)).toBeTruthy();
});
