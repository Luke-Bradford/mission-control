import type { AttentionHold } from "@mc/core";
import type { Store } from "../store.ts";

/** The setting that keeps the operator's and FLIGHT's holds on Needs-you items. */
export const ATTENTION_HOLDS_SETTING = "attention-holds";

/** The stored holds by item key (the reader alone, so a caller need not load the HUD). */
export function holds(store: Store): Record<string, AttentionHold> {
  // null prototype, so a key such as `__proto__` is an ordinary entry
  return Object.assign(
    Object.create(null),
    JSON.parse(store.getSetting(ATTENTION_HOLDS_SETTING) ?? "{}"),
  );
}
