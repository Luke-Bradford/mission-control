import type { AttentionItem } from "@mc/core";
import { mss } from "../fmt.ts";

/** Rows are cut here (catalogue 2.5.1). */
export const NEED_TEXT_MAX = 170;

/** Stalls read from the item's own `at` and `tool` on the 1 s clock; the server text is only "No output". */
export function needText(i: AttentionItem, now: number): string {
  if (i.kind !== "stalled") return i.text;
  return `${mss(now - i.at)} ${i.tool ? `in ${i.tool}` : "without output"}`;
}
