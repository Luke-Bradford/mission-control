/** Shapes of a template's loop: the steps the engine runs and the paths back to Build. */

/** The sizes that go to small-change when no template label matches. */
export const SMALL_SIZES: readonly string[] = ["XS", "S"];

export const LOOP_STEP_IDS = ["plan", "build", "ci", "review", "merge", "done"] as const;
export type LoopStepId = (typeof LOOP_STEP_IDS)[number];

export const LOOP_RETURN_IDS = ["ci-fail", "review-changes", "merge-conflict"] as const;
export type LoopReturnId = (typeof LOOP_RETURN_IDS)[number];

export const LOOP_RUNNERS = ["agent", "check", "fresh-agent", "hub"] as const;
export const LOOP_REPORT_TOOLS = ["report_plan", "report_evidence", "report_findings"] as const;
export const LOOP_PROMPT_MAX = 2000;
/** The most times one return path may send a run back to Build. */
export const LOOP_CAP_MAX = 10;

/** What the engine fixes for each step: who runs it, where it goes next and which tool it reports with. */
export const LOOP_STEP_SHAPE: Record<
  LoopStepId,
  {
    runner: (typeof LOOP_RUNNERS)[number];
    next: LoopStepId | null;
    report: (typeof LOOP_REPORT_TOOLS)[number] | null;
  }
> = {
  plan: { runner: "agent", next: "build", report: "report_plan" },
  build: { runner: "agent", next: "ci", report: "report_evidence" },
  ci: { runner: "check", next: "review", report: null },
  review: { runner: "fresh-agent", next: "merge", report: "report_findings" },
  merge: { runner: "hub", next: "done", report: null },
  done: { runner: "hub", next: null, report: null },
};

/** The step each return path leaves from. */
export const LOOP_RETURN_FROM: Record<LoopReturnId, LoopStepId> = {
  "ci-fail": "ci",
  "review-changes": "review",
  "merge-conflict": "merge",
};

export interface LoopStepDef {
  id: LoopStepId;
  name: string;
  runner: (typeof LOOP_RUNNERS)[number];
  /** Completes "You exit when ...". */
  gate: string;
  next: LoopStepId | null;
  /** Required on agent steps. */
  report?: (typeof LOOP_REPORT_TOOLS)[number];
  /** The plan step only: the Sizes that need a plan. */
  sizes?: string[];
  model?: string;
  effort?: string;
  /** At most `LOOP_PROMPT_MAX` characters. */
  prompt?: string;
}

export interface LoopReturnDef {
  id: LoopReturnId;
  label: string;
  from: LoopStepId;
  to: LoopStepId;
  cap: number;
}

export interface LoopDef {
  name: string;
  trigger: { labels: string[]; sizes: string[]; fallback?: boolean };
  steps: LoopStepDef[];
  returns: LoopReturnDef[];
}
