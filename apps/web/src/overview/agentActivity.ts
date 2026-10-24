import type { AttentionItem, CrewRow, RunDigest } from "@mc/core";
import { isSeatFree, seatItems } from "../crew.ts";

export const ACTIVITY_MINUTES = 120;
export const ACTIVITY_MS = ACTIVITY_MINUTES * 60_000;

/** Minute buckets end at the panel clock, never at an individual agent's last burst. */
export function activityValues(digest: RunDigest | null, now: number): number[] {
  const end = Math.floor(now / 60_000) * 60_000;
  const buckets = new Map(digest?.minuteTokens ?? []);
  return Array.from(
    { length: ACTIVITY_MINUTES },
    (_, i) => buckets.get(end - (ACTIVITY_MINUTES - 1 - i) * 60_000) ?? 0,
  );
}

export const age = (at: number, now: number): string =>
  `${Math.max(0, Math.floor((now - at) / 60_000))}m`;

export function attentionOrder(rows: CrewRow[], items: AttentionItem[]): CrewRow[] {
  const rank = (r: CrewRow): number => {
    if (
      seatItems(r, items).some((i) => i.owner === "operator" || i.owner === undefined) ||
      r.hudState === "error" ||
      r.hudState === "stalled"
    )
      return 0;
    if (["blocked", "parked"].includes(r.hudState) || r.loop?.phase === "parked") return 1;
    if (r.hudState === "running") return 2;
    if (
      r.hudState === "waiting" ||
      (!isSeatFree(r) && (r.loop?.phase === "ci" || r.loop?.phase === "review"))
    )
      return 3;
    return 4;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.index - b.index);
}
