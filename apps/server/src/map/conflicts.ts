import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MapSnapshot, MapUnchecked, PullRequestView } from "@mc/core";
import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS, gitEnv } from "../files.ts";

const execFileP = promisify(execFile);
type Tip = Pick<PullRequestView, "branch" | "headSha" | "state"> & { number?: number };
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

// Serialise checks, leaving room for another map git collector under the two-process limit.
let pending: Promise<unknown> = Promise.resolve();
function queued<T>(run: () => Promise<T>): Promise<T> {
  const next = pending.then(run, run);
  pending = next.catch(() => {});
  return next;
}

/** A pair whose merge check failed although both heads are present: logged once per hold. */
export interface PairFailure {
  branches: [string, string];
  reason: string;
}

/**
 * How long a head found missing, or a pair whose check failed for a reason that may pass (a
 * timeout), is held as unchecked before git is asked again. A deterministic failure (exit 128, e.g.
 * unrelated histories) is held until either head changes, which changes the pair's key.
 */
export const RETRY_HOLD_MS = 10_000;

type Held = { reason: string; until: number };

/** Slice 6: the snapshot's conflicts, from Store.pullRequests(repoId), never local branch refs. */
export class MapConflicts {
  /** sha pair → the conflicting files of a pair that merged (or failed to) cleanly. */
  private readonly cache = new Map<string, string[]>();
  /** worktree and sha pair → a failed check, held as unchecked (never clean) until `until`. */
  private readonly failed = new Map<string, Held>();
  /** worktree and sha → when that checkout was last found not to hold it. */
  private readonly missing = new Map<string, number>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * The conflicts between every pair the checkout can merge, and the branches it could not check:
   * a head it hasn't fetched yet, or a tip whose merge checks failed (unrelated histories, a
   * timeout). A tip is blamed only when it has no pair that checked; a failed pair between two
   * otherwise-checked tips marks both. Nothing unchecked is reported clean. `failures` lists only
   * pairs newly failed, so each is logged once per hold. Only a broken checkout rejects.
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
      const failedPairs: [string, string][] = [];
      const checkedTips = new Set<string>();
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
      const now = this.now();
      for (let i = 0; i < tips.length; i++) {
        const a = tips[i] as Tip & { headSha: string };
        for (const b of tips.slice(i + 1) as (Tip & { headSha: string })[]) {
          if (a.headSha === b.headSha) continue;
          const shas = [a.headSha, b.headSha].sort();
          const key = shas.join(":");
          const failedKey = `${worktree}\0${key}`;
          let files = this.cache.get(key);
          if (files === undefined) {
            const held = this.failed.get(failedKey);
            if (held && held.until > now) {
              failedPairs.push([a.branch, b.branch]);
              continue;
            }
            if (held) this.failed.delete(failedKey);
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
              const failure = e as { code?: unknown; killed?: boolean; signal?: unknown };
              const deterministic = failure.code === 128 && !failure.killed && !failure.signal;
              const reason = reasonOf(e);
              this.failed.set(failedKey, {
                reason,
                until: deterministic ? Number.POSITIVE_INFINITY : now + RETRY_HOLD_MS,
              });
              if (this.failed.size > 256)
                this.failed.delete(this.failed.keys().next().value as string);
              failures.push({ branches: [a.branch, b.branch], reason });
              failedPairs.push([a.branch, b.branch]);
              continue;
            }
            this.cache.set(key, files);
            if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value as string);
          }
          checkedTips.add(a.branch);
          checkedTips.add(b.branch);
          for (const file of files) {
            conflicts.push({
              file,
              branches: [a.branch, b.branch],
              shas: [a.headSha, b.headSha],
              prs: [a.number ?? null, b.number ?? null],
            });
          }
        }
      }
      // blame the tip common to the failing pairs: a branch that checked against some other tip is
      // sound; when neither side of a failed pair checked anywhere, or both did, both are unknown
      for (const [a, b] of failedPairs) {
        const blamed = [a, b].filter((t) => !checkedTips.has(t));
        for (const t of blamed.length ? blamed : [a, b])
          if (!unchecked.has(t)) unchecked.set(t, "merge check failed");
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

  /** Whether the checkout holds `sha`; a head found missing stays missing for the hold, no git. */
  private async holds(worktree: string, sha: string): Promise<boolean> {
    const key = `${worktree}\0${sha}`;
    const at = this.missing.get(key);
    if (at !== undefined && this.now() - at < RETRY_HOLD_MS) return false;
    const held = await hasCommit(worktree, sha);
    if (held) this.missing.delete(key);
    else {
      this.missing.delete(key); // re-inserted last, so the map drops its oldest entry first
      this.missing.set(key, this.now());
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
