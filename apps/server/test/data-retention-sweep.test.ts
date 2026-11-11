import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepHubData } from "../src/data-retention-sweep.ts";
import { encodePng } from "../src/pr-evidence/png.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const OLD = NOW - 8 * DAY;
const PNG = encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) });
let dirs: string[] = [];

function dir(): string {
  const value = mkdtempSync(join(tmpdir(), "mc-retention-"));
  dirs.push(value);
  return value;
}

function file(path: string, age = OLD, contents: string | Buffer = "retained fixture"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  utimesSync(path, age / 1000, age / 1000);
}

afterEach(() => {
  for (const value of dirs) rmSync(value, { recursive: true, force: true });
  dirs = [];
});

describe("hub data retention sweep", () => {
  it("removes old finished-PR files and scratch folders, while retaining live work", () => {
    const root = dir();
    const oldEvidence = join(root, "pr-evidence", "sample", "7", "a".repeat(40));
    const openEvidence = join(root, "pr-evidence", "sample", "8", "b".repeat(40));
    const oldAsset = "a".repeat(64);
    const openAsset = "b".repeat(64);
    const oldShot = "c".repeat(32);
    const openShot = "d".repeat(32);
    file(join(oldEvidence, "page.png"));
    file(join(openEvidence, "page.png"));
    file(join(root, "qa-report-assets", `${oldAsset}.png`), OLD, PNG);
    file(join(root, "qa-report-assets", `${openAsset}.png`));
    file(join(root, "review-screenshots", `${oldShot}.png`));
    file(join(root, "review-screenshots", `${openShot}.png`));
    file(join(root, "controller", "old", "scratch"));
    file(join(root, "controller", "question", "question"));
    file(join(root, "controller", "designs", "design"));
    file(join(root, "previews", "old", "copy"));

    const logs: string[] = [];
    const result = sweepHubData({
      root,
      now: NOW,
      prs: [
        { repoId: "sample", number: 7, state: "merged", finishedAt: OLD },
        { repoId: "sample", number: 8, state: "open", finishedAt: null },
      ],
      qaAssets: [
        { id: oldAsset, repoId: "sample", prNumber: 7 },
        { id: openAsset, repoId: "sample", prNumber: 8 },
      ],
      reviewShots: [
        { id: oldShot, repoId: "sample", prNumber: 7 },
        { id: openShot, repoId: "sample", prNumber: 8 },
      ],
      openQuestionPaths: [join(root, "controller", "question")],
      log: (line) => logs.push(line),
    });

    expect(result).toMatchObject({ removed: 5, bytes: expect.any(Number) });
    expect(logs).toEqual([expect.stringMatching(/^data retention: removed 5 files \(.+ bytes\)$/)]);
    expect(existsSync(oldEvidence)).toBe(false);
    expect(existsSync(join(root, "qa-report-assets", "thumbnails", `${oldAsset}.png`))).toBe(true);
    expect(existsSync(join(root, "controller", "old"))).toBe(false);
    expect(existsSync(join(root, "previews", "old"))).toBe(false);
    expect(existsSync(openEvidence)).toBe(true);
    expect(existsSync(join(root, "controller", "question"))).toBe(true);
    expect(existsSync(join(root, "controller", "designs"))).toBe(true);
  });

  it("refuses outside paths and symlinks that resolve outside the data folder", () => {
    const root = dir();
    const outside = dir();
    const outsideFile = join(outside, "outside.png");
    file(outsideFile);
    const linked = join(root, "controller", "linked");
    mkdirSync(join(root, "controller"), { recursive: true });
    symlinkSync(outside, linked);

    const result = sweepHubData({ root, now: NOW, prs: [], qaAssets: [], reviewShots: [] });

    expect(result).toEqual({ removed: 0, bytes: 0 });
    expect(existsSync(outsideFile)).toBe(true);
    expect(existsSync(linked)).toBe(true);
  });
});
