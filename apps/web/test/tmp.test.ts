import { describe, expect, it } from "vitest";
import { relativiser, toolResult } from "../src/agent/toolTarget.ts";

describe("a worktree path after a bracket, comma, backtick, < or |", () => {
  const rel = relativiser(undefined, "guido-1");
  const p = "/u/worktrees/guido-1-5/a.ts";
  it("is shortened, as in a stack trace", () => {
    expect(toolResult(`at fn (${p}:3:4)`, false, rel)).toBe("at fn (a.ts:3:4)");
    for (const lead of ["[", ",", "`", "<", "|"]) {
      expect(toolResult(`x${lead}${p}`, false, rel)).toBe(`x${lead}a.ts`);
    }
  });
});
