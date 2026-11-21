/**
 * The server's read of what a ticket waits on: the core rule applied to the stored board and PRs,
 * the record of how long each wait has stood, and the release of tickets when a wait ends.
 */
import {
  type BoardItem,
  type DependencyWait,
  type FlightBlocked,
  hudColumnOf,
  type PullRequestView,
  type RepoId,
  ticketWaits,
  waitChains,
} from "@mc/core";
import type { Store } from "../store.ts";

type WaitCard = Pick<BoardItem, "issueNumber" | "blockedBy" | "after">;

/** Reads the repo's board and PRs once; the result gives any card's open waits (GitHub links, body lines, a stacked PR). */
export function waitReader(
  store: Pick<Store, "board" | "pullRequests">,
  repoId: RepoId,
  prs: readonly PullRequestView[] = store.pullRequests(repoId),
): (card: WaitCard) => DependencyWait[] {
  const board = store.board(repoId);
  return (card) => ticketWaits({ repoId, card, board, prs });
}

export interface WaitRecord {
  /** Each waiting ticket: its open waits (refs) and when the hub first saw it wait. */
  waiting: Record<
    string,
    { open: string[]; unread?: string[]; since: number; sinceByRef?: Record<string, number> }
  >;
}

/** Each edge retains its first observation; legacy entries fall back to their recorded set start. */
export function observedWaitSince(
  entry: WaitRecord["waiting"][string] | undefined,
  ref: string,
): number | null {
  if (!entry?.open.includes(ref)) return null;
  return entry.sinceByRef?.[ref] ?? entry.since;
}

export const WAIT_RECORD_SETTING = "dependency-waits";

export function readWaitRecord(store: Store, repoId: RepoId): WaitRecord {
  try {
    const v = JSON.parse(
      store.getSetting(`${WAIT_RECORD_SETTING}:${repoId}`) ?? "null",
    ) as Partial<WaitRecord> | null;
    return { waiting: v?.waiting ?? {} };
  } catch {
    return { waiting: {} };
  }
}

export function writeWaitRecord(store: Store, repoId: RepoId, record: WaitRecord): void {
  const key = `${WAIT_RECORD_SETTING}:${repoId}`;
  const value = JSON.stringify(record);
  if (store.getSetting(key) !== value) store.setSetting(key, value);
}

/**
 * Brings the repo's record up to the stored board and PRs: a ticket that waited and no longer does
 * is released (once); a new wait starts its clock. Safe to call from anywhere, any number of times.
 */
export function observeWaits(
  store: Store,
  repoId: RepoId,
  now: number,
  prs?: readonly PullRequestView[],
): WaitRecord {
  const record = readWaitRecord(store, repoId);
  const board = store.board(repoId);
  const waitsOf = waitReader(store, repoId, prs);
  const waiting: WaitRecord["waiting"] = {};
  const open = board.filter((c) => !c.closed);
  for (const card of open) {
    const waits = waitsOf(card);
    if (waits.length === 0) continue;
    const ref = `${repoId}#${card.issueNumber}`;
    const unread = waits.filter((w) => w.unread === true).map((w) => w.ref);
    waiting[ref] = {
      open: waits.map((w) => w.ref),
      ...(unread.length > 0 ? { unread } : {}),
      since: record.waiting[ref]?.since ?? now,
      sinceByRef: Object.fromEntries(
        waits.map((wait) => [wait.ref, observedWaitSince(record.waiting[ref], wait.ref) ?? now]),
      ),
    };
  }
  const next = { waiting };
  writeWaitRecord(store, repoId, next);
  return next;
}

/** Every ticket that waits, with its chain and wait so far; the card's lane decides whether it is listed. */
export function blockedWork(
  store: Store,
  repoId: RepoId,
  now: number,
  listed: (card: BoardItem) => boolean = () => true,
): FlightBlocked[] {
  const record = observeWaits(store, repoId, now);
  const board = store.board(repoId);
  const cards = board.filter((c) => !c.closed);
  const chains = waitChains({ repoId, cards, board, prs: store.pullRequests(repoId) });
  return chains.flatMap((c) => {
    const card = cards.find((x) => `${repoId}#${x.issueNumber}` === c.ref);
    if (card === undefined || !listed(card)) return [];
    return [
      {
        ref: c.ref,
        title: card.title,
        column: hudColumnOf(card),
        waitsOn: c.waits.map((w) => w.text),
        chain: c.chain,
        waitedMin: Math.max(0, Math.floor((now - (record.waiting[c.ref]?.since ?? now)) / 60_000)),
      },
    ];
  });
}
