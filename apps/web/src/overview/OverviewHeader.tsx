import type { AttentionItem, OverviewSummary } from "@mc/core";
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
  const healthy = state === "Connected" && !attention.error;
  return (
    <>
      <h1 className="sr-only">Overview</h1>
      {!healthy && (
        <header className="overview-status">
          <span role="status" className="warn-t">
            {state}
          </span>
          {summary.data && tz && (
            <span className="s muted">Last read {hhmm(summary.data.at, tz)}</span>
          )}
          {attention.error && <span className="s">Attention could not load</span>}
          {(summary.error || stale) && (
            <button type="button" className="sm" onClick={() => hub.refetch(source.path)}>
              Refresh overview
            </button>
          )}
        </header>
      )}
    </>
  );
}
