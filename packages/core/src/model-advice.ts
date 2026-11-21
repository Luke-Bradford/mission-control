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
