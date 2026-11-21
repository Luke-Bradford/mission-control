import { BLOCKING_SEVERITIES, type ReviewFinding } from "./review.ts";
import type { LoopKind } from "./runtime-model.ts";

/** The steps of a ticket a model and effort can be recommended for. */
export const ADVICE_STEPS = ["plan", "build", "review"] as const;
export type AdviceStep = (typeof ADVICE_STEPS)[number];

/** Who recorded a recommendation: the planner, the hub's default, or a step-up after a repeated finding. */
export const ADVICE_BYS = ["planner", "hub", "step-up"] as const;
export type AdviceBy = (typeof ADVICE_BYS)[number];

export const ADVICE_REASON_MAX = 300;
/** The longest model or effort name `report_plan` takes. */
export const MODEL_ADVICE_FIELD_MAX = 80;

/** A recommended model and effort for one step of a ticket, with the reason it was recommended. */
export interface ModelAdvice {
  step: AdviceStep;
  /** null: a stronger model than the seat's. */
  model: string | null;
  /** null: the CLI's default. */
  effort: string | null;
  reason: string;
  by: AdviceBy;
  at: number;
}

export const HUB_DEFAULT_REASON =
  "No trial has shown a cheaper choice is adequate yet, so the seat keeps its configured model and effort.";

/** The step a seat's loop works on; a watch loop or any other has none. */
export function adviceStepOf(loop: LoopKind | null | undefined): AdviceStep | null {
  return loop === "plan" || loop === "build" || loop === "review" ? loop : null;
}

/** The model-and-effort part of a run's ticket line, for example `sonnet-5.5 medium`. */
export const modelEffortText = (model: string | null, effort: string | null): string =>
  [model ?? "a stronger model", effort].filter((p) => p !== null && p !== "").join(" ");

const BY_TEXT: Record<AdviceBy, string> = {
  planner: "the planner",
  hub: "the hub",
  "step-up": "step-up",
};

/** The recommended part of a run's ticket line. */
export const adviceLineText = (a: ModelAdvice): string =>
  `recommended ${modelEffortText(a.model, a.effort)} by ${BY_TEXT[a.by]}: ${a.reason}`;

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
    reason: reason.length > ADVICE_REASON_MAX ? `${reason.slice(0, ADVICE_REASON_MAX - 1)}…` : reason,
    by: "step-up",
    at: i.at,
  };
}
