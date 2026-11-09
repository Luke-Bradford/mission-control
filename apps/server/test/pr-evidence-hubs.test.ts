import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evidenceSideStarter,
  removeStaleEvidenceWork,
  runEvidenceCommand,
} from "../src/pr-evidence/hubs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SHA = "a".repeat(40);

function setup(over: { failAt?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mc-hubs-"));
  dirs.push(root);
  const commands: string[] = [];
  const events: string[] = [];
  const start = evidenceSideStarter({
    checkout: "/checkout",
    root,
    run: async (command, args, cwd) => {
      const line = [command, ...args].join(" ");
      commands.push(cwd === undefined ? line : `${line} (in worktree)`);
      if (over.failAt !== undefined && line.includes(over.failAt)) throw new Error("boom");
    },
    freePort: async () => 7555,
    launch: async ({ port, db }) => {
      events.push(`launch ${port} ${db.split("/").pop()}`);
      return {
        stop: async () => {
          events.push("hub stopped");
        },
      };
    },
  });
  return { start, commands, events };
}

describe("evidenceSideStarter", () => {
  it("cancels the build process group including a child process", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-evidence-build-"));
    dirs.push(root);
    const pidfile = join(root, "pid");
    const controller = new AbortController();
    const job = runEvidenceCommand(
      process.execPath,
      [
        "-e",
        `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);`,
        pidfile,
      ],
      root,
      controller.signal,
    );
    await expect.poll(() => readFileSync(pidfile, "utf8")).toMatch(/^\d+$/);
    const pid = Number(readFileSync(pidfile, "utf8"));
    controller.abort(new Error("cancel build"));
    await expect(job).rejects.toThrow("cancel build");
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });
  it("checks the commit out, builds the web app, serves it on a free port, and cleans up on stop", async () => {
    const t = setup();
    const side = await t.start({ sha: SHA, db: "/x/head.sqlite" });
    expect(side.origin).toBe("http://127.0.0.1:7555");
    expect(t.commands[0]).toBe(`git -C /checkout fetch origin ${SHA}`);
    expect(t.commands[1]).toMatch(/^git -C \/checkout worktree add -f --detach .+ a{40}$/);
    expect(t.commands.slice(2)).toEqual([
      "pnpm install --offline --frozen-lockfile (in worktree)",
      "pnpm --filter @mc/web build (in worktree)",
    ]);
    expect(t.events).toEqual(["launch 7555 head.sqlite"]);
    await side.stop();
    expect(t.events).toEqual(["launch 7555 head.sqlite", "hub stopped"]);
    expect(t.commands.at(-1)).toMatch(/^git -C \/checkout worktree remove --force /);
  });

  it("removes the worktree when a step fails, and says which", async () => {
    const t = setup({ failAt: "--filter" });
    await expect(t.start({ sha: SHA, db: "/x/head.sqlite" })).rejects.toThrow("boom");
    expect(t.events).toEqual([]);
    expect(t.commands.at(-1)).toMatch(/worktree remove --force/);
  });

  it("refuses a sha that is not a full commit id", async () => {
    const t = setup();
    await expect(t.start({ sha: "--upload-pack=x", db: "/x/y.sqlite" })).rejects.toThrow(/sha/);
    expect(t.commands).toEqual([]);
  });
});

describe("removeStaleEvidenceWork", () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" });
  const run = async (command: string, args: string[]): Promise<void> => {
    execFileSync(command, args, { stdio: "ignore" });
  };

  it("removes a dead capture's folder and its registered worktree, and leaves other files", async () => {
    const base = mkdtempSync(join(tmpdir(), "mc-stale-"));
    dirs.push(base);
    const checkout = join(base, "checkout");
    mkdirSync(checkout);
    git(checkout, "init", "-q");
    git(
      checkout,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    const workDir = join(base, "pr-evidence-work");
    const side = join(workDir, "sides", "abc-1234");
    mkdirSync(side, { recursive: true });
    git(checkout, "worktree", "add", "-q", "--detach", join(side, "worktree"));
    const capture = join(workDir, "capture-xyz");
    mkdirSync(capture);
    writeFileSync(join(capture, "snapshot.sqlite"), "db");
    writeFileSync(join(workDir, "keep.txt"), "not ours");
    expect(git(checkout, "worktree", "list")).toContain("abc-1234");

    const removed = await removeStaleEvidenceWork({ workDir, checkout, run });

    expect(removed.sort()).toEqual(["capture-xyz", join("sides", "abc-1234")]);
    expect(existsSync(capture)).toBe(false);
    expect(existsSync(side)).toBe(false);
    expect(readFileSync(join(workDir, "keep.txt"), "utf8")).toBe("not ours");
    expect(git(checkout, "worktree", "list")).not.toContain("abc-1234");
  });

  it("does nothing when there is no work folder", async () => {
    const base = mkdtempSync(join(tmpdir(), "mc-stale-"));
    dirs.push(base);
    const calls: string[][] = [];
    const removed = await removeStaleEvidenceWork({
      workDir: join(base, "none"),
      checkout: base,
      run: async (_c, args) => void calls.push(args),
    });
    expect(removed).toEqual([]);
    expect(calls).toEqual([]);
  });
});
