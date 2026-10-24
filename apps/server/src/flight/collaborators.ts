import type { GhRunner } from "../mcp/gh.ts";
import type { Store } from "../store.ts";

const TTL = 24 * 60 * 60_000;
const key = (repo: string, login: string) => `collaborator:${repo}:${login.toLowerCase()}`;

/** Missing and expired permissions are untrusted; cached results are evidence, never grants. */
export function trustedAuthor(
  store: Store,
  repo: string,
  login: string | null | undefined,
  now: number,
): boolean {
  if (!login) return false;
  const value = store.getSetting(key(repo, login));
  if (!value) return false;
  try {
    const entry = JSON.parse(value);
    return entry.trusted === true && typeof entry.at === "number" && now - entry.at < TTL;
  } catch {
    return false;
  }
}

export async function collaborator(
  store: Store,
  gh: GhRunner,
  cwd: string,
  repo: string,
  login: string | null | undefined,
  now: number,
): Promise<boolean> {
  if (!login || !/^[A-Za-z0-9-]{1,39}$/.test(login)) return false;
  store.pruneCollaborators(now - 7 * TTL);
  const saved = store.getSetting(key(repo, login));
  if (saved) {
    try {
      if (now - JSON.parse(saved).at < TTL) return trustedAuthor(store, repo, login, now);
    } catch {
      /* read again */
    }
  }
  const result = await gh(
    ["api", "--method=GET", `repos/${repo}/collaborators/${login}/permission`],
    { cwd },
  );
  let trusted = false;
  if (result.code === 0) {
    try {
      trusted = ["write", "maintain", "admin"].includes(JSON.parse(result.stdout).permission);
    } catch {
      /* fail closed */
    }
  }
  store.setSetting(key(repo, login), JSON.stringify({ at: now, trusted }));
  return trusted;
}

/** Warm only authors already present in the digest's repo; no issue-body reads. */
export async function refreshAuthors(
  store: Store,
  gh: GhRunner,
  cwd: string,
  repoId: string,
  github: string,
  now: number,
): Promise<void> {
  store.pruneCollaborators(now - 7 * TTL);
  const authors = new Set(
    [...store.board(repoId), ...store.pullRequests(repoId)]
      .map((x) => x.author)
      .filter((x): x is string => !!x),
  );
  for (const login of authors) await collaborator(store, gh, cwd, github, login, now);
}
