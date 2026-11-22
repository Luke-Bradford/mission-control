import { collaborator } from "../flight/collaborators.ts";
import type { GhRunner } from "../mcp/gh.ts";
import type { Store } from "../store.ts";

/** Why a PR's code may not be built; shown to the operator. */
export const UNTRUSTED_PR = "only pull requests from the crew or a collaborator are built and run";

/**
 * Whether the hub may build and run this PR head: it is open, on this repo's own branch (never a
 * fork) and its author has write access. The repo is public, so a stranger's code never runs here.
 * Read fresh from GitHub, the author's permission included (never the 24-hour cache, so a
 * revoked collaborator is refused at once); any failure is a refusal.
 */
export async function trustedPullRequest(
  store: Store,
  gh: GhRunner,
  cwd: string,
  repo: string,
  pr: number,
  sha: string | undefined,
  now: number,
): Promise<boolean> {
  const result = await gh(["api", "--method=GET", `repos/${repo}/pulls/${pr}`], { cwd });
  if (result.code !== 0) return false;
  let current: {
    state?: string;
    head?: { sha?: string; repo?: { full_name?: string } | null };
    user?: { login?: string };
  };
  try {
    current = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  if (
    current.state !== "open" ||
    (sha !== undefined && current.head?.sha?.toLowerCase() !== sha.toLowerCase()) ||
    current.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()
  )
    return false;
  return await collaborator(store, gh, cwd, repo, current.user?.login, now, true);
}
