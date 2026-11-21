import { ADVICE_REASON_MAX, type ModelAdvice } from "./model-advice.ts";
import { BLOCKING_SEVERITIES, type ReviewFinding } from "./review.ts";

export const stepUpReason = (classes: string[], round: number): string =>
  `Review round ${round} repeated blocking findings of the same kind as round ${round - 1} (${classes.join(", ")}). Give the next attempt more effort or a stronger model instead of a third identical round.`;

const STEP_UP_EFFORTS = ["low", "medium", "high"] as const;

/** A blocking finding's class: its category, else the file it is on. */
const findingClass = (f: ReviewFinding): string => f.category ?? `file ${f.file}`;

const blockingClasses = (findings: readonly ReviewFinding[]): Set<string> =>
  new Set(findings.filter((f) => BLOCKING_SEVERITIES.includes(f.severity)).map(findingClass));

/**
 * The step-up recommendation after a review round that repeated a class of blocking finding from
 * the round before; null in round 1 or when no class repeats. Low, medium or high effort rises one
 * step on the same model; max, no effort or a Codex effort asks for a stronger model instead.
 */
export function stepUpAdvice(i: {
  round: number;
  previous: readonly ReviewFinding[];
  current: readonly ReviewFinding[];
  model: string | null;
  effort: string | null;
  at: number;
}): ModelAdvice | null {
  if (i.round < 2) return null;
  const before = blockingClasses(i.previous);
  const shared = [...blockingClasses(i.current)].filter((c) => before.has(c)).sort();
  if (shared.length === 0) return null;
  const at = STEP_UP_EFFORTS.indexOf(i.effort as (typeof STEP_UP_EFFORTS)[number]);
  const raised = at >= 0 && at < STEP_UP_EFFORTS.length - 1;
  const reason = stepUpReason(shared, i.round);
  return {
    step: "build",
    model: raised ? i.model : null,
    effort: raised ? (STEP_UP_EFFORTS[at + 1] ?? null) : i.effort,
    reason:
      reason.length > ADVICE_REASON_MAX ? `${reason.slice(0, ADVICE_REASON_MAX - 1)}…` : reason,
    by: "step-up",
    at: i.at,
  };
}
