/**
 * What a run's transcript keeps of each CLI stdout line (#934). The keeper persists
 * `compactTranscriptLine(line)` instead of the line, so a run holds kilobytes per message:
 *   - a Claude `get_context_usage` answer (30 KB of display grid) is dropped: the hub reads it live
 *     and caches the few numbers it uses;
 *   - a Codex `item/commandExecution/outputDelta` is dropped: the `item/completed` carries the same
 *     output once (but see the heartbeat below);
 *   - a Codex `aggregatedOutput` and a Claude `tool_result` over `TRANSCRIPT_RESULT_MAX` keep their
 *     first and last `TRANSCRIPT_KEEP_BYTES`, with `outputTruncated: {bytes}` beside them.
 *   - a Codex `item/commandExecution/outputDelta` is not kept either, but one stripped heartbeat per
 *     item per `DELTA_HEARTBEAT_MS` is (no `delta`): the transcript's last event time keeps moving
 *     while a long command runs, and the HUD does not call the seat stalled.
 * Also cut: a Codex JSON-RPC `result` that carries a thread's items (a resume answer is megabytes),
 * a Claude line's `tool_use_result` (a second copy of the result) and an image's base64 `data`.
 * Pure and node-builtin free: the keeper runs it, and so does the one-off compaction of old
 * transcripts. It is idempotent: a line it has compacted compacts to itself.
 * Caveat: a line that is changed is parsed and written again with `JSON.stringify`, so its key
 * order is kept but its whitespace and number spellings are the serialiser's. A line that is not
 * changed is returned as it came.
 */

/** A result or command output longer than this (bytes) is cut. */
export const TRANSCRIPT_RESULT_MAX = 64 * 1024;
/** How much of its start, and of its end, a cut output keeps (bytes). */
export const TRANSCRIPT_KEEP_BYTES = 8 * 1024;

/** At most one outputDelta heartbeat per item in this long (ms). */
export const DELTA_HEARTBEAT_MS = 60 * 1000;

const CONTROL_RESPONSE = '"control_response"';
const COMMAND_OUTPUT_DELTA = "item/commandExecution/outputDelta";
const ITEM_COMPLETED = "item/completed";
const TRUNCATED = "outputTruncated";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Decides, per delta, whether its heartbeat is kept: `(itemId, atMs) => boolean`. */
export type DeltaHeartbeats = (itemId: string, at: number) => boolean;

/** A fresh heartbeat limiter: the first delta of an item, then one per `DELTA_HEARTBEAT_MS` of it. */
export function deltaHeartbeats(): DeltaHeartbeats {
  const lastKeptAt = new Map<string, number>();
  return (itemId, at) => {
    const last = lastKeptAt.get(itemId);
    if (last !== undefined && at - last < DELTA_HEARTBEAT_MS && at >= last) return false;
    lastKeptAt.set(itemId, at);
    return true;
  };
}

/** The first and last `TRANSCRIPT_KEEP_BYTES` of `text`, or null when it is not over the limit. */
function cut(text: string): { text: string; bytes: number } | null {
  if (text.length * 3 <= TRANSCRIPT_RESULT_MAX) return null; // cannot be over: skip the copy
  const buf = Buffer.from(text);
  if (buf.length <= TRANSCRIPT_RESULT_MAX) return null;
  const head = buf.subarray(0, TRANSCRIPT_KEEP_BYTES).toString("utf8");
  const tail = buf.subarray(buf.length - TRANSCRIPT_KEEP_BYTES).toString("utf8");
  return { text: `${head}\n...\n${tail}`, bytes: buf.length };
}

/**
 * Cuts `owner[key]` when it is a long string and marks `owner` with the bytes cut (all of the
 * owner's fields cut in this pass, summed). A cut text is far under the limit, so it is not cut twice.
 */
function cutField(owner: Json, key: string): boolean {
  const v = owner[key];
  if (typeof v !== "string") return false;
  const c = cut(v);
  if (c === null) return false;
  owner[key] = c.text;
  const before = isObj(owner[TRUNCATED]) ? Number(owner[TRUNCATED].bytes) || 0 : 0;
  owner[TRUNCATED] = { bytes: before + c.bytes };
  return true;
}

/** Cuts the long strings of a result: its own text, its text parts, and its images' base64. */
function cutResultValue(v: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  let changed = false;
  if (Array.isArray(v)) {
    for (const part of v) changed = cutResultValue(part, depth + 1) || changed;
  } else if (isObj(v)) {
    for (const key of Object.keys(v)) {
      const child = v[key];
      if (typeof child === "string") {
        if (key === "data" && v.type === "base64") changed = cutImage(v) || changed;
        else changed = cutField(v, key) || changed;
      } else if (child !== null && typeof child === "object") {
        changed = cutResultValue(child, depth + 1) || changed;
      }
    }
  }
  return changed;
}

/** Cuts `owner[key]` whatever it is: a string, or a value with strings in it. */
function cutIn(owner: Json, key: string): boolean {
  return typeof owner[key] === "string" ? cutField(owner, key) : cutResultValue(owner[key]);
}

/** Replaces an image's base64 `data` over the limit with a marker naming its bytes. */
function cutImage(source: Json): boolean {
  const data = source.data;
  if (typeof data !== "string" || data.length <= TRANSCRIPT_RESULT_MAX) return false;
  source.data = "";
  source[TRUNCATED] = { bytes: data.length };
  return true;
}

/** Whether a `control_response` is the answer to `get_context_usage` (it carries the usage categories). */
function isContextUsageResponse(m: Json): boolean {
  const r = m.response;
  if (!isObj(r) || !isObj(r.response)) return false;
  return Array.isArray(r.response.categories) && typeof r.response.totalTokens === "number";
}

/** Cuts every commandExecution output in a list of items. */
function cutItems(items: unknown): boolean {
  if (!Array.isArray(items)) return false;
  let changed = false;
  for (const item of items) {
    if (isObj(item) && item.type === "commandExecution")
      changed = cutField(item, "aggregatedOutput") || changed;
  }
  return changed;
}

/** The items a Codex JSON-RPC `result` carries: a thread's turns, or turns or items directly. */
function cutRpcResult(result: Json): boolean {
  let changed = cutItems(result.items);
  const turnLists = [result.turns, isObj(result.thread) ? result.thread.turns : undefined];
  for (const turns of turnLists) {
    if (!Array.isArray(turns)) continue;
    for (const turn of turns) if (isObj(turn)) changed = cutItems(turn.items) || changed;
  }
  return changed;
}

/** A delta's heartbeat: the delta line without the delta, or null for a line that is not a delta. */
function heartbeatOf(m: Json, heartbeats: DeltaHeartbeats | undefined): string | null {
  const p = isObj(m.params) ? m.params : {};
  const at = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : Number.NaN;
  if (heartbeats === undefined || typeof p.itemId !== "string" || !Number.isFinite(at)) return null;
  if (!heartbeats(p.itemId, at)) return null;
  return JSON.stringify({
    method: COMMAND_OUTPUT_DELTA,
    params: { threadId: p.threadId, turnId: p.turnId, itemId: p.itemId },
    timestamp: m.timestamp,
  });
}

/**
 * The line to persist: the same string when nothing changes, a shorter one when an output is cut,
 * null when the line is not kept at all. A line that is not JSON is kept as it is.
 * `heartbeats` lets a delta leave a delta-free heartbeat now and then; without it deltas are dropped.
 */
export function compactTranscriptLine(line: string, heartbeats?: DeltaHeartbeats): string | null {
  const dropsDelta = line.includes(COMMAND_OUTPUT_DELTA);
  const mayBeUsage = line.includes(CONTROL_RESPONSE);
  const mayBeBig = line.length > TRANSCRIPT_RESULT_MAX / 3;
  if (!dropsDelta && !mayBeUsage && !mayBeBig) return line;
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isObj(m)) return line;
  if (dropsDelta && m.method === COMMAND_OUTPUT_DELTA) {
    // a heartbeat already (no delta in it) stays as it is
    if (isObj(m.params) && m.params.delta === undefined) return line;
    return heartbeatOf(m, heartbeats);
  }
  if (mayBeUsage && m.type === "control_response" && isContextUsageResponse(m)) return null;
  if (!mayBeBig) return line;
  let changed = false;
  if (m.method === ITEM_COMPLETED && isObj(m.params) && isObj(m.params.item)) {
    changed = cutItems([m.params.item]);
  } else if (m.method === undefined && isObj(m.result)) {
    changed = cutRpcResult(m.result);
  } else if (m.type === "user") {
    if (isObj(m.message) && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (isObj(block) && block.type === "tool_result")
          changed = cutIn(block, "content") || changed;
      }
    }
    changed = cutIn(m, "tool_use_result") || changed;
  }
  return changed ? JSON.stringify(m) : line;
}
