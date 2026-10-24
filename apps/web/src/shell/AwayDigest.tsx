import { type AwaySettings, awayIsOn, type AwayDigest as Digest } from "@mc/core";
import { type ReactNode, useState } from "react";
import { useNow, useTz } from "../clock.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { hub, RESOURCES, useResource } from "../data.ts";
import { draftRowId } from "../flight/Drafts.tsx";
import { Panel } from "../hud/Panel.tsx";
import { parseTicket } from "../hud/RepoRef.tsx";
import { followLink, itemPath, ticketPath } from "../router.ts";
import { AWAY_DIGEST_KEY, readKey, writeKey } from "../storage.ts";

const LABELS = [
  "need you now",
  "safe PRs ready for review",
  "drafts to walk through",
  "failed, with the reason",
  "decisions FLIGHT made, with reasons",
  "messages drafted for you",
];

/** The latest away period belongs to the hub; acknowledgment belongs to this viewer. */
export function AwayDigest({ children = null }: { children?: ReactNode }) {
  const away = useResource<AwaySettings>(RESOURCES.away).data;
  const digest = useResource<Digest>(RESOURCES.awayDigest()).data;
  const tz = useTz();
  const now = useNow();
  const [acknowledged, setAcknowledged] = useState(() => readKey(AWAY_DIGEST_KEY));
  const [openedItem, setOpenedItem] = useState<number | null>(null);
  const started = digest?.startedAt;
  if (
    !away ||
    !tz ||
    !started ||
    awayIsOn(away, now, tz) ||
    acknowledged === String(started) ||
    openedItem === started
  )
    return children;
  return (
    <ReturnDigest
      started={started}
      openItem={() => setOpenedItem(started)}
      acknowledge={() => {
        writeKey(AWAY_DIGEST_KEY, String(started));
        setAcknowledged(String(started));
      }}
    />
  );
}

function ReturnDigest({
  started,
  acknowledge,
  openItem,
}: {
  started: number;
  acknowledge: () => void;
  openItem: () => void;
}) {
  const resource = RESOURCES.awayDigest(String(started));
  const { data, error } = useResource<Digest>(resource);
  const groups = data?.groups.map<{ key: string; href: string; text: string; reason?: string }[]>(
    (group) => {
      switch (group.kind) {
        case "needYouNow":
          return group.items.map((i) => ({ key: i.key, href: itemPath(i.key), text: i.text }));
        case "safePrsReady":
        case "draftsToWalkThrough":
          return group.items.map((p) => ({
            key: `${p.repoId}#${p.number}`,
            href: p.url,
            text: p.title,
          }));
        case "failures":
          return group.items.map((r) => ({
            key: r.runId,
            href: relatedTicket(r.ticket),
            text: `${r.ticket ?? r.runId}: ${r.reason}`,
          }));
        case "flightDecisions":
          return group.items.map((d) => ({
            key: String(d.id),
            href: relatedTicket(d.ref ?? d.about),
            text: `${d.about}: ${d.decision}`,
            reason: d.basis,
          }));
        case "messagesDrafted":
          return group.items.map((d) => ({
            key: String(d.id),
            href: `/flight#${draftRowId(d.id, d.target)}`,
            text: `${d.target}: ${d.text}`,
          }));
      }
      return [];
    },
  );
  return (
    <Panel
      title="When you come back"
      sub="One digest, most urgent first."
      className="away-digest"
      actions={
        data && (
          <button type="button" className="sm" onClick={acknowledge}>
            Acknowledge digest
          </button>
        )
      }
    >
      <div className="pb">
        {error ? (
          <p role="alert">
            Could not load the away digest.{" "}
            <button type="button" onClick={() => hub.refetch(resource.path)}>
              Retry
            </button>
          </p>
        ) : !groups ? (
          <p>Loading away digest…</p>
        ) : (
          <div className="stats">
            {groups.map((items, index) => (
              <div className="stat2" key={LABELS[index]}>
                <b>{items.length}</b>
                <h3>{LABELS[index]}</h3>
                {items.length === 0 ? (
                  <span>None</span>
                ) : (
                  <ul className="rules">
                    {items.map((item) => (
                      <li key={item.key}>
                        {item.href.startsWith("/") ? (
                          <a
                            href={item.href}
                            onClick={(event) => {
                              followLink(event, item.href);
                              if (
                                !event.metaKey &&
                                !event.ctrlKey &&
                                !event.shiftKey &&
                                event.button === 0
                              )
                                openItem();
                            }}
                          >
                            {item.text}
                          </a>
                        ) : (
                          <ExternalLink url={item.href}>{item.text}</ExternalLink>
                        )}
                        {item.reason && <p className="s fg2">{item.reason}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

function relatedTicket(ref: string | null): string {
  const ticket = ref ? parseTicket(ref) : null;
  return ticket ? ticketPath(ticket.repoId, ticket.number) : "/flight";
}
