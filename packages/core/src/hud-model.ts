/** Shared vocabulary and data shapes; independent of the domain algorithms. */

export const HUD_STATES = [
  "running",
  "stalled",
  "blocked",
  "parked",
  "waiting",
  "idle",
  "stopped",
  "error",
] as const;

export type HudState = (typeof HUD_STATES)[number];

/** The colour family of a pill; `neutral` is grey with a dot. */
export type HudTone = "ok" | "warn" | "crit" | "neutral";

/** `plain` is a pill without the dot (a word, not a state). */
export type PillTone = HudTone | "plain";

export type PillSpec = { label: string; tone: PillTone };

export const HUD_COLUMNS = [
  "Backlog",
  "Refinement",
  "Blocked",
  "Ready",
  "In progress",
  "In review",
  "Ready for QA",
  "Done",
] as const;

export type HudColumn = (typeof HUD_COLUMNS)[number];

/** Sort order of the Needs-you list (catalogue 2.5.1). */
export const ATTENTION_KINDS = [
  "lock",
  "stalled",
  "error",
  "person",
  "decision",
  "approval",
  "question",
  "blocked",
  "review",
  "ready",
  "flag",
  "ratelimit",
  "tag",
  "parked",
  "pr",
  "message",
  "stray",
] as const;

export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** Who an attention item waits on: the operator, FLIGHT, the controller, a lane's login or a loop. */
export type AttentionOwner = "operator" | "flight" | "controller" | "loop" | `lane:${string}`;
