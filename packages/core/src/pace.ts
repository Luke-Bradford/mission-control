/** How hard the crew runs. Normal is the absence of a setting: nothing here slows work by itself. */
export const PACE_SETTING = "pace";
export const PACE_NOTE_MAX = 80;

export interface PaceSettings {
  on: boolean;
  /** Epoch ms the slow mode ends; normal resumes at that moment. */
  until: number;
  /** Epoch ms it was switched on; only tickets started from then count against `maxStarts`. */
  since: number;
  /** A ticket starts only when it carries every one of these labels; none means any ticket. */
  labels: string[];
  /** How many tickets may start while it is on. */
  maxStarts: number;
  /** The operator's word for it ("weekend"), shown on the Overview. */
  note: string;
}

export const DEFAULT_PACE: PaceSettings = {
  on: false,
  until: 0,
  since: 0,
  labels: [],
  maxStarts: 0,
  note: "",
};

/** What the start check needs while a slow mode is on. */
export interface PaceCheck {
  labels: readonly string[];
  startsLeft: number;
  note: string;
}

/** What the Overview shows while a slow mode is on. */
export interface PaceView {
  note: string;
  until: number;
  labels: string[];
  maxStarts: number;
  startsLeft: number;
}

/** Every refusal from the pace starts with this, so a caller can tell it from a ticket's own failure. */
export const PACE_HELD_PREFIX = "Slow pace";

export const paceIsOn = (p: PaceSettings, now: number): boolean => p.on && now < p.until;

export function paceRefusal(p: PaceCheck, ref: string, labels: readonly string[]): string | null {
  const name = p.note === "" ? PACE_HELD_PREFIX : `${PACE_HELD_PREFIX} (${p.note})`;
  if (p.startsLeft <= 0) return `${name} is on and has no starts left: ${ref} waits.`;
  const missing = p.labels.filter((l) => !labels.includes(l));
  if (missing.length > 0)
    return `${name} is on and starts only tickets labelled ${p.labels.join(", ")}: ${ref} waits.`;
  return null;
}
