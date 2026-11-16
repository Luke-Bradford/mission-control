import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { traceFix } from "../src/bug-escapes/trace.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bug-trace-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z" } },
  ).trim();

const put = (path: string, content: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const commit = (message: string): string => {
  git("add", ".");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
};

/** A repo whose `main` takes a PR by merge commit, as this repo does. */
function mergeStyleRepo() {
  git("init", "-q", "-b", "main");
  put(
    "src/price.ts",
    "export const a = 1;\nexport const total = (x) => x + 1;\nexport const z = 3;\n",
  );
  commit("base");
  git("checkout", "-qb", "feature/pr-7");
  put(
    "src/price.ts",
    "export const a = 1;\nexport const total = (x) => x + tax(x); // BUG\nexport const z = 3;\n",
  );
  put("test/price.test.ts", "// covers nothing here\n");
  const introducing = commit("feat: add tax");
  git("checkout", "-q", "main");
  put("src/other.ts", "export const o = 1;\n");
  commit("unrelated");
  git("merge", "--no-ff", "-qm", "Merge pull request #7 from fix/pr-7", "feature/pr-7");
  const merge = git("rev-parse", "HEAD");
  // the fix PR
  git("checkout", "-qb", "feature/pr-9");
  put(
    "src/price.ts",
    "export const a = 1;\nexport const total = (x) => x + tax(x) + 0;\nexport const z = 3;\n",
  );
  commit("fix: total");
  git("checkout", "-q", "main");
  git("merge", "--no-ff", "-qm", "Merge pull request #9 from fix/pr-9", "feature/pr-9");
  return { introducing, merge, fix: git("rev-parse", "HEAD") };
}

describe("traceFix", () => {
  it("traces a fix back to the commit that introduced the line and the PR it came in on", async () => {
    const { introducing, merge, fix } = mergeStyleRepo();
    const t = await traceFix(dir, fix);
    expect(t).not.toBeNull();
    expect(t?.commit).toBe(introducing);
    expect(t?.prNumber).toBe(7);
    expect(t?.mergeSha).toBe(merge);
    expect(t?.fixedFiles).toEqual(["src/price.ts"]);
    expect(t?.introFiles.sort()).toEqual(["src/price.ts", "test/price.test.ts"]);
    expect(t?.mergedAt).toBe(Date.parse("2026-01-02T00:00:00Z"));
  });

  it("reads the PR number off a squash commit's subject", async () => {
    git("init", "-q", "-b", "main");
    put("lib.ts", "export const one = 1;\nexport const two = 2;\n");
    commit("base");
    put("lib.ts", "export const one = 1;\nexport const two = oops();\n");
    const squash = commit("feat: use oops (#12)");
    put("lib.ts", "export const one = 1;\nexport const two = fine();\n");
    const fix = commit("fix: two (#15)");
    const t = await traceFix(dir, fix);
    expect(t).toMatchObject({ commit: squash, prNumber: 12, mergeSha: squash });
  });

  it("blames the line before a pure insertion", async () => {
    git("init", "-q", "-b", "main");
    put("lib.ts", "export function f(x) {\n  return x.y;\n}\n");
    const intro = commit("feat: f (#3)");
    put("lib.ts", "export function f(x) {\n  if (!x) return 0;\n  return x.y;\n}\n");
    const fix = commit("fix: guard (#4)");
    expect((await traceFix(dir, fix))?.commit).toBe(intro);
  });

  it("gives no trace for a fix that only adds a new file, or a root commit", async () => {
    git("init", "-q", "-b", "main");
    put("a.ts", "export const a = 1;\n");
    const root = commit("root");
    put("b.ts", "export const b = 1;\n");
    const added = commit("add b");
    expect(await traceFix(dir, added)).toBeNull();
    expect(await traceFix(dir, root)).toBeNull();
  });

  it("refuses a value that is not a full commit id", async () => {
    git("init", "-q", "-b", "main");
    put("a.ts", "x\n");
    commit("root");
    expect(await traceFix(dir, "--output=/tmp/x")).toBeNull();
  });
});
