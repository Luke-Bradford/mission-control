import { describe, expect, it, vi } from "vitest";
import { type AppPreviewDeps, startAppPreview } from "../src/preview/app.ts";
import { PreviewManager } from "../src/preview/previews.ts";
import { createReviewPreviews } from "../src/preview/review.ts";

const SHA = "b".repeat(40);

describe("a non-hub repo's web PR gets a preview", () => {
  it("starts its own run command on the manager's port when a frontend/** file changes", async () => {
    const calls: string[][] = [];
    const spawned: { command: string; cwd: string; env: Record<string, string> }[] = [];
    const child = {};
    const deps: AppPreviewDeps = {
      run: async (command, args) => {
        calls.push([command, ...args]);
      },
      spawnApp: (command, cwd, env) => {
        spawned.push({ command, cwd, env });
        return child;
      },
      wait: async () => {},
      stop: async () => {},
    };
    const trusted = vi.fn(async () => true);
    const manager = new PreviewManager({
      trusted,
      capacity: () => ({ blocked: false, reason: null }),
      exists: () => false,
      start: async ({ repoId, pr, sha, port, checkout, signal }) => {
        expect(repoId).toBe("site");
        return await startAppPreview(deps, {
          checkout,
          root: "/data/previews/7",
          pr,
          ...(sha === undefined ? {} : { sha }),
          runCommand: "npm run dev",
          port,
          signal,
        });
      },
      remove: async () => {},
    });
    const previews = createReviewPreviews({
      previews: manager,
      files: () => ["frontend/src/app.tsx"],
      webGlobs: async (repoId) => (repoId === "site" ? ["frontend/**"] : ["apps/web/**"]),
      checkout: () => "/clones/site",
    });

    expect(
      await previews.open({ runId: "r:1", repoId: "site", pr: 7, branch: "feature/7", sha: SHA }),
    ).toBe(true);
    const ready = await previews.ready("r:1");

    expect(ready.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(trusted).toHaveBeenCalledWith(expect.objectContaining({ repoId: "site", pr: 7 }));
    expect(calls).toContainEqual([
      "git",
      "-C",
      "/clones/site",
      "worktree",
      "add",
      "-f",
      "--detach",
      "/data/previews/7/worktree",
      SHA,
    ]);
    expect(spawned).toEqual([
      {
        command: "npm run dev",
        cwd: "/data/previews/7/worktree",
        env: { PORT: String(new URL(ready.origin as string).port) },
      },
    ]);
    await previews.close("r:1");
  });

  it("refuses to start a repo that configures no run command", async () => {
    const deps: AppPreviewDeps = {
      run: async () => {},
      spawnApp: () => ({}),
      wait: async () => {},
      stop: async () => {},
    };
    await expect(
      startAppPreview(deps, {
        checkout: "/c",
        root: "/r",
        pr: 1,
        runCommand: undefined,
        port: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/run_command/);
  });
});
