import { useMemo } from "react";
import { useNow, useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { plural, rel } from "../fmt.ts";
import { followLink } from "../router.ts";
import type { RailEdgeView } from "./CommsRails.tsx";
import { commsHrefFor } from "./chartPaths.ts";
import { type FeedMessage, waitWord } from "./chartTypes.ts";
import { type ChartFilter, filterKeeps, filterLabel } from "./commsFilter.ts";
import { canonicalEndpoint } from "./useChartData.ts";

const SHOWN = 15;

/** The feed as the hub sends it, kept to rows that have every field (an older hub sends none). */
function readFeed(body: unknown): FeedMessage[] | undefined {
  const list = (body as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(list)) return undefined;
  return list.filter(
    (m): m is FeedMessage =>
      typeof m?.id === "string" &&
      typeof m.from === "string" &&
      typeof m.to === "string" &&
      typeof m.at === "number" &&
      typeof m.text === "string",
  );
}

/**
 * The full-screen view has no chat beside it, so a filtered chart gets this: what is waiting in the
 * conversation, its recent messages, and a link that opens it in Comms.
 */
export function ChartPane({
  filter,
  flight,
  edges,
  nameOf,
}: {
  filter: ChartFilter;
  flight: string;
  edges: readonly RailEdgeView[];
  nameOf: (id: string) => string;
}) {
  const feedResource = useResource<{ messages: unknown }>(RESOURCES.commsFeed);
  const feed = useMemo(() => readFeed(feedResource.data), [feedResource.data]);
  const now = useNow();
  const tz = useTz();
  const mine = edges.filter((e) => filterKeeps(filter, e.a, e.b));
  const waiting = mine.filter((e) => e.waiting !== null);
  const messages = useMemo(() => {
    if (feed === undefined) return undefined;
    return feed
      .filter((m) =>
        filterKeeps(filter, canonicalEndpoint(m.from, flight), canonicalEndpoint(m.to, flight)),
      )
      .sort((a, b) => b.at - a.at)
      .slice(0, SHOWN);
  }, [feed, filter, flight]);
  // Without the feed (an older hub), each link's newest message is what there is to show.
  const newest = mine.flatMap((e) => (e.last ? [e.last] : [])).sort((a, b) => b.at - a.at);
  const href = commsHrefFor(filter, flight);
  const when = (at: number) => (tz ? rel(at, now, tz) : "—");

  return (
    <aside className="comms-chart-pane" aria-label={`Conversation: ${filterLabel(filter, nameOf)}`}>
      <h2 className="comms-pane-title">{filterLabel(filter, nameOf)}</h2>
      <a className="comms-pane-open" href={href} onClick={(e) => followLink(e, href)}>
        Open in Comms →
      </a>
      {waiting.length > 0 && (
        <section aria-label="Waiting">
          <h3>Waiting</h3>
          <ul>
            {waiting.map((e) => (
              <li key={e.key} className="comms-pane-wait">
                <b>
                  {e.waiting ? nameOf(e.waiting.asker) : ""} waiting{" "}
                  {e.waiting ? waitWord(e.waiting.ms) : ""}
                  {e.waiting && e.waiting.n > 1 ? ` · ${e.waiting.n} open` : ""}
                </b>
                <span className="comms-pane-meta">
                  {nameOf(e.a)} ↔ {nameOf(e.b)}
                </span>
                {e.waiting?.question && <q>{e.waiting.question}</q>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Recent messages">
        <h3>Recent messages</h3>
        {messages === undefined && feedResource.error === null && (
          <p className="comms-pane-note">Loading messages…</p>
        )}
        {messages === undefined && feedResource.error !== null && newest.length === 0 && (
          <p className="comms-pane-note" role="status">
            This hub does not send the message feed yet, so only link counts show here.
          </p>
        )}
        {(messages ?? []).length === 0 && messages !== undefined && (
          <p className="comms-pane-note">No messages in this conversation in the last 24h.</p>
        )}
        <ul>
          {(
            messages ??
            newest.map((m, i) => ({
              id: `last-${i}`,
              from: m.from,
              to: m.to,
              at: m.at,
              text: m.text,
            }))
          ).map((m) => (
            <li key={m.id} className="comms-pane-msg">
              <span className="comms-pane-meta">
                {nameOf(canonicalEndpoint(m.from, flight))} →{" "}
                {nameOf(canonicalEndpoint(m.to, flight))} · {when(m.at)}
              </span>
              <q>{m.text}</q>
            </li>
          ))}
        </ul>
        {messages !== undefined && messages.length === SHOWN && (
          <p className="comms-pane-note">
            Newest {plural(SHOWN, "message")}. The rest are in Comms.
          </p>
        )}
      </section>
    </aside>
  );
}
