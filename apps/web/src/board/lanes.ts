import type { BoardItem, RepoView } from "@mc/core";
import { SESSION_ALL } from "../shell/session.ts";

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

/**
 * GitHub ORs repeated `repo:` qualifiers, so one query covers every repo. Under a session only
 * that repo's lane is offered (an unknown session id offers them all; the page hides the cards).
 */
export function lanesFor(repos: RepoView[], session: string = SESSION_ALL): Lane[] {
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
      // The collector reads projects through `user(login:)`, so each is a user project.
      url: `https://github.com/users/${r.github.split("/")[0] ?? ""}/projects/${r.project}`,
      match: (i) => i.repoId === r.id,
    }),
  );
  const own = session === SESSION_ALL ? undefined : repoLanes.find((l) => l.id === session);
  return own ? [own] : [all, ...repoLanes];
}

/**
 * The route's repo wins over the stored lane, except on a ticket route (`/board/:repo/:n`), where
 * the repo only names the ticket and the stored lane picks the lane. An unknown id falls back to
 * All repos. A single offered lane (a session) is every lane's answer.
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
