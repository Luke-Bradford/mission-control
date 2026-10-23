import { describe, expect, it } from "vitest";
import { ticketPlan } from "../src/agent/ticketPlan.ts";

describe("ticketPlan", () => {
  it("ticketPlan cuts the section", () => {
    const body = [
      "## Outcome",
      "x",
      "## Plan",
      "",
      "1. one",
      "```",
      "## x",
      "```",
      "~~~",
      "## y",
      "~~~",
      "2. two",
      "## Notes",
      "later",
    ].join("\n");
    const plan = ticketPlan(body);
    expect(plan).toBe("1. one\n```\n## x\n```\n~~~\n## y\n~~~\n2. two");
    expect(plan).not.toContain("later");
    expect(plan).not.toContain("Outcome");
  });

  it("runs to the end of the body, and ignores a plan heading inside a fence", () => {
    expect(ticketPlan("## Plan  \nstep")).toBe("step");
    expect(ticketPlan("```\n## Plan\nhidden\n```\ntext")).toBeNull();
  });

  it("gives null with no plan, or an empty one", () => {
    expect(ticketPlan("## Outcome\nx")).toBeNull();
    expect(ticketPlan("## Plan\n\n## Notes\nx")).toBeNull();
    expect(ticketPlan("## Planning\nx")).toBeNull();
  });
});
