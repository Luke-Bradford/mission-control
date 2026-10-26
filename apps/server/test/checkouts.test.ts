import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
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
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import {
  DIFF_CUT_LINE,
  MC_TMP_DIR_NAME,
  PNPM_STORE_DIR_NAME,
  REVIEW_DIFF_FILE,
  REVIEW_DIFF_MAX,
  REVIEW_INPUT_DIR,
  REVIEW_SINCE_FILE,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CheckoutError,
  COMMIT_ADD_PATHSPEC,
  existingCheckout,
  existingDetached,
  existingReadOnlyCheckout,
  existingScratch,
  INSTALL_ARGS,
  type InstallRunner,
  installAfterSync,
  installEnv,
  MC_MERGE_AUTHOR,
  prepareCheckout,
  prepareDetachedCheckout,
  preparePlanCheckout,
  prepareReadOnlyCheckout,
  prepareScratch,
  removeCheckout,
  syncReusedWorktree,
  UV_SYNC_ARGS,
  uvInstallEnv,
  writeReviewInputs,
} from "../src/runtime/checkouts.ts";

let dir: string;
let origin: string;
let seed: string;
let clone: string;
let root: string;
let savedGitPath: string | undefined;

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
const pendingSet = () => {
  const s = new Set<string>();
  return {
    s,
    pending: {
      isPending: (path: string) => s.has(path),
      markPending: (path: string) => {
        s.add(path);
      },
      clearPending: (path: string) => {
        s.delete(path);
      },
    },
  };
};
const ro = (issue = 42) =>
  prepareReadOnlyCheckout({
    checkout: clone,
    worktreesRoot: root,
    sessionId: "a",
    seatId: "retro",
    issue,
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

function expectPrivateCodexPnpmStore(worktree: string): void {
  const root = realpathSync(worktree);
  for (const [path, expected] of [
    [join(worktree, MC_TMP_DIR_NAME), join(root, MC_TMP_DIR_NAME)],
    [join(worktree, MC_TMP_DIR_NAME, "pnpm-store"), join(root, MC_TMP_DIR_NAME, "pnpm-store")],
  ]) {
    const stat = lstatSync(path);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.uid).toBe(process.getuid?.());
    expect(stat.mode & 0o777).toBe(0o700);
    expect(realpathSync(path)).toBe(expected);
  }
}

/** Plant disk changes after worktree creation without configuring a git helper. */
function afterWorktreeAdd(script: string): void {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shim = join(dir, "checkout-shim");
  mkdirSync(shim);
  writeFileSync(
    join(shim, "git"),
    `#!/bin/sh
"${realGit}" "$@" || exit "$?"
case " $* " in
  *" worktree add "*)
    previous=""
    last=""
    for arg do previous="$last"; last="$arg"; done
    cd "$previous" || exit 1
    ${script}
    ;;
esac
`,
    { mode: 0o755 },
  );
  savedGitPath = process.env.PATH;
  process.env.PATH = `${shim}:${savedGitPath}`;
}

const EMPTY_LOCK = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";
const PKG = '{"name":"x","version":"1.0.0","private":true}\n';

const PYPROJECT = '[project]\nname = "x"\nversion = "0"\n';
const UV_LOCK = "version = 1\n";
const execFileP = promisify(execFile);

function useFakeUv(): InstallRunner {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = {
      PATH: process.env.PATH,
      UV_INDEX_URL: process.env.UV_INDEX_URL,
      PIP_INDEX_URL: process.env.PIP_INDEX_URL,
    };
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "uv"),
      `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/uv-argv"
pwd -P > "${dir}/uv-cwd"
env > "${dir}/uv-env"
exit "$(cat "${dir}/uv-exit" 2>/dev/null || echo 0)"
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.UV_INDEX_URL = "http://uv.invalid";
    process.env.PIP_INDEX_URL = "http://pip.invalid";
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // Pin uv to the fixture even if PATH changes: never invoke an installed uv.
  return (command, args, options) =>
    execFileP(command === "uv" ? join(dir, "bin", "uv") : command, args, options);
}
const uvArgv = () =>
  existsSync(join(dir, "uv-argv"))
    ? readFileSync(join(dir, "uv-argv"), "utf8").trim().split("\n")
    : null;
const uvEnvKeys = () =>
  readFileSync(join(dir, "uv-env"), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("=", 1)[0] ?? "");

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
afterEach(() => {
  if (savedGitPath !== undefined) {
    process.env.PATH = savedGitPath;
    savedGitPath = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function syncCheckout() {
  const checkout = await prepareCheckout(input());
  return { ...checkout, synced: await syncReusedWorktree(clone, checkout, { syncMain: true }) };
}

describe("prepareCheckout", () => {
  it.each([false, true])("refuses helper config on reuse=%s", async (reuse) => {
    if (reuse) await prepareCheckout(input());
    git(clone, "config", "diff.x.textconv", "sentinel-helper");
    await expect(prepareCheckout(input())).rejects.toThrow(
      "the clone's git config defines helpers: diff.x.textconv",
    );
  });
  it("checks worktree-specific helper config on reuse", async () => {
    const checkout = await prepareCheckout(input());
    git(clone, "config", "extensions.worktreeConfig", "true");
    git(checkout.path, "config", "--worktree", "diff.x.textconv", "sentinel-helper");
    await expect(prepareCheckout(input())).rejects.toThrow(
      "the clone's git config defines helpers: diff.x.textconv",
    );
  });
  it("accepts disabled fsmonitor config", async () => {
    git(clone, "config", "core.fsmonitor", "false");
    expect((await prepareCheckout(input())).created).toBe(true);
    expect((await prepareCheckout(input())).created).toBe(false);
  });

  describe("uv installs", () => {
    const run = useFakeUv();
    const prepare = () => prepareCheckout(input(), run);
    const push = (files: Record<string, string> = {}) => {
      commit(seed, { "pyproject.toml": PYPROJECT, "uv.lock": UV_LOCK, ...files });
      git(seed, "push", "-q", "origin", "main");
    };
    const refused = async (what: string) => {
      const e = await fail(prepare());
      expect(e.code).toBe("protected");
      expect(e.message).toBe(`branch ${BRANCH} ${what}; Mission Control won't install from it`);
      expect(existsSync(wtPath())).toBe(false);
      expect(uvArgv()).toBeNull();
    };

    it("installs with configuration and downloads disabled and the worktree's own environment", async () => {
      push();
      await prepare();
      expect(uvArgv()).toEqual([...UV_SYNC_ARGS]);
      expect(readFileSync(join(dir, "uv-cwd"), "utf8").trim()).toBe(wtPath());
      expect(uvEnvKeys().filter((k) => k.startsWith("UV_") || k.startsWith("PIP_"))).toEqual([
        "UV_PROJECT_ENVIRONMENT",
      ]);
      expect(readFileSync(join(dir, "uv-env"), "utf8")).toContain(
        `UV_PROJECT_ENVIRONMENT=${join(wtPath(), ".venv")}\n`,
      );
      expect(UV_SYNC_ARGS).toEqual([
        "sync",
        "--no-config",
        "--no-python-downloads",
        "--frozen",
        "--no-build",
        "--no-install-workspace",
        "--no-install-local",
        "--link-mode=copy",
      ]);
    });

    it("strips inherited interpreter settings and overrides UV_PROJECT_ENVIRONMENT", () => {
      const keys = ["VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP"];
      try {
        for (const key of [...keys, "UV_PROJECT_ENVIRONMENT", "UV_INDEX_PRIVATE_PASSWORD"]) {
          vi.stubEnv(key, "/untrusted");
        }
        const env = uvInstallEnv(wtPath());
        for (const key of [...keys, "UV_INDEX_PRIVATE_PASSWORD"]) expect(env[key]).toBeUndefined();
        expect(env.UV_PROJECT_ENVIRONMENT).toBe(join(wtPath(), ".venv"));
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.each(["./fakepy", "/tmp/claude-501/py", "python3", "3.12\n./fakepy", "3.12 # comment"])(
      "refuses non-version interpreter requests: %s",
      async (version) => {
        push({ ".python-version": `${version}\n` });
        await refused("has a non-version interpreter in .python-version");
      },
    );

    it("accepts plain versions, blank lines and comment lines", async () => {
      push({
        ".python-version":
          "\n# Python versions\n3\n3.12\n3.13.0rc1\ncpython-3.12.1\npypy-3.10\ngraalpy-3.11\n",
      });
      await prepare();
      expect(uvArgv()).toEqual([...UV_SYNC_ARGS]);
    });

    it.each(["pyproject.toml", "uv.toml"])(
      "refuses a parent %s at each ancestor level",
      async (file) => {
        push();
        for (const parent of [join(root, "a"), root, dir]) {
          mkdirSync(parent, { recursive: true });
          writeFileSync(join(parent, file), "# parent workspace\n");
          await refused(`has an ancestor ${file}`);
          rmSync(join(parent, file));
        }
      },
    );

    it.each([
      "http://index.invalid/simple",
      "file:///tmp/wheels",
      "./wheels",
      "/tmp/wheels",
      "https://",
    ])("refuses a non-HTTPS registry: %s", async (registry) => {
      push({
        "uv.lock": `${UV_LOCK}[[package]]\nname = "x"\nsource = { registry = "${registry}" }\n`,
      });
      await refused("has a non-HTTPS registry in uv.lock");
    });

    it.each([
      '[package.source]\n"registry" = "http://index.invalid/simple"',
      '[[package]]\nsource = { "reg\\u0069stry" = "file:///tmp/wheels" }',
      "[[package]]\nsource.'registry' = 'file:///tmp/wheels'",
      "[[package]]\nsource = { registry = 123 }",
    ])("checks registry keys using TOML semantics: %s", async (source) => {
      push({ "uv.lock": `${UV_LOCK}${source}\n` });
      await refused("has a non-HTTPS registry in uv.lock");
    });

    it.each([
      '[[package]]\nsource = { registry = """file:///tmp/wheels""" }',
      '[[package]]\nsource = { "reg\\U00000069stry" = "file:///tmp/wheels" }',
    ])("refuses unsupported lockfile string syntax: %s", async (source) => {
      push({ "uv.lock": `${UV_LOCK}${source}\n` });
      await refused("has unsupported string syntax in uv.lock");
    });

    it("accepts HTTPS registry sources", async () => {
      push({
        "uv.lock": `${UV_LOCK}[[package]]\nsource = { registry = "https://pypi.org/simple" }\n`,
      });
      await prepare();
      expect(uvArgv()).toEqual([...UV_SYNC_ARGS]);
    });

    it.each(["pyproject.toml", "uv.lock", "uv.toml", ".python-version"])(
      "refuses to install when a reused branch changes %s",
      async (file) => {
        push();
        git(clone, "pull", "-q", "--ff-only");
        git(clone, "checkout", "-q", "-b", BRANCH);
        const body = file === "pyproject.toml" ? PYPROJECT : UV_LOCK;
        const tip = commit(clone, { [file]: `${body}\n` });
        git(clone, "checkout", "-q", "main");
        await refused(`changes ${file}`);
        expect(git(clone, "rev-parse", BRANCH)).toBe(tip);
      },
    );

    it.each([".venv/pyvenv.cfg", "pkg/.venv/pyvenv.cfg"])(
      "refuses a committed .venv at %s",
      async (file) => {
        push({ [file]: "x\n" });
        await refused(`has ${file}`);
        expect(hasBranch(BRANCH)).toBe(false);
      },
    );

    it("refuses a symlink in a uv repo", async () => {
      push();
      mkdirSync(join(seed, "docs"));
      symlinkSync("../README.md", join(seed, "docs", "link"));
      git(seed, "add", "-A");
      git(seed, "commit", "-qm", "link");
      git(seed, "push", "-q", "origin", "main");
      await refused("has a symlink at docs/link");
      expect(hasBranch(BRANCH)).toBe(false);
    });

    const onCheckout = (script: string) => {
      push({ ".gitattributes": "x.txt filter=plant\n", "x.txt": "x\n" });
      afterWorktreeAdd(script);
    };

    it("refuses a .venv on disk that the tree does not have", async () => {
      onCheckout("mkdir -p .venv");
      await refused("has .venv");
    });

    it("refuses changed inputs on disk even when the branch's ref is clean", async () => {
      onCheckout("echo changed >> pyproject.toml");
      await refused("changes pyproject.toml");
    });

    it.each(["pyproject.toml", "uv.toml", ".python-version"])(
      "refuses a missing root %s that origin has",
      async (file) => {
        push({ [file]: file === ".python-version" ? "3.12\n" : PYPROJECT });
        onCheckout(`rm -f ${file}`);
        await refused(`changes ${file}`);
      },
    );

    it("removes the worktree and the fresh branch when uv sync fails", async () => {
      push();
      writeFileSync(join(dir, "uv-exit"), "3");
      const e = await fail(prepare());
      expect(e.code).toBe("install");
      expect(e.message).toBe(`uv sync failed for ${BRANCH} (exit 3)`);
      expect(existsSync(wtPath())).toBe(false);
      expect(worktrees()).toHaveLength(1);
      expect(hasBranch(BRANCH)).toBe(false);
    });

    it("reports a timed out uv sync and cleans up", async () => {
      push();
      const e = await fail(
        prepareCheckout(input(), async () => {
          throw { killed: true };
        }),
      );
      expect(e.code).toBe("install");
      expect(e.message).toBe(`uv sync failed for ${BRANCH} (timed out)`);
      expect(existsSync(wtPath())).toBe(false);
      expect(hasBranch(BRANCH)).toBe(false);
    });

    it("fails and cleans up when uv is not on PATH", async () => {
      push();
      const e = await fail(
        prepareCheckout(input(), async () => {
          throw { code: "ENOENT" };
        }),
      );
      expect(e.code).toBe("install");
      expect(e.message).toBe(`uv sync failed for ${BRANCH} (uv not found)`);
      expect(existsSync(wtPath())).toBe(false);
      expect(hasBranch(BRANCH)).toBe(false);
      expect(uvArgv()).toBeNull();
    });

    it.each(["pyproject.toml", "uv.lock", "uv.toml", ".python-version", "pkg/pyproject.toml"])(
      "reports unsupported reinstall after syncing a changed %s",
      async (file) => {
        push();
        const first = await prepare();
        const before = git(first.path, "rev-parse", "HEAD");
        commit(seed, { [file]: file === ".python-version" ? "3.12\n" : `${PYPROJECT}\n` });
        git(seed, "push", "-q", "origin", "main");
        const next = await prepare();
        expect((await syncReusedWorktree(clone, next, { syncMain: true }))?.kind).toBe("merged");
        rmSync(join(dir, "uv-argv"));
        expect(await installAfterSync(clone, next, before)).toBe(
          "dependencies changed; uv reinstall is not supported in a reused worktree",
        );
        expect(uvArgv()).toBeNull();
      },
    );

    it("never runs uv without a uv.lock", async () => {
      commit(seed, { "pyproject.toml": PYPROJECT });
      git(seed, "push", "-q", "origin", "main");
      await prepare();
      expect(uvArgv()).toBeNull();
    });

    it("refuses a uv.lock with no pyproject.toml", async () => {
      commit(seed, { "uv.lock": UV_LOCK });
      git(seed, "push", "-q", "origin", "main");
      await refused("has no pyproject.toml");
    });

    it("runs pnpm then uv when both lockfiles are there", async () => {
      push({ "package.json": PKG, "pnpm-lock.yaml": EMPTY_LOCK });
      const commands: string[] = [];
      await prepareCheckout(input(), (command, args, options) => {
        commands.push(command);
        if (command === "uv") expect(existsSync(join(wtPath(), "node_modules"))).toBe(true);
        return run(command, args, options);
      });
      expect(commands).toEqual(["pnpm", "uv"]);
      expect(uvArgv()).toEqual([...UV_SYNC_ARGS]);
    });

    it("checks both tools before either install starts", async () => {
      push({ "package.json": PKG, "pnpm-lock.yaml": EMPTY_LOCK, ".venv/x": "x" });
      const runner = vi.fn(run);
      await fail(prepareCheckout(input(), runner));
      expect(runner).not.toHaveBeenCalled();
    });

    it("allows node_modules in a uv-only repo", async () => {
      onCheckout("mkdir -p node_modules");
      await prepare();
      expect(uvArgv()).toEqual([...UV_SYNC_ARGS]);
    });
  });

  it("brings origin's tip into a reused worktree when asked", async () => {
    const first = await prepareCheckout(input());
    const tip = commit(first.path, { "b.txt": "branch\n" });
    const main = commit(seed, { "m.txt": "main\n" });
    git(seed, "push", "-q", "origin", "main");
    const r = await syncCheckout();
    expect(r.synced).toEqual({
      kind: "merged",
      sha: git(r.path, "rev-parse", "HEAD"),
      before: tip,
    });
    expect(git(r.path, "log", "-1", "--format=%P")).toBe(`${tip} ${main}`);
    expect(git(r.path, "log", "-1", "--format=%an|%cn")).toBe(
      `${MC_MERGE_AUTHOR}|${MC_MERGE_AUTHOR}`,
    );
    expect(readFileSync(join(r.path, "m.txt"), "utf8")).toBe("main\n");
  });

  it("leaves a reused worktree's conflicts for the seat", async () => {
    const first = await prepareCheckout(input());
    commit(first.path, { "README.md": "branch\n" });
    const mainSha = commit(seed, { "README.md": "main\n" });
    git(seed, "push", "-q", "origin", "main");
    const r = await syncCheckout();
    expect(r.synced).toEqual({ kind: "conflict", mainSha, files: ["README.md"] });
    expect(git(r.path, "rev-parse", "MERGE_HEAD")).toBe(mainSha);
    expect(readFileSync(join(r.path, "README.md"), "utf8")).toContain("<<<<<<<");
    commit(seed, { "later.txt": "new main tip\n" });
    git(seed, "push", "-q", "origin", "main");
    expect((await syncCheckout()).synced).toEqual({
      kind: "conflict",
      mainSha,
      files: ["README.md"],
    });
  });

  it("skips a dirty reused worktree", async () => {
    const first = await prepareCheckout(input());
    writeFileSync(join(first.path, "new.txt"), "uncommitted\n");
    commit(seed, { "m.txt": "main\n" });
    git(seed, "push", "-q", "origin", "main");
    expect((await syncCheckout()).synced).toEqual({
      kind: "skipped",
      why: "dirty",
    });
    expect(readFileSync(join(first.path, "new.txt"), "utf8")).toBe("uncommitted\n");
  });

  it("leaves a reused worktree unchanged without the sync flag", async () => {
    const first = await prepareCheckout(input());
    commit(seed, { "m.txt": "main\n" });
    git(seed, "push", "-q", "origin", "main");
    const r = await prepareCheckout(input());
    expect(await syncReusedWorktree(clone, r, { syncMain: false })).toBeUndefined();
    expect(git(r.path, "rev-parse", "HEAD")).toBe(first.baseSha);
  });

  it("ignores local pnpm stores when syncing a reused worktree", async () => {
    const first = await prepareCheckout(input());
    for (const folder of [PNPM_STORE_DIR_NAME, `nested/${PNPM_STORE_DIR_NAME}`]) {
      mkdirSync(join(first.path, folder), { recursive: true });
      writeFileSync(join(first.path, folder, "cache"), "local cache\n");
    }
    commit(seed, { "m.txt": "main\n" });
    git(seed, "push", "-q", "origin", "main");
    const r = await syncCheckout();
    expect(r.synced?.kind).toBe("merged");
    expect(git(r.path, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(PNPM_STORE_DIR_NAME);
  });

  it("keeps Codex worktree temp directories out of commits", () => {
    expect(COMMIT_ADD_PATHSPEC).toContain(`:(top,exclude,glob)**/${MC_TMP_DIR_NAME}/**`);
    expect(COMMIT_ADD_PATHSPEC).toContain(`:(top,exclude,glob)**/${PNPM_STORE_DIR_NAME}/**`);
    expect(COMMIT_ADD_PATHSPEC).not.toContain(":(top,exclude,glob)**/pnpm-store/**");
  });

  it("answers up-to-date when the reused branch contains main", async () => {
    const first = await prepareCheckout(input());
    const tip = commit(first.path, { "b.txt": "branch\n" });
    expect((await syncCheckout()).synced).toEqual({
      kind: "up-to-date",
    });
    expect(git(first.path, "rev-parse", "HEAD")).toBe(tip);
  });

  it.each(["installed", "unsafe", "failed"])(
    "checks changed install inputs after a sync: %s",
    async (outcome) => {
      const first = await prepareCheckout(input());
      if (outcome === "unsafe") commit(first.path, { "nested/.npmrc": "unsafe=true\n" });
      commit(seed, {
        "package.json": PKG,
        "pnpm-lock.yaml": outcome === "failed" ? "garbage: [\n" : EMPTY_LOCK,
      });
      git(seed, "push", "-q", "origin", "main");
      const checkout = await syncCheckout();
      expect(checkout.synced?.kind).toBe("merged");
      if (checkout.synced?.kind !== "merged") throw new Error("expected merge");
      const note = await installAfterSync(clone, checkout, checkout.synced.before);
      if (outcome === "installed") {
        expect(note).toBeUndefined();
        expect(existsSync(join(checkout.path, "node_modules"))).toBe(true);
      } else {
        expect(note).toContain("dependencies changed; install refused:");
        expect(note).toContain(outcome === "unsafe" ? "nested/.npmrc" : "pnpm install failed");
      }
      expect(git(checkout.path, "rev-parse", "HEAD")).toBe(checkout.synced.sha);
    },
  );

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
    expect(again).toEqual({ ...first, created: false, leftoverChanges: ["?? wip.txt"] });
    expect(existsSync(join(wtPath(), "wip.txt"))).toBe(true);
  });

  it("captures clean status and quotes spaces and control characters in reused worktrees", async () => {
    const first = await prepareCheckout(input());
    expect(first.leftoverChanges).toBeUndefined();
    expect((await prepareCheckout(input())).leftoverChanges).toEqual([]);
    writeFileSync(join(first.path, "space name.txt"), "keep");
    writeFileSync(join(first.path, "tab\tline\n.txt"), "keep");
    mkdirSync(join(first.path, "nested"));
    writeFileSync(join(first.path, "nested/one.txt"), "one");
    writeFileSync(join(first.path, "nested/two.txt"), "two");
    const reused = await prepareCheckout(input());
    expect(reused.leftoverChanges).toEqual([
      "?? nested/one.txt",
      "?? nested/two.txt",
      '?? "space name.txt"',
      '?? "tab\\tline\\n.txt"',
    ]);
    expect(readFileSync(join(first.path, "tab\tline\n.txt"), "utf8")).toBe("keep");
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

  it("prepares private Codex pnpm directories before fresh and synced installs", async () => {
    await prepareCheckout(input());
    commit(seed, { "package.json": PKG, "pnpm-lock.yaml": EMPTY_LOCK });
    git(seed, "push", "-q", "origin", "main");
    const next = await syncCheckout();
    if (next.synced?.kind !== "merged") throw new Error("expected merged checkout");
    expect(await installAfterSync(clone, next, next.synced.before)).toBeUndefined();
    expectPrivateCodexPnpmStore(next.path);

    const fresh = await prepareCheckout({ ...input(), issue: 43 });
    expectPrivateCodexPnpmStore(fresh.path);
  });

  it("installs when a base lockfile is over the 4 MiB default read", async () => {
    commit(seed, {
      "package.json": PKG,
      "pnpm-lock.yaml": `${EMPTY_LOCK}${"# padding padding padding padding\n".repeat(160_000)}`,
    });
    git(seed, "push", "-q", "origin", "main");
    await prepareCheckout(input());
    expect(existsSync(join(wtPath(), "node_modules"))).toBe(true);
  });

  it("says a git that times out reading a base file timed out", async () => {
    commit(seed, { "package.json": PKG, "pnpm-lock.yaml": EMPTY_LOCK });
    git(seed, "push", "-q", "origin", "main");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shim = join(dir, "shim");
    mkdirSync(shim);
    writeFileSync(
      join(shim, "git"),
      `#!/bin/sh\ncase " $* " in *" cat-file -e "*) ;; *" cat-file "*) exec sleep 30;; esac\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${shim}:${savedPath}`;
    try {
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("protected");
      expect(e.message).toMatch(/^could not read \S+ from the crew clone \(timed out\)$/);
    } finally {
      process.env.PATH = savedPath;
    }
  }, 30_000);

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

  it("removes the worktree and the local branch made from origin's when the install fails", async () => {
    commit(seed, { "package.json": PKG, "pnpm-lock.yaml": "garbage: [\n" });
    git(seed, "push", "-q", "origin", "main");
    git(seed, "checkout", "-q", "-b", BRANCH);
    commit(seed, { "work.txt": "w\n" });
    git(seed, "push", "-q", "origin", BRANCH);
    const e = await fail(prepareCheckout(input()));
    expect(e.code).toBe("install");
    expect(existsSync(wtPath())).toBe(false);
    expect(worktrees()).toHaveLength(1);
    expect(hasBranch(BRANCH)).toBe(false);
  });

  it("refuses a branch only origin has that changes pnpm-lock.yaml, and leaves no branch", async () => {
    commit(seed, { "package.json": PKG });
    git(seed, "push", "-q", "origin", "main");
    git(seed, "checkout", "-q", "-b", BRANCH);
    commit(seed, { "pnpm-lock.yaml": EMPTY_LOCK });
    git(seed, "push", "-q", "origin", BRANCH);
    const e = await fail(prepareCheckout(input()));
    expect(e.code).toBe("protected");
    expect(e.message).toBe(
      `branch ${BRANCH} changes pnpm-lock.yaml; Mission Control won't install from it`,
    );
    expect(existsSync(wtPath())).toBe(false);
    expect(worktrees()).toHaveLength(1);
    expect(hasBranch(BRANCH)).toBe(false);
  });

  it("keeps a branch that moved after the start made it, when the install fails", async () => {
    commit(seed, { "package.json": PKG, "pnpm-lock.yaml": EMPTY_LOCK });
    git(seed, "push", "-q", "origin", "main");
    git(clone, "pull", "-q", "--ff-only");
    const moved = commit(clone, { "moved.txt": "m\n" });
    git(clone, "reset", "-q", "--hard", "HEAD~1");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "pnpm"),
      `#!/bin/sh\ngit -C '${clone}' update-ref refs/heads/${BRANCH} ${moved}\nexit 1\n`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("install");
    } finally {
      process.env.PATH = savedPath;
    }
    expect(existsSync(wtPath())).toBe(false);
    expect(git(clone, "rev-parse", `refs/heads/${BRANCH}`)).toBe(moved);
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

  it("installs without inherited CI, npm or git settings, using Codex's stable worktree store", () => {
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
      expect(env.pnpm_config_store_dir).toBe("/w/guido-42/.mc-tmp/pnpm-store");
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
      afterWorktreeAdd("echo modulesDir: /tmp/elsewhere >> pnpm-workspace.yaml");
      const e = await fail(prepareCheckout(input()));
      expect(e.code).toBe("protected");
      expect(e.message).toBe(
        `branch ${BRANCH} changes pnpm-workspace.yaml; Mission Control won't install from it`,
      );
      expect(existsSync(wtPath())).toBe(false);
      expect(hasBranch(BRANCH)).toBe(true);
    });

    /** Checkout runs `script` in the worktree root after git has written the tree. */
    const onCheckout = (script: string) => {
      commit(seed, { ".gitattributes": "x.txt filter=plant\n", "x.txt": "x\n" });
      git(seed, "push", "-q", "origin", "main");
      afterWorktreeAdd(script);
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
      // Plant a link during checkout: what is on disk
      // differs from what ls-tree read, as when another seat moves the ref mid-start.
      commit(seed, { ".gitattributes": "x.txt filter=plant\n", "x.txt": "x\n" });
      git(seed, "push", "-q", "origin", "main");
      afterWorktreeAdd(`ln -sf "${outside}" planted`);
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

describe("ticket checkout recovery", () => {
  it("keeps the ticket's branch after a title change, its worktree there or not", async () => {
    await prepareCheckout(input());
    const renamed = { ...input(), title: "A new name" };
    expect(await prepareCheckout(renamed)).toMatchObject({ branch: BRANCH, created: false });
    git(clone, "worktree", "remove", wtPath());
    expect(await prepareCheckout(renamed)).toMatchObject({ branch: BRANCH, created: true });
    expect(hasBranch("feature/42-a-new-name")).toBe(false);
  });

  it("refuses a ticket with more than one branch", async () => {
    git(clone, "branch", BRANCH);
    git(seed, "push", "-q", "origin", "main:refs/heads/feature/42-other");
    const e = await fail(prepareCheckout(input()));
    expect(e.code).toBe("branch");
    expect(e.message).toBe("#42 has more than one branch (2); delete the extra ones");
    expect(existsSync(wtPath())).toBe(false);
  });

  it("counts a branch both local and on origin once, and ignores feature/420", async () => {
    git(clone, "branch", BRANCH);
    git(seed, "push", "-q", "origin", `main:refs/heads/${BRANCH}`);
    git(clone, "branch", "feature/420-x");
    expect(await prepareCheckout(input())).toMatchObject({ branch: BRANCH });
  });

  it("removes a worktree recorded as half-made and makes it again", async () => {
    await prepareCheckout(input());
    writeFileSync(join(wtPath(), "wip.txt"), "wip");
    const { s, pending } = pendingSet();
    s.add(wtPath());
    expect(await prepareCheckout({ ...input(), pending })).toMatchObject({ created: true });
    expect(existsSync(join(wtPath(), "wip.txt"))).toBe(false);
    expect(s.size).toBe(0);
  });

  it.each([
    "gitdir only",
    "pointer only",
    "no HEAD",
    "no commondir",
    "locked",
    "orphan",
    "missing path",
  ])("recovers an interrupted add with %s", async (stage) => {
    const { s, pending } = pendingSet();
    const path = wtPath();
    const admin = join(clone, ".git", "worktrees", "interrupted");
    git(clone, "branch", BRANCH);
    mkdirSync(dirname(path), { recursive: true });
    if (stage !== "missing path") {
      mkdirSync(path);
      writeFileSync(join(path, "partial.txt"), "partial");
    }
    if (stage !== "orphan") {
      mkdirSync(admin, { recursive: true });
      writeFileSync(join(admin, "locked"), "initializing");
      if (stage !== "pointer only") writeFileSync(join(admin, "gitdir"), join(path, ".git"));
      if (stage !== "missing path" && stage !== "gitdir only") {
        writeFileSync(join(path, ".git"), `gitdir: ${admin}\n`);
      }
      if (stage !== "no commondir" && stage !== "gitdir only") {
        writeFileSync(join(admin, "commondir"), "../..");
      }
      if (stage !== "no HEAD" && stage !== "gitdir only") {
        writeFileSync(join(admin, "HEAD"), `ref: refs/heads/${BRANCH}\n`);
      }
    }
    s.add(path);
    expect(await prepareCheckout({ ...input(), pending })).toMatchObject({ created: true });
    expect(existsSync(join(path, "partial.txt"))).toBe(false);
    expect(existsSync(admin)).toBe(false);
    expect(git(path, "symbolic-ref", "HEAD")).toBe(`refs/heads/${BRANCH}`);
    expect(s.size).toBe(0);
    expect(worktrees()).toHaveLength(2);
  });

  it("keeps pending paths that redirect to another checkout", async () => {
    const other = join(dir, "other");
    git(clone, "worktree", "add", "--detach", other);
    const otherAdmin = git(other, "rev-parse", "--absolute-git-dir");
    mkdirSync(wtPath(), { recursive: true });
    writeFileSync(join(wtPath(), ".git"), `gitdir: ${otherAdmin}\n`);
    const { s, pending } = pendingSet();
    s.add(wtPath());
    expect((await fail(prepareCheckout({ ...input(), pending }))).code).toBe("path");
    expect(s.has(wtPath())).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(otherAdmin)).toBe(true);
  });

  it.each(["worktree", "session", "sibling"])(
    "does not follow a pending %s symlink",
    async (target) => {
      const outside = target === "sibling" ? join(root, "other-session") : join(dir, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "keep.txt"), "keep");
      mkdirSync(root, { recursive: true });
      if (target === "worktree") {
        mkdirSync(dirname(wtPath()), { recursive: true });
        symlinkSync(outside, wtPath());
      } else {
        symlinkSync(outside, dirname(wtPath()));
        mkdirSync(join(outside, "guido-42"));
      }
      const { s, pending } = pendingSet();
      s.add(wtPath());
      expect((await fail(prepareCheckout({ ...input(), pending }))).code).toBe("path");
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
      expect(s.has(wtPath())).toBe(true);
    },
  );

  it("reuses an unrecorded existing worktree as today", async () => {
    await prepareCheckout(input());
    writeFileSync(join(wtPath(), "wip.txt"), "wip");
    const { pending } = pendingSet();
    expect(await prepareCheckout({ ...input(), pending })).toMatchObject({ created: false });
    expect(readFileSync(join(wtPath(), "wip.txt"), "utf8")).toBe("wip");
  });

  it("keeps the record when the start fails, and the next start clears it", async () => {
    commit(seed, { "package.json": PKG, "pnpm-lock.yaml": "garbage\n" });
    git(seed, "push", "-q", "origin", "main");
    const { s, pending } = pendingSet();
    expect((await fail(prepareCheckout({ ...input(), pending }))).code).toBe("install");
    expect(s.has(wtPath())).toBe(true);
    commit(seed, { "pnpm-lock.yaml": EMPTY_LOCK });
    git(seed, "push", "-q", "origin", "main");
    await prepareCheckout({ ...input(), pending });
    expect(s.size).toBe(0);
  });
});

describe("prepareReadOnlyCheckout", () => {
  it("detaches at the branch tip while a writer's worktree has the branch checked out", async () => {
    await prepareCheckout(input());
    const tip = commit(wtPath(), { "w.txt": "w\n" });
    const r = await ro();
    expect(r).toMatchObject({ branch: BRANCH, created: true });
    expect(git(r.path, "rev-parse", "HEAD")).toBe(tip);
    expect(() => git(r.path, "symbolic-ref", "--quiet", "HEAD")).toThrow();
  });

  it("detaches at origin's tip when the ticket has no branch, and creates none", async () => {
    const r = await ro();
    expect(r.branch).toBe("");
    expect(git(r.path, "rev-parse", "HEAD")).toBe(r.baseSha);
    expect(git(clone, "for-each-ref", "refs/heads/feature")).toBe("");
  });

  it("replaces its own detached leftover, and refuses a worktree on a branch at its path", async () => {
    const r = await ro();
    writeFileSync(join(r.path, "stale.txt"), "stale");
    expect(await ro()).toMatchObject({ created: true });
    expect(existsSync(join(r.path, "stale.txt"))).toBe(false);
    git(r.path, "checkout", "-q", "-b", "unrelated");
    expect((await fail(ro())).code).toBe("path");
  });

  it.each([false, true])("upgrades a completed legacy checkout (flat: %s)", async (flat) => {
    const made = await prepareCheckout({ ...input(), seatId: "retro" });
    const path = flat ? join(root, "retro-42") : made.path;
    if (flat) git(clone, "worktree", "move", made.path, path);
    const tip = commit(path, { "legacy.txt": "legacy\n" });
    writeFileSync(join(path, "stale.txt"), "stale");
    const r = await ro();
    expect(r.path).toBe(path);
    expect(r.branch).toBe(BRANCH);
    expect(git(path, "rev-parse", "HEAD")).toBe(tip);
    expect(git(clone, "rev-parse", BRANCH)).toBe(tip);
    expect(() => git(path, "symbolic-ref", "--quiet", "HEAD")).toThrow();
    expect(existsSync(join(path, "stale.txt"))).toBe(false);
  });

  it("detaches a verified legacy run without changing its branch, index or files", async () => {
    const r = await prepareCheckout({ ...input(), seatId: "retro" });
    const tip = git(r.path, "rev-parse", "HEAD");
    writeFileSync(join(r.path, "staged.txt"), "staged");
    git(r.path, "add", "staged.txt");
    writeFileSync(join(r.path, "dirty.txt"), "dirty");
    const before = git(r.path, "status", "--porcelain");
    await existingReadOnlyCheckout(clone, r.path, BRANCH);
    expect(git(r.path, "status", "--porcelain")).toBe(before);
    expect(git(clone, "rev-parse", BRANCH)).toBe(tip);
    expect(await existingDetached(clone, r.path)).toEqual({ path: r.path, gitDir: r.gitDir });
    expect(await existingReadOnlyCheckout(clone, r.path, BRANCH)).toEqual({
      path: r.path,
      gitDir: r.gitDir,
    });
  });

  it("refuses to migrate a legacy run with a redirected git pointer", async () => {
    const r = await prepareCheckout({ ...input(), seatId: "retro" });
    const other = join(dir, "other");
    git(clone, "worktree", "add", "--detach", other);
    writeFileSync(join(r.path, ".git"), readFileSync(join(other, ".git")));
    expect((await fail(existingReadOnlyCheckout(clone, r.path, BRANCH))).code).toBe("path");
    expect(readFileSync(join(r.gitDir, "HEAD"), "utf8")).toContain(`refs/heads/${BRANCH}`);
  });

  it("existingDetached accepts a detached worktree and refuses one on a branch", async () => {
    const r = await ro();
    expect(await existingDetached(clone, r.path)).toEqual({ path: r.path, gitDir: r.gitDir });
    git(r.path, "checkout", "-q", "-b", BRANCH);
    expect((await fail(existingDetached(clone, r.path))).code).toBe("path");
  });

  it("uses origin's ticket branch without creating a local branch", async () => {
    git(seed, "checkout", "-q", "-b", BRANCH);
    const tip = commit(seed, { "remote.txt": "remote\n" });
    git(seed, "push", "-q", "origin", BRANCH);
    const r = await ro();
    expect(r.branch).toBe(BRANCH);
    expect(git(r.path, "rev-parse", "HEAD")).toBe(tip);
    expect(hasBranch(BRANCH)).toBe(false);
  });

  it("checks install inputs on the ticket branch", async () => {
    commit(seed, { "package.json": PKG, "pnpm-lock.yaml": EMPTY_LOCK });
    git(seed, "push", "-q", "origin", "main");
    await prepareCheckout(input());
    commit(wtPath(), {
      "package.json": `${PKG}\n`,
    });
    expect((await fail(ro())).code).toBe("protected");
    expect(existsSync(join(root, "a", "retro-42"))).toBe(false);
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
  const runUv = useFakeUv();
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

  it("installs with uv at a PR head off a uv repo", async () => {
    commit(seed, { "pyproject.toml": PYPROJECT, "uv.lock": UV_LOCK });
    git(seed, "push", "-q", "origin", "main");
    const { head } = pr({ "a.txt": "a\n" });
    await prepareScratch(scratchInput(head), runUv);
    expect(uvArgv()).toEqual([...UV_SYNC_ARGS]);
    expect(readFileSync(join(dir, "uv-cwd"), "utf8").trim()).toBe(scratchPath());
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

describe("a crew clone that shares its git repository", () => {
  const refs = () => git(clone, "for-each-ref");
  /** A linked worktree of the clone, standing in for a loop's worktree. */
  const loopWorktree = () => {
    const loop = join(dir, "loop-wt");
    git(clone, "worktree", "add", "-q", "--detach", loop);
    return loop;
  };

  it("is refused before anything is fetched, pruned or added", async () => {
    const loop = loopWorktree();
    // origin dropped a branch the clone still tracks: a prune would remove it
    git(seed, "push", "-q", "origin", "main:refs/heads/gone");
    git(clone, "fetch", "-q", "origin");
    git(origin, "branch", "-q", "-D", "gone");
    const refsBefore = refs();
    const treesBefore = worktrees();

    const peers = [{ label: "loop shop worktree", dir: loop }];
    const e = await fail(prepareCheckout({ ...input(), peers }));
    expect(e.code).toBe("checkout");
    expect(e.message).toBe("the crew clone shares its git repository with loop shop worktree");
    expect(refs()).toBe(refsBefore);
    expect(worktrees()).toEqual(treesBefore);
  });

  it("is refused for plan, review and detached checkouts too", async () => {
    const peers = [{ label: "the hub's checkout", dir: loopWorktree() }];
    const text = "the crew clone shares its git repository with the hub's checkout";
    const base = { checkout: clone, worktreesRoot: root, sessionId: "a" };
    const plan = await fail(preparePlanCheckout({ ...base, seatId: "guido", issue: 42, peers }));
    expect(plan.message).toBe(text);
    const scratch = await fail(
      prepareScratch({
        ...base,
        seatId: "retro",
        reviewId: 1,
        sha: git(clone, "rev-parse", "HEAD"),
        peers,
      }),
    );
    expect(scratch.message).toBe(text);
    const detached = await fail(
      prepareDetachedCheckout({ ...base, name: "flight-1-watch", peers }),
    );
    expect(detached.message).toBe(text);
  });

  it("skips a peer git cannot read and one in another repository", async () => {
    const other = join(dir, "other");
    git(dir, "init", "-q", "-b", "main", other);
    const peers = [
      { label: "loop gone worktree", dir: join(dir, "missing") },
      { label: "loop other worktree", dir: other },
    ];
    expect((await prepareCheckout({ ...input(), peers })).created).toBe(true);
  });
});
