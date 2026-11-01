import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evidenceSideStarter, runEvidenceCommand } from "../src/pr-evidence/hubs.ts";

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
