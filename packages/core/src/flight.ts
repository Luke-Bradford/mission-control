import type { SeatState } from "./runtime.ts";

// The FLIGHT seat: the head agent that runs the crew. It is the one `watch` seat, started with no
// ticket, and it keeps a log of what it decided (`flight_decisions`).

/** Every line the hub writes to FLIGHT starts with this; the dock tells them from the operator's. */
export const MC_LINE_PREFIX = "[Mission Control]";

/** The checkout name of a watch seat's detached worktree. */
export const watchCheckoutName = (seatId: string): string => `${seatId}-watch`;

export const watchStartRefusedText = (call: string): string =>
  `${call} runs the crew and is started without a ticket.`;
export const notWatchSeatText = (call: string): string => `${call} is not a watch seat.`;
export const ISSUE_REQUIRED = "issue: an issue number is required";
export const oneWatchSeatText = (first: string): string =>
  `only one seat may run the watch loop; ${first} already does`;
export const watchOnlyToolText = (t: string): string => `${t} is only for a watch role`;

export const FLIGHT_DECISION_KINDS = [
  "answer",
  "pass",
  "start",
  "message",
  "unpark",
  "note",
] as const;
export type FlightDecisionKind = (typeof FLIGHT_DECISION_KINDS)[number];

export interface FlightDecision {
  id: number;
  at: number;
  kind: FlightDecisionKind;
  seatId: string | null;
  targetRunId: string | null;
  ref: string | null;
  questionId: number | null;
  about: string;
  decision: string;
  basis: string;
}

/** `GET /api/flight`: the watch seat (null when none is configured) and the last day's decisions. */
export interface FlightView {
  seat: { id: string; call: string; model: string; state: SeatState | null; live: boolean } | null;
  decisions: FlightDecision[];
}

/** How far back `GET /api/flight` lists decisions, and the most it lists. */
export const FLIGHT_VIEW_MS = 24 * 60 * 60_000;
export const FLIGHT_VIEW_LIMIT = 100;
/** The most `log_decision` notes FLIGHT may log in an hour. */
export const FLIGHT_NOTES_PER_HOUR = 60;
export const FLIGHT_HOUR_MS = 60 * 60_000;

export const FLIGHT_ABOUT_MAX = 300;
export const FLIGHT_DECISION_MAX = 1000;
export const FLIGHT_BASIS_MAX = 500;

export const MC_FLIGHT_ONLY = "Not done: this tool is for the FLIGHT seat.";
export const notInSessionText = (seat: string): string =>
  `Not done: ${seat} is not a seat in your session.`;
export const capText = (what: string, n: number): string =>
  `Not done: you ${what} ${n} times in the last hour, the most allowed. Wait, or ask the operator.`;
export const FLIGHT_NOTED = "Noted in Decided without you.";
