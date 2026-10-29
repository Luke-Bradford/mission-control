import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrewGitError, crewGit, crewGitBytes } from "../src/runtime/git.ts";

let dir: string;
let clone: string;
let wt: string;
let other: string;
let marker: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...args], {
    cwd,
    encoding: "utf8",
  });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-crewgit-")));
  clone = join(dir, "clone");
  other = join(dir, "other");
  wt = join(dir, "wt");
  marker = join(dir, "hook-ran");
  for (const r of [clone, other]) {
    mkdirSync(r);
    git(r, "init", "-q");
    writeFileSync(join(r, "a.txt"), "a\n");
    git(r, "add", "-A");
    git(r, "commit", "-qm", "init");
  }
  git(clone, "worktree", "add", "-q", "-b", "seat", wt);
  git(other, "worktree", "add", "-q", "-b", "evil", join(dir, "evil-wt"));
  for (const hook of ["pre-commit", "post-commit", "post-checkout"]) {
    const h = join(clone, ".git", "hooks", hook);
    writeFileSync(h, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const common = () => join(clone, ".git");

describe("crewGit", () => {
  it("ignores replace refs: an object reads as itself, not as what a seat replaced it with", async () => {
    const real = git(clone, "rev-parse", "HEAD").trim();
    writeFileSync(join(clone, "a.txt"), "b\n");
    git(clone, "commit", "-qam", "fake");
    const fake = git(clone, "rev-parse", "HEAD").trim();
    git(clone, "replace", real, fake);
    expect(git(clone, "cat-file", "-p", real)).toContain("fake"); // a plain git honours it
    expect(await crewGit(clone, ["cat-file", "-p", real], common())).toContain("init");
  });

  it("runs git in the worktree and returns stdout", async () => {
    expect((await crewGit(wt, ["rev-parse", "--abbrev-ref", "HEAD"], common())).trim()).toBe(
      "seat",
    );
  });

  it("applies the caller's timeout while checking the checkout ownership", async () => {
    const bin = join(dir, "bin");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
case " $* " in
  *" --git-common-dir "*) sleep 6 ;;
esac
exec "${realGit}" "$@"
`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      expect(
        (
          await crewGit(wt, ["rev-parse", "--abbrev-ref", "HEAD"], common(), {
            timeoutMs: 10_000,
          })
        ).trim(),
      ).toBe("seat");
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  });

  it("refuses a worktree whose .git pointer was rewritten to another repo", async () => {
    writeFileSync(join(wt, ".git"), `gitdir: ${join(other, ".git", "worktrees", "evil-wt")}\n`);
    const e = await crewGit(wt, ["status"], common()).catch((x) => x);
    expect(e).toBeInstanceOf(CrewGitError);
    expect(e.code).toBe("redirected");
    expect(e.message).toBe("the checkout's git directory is not the clone's");
  });

  it("refuses a rewritten commondir file in the worktree's git dir", async () => {
    writeFileSync(join(common(), "worktrees", "wt", "commondir"), `${join(other, ".git")}\n`);
    const e = await crewGit(wt, ["status"], common()).catch((x) => x);
    expect(e).toBeInstanceOf(CrewGitError);
    expect(e.code).toBe("redirected");
  });

  it("does not run the clone's hooks (a plain git does)", async () => {
    writeFileSync(join(wt, "b.txt"), "b\n");
    await crewGit(wt, ["add", "b.txt"], common());
    await crewGit(
      wt,
      ["-c", "user.email=a@b", "-c", "user.name=n", "commit", "-qm", "b"],
      common(),
    );
    await crewGit(wt, ["checkout", "-q", "-b", "next"], common());
    expect(existsSync(marker)).toBe(false);
    // control: without the helper the same hook fires
    writeFileSync(join(wt, "c.txt"), "c\n");
    git(wt, "add", "c.txt");
    git(wt, "commit", "-qm", "c");
    expect(existsSync(marker)).toBe(true);
  });

  it("ignores GIT_* variables from the server's environment", async () => {
    process.env.GIT_DIR = join(other, ".git");
    try {
      expect((await crewGit(wt, ["rev-parse", "--abbrev-ref", "HEAD"], common())).trim()).toBe(
        "seat",
      );
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  it("checks the worktree's own git dir when one is given", async () => {
    git(clone, "worktree", "add", "-q", "-b", "seat2", join(dir, "wt2"));
    const own = join(common(), "worktrees", "wt");
    expect(
      (await crewGit(wt, ["rev-parse", "--abbrev-ref", "HEAD"], common(), { gitDir: own })).trim(),
    ).toBe("seat");
    // the pointer now names another worktree of the same clone: the common dir still matches
    writeFileSync(join(wt, ".git"), `gitdir: ${join(common(), "worktrees", "wt2")}\n`);
    expect((await crewGit(wt, ["rev-parse", "--abbrev-ref", "HEAD"], common())).trim()).toBe(
      "seat2",
    );
    const e = await crewGit(wt, ["status"], common(), { gitDir: own }).catch((x) => x);
    expect(e).toBeInstanceOf(CrewGitError);
    expect(e.code).toBe("redirected");
  });

  it("returns raw bytes (a tree's binary ids intact), behind the same checks", async () => {
    const tree = git(wt, "rev-parse", "HEAD^{tree}").trim();
    const raw = execFileSync("git", ["cat-file", "tree", tree], { cwd: wt });
    const got = await crewGitBytes(wt, ["cat-file", "tree", tree], common());
    expect(Buffer.isBuffer(got)).toBe(true);
    expect(got.equals(raw)).toBe(true);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(other, ".git", "worktrees", "evil-wt")}\n`);
    const e = await crewGitBytes(wt, ["cat-file", "tree", tree], common()).catch((x) => x);
    expect(e).toBeInstanceOf(CrewGitError);
  });

  it("honours maxBuffer", async () => {
    await expect(
      crewGit(wt, ["log", "--format=%H%n%H%n%H"], common(), { maxBuffer: 10 }),
    ).rejects.toThrow();
  });

  it("adds the caller's env (an author name), never over the variables that keep it safe", async () => {
    // An email and an empty HOME, so `git var` never depends on the runner's user or hostname.
    const home = join(dir, "empty-home");
    mkdirSync(home);
    const ident = await crewGit(wt, ["var", "GIT_AUTHOR_IDENT"], common(), {
      env: {
        GIT_AUTHOR_NAME: "GUIDO-1 (Mission Control)",
        GIT_AUTHOR_EMAIL: "guido@example.invalid",
        GIT_COMMITTER_NAME: "GUIDO-1 (Mission Control)",
        GIT_COMMITTER_EMAIL: "guido@example.invalid",
        HOME: home,
        XDG_CONFIG_HOME: home,
      },
    });
    expect(ident).toMatch(/^GUIDO-1 \(Mission Control\) </);
    const real = git(clone, "rev-parse", "HEAD").trim();
    writeFileSync(join(clone, "a.txt"), "b\n");
    git(clone, "commit", "-qam", "fake");
    git(clone, "replace", real, git(clone, "rev-parse", "HEAD").trim());
    const o = { env: { GIT_NO_REPLACE_OBJECTS: undefined } };
    expect(await crewGit(clone, ["cat-file", "-p", real], common(), o)).toContain("init");
  });

  it("runs with GIT_TERMINAL_PROMPT=0, so a remote that wants credentials fails, not waits", async () => {
    const dump = join(dir, "env-seen");
    const ssh = join(dir, "ssh.sh");
    writeFileSync(ssh, `#!/bin/sh\necho "$GIT_TERMINAL_PROMPT" > ${dump}\nexit 1\n`, {
      mode: 0o755,
    });
    git(clone, "config", "core.sshCommand", ssh);
    git(clone, "remote", "add", "origin", "ssh://example.invalid/r.git");
    await expect(crewGit(wt, ["ls-remote", "origin"], common())).rejects.toThrow();
    expect(readFileSync(dump, "utf8").trim()).toBe("0");
  });
});
