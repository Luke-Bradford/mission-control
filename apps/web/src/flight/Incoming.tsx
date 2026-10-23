import type { BoardItem, RepoView } from "@mc/core";
import { cardColumn } from "../board/cards.ts";
import { useSecond, useTz } from "../clock.ts";
import { RESOURCES, useResource, useResources } from "../data.ts";
import { rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef } from "../hud/RepoRef.tsx";
import { type NotificationsView, type PersonThreadView, whoOf } from "../notifications.ts";
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

/** GitHub threads updated within the window, newest first. */
export function incomingThreads(
  threads: readonly PersonThreadView[],
  now: number,
): PersonThreadView[] {
  return threads
    .filter((t) => t.updatedAt >= now - INCOMING_WINDOW_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

type Row = { at: number } & (
  | { from: "board"; card: BoardItem }
  | { from: "github"; thread: PersonThreadView }
);

/** Incoming (catalogue §2.2.4): cards that arrived in Backlog or Refinement, and GitHub threads, in the last day. */
export function Incoming() {
  const repos = useResource<RepoView[]>(RESOURCES.repos).data ?? NO_REPOS;
  const boards = useResources<BoardItem[]>(repos.map((r) => RESOURCES.boards(r.id)));
  const notes = useResource<NotificationsView>(RESOURCES.notifications);
  const [session] = useSession();
  const now = useSecond();
  const tz = useTz();
  const loaded =
    repos.length > 0 &&
    boards.every((b) => b.data !== undefined) &&
    (notes.data !== undefined || notes.error !== null);
  if (!loaded) return <p className="pb note">{DASH}</p>;
  const cards = incomingCards(
    boards.flatMap((b) => b.data ?? []).filter((i) => inSession(session, i.repoId)),
    now,
  );
  const threads = incomingThreads(
    (notes.data?.open ?? []).filter((t) => inSession(session, t.repoId)),
    now,
  );
  const rows: Row[] = [
    ...cards.map((card): Row => ({ at: card.createdAt, from: "board", card })),
    ...threads.map((thread): Row => ({ at: thread.updatedAt, from: "github", thread })),
  ].sort((a, b) => b.at - a.at);
  if (rows.length === 0) return <p className="pb note">{NO_INCOMING}</p>;
  return (
    <ul className="pb tlist" aria-label="Incoming cards">
      {rows.map((r) =>
        r.from === "board" ? (
          <li
            className="row"
            key={`${r.card.repoId}#${r.card.issueNumber}`}
            data-testid="incoming-row"
          >
            <Pill tone="plain">Board</Pill>
            <span className="s">{tz === null ? DASH : rel(r.at, now, tz)}</span>
            <Pill tone="neutral">{cardColumn(r.card)}</Pill>
            <RepoRef repoId={r.card.repoId} number={r.card.issueNumber} url={r.card.url} />
            <span className="min0 ellip">{r.card.title}</span>
          </li>
        ) : (
          <li className="row" key={r.thread.key} data-testid="incoming-row">
            <Pill tone="plain">GitHub</Pill>
            <span className="s">{tz === null ? DASH : rel(r.at, now, tz)}</span>
            <Pill tone="warn">Asked of you</Pill>
            {r.thread.number !== null && (
              <RepoRef repoId={r.thread.repoId} number={r.thread.number} url={r.thread.url} />
            )}
            <span className="min0 ellip">
              {whoOf(r.thread)} {r.thread.reasonText}: {r.thread.title}
            </span>
          </li>
        ),
      )}
    </ul>
  );
}
