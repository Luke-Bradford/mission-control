import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREW_GIT_ENV } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { assertSeatGitConfig, assertSeatGitVersion } from "../src/runtime/git.ts";

let dir: string;
let env: NodeJS.ProcessEnv;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-seat-git-"));
  env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "fixture",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "fixture",
  };
  git("init", "-q");
  writeFileSync(join(dir, "file"), "before\n");
  git("add", "file");
  git("commit", "-qm", "initial");
  writeFileSync(join(dir, "file"), "after\n");
  writeFileSync(join(dir, "helper"), '#!/bin/sh\nprintf ran > "$HOME/sentinel"\ncat "$1"\n', {
    mode: 0o755,
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it.each(
  ["global", "system"].flatMap((scope) =>
    [
      "diff.external",
      "diff.x.textconv",
      "filter.x.clean",
      "filter.x.process",
      "core.fsmonitor",
    ].map((key) => ({ scope, key })),
  ),
)("ignores $scope $key for every seat read", ({ scope, key }) => {
  const config = join(dir, "operator-config");
  const helper = `"${join(dir, "helper")}"`;
  git("config", "--file", config, key, helper);
  writeFileSync(join(dir, ".gitattributes"), "file diff=x filter=x\n");
  env = {
    ...env,
    ...(scope === "global"
      ? { GIT_CONFIG_GLOBAL: config }
      : { GIT_CONFIG_SYSTEM: config, GIT_CONFIG_NOSYSTEM: "0" }),
    ...CREW_GIT_ENV,
  };
  for (const args of [["diff"], ["log", "-p"], ["show"], ["status"]]) {
    const output = git(...args);
    if (args[0] === "diff") expect(output).toContain("+after");
    expect(existsSync(join(dir, "sentinel"))).toBe(false);
  }
});

it.each([
  "diff.external",
  "diff.x.textconv",
  "filter.x.clean",
  "filter.x.process",
  "merge.x.driver",
  "core.fsmonitor",
])("refuses repo helper %s before seat reads", async (key) => {
  git("config", key, join(dir, "helper"));
  writeFileSync(join(dir, ".gitattributes"), "file diff=x filter=x merge=x\n");
  await expect(assertSeatGitConfig(dir)).rejects.toThrow(
    `the clone's git config defines helpers: ${key}`,
  );
  expect(existsSync(join(dir, "sentinel"))).toBe(false);
});

it("accepts a clean config and disabled fsmonitor", async () => {
  await expect(assertSeatGitConfig(dir)).resolves.toBeUndefined();
  for (const value of ["false", ""]) {
    git("config", "core.fsmonitor", value);
    await expect(assertSeatGitConfig(dir)).resolves.toBeUndefined();
  }
});

it("requires git 2.32 for seat isolation", async () => {
  const command = join(dir, "old-git");
  writeFileSync(command, "#!/bin/sh\necho 'git version 2.30.0'\n", { mode: 0o755 });
  await expect(assertSeatGitVersion(command)).rejects.toThrow(
    "git ≥ 2.32 required for seat isolation",
  );
  await expect(assertSeatGitVersion()).resolves.toBeUndefined();
});

it("never includes helper values in the refusal", async () => {
  git("config", "diff.x.textconv", "helper\n\tprivate-value do-not-log");
  await expect(assertSeatGitConfig(dir)).rejects.toThrow(
    /^the clone's git config defines helpers: diff.x.textconv$/,
  );
});

it("checks included repo config", async () => {
  const included = join(dir, "included-config");
  git("config", "--file", included, "filter.x.smudge", "helper");
  git("config", "include.path", included);
  await expect(assertSeatGitConfig(dir)).rejects.toThrow("filter.x.smudge");
});

it.each(["included", "missing/target"])(
  "refuses writable include target %s before it gains helpers",
  async (name) => {
    git("config", "include.path", join(dir, name));
    if (name === "included") writeFileSync(join(dir, name), "");
    await expect(assertSeatGitConfig(dir)).rejects.toThrow("writable include");
  },
);
