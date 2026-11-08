import type { FlightSummaryView } from "@mc/core";
import { hub, RESOURCES, streamStatus, useResource } from "../data.ts";
import { Pill } from "../hud/Pill.tsx";
import { followLink } from "../router.ts";
import { markMentionsSeen, mentionPath, useOperatorUnread } from "./operatorMessages.ts";
import { useStore } from "./store.ts";

/** The existing attention order and read-only headline; no second queue or decision store. */
export function DockSummary({ canMessage }: { canMessage: boolean }) {
  const summary = useResource<FlightSummaryView>(RESOURCES.flightSummary);
  const connection = useStore(streamStatus);
  const stale = (summary.data?.headlineAgeMin ?? 0) >= 60;
  const headline = summary.data?.headline;
  const unread = useOperatorUnread();
  return (
    <section className="dock-summary scroll" aria-label="FLIGHT summary">
      <div className="dock-summary-state s" aria-live="polite">
        {!connection.connected && (
          <Pill tone="warn">{connection.reconnecting ? "Disconnected" : "Connecting"}</Pill>
        )}
        {stale && <Pill tone="warn">Stale headline · {summary.data?.headlineAgeMin} min old</Pill>}
      </div>
      {!connection.connected && connection.reconnecting && (
        <p className="note s">Showing the last received summary. Reconnect to refresh it.</p>
      )}
      {summary.error ? (
        <p className="note err" role="alert">
          FLIGHT summary could not refresh.{" "}
          <button
            type="button"
            className="sm"
            onClick={() => hub.refetch(RESOURCES.flightSummary.path)}
          >
            Retry summary
          </button>
        </p>
      ) : null}
      {headline && headline.length <= 140 ? (
        <p className="dock-headline-text">{headline}</p>
      ) : headline ? (
        <details className="dock-headline">
          <summary>
            <span>{headline.length > 140 ? `${headline.slice(0, 140)}…` : headline}</span>
            <span className="s fg2">Read headline</span>
          </summary>
          <p>{headline}</p>
        </details>
      ) : (
        <p className="note">
          {summary.data === undefined
            ? summary.error
              ? "The last headline is unavailable."
              : "Loading FLIGHT's headline…"
            : summary.data.session === null
              ? "No FLIGHT seat is configured."
              : "FLIGHT has not recorded a headline."}
        </p>
      )}
      {unread.length > 0 && (
        <div className="dock-messages" id="dockMessages">
          <h3>Messages to you · {unread.length}</h3>
          {unread.slice(0, 3).map((m) => (
            <a
              key={m.message.id}
              href={mentionPath(m)}
              className="dock-message"
              onClick={(e) => {
                void markMentionsSeen([m.message.id]);
                followLink(e, mentionPath(m));
              }}
            >
              <b>{m.message.from}</b> <span title={m.message.text}>{m.message.text}</span>
            </a>
          ))}
          <button
            type="button"
            className="sm"
            onClick={() => void markMentionsSeen(unread.map((m) => m.message.id))}
          >
            Mark all read
          </button>
        </div>
      )}
      <div className="dock-next">
        <p className="note">
          {canMessage
            ? "Message FLIGHT below, or open its full view."
            : "Open FLIGHT's full view to check its status."}
        </p>
        <a href="/flight">Open FLIGHT's full view</a>
      </div>
    </section>
  );
}
