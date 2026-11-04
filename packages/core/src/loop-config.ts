/**
 * A template's loop as data: the steps, who runs each, its gate and the capped return paths.
 * The engine keeps its fixed shape (`reconcile` in loop.ts); config sets the trigger, names,
 * gates, caps and plan sizes, and a loop the engine cannot run is refused at load.
 */
import { PLAN_SIZES } from "./flight.ts";
import {
  type LoopDef,
  type LoopReturnDef,
  type LoopStepDef,
  type LoopStepId,
  SMALL_SIZES,
} from "./loop-config-model.ts";
import type { Profile } from "./profiles-model.ts";

export {
  LOOP_PROMPT_MAX,
  LOOP_REPORT_TOOLS,
  LOOP_RETURN_IDS,
  LOOP_RUNNERS,
  LOOP_STEP_IDS,
  type LoopDef,
  type LoopReturnDef,
  type LoopReturnId,
  type LoopStepDef,
  type LoopStepId,
  SMALL_SIZES,
} from "./loop-config-model.ts";

/** The order the engine runs the steps in; `plan` may come first. */
const ENGINE_ORDER: readonly LoopStepId[] = ["build", "ci", "review", "merge", "done"];
const MERGE_CONFLICT_CAP = 1;

/** Why the engine cannot run `def`, or null when it can. */
export function validateLoop(def: LoopDef): string | null {
  const refuse = (why: string): string => `loop ${def.name}: ${why}`;
  for (const r of def.returns) {
    if (!Number.isInteger(r.cap) || r.cap < 1) return refuse(`return path ${r.id} has no cap`);
    if (r.to !== "build") return refuse(`return path ${r.id} must return to build`);
    if (r.id === "merge-conflict" && r.cap !== MERGE_CONFLICT_CAP)
      return refuse("return path merge-conflict must have cap 1");
  }
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const returnsFrom = new Set(def.returns.map((r) => r.from));
  // Last step first, so the step that breaks the chain is the one named.
  for (const start of [...def.steps].reverse()) {
    const seen = new Set<LoopStepId>();
    let at: LoopStepDef | undefined = start;
    let stops = false;
    while (at !== undefined && !seen.has(at.id)) {
      seen.add(at.id);
      if (at.id === "done" || returnsFrom.has(at.id)) {
        stops = true;
        break;
      }
      at = at.next === null ? undefined : byId.get(at.next);
    }
    if (!stops) return refuse(`step ${start.id} cannot reach Done or FLIGHT`);
  }
  for (const s of def.steps) {
    if ((s.runner === "agent" || s.runner === "fresh-agent") && s.report === undefined)
      return refuse(`agent step ${s.id} has no report tool`);
  }
  const ids = def.steps.map((s) => s.id);
  const rest = ids[0] === "plan" ? ids.slice(1) : ids;
  if (rest.length !== ENGINE_ORDER.length || rest.some((id, i) => id !== ENGINE_ORDER[i]))
    return refuse(
      "the hub runs build, ci, review, merge and done in that order; plan is optional at the start",
    );
  return null;
}

const step = (
  id: LoopStepId,
  name: string,
  runner: LoopStepDef["runner"],
  gate: string,
  next: LoopStepId | null,
  extra: Partial<LoopStepDef> = {},
): LoopStepDef => ({ id, name, runner, gate, next, ...extra });

/** The loop the hub runs today for a template: the fixed steps with the profile's caps. */
export function standardLoop(
  p: Pick<Profile, "name" | "labels" | "planRequired" | "tries" | "rounds">,
): LoopDef {
  const steps: LoopStepDef[] = [
    ...(p.planRequired
      ? [
          step("plan", "Plan", "agent", "the ticket has a ## Plan", "build", {
            report: "report_plan",
            sizes: [...PLAN_SIZES],
          }),
        ]
      : []),
    step("build", "Build", "agent", "evidence is reported", "ci", { report: "report_evidence" }),
    step("ci", "CI checks", "check", "all required checks are green", "review"),
    step("review", "Review", "fresh-agent", "the review has no blocking findings", "merge", {
      report: "report_findings",
    }),
    step("merge", "Merge", "hub", "the PR is mergeable and cleared", "done"),
    step("done", "Done", "hub", "the PR is merged", null),
  ];
  const returns: LoopReturnDef[] = [
    { id: "ci-fail", label: "CI fails", from: "ci", to: "build", cap: p.tries },
    { id: "review-changes", label: "Review changes", from: "review", to: "build", cap: p.rounds },
    { id: "merge-conflict", label: "Merge conflicts", from: "merge", to: "build", cap: 1 },
  ];
  return {
    name: p.name,
    trigger: {
      labels: [...p.labels],
      sizes: p.name === "small-change" ? [...SMALL_SIZES] : [],
      ...(p.name === "feature" ? { fallback: true } : {}),
    },
    steps,
    returns,
  };
}

/** The profile's loop: its own, else today's. Null for an orchestration-only template. */
export function loopOf(p: Profile): LoopDef | null {
  if (p.orchestrationOnly) return null;
  return p.loop ?? standardLoop(p);
}

/** The CI try cap and the review round cap of a loop. */
export function loopLimits(def: LoopDef): { tries: number; rounds: number } {
  const cap = (id: LoopReturnDef["id"]): number => def.returns.find((r) => r.id === id)?.cap ?? 0;
  return { tries: cap("ci-fail"), rounds: cap("review-changes") };
}
