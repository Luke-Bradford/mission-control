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
import { diskUse } from "../src/disk/use.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NOW = Date.UTC(2026, 10, 12);
const DAY = 86_400_000;
const hash = (c: string): string => c.repeat(64);
function file(path: string, ageMs: number, bytes: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
  const t = (NOW - ageMs) / 1000;
  utimesSync(path, t, t);
}
const folder = (): string => {
  const data = realpathSync(mkdtempSync(join(tmpdir(), "mc-budget-")));
  dirs.push(data);
  return data;
};
const open = {
  openPrs: new Set(["mc#5"]),
  citedAssets: new Set([hash("a")]),
  keptShots: new Set<string>(),
};

it("over the budget, idle scratch goes oldest first and the log says what the hub holds", async () => {
  const data = folder();
  file(join(data, "controller", "idle-old", "f"), 2 * DAY, 400);
  file(join(data, "controller", "idle-newer", "f"), 1.5 * DAY, 400);
  file(join(data, "pr-evidence", "mc", "5", "a".repeat(40), "m.png"), 2 * DAY, 400);
  file(join(data, "mc.sqlite"), 0, 100);
  const lines: string[] = [];
  const r = await sweepDataFolder({
    dataDir: data,
    now: () => NOW,
    ...open,
    budgetBytes: 700,
    holdings: () => diskUse({ dataDir: data, worktrees: undefined }),
    log: (l) => lines.push(l),
  });
  // 1300 held, 700 allowed: the oldest idle scratch (400) is not enough, the next one goes too
  expect(existsSync(join(data, "controller", "idle-old"))).toBe(false);
  expect(existsSync(join(data, "controller", "idle-newer"))).toBe(false);
  expect(existsSync(join(data, "pr-evidence", "mc", "5"))).toBe(true);
  expect(r.bytes).toBe(800);
  const text = lines.join("\n");
  expect(text).toMatch(/over its budget/);
  expect(text).toMatch(/evidence 400/);
  expect(text).toMatch(/scratch 800/);
});

it("never removes open work or scratch that may be in use, even far over the budget", async () => {
  const data = folder();
  file(join(data, "controller", "live-preview", "mc.sqlite"), 60_000, 3000);
  file(join(data, "pr-evidence-work", "sides", "x"), 30_000, 2000);
  file(join(data, "qa-report-assets", `${hash("a")}.png`), 60_000, 1000);
  file(join(data, "pr-evidence", "mc", "5", "a".repeat(40), "m.png"), 60_000, 1000);
  const lines: string[] = [];
  const r = await sweepDataFolder({
    dataDir: data,
    now: () => NOW,
    ...open,
    budgetBytes: 500,
    holdings: () => diskUse({ dataDir: data, worktrees: undefined }),
    log: (l) => lines.push(l),
  });
  expect(r.files).toBe(0);
  expect(existsSync(join(data, "controller", "live-preview", "mc.sqlite"))).toBe(true);
  expect(existsSync(join(data, "pr-evidence-work", "sides", "x"))).toBe(true);
  expect(existsSync(join(data, "qa-report-assets", `${hash("a")}.png`))).toBe(true);
  expect(existsSync(join(data, "pr-evidence", "mc", "5"))).toBe(true);
  expect(lines.join("\n")).toMatch(/only open or in-use work is left/);
});
