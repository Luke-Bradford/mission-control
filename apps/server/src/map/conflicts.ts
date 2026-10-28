import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MapSnapshot, MapUnchecked, PullRequestView } from "@mc/core";
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

/** A pair whose merge check failed although both heads are present (logged, never cached). */
export interface PairFailure {
  branches: [string, string];
  reason: string;
}

/** How long a head found missing is taken as still missing before git is asked again. */
export const MISSING_HEAD_TTL_MS = 30_000;

/** Slice 6: the snapshot's conflicts, from Store.pullRequests(repoId), never local branch refs. */
export class MapConflicts {
  private readonly cache = new Map<string, string[]>();
  /** sha → when the checkout was last found not to hold it. */
  private readonly missing = new Map<string, number>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The conflicts, or a rejection when any open pair could not be checked (never reported clean). */
  async read(worktree: string, prs: readonly Tip[]): Promise<MapSnapshot["conflicts"]> {
    const { conflicts, unchecked } = await this.check(worktree, prs);
    if (unchecked.length > 0)
      throw new Error(
        `map conflicts unchecked for ${unchecked.map((u) => `${u.branch} (${u.reason})`).join(", ")}`,
      );
    return conflicts;
  }

  /**
   * The conflicts between every pair the checkout can merge, and the branches with a pair it could
   * not: a head it hasn't fetched yet, or a merge check that failed (unrelated histories, a
   * timeout). An unchecked pair is neither cached nor reported clean, so it is checked again once
   * possible. Only a broken checkout rejects.
   */
  async check(
    worktree: string,
    prs: readonly Tip[],
  ): Promise<{
    conflicts: MapSnapshot["conflicts"];
    unchecked: MapUnchecked[];
    failures: PairFailure[];
  }> {
    return queued(async () => {
      const tips = prs.filter((p) => p.state === "open" && p.headSha && SHA.test(p.headSha));
      const conflicts: MapSnapshot["conflicts"] = [];
      const unchecked = new Map<string, MapUnchecked["reason"]>();
      const failures: PairFailure[] = [];
      // Checked only on a cache miss: a cached pair needs no object reads.
      const present = new Map<string, Promise<boolean>>();
      const holds = (sha: string) => {
        let known = present.get(sha);
        if (known === undefined) {
          known = this.holds(worktree, sha);
          present.set(sha, known);
        }
        return known;
      };
      for (let i = 0; i < tips.length; i++) {
        const a = tips[i] as Tip & { headSha: string };
        for (const b of tips.slice(i + 1) as (Tip & { headSha: string })[]) {
          if (a.headSha === b.headSha) continue;
          const shas = [a.headSha, b.headSha].sort();
          const key = shas.join(":");
          let files = this.cache.get(key);
          if (files === undefined) {
            // A PR head the checkout hasn't fetched yet has no objects to merge: record it as
            // unchecked (uncached, so it is checked once fetched) rather than fail the snapshot.
            const missing: Tip[] = [];
            for (const t of [a, b]) if (!(await holds(t.headSha))) missing.push(t);
            if (missing.length > 0) {
              for (const t of missing) unchecked.set(t.branch, "head not fetched");
              continue;
            }
            try {
              files = await mergeFiles(worktree, shas[0] as string, shas[1] as string);
            } catch (e) {
              // both heads are here, so the checkout is sound: only this pair is unknown
              failures.push({ branches: [a.branch, b.branch], reason: reasonOf(e) });
              for (const t of [a, b])
                if (!unchecked.has(t.branch)) unchecked.set(t.branch, "merge check failed");
              continue;
            }
            this.cache.set(key, files);
            if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value as string);
          }
          for (const file of files) {
            conflicts.push({ file, branches: [a.branch, b.branch], shas: [a.headSha, b.headSha] });
          }
        }
      }
      return {
        conflicts,
        unchecked: [...unchecked.entries()]
          .map(([branch, reason]) => ({ branch, reason }))
          .sort((x, y) => x.branch.localeCompare(y.branch)),
        failures,
      };
    });
  }

  /** Whether the checkout holds `sha`; a head found missing stays missing for 30 s without git. */
  private async holds(worktree: string, sha: string): Promise<boolean> {
    const at = this.missing.get(sha);
    if (at !== undefined && this.now() - at < MISSING_HEAD_TTL_MS) return false;
    const held = await hasCommit(worktree, sha);
    if (held) this.missing.delete(sha);
    else {
      this.missing.set(sha, this.now());
      if (this.missing.size > 256) this.missing.delete(this.missing.keys().next().value as string);
    }
    return held;
  }
}

/** A git failure's first line, for the log; never sent to the page. */
function reasonOf(e: unknown): string {
  const failure = e as { code?: unknown; signal?: unknown; killed?: boolean; message?: unknown };
  const first = typeof failure.message === "string" ? (failure.message.split("\n")[0] ?? "") : "";
  const how = failure.killed
    ? "timed out"
    : failure.signal
      ? `signal ${String(failure.signal)}`
      : failure.code !== undefined
        ? `exit ${String(failure.code)}`
        : "failed";
  return `${how}: ${first}`.slice(0, 300);
}

/** Git's environment for map reads: no system or global config, no lazy fetch, no prompts. */
function isolatedEnv(): NodeJS.ProcessEnv {
  return {
    ...gitEnv(process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Whether the checkout holds `sha` as a commit. `rev-parse -q --verify` exits 1 only when the name
 * does not resolve; a broken or missing checkout exits 128 and throws, failing the snapshot.
 */
async function hasCommit(worktree: string, sha: string): Promise<boolean> {
  try {
    await execFileP(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.attributesFile=/dev/null",
        "-C",
        worktree,
        "rev-parse",
        "-q",
        "--verify",
        `${sha}^{commit}`,
      ],
      { env: isolatedEnv(), timeout: GIT_TIMEOUT_MS },
    );
    return true;
  } catch (e) {
    const failure = e as { code?: number; killed?: boolean; signal?: string };
    if (failure.code === 1 && !failure.killed && !failure.signal) return false;
    throw e;
  }
}

async function mergeFiles(worktree: string, left: string, right: string): Promise<string[]> {
  const scratch = await mkdtemp(join(tmpdir(), "mc-map-merge-"));
  const env = isolatedEnv();
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
