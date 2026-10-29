import {
  type LoopTry,
  REVIEW_STATUS_BLOCKED,
  REVIEW_STATUS_RUNNING,
  type RunLoopView,
  type RunView,
} from "@mc/core";
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
    expect(screen.getByText("1.5k tokens total · 0m")).toBeTruthy();
  });

  it("shows the timeline, edge counts, step token totals, caps and next direction", () => {
    render(
      <RunTrace
        runId="run/alpha"
        view={view}
        startedAt={NOW - 12_000}
        endedAt={null}
        now={NOW}
        run={
          {
            profile: { profile: { tries: 2, rounds: 2 } },
          } as RunView
        }
      />,
    );

    expect(screen.getByRole("heading", { name: "Run Trace" })).toBeTruthy();
    expect(screen.getByText("Working → Checks ×2")).toBeTruthy();
    expect(screen.getByText("Working · 1.5k")).toBeTruthy();
    expect(screen.getByText("CI fixes 1 / 2")).toBeTruthy();
    expect(screen.getByText("Review round 1 / 2")).toBeTruthy();
    expect(screen.getByText(/If Checks pass → In review/)).toBeTruthy();
    expect(screen.getByText("CI started")).toBeTruthy();
  });

  it("keeps an upcoming direction for active Working and Review visits", () => {
    const working = {
      ...view,
      tries: [{ ...tries[0], endedAt: null, outcome: "running" as const }],
    };
    const review = {
      ...view,
      tries: [{ ...tries[0], step: "review" as const, endedAt: null, outcome: "running" as const }],
    };
    const { rerender } = render(<RunChecklist view={working} now={NOW} />);
    expect(screen.getByText("Next: Checks")).toBeTruthy();
    rerender(
      <RunTrace runId="review" view={review} startedAt={NOW - 12_000} endedAt={null} now={NOW} />,
    );
    expect(screen.getByText(/If In review pass → Done/)).toBeTruthy();
  });

  it("keeps queued checks and reviews conditional, but does not project parked or stopped visits", () => {
    const waitingReview = {
      ...view,
      tries: [{ ...tries[0], step: "review" as const, endedAt: null, outcome: "waiting" as const }],
    };
    const parkedChecks = {
      ...view,
      tries: [{ ...tries[1], endedAt: null, outcome: "parked" as const, reason: "CI cap reached" }],
    };
    const stoppedReview = {
      ...view,
      tries: [
        {
          ...tries[0],
          step: "review" as const,
          outcome: "stopped" as const,
          reason: "operator stopped run",
        },
      ],
    };
    const { rerender } = render(
      <RunTrace
        runId="queued"
        view={waitingReview}
        startedAt={NOW - 12_000}
        endedAt={null}
        now={NOW}
      />,
    );
    expect(screen.getByText(/If In review pass → Done; if it fails → Working/)).toBeTruthy();
    rerender(<RunChecklist view={parkedChecks} now={NOW} />);
    expect(screen.queryByText(/Next:/)).toBeNull();
    rerender(
      <RunTrace
        runId="parked"
        view={parkedChecks}
        startedAt={NOW - 9_000}
        endedAt={null}
        now={NOW}
      />,
    );
    expect(screen.getByText("Checks parked: CI cap reached.")).toBeTruthy();
    rerender(
      <RunTrace
        runId="stopped"
        view={stoppedReview}
        startedAt={NOW - 12_000}
        endedAt={null}
        now={NOW}
      />,
    );
    expect(screen.getByText("In review stopped: operator stopped run.")).toBeTruthy();
  });

  it("shows the loop API's recorded review state alongside its review visit", () => {
    const review = {
      ...view,
      tries: [{ ...tries[0], step: "review" as const, endedAt: null, outcome: "running" as const }],
      review: { state: "pending" as const, description: REVIEW_STATUS_RUNNING },
    };
    const { rerender } = render(
      <RunTrace runId="review" view={review} startedAt={NOW - 12_000} endedAt={null} now={NOW} />,
    );
    expect(screen.getByText(REVIEW_STATUS_RUNNING)).toBeTruthy();
    rerender(
      <RunTrace
        runId="blocked"
        view={{ ...review, review: { state: "failure", description: REVIEW_STATUS_BLOCKED } }}
        startedAt={NOW - 12_000}
        endedAt={null}
        now={NOW}
      />,
    );
    expect(screen.getByText(REVIEW_STATUS_BLOCKED)).toBeTruthy();
  });
});
