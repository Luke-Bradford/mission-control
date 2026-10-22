/** The Guard and Test lock KPI tiles' words (Telemetry, from `/api/guard/hits` and `/api/test-lock`). */
import { GUARD_RULES, type GuardRule } from "@mc/core";

export const GUARD_TILE_LABEL = "Guard";
export const LOCK_TILE_LABEL = "Test lock";
export const LOCK_TILE_FREE = "Free";
/** The Comms guard drawer's element id. */
export const GUARD_DRAWER_ID = "cGuard";
/** Where the Guard tile goes: the Comms guard drawer. */
export const GUARD_DRAWER_HREF = `/comms#${GUARD_DRAWER_ID}`;

export const GUARD_TILE_NONE = "blocked this week";

/** The rule with the most hits (the first listed on a tie); null when there are none. */
export function topGuardRule(
  counts: Partial<Record<GuardRule, number>>,
): { rule: GuardRule; count: number } | null {
  let top: { rule: GuardRule; count: number } | null = null;
  for (const rule of Object.keys(GUARD_RULES) as GuardRule[]) {
    const count = counts[rule] ?? 0;
    if (count > 0 && (top === null || count > top.count)) top = { rule, count };
  }
  return top;
}

export const guardTileDetail = (top: { rule: GuardRule; count: number } | null): string =>
  top === null ? GUARD_TILE_NONE : `blocked · most: ${top.rule} (${top.count})`;

export const lockHolderDetail = (elapsed: string, waiting: number): string =>
  `holds it · ${elapsed} · ${waiting} waiting`;
export const lockFreeDetail = (waiting: number): string => `${waiting} waiting`;
