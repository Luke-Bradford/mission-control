/** Starts a hub that serves one commit's HUD from a copy of the database, for screenshots. */
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceSide } from "./capture.ts";

export interface EvidenceHubOptions {
  /** The checkout the commit is fetched into and its worktree is made from. */
  checkout: string;
  /** Where each side's worktree lives while it is served. */
  root: string;
  run(command: string, args: string[], cwd?: string, signal?: AbortSignal): Promise<void>;
  freePort(): Promise<number>;
  /** Spawns the hub on `port` with the database at `db` and resolves once it answers. */
  launch(input: {
    worktree: string;
    port: number;
    db: string;
    signal?: AbortSignal;
  }): Promise<{ stop(): Promise<void> }>;
}

const SHA = /^[0-9a-f]{40}$/;
const HOST = "127.0.0.1";

/** Returns `startSide` for the capture: one worktree, one hub, torn down by `stop`. */
export function evidenceSideStarter(
  o: EvidenceHubOptions,
): (input: { sha: string; db: string; signal?: AbortSignal }) => Promise<EvidenceSide> {
  return async ({ sha, db, signal }) => {
    if (!SHA.test(sha)) throw new Error("evidence side needs a full commit sha");
    const dir = join(o.root, `${sha.slice(0, 12)}-${randomBytes(4).toString("hex")}`);
    const worktree = join(dir, "worktree");
    let hub: { stop(): Promise<void> } | undefined;
    let added = false;
    const cleanup = async (): Promise<void> => {
      await hub?.stop().catch(() => {});
      if (added)
        await o
          .run("git", ["-C", o.checkout, "worktree", "remove", "--force", worktree])
          .catch(() => {});
      await rm(dir, { recursive: true, force: true });
    };
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await o.run("git", ["-C", o.checkout, "fetch", "origin", sha], undefined, signal);
      await o.run(
        "git",
        ["-C", o.checkout, "worktree", "add", "-f", "--detach", worktree, sha],
        undefined,
        signal,
      );
      added = true;
      await o.run("pnpm", ["install", "--offline", "--frozen-lockfile"], worktree, signal);
      await o.run("pnpm", ["--filter", "@mc/web", "build"], worktree, signal);
      const port = await o.freePort();
      hub = await o.launch({ worktree, port, db, ...(signal ? { signal } : {}) });
      return { origin: `http://${HOST}:${port}`, stop: cleanup };
    } catch (e) {
      await cleanup();
      throw e;
    }
  };
}
