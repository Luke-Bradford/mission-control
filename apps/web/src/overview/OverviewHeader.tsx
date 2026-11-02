import type { AttentionItem, OverviewSummary } from "@mc/core";
import { needsYouItems, openNeedsYou } from "../attention.ts";
import { useNow, useTz } from "../clock.ts";
import { hub, RESOURCES, streamStatus, useResource } from "../data.ts";
import { hhmm } from "../fmt.ts";
import { useSession } from "../shell/session.ts";
import { useStore } from "../shell/store.ts";

/** Source state and the existing attention inbox, without another collection or poll. */
export function OverviewHeader() {
  const [session] = useSession();
  const source = RESOURCES.overview(session);
  const summary = useResource<OverviewSummary>(source);
  const attention = useResource<AttentionItem[]>(RESOURCES.attention);
  const connection = useStore(streamStatus);
  const tz = useTz();
  const now = useNow();
  const stale = !!summary.data && (now - summary.data.at >= 120_000 || !!summary.error);
  const state = !connection.connected
    ? connection.reconnecting
      ? "Disconnected"
      : "Connecting"
    : summary.error
      ? "Refresh failed"
      : stale
        ? "Stale snapshot"
        : !summary.data
          ? "Loading current work"
          : "Connected";
  return (
    <header className="overview-heading">
      <div>
        <h1>What needs attention, and what comes next?</h1>
        <p className="s muted">
          {session === "all" ? "All sessions" : session} · current work first
          {summary.data && tz ? ` · read ${hhmm(summary.data.at, tz)}` : ""}
        </p>
      </div>
      <div className="overview-status">
        <span role="status" className={state === "Connected" ? "ok-t" : "warn-t"}>
          {state}
        </span>
        {attention.data ? (
          <button type="button" className="sm" onClick={openNeedsYou}>
            ◆ Needs you · {needsYouItems(attention.data).length}
          </button>
        ) : (
          <span className="s">
            {attention.error ? "Attention could not load" : "Loading attention…"}
          </span>
        )}
        {(summary.error || stale) && (
          <button type="button" className="sm" onClick={() => hub.refetch(source.path)}>
            Refresh overview
          </button>
        )}
      </div>
    </header>
  );
}
