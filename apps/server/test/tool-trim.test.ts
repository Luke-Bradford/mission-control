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
});
