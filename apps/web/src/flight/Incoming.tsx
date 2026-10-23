import type { BoardItem, RepoView } from "@mc/core";
import { cardColumn } from "../board/cards.ts";
import { useSecond, useTz } from "../clock.ts";
import { RESOURCES, useResource, useResources } from "../data.ts";
import { rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef } from "../hud/RepoRef.tsx";
import { inSession, useSession } from "../shell/session.ts";

const DASH = "—";
const NO_REPOS: RepoView[] = [];
export const INCOMING_WINDOW_MS = 86_400_000;
export const NO_INCOMING = "Nothing new in Backlog or Refinement in the last day.";

/** Open cards that are new (created within the window) in Backlog or Refinement, newest first. */
export function incomingCards(items: readonly BoardItem[], now: number): BoardItem[] {
  return items
    .filter((i) => {
      const col = cardColumn(i);
      return (
        !i.closed &&
        (col === "Backlog" || col === "Refinement") &&
        i.createdAt >= now - INCOMING_WINDOW_MS
      );
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Incoming (catalogue §2.2.4): cards that arrived in Backlog or Refinement in the last day. */
export function Incoming() {
  const repos = useResource<RepoView[]>(RESOURCES.repos).data ?? NO_REPOS;
  const boards = useResources<BoardItem[]>(repos.map((r) => RESOURCES.boards(r.id)));
  const [session] = useSession();
  const now = useSecond();
  const tz = useTz();
  const loaded = repos.length > 0 && boards.every((b) => b.data !== undefined);
  if (!loaded) return <p className="pb note">{DASH}</p>;
  const cards = incomingCards(
    boards.flatMap((b) => b.data ?? []).filter((i) => inSession(session, i.repoId)),
    now,
  );
  if (cards.length === 0) return <p className="pb note">{NO_INCOMING}</p>;
  return (
    <ul className="pb tlist" aria-label="Incoming cards">
      {cards.map((c) => (
        <li className="row" key={`${c.repoId}#${c.issueNumber}`} data-testid="incoming-row">
          <Pill tone="plain">Board</Pill>
          <span className="s">{tz === null ? DASH : rel(c.createdAt, now, tz)}</span>
          <Pill tone="neutral">{cardColumn(c)}</Pill>
          <RepoRef repoId={c.repoId} number={c.issueNumber} url={c.url} />
          <span className="min0 ellip">{c.title}</span>
        </li>
      ))}
    </ul>
  );
}
