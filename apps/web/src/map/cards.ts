import { MAP_RECENT_MS, type MapSeat, type MapSnapshot, namesOnly } from "@mc/core";
import { seatColorVar } from "../crew.ts";

const isDocked = (seat: MapSeat, now: number): boolean =>
  seat.calls.length === 0 && seat.state !== "running" && now - seat.since >= 60_000;

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h`;
}

/** A change that moved at least one line (a mode-only or empty entry counts for nothing). */
const counted = (seat: MapSeat) => seat.scope.modified.filter((c) => c.add + c.rem > 0);

/**
 * Waiting on the operator: a question awaiting a reply, or parked for a reason other than the
 * operator stopping its run (a test-lock queue waits on the lock, not on anyone). The map shows no
 * warning for it; it only keeps such a seat in the selector.
 */
const waitsOnYou = (seat: MapSeat): boolean =>
  seat.badges.questions.length > 0 ||
  (seat.badges.waiting?.kind === "parked" && !seat.badges.waiting.stopped);

/** A seat's recent accesses the hub still keeps: those within MAP_RECENT_MS of now. */
export const freshRecent = (seat: MapSeat, now: number): MapSeat["recent"] =>
  seat.recent.filter((r) => r.at >= now - MAP_RECENT_MS);

/**
 * A seat the map shows: live now (a call in flight, a running turn, or less than a minute since
 * one), with a recent path (kept MAP_RECENT_MS after its calls end), carrying an unmerged branch
 * with changes, or waiting on the operator.
 */
export function isWorking(seat: MapSeat, now: number): boolean {
  return (
    !isDocked(seat, now) ||
    freshRecent(seat, now).length > 0 ||
    counted(seat).length > 0 ||
    waitsOnYou(seat)
  );
}

/** Lines added and removed, and whether any of it is edit churn rather than the branch's diff. */
export interface ChangeCount {
  add: number;
  rem: number;
  churn: boolean;
}

/** What a seat has changed on its unmerged branches: distinct files, and their lines. */
export function changeTotals(seat: MapSeat): ChangeCount & { files: number } {
  const changes = counted(seat);
  return {
    files: new Set(changes.map((c) => c.file)).size,
    add: changes.reduce((n, c) => n + c.add, 0),
    rem: changes.reduce((n, c) => n + c.rem, 0),
    churn: changes.some((c) => c.source === "churn"),
  };
}

/**
 * The files a seat has touched on its current run: changed, read, or accessed by a call (a
 * name-only listing such as Glob opened nothing, so it touches nothing).
 */
export function touchedFiles(seat: MapSeat): Set<string> {
  return new Set([
    ...counted(seat).map((c) => c.file),
    ...seat.scope.read,
    ...seat.recent.map((r) => r.file),
    ...seat.calls.filter((c) => !namesOnly(c.tool)).flatMap((c) => c.files),
  ]);
}

/**
 * The files a seat read, by nodeWork's rule: read on its run, or touched without being changed,
 * so the seat's card and the discs on the map agree once a run's reads are gone.
 */
export function readCount(seat: MapSeat): number {
  const read = new Set(seat.scope.read);
  const changed = new Set(counted(seat).map((c) => c.file));
  return [...touchedFiles(seat)].filter((f) => read.has(f) || !changed.has(f)).length;
}

/** One seat's work on a node: its lines changed there (null when none), and whether it read it. */
export interface NodeSeatWork {
  seat: string;
  changed: ChangeCount | null;
  read: boolean;
}

/**
 * Who worked on a node (one file, or a collapsed folder's files), in seat order: each seat that
 * touched any of them, with its own +/− where it changed them, and whether it read them. A file a
 * seat only accessed by a call counts as read.
 */
export function nodeWork(snapshot: MapSnapshot, files: string[]): NodeSeatWork[] {
  const has = new Set(files);
  return snapshot.seats.flatMap((seat) => {
    const changes = counted(seat).filter((c) => has.has(c.file));
    const touched = [...touchedFiles(seat)].some((f) => has.has(f));
    if (!touched) return [];
    const changed = changes.length
      ? {
          add: changes.reduce((n, c) => n + c.add, 0),
          rem: changes.reduce((n, c) => n + c.rem, 0),
          churn: changes.some((c) => c.source === "churn"),
        }
      : null;
    const read = seat.scope.read.some((f) => has.has(f)) || changed === null;
    return [{ seat: seat.seat, changed, read }];
  });
}

/** What a seat is on, from one source: the crew row's ticket, title and PR, else the map's. */
export interface SeatWork {
  ticket: number | null;
  title: string | null;
  pr: number | null;
}

/**
 * What a seat is on, as the Overview says it: `#808 · PR #812 · Map: plain seat lights`, the
 * ticket and its PR when known, else null.
 */
export function workLine(work: SeatWork): string | null {
  const refs = [
    ...(work.ticket !== null ? [`#${work.ticket}`] : []),
    ...(work.pr !== null ? [`PR #${work.pr}`] : []),
  ];
  if (!refs.length) return null;
  return [...refs, ...(work.title ? [work.title] : [])].join(" · ");
}

/**
 * A seat's colour token on the map, its place in config order (FLIGHT its own): the same palette
 * as `agentColor`, so a seat is one colour on every page.
 */
export const seatToken = (seat: string, order: number): string =>
  seat === "FLIGHT" ? "--seat-flight" : seatColorVar(order);
