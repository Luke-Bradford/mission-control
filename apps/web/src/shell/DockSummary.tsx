import { openNeedsYou, useNeedsCount } from "../attention.ts";
import { hub, RESOURCES, streamStatus } from "../data.ts";
import { Pill } from "../hud/Pill.tsx";
import { useStore } from "./store.ts";

/** One line that opens Needs you: how many open questions wait on the operator. */
function NeedsLine() {
  const { state, n } = useNeedsCount();
  if (state !== "ready" || n === null)
    return state === "error" ? (
      <p className="note err" role="alert">
        Open questions could not load.{" "}
        <button type="button" className="sm" onClick={() => hub.refetch(RESOURCES.attention.path)}>
          Retry
        </button>
      </p>
    ) : (
      <p className="note">Loading open questions…</p>
    );
  const words =
    n === 0 ? "No questions wait" : n === 1 ? "1 question waits" : `${n} questions wait`;
  return (
    <button
      type="button"
      className={n > 0 ? "dock-needs warn" : "dock-needs"}
      onClick={openNeedsYou}
    >
      <span>{words}</span>
      <span className="fg2">Open Needs you →</span>
    </button>
  );
}

/**
 * The fly-out holds the conversation only: this strip is the connection state and the one line to
 * Needs you. The waiting list and FLIGHT's headline are on those pages.
 */
export function DockSummary() {
  const connection = useStore(streamStatus);
  return (
    <section className="dock-summary" aria-label="Needs you and connection">
      {!connection.connected && (
        <div className="dock-summary-state s" aria-live="polite">
          <Pill tone="warn">{connection.reconnecting ? "Disconnected" : "Connecting"}</Pill>
          {connection.reconnecting && (
            <span className="note s">Showing the last received messages.</span>
          )}
        </div>
      )}
      <NeedsLine />
    </section>
  );
}
