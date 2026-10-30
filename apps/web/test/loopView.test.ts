import {
  CI_TRIES,
  DEFAULT_PROFILES,
  type LoopTry,
  pushChecksText,
  REVIEW_ROUNDS,
  REVIEW_STATUS_RUNNING,
  type RunLoop,
  type RunView,
} from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  barClass,
  barPlace,
  ciCheck,
  heldStep,
  loopRule,
  loopSpan,
  reasonLine,
  reviewChecks,
  runLimits,
  stepChecks,
  stepTries,
  tryClass,
  tryMinutes,
  tryText,
} from "../src/agent/loopView.ts";
import { MIN, NOW, prView, run } from "./fixtures.ts";

const loop = (over: Partial<RunLoop> = {}) =>
  ({
    phase: "ci",
    prNumber: 77,
    pushFor: "abc1234def5678",
    epoch: 1,
    budgetExtra: 0,
    ...over,
  }) as RunLoop;

const tryOf = (over: Partial<LoopTry> = {}): LoopTry => ({
  step: "ci",
  fix: false,
  n: 1,
  startedAt: 0,
  endedAt: 9 * MIN,
  outcome: "pass",
  reason: null,
  ...over,
});

describe("ciCheck", () => {
  const pr = (over = {}) => prView({ number: 77, headSha: "abc1234def5678", ...over });

  it("ciCheck words each case", () => {
    expect(ciCheck(loop({ pushFor: null }), [pr()])).toEqual({
      text: "Nothing pushed yet",
      state: "wait",
    });
    const waiting = {
      text: "CI on abc1234: waiting for the push to show on GitHub",
      state: "wait",
    };
    expect(ciCheck(loop(), [])).toEqual(waiting);
    expect(ciCheck(loop(), undefined)).toEqual(waiting);
    expect(ciCheck(loop(), [pr({ number: 78 })])).toEqual(waiting);
    expect(ciCheck(loop(), [pr({ headSha: "fff0000" })])).toEqual(waiting);
    expect(ciCheck(loop(), [pr({ ci: "passing" })])).toEqual({
      text: "CI on abc1234",
      state: "pass",
    });
    expect(ciCheck(loop(), [pr({ ci: "failing" })])).toEqual({
      text: "CI on abc1234",
      state: "fail",
    });
    expect(ciCheck(loop(), [pr({ ci: "pending" })])).toEqual({
      text: "CI on abc1234",
      state: "run",
    });
    expect(ciCheck(loop(), [pr({ ci: null })])).toEqual({
      text: "CI on abc1234: no CI reported yet",
      state: "wait",
    });
  });
});

describe("reviewChecks", () => {
  it("reviewChecks maps the status", () => {
    expect(reviewChecks(null, 77)).toEqual([
      { text: "No QA review yet", state: "wait" },
      { text: "PR #77 merged", state: "wait" },
    ]);
    const first = (state: "pending" | "success" | "failure", description: string) =>
      reviewChecks({ state, description }, null)[0];
    expect(first("pending", REVIEW_STATUS_RUNNING)).toEqual({
      text: REVIEW_STATUS_RUNNING,
      state: "run",
    });
    expect(first("pending", "QA review queued")).toEqual({
      text: "QA review queued",
      state: "wait",
    });
    expect(first("success", "QA review passed")?.state).toBe("pass");
    expect(first("failure", "QA review found blocking issues")?.state).toBe("fail");
    expect(reviewChecks(null, null)[1]).toEqual({ text: "PR merged", state: "wait" });
  });

  it("stepChecks has none for Working and Done", () => {
    expect(stepChecks("working", loop(), null, [])).toEqual([]);
    expect(stepChecks("done", loop(), null, [])).toEqual([]);
    expect(stepChecks("ci", loop(), null, [])).toHaveLength(1);
    expect(stepChecks("review", loop(), null, [])).toHaveLength(2);
  });
});

describe("try helpers", () => {
  it("try helpers", () => {
    const failed = tryOf({ outcome: "fail", reason: "x" });
    expect(tryText(failed)).toBe("fail: x");
    expect(tryText(tryOf())).toBe("pass");
    expect(tryClass(failed)).toBe("crit-t");
    expect(tryClass(tryOf({ outcome: "parked" }))).toBe("crit-t");
    expect(tryClass(tryOf({ outcome: "stopped" }))).toBe("crit-t");
    expect(tryClass(tryOf({ outcome: "running" }))).toBe("fg2");
    expect(tryClass(tryOf({ outcome: "waiting" }))).toBe("fg2");
    expect(tryClass(tryOf())).toBe("ok-t");
    expect(barClass(failed)).toBe("tl-fail");
    expect(barClass(tryOf({ fix: true, outcome: "fail" }))).toBe("tl-fix");
    expect(barClass(tryOf({ outcome: "stopped" }))).toBe("tl-fail");
    expect(barClass(tryOf({ outcome: "running" }))).toBe("tl-run");
    expect(barClass(tryOf({ outcome: "waiting" }))).toBe("tl-wait");
    expect(barClass(tryOf({ outcome: "parked" }))).toBe("tl-wait");
    expect(barClass(tryOf())).toBe("tl-pass");
    expect(tryMinutes(tryOf({ startedAt: 0, endedAt: null }), 9.4 * MIN)).toBe(9);
    expect(tryMinutes(tryOf({ startedAt: 0, endedAt: 19 * MIN }), 99 * MIN)).toBe(19);
  });

  it("picks the held step and a step's tries, fixes included", () => {
    const tries = [
      tryOf({ step: "working" }),
      tryOf({ step: "review", fix: true }),
      tryOf({ step: "review" }),
    ];
    expect(heldStep(tries)).toBe("review");
    expect(heldStep([])).toBeNull();
    expect(stepTries(tries, "review")).toHaveLength(2);
    expect(stepTries(tries, "ci")).toEqual([]);
  });
});

describe("barPlace", () => {
  it("barPlace", () => {
    const { end, total } = loopSpan(0, 40 * MIN, NOW);
    expect(total).toBe(40 * MIN);
    expect(barPlace(tryOf({ startedAt: 10 * MIN, endedAt: 19 * MIN }), 0, end, total)).toEqual({
      left: 25,
      width: 22.5,
    });
    expect(barPlace(tryOf({ startedAt: 30 * MIN, endedAt: null }), 0, end, total)).toEqual({
      left: 75,
      width: 25,
    });
    expect(loopSpan(5, null, 5).total).toBe(1);
  });
});

describe("loopRule", () => {
  it("states the parking rule of CI and review only", () => {
    const limits = { tries: 3, rounds: 2 };
    expect(loopRule("ci", limits)).toBe("↻ fail → back to Working · parks after 3 failures");
    expect(loopRule("review", limits)).toBe(
      "↻ Critical or Important findings → fix → CI → review · parks after 2 rounds",
    );
    expect(loopRule("working", limits)).toBeNull();
    expect(loopRule("done", limits)).toBeNull();
  });
});

describe("runLimits", () => {
  it("runLimits", () => {
    expect(runLimits()).toEqual({ tries: CI_TRIES, rounds: REVIEW_ROUNDS });
    expect(runLimits({ ...run(), prs: [] })).toEqual({ tries: CI_TRIES, rounds: REVIEW_ROUNDS });
    const profile = DEFAULT_PROFILES.find((p) => p.name === "small-change");
    if (!profile) throw new Error("no small-change profile");
    const small: RunView = {
      ...run(),
      prs: [],
      profile: { profile, route: { by: "label", label: "chore" }, hash: "h" },
    };
    expect(runLimits(small)).toEqual({ tries: profile.tries, rounds: profile.rounds });
  });
});

describe("reasonLine", () => {
  const refusal = pushChecksText("80001f8abcdef", [{ command: "pnpm -s test", state: "missing" }]);

  it("reads the hub's push refusal as one line naming the check and the commit", () => {
    expect(reasonLine(refusal)).toEqual({
      line: "push refused: `pnpm -s test` not run on 80001f8",
      full: refusal,
    });
  });

  it("says failed for a failed check and counts the others", () => {
    const text = pushChecksText("80001f8abcdef", [
      { command: "pnpm -s lint", state: "failed" },
      { command: "pnpm -s test", state: "missing" },
      { command: "pnpm -s build", state: "missing" },
    ]);
    expect(reasonLine(text).line).toBe("push refused: `pnpm -s lint` failed on 80001f8 (+2 more)");
  });

  it("keeps a short one-line reason whole, with no full text to open", () => {
    expect(reasonLine("CI cap reached")).toEqual({ line: "CI cap reached", full: null });
  });

  it("cuts other long or multi-line text to its first line, keeping the whole", () => {
    const long = `${"word ".repeat(60)}end`;
    const cut = reasonLine(long);
    expect(cut.line.length).toBeLessThanOrEqual(120);
    expect(cut.line.endsWith("…")).toBe(true);
    expect(cut.full).toBe(long);
    expect(reasonLine("first\nsecond")).toEqual({ line: "first", full: "first\nsecond" });
  });
});

describe("parkNote and tryCode", () => {
  it("names a review park by its count and sha, and a refusal by a code", async () => {
    const { parkNote, tryCode } = await import("../src/agent/loopView.ts");
    const note = parkNote(
      "RETRO reviewed c74cdfc and found 2 issues. Long text.",
      "review",
      "c74cdfc99",
    );
    expect(note.step).toBe("waiting: 2 findings held on c74cdfc");
    expect(note.header).toBe("Parked · review findings on c74cdfc · 2 held");
    expect(parkNote("whatever\nmore", "no-ci").step).toBe("parked: no CI reported");
    expect(parkNote("x".repeat(500)).step.length).toBeLessThanOrEqual(60);
    const t = {
      step: "ci",
      fix: false,
      n: 1,
      startedAt: 0,
      endedAt: 1,
      outcome: "fail",
      reason: "lint\nmore",
    } as const;
    expect(tryCode(t)).toBe("CI failed: lint");
  });
});
