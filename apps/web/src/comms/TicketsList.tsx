import type { BoardItem, RepoView } from "@mc/core";
import { useState } from "react";
import { RESOURCES, useResource, useResources } from "../data.ts";
import { commsTicketPath, followLink, navigate, ticketPath } from "../router.ts";

const NO_REPOS: RepoView[] = [];
/** The list shows this many matches; a longer search narrows it. */
const SHOWN = 40;

/** Whether a ticket matches the search text: its `repo#n`, title or status. */
export function ticketMatches(item: BoardItem, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${item.repoId}#${item.issueNumber} ${item.title} ${item.status}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * Comms's Tickets list: a search for when the number is not known. The ticket's number opens its
 * page; the small button beside it narrows the chat to that ticket's messages.
 */
export function TicketsList() {
  const repos = useResource<RepoView[]>(RESOURCES.repos).data ?? NO_REPOS;
  const boards = useResources<BoardItem[]>(repos.map((r) => RESOURCES.boards(r.id)));
  const [query, setQuery] = useState("");
  const all = boards.flatMap((b) => b.data ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  const found = all.filter((item) => ticketMatches(item, query));
  return (
    <section className="comms-tickets" aria-label="Tickets">
      <div className="comms-section-head">
        <h2>Tickets</h2>
        <span>{`${found.length} of ${all.length}`}</span>
      </div>
      <input
        type="search"
        className="comms-ticket-search"
        aria-label="Search tickets"
        placeholder="Search by number or text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {found.length === 0 ? (
        <p className="note">
          {query.trim() === "" ? "No tickets yet." : `No ticket matches “${query.trim()}”.`}
        </p>
      ) : (
        <ul className="comms-ticket-list">
          {found.slice(0, SHOWN).map((item) => {
            const ref = `${item.repoId}#${item.issueNumber}`;
            const href = ticketPath(item.repoId, item.issueNumber);
            return (
              <li key={ref}>
                <a
                  className="comms-ticket-open"
                  href={href}
                  aria-label={`Open ${ref}`}
                  onClick={(e) => followLink(e, href)}
                >
                  <b className="mono">{`#${item.issueNumber}`}</b>
                  <span className="comms-ticket-title">{item.title}</span>
                  <small>{item.status}</small>
                </a>
                <button
                  type="button"
                  className="comms-ticket-filter"
                  aria-label={`Show only messages about ${ref}`}
                  title="Show only the messages about this ticket"
                  onClick={() => navigate(commsTicketPath(`#${item.issueNumber}`, ref))}
                >
                  Chat
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {found.length > SHOWN && (
        <p className="note">{`Showing ${SHOWN} of ${found.length}. Type more to narrow it.`}</p>
      )}
    </section>
  );
}
