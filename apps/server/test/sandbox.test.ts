import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOnPath } from "../src/cli-version.ts";
import { crewToolchainPaths, realish } from "../src/config.ts";
import { crewGitConfigPaths } from "../src/runtime/sandbox.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-sandbox-")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function file(path: string, text = "standalone"): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function pnpmPackage(install: string, store: string): string {
  file(join(install, "package.json"), JSON.stringify({ name: "pnpm" }));
  const entry = file(join(install, "bin/pnpm.cjs"), `#!/bin/sh\nprintf '%s\\n' '${store}'\n`);
  chmodSync(entry, 0o755);
  return entry;
}

describe("toolchain read grants", () => {
  it.each(["Library/pnpm", ".local/bin"])("grants the standalone file in %s", (folder) => {
    const pnpm = file(join(dir, folder, "pnpm"));
    expect(crewToolchainPaths(process.execPath, pnpm)).toEqual([
      realpathSync(process.execPath),
      pnpm,
    ]);
  });

  it("grants a symlink's executable and verified pnpm package, without its store", () => {
    const install = join(dir, "package");
    const entry = pnpmPackage(install, join(dir, "store"));
    const link = join(dir, "pnpm");
    symlinkSync(entry, link);
    expect(crewToolchainPaths(process.execPath, link)).toEqual([
      realpathSync(process.execPath),
      entry,
      install,
    ]);
  });

  it("never grants a package folder containing the pnpm store, including through a symlink", () => {
    const install = join(dir, "package");
    mkdirSync(install);
    const link = join(dir, "linked-store");
    symlinkSync(join(install, "store"), link);
    // Create the target so realish resolves the link.
    mkdirSync(join(install, "store"));
    const entry = pnpmPackage(install, link);
    expect(() => crewToolchainPaths(process.execPath, entry)).toThrow(/contains pnpm store/);
  });

  it("caches store discovery across binary aliases and refreshes after an upgrade", () => {
    const install = join(dir, "package");
    const entry = pnpmPackage(install, join(dir, "store"));
    const calls = join(dir, "calls");
    writeFileSync(entry, `${readFileSync(entry, "utf8")}printf x >> '${calls}'\n`);
    const link = join(dir, "pnpm");
    symlinkSync(entry, link);
    crewToolchainPaths(process.execPath, link);
    crewToolchainPaths(process.execPath, entry);
    expect(readFileSync(calls, "utf8")).toBe("x");

    const modified = statSync(entry).mtimeMs / 1000 + 10;
    pnpmPackage(install, join(install, "store"));
    utimesSync(entry, modified, modified);
    expect(() => crewToolchainPaths(process.execPath, link)).toThrow(/contains pnpm store/);
  });

  it("refreshes store discovery when a pnpm link changes target with the same mtime", () => {
    const entry = pnpmPackage(join(dir, "first"), join(dir, "store"));
    const other = pnpmPackage(join(dir, "second"), join(dir, "second/store"));
    const modified = new Date("2026-01-01T00:00:00Z");
    utimesSync(entry, modified, modified);
    utimesSync(other, modified, modified);
    const link = join(dir, "pnpm");
    symlinkSync(entry, link);
    crewToolchainPaths(process.execPath, link);
    rmSync(link);
    symlinkSync(other, link);
    expect(() => crewToolchainPaths(process.execPath, link)).toThrow(/contains pnpm store/);
  });

  it.each([".", "nested-home"])("refuses a package at or above home (%s)", (home) => {
    const entry = pnpmPackage(dir, join(dir, "store"));
    vi.stubEnv("HOME", join(dir, home));
    expect(() => crewToolchainPaths(process.execPath, entry)).toThrow(/home or holds home/);
  });

  it("skips non-executable PATH entries as Bash does", () => {
    file(join(dir, "first/node"));
    const node = file(join(dir, "second/node"));
    chmodSync(node, 0o755);
    expect(resolveOnPath("node", `${dir}/first:${dir}/second`)).toBe(node);
  });

  it("grants both the PATH node and the hub node when they differ, and permits absent pnpm", () => {
    const node = file(join(dir, "node"));
    chmodSync(node, 0o755);
    vi.stubEnv("PATH", dir);
    expect(crewToolchainPaths(resolveOnPath("node"), resolveOnPath("pnpm"))).toEqual([
      realpathSync(process.execPath),
      node,
    ]);
  });
});

describe("global git config read grants", () => {
  it("grants configured ignore and attributes files through includes, tilde paths and symlinks", async () => {
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    execFileSync("git", ["init", "-q", repo]);
    const ignores = file(join(dir, "files/ignores"), "ignored\n");
    const attributes = file(join(dir, "files/attributes"), "* text=auto\n");
    symlinkSync(ignores, join(home, "ignores"));
    symlinkSync(attributes, join(home, "attributes"));
    file(join(home, ".gitconfig"), "[include]\npath = settings/git\n");
    file(
      join(home, "settings/git"),
      `[core]\nexcludesFile = ~/ignores\nattributesFile = ${home}/attributes\n`,
    );
    const { allowRead } = await crewGitConfigPaths(repo, join(repo, ".git"));
    expect(allowRead).toContain(ignores);
    expect(allowRead).toContain(attributes);
    expect(allowRead).not.toContain(join(dir, "files"));
    expect(allowRead).not.toContain(home);
  });

  it("resolves relative core file paths against the checkout and uses the last configured value", async () => {
    vi.stubEnv("HOME", dir);
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    file(
      join(dir, ".gitconfig"),
      "[core]\nexcludesFile = old\nexcludesFile = ignores\nattributesFile = attributes\n",
    );
    const { allowRead } = await crewGitConfigPaths(repo, join(repo, ".git"));
    expect(allowRead).toContain(join(repo, "ignores"));
    expect(allowRead).toContain(join(repo, "attributes"));
    expect(allowRead).not.toContain(join(repo, "old"));
    expect(allowRead).not.toContain(join(dir, "ignores"));
  });

  it("discovers the seat's default XDG config, includes and core files despite the hub's override", async () => {
    vi.stubEnv("HOME", dir);
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const override = join(dir, "override");
    vi.stubEnv("XDG_CONFIG_HOME", override);
    for (const [config, prefix] of [
      [join(dir, ".config/git/config"), "seat"],
      [join(override, "git/config"), "hub"],
    ]) {
      file(config, `[include]\npath = ~/${prefix}-include\n`);
      file(
        join(dir, `${prefix}-include`),
        `[core]\nexcludesFile = ~/${prefix}-ignores\nattributesFile = ~/${prefix}-attributes\n`,
      );
    }
    const { allowRead } = await crewGitConfigPaths(repo, join(repo, ".git"));
    for (const suffix of ["include", "ignores", "attributes"]) {
      expect(allowRead).toContain(join(dir, `seat-${suffix}`));
      expect(allowRead).not.toContain(join(dir, `hub-${suffix}`));
    }
    expect(process.env.XDG_CONFIG_HOME).toBe(override);
  });

  it("resolves config symlinks, relative and tilde includes, conditional and nested includes", async () => {
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    mkdirSync(home);
    mkdirSync(repo);
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    execFileSync("git", ["init", "-q", repo]);
    const gitDir = join(repo, ".git");
    const nested = file(join(home, "nested"));
    writeFileSync(nested, "[user]\nname = Nested\n");
    const relative = file(join(home, "relative"), "[include]\npath = ~/nested\n");
    const conditional = file(join(home, "conditional"), "[user]\nname = Conditional\n");
    const inactive = file(join(home, "inactive"), "[user]\nname = Inactive\n");
    const global = file(
      join(dir, "global"),
      `[include]\npath = relative\n[includeIf "gitdir:${repo}/"]\npath = ~/conditional\n[includeIf "gitdir:/never/"]\npath = ~/inactive\n`,
    );
    symlinkSync(global, join(home, ".gitconfig"));
    const xdg = join(dir, "xdg");
    file(join(xdg, "config"), "[user]\nname = XDG\n");
    mkdirSync(join(home, ".config"));
    symlinkSync(xdg, join(home, ".config/git"));
    const result = await crewGitConfigPaths(repo, gitDir);
    expect(result.allowRead).toEqual(
      expect.arrayContaining([global, xdg, relative, nested, conditional, inactive]),
    );
    expect(result.allowRead).not.toContain(home);
    expect(result.denyRead).toEqual([join(xdg, "credentials")]);
  });

  it("handles missing global config and missing include files without broadening grants", async () => {
    vi.stubEnv("HOME", dir);
    vi.stubEnv("XDG_CONFIG_HOME", join(dir, ".config"));
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    expect((await crewGitConfigPaths(repo, join(repo, ".git"))).allowRead).toEqual([
      realish(join(dir, ".gitconfig")),
      realish(join(dir, ".config/git")),
    ]);
    file(join(dir, ".gitconfig"), "[include]\npath = missing\n");
    expect((await crewGitConfigPaths(repo, join(repo, ".git"))).allowRead).toContain(
      join(dir, "missing"),
    );
  });
});
