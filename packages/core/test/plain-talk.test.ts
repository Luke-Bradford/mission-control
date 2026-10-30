import { describe, expect, it } from "vitest";
import { plainTalkProblems } from "../src/plain-talk.ts";

describe("plainTalkProblems", () => {
  it("passes a short, plain run report", () => {
    const report = [
      "Done: seats can invoke the repo's skills.",
      "Not done: the CLAUDE.md Skills section.",
      "Next: FLIGHT adds it.",
    ].join("\n");
    expect(plainTalkProblems(report)).toEqual([]);
  });

  it.each([
    ["an exclamation mark", "All done!", "has an exclamation mark"],
    ["a hedge", "I think the tests pass.", 'uses "I think"'],
    ["a banned word", "This was a quick fix.", 'uses "quick"'],
    ["a heavy word", "Escalate to FLIGHT.", 'uses "Escalate"'],
  ])("flags %s", (_what, text, problem) => {
    expect(plainTalkProblems(text)).toContain(problem);
  });

  it("flags a sentence of 20 words or more, and ignores words inside code", () => {
    const long = Array.from({ length: 20 }, () => "word").join(" ");
    expect(plainTalkProblems(`${long}.`)).toEqual([expect.stringContaining("20 words")]);
    expect(plainTalkProblems("Ran `pnpm -s lint && pnpm -s typecheck && pnpm -s test`.")).toEqual(
      [],
    );
  });
});
