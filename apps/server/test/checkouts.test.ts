import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  DIFF_CUT_LINE,
  REVIEW_DIFF_FILE,
  REVIEW_DIFF_MAX,
  REVIEW_INPUT_DIR,
  REVIEW_SINCE_FILE,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CheckoutError,
  existingCheckout,
  existingScratch,
  INSTALL_ARGS,
  installEnv,
  prepareCheckout,
  prepareDetachedCheckout,
  preparePlanCheckout,
  prepareScratch,
  removeCheckout,
  writeReviewInputs,
} from "../src/runtime/checkouts.ts";

let dir: string;
let origin: string;
let seed: string;
let clone: string;
let root: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Commits `files` in `repo` (paths may be nested) and returns the new SHA. */
function commit(repo: string, files: Record<string, string>, msg = "c"): string {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), body);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", msg);
  return git(repo, "rev-parse", "HEAD");
}

const TITLE = "Fix the stop() race in the Claude adapter!";
const BRANCH = "feature/42-fix-the-stop-race-in-the-claude-adapter";
const input = () => ({
  checkout: clone,
  worktreesRoot: root,
  sessionId: "a",
  seatId: "guido",
  issue: 42,
  title: TITLE,
});
const wtPath = () => join(root, "a", "guido-42");
const fail = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a CheckoutError");
    },
    (e) => {
      expect(e).toBeInstanceOf(CheckoutError);
      return e as CheckoutError;
    },
  );
const worktrees = () =>
  git(clone, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "));
const hasBranch = (b: string) => {
  try {
    git(clone, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`);
    return true;
  } catch {
    return false;
  }
};

const EMPTY_LOCK = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";
const PKG = '{"name":"x","version":"1.0.0","private":true}\n';

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-checkouts-")));
  origin = join(dir, "origin.git");
  seed = join(dir, "seed");
  clone = join(dir, "clone");
  root = join(dir, "worktrees");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main", seed);
  commit(seed, { "README.md": "hi\n", ".gitignore": "node_modules\n" }, "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", origin, clone);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("prepareCheckout", () => {
  it("creates a fresh branch from origin's default branch, read from origin itself", async () => {
    // origin moved on since the clone, and a seat pointed the local origin/HEAD at its own ref
    const tip = commit(seed, { "b.txt": "b\n" });
    git(seed, "push", "-q", "origin", "main");
    const evil = commit(clone, { "evil.txt": "x\n" });
    git(clone, "reset", "-q", "--hard", "HEAD~1");
    git(clone, "update-ref", "refs/remotes/origin/evil", evil);
    git(clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/evil");

    const r = await prepareCheckout(input());
    expect(r).toMatchObject({ branch: BRANCH, path: wtPath(), created: true, baseSha: tip });
    expect(git(wtPath(), "rev-parse", "HEAD")).toBe(tip);
    expect(git(wtPath(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(realpathSync(r.gitDir)).toBe(
      realpathSync(git(wtPath(), "rev-parse", "--absolute-git-dir")),
    );
    expect(dirname(r.gitDir)).toBe(join(clone, ".git", "worktrees"));
  });

  it("reuses a worktree that is still at the old flat path, and makes new ones in the session folder", async () => {
    const flat = join(root, "guido-42");
    git(clone, "worktree", "add", "-q", "-b", BRANCH, flat);
    const r = await prepareCheckout(input());
    expect(r).toMatchObject({ branch: BRANCH, path: flat, created: false });
    expect(existsSync(wtPath())).toBe(false);
    const fresh = await prepareCheckout({ ...input(), issue: 43, title: "Another" });
    expect(dirname(fresh.path)).toBe(join(root, "a"));
  });

  it("refuses a session id that is not a folder name", async () => {
    const e = await fail(prepareCheckout({ ...input(), sessionId: "../x" }));
    expect(e.code).toBe("path");
    expect(worktrees()).toHaveLength(1);
  });

  it("works from a checkout on a detached HEAD (the base never comes from it)", async () => {
    git(clone, "checkout", "-q", "--detach");
    const r = await prepareCheckout(input());
    expect(r.created).toBe(true);
  });

  it("reuses an existing local branch and keeps its commits", async () => {
    git(clone, "checkout", "-q", "-b", BRANCH);
    const mine = commit(clone, { "work.txt": "w\n" });
    git(clone, "checkout", "-q", "main");
    const r = await prepareCheckout(input());
    expect(r.created).toBe(true);
    expect(git(wtPath(), "rev-parse", "HEAD")).toBe(mine);
  });

  it("checks out a branch only origin has, tracking origin", async () => {
    git(seed, "checkout", "-q", "-b", BRANCH);
    const theirs = commit(seed, { "work.txt": "w\n" });
    git(seed, "push", "-q", "origin", BRANCH);
    const r = await prepareCheckout(input());
    expect(r.created).toBe(true);
    expect(git(wtPath(), "rev-parse", "HEAD")).toBe(theirs);
    expect(git(wtPath(), "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${BRANCH}`);
  });

  it("ignores a remote-tracking ref origin does not have", async () => {
    const planted = commit(clone, { "evil.txt": "x\n" });
    git(clone, "reset", "-q", "--hard", "HEAD~1");
    git(clone, "update-ref", `refs/remotes/origin/${BRANCH}`, planted);
    const r = await prepareCheckout(input());
    expect(git(wtPath(), "rev-parse", "HEAD")).toBe(r.baseSha);
  });

  it("reuses this ticket's existing worktree as it is", async () => {
    const first = await prepareCheckout(input());
    writeFileSync(join(wtPath(), "wip.txt"), "wip\n");
    const again = await prepareCheckout(input());
    expect(again).toEqual({ ...first, created: false });
    expect(existsSync(join(wtPath(), "wip.txt"))).toBe(true);
  });

  it("refuses a path that is not this ticket's checkout", async () => {
    mkdirSync(wtPath(), { recursive: true });
    writeFileSync(join(wtPath(), "x"), "x\n");
    const e = await fail(prepareCheckout(input()));
    expect(e.code).toBe("path");
    // fixed text for the route; the path is the server log's (detail)
    expect(e.message).toBe(
      "the worktree path for guido-42 exists and is not this ticket's checkout",
    );
    expect(e.detail).toBe(wtPath());
    rmSync(wtPath(), { recursive: true });
    // a worktree of another branch at that path
    git(clone, "worktree", "add", "-q", "-b", "other", wtPath());
    expect((await fail(prepareCheckout(input()))).code).toBe("path");
  });

  it("refuses a dirty, missing or non-top-level checkout", async () => {
    writeFileSync(join(clone, "stray.txt"), "s\n");
    const e = await fail(prepareCheckout(input()));
    expect(e.code).toBe("checkout");
    expect(e.message).toBe("the crew checkout is missing or has uncommitted changes");
    rmSync(join(clone, "stray.txt"));
    mkdirSync(join(clone, "sub"));
    writeFileSync(join(clone, "sub", "f"), "f\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "sub");
    expect((await fail(prepareCheckout({ ...input(), checkout: join(clone, "sub") }))).code).toBe(
      "checkout",
    );
    expect((await fail(prepareCheckout({ ...input(), checkout: join(dir, "nope") }))).code).toBe(
      "checkout",
    );
    expect(existsSync(root)).toBe(false);
  });

  it("reports an unreachable origin and creates nothing", async () => {
    git(clone, "remote", "set-url", "origin", join(dir, "gone.git"));
    const e = await fail(prepareCheckout(input()));
    expect(e.code).toBe("fetch");
    expect(e.message).toBe("could not reach origin");
    expect(existsSync(root)).toBe(false);
    expect(hasBranch(BRANCH)).toBe(false);
  });

  it("reports an origin with no default branch", async () => {
    git(origin, "symbolic-ref", "HEAD", "refs/heads/none");
    const e = await fail(prepareCheckout(input()));
    expect(e.code).toBe("base");
    expect(e.message).toBe("origin has no default branch");
    expect(existsSync(root)).toBe(false);
  });

  it("reports a branch git will not check out (it is the checkout's own)", async () => {
    git(clone, "checkout", "-q", "-b", BRANCH);
    const e = await fail(prepareCheckout(input()));
    expect(e.code).toBe("worktree");
    expect(e.message).toBe(`could not create a worktree for ${BRANCH}`);
    // git's own text (it names paths) is the server log's, not the route's
    expect(e.detail).toMatch(/\S/);
    expect(e.message).not.toContain(dir);
    expect(worktrees()).toHaveLength(1);
  });

  it("refuses a seat id that is not one", async () => {
    const e = await fail(prepareCheckout({ ...input(), seatId: "../x" }));
    expect(e.code).toBe("path");
    expect(existsSync(root)).toBe(false);
  });

  it("installs dependencies in a new worktree that has a pnpm lockfile", async () => {
    commit(seed, { "package.json": PKG, "pnpm-lock.yaml": EMPTY_LOCK });
    git(seed, "push", "-q", "origin", "main");
    await prepareCheckout(input());
    expect(existsSync(join(wtPath(), "node_modules"))).toBe(true);
    expect(git(wtPath(), "status", "--porcelain")).toBe("");
  });

  it("removes the worktree and the fresh branch when the install fails", async () => {
    commit(seed, { "package.json": PKG, "pnpm-lock.yaml": "garbage: [\n" });
    git(seed, "push", "-q", "origin", "main");
    const e = await fail(prepareCheckout(input()));
    expect(e.code).toBe("install");
    expect(e.message).toMatch(new RegExp(`^pnpm install failed for ${BRANCH}`));
    expect(existsSync(wtPath())).toBe(false);
    expect(worktrees()).toHaveLength(1);
    expect(hasBranch(BRANCH)).toBe(false);
  });

  it("installs with clone-or-copy, never hardlinks into the shared store", () => {
    expect(INSTALL_ARGS).toEqual([
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--package-import-method=clone-or-copy",
    ]);
  });

  it("installs without CI markers, npm_* or GIT_* from the server's environment", () => {
    const keys = [
      "CI",
      "CONTINUOUS_INTEGRATION",
      "BUILD_NUMBER",
      "RUN_ID",
      "GITHUB_ACTIONS",
      "npm_config_x",
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) process.env[k] = "1";
    try {
      const env = installEnv("/w/guido-42");
      for (const k of keys.filter((k) => k !== "CI")) expect(env[k]).toBeUndefined();
      // ci-info reads CI=false as "not CI" whatever the vendor variables say
      expect(env.CI).toBe("false");
      // pnpm never walks up to an ancestor's workspace
      expect(env.NPM_CONFIG_WORKSPACE_DIR).toBe("/w/guido-42");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  describe("install inputs are checked by content against origin's verified objects", () => {
    const WS = "packages:\n  - packages/*\n";
    beforeEach(() => {
      commit(seed, {
        "package.json": PKG,
        "pnpm-lock.yaml": EMPTY_LOCK,
        "pnpm-workspace.yaml": WS,
        "packages/x/src.ts": "x\n",
      });
      git(seed, "push", "-q", "origin", "main");
      git(clone, "pull", "-q");
    });

    it("refuses when a base object in the clone was rewritten", async () => {
      const id = git(clone, "rev-parse", "HEAD:pnpm-workspace.yaml");
      const loose = join(clone, ".git", "objects", id.slice(0, 2), id.slice(2));
      expect(existsSync(loose)).toBe(true);
      const evil = Buffer.from("modulesDir: /tmp/elsewhere\n");
      rmSync(loose, { force: true }); // replace, never write through: it may be hardlinked
      writeFileSync(
        loose,
        deflateSync(Buffer.concat([Buffer.from(`blob ${evil.length}\0`), evil])),
      );
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("protected");
      expect(e.message).toBe("the clone's objects don't match origin");
      expect(existsSync(wtPath())).toBe(false);
      expect(hasBranch(BRANCH)).toBe(false);
    });

    it("refuses an install input that differs on disk though the branch's ref is clean", async () => {
      commit(seed, { ".gitattributes": "pnpm-workspace.yaml filter=plant\n" });
      git(seed, "push", "-q", "origin", "main");
      git(clone, "pull", "-q");
      git(clone, "branch", BRANCH);
      git(clone, "config", "filter.plant.smudge", "sh -c 'cat; echo modulesDir: /tmp/elsewhere'");
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("protected");
      expect(e.message).toBe(
        `branch ${BRANCH} changes pnpm-workspace.yaml; Mission Control won't install from it`,
      );
      expect(existsSync(wtPath())).toBe(false);
      expect(hasBranch(BRANCH)).toBe(true);
    });

    /** Checkout runs `script` (in the worktree root) as a side effect of smudging x.txt. */
    const onCheckout = (script: string) => {
      commit(seed, { ".gitattributes": "x.txt filter=plant\n", "x.txt": "x\n" });
      git(seed, "push", "-q", "origin", "main");
      git(clone, "config", "filter.plant.smudge", `sh -c '${script}; cat'`);
    };

    it.each([
      "packages/x/package.json",
      "packages/a/package.yaml",
      "packages/a/package.json5",
      ".pnpmfile.mjs",
    ])("refuses an install input on disk that the base does not have: %s", async (file) => {
      onCheckout(`mkdir -p "$(dirname ${file})" && printf {} > ${file}`);
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("protected");
      expect(e.message).toBe(
        `branch ${BRANCH} changes ${file}; Mission Control won't install from it`,
      );
      expect(existsSync(wtPath())).toBe(false);
    });

    it("refuses a worktree missing the base's root pnpm-workspace.yaml", async () => {
      onCheckout("rm -f pnpm-workspace.yaml");
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("protected");
      expect(e.message).toBe(
        `branch ${BRANCH} changes pnpm-workspace.yaml; Mission Control won't install from it`,
      );
      expect(existsSync(join(dir, "node_modules"))).toBe(false);
      expect(existsSync(wtPath())).toBe(false);
    });

    it("installs when every install input matches the base", async () => {
      await prepareCheckout(input());
      expect(existsSync(join(wtPath(), "node_modules"))).toBe(true);
    });
  });

  describe("a tree with a symlink or a node_modules path", () => {
    let outside: string;
    beforeEach(() => {
      outside = join(dir, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "keep\n");
      commit(seed, { "package.json": PKG, "pnpm-lock.yaml": EMPTY_LOCK });
    });
    const pushLink = (at: string) => {
      mkdirSync(dirname(join(seed, at)), { recursive: true });
      symlinkSync(outside, join(seed, at));
      git(seed, "add", "-f", "--", at);
      git(seed, "commit", "-qm", "link");
      git(seed, "push", "-q", "origin", "main");
    };

    it.each(["node_modules", "packages/x/node_modules", "docs/link"])(
      "refuses a symlink at %s and touches nothing outside the worktree",
      async (at) => {
        pushLink(at);
        const e = await fail(prepareCheckout(input()));
        expect(e.code).toBe("protected");
        expect(e.message).toBe(
          `branch ${BRANCH} has a symlink at ${at}; Mission Control won't install from it`,
        );
        expect(readdirSync(outside)).toEqual(["keep.txt"]);
        expect(existsSync(wtPath())).toBe(false);
        expect(hasBranch(BRANCH)).toBe(false);
      },
    );

    it("refuses a tracked path under node_modules", async () => {
      writeFileSync(join(seed, "x.js"), "x\n");
      mkdirSync(join(seed, "packages", "y", "node_modules", "dep"), { recursive: true });
      writeFileSync(join(seed, "packages", "y", "node_modules", "dep", "index.js"), "x\n");
      git(seed, "add", "-f", "-A");
      git(seed, "commit", "-qm", "nm");
      git(seed, "push", "-q", "origin", "main");
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("protected");
      expect(e.message).toBe(
        `branch ${BRANCH} has packages/y/node_modules/dep/index.js; Mission Control won't install from it`,
      );
      expect(existsSync(wtPath())).toBe(false);
    });

    it("refuses a tracked NODE_MODULES that a case-insensitive disk reads as node_modules", async (ctx) => {
      writeFileSync(join(dir, "CaseProbe"), "");
      if (!existsSync(join(dir, "caseprobe"))) ctx.skip();
      mkdirSync(join(seed, "NODE_MODULES"));
      writeFileSync(join(seed, "NODE_MODULES", ".modules.yaml"), "x: 1\n");
      git(seed, "add", "-f", "--", "NODE_MODULES/.modules.yaml");
      git(seed, "commit", "-qm", "nm");
      git(seed, "push", "-q", "origin", "main");
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("protected");
      expect(e.message).toBe(
        `branch ${BRANCH} has node_modules; Mission Control won't install from it`,
      );
      expect(existsSync(wtPath())).toBe(false);
    });

    it("refuses a symlink that is on disk but not in the branch's tree", async () => {
      // A smudge filter in the clone's own config plants a link during checkout: what is on disk
      // differs from what ls-tree read, as when another seat moves the ref mid-start.
      commit(seed, { ".gitattributes": "x.txt filter=plant\n", "x.txt": "x\n" });
      git(seed, "push", "-q", "origin", "main");
      git(clone, "config", "filter.plant.smudge", `sh -c 'ln -sf ${outside} planted; cat'`);
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("protected");
      expect(e.message).toBe(
        `branch ${BRANCH} has a symlink at planted; Mission Control won't install from it`,
      );
      expect(readdirSync(outside)).toEqual(["keep.txt"]);
      expect(existsSync(wtPath())).toBe(false);
    });

    it("refuses the same on a reused branch", async () => {
      git(seed, "push", "-q", "origin", "main");
      git(clone, "pull", "-q");
      git(clone, "checkout", "-q", "-b", BRANCH);
      symlinkSync(outside, join(clone, "node_modules"));
      git(clone, "add", "-f", "--", "node_modules");
      git(clone, "commit", "-qm", "link");
      git(clone, "checkout", "-q", "main");
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("protected");
      expect(readdirSync(outside)).toEqual(["keep.txt"]);
      expect(hasBranch(BRANCH)).toBe(true);
    });
  });

  describe("a reused branch that changes what the install reads", () => {
    beforeEach(() => {
      commit(seed, { "package.json": PKG, "pnpm-lock.yaml": EMPTY_LOCK, ".npmrc": "x=1\n" });
      git(seed, "push", "-q", "origin", "main");
      git(clone, "pull", "-q");
      git(clone, "checkout", "-q", "-b", BRANCH);
    });

    it.each([
      ["packages/x/package.json", () => commit(clone, { "packages/x/package.json": PKG })],
      ["pnpm-lock.yaml", () => commit(clone, { "pnpm-lock.yaml": `${EMPTY_LOCK}\n` })],
      ["deep/.pnpmfile.cjs", () => commit(clone, { "deep/.pnpmfile.cjs": "x\n" })],
      [
        ".npmrc",
        () => {
          git(clone, "mv", ".npmrc", "renamed");
          git(clone, "commit", "-qm", "mv");
        },
      ],
    ])("refuses to install when the branch changes %s", async (file, change) => {
      change();
      const tip = git(clone, "rev-parse", "HEAD");
      git(clone, "checkout", "-q", "main");
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("protected");
      expect(e.message).toBe(
        `branch ${BRANCH} changes ${file}; Mission Control won't install from it`,
      );
      expect(existsSync(wtPath())).toBe(false);
      expect(git(clone, "rev-parse", `refs/heads/${BRANCH}`)).toBe(tip);
    });

    it("installs when the branch changes other files only", async () => {
      commit(clone, { "src/a.ts": "a\n" });
      git(clone, "checkout", "-q", "main");
      await prepareCheckout(input());
      expect(existsSync(join(wtPath(), "node_modules"))).toBe(true);
    });
  });
});

describe("preparePlanCheckout", () => {
  const planInput = () => {
    const { title: _title, ...rest } = input();
    return rest;
  };

  it("plan checkout is detached at origin's tip, no branch", async () => {
    const tip = commit(seed, { "b.txt": "b\n" });
    git(seed, "push", "-q", "origin", "main");
    const r = await preparePlanCheckout(planInput());
    expect(r).toMatchObject({ branch: "", path: wtPath(), created: true, baseSha: tip });
    expect(git(wtPath(), "rev-parse", "HEAD")).toBe(tip);
    expect(() => git(wtPath(), "symbolic-ref", "--quiet", "HEAD")).toThrow();
    expect(dirname(r.gitDir)).toBe(join(clone, ".git", "worktrees"));
    expect(existsSync(join(wtPath(), "node_modules"))).toBe(false);
  });

  it("a leftover is replaced", async () => {
    await preparePlanCheckout(planInput());
    writeFileSync(join(wtPath(), "stale.txt"), "s\n");
    const again = await preparePlanCheckout(planInput());
    expect(again.created).toBe(true);
    expect(existsSync(join(wtPath(), "stale.txt"))).toBe(false);
    expect(worktrees()).toHaveLength(2);
  });

  it("refuses a path that is not a worktree", async () => {
    mkdirSync(wtPath(), { recursive: true });
    writeFileSync(join(wtPath(), "x"), "x\n");
    const e = await fail(preparePlanCheckout(planInput()));
    expect(e.code).toBe("path");
    expect(existsSync(join(wtPath(), "x"))).toBe(true);
  });
});

describe("prepareDetachedCheckout", () => {
  const flightInput = (name = "flight-1-watch") => ({
    checkout: clone,
    worktreesRoot: root,
    sessionId: "a",
    name,
  });

  it("is detached at origin's tip with no new branch, at {root}/{name}", async () => {
    const tip = commit(seed, { "b.txt": "b\n" });
    git(seed, "push", "-q", "origin", "main");
    const branches = git(clone, "branch", "--list");
    const r = await prepareDetachedCheckout(flightInput());
    expect(r).toMatchObject({
      branch: "",
      path: join(root, "a", "flight-1-watch"),
      created: true,
      baseSha: tip,
    });
    expect(git(r.path, "rev-parse", "HEAD")).toBe(tip);
    expect(() => git(r.path, "symbolic-ref", "--quiet", "HEAD")).toThrow();
    expect(git(clone, "branch", "--list")).toBe(branches);
  });

  it("replaces a leftover", async () => {
    const first = await prepareDetachedCheckout(flightInput());
    writeFileSync(join(first.path, "stale.txt"), "s\n");
    const again = await prepareDetachedCheckout(flightInput());
    expect(existsSync(join(again.path, "stale.txt"))).toBe(false);
    expect(worktrees()).toHaveLength(2);
  });

  it.each(["Flight", "../x", "", "-x", "a/b"])("refuses the name %j", async (name) => {
    const e = await fail(prepareDetachedCheckout(flightInput(name)));
    expect(e.code).toBe("path");
    expect(e.message).toBe(`${name} is not a seat checkout name`);
  });
});

describe("review scratch checkouts", () => {
  const scratchPath = () => join(root, "a", "retro-review-7");
  /** A PR branch off main's current tip; main then moves on. Returns { head, fork }. */
  function pr(files: Record<string, string>): { head: string; fork: string } {
    const fork = git(seed, "rev-parse", "HEAD");
    git(seed, "checkout", "-q", "-b", "pr");
    const head = commit(seed, files, "pr change");
    git(seed, "push", "-q", "origin", "pr");
    git(seed, "checkout", "-q", "main");
    return { head, fork };
  }
  const scratchInput = (sha: string) => ({
    checkout: clone,
    worktreesRoot: root,
    sessionId: "a",
    seatId: "retro",
    reviewId: 7,
    sha,
  });

  it("prepareScratch checks out the sha detached", async () => {
    const { head, fork } = pr({ "a.txt": "a\n" });
    commit(seed, { "later.txt": "l\n" });
    git(seed, "push", "-q", "origin", "main");
    const s = await prepareScratch(scratchInput(head));
    expect(s.path).toBe(scratchPath());
    expect(git(scratchPath(), "rev-parse", "HEAD")).toBe(head);
    expect(() => git(scratchPath(), "symbolic-ref", "-q", "HEAD")).toThrow();
    expect(s.mergeBase).toBe(fork);
    expect(s.baseSha).toBe(git(seed, "rev-parse", "main"));
    expect(dirname(s.gitDir)).toBe(join(clone, ".git", "worktrees"));
  });

  it("prepareScratch refuses a sha the clone lacks", async () => {
    const e = await fail(prepareScratch(scratchInput("a".repeat(40))));
    expect(e.code).toBe("base");
    expect(e.message).toBe("the PR's head commit is not in the clone");
    expect(existsSync(scratchPath())).toBe(false);
  });

  it("prepareScratch refuses names that are not review checkouts", async () => {
    const { head } = pr({ "a.txt": "a\n" });
    for (const bad of [
      { ...scratchInput(head), reviewId: 0 },
      { ...scratchInput(head), seatId: "../x" },
      { ...scratchInput(head), sha: "main" },
      { ...scratchInput(head), worktreesRoot: "rel" },
    ]) {
      expect((await fail(prepareScratch(bad))).code).toBe("path");
    }
  });

  it("a leftover worktree of the same review is replaced", async () => {
    const { head } = pr({ "a.txt": "a\n" });
    await prepareScratch(scratchInput(head));
    writeFileSync(join(scratchPath(), "stale.txt"), "s\n");
    await prepareScratch(scratchInput(head));
    expect(existsSync(join(scratchPath(), "stale.txt"))).toBe(false);
    expect(worktrees()).toHaveLength(2);
  });

  it("prepareScratch refuses a path that is not a worktree", async () => {
    const { head } = pr({ "a.txt": "a\n" });
    mkdirSync(scratchPath(), { recursive: true });
    writeFileSync(join(scratchPath(), "x"), "x\n");
    const e = await fail(prepareScratch(scratchInput(head)));
    expect(e.code).toBe("path");
    expect(existsSync(join(scratchPath(), "x"))).toBe(true);
  });

  it("install inputs are judged at the merge base", async () => {
    commit(seed, { "package.json": PKG, "pnpm-lock.yaml": EMPTY_LOCK });
    git(seed, "push", "-q", "origin", "main");
    const { head } = pr({ "a.txt": "a\n" });
    // main changes the lockfile after the branch point
    commit(seed, { "pnpm-lock.yaml": `${EMPTY_LOCK}\n` });
    git(seed, "push", "-q", "origin", "main");
    await prepareScratch(scratchInput(head));
    expect(existsSync(join(scratchPath(), "node_modules"))).toBe(true);
  });

  it("a PR head that changes an install input is refused and removed", async () => {
    commit(seed, { "package.json": PKG, "pnpm-lock.yaml": EMPTY_LOCK });
    git(seed, "push", "-q", "origin", "main");
    const { head } = pr({ "package.json": `${PKG}\n` });
    const e = await fail(prepareScratch(scratchInput(head)));
    expect(e.code).toBe("protected");
    expect(e.message).toBe(
      `the PR head ${head.slice(0, 7)} changes package.json; Mission Control won't install from it`,
    );
    expect(existsSync(scratchPath())).toBe(false);
    expect(worktrees()).toHaveLength(1);
  });

  describe("writeReviewInputs", () => {
    const read = (f: string) => readFileSync(join(scratchPath(), f), "utf8");

    it("writes the branch's diff, and the diff since the last review", async () => {
      const { head: first } = pr({ "a.txt": "a\n" });
      git(seed, "checkout", "-q", "pr");
      const second = commit(seed, { "b.txt": "b\n" });
      git(seed, "push", "-q", "origin", "pr");
      git(seed, "checkout", "-q", "main");
      commit(seed, { "main-only.txt": "m\n" });
      git(seed, "push", "-q", "origin", "main");
      const s = await prepareScratch(scratchInput(second));
      const r = await writeReviewInputs(clone, s, second, first);
      expect(r).toEqual({ diffCut: false, since: true });
      const all = read(REVIEW_DIFF_FILE);
      expect(all).toContain("+++ b/a.txt");
      expect(all).toContain("+++ b/b.txt");
      expect(all).not.toContain("main-only.txt");
      const since = read(REVIEW_SINCE_FILE);
      expect(since).toContain("+++ b/b.txt");
      expect(since).not.toContain("a.txt");
    });

    it("writes no since file without a known previous sha", async () => {
      const { head } = pr({ "a.txt": "a\n" });
      const s = await prepareScratch(scratchInput(head));
      for (const prev of [null, "b".repeat(40)]) {
        rmSync(join(scratchPath(), REVIEW_INPUT_DIR), { recursive: true, force: true });
        expect(await writeReviewInputs(clone, s, head, prev)).toEqual({
          diffCut: false,
          since: false,
        });
        expect(existsSync(join(scratchPath(), REVIEW_SINCE_FILE))).toBe(false);
      }
    });

    it("cuts a 2 MiB change at 1 MiB, on a character boundary", async () => {
      const { head } = pr({ "big.txt": "é".repeat(1024 * 1024) });
      const s = await prepareScratch(scratchInput(head));
      const r = await writeReviewInputs(clone, s, head, null);
      expect(r.diffCut).toBe(true);
      const text = read(REVIEW_DIFF_FILE);
      expect(text.endsWith(DIFF_CUT_LINE)).toBe(true);
      expect(text).not.toContain("�");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(REVIEW_DIFF_MAX + DIFF_CUT_LINE.length);
    });
  });

  describe("existingScratch", () => {
    it("accepts the made worktree, and refuses another sha or a non-worktree", async () => {
      const { head, fork } = pr({ "a.txt": "a\n" });
      const s = await prepareScratch(scratchInput(head));
      expect(await existingScratch(clone, scratchPath(), head)).toEqual({
        path: scratchPath(),
        gitDir: s.gitDir,
      });
      expect((await fail(existingScratch(clone, scratchPath(), fork))).code).toBe("path");
      mkdirSync(join(root, "plain"));
      expect((await fail(existingScratch(clone, join(root, "plain"), head))).code).toBe("path");
    });

    it("refuses a worktree that is on a branch", async () => {
      const { head } = pr({ "a.txt": "a\n" });
      await prepareScratch(scratchInput(head));
      git(scratchPath(), "checkout", "-q", "-b", "mine");
      expect((await fail(existingScratch(clone, scratchPath(), head))).code).toBe("path");
    });
  });
});

describe("removeCheckout", () => {
  it("removes a clean worktree and keeps its branch (ignored files do not count)", async () => {
    await prepareCheckout(input());
    mkdirSync(join(wtPath(), "node_modules"));
    await removeCheckout(clone, wtPath());
    expect(existsSync(wtPath())).toBe(false);
    expect(hasBranch(BRANCH)).toBe(true);
  });

  it("refuses a worktree with uncommitted changes", async () => {
    await prepareCheckout(input());
    writeFileSync(join(wtPath(), "wip.txt"), "wip\n");
    const e = await fail(removeCheckout(clone, wtPath()));
    expect(e.code).toBe("dirty");
    expect(e.message).toBe(`${wtPath()} has uncommitted changes`);
    expect(existsSync(join(wtPath(), "wip.txt"))).toBe(true);
    expect(hasBranch(BRANCH)).toBe(true);
  });

  it("with force, removes a worktree with uncommitted changes and keeps its branch", async () => {
    await prepareCheckout(input());
    writeFileSync(join(wtPath(), "wip.txt"), "wip\n");
    await removeCheckout(clone, wtPath(), { force: true });
    expect(existsSync(wtPath())).toBe(false);
    expect(hasBranch(BRANCH)).toBe(true);
  });

  it("with force, still refuses a path that is not one of the checkout's worktrees", async () => {
    mkdirSync(join(dir, "elsewhere"));
    expect((await fail(removeCheckout(clone, join(dir, "elsewhere"), { force: true }))).code).toBe(
      "path",
    );
    expect(readdirSync(join(dir, "elsewhere"))).toEqual([]);
  });

  it("refuses a path that is not one of the checkout's worktrees", async () => {
    mkdirSync(join(dir, "elsewhere"));
    expect((await fail(removeCheckout(clone, join(dir, "elsewhere")))).code).toBe("path");
    expect((await fail(removeCheckout(clone, clone))).code).toBe("path");
    expect(readdirSync(join(dir, "elsewhere"))).toEqual([]);
  });
});

describe("existingCheckout", () => {
  it("gives a run's worktree back with its branch and git dir, read from the clone's side", async () => {
    const made = await prepareCheckout(input());
    expect(await existingCheckout(clone, wtPath(), BRANCH)).toEqual({
      branch: BRANCH,
      path: wtPath(),
      gitDir: made.gitDir,
    });
  });

  it("refuses a missing path, a path that is not a worktree, or another branch", async () => {
    expect((await fail(existingCheckout(clone, wtPath(), BRANCH))).code).toBe("path");
    mkdirSync(join(dir, "elsewhere"));
    expect((await fail(existingCheckout(clone, join(dir, "elsewhere"), BRANCH))).code).toBe("path");
    await prepareCheckout(input());
    expect((await fail(existingCheckout(clone, wtPath(), "feature/other"))).code).toBe("path");
  });

  it("refuses a worktree whose .git pointer a seat redirected", async () => {
    await prepareCheckout(input());
    const other = join(dir, "other");
    git(dir, "init", "-q", other);
    writeFileSync(join(wtPath(), ".git"), `gitdir: ${join(other, ".git")}\n`);
    expect((await fail(existingCheckout(clone, wtPath(), BRANCH))).code).toBe("path");
  });
});
