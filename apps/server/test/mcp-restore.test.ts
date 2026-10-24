import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type RestoreBoundary,
  type RestoreSandboxCall,
  restoreProfile,
  restoreWorktreeFile,
  runRestoreSandbox,
} from "../src/mcp/restore.ts";

let dir: string;
let root: string;
let outside: string;
let boundary: RestoreBoundary;
const entry = { mode: "100644", body: Buffer.from("verified bytes") };
const plainHelper = async ({ args, cwd, input }: RestoreSandboxCall) => {
  execFileSync(process.execPath, args, { cwd, input, stdio: ["pipe", "pipe", "pipe"] });
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-restore-")));
  root = join(dir, "worktrees", "scratch");
  outside = join(dir, "outside");
  boundary = {
    worktreesRoot: join(dir, "worktrees"),
    gitCommonDir: join(dir, "common"),
    worktreeGitDir: join(dir, "common", "worktrees", "scratch"),
    dataDir: join(dir, "data"),
  };
  for (const path of [
    root,
    outside,
    boundary.worktreeGitDir,
    boundary.dataDir,
    join(root, ".git"),
  ]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(root, "file"), "experiment");
  writeFileSync(join(outside, "file"), "outside");
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

it("passes only verified bytes, relative path, mode and operation to the typed helper", async () => {
  const runner = vi.fn(plainHelper);
  await restoreWorktreeFile(root, "file", entry, boundary, runner);
  expect(readFileSync(join(root, "file"))).toEqual(entry.body);
  expect(runner.mock.calls[0]?.[0]).toMatchObject({
    cwd: root,
    input: entry.body,
    args: [
      "--experimental-strip-types",
      expect.stringMatching(/restore-helper\.ts$/),
      "file",
      entry.mode,
      "restore",
    ],
    profile: restoreProfile(root, [
      boundary.gitCommonDir,
      boundary.worktreeGitDir,
      boundary.dataDir,
    ]),
  });
  await restoreWorktreeFile(root, "file", null, boundary, runner);
  expect(existsSync(join(root, "file"))).toBe(false);
});

it.each(['"', "\\", "\n", "\r", "\t", "\0", "\x7f", "\x85"])(
  "refuses unsafe profile paths (%j)",
  (bad) => {
    expect(() => restoreProfile(`${root}${bad}`, [])).toThrow("sandbox paths");
    expect(() => restoreProfile(root, [`${outside}${bad}`])).toThrow("sandbox paths");
  },
);

it("refuses an already substituted root without adopting its target", async () => {
  renameSync(root, `${root}-old`);
  symlinkSync(outside, root);
  const runner = vi.fn(plainHelper);
  await expect(restoreWorktreeFile(root, "file", entry, boundary, runner)).rejects.toThrow(
    "replaced or redirected",
  );
  expect(runner).not.toHaveBeenCalled();
  expect(readFileSync(join(outside, "file"), "utf8")).toBe("outside");
});

it("restores bytes and mode through missing parents created by the helper", async () => {
  const runner = vi.fn(plainHelper);
  const executable = { ...entry, mode: "100755" };
  await restoreWorktreeFile(root, "missing/nested/file", executable, boundary, runner);
  expect(runner).toHaveBeenCalledOnce();
  expect(readFileSync(join(root, "missing/nested/file"))).toEqual(entry.body);
  expect(statSync(join(root, "missing/nested/file")).mode & 0o777).toBe(0o755);
});

it("refuses overlapping data storage and profiles whose denies cover the worktree", async () => {
  const runner = vi.fn(plainHelper);
  for (const dataDir of [root, boundary.worktreesRoot, dir]) {
    await expect(
      restoreWorktreeFile(root, "file", entry, { ...boundary, dataDir }, runner),
    ).rejects.toThrow("outside the hub data directory");
    expect(() => restoreProfile(root, [dataDir])).toThrow("covers the scratch worktree");
  }
  expect(runner).not.toHaveBeenCalled();
  expect(readFileSync(join(root, "file"), "utf8")).toBe("experiment");
});

it("fails closed on other platforms and when the sandbox runner fails", async () => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  await expect(restoreWorktreeFile(root, "file", entry, boundary)).rejects.toThrow(
    "requires macOS sandbox-exec",
  );
  await expect(
    restoreWorktreeFile(root, "file", entry, boundary, async () => {
      throw new Error("sandbox failed to apply");
    }),
  ).rejects.toThrow("sandbox failed to apply");
  expect(readFileSync(join(root, "file"), "utf8")).toBe("experiment");
});

describe.skipIf(process.platform !== "darwin")("Seatbelt confinement", () => {
  beforeEach(async () => {
    await probe("process.stdout.write('sandbox ready')");
  });

  const probe = (program: string) =>
    runRestoreSandbox({
      cwd: root,
      profile: restoreProfile(root, [
        boundary.gitCommonDir,
        boundary.worktreeGitDir,
        boundary.dataDir,
      ]),
      args: ["--input-type=module", "-e", program],
      input: entry.body,
    });
  const write = (path: string) =>
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path)}, fs.readFileSync(0));`;

  it("allows the scratch file and denies outside symlinks, .git, both Git directories and hub data", async () => {
    await probe(write(join(root, "file")));
    expect(readFileSync(join(root, "file"))).toEqual(entry.body);
    symlinkSync(outside, join(root, "linked"));
    for (const path of [
      join(root, "linked/file"),
      join(root, ".git/file"),
      join(boundary.gitCommonDir, "file"),
      join(boundary.worktreeGitDir, "file"),
      join(boundary.dataDir, "file"),
    ]) {
      await expect(probe(write(path))).rejects.toThrow(
        /operation not permitted|permission denied/i,
      );
    }
    expect(readFileSync(join(outside, "file"), "utf8")).toBe("outside");
    expect(existsSync(join(root, ".git/file"))).toBe(false);
  });

  it("refuses an invalid profile without running the command", async () => {
    await expect(
      runRestoreSandbox({
        cwd: root,
        profile: "invalid profile",
        args: ["-e", write(join(root, "file"))],
        input: entry.body,
      }),
    ).rejects.toThrow("sandboxed restore failed");
    expect(readFileSync(join(root, "file"), "utf8")).toBe("experiment");
  });

  it.each(["root", "parent", "git-parent"])(
    "confines a %s substitution after the hub's checks",
    async (kind) => {
      mkdirSync(join(root, "parent"));
      writeFileSync(join(root, "parent/file"), "experiment");
      const path = kind === "root" ? "file" : "parent/file";
      await expect(
        restoreWorktreeFile(root, path, entry, boundary, async (call) => {
          const from = kind === "root" ? root : join(root, "parent");
          renameSync(from, `${from}-old`);
          symlinkSync(kind === "git-parent" ? boundary.worktreeGitDir : outside, from);
          await runRestoreSandbox(call);
        }),
      ).rejects.toThrow(/operation not permitted|permission denied/i);
      expect(readFileSync(join(outside, "file"), "utf8")).toBe("outside");
      expect(existsSync(join(boundary.worktreeGitDir, "file"))).toBe(false);
    },
  );

  it.each(["temp", "target"])(
    "keeps outside bytes intact after %s substitution in the helper",
    async (kind) => {
      const helper = new URL("../src/mcp/restore-helper.ts", import.meta.url).href;
      const outsideFile = join(outside, "file");
      const program = `
      import fs from 'node:fs';
      import { mutateRestore } from ${JSON.stringify(helper)};
      const unlink = fs.unlinkSync;
      if (${JSON.stringify(kind)} === 'temp') {
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
          unlink(from);
          fs.symlinkSync(${JSON.stringify(outsideFile)}, from);
          return rename(from, to);
        };
      } else {
        fs.unlinkSync = (path) => {
          if (path === 'file') {
            unlink(path);
            fs.symlinkSync(${JSON.stringify(outsideFile)}, path);
          }
          return unlink(path);
        };
      }
      mutateRestore('file', '100644', ${JSON.stringify(kind === "temp" ? "restore" : "delete")});
    `;
      await probe(program);
      expect(readFileSync(outsideFile, "utf8")).toBe("outside");
      expect(existsSync(join(root, ".git/file"))).toBe(false);
    },
  );

  it.each(["outside", "git"])(
    "denies writes after the helper's cwd is relocated into %s",
    async (target) => {
      const parent = join(root, "parent");
      mkdirSync(parent);
      writeFileSync(join(parent, "file"), "experiment");
      const moved = join(target === "outside" ? outside : boundary.gitCommonDir, "moved");
      const helper = new URL("../src/mcp/restore-helper.ts", import.meta.url).href;
      const program = `
      import fs from 'node:fs';
      import { mutateRestore } from ${JSON.stringify(helper)};
      const read = fs.readFileSync;
      fs.readFileSync = (path, ...args) => {
        if (path === 0) process.stdout.write('ready');
        return read(path, ...args);
      };
      mutateRestore('parent/file', '100644', 'restore');
    `;
      const child = promisify(execFile)(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          restoreProfile(root, [boundary.gitCommonDir, boundary.worktreeGitDir, boundary.dataDir]),
          process.execPath,
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          program,
        ],
        { cwd: root, timeout: 5000 },
      );
      const movedWhenReady = new Promise<void>((resolve, reject) => {
        child.child.once("error", reject);
        child.child.once("exit", () => reject(new Error("helper exited before relocation")));
        child.child.stdout?.once("data", () => {
          try {
            renameSync(parent, moved);
            child.child.stdin?.end(entry.body);
            resolve();
          } catch (e) {
            child.child.stdin?.end();
            reject(e);
          }
        });
      });
      child.child.stdin?.on("error", () => {});
      await expect(Promise.all([child, movedWhenReady])).rejects.toThrow(
        /operation not permitted|permission denied/i,
      );
      expect(readFileSync(join(moved, "file"), "utf8")).toBe("experiment");
      expect(readFileSync(join(outside, "file"), "utf8")).toBe("outside");
    },
  );
});
