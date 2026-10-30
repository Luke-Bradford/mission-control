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
    ["abort", "Abort the run and flag the issue.", 'uses "Abort"'],
    ["flag", "Abort the run and flag the issue.", 'uses "flag"'],
    ["flagged", "The issue was flagged.", 'uses "flagged"'],
    ["flagging", "Flagging the issue.", 'uses "Flagging"'],
    ["kill", "Kill the process.", 'uses "Kill"'],
    ["surface", "Surface the error to FLIGHT.", 'uses "Surface"'],
    ["disable", "Disable the check.", 'uses "Disable"'],
    ["terminated", "The run was terminated.", 'uses "terminated"'],
    ["terminating", "Terminating the run.", 'uses "Terminating"'],
    ["enables", "This enables the lock.", 'uses "enables"'],
    ["escalated", "GUIDO-1 escalated it.", 'uses "escalated"'],
    ["escalating", "Escalating now.", 'uses "Escalating"'],
    ["enabled", "The flag is enabled.", 'uses "enabled"'],
    ["allows you to", "It allows you to stop.", 'uses "allows you to"'],
    ["in order to", "Run it in order to pass.", 'uses "in order to"'],
    ["first person", "I ran the tests.", 'uses "I"'],
  ])("flags %s", (_what, text, problem) => {
    expect(plainTalkProblems(text)).toContain(problem);
  });

  it("flags a sentence of 20 words or more, and ignores words inside code", () => {
    const long = Array.from({ length: 20 }, () => "word").join(" ");
    expect(plainTalkProblems(`${long}.`)).toEqual([expect.stringContaining("20 words")]);
    expect(plainTalkProblems("Ran `pnpm -s lint && pnpm -s typecheck && pnpm -s test`.")).toEqual(
      [],
    );
    expect(plainTalkProblems("Ran `git push --flag`.")).toEqual([]);
  });
});
