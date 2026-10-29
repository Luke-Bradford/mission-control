import type { LoopTry, RunLoopView } from "@mc/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunChecklist, RunTrace } from "../src/agent/RunTrace.tsx";

const NOW = 1_730_000_000_000;
const tries: LoopTry[] = [
  {
    step: "working",
    fix: false,
    n: 1,
    tokens: 1200,
    startedAt: NOW - 12_000,
    endedAt: NOW - 9_000,
    outcome: "pass",
    reason: null,
  },
  {
    step: "ci",
    fix: false,
    n: 1,
    tokens: 0,
    startedAt: NOW - 9_000,
    endedAt: NOW - 6_000,
    outcome: "fail",
    reason: "lint",
  },
  {
    step: "working",
    fix: false,
    n: 2,
    tokens: 300,
    startedAt: NOW - 6_000,
    endedAt: NOW - 3_000,
    outcome: "pass",
    reason: null,
  },
  {
    step: "ci",
    fix: false,
    n: 2,
    tokens: 0,
    startedAt: NOW - 3_000,
    endedAt: null,
    outcome: "running",
    reason: null,
  },
];

const view: RunLoopView = {
  runId: "run/alpha",
  loop: { phase: "ci", ciFails: 1, parked: null } as RunLoopView["loop"] & object,
  events: [{ key: "e", runId: "run/alpha", text: "CI started", at: NOW - 3_000 }],
  tries,
  round: 1,
  budget: 2_000,
  review: null,
};

describe("Run trace", () => {
  it("keeps every step visit in the checklist, including a return to Build", () => {
    render(<RunChecklist view={view} now={NOW} />);

    expect(screen.getAllByText("Working")).toHaveLength(2);
    expect(screen.getAllByText("Next: Checks")).toHaveLength(2);
    expect(screen.getByText("1.5k tokens total")).toBeTruthy();
  });

  it("shows the timeline, edge counts, step token totals, caps and next direction", () => {
    render(
      <RunTrace runId="run/alpha" view={view} startedAt={NOW - 12_000} endedAt={null} now={NOW} />,
    );

    expect(screen.getByRole("heading", { name: "Run Trace" })).toBeTruthy();
    expect(screen.getByText("Working → Checks ×2")).toBeTruthy();
    expect(screen.getByText("Working · 1.5k")).toBeTruthy();
    expect(screen.getByText("CI fixes 1 / 3")).toBeTruthy();
    expect(screen.getByText(/If Checks pass → In review/)).toBeTruthy();
    expect(screen.getByText("CI started")).toBeTruthy();
  });
});
