import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIFF_MAX_CHARS } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changedFiles,
  committedLines,
  FILES_MAX,
  FILTERS_NOTE,
  fileDiff,
  type GitExec,
  GitFailed,
  gitEnv,
  NO_ORIGIN_HEAD_NOTE,
  realGitExec,
} from "../src/files.ts";

const WT = "/tmp/never-a-real-worktree";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
/** The read-only arguments every git call starts with. */
const PREFIX = 8;

/** A fake git: answers by subcommand, records every argument list. */
function fakeGit(answers: {
  committed?: string | Error;
  uncommitted?: string | Error;
  untracked?: string | Error;
  /** `ls-files` of the .gitattributes files. */
  attributes?: string | Error;
  /** `rev-parse --git-common-dir`. */
  commonDir?: string | Error;
  /** `config --get attr.tree`. */
  attrTree?: string | Error;
  /** `ls-files --others --ignored` of the .gitattributes files. */
  ignoredAttributes?: string | Error;
  /** Whether this git knows `--no-lazy-fetch` (the probe); default yes. */
  lazyFetch?: boolean;
  /** `rev-parse --verify HEAD`, asked before and after the reads: called with the 1-based ask. */
  head?: string | Error | ((ask: number) => string | Error);
}) {
  const calls: string[][] = [];
  let asks = 0;
  const exec: GitExec = async (args) => {
    calls.push(args);
    if (args.includes("--verify")) {
      const h = typeof answers.head === "function" ? answers.head(++asks) : (answers.head ?? SHA);
      if (h instanceof Error) throw h;
      return `${h}\n`;
    }
    if (args.includes("version")) {
      if (answers.lazyFetch === false) throw new Error("unknown option: --no-lazy-fetch");
      return "git version 2.54.0\n";
    }
    const pick = args.includes("config")
      ? (answers.attrTree ?? "")
      : args.includes("rev-parse")
        ? (answers.commonDir ?? ".git")
        : args.includes(".gitattributes")
          ? args.includes("--ignored")
            ? answers.ignoredAttributes
            : answers.attributes
          : args.includes("ls-files")
            ? answers.untracked
            : args.some((a) => a.startsWith("origin/HEAD..."))
              ? answers.committed
              : answers.uncommitted;
    const a = pick ?? "";
    if (a instanceof Error) throw a;
    return a;
  };
  return { exec, calls };
}

const numstat = (rows: [string, string, string][]) =>
  rows.map(([a, d, p]) => `${a}\t${d}\t${p}\0`).join("");

describe("changedFiles", () => {
  it("runs only read-only git calls, each with --no-optional-locks, fsmonitor off and -C", async () => {
    const { exec, calls: all } = fakeGit({});
    await changedFiles(WT, exec);
    // the probe, once: `git --no-lazy-fetch version`
    expect(all.filter((a) => a.includes("version"))).toEqual([["--no-lazy-fetch", "version"]]);
    const calls = all.filter((a) => !a.includes("version"));
    // the seven reads, and HEAD named before and after them
    expect(calls).toHaveLength(9);
    for (const args of calls) {
      expect(args.slice(0, PREFIX)).toEqual([
        "--no-optional-locks",
        "--no-lazy-fetch",
        "-c",
        "core.fsmonitor=false",
        "-C",
        WT,
        "-c",
        "core.attributesFile=/dev/null",
      ]);
      for (const bad of [
        "add",
        "checkout",
        "stash",
        "reset",
        "commit",
        "fetch",
        "gc",
        "update-index",
        "lfs",
      ]) {
        expect(args, bad).not.toContain(bad);
      }
      if (args.includes("diff")) {
        expect(args).toContain("--no-ext-diff");
        expect(args).toContain("--no-textconv");
        expect(args).toContain("--numstat");
        expect(args).toContain("--ignore-submodules=all");
      }
    }
    const subs = calls.map((a) => a.slice(PREFIX).join(" "));
    expect(subs.some((s) => s.startsWith("diff") && s.endsWith("origin/HEAD...HEAD"))).toBe(true);
    expect(subs.some((s) => s.startsWith("diff") && s.endsWith(" HEAD"))).toBe(true);
    expect(
      subs.some(
        (s) =>
          s.startsWith("ls-files") && s.includes("--others") && s.includes("--exclude-standard"),
      ),
    ).toBe(true);
  });

  it("lists committed, uncommitted and untracked files, one row per path in its latest state", async () => {
    const { exec } = fakeGit({
      committed: numstat([
        ["10", "2", "src/a.ts"],
        ["3", "0", "src/b.ts"],
      ]),
      uncommitted: numstat([["1", "1", "src/b.ts"]]),
      untracked: "notes/new.md\0",
    });
    expect(await changedFiles(WT, exec)).toEqual({
      files: [
        { path: "src/a.ts", add: 10, del: 2, state: "committed", commitSha: null },
        { path: "src/b.ts", add: 1, del: 1, state: "uncommitted", commitSha: null },
        { path: "notes/new.md", add: null, del: null, state: "untracked", commitSha: null },
      ],
      note: null,
      sha: SHA,
    });
  });

  it("reads several committed files with one bounded git log and keeps their newest commits", async () => {
    const paths = ["a.ts", "b.ts", "c.ts"];
    const { exec: baseExec, calls } = fakeGit({
      committed: numstat(paths.map((path) => ["1", "0", path])),
    });
    const exec: GitExec = async (args) => {
      if (args.includes("log")) {
        calls.push(args);
        return `\0${SHA}\0\na.ts\0b.ts\0\0${OTHER_SHA}\0\na.ts\0c.ts\0`;
      }
      return baseExec(args);
    };
    const result = await changedFiles(WT, exec);
    const logs = calls.filter((args) => args.includes("log"));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.slice(PREFIX)).toEqual([
      "log",
      "--no-show-signature",
      "--format=%x00%H",
      "--name-only",
      "-z",
      "origin/HEAD..HEAD",
    ]);
    expect(result.files.map((file) => file.commitSha)).toEqual([SHA, SHA, OTHER_SHA]);
  });

  it("a binary file's `-` counts are null", async () => {
    const { exec } = fakeGit({ committed: numstat([["-", "-", "img/logo.png"]]) });
    expect((await changedFiles(WT, exec)).files).toEqual([
      { path: "img/logo.png", add: null, del: null, state: "committed", commitSha: null },
    ]);
  });

  it("Review Focus 2: no origin/HEAD still returns uncommitted and untracked files, with the note", async () => {
    const { exec } = fakeGit({
      committed: new Error("fatal: ambiguous argument 'origin/HEAD...HEAD': unknown revision"),
      uncommitted: numstat([["4", "1", "x.ts"]]),
      untracked: "y.ts\0",
    });
    expect(await changedFiles(WT, exec)).toEqual({
      files: [
        { path: "x.ts", add: 4, del: 1, state: "uncommitted", commitSha: null },
        { path: "y.ts", add: null, del: null, state: "untracked", commitSha: null },
      ],
      note: NO_ORIGIN_HEAD_NOTE,
      sha: SHA,
    });
    expect(NO_ORIGIN_HEAD_NOTE).toBe("no origin/HEAD: showing uncommitted changes only");
  });

  it("names the commit the list describes", async () => {
    const { exec } = fakeGit({ committed: numstat([["1", "0", "a.ts"]]) });
    expect((await changedFiles(WT, exec)).sha).toBe(SHA);
  });

  it("a commit landing during the reads is read again, never mixed into one list", async () => {
    // the first attempt sees SHA before and OTHER_SHA after; the second sees OTHER_SHA both times
    const { exec, calls } = fakeGit({ head: (ask) => (ask === 1 ? SHA : OTHER_SHA) });
    const r = await changedFiles(WT, exec);
    expect(r.sha).toBe(OTHER_SHA);
    expect(calls.filter((a) => a.includes("origin/HEAD...HEAD"))).toHaveLength(2);
  });

  it("a HEAD that keeps moving is GitFailed, not a list", async () => {
    const { exec } = fakeGit({ head: (ask) => (ask % 2 === 1 ? SHA : OTHER_SHA) });
    await expect(changedFiles(WT, exec)).rejects.toBeInstanceOf(GitFailed);
  });

  it("every git call failing still carries the filter note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-attr-"));
    try {
      writeFileSync(join(dir, ".gitattributes"), "*.psd filter=lfs\n");
      const e = new Error("fatal: not a git repository");
      const { exec } = fakeGit({
        attributes: ".gitattributes\0",
        committed: e,
        untracked: e,
        head: e,
      });
      const err = await changedFiles(dir, exec).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(GitFailed);
      expect(err).toMatchObject({ note: FILTERS_NOTE });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every git call failing throws GitFailed", async () => {
    const e = new Error("fatal: not a git repository");
    const { exec } = fakeGit({ committed: e, uncommitted: e, untracked: e });
    await expect(changedFiles(WT, exec)).rejects.toBeInstanceOf(GitFailed);
  });

  it("GitFailed carries the first failing git command and its exit code, never its message", async () => {
    const e = Object.assign(new Error(`fatal: not a git repository: ${WT}`), { code: 128 });
    const { exec } = fakeGit({ committed: e, uncommitted: e, untracked: e });
    const err = await changedFiles(WT, exec).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(GitFailed);
    expect(err).toMatchObject({ command: "diff", exitCode: 128 });
    expect(JSON.stringify({ ...(err as object) })).not.toContain(WT);
  });

  it("GitFailed names the call that failed first, not last", async () => {
    const ok = fakeGit({}).exec;
    const failAfter = (ms: number, exitCode: number) =>
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error("x"), { code: exitCode })), ms),
      );
    const exec: GitExec = (args) => {
      if (args.includes("version")) return ok(args);
      if (args.includes("origin/HEAD...HEAD")) return failAfter(0, 1);
      if (args.includes("diff")) return failAfter(30, 3);
      if (args.includes("ls-files") && !args.includes(".gitattributes")) return failAfter(15, 2);
      return ok(args);
    };
    await expect(changedFiles(WT, exec)).rejects.toMatchObject({ command: "diff", exitCode: 1 });
  });

  it("GitFailed keeps the signal of a call killed on a timeout", async () => {
    const e = Object.assign(new Error("timed out"), { code: null, signal: "SIGTERM" });
    const { exec } = fakeGit({ committed: e, uncommitted: e, untracked: e });
    await expect(changedFiles(WT, exec)).rejects.toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
    });
  });

  it("a part git could not read is named in the note", async () => {
    const { exec } = fakeGit({
      committed: numstat([["1", "0", "a"]]),
      untracked: new Error("maxBuffer exceeded"),
    });
    const r = await changedFiles(WT, exec);
    expect(r.files).toHaveLength(1);
    expect(r.note).toBe("git could not list untracked files");
  });

  it(`keeps at most ${FILES_MAX} files and says so`, async () => {
    const rows = Array.from({ length: 250 }, (_, i): [string, string, string] => [
      "1",
      "0",
      `f${i}`,
    ]);
    const { exec } = fakeGit({ committed: numstat(rows) });
    const r = await changedFiles(WT, exec);
    expect(FILES_MAX).toBe(200);
    expect(r.files).toHaveLength(200);
    expect(r.note).toBe("showing the first 200 of 250 files");
  });

  it("a repo whose attributes name a filter: no uncommitted diff is run, and the note says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-attr-"));
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(
        join(dir, "sub", ".gitattributes"),
        "*.bin binary\n*.psd filter=lfs diff=lfs\n",
      );
      const { exec, calls } = fakeGit({
        committed: numstat([["1", "0", "a"]]),
        attributes: "sub/.gitattributes\0",
        untracked: "u\0",
      });
      const r = await changedFiles(dir, exec);
      expect(calls.some((a) => a.at(-1) === "HEAD" && a.includes("diff"))).toBe(false);
      expect(r.note).toBe(FILTERS_NOTE);
      expect(FILTERS_NOTE).toBe("repo uses git filters: uncommitted changes not read");
      expect(r.files.map((f) => f.state)).toEqual(["committed", "untracked"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters named at the root or in info/attributes (common dir) also skip it", async () => {
    for (const where of ["root", "info"] as const) {
      const dir = mkdtempSync(join(tmpdir(), "mc-attr-"));
      try {
        mkdirSync(join(dir, "gd", "info"), { recursive: true });
        if (where === "root") writeFileSync(join(dir, ".gitattributes"), "* filter=lfs\n");
        else writeFileSync(join(dir, "gd", "info", "attributes"), "[attr]big filter=lfs\n");
        const { exec, calls } = fakeGit({ commonDir: "gd\n" });
        const r = await changedFiles(dir, exec);
        expect(
          calls.some((a) => a.at(-1) === "HEAD" && a.includes("diff")),
          where,
        ).toBe(false);
        expect(r.note, where).toContain(FILTERS_NOTE);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("when the attributes cannot be checked, the uncommitted diff is not run either", async () => {
    const { exec, calls } = fakeGit({ attributes: new Error("boom") });
    const r = await changedFiles(WT, exec);
    expect(calls.some((a) => a.at(-1) === "HEAD" && a.includes("diff"))).toBe(false);
    expect(r.note).toContain("could not check for git filters: uncommitted changes not read");
  });

  it("a git without --no-lazy-fetch gets the same calls without the flag (a failed probe is retried)", async () => {
    const { exec, calls } = fakeGit({ lazyFetch: false, untracked: "u\0" });
    expect((await changedFiles(WT, exec)).files).toHaveLength(1);
    await changedFiles(WT, exec);
    expect(calls.filter((a) => a.includes("version"))).toHaveLength(2);
    const work = calls.filter((a) => !a.includes("version"));
    expect(work).toHaveLength(18);
    for (const args of work) {
      expect(args).not.toContain("--no-lazy-fetch");
      expect(args.slice(0, PREFIX - 1)).toEqual([
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-C",
        WT,
        "-c",
        "core.attributesFile=/dev/null",
      ]);
    }
  });

  it("caches only a successful probe: a transient failure is probed again, a success once", async () => {
    const answers: { lazyFetch?: boolean } = { lazyFetch: false };
    const { exec, calls } = fakeGit(answers);
    const probes = () => calls.filter((a) => a.includes("version")).length;
    const flagged = () => calls.at(-1)?.includes("--no-lazy-fetch");
    await changedFiles(WT, exec);
    expect([probes(), flagged()]).toEqual([1, false]);
    answers.lazyFetch = true;
    await changedFiles(WT, exec);
    expect([probes(), flagged()]).toEqual([2, true]);
    await changedFiles(WT, exec);
    expect([probes(), flagged()]).toEqual([2, true]);
  });

  it("an ignored nested .gitattributes naming a filter skips the diff; ignored directories are not read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-attr-"));
    try {
      mkdirSync(join(dir, "vendor"));
      writeFileSync(join(dir, "vendor", ".gitattributes"), "*.txt filter=mark\n");
      const { exec, calls } = fakeGit({
        ignoredAttributes: "node_modules/\0vendor/.gitattributes\0",
      });
      const r = await changedFiles(dir, exec);
      const listing = calls.find((a) => a.includes("--ignored")) ?? [];
      expect(listing).toEqual(
        expect.arrayContaining(["--others", "--exclude-standard", "--directory"]),
      );
      expect(calls.some((a) => a.at(-1) === "HEAD" && a.includes("diff"))).toBe(false);
      expect(r.note).toContain(FILTERS_NOTE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attr.tree set (attributes read from a tree): the uncommitted diff is skipped", async () => {
    const { exec, calls } = fakeGit({ attrTree: "HEAD\n" });
    const r = await changedFiles(WT, exec);
    expect(calls.some((a) => a.at(-1) === "HEAD" && a.includes("diff"))).toBe(false);
    expect(r.note).toContain(FILTERS_NOTE);
  });

  it("a listed .gitattributes missing on disk (git reads the index copy): skipped", async () => {
    const { exec, calls } = fakeGit({ attributes: "gone/.gitattributes\0" });
    const r = await changedFiles(WT, exec);
    expect(calls.some((a) => a.at(-1) === "HEAD" && a.includes("diff"))).toBe(false);
    expect(r.note).toContain(FILTERS_NOTE);
  });

  it("git's environment drops every GIT_* override and turns system attributes off", () => {
    const env = gitEnv({
      PATH: "/bin",
      HOME: "/h",
      GIT_ATTR_SOURCE: "deadbeef",
      GIT_DIR: "/x",
      GIT_CONFIG_PARAMETERS: "'filter.x.clean'='evil'",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", GIT_ATTR_NOSYSTEM: "1" });
  });

  it("strips control characters from paths", async () => {
    const { exec } = fakeGit({ untracked: "evil\x1b[31mred\x07.txt\0" });
    expect((await changedFiles(WT, exec)).files[0]?.path).toBe("evilred.txt");
  });
});

describe("fileDiff", () => {
  it("diffs a listed file with the same read-only calls, no colour, ext diff or textconv, a literal path", async () => {
    const { exec, calls } = fakeGit({
      committed: numstat([["1", "0", "src/*.ts"]]),
    });
    await fileDiff(WT, "src/*.ts", exec);
    const work = calls.filter((a) => !a.includes("version"));
    const diff = work.at(-1) ?? [];
    for (const args of work) {
      expect(args.slice(0, PREFIX)).toEqual([
        "--no-optional-locks",
        "--no-lazy-fetch",
        "-c",
        "core.fsmonitor=false",
        "-C",
        WT,
        "-c",
        "core.attributesFile=/dev/null",
      ]);
    }
    expect(diff).toEqual(
      expect.arrayContaining([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--ignore-submodules=all",
        "--no-renames",
        `origin/HEAD...${SHA}`,
      ]),
    );
    expect(diff.slice(-2)).toEqual(["--", ":(literal)src/*.ts"]);
  });

  it("diffs against the commit its list named, and names it, when HEAD moves in between", async () => {
    // the list's two HEAD reads see SHA; every read after that sees OTHER_SHA
    const head = (ask: number) => (ask <= 2 ? SHA : OTHER_SHA);
    for (const [state, range] of [
      ["committed", `origin/HEAD...${SHA}`],
      ["uncommitted", SHA],
    ] as const) {
      const { exec, calls } = fakeGit({ [state]: numstat([["1", "0", "a.ts"]]), head });
      const r = await fileDiff(WT, "a.ts", exec);
      expect(r?.sha, state).toBe(SHA);
      const diff = calls.filter((a) => a.includes("--") && a.includes("diff")).at(-1) ?? [];
      expect(diff.at(-3), state).toBe(range);
      expect(diff, state).not.toContain("HEAD");
    }
  });

  it("a path not in the list is null and runs no diff", async () => {
    const { exec, calls } = fakeGit({ committed: numstat([["1", "0", "a.ts"]]) });
    for (const p of ["b.ts", "../etc/passwd", ""])
      expect(await fileDiff(WT, p, exec), p).toBeNull();
    expect(calls.some((a) => a.includes("--") && a.includes("diff"))).toBe(false);
  });

  it("a failed diff is GitFailed with git's message, never the worktree path", async () => {
    const e = Object.assign(new Error(`Command failed: git -C ${WT} diff`), {
      stderr: `fatal: bad object in ${WT}/x\n`,
    });
    const exec: GitExec = async (args) => {
      if (args.includes("--")) throw e;
      if (args.some((a) => a.startsWith("origin/HEAD..."))) return numstat([["1", "0", "a.ts"]]);
      return "";
    };
    const err = await fileDiff(WT, "a.ts", exec).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(GitFailed);
    expect((err as Error).message).toContain("fatal: bad object");
    expect((err as Error).message).not.toContain(WT);
  });

  it("a committed or uncommitted name that cleaning changed is null and runs no diff", async () => {
    for (const state of ["committed", "uncommitted"] as const) {
      const { exec, calls } = fakeGit({ [state]: numstat([["1", "0", "a\x07.ts"]]) });
      expect((await changedFiles(WT, exec)).files.map((f) => f.path)).toEqual(["a.ts"]);
      expect(await fileDiff(WT, "a.ts", exec), state).toBeNull();
      expect(
        calls.some((a) => a.includes("diff") && a.includes("--")),
        state,
      ).toBe(false);
    }
  });

  it("listing failing throws GitFailed", async () => {
    const e = new Error("fatal: not a git repository");
    const { exec } = fakeGit({ committed: e, uncommitted: e, untracked: e });
    await expect(fileDiff(WT, "a.ts", exec)).rejects.toBeInstanceOf(GitFailed);
  });
});

/** The real exec against a throwaway repo in the temp dir (never a loop's worktree). */
describe("realGitExec on a scratch repo", () => {
  let dir: string;
  // Isolated from the user's git config: no hooks, no signing.
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        dir,
        ...args,
      ],
      { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-files-"));
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "one\n");
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    git("add", "a.txt", ".gitignore");
    git("commit", "-q", "-m", "base");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts a merge against its first parent rather than treating it as an empty commit", async () => {
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "feature.txt"), "feature\n");
    git("add", "feature.txt");
    git("commit", "-q", "-m", "feature");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "merge", "feature");
    expect(await committedLines(dir, git("rev-parse", "HEAD").trim())).toEqual({
      additions: 1,
      deletions: 0,
    });
  });

  it("counts root and ordinary commits independently of dirty worktree changes", async () => {
    const root = git("rev-parse", "HEAD").trim();
    expect(await committedLines(dir, root)).toEqual({ additions: 2, deletions: 0 });
    writeFileSync(join(dir, "a.txt"), "two\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "change");
    const sha = git("rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "a.txt"), "dirty\nworktree\nchanges\n");
    expect(await committedLines(dir, sha)).toEqual({ additions: 1, deletions: 1 });
  });

  it("reads uncommitted and untracked files with the note when there is no origin/HEAD", async () => {
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "new file.txt"), "x\n");
    writeFileSync(join(dir, "ignored.txt"), "x\n");
    expect(await changedFiles(dir, realGitExec)).toEqual({
      files: [
        { path: "a.txt", add: 1, del: 0, state: "uncommitted", commitSha: null },
        { path: "new file.txt", add: null, del: null, state: "untracked", commitSha: null },
      ],
      note: NO_ORIGIN_HEAD_NOTE,
      sha: git("rev-parse", "HEAD").trim(),
    });
  });

  it("never runs a clean filter: a filtered repo's uncommitted diff is skipped", async () => {
    const marker = `${dir}-filter-ran`;
    // A clean filter that leaves a marker when git runs it (as git-lfs writes into .git/lfs).
    git("config", "filter.mark.clean", `sh -c 'touch "${marker}"; cat'`);
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=mark\n");
    git("add", ".gitattributes");
    git("commit", "-q", "-m", "attrs");
    rmSync(marker, { force: true });
    writeFileSync(join(dir, "a.txt"), "one\nchanged\n");
    const calls: string[][] = [];
    const r = await changedFiles(dir, (args) => {
      calls.push(args);
      return realGitExec(args);
    });
    expect(existsSync(marker)).toBe(false);
    expect(calls.some((a) => a.at(-1) === "HEAD" && a.includes("diff"))).toBe(false);
    expect(r.note).toContain(FILTERS_NOTE);
    // the probe: a plain `git diff HEAD` in this repo does run the filter
    execFileSync("git", ["-C", dir, "diff", "--numstat", "HEAD"]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });
  });

  /** Configures a clean filter `mark` that leaves `marker` when run; returns the marker path. */
  const markFilter = (repo: string): string => {
    const marker = `${repo}-filter-ran`;
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "filter.mark.clean",
      `sh -c 'touch "${marker}"; cat'`,
    ]);
    return marker;
  };
  const changedVia = async (repo: string) => {
    const calls: string[][] = [];
    const r = await changedFiles(repo, (args) => {
      calls.push(args);
      return realGitExec(args);
    });
    return { r, ranWorktreeDiff: calls.some((a) => a.at(-1) === "HEAD" && a.includes("diff")) };
  };

  it("a tracked .gitattributes deleted from the work tree still skips the diff (git reads the index copy)", async () => {
    const marker = markFilter(dir);
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=mark\n");
    git("add", ".gitattributes");
    git("commit", "-q", "-m", "attrs");
    rmSync(join(dir, ".gitattributes"));
    writeFileSync(join(dir, "a.txt"), "one\nchanged\n");
    rmSync(marker, { force: true });
    const { r, ranWorktreeDiff } = await changedVia(dir);
    expect(existsSync(marker)).toBe(false);
    expect(ranWorktreeDiff).toBe(false);
    expect(r.note).toContain(FILTERS_NOTE);
    // the probe: git does still apply the deleted file's filter
    execFileSync("git", ["-C", dir, "diff", "--numstat", "HEAD"]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });
  });

  it("an ignored nested .gitattributes (git still applies it) skips the diff", async () => {
    const marker = markFilter(dir);
    mkdirSync(join(dir, "vendor"));
    writeFileSync(join(dir, "vendor", "v.txt"), "v\n");
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\nvendor/.gitattributes\n");
    git("add", ".gitignore", "vendor/v.txt");
    git("commit", "-q", "-m", "vendor");
    writeFileSync(join(dir, "vendor", ".gitattributes"), "*.txt filter=mark\n");
    writeFileSync(join(dir, "vendor", "v.txt"), "v\n"); // stat-dirty
    rmSync(marker, { force: true });
    const { r, ranWorktreeDiff } = await changedVia(dir);
    expect(existsSync(marker)).toBe(false);
    expect(ranWorktreeDiff).toBe(false);
    expect(r.note).toContain(FILTERS_NOTE);
    // the probe: plain git applies the ignored file's filter
    execFileSync("git", ["-C", dir, "diff", "--numstat", "HEAD"]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });
  });

  it("a stat-dirty submodule's clean filter never runs", async () => {
    const subSrc = mkdtempSync(join(tmpdir(), "mc-files-sub-"));
    try {
      const sg = (cwd: string, ...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.file.allow=always",
            "-C",
            cwd,
            ...args,
          ],
          { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
        );
      sg(subSrc, "init", "-q", "-b", "main");
      writeFileSync(join(subSrc, ".gitattributes"), "*.txt filter=mark\n");
      writeFileSync(join(subSrc, "s.txt"), "s\n");
      sg(subSrc, "add", ".");
      sg(subSrc, "commit", "-q", "-m", "sub");
      sg(dir, "submodule", "add", "-q", subSrc, "sub");
      sg(dir, "commit", "-q", "-m", "add sub");
      const sub = join(dir, "sub");
      const marker = markFilter(sub);
      // stat-dirty, same content
      writeFileSync(join(sub, "s.txt"), "s\n");
      rmSync(marker, { force: true });
      const { r } = await changedVia(dir);
      expect(existsSync(marker)).toBe(false);
      expect(r.note).toBe(NO_ORIGIN_HEAD_NOTE);
      // the probe: a plain diff in the superproject does reach the submodule's filter
      execFileSync("git", ["-C", dir, "diff", "--numstat", "HEAD"]);
      expect(existsSync(marker)).toBe(true);
      rmSync(marker, { force: true });
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it("keeps file commits distinct from the snapshot and clears dirty provenance", async () => {
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    writeFileSync(join(dir, "first.txt"), "first\n");
    git("add", "first.txt");
    git("commit", "-q", "-m", "first");
    const first = git("rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "second.txt"), "second\n");
    git("add", "second.txt");
    git("commit", "-q", "-m", "second");
    const second = git("rev-parse", "HEAD").trim();
    const list = await changedFiles(dir);
    expect(list.sha).toBe(second);
    expect(list.files.find((f) => f.path === "first.txt")?.commitSha).toBe(first);
    expect(list.files.find((f) => f.path === "second.txt")?.commitSha).toBe(second);
    writeFileSync(join(dir, "first.txt"), "dirty\n");
    writeFileSync(join(dir, "third.txt"), "new\n");
    const dirty = await changedFiles(dir);
    expect(dirty.files.find((f) => f.path === "first.txt")?.commitSha).toBeNull();
    expect(dirty.files.find((f) => f.path === "third.txt")?.commitSha).toBeNull();
  });

  it("GIT_ATTR_SOURCE in the server's environment is not passed to git", async () => {
    const marker = markFilter(dir);
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=mark\n");
    git("add", ".gitattributes");
    git("commit", "-q", "-m", "attrs");
    const withFilter = git("rev-parse", "HEAD").trim();
    git("rm", "-q", ".gitattributes");
    git("commit", "-q", "-m", "no attrs");
    writeFileSync(join(dir, "a.txt"), "one\nchanged\n");
    rmSync(marker, { force: true });
    const before = process.env.GIT_ATTR_SOURCE;
    process.env.GIT_ATTR_SOURCE = withFilter;
    try {
      const { r, ranWorktreeDiff } = await changedVia(dir);
      expect(ranWorktreeDiff).toBe(true);
      expect(r.files).toContainEqual({
        path: "a.txt",
        add: 1,
        del: 0,
        state: "uncommitted",
        commitSha: null,
      });
      expect(existsSync(marker)).toBe(false);
      // the probe: with the variable, git applies that tree's filter
      execFileSync("git", ["-C", dir, "diff", "--numstat", "HEAD"]);
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.GIT_ATTR_SOURCE;
      else process.env.GIT_ATTR_SOURCE = before;
      rmSync(marker, { force: true });
    }
  });

  it("reads the branch's commits since origin/HEAD", async () => {
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git("checkout", "-q", "-b", "feature/1-x");
    writeFileSync(join(dir, "b.txt"), "b\nb\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "b");
    expect(await changedFiles(dir, realGitExec)).toEqual({
      files: [
        {
          path: "b.txt",
          add: 2,
          del: 0,
          state: "committed",
          commitSha: git("rev-parse", "HEAD").trim(),
        },
      ],
      note: null,
      sha: git("rev-parse", "HEAD").trim(),
    });
  });

  /** origin/HEAD at the base commit, then a feature branch. */
  const branchOff = () => {
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git("checkout", "-q", "-b", "feature/1-x");
  };

  it("fileDiff: a committed file's diff from the merge base with origin/HEAD", async () => {
    branchOff();
    writeFileSync(join(dir, "b.txt"), "b1\nb2\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "b");
    const d = await fileDiff(dir, "b.txt", realGitExec);
    expect(d).toMatchObject({ path: "b.txt", truncated: false, binary: false });
    expect(d?.text).toContain("@@ -0,0 +1,2 @@");
    expect(d?.text).toContain("+b1\n+b2");
    expect(d?.text).not.toContain("\x1b");
  });

  it("fileDiff: an uncommitted file's diff against HEAD", async () => {
    writeFileSync(join(dir, "a.txt"), "uno\n");
    const d = await fileDiff(dir, "a.txt", realGitExec);
    expect(d?.text).toContain("-one\n+uno");
    expect(d?.binary).toBe(false);
  });

  it("fileDiff: an untracked file comes back as added lines", async () => {
    writeFileSync(join(dir, "new.txt"), "x\ny\n");
    expect(await fileDiff(dir, "new.txt", realGitExec)).toEqual({
      path: "new.txt",
      text: "+x\n+y",
      truncated: false,
      binary: false,
      sha: git("rev-parse", "HEAD").trim(),
    });
  });

  it("fileDiff: a path not in the list is null; nothing outside the list is read", async () => {
    writeFileSync(join(dir, "new.txt"), "x\n");
    for (const p of ["a.txt", "ignored.txt", "../etc/passwd", "/etc/passwd", "nope.txt"]) {
      expect(await fileDiff(dir, p, realGitExec), p).toBeNull();
    }
  });

  it("fileDiff: an untracked `x\\x07.env` beside an ignored `x.env` is null; `x.env` is never read", async () => {
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\nx.env\n");
    writeFileSync(join(dir, "x.env"), "TOKEN=hunter2\n");
    writeFileSync(join(dir, "x\x07.env"), "harmless\n");
    const listed = (await changedFiles(dir, realGitExec)).files;
    expect(listed).toContainEqual({
      path: "x.env",
      add: null,
      del: null,
      state: "untracked",
      commitSha: null,
    });
    expect(await fileDiff(dir, "x.env", realGitExec)).toBeNull();
  });

  it("fileDiff: an untracked symlink out of the worktree is null", async () => {
    const outside = mkdtempSync(join(tmpdir(), "mc-files-out-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "secret\n");
      symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
      symlinkSync(outside, join(dir, "linkdir"));
      expect((await changedFiles(dir, realGitExec)).files.map((f) => f.path)).toContain("link.txt");
      expect(await fileDiff(dir, "link.txt", realGitExec)).toBeNull();
      expect(await fileDiff(dir, "linkdir", realGitExec)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it(`fileDiff: a 300 KB file is cut at ${DIFF_MAX_CHARS} characters`, async () => {
    const big = `${"0123456789abcdef\n".repeat(18_000)}`; // 306 000 characters
    writeFileSync(join(dir, "big.txt"), big);
    const untracked = await fileDiff(dir, "big.txt", realGitExec);
    expect(untracked?.truncated).toBe(true);
    expect(untracked?.text.length).toBeLessThanOrEqual(DIFF_MAX_CHARS);
    expect(untracked?.text.startsWith("+0123456789abcdef\n")).toBe(true);
    branchOff();
    git("add", "big.txt");
    git("commit", "-q", "-m", "big");
    const committed = await fileDiff(dir, "big.txt", realGitExec);
    expect(committed?.truncated).toBe(true);
    expect(committed?.text.length).toBeLessThanOrEqual(DIFF_MAX_CHARS);
  });

  it("fileDiff: a binary file is binary, with no text", async () => {
    writeFileSync(join(dir, "img.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    expect(await fileDiff(dir, "img.bin", realGitExec)).toEqual({
      path: "img.bin",
      text: "",
      truncated: false,
      binary: true,
      sha: git("rev-parse", "HEAD").trim(),
    });
    branchOff();
    git("add", "img.bin");
    git("commit", "-q", "-m", "bin");
    expect(await fileDiff(dir, "img.bin", realGitExec)).toMatchObject({ binary: true, text: "" });
  });

  it("fileDiff never runs a clean filter, an external diff or a textconv", async () => {
    const marker = markFilter(dir);
    const hook = `sh -c 'touch "${marker}"; cat "$1"' --`;
    git("config", "diff.external", hook);
    git("config", "diff.tc.textconv", hook);
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=mark diff=tc\n");
    git("add", ".gitattributes");
    git("commit", "-q", "-m", "attrs");
    branchOff();
    writeFileSync(join(dir, "c.txt"), "c\n");
    git("add", "c.txt");
    git("commit", "-q", "-m", "c");
    writeFileSync(join(dir, "a.txt"), "one\nchanged\n"); // stat-dirty, filtered: never listed
    rmSync(marker, { force: true });
    const d = await fileDiff(dir, "c.txt", realGitExec);
    expect(d?.text).toContain("+c");
    expect(await fileDiff(dir, "a.txt", realGitExec)).toBeNull();
    expect(existsSync(marker)).toBe(false);
    // the probe: plain git does run them
    execFileSync("git", ["-C", dir, "diff", "origin/HEAD...HEAD", "--", "c.txt"]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });
  });
});

describe("committed line counts", () => {
  it("reads immutable commit trees, preserving binary and missing counts as unknown", async () => {
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push(args);
      if (args.includes("version")) return "git";
      return "3\t2\tfile.ts\0";
    };
    expect(await committedLines(WT, SHA, exec)).toEqual({ additions: 3, deletions: 2 });
    expect(calls.at(-1)).toContain(SHA);
    expect(calls.at(-1)).toContain("--root");
    expect(calls.at(-1)).toContain("--no-ext-diff");
    expect(await committedLines(WT, SHA, async () => "-\t-\timage.bin\0")).toEqual({
      additions: null,
      deletions: null,
    });
    expect(
      await committedLines(WT, SHA, async () => {
        throw new Error("missing");
      }),
    ).toEqual({ additions: null, deletions: null });
    expect(await committedLines(WT, "--bad", exec)).toEqual({ additions: null, deletions: null });
  });
});
