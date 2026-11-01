import { describe, expect, it } from "vitest";
import {
  CODE_HEALTH_READ_INPUT_SCHEMA,
  CODE_HEALTH_RULES,
  type CodeHealthFinding,
  type CodeHealthReviewRound,
  type CodeHealthTestAttempt,
  codeHealthDurationMs,
  codeHealthFileIncidence,
  codeHealthFindingCategories,
  codeHealthRate,
  codeHealthReviewRounds,
  codeHealthTestRate,
  codeHealthWindowBounds,
} from "../src/code-health.ts";
import { MC_TOOL_NAMES, MC_TOOLS } from "../src/mcp.ts";
import { BUILTIN_ROLES } from "../src/runtime.ts";

const review = (pr: number, round = 1): CodeHealthReviewRound => ({
  reviewId: `review-${pr}-${round}`,
  repoId: "sample",
  pr,
  headSha: "a".repeat(40),
  round,
  state: "reported",
});
const finding = (id: number, pr: number, category: string | null = null): CodeHealthFinding => ({
  findingId: `finding-${id}`,
  repoId: "sample",
  pr,
  reviewId: `review-${pr}`,
  headSha: "a".repeat(40),
  file: "src/example.ts",
  category,
  state: "open",
});
const attempt = (id: number, state: CodeHealthTestAttempt["state"]): CodeHealthTestAttempt => ({
  attemptId: `attempt-${id}`,
  testId: "example:invariant",
  repoId: "sample",
  headSha: "a".repeat(40),
  workflow: "checks",
  job: "unit",
  state,
  completedAt: id,
  duration: 0.1,
  durationUnit: "s",
  environment: "fixture",
});

describe("code-health definitions", () => {
  it("uses rolling half-open windows without local daylight-saving arithmetic", () => {
    const until = Date.UTC(2026, 10, 1, 12);
    expect(codeHealthWindowBounds("7d", until)).toEqual({ from: until - 604_800_000, until });
    expect(codeHealthWindowBounds("30d", until).from).toBe(until - 2_592_000_000);
    expect(codeHealthWindowBounds("90d", until).from).toBe(until - 7_776_000_000);
    expect(() => codeHealthWindowBounds("7d", Number.NaN)).toThrow();
    expect(() => codeHealthWindowBounds("7d", -1)).toThrow();
  });

  it("keeps an empty or incomplete denominator distinct from an observed zero", () => {
    expect(codeHealthRate(0, 0, true).percent).toBeNull();
    expect(codeHealthRate(0, 8, true).percent).toBe(0);
    expect(codeHealthRate(3, 8, false)).toEqual({ numerator: 3, denominator: 8, percent: null });
    expect(() => codeHealthRate(9, 8, true)).toThrow();
    expect(() => codeHealthRate(1, 1.5, true)).toThrow();
    expect(() => codeHealthRate(-1, 8, true)).toThrow();
  });

  it("reproduces the reported-PR cohort without counting review rows as PRs", () => {
    const rows: CodeHealthReviewRound[] = [];
    let pr = 0;
    for (const [round, count] of [
      [1, 103],
      [2, 128],
      [3, 87],
      [4, 2],
    ]) {
      for (let i = 0; i < count; i++) {
        pr++;
        for (let n = 1; n <= round; n++) rows.push(review(pr, n));
      }
    }
    rows.push({ ...review(321), state: "pending" }, { ...review(322), state: "failed" });
    rows.push(rows[0], { ...review(1, 12), repoId: "another-repo" });
    const result = codeHealthReviewRounds(rows, "sample");
    expect(result.reviewedPrs).toBe(320);
    expect(result.rounds.map((row) => row.prs)).toEqual([103, 128, 87, 2]);
    expect(result.rework.numerator).toBe(217);
    expect(result.rework.percent?.toFixed(1)).toBe("67.8");
    expect(result.threeOrMoreRounds.numerator).toBe(89);
    expect(result.threeOrMoreRounds.percent?.toFixed(1)).toBe("27.8");
  });

  it("groups round 4+ and excludes pending attempts even when their round is higher", () => {
    expect(
      codeHealthReviewRounds([review(1, 9), { ...review(2, 99), state: "pending" }], "sample"),
    ).toMatchObject({ reviewedPrs: 1, rounds: [{ prs: 0 }, { prs: 0 }, { prs: 0 }, { prs: 1 }] });
    expect(codeHealthReviewRounds([], "sample").rework.percent).toBeNull();
    expect(() => codeHealthReviewRounds([review(1, 0)], "sample")).toThrow();
  });

  it("refuses conflicting identities rather than silently selecting a convenient snapshot", () => {
    const row = review(1);
    expect(() => codeHealthReviewRounds([row, { ...row, round: 2 }], "sample")).toThrow(/identity/);
    const f = finding(1, 1);
    expect(() => codeHealthFindingCategories([f, { ...f, category: "spec" }], "sample")).toThrow(
      /identity/,
    );
  });

  it("retains uncategorised coverage and counts duplicate finding snapshots once", () => {
    const rows = Array.from({ length: 2277 }, (_, i) => finding(i, 1, i < 915 ? null : "spec"));
    rows.push(rows[0], { ...finding(9999, 1, "security"), repoId: "another-repo" });
    const result = codeHealthFindingCategories(rows, "sample");
    expect(result.uncategorised).toMatchObject({ numerator: 915, denominator: 2277 });
    expect(result.uncategorised.percent?.toFixed(1)).toBe("40.2");
    expect(result.categories).toEqual([{ category: "spec", findings: 1362 }]);
    expect(
      codeHealthFindingCategories([finding(1, 1, "  ")], "sample").uncategorised.numerator,
    ).toBe(1);
  });

  it("intersects eligible changed PRs, with multiple findings and outside-diff counts separate", () => {
    const input = {
      repoId: "sample",
      file: "src/example.ts",
      eligiblePrs: [1, 2, 3].map((pr) => ({ repoId: "sample", pr })),
      changedPrs: [1, 2, 2, 99].map((pr) => ({ repoId: "sample", pr })),
      findings: [
        finding(1, 1),
        finding(2, 1),
        finding(3, 3),
        finding(4, 99),
        { ...finding(5, 2), repoId: "another-repo" },
        { ...finding(6, 2), file: "other.ts" },
      ],
      changedFilesComplete: true,
    };
    expect(codeHealthFileIncidence(input)).toEqual({
      findings: 3,
      outsideDiffFindings: 1,
      incidence: { numerator: 1, denominator: 2, percent: 50 },
    });
    expect(codeHealthFileIncidence({ ...input, changedFilesComplete: false })).toMatchObject({
      outsideDiffFindings: null,
      incidence: { percent: null },
    });
  });

  it("counts executed test attempts, excluding cancellation, skip and not-run observations", () => {
    const rows = [
      attempt(1, "passed"),
      attempt(2, "failed"),
      attempt(3, "skipped"),
      attempt(4, "cancelled"),
      attempt(5, "not-run"),
    ];
    rows.push(rows[1], { ...attempt(6, "failed"), repoId: "another-repo" });
    expect(codeHealthTestRate(rows, "sample", true)).toEqual({
      numerator: 1,
      denominator: 2,
      percent: 50,
    });
    expect(codeHealthTestRate(rows, "sample", false).percent).toBeNull();
    expect(codeHealthTestRate([attempt(1, "cancelled")], "sample", true).percent).toBeNull();
    expect(() =>
      codeHealthTestRate([rows[0], { ...rows[0], state: "failed" }], "sample", true),
    ).toThrow(/identity/);
  });

  it("normalises only documented units and environments", () => {
    expect(codeHealthDurationMs(0.25, "s", "fixture")).toBe(250);
    expect(codeHealthDurationMs(250, "ms", "fixture")).toBe(250);
    expect(codeHealthDurationMs(0, "ms", "fixture")).toBe(0);
    expect(codeHealthDurationMs(600000, null, "fixture")).toBeNull();
    expect(codeHealthDurationMs(250, "ms", null)).toBeNull();
    expect(codeHealthDurationMs(null, "ms", "fixture")).toBeNull();
    expect(() => codeHealthDurationMs(-1, "ms", "fixture")).toThrow();
    expect(() => codeHealthDurationMs(Number.POSITIVE_INFINITY, "s", "fixture")).toThrow();
  });

  it("exposes a read-only tool to FLIGHT and FAO with no writer-role grant", () => {
    expect(MC_TOOL_NAMES.codeHealth).toBe("code_health");
    expect(MC_TOOLS.codeHealth).toBe("mcp__mc__code_health");
    expect(BUILTIN_ROLES.FLIGHT.tools).toContain(MC_TOOL_NAMES.codeHealth);
    expect(BUILTIN_ROLES.FAO.tools).toContain(MC_TOOL_NAMES.codeHealth);
    expect(BUILTIN_ROLES.GUIDO.tools).not.toContain(MC_TOOL_NAMES.codeHealth);
    expect(CODE_HEALTH_READ_INPUT_SCHEMA.additionalProperties).toBe(false);
    expect(CODE_HEALTH_RULES.recurringCorrection).toEqual({
      windowDays: 30,
      findings: 3,
      distinctPrs: 2,
    });
    expect(CODE_HEALTH_RULES.repeatedlyChangedLargeFile).toEqual({
      windowDays: 30,
      lines: 1000,
      mergedPrTouches: 5,
    });
    expect(CODE_HEALTH_RULES.mixedCi.classification).toBe("candidate");
  });
});
