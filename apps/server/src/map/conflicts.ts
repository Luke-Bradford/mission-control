import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MapSnapshot, PullRequestView } from "@mc/core";
import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS, gitEnv } from "../files.ts";

const execFileP = promisify(execFile);
type Tip = Pick<PullRequestView, "branch" | "headSha" | "state">;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

// Serialise checks, leaving room for another map git collector under the two-process limit.
let pending: Promise<unknown> = Promise.resolve();
function queued<T>(run: () => Promise<T>): Promise<T> {
  const next = pending.then(run, run);
  pending = next.catch(() => {});
  return next;
}

/** Slice 6: the snapshot's conflicts, from Store.pullRequests(repoId), never local branch refs. */
export class MapConflicts {
  private readonly cache = new Map<string, string[]>();

  async read(worktree: string, prs: readonly Tip[]): Promise<MapSnapshot["conflicts"]> {
    return queued(async () => {
      const tips = prs.filter((p) => p.state === "open" && p.headSha && SHA.test(p.headSha));
      const conflicts: MapSnapshot["conflicts"] = [];
      for (let i = 0; i < tips.length; i++) {
        const a = tips[i] as Tip & { headSha: string };
        for (const b of tips.slice(i + 1) as (Tip & { headSha: string })[]) {
          if (a.headSha === b.headSha) continue;
          const shas = [a.headSha, b.headSha].sort();
          const key = shas.join(":");
          let files = this.cache.get(key);
          if (files === undefined) {
            files = await mergeFiles(worktree, shas[0] as string, shas[1] as string);
            this.cache.set(key, files);
            if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value as string);
          }
          for (const file of files) {
            conflicts.push({ file, branches: [a.branch, b.branch], shas: [a.headSha, b.headSha] });
          }
        }
      }
      return conflicts;
    });
  }
}

async function mergeFiles(worktree: string, left: string, right: string): Promise<string[]> {
  const scratch = await mkdtemp(join(tmpdir(), "mc-map-merge-"));
  const env = {
    ...gitEnv(process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    (
      await execFileP(
        "git",
        ["--no-optional-locks", "-c", "core.attributesFile=/dev/null", ...args],
        {
          env: { ...env, ...extra },
          encoding: "utf8",
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
        },
      )
    ).stdout;
  try {
    const objects = (
      await git([
        "-c",
        "core.fsmonitor=false",
        "-C",
        worktree,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ])
    ).trim();
    // A separate bare repo excludes source hooks, merge drivers and promisor config.
    await git([
      "init",
      "--bare",
      "--template=",
      `--object-format=${left.length === 64 ? "sha256" : "sha1"}`,
      "-q",
      scratch,
    ]);
    let output: string;
    try {
      await git(["-C", scratch, "merge-tree", "--write-tree", "--name-only", "-z", left, right], {
        GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects),
      });
      return [];
    } catch (e) {
      const failure = e as { code?: number; stdout?: string; killed?: boolean; signal?: string };
      if (
        failure.code !== 1 ||
        failure.killed ||
        failure.signal ||
        typeof failure.stdout !== "string"
      )
        throw e;
      output = failure.stdout;
    }
    // -z: tree id, conflicting paths, empty record, then informational messages.
    const records = output.split("\0");
    if (!SHA.test(records.shift() ?? "") || !records.includes("")) {
      throw new Error("Invalid merge-tree conflict output");
    }
    return [...new Set(records.slice(0, records.indexOf("")))];
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
