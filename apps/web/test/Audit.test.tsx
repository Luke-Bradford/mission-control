import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Audit } from "../src/pages/Audit.tsx";
import { stubFetch } from "./fetchStub.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28, 12);

const AUDIT = {
  range: { since: NOW - 30 * 24 * HOUR, until: NOW },
  longRunners: [
    { runId: "run/alpha", agentId: "inco-cx", ticket: "mission-control#770", durationMs: 9 * HOUR },
  ],
  deathLoops: [{ runId: "run/death", parks: 4 }],
  reworkRounds: [{ runId: "run/rework", rounds: 3, maxRound: 4 }],
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
    },
    {
      repoId: "mission-control",
      number: 701,
      additions: 1800,
      deletions: 200,
      changedFiles: 25,
      runId: "run/large",
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
  flakes: [{ name: "web test", count: 3, runId: "run/flaky" }],
  proposals: [
    { id: "s-1", title: "Use smaller PRs", status: "open", runId: "run/surgeon" },
    { id: "s-2", title: "Tune prompt", status: "verified" },
  ],
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stubFetch({ "/api/audit?range=30d": AUDIT });
});

afterEach(() => vi.restoreAllMocks());

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
  expect(screen.getByRole("link", { name: /run\/alpha/i }).getAttribute("href")).toBe(
    "/agent/inco-cx?run=run%2Falpha",
  );
  expect(screen.getByRole("link", { name: /PR #701/i }).getAttribute("href")).toBe(
    "/board/mission-control",
  );
  expect(screen.getByText("Use smaller PRs")).toBeTruthy();
  expect(screen.getByText("verified")).toBeTruthy();

  fireEvent.click(
    within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "7d" }),
  );
  await vi.waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/audit?range=7d", expect.anything()),
  );
});
