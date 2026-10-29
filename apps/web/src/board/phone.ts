import { useSyncExternalStore } from "react";

/** Phone width: board.css's `@media (max-width: 760px)` block, which the board's column CSS shares. */
export const PHONE_QUERY = "(max-width: 760px)";

const query = (): MediaQueryList | null =>
  typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;

function subscribe(fn: () => void): () => void {
  const q = query();
  q?.addEventListener?.("change", fn);
  return () => q?.removeEventListener?.("change", fn);
}

/** True while the window is phone width; false where `matchMedia` is missing. */
export const usePhone = (): boolean =>
  useSyncExternalStore(subscribe, () => query()?.matches ?? false);
