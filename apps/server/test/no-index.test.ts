import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keepOutOfSpotlight, NO_INDEX_MARKER } from "../src/no-index.ts";

describe("keepOutOfSpotlight", () => {
  it("writes the marker at each folder's root, making a missing folder, and keeps existing files", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-noindex-"));
    const existing = join(root, "worktrees");
    mkdirSync(existing);
    writeFileSync(join(existing, "keep.txt"), "x");
    const missing = join(root, "qa-report-assets");
    keepOutOfSpotlight([existing, missing, existing], () => {});
    expect(existsSync(join(existing, NO_INDEX_MARKER))).toBe(true);
    expect(existsSync(join(existing, "keep.txt"))).toBe(true);
    expect(existsSync(join(missing, NO_INDEX_MARKER))).toBe(true);
  });

  it("logs and carries on when a folder cannot be written", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-noindex-"));
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    const lines: string[] = [];
    keepOutOfSpotlight([join(file, "inside"), root], (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(existsSync(join(root, NO_INDEX_MARKER))).toBe(true);
  });
});
