import { useSecond } from "../clock.ts";
import { streamStatus } from "../data.ts";
import { useStore } from "./store.ts";

/** Freshness of observable SSE messages; server heartbeat comments are invisible to EventSource. */
export function LiveIndicator() {
  const { connected, lastMessageAt } = useStore(streamStatus);
  const now = useSecond();
  const age = lastMessageAt === null ? null : Math.max(0, now - lastMessageAt);
  const state = !connected ? "down" : age === null || age > 15_000 ? "stale" : "fresh";
  const text = !connected ? "reconnecting" : age === null ? "—" : `${Math.floor(age / 1000)}s`;
  return (
    <span className={`live-indicator num ${state}`} title="Age of the last SSE message">
      <i aria-hidden="true" />
      LIVE · {text}
    </span>
  );
}
