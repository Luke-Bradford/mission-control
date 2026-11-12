import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCRATCH_MAX_AGE_MS, sweepDataFolder } from "../src/disk/sweep.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "mc-disk-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 12);
const DAY = 86_400_000;
const hash = (c: string): string => c.repeat(64);
const shot = (c: string): string => c.repeat(32);

/** A file of `bytes` bytes, last touched `ageMs` before NOW. */
function file(path: string, ageMs: number, bytes = 10): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
  const t = (NOW - ageMs) / 1000;
  utimesSync(path, t, t);
}

function fixture(): string {
  const data = tmp();
  // evidence: PR 5 is open, PR 6 is finished
  file(join(data, "pr-evidence", "mc", "5", "a".repeat(40), "m.png"), 5 * DAY);
  file(join(data, "pr-evidence", "mc", "6", "b".repeat(40), "m.png"), 5 * DAY, 100);
  // QA images: one cited by an open PR's report, one not
  file(join(data, "qa-report-assets", `${hash("a")}.png`), 5 * DAY);
  file(join(data, "qa-report-assets", `${hash("b")}.png`), 5 * DAY, 100);
  // review screenshots: one of an open PR, one of a finished PR
  file(join(data, "review-screenshots", `${shot("a")}.png`), 5 * DAY);
  file(join(data, "review-screenshots", `${shot("b")}.png`), 5 * DAY, 100);
  // scratch
  file(join(data, "controller", "old-copy", "mc.sqlite"), 4 * DAY, 1000);
  file(join(data, "controller", "fresh-copy", "mc.sqlite"), 1 * DAY);
  file(join(data, "controller", "designs", "keep.html"), 30 * DAY);
  file(join(data, "pr-evidence-work", "capture-old", "x"), 4 * DAY, 500);
  return data;
}

const open = {
  openPrs: new Set(["mc#5"]),
  citedAssets: new Set([hash("a")]),
  keptShots: new Set([shot("a")]),
};

describe("sweepDataFolder", () => {
  it("removes finished work's pictures and old scratch, keeps open work and designs", async () => {
    const data = fixture();
    const lines: string[] = [];
    const r = await sweepDataFolder({
      dataDir: data,
      now: () => NOW,
      ...open,
      log: (l) => lines.push(l),
    });
    expect(existsSync(join(data, "pr-evidence", "mc", "6"))).toBe(false);
    expect(existsSync(join(data, "pr-evidence", "mc", "5"))).toBe(true);
    expect(existsSync(join(data, "qa-report-assets", `${hash("b")}.png`))).toBe(false);
    expect(existsSync(join(data, "qa-report-assets", `${hash("a")}.png`))).toBe(true);
    expect(existsSync(join(data, "review-screenshots", `${shot("b")}.png`))).toBe(false);
    expect(existsSync(join(data, "review-screenshots", `${shot("a")}.png`))).toBe(true);
    expect(existsSync(join(data, "controller", "old-copy"))).toBe(false);
    expect(existsSync(join(data, "controller", "fresh-copy"))).toBe(true);
    expect(existsSync(join(data, "controller", "designs", "keep.html"))).toBe(true);
    expect(existsSync(join(data, "pr-evidence-work", "capture-old"))).toBe(false);
    expect(r.files).toBe(5);
    expect(r.bytes).toBe(100 + 100 + 100 + 1000 + 500);
    expect(lines.join("\n")).toMatch(/removed 5 .*1800 bytes/);
  });

  it("leaves a PR's files for a grace period after it finishes", async () => {
    const data = tmp();
    file(join(data, "pr-evidence", "mc", "7", "c".repeat(40), "m.png"), 60_000);
    await sweepDataFolder({ dataDir: data, now: () => NOW, ...open, log: () => {} });
    expect(existsSync(join(data, "pr-evidence", "mc", "7"))).toBe(true);
  });

  it("never removes a path outside the data folder, even through a symlink", async () => {
    const data = fixture();
    const outside = tmp();
    file(join(outside, "precious.txt"), 30 * DAY);
    symlinkSync(outside, join(data, "controller", "link-out"));
    symlinkSync(outside, join(data, "pr-evidence", "mc", "9"));
    const old = (NOW - 30 * DAY) / 1000;
    utimesSync(join(data, "controller", "link-out"), old, old);
    await sweepDataFolder({ dataDir: data, now: () => NOW, ...open, log: () => {} });
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
    expect(SCRATCH_MAX_AGE_MS).toBe(3 * DAY);
  });
});
