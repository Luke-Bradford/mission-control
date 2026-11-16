import {
  type AttentionItem,
  COMMS_OPEN_PREFIX,
  REPO_UNWATCHED_REASON,
  repoUnwatchedPanelText,
  type TestLockState,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import { attentionItems, NO_LOCK } from "../hud/hud.ts";
import type { Store } from "../store.ts";
import { questionAskAt, releaseHold } from "./holds.ts";

/** The repo an item was raised in: its ticket's, else the repo of the seat that raised it. */
export const itemRepo = (item: AttentionItem): string | null =>
  /^(.+)#\d+$/.exec(item.ticket ?? "")?.[1] ?? item.repoId;

/** The item with `repoUnwatched` set when it was raised in a repo this hub does not watch. */
export function withRepoWatch(item: AttentionItem, config: CcConfig): AttentionItem {
  const repo = itemRepo(item);
  if (repo === null || config.repos.some((r) => r.id === repo)) return item;
  return { ...item, repoUnwatched: { repoId: repo, text: repoUnwatchedPanelText(repo) } };
}

/**
 * Closes each open question or blocker raised in a repo the hub no longer watches, even a
 * protected one: nobody can act on it any more, so asking the operator to answer it means
 * nothing. The closure and a FLIGHT decision record why. A repo that comes back does not reopen
 * what was closed. Returns how many it closed.
 */
export function closeUnwatchedRepoItems(d: {
  config: CcConfig;
  store: Store;
  now: number;
  lock?: TestLockState;
}): number {
  const { config, store, now } = d;
  const watched = new Set(config.repos.map((r) => r.id));
  let closed = 0;
  for (const item of attentionItems(config, store, now, d.lock ?? NO_LOCK, undefined, null, true)) {
    const comms = item.key.startsWith(COMMS_OPEN_PREFIX);
    const source = comms || item.key.startsWith("ask:") || item.key.startsWith("note:");
    if (!source) continue;
    const repo = itemRepo(item);
    if (repo === null || watched.has(repo)) continue;
    const question = item.brief?.ask || item.text;
    const closure = {
      key: item.key,
      askAt: questionAskAt(item, item.brief),
      kind: "repo-unwatched",
      reason: REPO_UNWATCHED_REASON,
      by: "hub",
      question,
      ticket: item.ticket,
      operator: true,
      at: now,
    } as const;
    const ask = /^ask:(\d+)$/.exec(item.key);
    const stored = ask ? store.closeQuestion(closure) : store.clearAttention(closure);
    if (!stored) continue;
    if (ask) store.answerQuestion(Number(ask[1]), now);
    // Held sources must leave their hold as well as Needs you. Otherwise a later source with the
    // same key would remain hidden behind an obsolete operator hold.
    releaseHold(store, item.key, now);
    closed++;
    store.addFlightDecision({
      at: now,
      kind: "settle",
      seatId: null,
      targetRunId: null,
      ref: item.ticket,
      questionId: null,
      about: question,
      decision: `Closed ${item.key}: ${REPO_UNWATCHED_REASON}`,
      basis: `${repo} is not in the hub's watched repos`,
    });
  }
  return closed;
}
