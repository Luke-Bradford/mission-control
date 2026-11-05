import { ATTENTION_LABEL, type AttentionItem, type Crew, type FlightSummaryView } from "@mc/core";
import { openNeed, openNeedsYou, youAction } from "../attention.ts";
import type { Resource } from "../data.ts";
import { hub, RESOURCES, streamStatus, useResource } from "../data.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { useStore } from "./store.ts";

/** The existing attention order and read-only headline; no second queue or decision store. */
export function DockSummary({
  asks,
  attention,
  crew,
  canMessage,
}: {
  asks: readonly AttentionItem[];
  attention: Resource<AttentionItem[]>;
  crew: Crew | undefined;
  canMessage: boolean;
}) {
  const summary = useResource<FlightSummaryView>(RESOURCES.flightSummary);
  const connection = useStore(streamStatus);
  const stale = (summary.data?.headlineAgeMin ?? 0) >= 60;
  const headline = summary.data?.headline;
  const first = asks[0];
  const open = openNeed;
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
      {attention.error && (
        <p className="note err" role="alert">
          Waiting items could not refresh.{" "}
          <button
            type="button"
            className="sm"
            onClick={() => hub.refetch(RESOURCES.attention.path)}
          >
            Retry waiting items
          </button>
        </p>
      )}
      <div className="dock-waiting" id="dockWaiting">
        <h3 className="dwh">
          {attention.data === undefined
            ? attention.error
              ? "Waiting items are unavailable."
              : "Loading waiting items…"
            : `Waiting on you · ${asks.length}`}
        </h3>
        {attention.data !== undefined && asks.length === 0 && (
          <p className="note">Nothing is waiting for your decision.</p>
        )}
        {asks.slice(0, 3).map((item) => {
          const agent = crew?.rows.find((row) => row.id === item.agentId);
          return (
            <div className="dock-summary-item" key={item.key} data-testid="waiting-ask">
              <div className="row">
                <Pill tone={item.kind === "decision" ? "warn" : "plain"}>
                  {item.notTriaging ? "FLIGHT" : ATTENTION_LABEL[item.kind]}
                </Pill>
                {agent ? (
                  <AgentTag bare sm id={agent.id} index={agent.index} />
                ) : (
                  <span className="s">{item.agentId}</span>
                )}
              </div>
              <p className="dock-item-reason" title={item.text}>
                {item.text}
              </p>
              <button
                type="button"
                className="sm"
                aria-label={`Open: ${item.text}`}
                onClick={() => open(item)}
              >
                {item.notTriaging ? "Show them" : "Open"}
              </button>
            </div>
          );
        })}
        {asks.length > 3 && (
          <button type="button" className="sm" onClick={openNeedsYou}>
            View all {asks.length} waiting items
          </button>
        )}
      </div>
      <div className="dock-next">
        <h3>Next action</h3>
        {first ? (
          <button type="button" className="sm" onClick={() => open(first)}>
            {first.notTriaging
              ? "Review items waiting for FLIGHT"
              : `${youAction(first)} · ${ATTENTION_LABEL[first.kind]}`}
          </button>
        ) : attention.data === undefined ? (
          <p className="note">Waiting items are not available yet.</p>
        ) : (
          <p className="note">
            {canMessage
              ? "No operator action is waiting. Message FLIGHT below, or open its full view."
              : "No operator action is waiting. Open FLIGHT's full view to check its status."}
          </p>
        )}
        <a href="/flight">Open FLIGHT's full view</a>
      </div>
    </section>
  );
}
