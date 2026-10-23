/** The Agent page's Loop panel, as data: the run's limits, its tries and checks, the timeline's bars. */
import {
  CI_TRIES,
  type LoopTry,
  type PullRequestView,
  REVIEW_ROUNDS,
  REVIEW_STATUS_RUNNING,
  type ReviewStatus,
  type RunLoop,
  type RunView,
} from "@mc/core";
import type { LOOP_PATH } from "../crew.ts";

export type LoopStep = (typeof LOOP_PATH)[number];

export type CheckState = "pass" | "fail" | "run" | "wait";

export const CHECK_ICON: Record<CheckState, string> = {
  pass: "✓ pass",
  fail: "✗ fail",
  run: "◌ running",
  wait: "· waiting",
};

export const CHECK_CLASS: Record<CheckState, string> = {
  pass: "ck-pass",
  fail: "ck-fail",
  run: "ck-run",
  wait: "ck-wait",
};

export interface Check {
  text: string;
  state: CheckState;
}

export interface LoopLimits {
  tries: number;
  rounds: number;
}

/** The limits the engine parks on: the run's profile's, else the build loop's. */
export const runLimits = (run?: RunView): LoopLimits => ({
  tries: run?.profile?.profile.tries ?? CI_TRIES,
  rounds: run?.profile?.profile.rounds ?? REVIEW_ROUNDS,
});

/** The line under a step saying when it parks the run; null for a step that never does. */
export function loopRule(step: LoopStep, limits: LoopLimits): string | null {
  if (step === "ci") return `↻ fail → back to Working · parks after ${limits.tries} failures`;
  if (step === "review") {
    return `↻ Critical or Important findings → fix → CI → review · parks after ${limits.rounds} rounds`;
  }
  return null;
}

export const loopNote = (limits: LoopLimits): string =>
  `CI gets ${limits.tries} tries and review ${limits.rounds} rounds; after that the run parks for you.`;

/** The step the run's newest try is at, else null. */
export const heldStep = (tries: readonly LoopTry[]): LoopStep | null => tries.at(-1)?.step ?? null;

/** A step's tries, oldest first, fixes included. */
export const stepTries = (tries: readonly LoopTry[], step: LoopStep): LoopTry[] =>
  tries.filter((t) => t.step === step);

const MINUTE = 60_000;

export const tryMinutes = (t: LoopTry, now: number): number =>
  Math.round(((t.endedAt ?? now) - t.startedAt) / MINUTE);

export const tryText = (t: LoopTry): string => (t.reason ? `${t.outcome}: ${t.reason}` : t.outcome);

export function tryClass(t: LoopTry): string {
  switch (t.outcome) {
    case "fail":
    case "parked":
    case "stopped":
      return "crit-t";
    case "running":
    case "waiting":
      return "fg2";
    case "pass":
      return "ok-t";
  }
}

export function barClass(t: LoopTry): string {
  if (t.fix) return "tl-fix";
  switch (t.outcome) {
    case "fail":
    case "stopped":
      return "tl-fail";
    case "running":
      return "tl-run";
    case "waiting":
    case "parked":
      return "tl-wait";
    case "pass":
      return "tl-pass";
  }
}

const sha7 = (sha: string): string => sha.slice(0, 7);

/** The CI check of the pushed commit, read from the PR the loop watches. */
export function ciCheck(loop: RunLoop, prs: readonly PullRequestView[] | undefined): Check {
  if (!loop.pushFor) return { text: "Nothing pushed yet", state: "wait" };
  const short = sha7(loop.pushFor);
  const pr = prs?.find((p) => p.number === loop.prNumber);
  if (!pr || pr.headSha !== loop.pushFor) {
    return { text: `CI on ${short}: waiting for the push to show on GitHub`, state: "wait" };
  }
  switch (pr.ci) {
    case "passing":
      return { text: `CI on ${short}`, state: "pass" };
    case "failing":
      return { text: `CI on ${short}`, state: "fail" };
    case "pending":
      return { text: `CI on ${short}`, state: "run" };
    case null:
      return { text: `CI on ${short}: no CI reported yet`, state: "wait" };
  }
}

/** The In review step's checks: the QA review's status, then the merge. */
export function reviewChecks(review: ReviewStatus | null, prNumber: number | null): Check[] {
  const qa: Check = !review
    ? { text: "No QA review yet", state: "wait" }
    : {
        text: review.description,
        state:
          review.state === "success"
            ? "pass"
            : review.state === "failure"
              ? "fail"
              : review.description.startsWith(REVIEW_STATUS_RUNNING)
                ? "run"
                : "wait",
      };
  return [qa, { text: prNumber === null ? "PR merged" : `PR #${prNumber} merged`, state: "wait" }];
}

export function stepChecks(
  step: LoopStep,
  loop: RunLoop,
  review: ReviewStatus | null,
  prs: readonly PullRequestView[] | undefined,
): Check[] {
  if (step === "ci") return [ciCheck(loop, prs)];
  if (step === "review") return reviewChecks(review, loop.prNumber);
  return [];
}

/** The timeline's extent: the run's start to its end, or to now while it runs. */
export function loopSpan(
  start: number,
  endedAt: number | null,
  now: number,
): { end: number; total: number } {
  const end = endedAt ?? now;
  return { end, total: Math.max(end - start, 1) };
}

/** A try's bar as percents of the span; an open try runs to the span's end. */
export function barPlace(
  t: LoopTry,
  start: number,
  end: number,
  total: number,
): { left: number; width: number } {
  return {
    left: ((t.startedAt - start) * 100) / total,
    width: (((t.endedAt ?? end) - t.startedAt) * 100) / total,
  };
}
