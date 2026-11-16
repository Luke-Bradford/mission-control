import { describe, expect, it } from "vitest";
import { classifySpecBounce } from "../src/spec-bounce.ts";

const DONE = ["A test covers the case"];

describe("classifySpecBounce", () => {
  it.each([
    ["scope-wider", "The PR changes the queue, which is outside the ticket.", DONE],
    ["missing-reference", "The ticket names no page and links no mockup.", DONE],
    ["ambiguous-wording", "The ticket wording is ambiguous: it could mean two things.", DONE],
    ["missing-reference", "The ticket does not name the page.", DONE],
    ["missing-reference", "The page reference is missing.", DONE],
    ["missing-reference", "The ticket doesn't name a page for the control.", DONE],
    ["no-done-when", "No Done-when line covers the empty case.", DONE],
    ["no-done-when", "The header is wrong.", []],
    ["other", "The header is wrong.", DONE],
  ] as const)("%s", (cause, text, doneWhen) => {
    expect(classifySpecBounce(text, doneWhen)).toBe(cause);
  });

  it("takes the first matching rule when a finding fits several", () => {
    expect(classifySpecBounce("Out of scope and ambiguous, no mockup.", DONE)).toBe("scope-wider");
  });

  it("is the same on every call for the same text", () => {
    expect(classifySpecBounce("Unclear.", DONE)).toBe(classifySpecBounce("Unclear.", DONE));
  });
});
