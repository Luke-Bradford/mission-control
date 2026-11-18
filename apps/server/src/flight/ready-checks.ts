/**
 * The checks a ticket passes before it goes to Ready, shared by FLIGHT's `promote` and the
 * operator's plan approval so the two cannot drift. Each returns the refusal text, or null.
 */
import {
  areaLabelsOf,
  type BoardItem,
  dependsOn,
  hasDoneWhenSection,
  missingNeedsText,
  moveHasRunText,
  moveNoAreaText,
  moveTwoAreasText,
  moveWaitsOnText,
  type RepoRules,
  WAITING_OPERATOR_LABEL,
  waitingOperatorPromoteText,
} from "@mc/core";
import { waitReader } from "../queue/dependencies.ts";
import { prototypeLinkProblem } from "../repo/prototype-links.ts";
import type { Store } from "../store.ts";

/** The operator set it aside with a question, or a run has the ticket. */
export function readyEarlyBlock(
  store: Store,
  ref: string,
  card: BoardItem,
  /** Moving back to Backlog: a set-aside question does not hold the card there. */
  toBacklog = false,
): string | null {
  if (!toBacklog && card.labels.includes(WAITING_OPERATOR_LABEL))
    return waitingOperatorPromoteText(ref);
  if (store.activeTickets().has(ref)) return moveHasRunText(ref);
  return null;
}

/** Missing needs, area labels, and anything the ticket waits on (blocked-by, Depends on, holds). */
export function readyBlock(i: {
  store: Store;
  repoId: string;
  ref: string;
  card: BoardItem;
  body: string;
  rules: RepoRules;
}): string | null {
  const { store, repoId, ref, card, body, rules } = i;
  const missing = rules.needs.filter((n) =>
    n === "done_when" ? !hasDoneWhenSection(body) : card.size === null,
  );
  if (missing.length > 0) return missingNeedsText(ref, missing);
  const areas = areaLabelsOf(rules, card);
  if (areas.length >= 2) return moveTwoAreasText(ref, areas);
  if (areas.length === 0) return moveNoAreaText(ref);
  const board = store.board(repoId);
  const waits = new Map(card.blockedBy.filter((b) => !b.closed).map((b) => [b.ref, b.ref]));
  for (const n of dependsOn(body)) {
    const dep = board.find((b) => b.issueNumber === n);
    if (dep === undefined || !dep.closed) waits.set(`${repoId}#${n}`, `${repoId}#${n}`);
  }
  for (const w of waitReader(store, repoId)(card)) waits.set(w.ref, w.text);
  return waits.size > 0 ? moveWaitsOnText(ref, [...waits.values()]) : null;
}

/** A prototype link the ticket carries that the repo cannot show (promote and approval alike), or null. */
export function prototypeBlock(
  ref: string,
  ticket: { body: string; prototypeProblem?: string | null } | null,
  github: string | undefined,
): string | null {
  const body = ticket?.body ?? "";
  const problem = ticket?.prototypeProblem ?? prototypeLinkProblem(body, github);
  return problem === null ? null : `Not moved: ${ref} ${problem}`;
}
