import type { BoardItem, CommsTicketCounts, RepoView } from "@mc/core";
import { useState } from "react";
import { RESOURCES, useResource, useResources } from "../data.ts";
import { plural } from "../fmt.ts";
import { commsTicketPath, followLink, navigate, ticketPath } from "../router.ts";

const NO_REPOS: RepoView[] = [];
/** The list shows this many matches; a longer search narrows it. */
const SHOWN = 40;

/** One row: a ticket that has stored messages, with its all-time message count. */
interface TicketRow {
  ref: string;
  repoId: string;
  issueNumber: number;
  /** The board's title, else the reference itself for a ticket on no loaded board. */
  title: string;
  status: string;
  messages: number;
}

/** Whether a row matches the search text: its `repo#n`, title or status. */
export function ticketMatches(row: TicketRow, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${row.ref} ${row.title} ${row.status}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The tickets with stored messages, joined to their board cards; a ticket with none is left out. */
export function ticketRows(counts: CommsTicketCounts, boards: BoardItem[]): TicketRow[] {
  const card = new Map(boards.map((b) => [`${b.repoId}#${b.issueNumber}`, b]));
  return counts.tickets
    .filter((t) => t.count > 0)
    .flatMap((t) => {
      const m = /^([^#]+)#([1-9]\d*)$/.exec(t.ticket);
      if (!m) return [];
      const item = card.get(t.ticket);
      return [
        {
          ref: t.ticket,
          repoId: m[1] as string,
          issueNumber: Number(m[2]),
          title: item?.title ?? t.ticket,
          status: item?.status ?? "",
          messages: t.count,
        },
      ];
    })
    .sort(
      (a, b) =>
        (card.get(b.ref)?.updatedAt ?? 0) - (card.get(a.ref)?.updatedAt ?? 0) ||
        b.messages - a.messages,
    );
}

/**
 * Comms's Tickets list: the tickets that have messages, each with its message count, and a search
 * for when the number is not known. The ticket's number opens its page; the small button beside it
 * narrows the chat to that ticket's messages.
 */
export function TicketsList() {
  const reposRes = useResource<RepoView[]>(RESOURCES.repos);
  const repos = reposRes.data ?? NO_REPOS;
  const boards = useResources<BoardItem[]>(repos.map((r) => RESOURCES.boards(r.id)));
  const countsRes = useResource<CommsTicketCounts>(RESOURCES.commsTicketCounts);
  const [query, setQuery] = useState("");
  const rows = countsRes.data
    ? ticketRows(
        countsRes.data,
        boards.flatMap((b) => b.data ?? []),
      )
    : [];
  const found = rows.filter((row) => ticketMatches(row, query));
  // nothing is counted or called empty until every read has answered, one way or the other
  const waiting =
    (reposRes.data === undefined && !reposRes.error) ||
    boards.some((b) => !b.data && !b.error) ||
    (countsRes.data === undefined && !countsRes.error);
  const reposFailed = reposRes.error && !reposRes.data;
  const countsFailed = countsRes.error && !countsRes.data;
  const failedBoards = repos.filter((_, i) => boards[i]?.error && !boards[i]?.data);
  const staleBoards = repos.filter((_, i) => boards[i]?.error && boards[i]?.data);
  const alerts: string[] = [
    ...(reposRes.error
      ? [
          reposRes.data
            ? "Could not read repositories. These tickets may be out of date."
            : "Could not read repositories.",
        ]
      : []),
    ...(countsFailed ? ["Could not read message counts."] : []),
    ...(countsRes.error && countsRes.data
      ? ["Could not refresh message counts; these tickets may be out of date."]
      : []),
    ...failedBoards.map((r) => `Could not read the board for ${r.id}.`),
    ...staleBoards.map(
      (r) => `Could not refresh the board for ${r.id}; these tickets may be out of date.`,
    ),
  ];
  const showList = !reposFailed && !countsFailed;
  return (
    <section className="comms-tickets" aria-label="Tickets">
      <div className="comms-section-head">
        <h2>Tickets</h2>
        {!waiting && showList && <span>{`${found.length} of ${rows.length}`}</span>}
      </div>
      <input
        type="search"
        className="comms-ticket-search"
        aria-label="Search tickets"
        placeholder="Search by number or text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {alerts.map((text) => (
        <p key={text} className="note crit-t" role="alert">
          {text}
        </p>
      ))}
      {!showList ? null : waiting ? (
        <p className="note">Loading tickets…</p>
      ) : found.length === 0 ? (
        <p className="note">
          {query.trim() === ""
            ? "No ticket has messages yet."
            : `No ticket matches “${query.trim()}”.`}
        </p>
      ) : (
        <ul className="comms-ticket-list">
          {found.slice(0, SHOWN).map((row) => {
            const href = ticketPath(row.repoId, row.issueNumber);
            return (
              <li key={row.ref}>
                <a
                  className="comms-ticket-open"
                  href={href}
                  aria-label={`Open ${row.ref}: ${row.title}`}
                  onClick={(e) => followLink(e, href)}
                >
                  <b className="mono">{`#${row.issueNumber}`}</b>
                  <span className="comms-ticket-title" title={row.title}>
                    {row.title}
                  </span>
                  <small>
                    {row.status ? `${row.status} · ` : ""}
                    <span>{plural(row.messages, "message")}</span>
                  </small>
                </a>
                <button
                  type="button"
                  className="comms-ticket-filter"
                  aria-label={`Show only messages about ${row.ref}`}
                  title="Show only the messages about this ticket"
                  onClick={() => navigate(commsTicketPath(`#${row.issueNumber}`, row.ref))}
                >
                  Chat
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {showList && found.length > SHOWN && (
        <p className="note">{`Showing ${SHOWN} of ${found.length}. Type more to narrow it.`}</p>
      )}
    </section>
  );
}
