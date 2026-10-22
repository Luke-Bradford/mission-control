import type { TicketState, Topic } from "./types.ts";

export const TOPICS: readonly Topic[] = [
  "agents",
  "limits",
  "boards",
  "escalations",
  "health",
  "machine",
  "attention",
  "settings",
  "config",
  "guard",
  "flight",
];

/** Board columns, in display order. */
export const TICKET_STATES: readonly TicketState[] = [
  "planned",
  "in progress",
  "review",
  "blocked",
  "done",
];
