import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { Audit } from "../src/pages/Audit.tsx";
import { stubFetch } from "./fetchStub.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28, 12);

const AUDIT = {
  range: { since: NOW - 30 * 24 * HOUR, until: NOW },
  longRunners: [
    { runId: "run/alpha", agentId: "inco-cx", ticket: "mission-control#770", durationMs: 9 * HOUR },
  ],
  deathLoops: [{ runId: "run/death", agentId: "retro-cx", parks: 4 }],
  reworkRounds: [{ runId: "run/rework", agentId: "guido-cx", rounds: 3, maxRound: 4 }],
  refusalsByRule: [{ rule: "no-network", count: 8 }],
  costPerMergedTicket: [{ ticket: "mission-control#700", costUsd: 42.5 }],
  prSizes: [
    {
      repoId: "mission-control",
      number: 770,
      additions: 120,
      deletions: 40,
      changedFiles: 4,
      runId: "run/alpha",
      agentId: "inco-cx",
    },
    {
      repoId: "mission-control",
      number: 701,
      additions: 1800,
      deletions: 200,
      changedFiles: 25,
      runId: "run/large",
      agentId: "surgeon-cx",
    },
  ],
  modelPromptTimeline: [
    {
      at: NOW - 4 * HOUR,
      model: "gpt-5.6",
      accountId: "codex",
      effort: "high",
      promptHash: "before",
      metrics: { cycleMs: HOUR, costUsd: 2, reworkRounds: 1 },
    },
    {
      at: NOW - HOUR,
      model: "gpt-6",
      accountId: "codex",
      effort: "medium",
      promptHash: "after",
      metrics: { cycleMs: HOUR / 2, costUsd: 1, reworkRounds: 0 },
    },
  ],
  questions: { asked: 7, answered: 5, answerMs: HOUR },
  chatter: { messages: 90, unnecessary: 12 },
  flakes: [{ name: "web test", count: 3, runId: "run/flaky", agentId: "guido-cx" }],
  proposals: [
    { id: "s-1", title: "Use smaller PRs", status: "open", runId: "run/surgeon" },
    { id: "s-ticketed", title: "Collect PR sizes", status: "ticketed" },
    { id: "s-dismissed", title: "Ignore isolated blip", status: "dismissed" },
    { id: "s-2", title: "Tune prompt", status: "verified" },
  ],
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stubFetch({ "/api/audit?range=30d": AUDIT });
});

afterEach(() => vi.restoreAllMocks());

it("shows loading until the initial range arrives", async () => {
  hub.clear();
  let resolve: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  render(<Audit />);
  expect(screen.getByText("Loading audit…")).toBeTruthy();
  await act(async () => resolve(new Response(JSON.stringify(AUDIT), { status: 200 })));
  expect(await screen.findByText("Use smaller PRs")).toBeTruthy();
});

it("renders empty audit panels and an initial API failure", async () => {
  hub.clear();
  stubFetch({ "/api/audit?range=30d": { questions: { asked: 0, answered: 0, answerMs: null } } });
  const empty = render(<Audit />);
  await screen.findByText("Unanswered questions · 0");
  expect(screen.getByText("No findings in this range.")).toBeTruthy();
  expect(screen.getAllByText("Not collected yet.")).toHaveLength(3);
  expect(screen.getByText("Chatter · Not collected yet.")).toBeTruthy();
  expect(screen.getByText("Flakes · Not collected yet.")).toBeTruthy();
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
  await screen.findByText("Use smaller PRs");

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
  expect(screen.getByRole("link", { name: "Trace run/large" }).getAttribute("href")).toBe(
    "/agent/surgeon-cx?trace=run%2Flarge",
  );
  expect(screen.getByRole("link", { name: /Flake · web test/i }).getAttribute("href")).toBe(
    "/agent/guido-cx?trace=run%2Fflaky",
  );
  expect(screen.getByText("Use smaller PRs")).toBeTruthy();
  expect(screen.getByText("changed · cycle 1h 0m → 30m · cost $2.00 → $1.00")).toBeTruthy();
  expect(screen.getByText("Unanswered questions · 2")).toBeTruthy();
  expect(screen.getByText("Chatter · 12 of 90")).toBeTruthy();
  expect(screen.getByText("Guard refusal spike · no-network · 8")).toBeTruthy();
  expect(screen.getByText("open")).toBeTruthy();
  expect(screen.getByText("ticketed")).toBeTruthy();
  expect(screen.getByText("dismissed")).toBeTruthy();
  expect(screen.getByText("verified")).toBeTruthy();

  fireEvent.click(
    within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "7d" }),
  );
  await vi.waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/audit?range=7d", expect.anything()),
  );
});
