import type { FlightIncomingView } from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { githubHref } from "../links.ts";
import { useSessionScope } from "../shell/session.ts";
import { Pending } from "./Pending.tsx";

const DASH = "—";
export const NO_INCOMING = "Nothing has arrived yet.";

/** Recorded arrival outcomes, independent of the card's current column. */
export function Incoming() {
  const { data, error } = useResource<FlightIncomingView>(RESOURCES.flightIncoming);
  const { inRepo, session } = useSessionScope();
  const now = useSecond();
  const tz = useTz();
  if (error)
    return (
      <p className="pb note err" role="alert">
        {error.message}
      </p>
    );
  if (!data) return <Pending what="arrivals" error={null} resource={RESOURCES.flightIncoming} />;
  const rows = data.entries
    .map((entry) => {
      const { repoId, sourceRef } = entry;
      const url = sourceRef?.url;
      let href = sourceRef && sourceRef.kind !== "teams" ? githubHref(sourceRef.url) : null;
      if (sourceRef?.kind === "teams" && url) {
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
            <Pill tone="plain">{entry.sourceRef?.kind === "teams" ? "Teams" : entry.source}</Pill>
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
