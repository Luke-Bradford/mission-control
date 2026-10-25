import { useSecond } from "../clock.ts";
import { streamStatus } from "../data.ts";
import { useStore } from "./store.ts";

/** Connection state and observable message age; quiet open streams remain connected. */
export function LiveIndicator() {
  const { connected, reconnecting, lastMessageAt } = useStore(streamStatus);
  const now = useSecond();
  const age = lastMessageAt === null ? null : Math.max(0, now - lastMessageAt);
  const state = connected ? "fresh" : reconnecting ? "down" : "connecting";
  const text = connected
    ? age === null
      ? "—"
      : `${Math.floor(age / 1000)}s`
    : reconnecting
      ? "reconnecting"
      : "connecting";
  return (
    <span className={`live-indicator num ${state}`} title="Age of the last SSE message">
      <i aria-hidden="true" />
      LIVE · {text}
    </span>
  );
}
