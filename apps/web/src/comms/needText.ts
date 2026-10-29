import type { AttentionItem } from "@mc/core";
import { mss } from "../fmt.ts";

export const NEED_TEXT_MAX = 170;

export function needText(item: AttentionItem, now: number): string {
  if (item.kind !== "stalled") return item.text;
  return `${mss(now - item.at)} ${item.tool ? `in ${item.tool}` : "without output"}`;
}
