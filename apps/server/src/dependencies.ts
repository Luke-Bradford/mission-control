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
import type { Store } from "./store.ts";

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

/** A wait that ended: the ticket it freed, what it was waiting on, and what the engine has done about it. */
export interface ReleasedWait {
  ref: string;
  /** The waits that had stood, as refs (`repo#number` or `PR number`). */
  resolved: string[];
  at: number;
  /** The card's move to Ready is settled (done, or the card was not Blocked or not complete). */
  moved?: boolean;
  /** PRs of the ticket that have been told to merge main. */
  synced?: number[];
  /** When the engine last tried and failed; it waits before trying again. */
  triedAt?: number;
}

export interface WaitRecord {
  /** Each waiting ticket: its open waits (refs) and when the hub first saw it wait. */
  waiting: Record<string, { open: string[]; unread?: string[]; since: number }>;
  released: ReleasedWait[];
}

export const WAIT_RECORD_SETTING = "dependency-waits";
/** A released wait is kept this long, for the wake and the engine's retries. */
export const WAIT_RELEASED_KEEP_MS = 24 * 60 * 60_000;

export function readWaitRecord(store: Store, repoId: RepoId): WaitRecord {
  try {
    const v = JSON.parse(
      store.getSetting(`${WAIT_RECORD_SETTING}:${repoId}`) ?? "null",
    ) as Partial<WaitRecord> | null;
    return { waiting: v?.waiting ?? {}, released: v?.released ?? [] };
  } catch {
    return { waiting: {}, released: [] };
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
    };
  }
  const released = record.released.filter((r) => now - r.at < WAIT_RELEASED_KEEP_MS);
  for (const [ref, entry] of Object.entries(record.waiting)) {
    if (waiting[ref] !== undefined) continue;
    // a ticket that closed or left the board did not get released
    if (!open.some((c) => `${repoId}#${c.issueNumber}` === ref)) continue;
    // a wait the hub never read has no known end: reading the PR later is not a release
    if (entry.open.every((r) => entry.unread?.includes(r))) continue;
    released.push({ ref, resolved: entry.open, at: now });
  }
  const next = { waiting, released };
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

/**
 * "mc#1015 merged: mc#1139, mc#1142 unblocked": one line per set of waits that ended together.
 * `verb` is "merged" for a PR or an issue a merged PR closed, else "closed".
 */
export function releasedLines(
  released: readonly ReleasedWait[],
  verb: (ref: string) => string,
): { ref: string; at: number; text: string }[] {
  const groups = new Map<string, ReleasedWait[]>();
  for (const r of released) {
    const key = [...r.resolved].sort().join(", ");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].flatMap((rs) => {
    const first = rs[0];
    if (first === undefined) return [];
    const said = [...new Set(first.resolved)].map((d) => `${d} ${verb(d)}`).join(", ");
    return [
      {
        ref: first.ref,
        at: Math.max(...rs.map((r) => r.at)),
        text: `${said}: ${rs.map((r) => r.ref).join(", ")} unblocked`,
      },
    ];
  });
}

/** Whether a ref that stopped being a wait was merged ("merged") or just closed ("closed"). */
export function endedVerb(
  store: Pick<Store, "pullRequests">,
  repoId: RepoId,
): (ref: string) => string {
  const prs = store.pullRequests(repoId);
  return (ref) => {
    const pr = /^PR (\d+)$/.exec(ref);
    if (pr)
      return prs.find((p) => p.number === Number(pr[1]))?.state === "merged" ? "merged" : "closed";
    const issue = /#(\d+)$/.exec(ref);
    const n = issue ? Number(issue[1]) : -1;
    const merged = prs.some(
      (p) =>
        p.state === "merged" &&
        (p.closingIssues?.length ? p.closingIssues.includes(n) : p.ticket === ref),
    );
    return merged ? "merged" : "closed";
  };
}

/** Sets flags on a released wait, rereading the record so a concurrent observe is not overwritten. */
export function patchReleased(
  store: Store,
  repoId: RepoId,
  ref: string,
  at: number,
  fields: Partial<Pick<ReleasedWait, "moved" | "synced" | "triedAt">>,
): void {
  const record = readWaitRecord(store, repoId);
  const entry = record.released.find((r) => r.ref === ref && r.at === at);
  if (entry === undefined) return;
  Object.assign(entry, fields);
  writeWaitRecord(store, repoId, record);
}
