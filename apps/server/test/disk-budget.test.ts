import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sweepDataFolder } from "../src/disk/sweep.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NOW = Date.UTC(2026, 10, 12);
const DAY = 86_400_000;
function file(path: string, ageMs: number, bytes: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
  const t = (NOW - ageMs) / 1000;
  utimesSync(path, t, t);
}

it("above the budget, the oldest files go first, and the log says what the hub holds", () => {
  const data = realpathSync(mkdtempSync(join(tmpdir(), "mc-budget-")));
  dirs.push(data);
  // all for open work, so only the budget can remove them
  file(join(data, "controller", "fresh-scratch", "f"), 1 * DAY, 400);
  file(join(data, "pr-evidence", "mc", "5", "a".repeat(40), "old.png"), 2 * DAY, 400);
  file(join(data, "pr-evidence", "mc", "6", "b".repeat(40), "new.png"), 1_000, 400);
  file(join(data, "mc.sqlite"), 0, 100);
  const lines: string[] = [];
  const r = sweepDataFolder({
    dataDir: data,
    now: () => NOW,
    openPrs: new Set(["mc#5", "mc#6"]),
    citedAssets: new Set(),
    keptShots: new Set(),
    budgetBytes: 700,
    log: (l) => lines.push(l),
  });
  // 1300 held, 700 allowed: scratch goes first, then the oldest evidence
  expect(existsSync(join(data, "controller", "fresh-scratch"))).toBe(false);
  expect(existsSync(join(data, "pr-evidence", "mc", "5"))).toBe(false);
  expect(existsSync(join(data, "pr-evidence", "mc", "6"))).toBe(true);
  expect(r.bytes).toBe(800);
  const text = lines.join("\n");
  expect(text).toMatch(/over its budget/);
  expect(text).toMatch(/evidence 800/);
  expect(text).toMatch(/scratch 400/);
});
