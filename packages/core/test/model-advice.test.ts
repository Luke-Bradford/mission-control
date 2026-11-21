import { describe, expect, it } from "vitest";
import { adviceLineText, adviceStepOf, modelEffortText } from "../src/model-advice.ts";

describe("model advice", () => {
  it("maps a loop to its step, and a watch loop to none", () => {
    expect(adviceStepOf("plan")).toBe("plan");
    expect(adviceStepOf("build")).toBe("build");
    expect(adviceStepOf("review")).toBe("review");
    expect(adviceStepOf("watch")).toBeNull();
    expect(adviceStepOf(undefined)).toBeNull();
  });

  it("words the ticket line from the advice", () => {
    expect(modelEffortText("sonnet-5.5", "medium")).toBe("sonnet-5.5 medium");
    expect(modelEffortText("sonnet-5.5", null)).toBe("sonnet-5.5");
    expect(modelEffortText(null, "high")).toBe("a stronger model high");
    expect(
      adviceLineText({
        step: "build",
        model: "opus-5.5",
        effort: "high",
        reason: "hard change",
        by: "planner",
        at: 1,
      }),
    ).toBe("recommended opus-5.5 high by the planner: hard change");
  });
});
