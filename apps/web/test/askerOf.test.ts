import { describe, expect, it } from "vitest";
import { askerOf, bandCallSign } from "../src/needs/QuestionBand.tsx";
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
  it("the band writes a seat id as a call sign when no crew row names it", () => {
    const asked = item({ agentId: "guido-1" });
    expect(askerOf(asked, bandCallSign(asked, undefined))).toBe("GUIDO-1");
    expect(askerOf(asked)).toBe("guido-1");
  });
});
