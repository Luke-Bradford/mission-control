import type { FlightIncomingView, RepoView } from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { githubHref, githubItemHref } from "../links.ts";
import type { NotificationsView } from "../notifications.ts";
import { useSessionScope } from "../shell/session.ts";

const DASH = "—";
const NO_REPOS: RepoView[] = [];
export const NO_INCOMING = "Nothing has arrived yet.";

/** Recorded arrival outcomes, independent of the card's current column. */
export function Incoming() {
  const { data, error } = useResource<FlightIncomingView>(RESOURCES.flightIncoming);
  const repos = useResource<RepoView[]>(RESOURCES.repos).data ?? NO_REPOS;
  const notes = useResource<NotificationsView>(RESOURCES.notifications).data;
  const { inRepo, session } = useSessionScope();
  const now = useSecond();
  const tz = useTz();
  if (error)
    return (
      <p className="pb note err" role="alert">
        {error.message}
      </p>
    );
  if (!data) return <p className="pb note">{DASH}</p>;
  const rows = data.entries
    .map((entry) => {
      const match = /^(.*)#(\d+)$/.exec(entry.arrivalId);
      const thread = [...(notes?.open ?? []), ...(notes?.handledToday ?? [])].find(
        (t) => t.id === entry.arrivalId,
      );
      const repoId = match?.[1] ?? thread?.repoId;
      const repo = repos.find((r) => r.id === repoId);
      const number = match?.[2] ?? thread?.number;
      const url =
        thread && "url" in thread
          ? thread.url
          : repo && number
            ? githubItemHref(repo.github, "issue", Number(number))
            : undefined;
      let href = url ? githubHref(url) : null;
      if (entry.source === "Teams" && url) {
        try {
          const source = new URL(url);
          if (
            source.protocol === "https:" &&
            source.hostname === "teams.microsoft.com" &&
            !source.username &&
            !source.password
          )
            href = source.href;
        } catch {
          /* An invalid source stays plain text. */
        }
      }
      return { entry, repoId, url: href };
    })
    .filter((r) => (r.repoId ? inRepo(r.repoId) : session === "all"))
    .sort((a, b) => b.entry.arrivedAt - a.entry.arrivedAt);
  if (!rows.length) return <p className="pb note">{NO_INCOMING}</p>;
  return (
    <ul className="pb tlist" aria-label="Incoming arrivals">
      {rows.map(({ entry, url }) => (
        <li className="incoming-row" key={entry.id} data-testid="incoming-row">
          <div className="row">
            <Pill tone="plain">{entry.source}</Pill>
            <span className="s">{tz === null ? DASH : rel(entry.arrivedAt, now, tz)}</span>
            <Pill
              tone={
                entry.outcome === "Assigned"
                  ? "ok"
                  : ["Asked of you", "Raised to you", "Watching"].includes(entry.outcome)
                    ? "warn"
                    : "plain"
              }
            >
              {entry.outcome}
            </Pill>
          </div>
          <div>
            {url ? (
              <a href={url} target="_blank" rel="noreferrer">
                {entry.text}
              </a>
            ) : (
              entry.text
            )}
          </div>
          <div className="s fg2">{entry.detail}</div>
        </li>
      ))}
    </ul>
  );
}
