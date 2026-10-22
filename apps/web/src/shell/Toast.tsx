import { store, useStore } from "./store.ts";

/** How long a toast stays (catalogue §1.3). */
const TOAST_MS = 5200;

const message = store<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

/** Show `msg` bottom-left, replacing any toast already showing. */
export function toast(msg: string): void {
  clearTimeout(timer);
  message.set(msg);
  timer = setTimeout(() => message.set(null), TOAST_MS);
}

export function clearToast(): void {
  clearTimeout(timer);
  message.set(null);
}

/**
 * The status line: always mounted and never `hidden` (a live region outside the accessibility tree
 * can miss its first message); hud.css hides it visually while it is empty.
 */
export function Toast() {
  const msg = useStore(message);
  return (
    <div id="toast" role="status">
      {msg}
    </div>
  );
}
