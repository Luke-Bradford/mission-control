import { describe, expect, it } from "vitest";
import {
  CI_TRIES,
  DEFAULT_PROFILES,
  type LoopDef,
  loopLimits,
  loopOf,
  PLAN_SIZES,
  REVIEW_ROUNDS,
  standardLoop,
  validateLoop,
} from "../src/index.ts";

const loopNamed = (name: string): LoopDef => {
  const p = DEFAULT_PROFILES.find((d) => d.name === name);
  const loop = p === undefined ? null : loopOf(p);
  if (loop === null) throw new Error(name);
  return loop;
};

describe("built-in loops", () => {
  it("feature loop carries today's caps, gates and targets", () => {
    const feature = loopNamed("feature");
    expect(loopLimits(feature)).toEqual({ tries: CI_TRIES, rounds: REVIEW_ROUNDS });
    expect(feature.steps.find((s) => s.id === "plan")?.sizes).toEqual(PLAN_SIZES);
    expect(feature.steps.map((s) => [s.id, s.runner, s.gate, s.next, s.report])).toEqual([
      ["plan", "agent", "the ticket has a ## Plan", "build", "report_plan"],
      ["build", "agent", "evidence is reported", "ci", "report_evidence"],
      ["ci", "check", "all required checks are green", "review", undefined],
      ["review", "fresh-agent", "the review has no blocking findings", "merge", "report_findings"],
      ["merge", "hub", "the PR is mergeable and cleared", "done", undefined],
      ["done", "hub", "the PR is merged", null, undefined],
    ]);
    expect(feature.returns).toEqual([
      { id: "ci-fail", label: "CI fails", from: "ci", to: "build", cap: 3 },
      { id: "review-changes", label: "Review changes", from: "review", to: "build", cap: 3 },
      { id: "merge-conflict", label: "Merge conflicts", from: "merge", to: "build", cap: 1 },
    ]);
  });

  it("every executable built-in validates; orchestration-only ones carry no loop", () => {
    for (const p of DEFAULT_PROFILES) {
      const loop = loopOf(p);
      if (p.orchestrationOnly) expect(loop).toBeNull();
      else expect(validateLoop(loop as LoopDef)).toBeNull();
    }
  });

  it.each([
    ["bugfix", 3, 3, true],
    ["small-change", 2, 2, false],
    ["docs", 2, 2, false],
    ["research", 2, 2, false],
  ])("%s has caps %i and %i, plan step %s", (name, tries, rounds, plan) => {
    const loop = loopNamed(name);
    expect(loopLimits(loop)).toEqual({ tries, rounds });
    expect(loop.steps.some((s) => s.id === "plan")).toBe(plan);
    expect(loop.steps.map((s) => s.id).slice(-5)).toEqual([
      "build",
      "ci",
      "review",
      "merge",
      "done",
    ]);
  });

  it("a stored loop wins over the standard one", () => {
    const p = DEFAULT_PROFILES.find((d) => d.name === "feature");
    if (p === undefined) throw new Error("feature");
    const own = { ...standardLoop(p), name: "own" };
    expect(loopOf({ ...p, loop: own })).toBe(own);
  });
});

describe("validateLoop refuses", () => {
  const feature = (): LoopDef => structuredClone(loopNamed("feature"));
  const ret = (d: LoopDef, id: string) => {
    const r = d.returns.find((x) => x.id === id);
    if (r === undefined) throw new Error(id);
    return r;
  };
  const step = (d: LoopDef, id: string) => {
    const s = d.steps.find((x) => x.id === id);
    if (s === undefined) throw new Error(id);
    return s;
  };

  it.each<[string, (d: LoopDef) => void, string]>([
    [
      "no cap",
      (d) => {
        // biome-ignore lint/suspicious/noExplicitAny: a file may omit the cap
        (ret(d, "ci-fail") as any).cap = undefined;
      },
      "loop feature: return path ci-fail has no cap",
    ],
    [
      "a cap of 0",
      (d) => {
        ret(d, "review-changes").cap = 0;
      },
      "loop feature: return path review-changes has no cap",
    ],
    [
      "return to plan",
      (d) => {
        ret(d, "review-changes").to = "plan";
      },
      "loop feature: return path review-changes must return to build",
    ],
    [
      "merge conflict with another cap",
      (d) => {
        ret(d, "merge-conflict").cap = 2;
      },
      "loop feature: return path merge-conflict must have cap 1",
    ],
    [
      "ci with next null and no return",
      (d) => {
        step(d, "ci").next = null;
        d.returns = d.returns.filter((r) => r.from !== "ci");
      },
      "loop feature: step ci cannot reach Done or FLIGHT",
    ],
    [
      "agent step with no report tool",
      (d) => {
        delete step(d, "build").report;
      },
      "loop feature: agent step build has no report tool",
    ],
    [
      "steps out of order",
      (d) => {
        const [ci, review] = [step(d, "ci"), step(d, "review")];
        d.steps = d.steps.map((s) => (s === ci ? review : s === review ? ci : s));
      },
      "loop feature: the hub runs build, ci, review, merge and done in that order; plan is optional at the start",
    ],
  ])("%s", (_name, mutate, text) => {
    const d = feature();
    mutate(d);
    expect(validateLoop(d)).toBe(text);
  });

  it("accepts a clean feature loop", () => {
    expect(validateLoop(feature())).toBeNull();
  });
});
