import type { AttentionItem, TestLockState } from "@mc/core";
import type { CcConfig } from "../config.ts";
import { attentionItems, NO_LOCK } from "../hud/hud.ts";
import type { Store } from "../store.ts";
import { questionAskAt } from "./holds.ts";

/** The line the Answered group shows for a question the operator settled by choosing an option. */
export const answeredReason = (label: string): string => `You chose: ${label}.`;

/**
 * Records that the operator answered this item's question, under each of its keys, so it leaves
 * Needs you and is listed under Answered whatever its repo. Returns whether any key was recorded.
 */
export function recordAnswered(
  store: Store,
  item: AttentionItem,
  keys: readonly string[],
  label: string,
  at: number,
): boolean {
  let recorded = false;
  for (const key of keys)
    recorded =
      store.closeQuestion({
        key,
        askAt: questionAskAt(item, item.brief),
        kind: "answered",
        reason: answeredReason(label),
        by: "operator",
        question: item.brief?.ask || item.text,
        ticket: item.ticket,
        operator: true,
        at,
      }) || recorded;
  return recorded;
}

/**
 * Records every item whose chosen option was applied but which still sits in Needs you (a choice
 * made before closures were written). Returns how many it recorded.
 */
export function closeAnsweredItems(d: {
  config: CcConfig;
  store: Store;
  now: number;
  lock?: TestLockState;
}): number {
  const { config, store, now } = d;
  let closed = 0;
  for (const item of attentionItems(config, store, now, d.lock ?? NO_LOCK, undefined, null, true)) {
    const choice = item.brief?.choice;
    if (choice?.state !== "applied") continue;
    const label = item.brief?.options.find((o) => o.id === choice.optionId)?.label;
    if (
      label !== undefined &&
      recordAnswered(store, item, [item.key], label, choice.completedAt ?? now)
    )
      closed++;
  }
  return closed;
}
