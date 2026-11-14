import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { flightConflicts } from "../src/flight/conflicts.ts";
import { MapConflicts } from "../src/map/conflicts.ts";

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const lines = (n: number, edit: Record<number, string> = {}) =>
  `${Array.from({ length: n }, (_, i) => edit[i] ?? `line ${i}`).join("\n")}\n`;
const tip = (branch: string, number: number) => ({
  branch,
  number,
  headSha: git("rev-parse", branch),
  state: "open" as const,
});

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-flight-conflicts-")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(dir, "clash.txt"), "base\n");
  writeFileSync(join(dir, "apart.txt"), lines(30));
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "left");
  writeFileSync(join(dir, "clash.txt"), "left\n");
  writeFileSync(join(dir, "apart.txt"), lines(30, { 2: "left edit" }));
  git("commit", "-qam", "left");
  git("checkout", "-qb", "right", "main");
  writeFileSync(join(dir, "clash.txt"), "right\n");
  writeFileSync(join(dir, "apart.txt"), lines(30, { 25: "right edit" }));
  git("commit", "-qam", "right");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("names only the files whose merge conflicts, not every file two PRs both change", async () => {
  const found = await flightConflicts(new MapConflicts(), dir, [tip("left", 7), tip("right", 8)]);
  expect(found).toEqual([{ file: "clash.txt", prs: [7, 8] }]);
});

it("is undefined when the checkout cannot be read, so FLIGHT's state still builds", async () => {
  expect(
    await flightConflicts(new MapConflicts(), join(dir, "missing"), [
      tip("left", 7),
      tip("right", 8),
    ]),
  ).toBeUndefined();
});
