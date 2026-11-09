import { setImmediate as yieldEventLoop } from "node:timers/promises";
import {
  COMMS_CAPCOM,
  type FlightConversationMessage,
  type FlightConversationPage,
  type StreamEvent,
} from "@mc/core";
import { statNoted } from "./file-deps.ts";
import { commsPosition, type Store } from "./store.ts";
import { readStreamPage } from "./stream.ts";
import { transcriptFilePath } from "./transcript-file.ts";

type SourceRun = ReturnType<Store["flightConversationRuns"]>[number];
interface Rank {
  at: number;
  source: string;
  offset: number;
  block: number;
}
interface Line extends Rank {
  message: FlightConversationMessage;
}
interface Entry {
  size: number;
  mtime: number;
  lines: Line[];
  bytes: number;
}
interface Cache {
  entries: Map<string, Entry>;
  bytes: number;
}
const caches = new WeakMap<Store, Cache>();
const CACHE_BYTES = 64 * 1024 * 1024;
const readKey = (flightId: string) => `flight-conversation-read:${flightId}`;
const compare = (a: Rank, b: Rank): number =>
  a.at - b.at ||
  (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
  a.offset - b.offset ||
  a.block - b.block;
const internal = (text: string) => /^\s*\[Mission Control\]/i.test(text);
export class FlightConversationCursorError extends Error {}

function readBound(store: Store, flightId: string): (Rank & { id: string }) | null {
  try {
    const value = JSON.parse(store.getSetting(readKey(flightId)) ?? "null") as
      | (Rank & { id: string })
      | null;
    return value &&
      typeof value.id === "string" &&
      typeof value.source === "string" &&
      [value.at, value.offset, value.block].every(Number.isFinite)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** The old conversation join used threadMessages' latest three runs. Page the retained sources instead. */
async function runLines(store: Store, flightId: string, run: SourceRun): Promise<Line[]> {
  if (!run.transcriptPath) return [];
  let stamp: { size: number; mtimeMs: number };
  try {
    stamp = statNoted(transcriptFilePath(run.transcriptPath));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  let cache = caches.get(store);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    caches.set(store, cache);
  }
  const key = `${run.id}\0${run.transcriptPath}\0${run.startedAt}\0${run.vendor ?? ""}`;
  const prior = cache.entries.get(key);
  if (prior?.size === stamp.size && prior.mtime === stamp.mtimeMs) {
    cache.entries.delete(key);
    cache.entries.set(key, prior);
    return prior.lines;
  }
  if (prior) {
    cache.bytes -= prior.bytes;
    cache.entries.delete(key);
  }
  let before: string | undefined;
  let scanBefore: number | undefined;
  const pages: StreamEvent[][] = [];
  for (;;) {
    const page = readStreamPage(run.transcriptPath, 200, run.vendor, before, scanBefore);
    pages.push(page.events);
    const next = page.events[0]?.id;
    if (!page.more) break;
    if (next) {
      if (next === before) break;
      before = next;
      scanBefore = undefined;
    } else {
      if (page.scanBefore === undefined || page.scanBefore === scanBefore) break;
      before = undefined;
      scanBefore = page.scanBefore;
    }
    await yieldEventLoop();
  }
  let orderAt = run.startedAt;
  const seen = new Set<string>();
  const lines: Line[] = [];
  for (const events of pages.reverse())
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (event.at !== null) orderAt = event.at;
      if (event.kind !== "msg" || internal(event.text)) continue;
      const id = `stream:${run.id}:${event.id}`;
      const position = commsPosition(id);
      if (!position) continue;
      lines.push({
        at: event.at ?? orderAt,
        source: position.source,
        offset: position.offset,
        block: position.block,
        message: {
          id,
          at: event.at,
          from: flightId,
          to: COMMS_CAPCOM,
          text: event.text,
          ticket: run.ticket ?? null,
          label: null,
          ref: null,
          replyTo: null,
          mentions: [],
          reactions: [],
          operator: false,
          senderKind: "flight",
        },
      });
    }
  const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line.message.text) + 256, 0);
  const after = statNoted(transcriptFilePath(run.transcriptPath));
  if (stamp.size === after.size && stamp.mtimeMs === after.mtimeMs && bytes <= CACHE_BYTES) {
    cache.entries.set(key, { size: stamp.size, mtime: stamp.mtimeMs, lines, bytes });
    cache.bytes += bytes;
    while (cache.bytes > CACHE_BYTES) {
      const first = cache.entries.entries().next().value;
      if (!first) break;
      cache.entries.delete(first[0]);
      cache.bytes -= first[1].bytes;
    }
  }
  return lines;
}

async function sources(store: Store, flightId: string): Promise<Line[]> {
  const lines: Line[] = [];
  for (const run of store.flightConversationRuns(flightId)) {
    for (const line of await runLines(store, flightId, run)) lines.push(line);
    await yieldEventLoop();
  }
  return lines;
}

function cursorRank(
  store: Store,
  flightId: string,
  seats: readonly string[],
  streams: Line[],
  id: string,
): Rank {
  if (id.startsWith("comms:")) {
    const row = store.flightConversationStored(flightId, seats, 1, undefined, id)[0];
    const position = row && commsPosition(row.id);
    if (row && position)
      return {
        at: row.at,
        source: position.source,
        offset: position.offset,
        block: position.block,
      };
  } else {
    const line = streams.find((line) => line.message.id === id);
    if (line) return line;
  }
  throw new FlightConversationCursorError("before must name a line in this FLIGHT conversation.");
}

/** Both durable messages and actual turn text form one ordered, source-bound conversation. GET writes nothing. */
export async function flightConversation(
  store: Store,
  flightId: string,
  seats: readonly string[],
  paging: { limit: number; before?: string },
): Promise<FlightConversationPage> {
  const streams = await sources(store, flightId);
  const cut = paging.before ? cursorRank(store, flightId, seats, streams, paging.before) : null;
  const stored = store.flightConversationStored(
    flightId,
    seats,
    paging.limit + 1,
    cut
      ? { at: cut.at, id: cut.source === "comms" ? cut.offset : Number.MAX_SAFE_INTEGER }
      : undefined,
  );
  const latestReply = streams.reduce(
    (latest, line) => Math.max(latest, line.message.at ?? -Infinity),
    store.latestFlightStoredReplyAt(flightId) ?? -Infinity,
  );
  const pins = new Set(store.commsPins().map((pin) => pin.id));
  const candidates: Line[] = streams.filter((line) => !cut || compare(line, cut) < 0);
  for (const row of stored) {
    const position = commsPosition(row.id);
    if (!position) continue;
    const state =
      row.from !== COMMS_CAPCOM || row.choice
        ? {}
        : {
            state:
              row.deliveredAt === null
                ? ("stored" as const)
                : latestReply >= row.deliveredAt
                  ? ("answered" as const)
                  : ("delivered" as const),
          };
    candidates.push({
      at: row.at,
      source: position.source,
      offset: position.offset,
      block: position.block,
      message: {
        ...row,
        ...state,
        text: row.choice ? `You chose: ${row.choice.label}` : row.text,
        operator: row.from === COMMS_CAPCOM,
        pinned: pins.has(row.id),
        reactions: store.commsReactions(row.id),
      },
    });
  }
  candidates.sort(compare);
  const bound = readBound(store, flightId);
  const legacyCursor = store.commsScopeCursor("flight");
  const thread = store.threadReadCursors(flightId);
  const streamUnread = streams.filter((line) => {
    if (bound) return compare(line, bound) > 0;
    const read = thread.get(line.source);
    return (
      !read || line.offset > read.offset || (line.offset === read.offset && line.block > read.block)
    );
  }).length;
  return {
    messages: candidates.slice(-paging.limit).map((line) => line.message),
    hasMore: candidates.length > paging.limit,
    cursor: bound?.id ?? legacyCursor,
    unread:
      streamUnread +
      store.flightConversationUnread(flightId, seats, legacyCursor, bound ?? undefined),
  };
}

/** A read moves through real displayed identities, never a fabricated transcript position. */
export async function readFlightConversation(
  store: Store,
  flightId: string,
  seats: readonly string[],
  id: string,
): Promise<void> {
  const streams = await sources(store, flightId);
  const bound = cursorRank(store, flightId, seats, streams, id);
  const prior = readBound(store, flightId);
  if (prior && compare(bound, prior) <= 0) return;
  const markers = new Map<string, Line>();
  for (const line of streams)
    if (compare(line, bound) <= 0) {
      const old = markers.get(line.source);
      if (
        !old ||
        line.offset > old.offset ||
        (line.offset === old.offset && line.block > old.block)
      )
        markers.set(line.source, line);
    }
  const max = store.flightConversationStoredReadThrough(flightId, seats, bound);
  const ids = [...markers.values()].map((line) => line.message.id);
  if (max !== null) {
    const storedId = `comms:${max}`;
    store.markCommsScopeRead("flight", storedId);
    ids.push(storedId);
  }
  store.markThreadRead(flightId, ids);
  store.setSetting(
    readKey(flightId),
    JSON.stringify({
      id,
      at: bound.at,
      source: bound.source,
      offset: bound.offset,
      block: bound.block,
    }),
  );
}
