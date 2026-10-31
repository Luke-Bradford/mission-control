/**
 * Branch tidying. GitHub's delete-on-merge removes a branch only when its PR merges, so the hub
 * removes the rest: a crew branch whose PR closed unmerged (`closedPass`), and any branch with no
 * open PR, no live run and no commit for a day (`sweep`). It also drops the local branches of the
 * seat clones that are merged or whose remote is gone (`pruneLocal`).
 *
 * The one GitHub write is `DELETE /git/refs/heads/<branch>`. A branch is deleted only after
 * reads that all succeeded: a failed read skips the repo, never guesses.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { CcConfig } from "./config.ts";
import type { GhRunner } from "./mcp/gh.ts";
import { RUN_BRANCH } from "./mcp/tools.ts";
import { CREW_GIT_SLOW_MS } from "./runtime/checkouts.ts";
import { crewGit } from "./runtime/git.ts";
import { crewDir, type Store } from "./store.ts";

/** A branch must have had no commit for this long before the sweep takes it. */
export const SWEEP_MIN_AGE_MS = 24 * 60 * 60_000;
/** The sweep runs this often. */
export const SWEEP_EVERY_MS = 24 * 60 * 60_000;
/** The closed-PR pass and the local prune run this often. */
export const TIDY_EVERY_MS = 10 * 60_000;
/** Branches under this prefix are never touched. */
export const KEEP_PREFIX = "archive/";
/** Ref pages read per repo (100 branches each). */
const MAX_PAGES = 20;
/** A branch name the hub will put in an API path: nothing a path or shell could read differently. */
export const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

export interface RemoteBranch {
  name: string;
  /** The tip commit's date; null when GitHub gave none. */
  committedAt: number | null;
}

/** Whether the hub must leave `branch` alone: the default branch, `archive/*`, or the repo's keep-list. */
export function isKept(branch: string, defaultBranch: string, keep: readonly string[]): boolean {
  return (
    branch === defaultBranch ||
    branch.startsWith(KEEP_PREFIX) ||
    keep.some((k) => (k.endsWith("*") ? branch.startsWith(k.slice(0, -1)) : branch === k))
  );
}

export interface BranchTidyDeps {
  config: CcConfig;
  store: Store;
  gh: GhRunner;
  dbPath: string;
  inClone: <T>(checkout: string, fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
  git?: typeof crewGit;
  log?: (line: string) => void;
}

export interface BranchTidy {
  /** Deletes the branches of crew PRs that closed unmerged; the branches deleted, as `repo:branch`. */
  closedPass(): Promise<string[]>;
  /** Deletes every branch with no open PR, no live run and no commit for 24 hours. */
  sweep(): Promise<string[]>;
  /** Fetches each seat clone and drops its local branches that are merged or gone. */
  pruneLocal(): Promise<string[]>;
}

const REFS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: 100, after: $after) {
      nodes { name target { ... on Commit { committedDate } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export function createBranchTidy(deps: BranchTidyDeps): BranchTidy {
  const now = deps.now ?? Date.now;
  const cwd = () => crewDir(deps.dbPath);
  const log = (line: string) => deps.log?.(`branch tidy: ${line}`);

  /** The repo's remote branches and its default branch, or null when any page could not be read. */
  async function remoteBranches(
    repo: string,
  ): Promise<{ defaultBranch: string; branches: RemoteBranch[] } | null> {
    const [owner = "", name = ""] = repo.split("/");
    const branches: RemoteBranch[] = [];
    let defaultBranch: string | null = null;
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${REFS_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        ...(after === null ? [] : ["-F", `after=${after}`]),
      ];
      const r = await deps.gh(args, { cwd: cwd() });
      if (r.code !== 0) return null;
      let repository: {
        defaultBranchRef?: { name?: unknown } | null;
        refs?: {
          nodes?: { name?: unknown; target?: { committedDate?: unknown } | null }[];
          pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
        };
      } | null;
      try {
        repository =
          (JSON.parse(r.stdout) as { data?: { repository?: typeof repository } }).data
            ?.repository ?? null;
      } catch {
        return null;
      }
      const refs = repository?.refs;
      if (refs?.nodes === undefined || !Array.isArray(refs.nodes)) return null;
      if (typeof repository?.defaultBranchRef?.name === "string") {
        defaultBranch = repository.defaultBranchRef.name;
      }
      for (const n of refs.nodes) {
        if (typeof n?.name !== "string") continue;
        const at = Date.parse(String(n.target?.committedDate));
        branches.push({ name: n.name, committedAt: Number.isNaN(at) ? null : at });
      }
      if (refs.pageInfo?.hasNextPage !== true) {
        return defaultBranch === null ? null : { defaultBranch, branches };
      }
      if (typeof refs.pageInfo.endCursor !== "string") return null;
      after = refs.pageInfo.endCursor;
    }
    return null;
  }

  /** The head and base branches of the repo's open PRs, or null when gh could not say. */
  async function openPrBranches(repo: string): Promise<Set<string> | null> {
    const r = await deps.gh(
      [
        "pr",
        "list",
        `--repo=${repo}`,
        "--state=open",
        "--limit=1000",
        "--json=headRefName,baseRefName",
      ],
      { cwd: cwd() },
    );
    if (r.code !== 0) return null;
    try {
      const parsed: unknown = JSON.parse(r.stdout);
      if (!Array.isArray(parsed)) return null;
      const out = new Set<string>();
      for (const p of parsed as { headRefName?: unknown; baseRefName?: unknown }[]) {
        if (typeof p?.headRefName !== "string") return null;
        out.add(p.headRefName);
        // a branch another open PR is stacked on stays
        if (typeof p.baseRefName === "string") out.add(p.baseRefName);
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Whether the crew has a session in the repo and no observed loop works in it. */
  const crewWorks = (repoId: string): boolean =>
    (deps.config.crew?.sessions ?? []).some((x) => x.repoId === repoId) &&
    !deps.config.loops.some((l) => l.repoId === repoId);

  /** The branches of runs that have not ended, per repo. */
  function liveBranches(repoId: string): Set<string> {
    const out = new Set<string>();
    for (const run of deps.store.runsActiveSince(Number.MAX_SAFE_INTEGER)) {
      // a run parked on a closed PR holds nothing: its PR is gone and nothing lifts that park
      if (run.loop?.parked?.kind === "pr-closed") continue;
      if (run.repoId === repoId && run.endedAt === null && run.branch !== null) out.add(run.branch);
    }
    return out;
  }

  /** `DELETE /git/refs/heads/<branch>`; a branch already gone counts as deleted. */
  async function deleteBranch(repo: string, branch: string): Promise<boolean> {
    if (!SAFE_BRANCH.test(branch)) return false;
    const path = `repos/${repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
    const r = await deps.gh(["api", "--method", "DELETE", path], { cwd: cwd() });
    return r.code === 0 || /HTTP 422|Reference does not exist/i.test(r.stderr);
  }

  /** Deletes, in each repo, the branches `wanted` picks that are not kept, open or live. */
  async function tidy(
    wanted: (b: RemoteBranch, repoId: string) => boolean,
    reason: string,
  ): Promise<string[]> {
    const deleted: string[] = [];
    for (const repo of deps.config.repos) {
      // only a repo the crew works in: an observed loop's branches and the operator's are not ours
      if (!crewWorks(repo.id)) continue;
      try {
        const listed = await remoteBranches(repo.github);
        const open = listed === null ? null : await openPrBranches(repo.github);
        if (listed === null || open === null) {
          log(`${repo.id}: branches or PRs could not be read; nothing deleted`);
          continue;
        }
        const live = liveBranches(repo.id);
        for (const b of listed.branches) {
          if (
            isKept(b.name, listed.defaultBranch, repo.keepBranches ?? []) ||
            open.has(b.name) ||
            live.has(b.name) ||
            !wanted(b, repo.id)
          ) {
            continue;
          }
          if (!(await deleteBranch(repo.github, b.name))) {
            log(`${repo.id}: could not delete ${b.name}`);
            continue;
          }
          deps.store.addHubEvent(`Deleted branch ${b.name} in ${repo.github}: ${reason}`, now());
          deleted.push(`${repo.id}:${b.name}`);
        }
      } catch (e) {
        log(`${repo.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return deleted;
  }

  /** Drops the clone's local branches that are merged into origin's default branch or whose remote is gone. */
  async function pruneClone(checkout: string, live: ReadonlySet<string>): Promise<string[]> {
    const git = deps.git ?? crewGit;
    return deps.inClone(checkout, async () => {
      const common = await realpath(join(checkout, ".git"));
      const g = (a: string[]) =>
        git(checkout, a, common, { gitDir: common, timeoutMs: CREW_GIT_SLOW_MS });
      await g(["fetch", "--quiet", "--prune", "--no-tags", "origin"]);
      const head = (
        await g(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")
      ).trim();
      const base = head === "" ? null : head;
      // branches checked out in a worktree (a live run's) are never dropped
      const busy = new Set(
        (await g(["worktree", "list", "--porcelain"]))
          .split("\n")
          .filter((l) => l.startsWith("branch refs/heads/"))
          .map((l) => l.slice("branch refs/heads/".length)),
      );
      const merged = new Set(
        base === null
          ? []
          : (await g(["for-each-ref", "--format=%(refname:short)", "--merged", base, "refs/heads"]))
              .split("\n")
              .filter(Boolean),
      );
      const dropped: string[] = [];
      const rows = (
        await g(["for-each-ref", "--format=%(refname:short)%09%(upstream:track)", "refs/heads"])
      )
        .split("\n")
        .filter(Boolean);
      for (const row of rows) {
        const [name = "", track = ""] = row.split("\t");
        const gone = track === "[gone]";
        if (
          name === "" ||
          busy.has(name) ||
          live.has(name) ||
          (base !== null && name === base.replace(/^origin\//, "")) ||
          !(gone || merged.has(name))
        ) {
          continue;
        }
        try {
          await g(["branch", gone ? "-D" : "-d", "--", name]);
          dropped.push(name);
        } catch {
          // a branch git will not drop stays
        }
      }
      return dropped;
    });
  }

  return {
    async closedPass() {
      const closed = new Map<string, Set<string>>();
      for (const repo of deps.config.repos) {
        const set = new Set<string>();
        for (const pr of deps.store.pullRequests(repo.id)) {
          if (pr.state === "closed" && RUN_BRANCH.test(pr.branch)) set.add(pr.branch);
        }
        closed.set(repo.id, set);
      }
      return tidy(
        (b, repoId) => closed.get(repoId)?.has(b.name) === true,
        "its PR closed unmerged",
      );
    },

    async sweep() {
      const cutoff = now() - SWEEP_MIN_AGE_MS;
      return tidy(
        (b) => b.committedAt !== null && b.committedAt <= cutoff,
        "no open PR, no live run, no commit for 24 hours",
      );
    },

    async pruneLocal() {
      const dropped: string[] = [];
      for (const session of deps.config.crew?.sessions ?? []) {
        try {
          const live = liveBranches(session.repoId);
          for (const b of await pruneClone(session.checkout, live)) {
            dropped.push(`${session.repoId}:${b}`);
          }
        } catch (e) {
          log(`${session.checkout}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return dropped;
    },
  };
}
