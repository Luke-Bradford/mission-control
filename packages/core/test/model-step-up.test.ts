import { describe, expect, it } from "vitest";
import { stepUpAdvice, stepUpReason } from "../src/model-step-up.ts";

describe("stepUpAdvice", () => {
  const f = (file: string, category?: string, severity = "Important") =>
    ({ severity, file, line: 1, summary: "s", scenario: "x", fix: "f", category }) as never;
  const base = { round: 2, model: "sonnet-5.5", at: 5 };

  it("raises effort on a repeated class", () => {
    const a = stepUpAdvice({
      ...base,
      effort: "medium",
      previous: [f("a.ts", "security")],
      current: [f("b.ts", "security")],
    });
    expect(a).toMatchObject({ step: "build", model: "sonnet-5.5", effort: "high", by: "step-up" });
    expect(a?.reason).toBe(stepUpReason(["security"], 2));
    expect(a?.reason.length).toBeLessThanOrEqual(300);
  });

  it("raises high to max on the same model", () => {
    const a = stepUpAdvice({
      ...base,
      effort: "high",
      previous: [f("a.ts")],
      current: [f("a.ts")],
    });
    expect(a).toMatchObject({ model: "sonnet-5.5", effort: "max" });
  });

  it("asks for a stronger model at max, null or a Codex effort", () => {
    const i = { ...base, previous: [f("a.ts")], current: [f("a.ts")] };
    expect(stepUpAdvice({ ...i, effort: "max" })).toMatchObject({ model: null, effort: "max" });
    expect(stepUpAdvice({ ...i, effort: null })).toMatchObject({ model: null, effort: null });
    expect(stepUpAdvice({ ...i, effort: "xhigh" })).toMatchObject({ model: null, effort: "xhigh" });
  });

  it("uses the file as the class when there is no category", () => {
    const a = stepUpAdvice({
      ...base,
      effort: "low",
      previous: [f("a.ts")],
      current: [f("a.ts")],
    });
    expect(a?.reason).toContain("file a.ts");
    expect(a?.effort).toBe("medium");
  });

  it("does nothing in round 1, with no shared class, or for non-blocking findings", () => {
    const i = { ...base, effort: "medium" };
    expect(
      stepUpAdvice({ ...i, round: 1, previous: [f("a.ts")], current: [f("a.ts")] }),
    ).toBeNull();
    expect(stepUpAdvice({ ...i, previous: [f("a.ts")], current: [f("b.ts")] })).toBeNull();
    expect(
      stepUpAdvice({ ...i, previous: [f("a.ts")], current: [f("a.ts", undefined, "Minor")] }),
    ).toBeNull();
  });
});
