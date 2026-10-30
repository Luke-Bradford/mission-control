import { describe, expect, it } from "vitest";
import {
  AUDIT_EXPECTED_TOKENS_DEFAULT,
  classifyOveruse,
  groupOveruse,
  overusePrevention,
  tokenBaselines,
} from "../src/audit.ts";

const facts = (over: Partial<Parameters<typeof classifyOveruse>[0]> = {}) => ({
  size: "M" as string | null,
  reviewRounds: 1,
  blocking: 0,
  blockingByCategory: {} as Record<string, number>,
  turns: 40 as number | null,
  ...over,
});

describe("tokenBaselines", () => {
  const sample = (size: string | null, tokens: number) => ({ size, tokens });

  it("uses the default for a size with fewer than five runs", () => {
    const b = tokenBaselines([sample("M", 10), sample("M", 20), sample("M", 30), sample("M", 40)]);
    expect(b.bySize.get("M")).toBeUndefined();
    expect(b.expected("M")).toBe(AUDIT_EXPECTED_TOKENS_DEFAULT);
    expect(b.expected(null)).toBe(AUDIT_EXPECTED_TOKENS_DEFAULT);
  });

  it("takes 1.5 times the median of each size's runs, sizes apart", () => {
    const m = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((t) => sample("M", t));
    const s = [10, 20, 30, 40, 50].map((t) => sample("S", t));
    const b = tokenBaselines([...m, ...s]);
    expect(b.expected("M")).toBe(825);
    expect(b.expected("S")).toBe(45);
    expect(b.expected("L")).toBe(AUDIT_EXPECTED_TOKENS_DEFAULT);
  });

  it("groups runs with no size together", () => {
    const b = tokenBaselines([1, 2, 3, 4, 5].map((t) => sample(null, t * 1000)));
    expect(b.expected(null)).toBe(4500);
    expect(b.expected("M")).toBe(AUDIT_EXPECTED_TOKENS_DEFAULT);
  });
});

describe("classifyOveruse", () => {
  it("calls many rounds or many blocking findings rework churn", () => {
    expect(classifyOveruse(facts({ reviewRounds: 14, blocking: 68 }))).toBe("rework-churn");
    expect(classifyOveruse(facts({ reviewRounds: 2, blocking: 12 }))).toBe("rework-churn");
  });

  it("calls findings about scope or spec a plan that missed files", () => {
    expect(
      classifyOveruse(
        facts({
          reviewRounds: 5,
          blocking: 8,
          blockingByCategory: { scope: 3, spec: 2, style: 3 },
        }),
      ),
    ).toBe("plan-gap");
  });

  it("calls stale or wrong test findings a flaky test loop", () => {
    expect(
      classifyOveruse(
        facts({
          reviewRounds: 5,
          blocking: 6,
          blockingByCategory: { "test-wrong": 2, "test-stale": 2, correctness: 2 },
        }),
      ),
    ).toBe("flaky-test-loop");
  });

  it("calls a large ticket with little rework too wide", () => {
    expect(classifyOveruse(facts({ size: "XL" }))).toBe("wide-ticket");
    expect(classifyOveruse(facts({ size: "L", reviewRounds: 2, blocking: 2 }))).toBe("wide-ticket");
  });

  it("says unexplained when nothing points anywhere", () => {
    expect(classifyOveruse(facts())).toBe("unexplained");
    expect(classifyOveruse(facts({ size: null, turns: null }))).toBe("unexplained");
  });
});

describe("overusePrevention and groupOveruse", () => {
  it("proposes a lesson, a plan rule or a split rule per cause", () => {
    expect(overusePrevention("rework-churn").kind).toBe("lesson");
    expect(overusePrevention("flaky-test-loop").kind).toBe("lesson");
    expect(overusePrevention("plan-gap").kind).toBe("plan-rule");
    expect(overusePrevention("wide-ticket").kind).toBe("split-rule");
    expect(overusePrevention("unexplained").text).not.toBe("");
  });

  it("groups runs by cause, most runs first, with the prevention", () => {
    const g = groupOveruse([
      { runId: "a", cause: "plan-gap" },
      { runId: "b", cause: "rework-churn" },
      { runId: "c", cause: "rework-churn" },
    ]);
    expect(g.map((x) => [x.cause, x.runIds, x.prevention.kind])).toEqual([
      ["rework-churn", ["b", "c"], "lesson"],
      ["plan-gap", ["a"], "plan-rule"],
    ]);
  });
});
