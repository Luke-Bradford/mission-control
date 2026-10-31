import type { RunStatus, TicketEvent, TicketHistory } from "@mc/core";
import { shortSha } from "../fmt.ts";

/** Every event the page has seen, newest first; an event that left the live window is kept. */
export function mergeEvents(...lists: TicketEvent[][]): TicketEvent[] {
  const seen = new Map<string, TicketEvent>();
  for (const list of lists) for (const e of list) seen.set(e.key, e);
  return [...seen.values()].sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : -1));
}

/** The word a run's status is shown as. */
export const RUN_WORD: Record<RunStatus, string> = {
  running: "running",
  ok: "finished",
  failed: "failed",
  blocked: "blocked",
  unknown: "ended, outcome unknown",
};

export const KIND_WORD: Record<TicketEvent["kind"], string> = {
  run: "Run",
  review: "Review",
  ci: "CI",
  decision: "FLIGHT",
  comms: "Comms",
};

const count = (n: number, word: string): string => `${n} ${word}`;

/** One line for an event; the page renders it as text. */
export function eventLine(e: TicketEvent): string {
  switch (e.kind) {
    case "run":
      return `${e.seat} run ${RUN_WORD[e.status]}${e.phase ? `, phase ${e.phase}` : ""}`;
    case "review":
      return `PR #${e.prNumber} review round ${e.round}: ${e.state}, ${count(e.blocking, "blocking")}, ${count(e.minor, "minor")}`;
    case "ci":
      return `PR #${e.prNumber} CI on ${shortSha(e.sha)}: ${e.passing} passing, ${e.failing} failing, ${e.pending} pending`;
    case "decision":
      return `${e.decisionKind}: ${e.decision}`;
    case "comms":
      return `${e.from} to ${e.to}${e.label ? ` (${e.label})` : ""}: ${e.text}`;
  }
}

/** The findings of the review round a timeline entry names, from the PRs the page already has. */
export function findingsOf(t: TicketHistory, reviewId: number) {
  for (const pr of t.prs) {
    const round = pr.rounds.find((r) => r.reviewId === reviewId);
    if (round) return round.findings;
  }
  return [];
}
