import {
  DEFAULT_PACE,
  PACE_NOTE_MAX,
  PACE_SETTING,
  type PaceCheck,
  type PaceSettings,
  type PaceView,
  paceIsOn,
} from "@mc/core";
import { z } from "zod";
import type { CcConfig } from "./config.ts";
import type { Store } from "./store.ts";

/** A full PaceSettings. `until` is the end time; the server sets `since` when it is switched on. */
export const PaceBody = z.strictObject({
  on: z.boolean(),
  until: z.number().int().nonnegative(),
  since: z.number().int().nonnegative(),
  labels: z.array(z.string().min(1).max(100)).max(20),
  maxStarts: z.number().int().min(0).max(50),
  note: z.string().max(PACE_NOTE_MAX),
}) satisfies z.ZodType<PaceSettings>;

/** What the operator sends: everything but `since`, which the server sets. */
export const PaceInput = PaceBody.omit({ since: true });

export const PACE_CORRUPT_LOG = "Invalid pace settings: running at normal pace.";
const warnedStores = new WeakSet<Store>();

/** Missing or unreadable means normal: only the operator's saved setting ever slows the crew. */
export function readPaceSettings(store: Store): PaceSettings {
  const raw = store.getSetting(PACE_SETTING);
  if (raw === null) return DEFAULT_PACE;
  try {
    const parsed = PaceBody.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    /* falls through to normal */
  }
  if (!warnedStores.has(store)) {
    warnedStores.add(store);
    console.warn(PACE_CORRUPT_LOG);
  }
  return DEFAULT_PACE;
}

export function activePace(store: Store, now: number): PaceSettings | null {
  const settings = readPaceSettings(store);
  return paceIsOn(settings, now) ? settings : null;
}

/** The ids of every crew seat; runs by anything else (an observed loop) do not count as starts. */
const crewSeatIds = (config: CcConfig): string[] =>
  (config.crew?.sessions ?? []).flatMap((s) => s.seats.map((x) => x.id));

export const paceStartsLeft = (store: Store, config: CcConfig, p: PaceSettings): number =>
  Math.max(0, p.maxStarts - store.ticketsStartedSince(p.since, crewSeatIds(config)));

/** The start check's pace input; undefined at normal pace, so nothing is held. */
export function paceStartCheck(store: Store, config: CcConfig, now: number): PaceCheck | undefined {
  const p = activePace(store, now);
  return p
    ? { labels: p.labels, startsLeft: paceStartsLeft(store, config, p), note: p.note }
    : undefined;
}

/** What the Overview shows while it is on; null at normal pace. */
export function paceView(store: Store, config: CcConfig, now: number): PaceView | null {
  const p = activePace(store, now);
  if (!p) return null;
  return {
    note: p.note,
    until: p.until,
    labels: p.labels,
    maxStarts: p.maxStarts,
    startsLeft: paceStartsLeft(store, config, p),
  };
}
