import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headEntryKind, worktreeEntry } from "../src/mcp/remove.ts";

let R: string;

beforeEach(() => {
  R = realpathSync(mkdtempSync(join(tmpdir(), "mc-remove-")));
});
afterEach(() => {
  rmSync(R, { recursive: true, force: true });
});

const put = (rel: string, text = "x\n") => {
  mkdirSync(join(R, rel, ".."), { recursive: true });
  writeFileSync(join(R, rel), text);
};

describe("worktreeEntry", () => {
  it("check keeps, rm deletes", async () => {
    put("a/f.ts");
    expect(await worktreeEntry(R, "a/f.ts", false)).toBe("file");
    expect(existsSync(join(R, "a/f.ts"))).toBe(true);
    expect(await worktreeEntry(R, "a/f.ts", true)).toBe("file");
    expect(existsSync(join(R, "a/f.ts"))).toBe(false);
  });

  it("folder and missing", async () => {
    put("a/f.ts");
    expect(await worktreeEntry(R, "a", true)).toBe("folder");
    expect(await worktreeEntry(R, "zz/f.ts", true)).toBe("missing");
    expect(await worktreeEntry(R, "a/nope.ts", true)).toBe("missing");
    expect(existsSync(join(R, "a/f.ts"))).toBe(true);
  });

  it("never reads a differently-cased name as the file, and leaves the file", async () => {
    put("a/f.ts");
    // linked on a case-insensitive disk (fails closed), missing on a case-sensitive one
    expect(["linked", "missing"]).toContain(await worktreeEntry(R, "A/f.ts", true));
    expect(["linked", "missing"]).toContain(await worktreeEntry(R, "a/F.ts", true));
    expect(existsSync(join(R, "a/f.ts"))).toBe(true);
  });

  it("never goes through a symlinked folder", async () => {
    put("out/f.ts");
    mkdirSync(join(R, "wt"));
    symlinkSync(join(R, "out"), join(R, "wt", "a"));
    expect(await worktreeEntry(join(R, "wt"), "a/f.ts", true)).toBe("linked");
    expect(existsSync(join(R, "out/f.ts"))).toBe(true);
  });

  it("removes a symlink itself, not its target", async () => {
    put("out/f.ts");
    mkdirSync(join(R, "wt"));
    symlinkSync(join(R, "out/f.ts"), join(R, "wt", "l.ts"));
    expect(await worktreeEntry(join(R, "wt"), "l.ts", true)).toBe("file");
    expect(() => lstatSync(join(R, "wt", "l.ts"))).toThrow();
    expect(existsSync(join(R, "out/f.ts"))).toBe(true);
  });
});

describe("headEntryKind", () => {
  const ls = (...rows: string[]) => `${rows.join("\0")}\0`;
  it("reads the entry for exactly the path", () => {
    expect(headEntryKind(ls("100644 blob abc\tx"), "x")).toBe("file");
    expect(headEntryKind(ls("100755 blob abc\tx"), "x")).toBe("file");
    expect(headEntryKind(ls("120000 blob abc\tx"), "x")).toBe("file");
    expect(headEntryKind(ls("040000 tree abc\tx"), "x")).toBe("folder");
    expect(headEntryKind(ls("160000 commit abc\tx"), "x")).toBe("nested");
    expect(headEntryKind(ls("100644 blob abc\ty"), "x")).toBe("none");
    expect(headEntryKind(ls("100644 blob abc\tx/y"), "x")).toBe("none");
    expect(headEntryKind("", "x")).toBe("none");
  });
});
