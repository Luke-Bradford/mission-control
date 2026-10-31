import type { RunStatus, TicketEvent, TicketHistory } from "@mc/core";
import { shortSha } from "../fmt.ts";

/** A PR opening or merging: the response has the PRs' times, the timeline has no entry for them. */
export interface PrEvent {
  key: string;
  at: number;
  kind: "pr";
  prNumber: number;
  title: string;
  action: "opened" | "merged";
}

export type PageEvent = TicketEvent | PrEvent;

/** The PR events of a ticket's PRs. */
export function prEvents(t: TicketHistory): PrEvent[] {
  return t.prs.flatMap((p) => {
    const base = { kind: "pr", prNumber: p.number, title: p.title } as const;
    const out: PrEvent[] = [
      { ...base, key: `pr:${p.number}:opened`, at: p.createdAt, action: "opened" },
    ];
    if (p.mergedAt !== null)
      out.push({ ...base, key: `pr:${p.number}:merged`, at: p.mergedAt, action: "merged" });
    return out;
  });
}

/** Every event the page has seen, newest first; an event that left the live window is kept. */
export function mergeEvents<E extends PageEvent>(...lists: E[][]): E[] {
  const seen = new Map<string, E>();
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

export const KIND_WORD: Record<PageEvent["kind"], string> = {
  pr: "PR",
  run: "Run",
  review: "Review",
  ci: "CI",
  decision: "FLIGHT",
  comms: "Comms",
};

const count = (n: number, word: string): string => `${n} ${word}`;

/** One line for an event; the page renders it as text. */
export function eventLine(e: PageEvent): string {
  switch (e.kind) {
    case "pr":
      return `PR #${e.prNumber} ${e.action}: ${e.title}`;
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

/** The word for a finding: how it ended, else whether it blocks. */
export function findingWord(f: { resolution: string | null; state: "open" | "logged" }): string {
  if (f.resolution) return f.resolution.replace(/-/g, " ");
  return f.state === "logged" ? "logged in the PR" : "open";
}
