import { useSecond } from "../clock.ts";
import { streamStatus } from "../data.ts";
import { useDemo } from "../demo/mode.ts";
import { useStore } from "./store.ts";

/** Connection state and observable message age; quiet open streams remain connected. */
export function LiveIndicator() {
  const { connected, reconnecting, lastMessageAt } = useStore(streamStatus);
  const demo = useDemo();
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
    <span
      className={`live-indicator num ${state}`}
      title={demo ? "Age of the last simulated message" : "Age of the last SSE message"}
    >
      <i aria-hidden="true" />
      {demo ? "DEMO" : "LIVE"} · {text}
    </span>
  );
}
