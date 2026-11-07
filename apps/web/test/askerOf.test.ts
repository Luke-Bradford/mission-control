import { describe, expect, it } from "vitest";
import { askerOf } from "../src/needs/QuestionBand.tsx";
import { brief, item } from "./fixtures.ts";

describe("askerOf (#1543)", () => {
  it("names the hub for an alert, even when it names a seat", () => {
    expect(askerOf(item({ agentId: "guido-1", alert: true }), "GUIDO-1")).toBe("the hub");
  });
  it("names the seat by its call sign, else FLIGHT for its brief, else the hub", () => {
    expect(askerOf(item({ agentId: "guido-1" }), "GUIDO-1")).toBe("GUIDO-1");
    expect(askerOf(item({ agentId: null, brief: brief({ for: "operator" }) }))).toBe("FLIGHT");
    expect(askerOf(item({ agentId: null, brief: undefined }))).toBe("the hub");
  });
});
