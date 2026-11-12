import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { diskUse } from "../src/disk/use.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "mc-use-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const put = (path: string, bytes: number): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
};

it("sizes what the hub holds by kind", () => {
  const data = tmp();
  const wt = tmp();
  put(join(data, "qa-report-assets", "a.png"), 10);
  put(join(data, "review-screenshots", "b.png"), 20);
  put(join(data, "hud-screenshots", "c.png"), 5);
  put(join(data, "pr-evidence", "mc", "5", "m.png"), 100);
  put(join(data, "controller", "x", "copy"), 1000);
  put(join(data, "pr-evidence-work", "capture", "y"), 500);
  put(join(data, "mc.sqlite"), 7000);
  put(join(data, "mc.sqlite-wal"), 300);
  put(join(wt, "seat-1", "file"), 40000);
  expect(diskUse({ dataDir: data, worktrees: wt })).toEqual({
    worktrees: 40000,
    pictures: 35,
    evidence: 100,
    scratch: 1500,
    database: 7300,
    total: 48935,
  });
});

it("reports zero for a folder that does not exist", () => {
  expect(diskUse({ dataDir: join(tmp(), "none"), worktrees: undefined }).total).toBe(0);
});
