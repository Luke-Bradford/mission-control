import { describe, expect, it } from "vitest";
import { relativiser, toolResult, toolTarget } from "../src/agent/toolTarget.ts";
import { cutStart, cutText, firstLine } from "../src/fmt.ts";
import { CONFIG, CREW_CONFIG } from "./fixtures.ts";

const inp = (o: object) => JSON.stringify(o);
const fallback = relativiser(undefined, "guido-1");
const crew = relativiser(
  { ...CREW_CONFIG, crew: { ...(CREW_CONFIG.crew as object), worktrees: "/w/seats" } } as never,
  "guido-1",
);
const loop = relativiser(CONFIG, "shop-app-ta");

describe("toolTarget", () => {
  it("shows a path relative to a crew seat's configured worktree", () => {
    expect(toolTarget(inp({ file_path: "/w/seats/guido-1-167/a/b.ts" }), crew)).toBe("a/b.ts");
  });
  it("shows a path relative to a loop's configured worktree", () => {
    expect(toolTarget(inp({ file_path: "/u/.shop-app-autonomy/app/x.ts" }), loop)).toBe("app/x.ts");
  });
  it("falls back to the /worktrees/<seat>-<digits>/ shape while the config loads", () => {
    const p = "/Users/me/Dev/worktrees/guido-1-167/packages/core/src/loop.ts";
    expect(toolTarget(inp({ file_path: p }), fallback)).toBe("packages/core/src/loop.ts");
  });
  it("cuts a long path from the left, keeping the file name", () => {
    const p = `src/${"deep/".repeat(30)}runtime/supervisor.ts`;
    const t = toolTarget(inp({ file_path: p }), fallback);
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t.startsWith("…/")).toBe(true);
    expect(t.endsWith("/runtime/supervisor.ts")).toBe(true);
  });
  it("uses the first non-empty line of a command and drops a leading cd into the worktree", () => {
    expect(toolTarget(inp({ command: "\n\n  pnpm test\nsecond" }), fallback)).toBe("pnpm test");
    expect(toolTarget(inp({ command: "cd /w/seats/guido-1-9 && pnpm -s lint" }), crew)).toBe(
      "pnpm -s lint",
    );
  });
  it("shortens worktree paths inside a command", () => {
    expect(toolTarget(inp({ command: "cat /w/seats/guido-1-9/a.ts" }), crew)).toBe("cat a.ts");
  });
  it("shows a Grep/Glob pattern, not the directory", () => {
    expect(toolTarget(inp({ pattern: "foo.*bar", path: "/w/seats/guido-1-9/src" }), crew)).toBe(
      "foo.*bar",
    );
    expect(toolTarget(inp({ path: "/w/seats/guido-1-9/src" }), crew)).toBe("src");
  });
  it("reads a path out of an input cut short", () => {
    expect(toolTarget('{"file_path":"/w/seats/guido-1-9/a.ts","old_str', crew)).toBe("a.ts");
  });
  it("shortens paths in the result and skips an empty first line", () => {
    expect(toolResult("\nThe file /w/seats/guido-1-9/a.ts was updated", false, crew)).toBe(
      "The file a.ts was updated",
    );
    expect(toolResult("boom", true, crew)).toBe("error: boom");
    expect(toolResult("x".repeat(300), false, crew).length).toBe(100);
  });
});

describe("worktree paths are stripped only from their start", () => {
  const rootCrew = relativiser(
    { ...CREW_CONFIG, crew: { ...(CREW_CONFIG.crew as object), worktrees: "/a/b" } } as never,
    "guido-1",
  );
  const result = (s: string, rel = fallback) => toolResult(s, false, rel);
  it("leaves a longer path that merely contains the root", () => {
    expect(result("/z/a/b/guido-1-5/x", rootCrew)).toBe("/z/a/b/guido-1-5/x");
    expect(result("/a/b/guido-1-5/x", rootCrew)).toBe("x");
  });
  it("leaves ~/…, ../… and URL paths alone in the fallback", () => {
    for (const p of [
      "~/Dev/worktrees/x-1/a.ts",
      "../worktrees/x-1/a.ts",
      "https://h.test/Dev/worktrees/x-1/a.ts",
      "/Users/me/My Dir/worktrees/x-1/a.ts",
    ]) {
      expect(result(p)).toBe(p);
    }
  });
  it("leaves git's admin dir .git/worktrees/<seat>-<n>/ alone", () => {
    for (const p of [
      "/Users/me/Dev/repo/.git/worktrees/guido-1-5/HEAD",
      "/Users/me/Dev/repo.git/worktrees/guido-1-5/HEAD",
    ]) {
      expect(result(p)).toBe(p);
    }
  });
  it("strips after whitespace, a quote, = or :", () => {
    for (const lead of [" ", '"', "'", "=", ":"]) {
      expect(result(`x${lead}/u/worktrees/guido-1-5/a.ts`)).toBe(`x${lead}a.ts`);
    }
  });
  it("is linear in the length of the line", () => {
    for (const unit of ["/a/b=", "/a ", "/worktrees/x-"]) {
      const line = unit.repeat(100_000 / unit.length);
      const t0 = performance.now();
      toolTarget(inp({ command: line }), fallback);
      toolTarget(inp({ file_path: line }), fallback);
      toolTarget(inp({ path: line }), fallback);
      toolResult(line, false, fallback);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });
});

describe("cut helpers", () => {
  it("cut by code point, never splitting a pair", () => {
    expect(cutText("😀😀😀", 2)).toBe("😀…");
    expect(cutStart("😀😀😀", 2)).toBe("…😀");
    expect(cutText("abc", 3)).toBe("abc");
  });
  it("firstLine is the first line with text", () => {
    expect(firstLine("\n \n a \nb")).toBe("a");
    expect(firstLine("")).toBe("");
  });
});
