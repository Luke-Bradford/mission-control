import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_TRIM_HEAD, TOOL_TRIM_TAIL } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trimMain } from "../src/guard/trim.ts";

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "mc-trim-")), "tool-output");
  mkdirSync(dir);
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

const post = (over: Record<string, unknown>) =>
  JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "mcp__x__dump",
    tool_use_id: "toolu_1",
    tool_response: "r".repeat(300_000),
    ...over,
  });

describe("trimMain", () => {
  it("prints nothing for a small result", () => {
    expect(trimMain(post({ tool_response: "small" }), dir)).toBe("");
  });

  it("returns the cut text as updatedToolOutput and keeps the full output in the folder", () => {
    const out = JSON.parse(trimMain(post({}), dir));
    const file = join(dir, "toolu_1.txt");
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const text = out.hookSpecificOutput.updatedToolOutput as string;
    expect(text.length).toBeLessThan(TOOL_TRIM_HEAD + TOOL_TRIM_TAIL + 400);
    expect(text).toContain(file);
    expect(readFileSync(file, "utf8")).toBe("r".repeat(300_000));
  });

  it("is silent for a Pre event, a failure with no response, and a bad tool_use_id", () => {
    expect(trimMain(post({ hook_event_name: "PreToolUse" }), dir)).toBe("");
    expect(trimMain(post({ tool_response: undefined }), dir)).toBe("");
    expect(trimMain(post({ tool_use_id: "../../etc/x" }), dir)).toBe("");
    expect(trimMain("not json", dir)).toBe("");
  });

  it("leaves the result whole when the folder is missing", () => {
    expect(trimMain(post({}), join(dir, "..", "absent"))).toBe("");
  });

  it("does not write through a folder the seat swapped for a link", () => {
    const outside = join(dir, "..", "outside");
    mkdirSync(outside);
    rmSync(dir, { recursive: true });
    symlinkSync(outside, dir);
    expect(trimMain(post({}), dir)).toBe("");
    expect(existsSync(join(outside, "toolu_1.txt"))).toBe(false);
  });

  it("does not write through a file link, and never overwrites a file", () => {
    const target = join(dir, "..", "target.txt");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, "toolu_1.txt"));
    expect(trimMain(post({}), dir)).toBe("");
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  describe("large shell results (#1642)", () => {
    const bash = (over: Record<string, unknown>) => post({ tool_name: "Bash", ...over });

    it("a large successful Bash result returns bounded text and keeps the whole result, flags included", () => {
      const stdout = `${"match: line\n".repeat(20_000)}done\n`;
      const response = { stdout, stderr: "", interrupted: false, isImage: false };
      const out = JSON.parse(trimMain(bash({ tool_response: response }), dir));
      const shown = out.hookSpecificOutput.updatedToolOutput as typeof response;
      const file = join(dir, "toolu_1.txt");
      expect(shown.stdout.length).toBeLessThan(TOOL_TRIM_HEAD + TOOL_TRIM_TAIL + 400);
      expect(shown.stdout).toContain(file);
      expect(shown.stdout.endsWith("done\n")).toBe(true);
      expect(shown.interrupted).toBe(false);
      // the retrieval path holds all of it
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(response);
    });

    it("the hook leaves a large failed Bash call (PostToolUseFailure) as the CLI cut it and keeps nothing", () => {
      const error = `Exit code 2\n${"error: nope\n".repeat(20_000)}`;
      const event = bash({
        hook_event_name: "PostToolUseFailure",
        tool_response: undefined,
        error,
      });
      expect(trimMain(event, dir)).toBe("");
      expect(existsSync(join(dir, "toolu_1.txt"))).toBe(false);
    });

    it("a large Bash result that failed a check still shows its last failing line", () => {
      const stdout = `${"ok\n".repeat(30_000)}FAIL src/a.test.ts > it breaks\n${"trailing detail\n".repeat(100)}`;
      const out = JSON.parse(trimMain(bash({ tool_response: { stdout, stderr: "" } }), dir));
      expect(out.hookSpecificOutput.updatedToolOutput.stdout).toContain("FAIL src/a.test.ts");
    });
  });
});
