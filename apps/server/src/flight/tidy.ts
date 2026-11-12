/**
 * FLIGHT's crew housekeeping (#1214): remove the worktree of a run that has ended (the branch
 * stays, so a seat can start the ticket again), and drop the seat clones' merged or gone local
 * branches. A clean worktree only: a dirty one, a live run's, or one outside the crew's worktree
 * folder is refused.
 */
import { realpath, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Run } from "@mc/core";
import type { CcConfig } from "../config.ts";
import { CheckoutError, removeCheckout } from "../runtime/checkouts.ts";
import { crewGit } from "../runtime/git.ts";
import type { Store } from "../store.ts";

export interface TidyResult {
  ok: boolean;
  text: string;
}

export interface CrewTidy {
  /** Removes the clean worktree an ended run's branch is checked out in; the branch is kept. */
  removeWorktree(runId: string): Promise<TidyResult>;
  /** Drops the seat clones' local branches that are merged or whose remote is gone. */
  pruneBranches(): Promise<TidyResult>;
}

export interface CrewTidyCycle extends CrewTidy {
  /**
   * One cycle (#1756): removes the worktree of every recently ended run whose PR has merged or
   * closed, and drops `node_modules` from the worktree of an ended run whose work is still open
   * (a set-aside run); the seat reinstalls when the run resumes. Returns the run ids of each.
   */
  tidyFinished(now: number): Promise<{ removed: string[]; trimmed: string[] }>;
}

/** An ended run's worktree is tidied for this long after it ended. */
export const TIDY_FINISHED_WINDOW_MS = 30 * 86_400_000;

export interface CrewTidyDeps {
  config: CcConfig;
  store: Store;
  /** `BranchTidy.pruneLocal`: the dropped branches, as `repo:branch`. */
  pruneLocal: () => Promise<string[]>;
  git?: typeof crewGit;
  remove?: typeof removeCheckout;
}

type SessionRef = NonNullable<CcConfig["crew"]>["sessions"][number];
const no = (text: string): TidyResult => ({ ok: false, text });

export function createCrewTidy(deps: CrewTidyDeps): CrewTidyCycle {
  const git = deps.git ?? crewGit;
  const remove = deps.remove ?? removeCheckout;

  /** The worktree an ended run's branch is checked out in, or why there is none to touch. */
  async function locate(run: Run): Promise<{ session: SessionRef; path: string } | string> {
    const branch = run.branch as string;
    const sessions = (deps.config.crew?.sessions ?? []).filter((s) => s.repoId === run.repoId);
    const session = sessions.find((s) => s.seats.some((x) => x.id === run.agentId)) ?? sessions[0];
    if (session === undefined) return "The crew has no checkout for that repo.";
    const root = deps.config.crew?.worktrees;
    if (root === undefined) return "The crew has no worktree folder.";
    const common = await realpath(join(session.checkout, ".git"));
    const listed = await git(session.checkout, ["worktree", "list", "--porcelain"], common, {
      gitDir: common,
    });
    const block = listed
      .split("\n\n")
      .find((b) => b.split("\n").includes(`branch refs/heads/${branch}`));
    const path = block
      ?.split("\n")
      .find((l) => l.startsWith("worktree "))
      ?.slice("worktree ".length);
    if (path === undefined) return "No worktree holds that branch.";
    const real = await realpath(path).catch(() => resolve(path));
    const base = await realpath(root).catch(() => resolve(root));
    if (!real.startsWith(base + sep)) return "That worktree is not in the crew's folder.";
    // a seat that still points at the worktree is using it
    if (
      deps.config.crew?.sessions
        .flatMap((s) => s.seats)
        .some((x) => deps.store.seatSession(x.id)?.worktree === path)
    )
      return "A seat still holds that worktree.";
    return { session, path };
  }

  return {
    async removeWorktree(runId) {
      const run = deps.store.run(runId);
      if (run === null) return no("Unknown run.");
      if (run.endedAt === null) return no("The run has not ended; end it first.");
      if (run.branch === null) return no("The run has no branch, so no worktree to find.");
      const branch = run.branch;
      const live = deps.store
        .runsActiveSince(Number.MAX_SAFE_INTEGER)
        .some((r) => r.endedAt === null && r.repoId === run.repoId && r.branch === branch);
      if (live) return no("Another run is live on that branch; its worktree is in use.");
      try {
        const found = await locate(run);
        if (typeof found === "string") return no(found);
        const { session, path } = found;
        await remove(session.checkout, path);
        return {
          ok: true,
          text: `Removed the worktree of ${runId}; the branch ${branch} is kept.`,
        };
      } catch (e) {
        if (e instanceof CheckoutError && e.code === "dirty")
          return no("The worktree has uncommitted changes; nothing was removed.");
        return no("The worktree could not be removed.");
      }
    },

    async tidyFinished(now) {
      const seen = new Set<string>();
      const out = { removed: [] as string[], trimmed: [] as string[] };
      const runs = deps.store
        .runsActiveSince(now - TIDY_FINISHED_WINDOW_MS)
        .filter((r) => r.endedAt !== null && r.branch !== null)
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
      for (const run of runs) {
        const key = `${run.repoId}:${run.branch}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pr = deps.store.pullRequestOfBranch(run.repoId, run.branch as string);
        if (pr !== null && pr.state !== "open") {
          if ((await this.removeWorktree(run.id)).ok) out.removed.push(run.id);
          continue;
        }
        const live = deps.store
          .runsActiveSince(Number.MAX_SAFE_INTEGER)
          .some((r) => r.endedAt === null && r.repoId === run.repoId && r.branch === run.branch);
        if (live) continue;
        try {
          const found = await locate(run);
          if (typeof found === "string") continue;
          const modules = join(found.path, "node_modules");
          if (!(await stat(modules).catch(() => null))?.isDirectory()) continue;
          await rm(modules, { recursive: true, force: true });
          out.trimmed.push(run.id);
        } catch {
          // left as it is; the next cycle looks again
        }
      }
      return out;
    },

    async pruneBranches() {
      try {
        const dropped = await deps.pruneLocal();
        return {
          ok: true,
          text:
            dropped.length === 0
              ? "No local branch was merged or gone."
              : `Dropped ${dropped.length} local ${dropped.length === 1 ? "branch" : "branches"}: ${dropped.join(", ")}.`,
        };
      } catch {
        return no("The local branches could not be pruned.");
      }
    },
  };
}
