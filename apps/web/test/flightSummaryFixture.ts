import type {
  FlightLedgerEntry,
  FlightLedgerView,
  FlightSummaryItem,
  FlightSummaryOutcome,
  FlightSummaryView,
} from "@mc/core";
import { MIN, NOW } from "./fixtures.ts";

export const ledgerEntry = (over: Partial<FlightLedgerEntry> = {}): FlightLedgerEntry => ({
  key: "work:1",
  kind: "work",
  title: "Ship the summary",
  status: "active",
  owner: "guido-1",
  next: "Review the change",
  waitsOn: "RETRO",
  due: null,
  refs: ["#522", "PR #523"],
  priority: "P1",
  createdAt: NOW - 10 * MIN,
  updatedAt: NOW - MIN,
  outcome: null,
  basis: "Ticket agreed",
  ...over,
});
export const summaryItem = (entry: FlightLedgerEntry): FlightSummaryItem => ({
  key: entry.key,
  kind: entry.kind,
  title: entry.title,
  status: entry.status,
  next: entry.next,
  due: entry.due,
  priority: entry.priority,
  ageMin: 10,
});
export const summaryOutcome = (entry: FlightLedgerEntry): FlightSummaryOutcome => ({
  ...summaryItem(entry),
  outcome: entry.outcome,
  refs: entry.refs,
  basis: entry.basis,
  closedAt: entry.updatedAt,
});
export const flightLedger = (entries: FlightLedgerEntry[] = []): FlightLedgerView => ({
  session: "s1",
  entries,
  more: false,
  nextOffset: null,
});
export const flightSummary = (over: Partial<FlightSummaryView> = {}): FlightSummaryView => ({
  session: "s1",
  headlineAgeMin: 1,
  headline: "The crew is shipping; one review needs attention.",
  now: [],
  watching: { counts: { active: 3, blocked: 1, waiting: 2, done: 4, dropped: 1 }, top: [] },
  next: [],
  done: [],
  incoming: 0,
  metrics: {
    since: NOW - 12 * 60 * MIN,
    opened: 8,
    inReview: 4,
    inCi: 2,
    ciFailures: 3,
    reruns: 1,
    parks: { day: 2, live: [] },
    seats: [
      { seat: "flight-1", tokens: 1000, costUsd: 1.25 },
      { seat: "guido-1", tokens: 2000, costUsd: 2.5 },
    ],
    flight: { wakes: 10, costUsd: 1.25 },
    forTheController: 0,
  },
  ...over,
});
