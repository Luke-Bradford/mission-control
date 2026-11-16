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
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CheckoutError,
  type InstallRunner,
  prepareCheckout,
  prepareScratch,
  resumeSeatCheckout,
  reviewTreePath,
  seatTreePath,
} from "../src/runtime/checkouts.ts";

let dir: string;
let clone: string;
let seed: string;
let root: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function commit(repo: string, files: Record<string, string>, msg = "c"): string {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), body);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", msg);
  return git(repo, "rev-parse", "HEAD");
}

const PKG = '{"name":"x","version":"1.0.0","private":true}\n';
const LOCK = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";

/** A fake pnpm: counts its runs and leaves a node_modules behind. */
function fakeInstall() {
  const runs: string[] = [];
  const run: InstallRunner = async (command, _args, options) => {
    if (command !== "pnpm") return;
    runs.push(options.cwd);
    mkdirSync(join(options.cwd, "node_modules"), { recursive: true });
    writeFileSync(join(options.cwd, "node_modules", "installed"), "1");
  };
  return { runs, run };
}

const seat = (issue: number, title = "Do the thing") => ({
  checkout: clone,
  worktreesRoot: root,
  sessionId: "a",
  seatId: "guido",
  issue,
  title,
  seatTree: true as const,
});
const worktreeCount = () =>
  git(clone, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length - 1;

/** Counts `git worktree add` runs through a shim ahead of git on PATH. */
let savedPath: string | undefined;
const addLog = () => join(dir, "worktree-adds");
function countWorktreeAdds(): void {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shim = join(dir, "shim");
  mkdirSync(shim);
  writeFileSync(
    join(shim, "git"),
    `#!/bin/sh\ncase " $* " in *" worktree add "*) echo add >> "${addLog()}";; esac\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  savedPath = process.env.PATH;
  process.env.PATH = `${shim}:${savedPath}`;
}
const adds = () =>
  existsSync(addLog()) ? readFileSync(addLog(), "utf8").trim().split("\n").length : 0;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-seat-tree-")));
  const origin = join(dir, "origin.git");
  seed = join(dir, "seed");
  clone = join(dir, "clone");
  root = join(dir, "worktrees");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main", seed);
  commit(seed, {
    "README.md": "hi\n",
    ".gitignore": "node_modules\n.cache\n",
    "package.json": PKG,
    "pnpm-lock.yaml": LOCK,
  });
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", origin, clone);
});
afterEach(() => {
  if (savedPath !== undefined) {
    process.env.PATH = savedPath;
    savedPath = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("one tree per seat", () => {
  it("a seat that starts a second ticket uses the same path and adds no worktree", async () => {
    const { run } = fakeInstall();
    countWorktreeAdds();
    const a = await prepareCheckout(seat(1), run);
    expect(a.path).toBe(seatTreePath(root, "a", "guido"));
    expect(a.created).toBe(true);
    commit(a.path, { "a.txt": "a\n" });
    const b = await prepareCheckout(seat(2), run);
    expect(b.path).toBe(a.path);
    expect(b.branch).toMatch(/^feature\/2-/);
    expect(git(b.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(b.branch);
    expect(existsSync(join(b.path, "a.txt"))).toBe(false);
    expect(adds()).toBe(1);
    expect(worktreeCount()).toBe(1);
  });

  it("refuses a switch with uncommitted changes and names the files", async () => {
    const { run } = fakeInstall();
    const a = await prepareCheckout(seat(1), run);
    writeFileSync(join(a.path, "README.md"), "edited\n");
    writeFileSync(join(a.path, "unsaved.txt"), "new\n");
    const e = await prepareCheckout(seat(2), run).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(CheckoutError);
    expect((e as CheckoutError).message).toContain("README.md");
    expect((e as CheckoutError).message).toContain("unsaved.txt");
    expect(git(a.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(a.branch);
    expect(readFileSync(join(a.path, "README.md"), "utf8")).toBe("edited\n");
  });

  it("removes files left outside git by the last ticket and keeps the install", async () => {
    const { run } = fakeInstall();
    const a = await prepareCheckout(seat(1), run);
    mkdirSync(join(a.path, ".cache", "deep"), { recursive: true });
    writeFileSync(join(a.path, ".cache", "deep", "x"), "x");
    const b = await prepareCheckout(seat(2), run);
    expect(existsSync(join(b.path, ".cache"))).toBe(false);
    expect(existsSync(join(b.path, "node_modules", "installed"))).toBe(true);
  });

  it("skips the install when the inputs match, reinstalls when they differ", async () => {
    const f = fakeInstall();
    await prepareCheckout(seat(1), f.run);
    expect(f.runs).toHaveLength(1);
    await prepareCheckout(seat(2), f.run);
    expect(f.runs).toHaveLength(1);
    // origin's lockfile changes: the next ticket's branch starts from it
    commit(seed, { "pnpm-lock.yaml": `${LOCK}\n# changed\n` });
    git(seed, "push", "-q", "origin", "main");
    const c = await prepareCheckout(seat(3), f.run);
    expect(f.runs).toHaveLength(2);
    expect(existsSync(join(c.path, "node_modules", "installed"))).toBe(true);
    await prepareCheckout(seat(4), f.run);
    expect(f.runs).toHaveLength(2);
  });

  it("still refuses a branch that changes an install input", async () => {
    const f = fakeInstall();
    const a = await prepareCheckout(seat(1), f.run);
    commit(a.path, { "package.json": `${PKG} ` });
    const e = await prepareCheckout(seat(2), f.run).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeNull(); // issue 2 starts clean from origin
    await prepareCheckout(seat(1), f.run).then(
      () => {
        throw new Error("expected a refusal");
      },
      (x: unknown) => {
        expect(x).toBeInstanceOf(CheckoutError);
        expect((x as CheckoutError).code).toBe("protected");
      },
    );
  });
});

describe("review seat tree", () => {
  const scratch = (sha: string, reviewId: number) => ({
    checkout: clone,
    worktreesRoot: root,
    sessionId: "a",
    seatId: "retro",
    reviewId,
    sha,
    seatTree: true as const,
  });
  const pr = (n: number, file: string) => {
    git(clone, "fetch", "-q", "origin");
    const tmp = join(dir, `pr${n}`);
    git(dir, "clone", "-q", join(dir, "origin.git"), tmp);
    git(tmp, "checkout", "-q", "-b", `pr${n}`);
    const sha = commit(tmp, { [file]: "x\n" });
    git(tmp, "push", "-q", "origin", `pr${n}`);
    git(clone, "fetch", "-q", "origin");
    return sha;
  };

  it("reuses one tree across two reviews, detached at each head", async () => {
    const f = fakeInstall();
    countWorktreeAdds();
    const one = pr(1, "one.txt");
    const two = pr(2, "two.txt");
    const s1 = await prepareScratch(scratch(one, 10), f.run);
    mkdirSync(join(s1.path, ".cache"), { recursive: true });
    writeFileSync(join(s1.path, ".cache", "x"), "x");
    const s2 = await prepareScratch(scratch(two, 11), f.run);
    expect(s2.path).toBe(s1.path);
    expect(s2.path).toBe(reviewTreePath(root, "a", "retro"));
    expect(git(s2.path, "rev-parse", "HEAD")).toBe(two);
    expect(() => git(s2.path, "symbolic-ref", "-q", "HEAD")).toThrow();
    expect(existsSync(join(s2.path, "one.txt"))).toBe(false);
    expect(existsSync(join(s2.path, ".cache"))).toBe(false);
    expect(adds()).toBe(1);
    expect(f.runs).toHaveLength(1);
  });
});

describe("a parked ticket", () => {
  it("has no tree of its own; resuming goes back to its branch with its commits", async () => {
    const { run } = fakeInstall();
    const a = await prepareCheckout(seat(1), run);
    const sha = commit(a.path, { "work.txt": "w\n" });
    // the seat moves on to another ticket while ticket 1 waits
    const b = await prepareCheckout(seat(2), run);
    expect(worktreeCount()).toBe(1);
    expect(existsSync(join(b.path, "work.txt"))).toBe(false);
    const back = await resumeSeatCheckout(
      { checkout: clone, worktreesRoot: root, sessionId: "a", seatId: "guido" },
      a.path,
      a.branch,
    );
    expect(back.path).toBe(a.path);
    expect(git(a.path, "rev-parse", "HEAD")).toBe(sha);
    expect(git(a.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(a.branch);
    expect(worktreeCount()).toBe(1);
  });
});
