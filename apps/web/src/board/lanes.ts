import type { BoardItem, RepoView } from "@mc/core";

/** A saved view: which tickets, and the GitHub query and project that show the same set. */
export type Lane = {
  id: string;
  name: string;
  query: string;
  url: string | null;
  match: (i: BoardItem) => boolean;
};

/** The All-repos lane's id; repo lanes use the repo id. */
export const ALL_LANE = "*";
/** The All-mine lane's id. */
export const MINE_LANE = "@mine";

/**
 * GitHub ORs repeated `repo:` qualifiers, so one query covers every repo.
 * Lanes are independent of the session filter, which follows a card's assigned agent.
 */
export function lanesFor(repos: RepoView[], githubLogin: string | null = null): Lane[] {
  const all: Lane = {
    id: ALL_LANE,
    name: "All repos",
    query: [...repos.map((r) => `repo:${r.github}`), "is:issue"].join(" "),
    url: null,
    match: () => true,
  };
  const repoLanes = repos.map(
    (r): Lane => ({
      id: r.id,
      name: r.id,
      query: `repo:${r.github} is:issue`,
      // GitHub's own address for the Project (user or organisation); until the server has read the
      // board there is none, so assume a user project.
      url:
        r.projectUrl ??
        `https://github.com/users/${r.github.split("/")[0] ?? ""}/projects/${r.project}`,
      match: (i) => i.repoId === r.id,
    }),
  );
  if (githubLogin === null) return [all, ...repoLanes];
  const query = `${all.query} assignee:${githubLogin}`;
  const mine: Lane = {
    id: MINE_LANE,
    name: "All mine",
    query,
    url: `https://github.com/issues?q=${encodeURIComponent(query)}`,
    match: (i) => (i.assignees ?? []).some((a) => a.toLowerCase() === githubLogin.toLowerCase()),
  };
  return [all, mine, ...repoLanes];
}

/**
 * The route's repo wins over the stored lane, except on a ticket route (`/board/:repo/:n`), where
 * the repo only names the ticket and the stored lane picks the lane. An unknown id falls back to
 * All repos.
 */
export function resolveLane(
  lanes: Lane[],
  routeRepo: string | null,
  stored: string | null,
  ticketRoute = false,
): Lane {
  if (lanes.length === 1) return lanes[0] as Lane;
  const find = (id: string | null) => (id === null ? undefined : lanes.find((l) => l.id === id));
  return find(ticketRoute ? null : routeRepo) ?? find(stored) ?? (lanes[0] as Lane);
}
