/**
 * Claiming a ticket between hubs. Two hubs on one board share no store and no lock, so the claim
 * lives on GitHub: a hub assigns its own `gh` login to the issue when it starts a run, and never
 * deals or starts a ticket assigned to another login. Assigning does not move the card.
 */
import type { CcConfig } from "./config.ts";
import type { GhRunner } from "./mcp/gh.ts";

export const CLAIM_FAILED = "could not claim the ticket on GitHub";

/** The login `gh` is signed in as (`gh api user`), read once at start-up; null when it cannot be read. */
export async function readLogin(gh: GhRunner, cwd: string): Promise<string | null> {
  const out = await gh(["api", "user", "--jq", ".login"], { cwd });
  const login = out.stdout.trim();
  return out.code === 0 && login !== "" ? login : null;
}

/** Assigns `login` to the issue. Throws when gh refuses; the message carries no gh output. */
export async function assignIssue(
  gh: GhRunner,
  cwd: string,
  login: string,
  repo: CcConfig["repos"][number],
  issue: number,
): Promise<void> {
  const out = await gh(
    ["issue", "edit", String(issue), "--repo", repo.github, "--add-assignee", login],
    { cwd },
  );
  if (out.code !== 0) throw new Error(CLAIM_FAILED);
}
