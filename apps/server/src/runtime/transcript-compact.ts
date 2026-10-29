/**
 * What a run's transcript keeps of each CLI stdout line (#934). The keeper persists
 * `compactTranscriptLine(line)` instead of the line, so a run holds kilobytes per message:
 *   - a Claude `get_context_usage` answer (30 KB of display grid) is dropped: the hub reads it live
 *     and caches the few numbers it uses;
 *   - a Codex `item/commandExecution/outputDelta` is dropped: the `item/completed` carries the same
 *     output once;
 *   - a Codex `aggregatedOutput` and a Claude `tool_result` over `TRANSCRIPT_RESULT_MAX` keep their
 *     first and last `TRANSCRIPT_KEEP_BYTES`, with `outputTruncated: {bytes}` beside them.
 * Pure and node-builtin free: the keeper runs it, and so does the one-off compaction of old
 * transcripts. It is idempotent: a line it has compacted compacts to itself.
 */

/** A result or command output longer than this (bytes) is cut. */
export const TRANSCRIPT_RESULT_MAX = 64 * 1024;
/** How much of its start, and of its end, a cut output keeps (bytes). */
export const TRANSCRIPT_KEEP_BYTES = 8 * 1024;

const CONTROL_RESPONSE = '"control_response"';
const COMMAND_OUTPUT_DELTA = "item/commandExecution/outputDelta";
const ITEM_COMPLETED = "item/completed";
const TRUNCATED = "outputTruncated";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The first and last `TRANSCRIPT_KEEP_BYTES` of `text`, or null when it is not over the limit. */
function cut(text: string): { text: string; bytes: number } | null {
  if (text.length * 3 <= TRANSCRIPT_RESULT_MAX) return null; // cannot be over: skip the copy
  const buf = Buffer.from(text);
  if (buf.length <= TRANSCRIPT_RESULT_MAX) return null;
  const head = buf.subarray(0, TRANSCRIPT_KEEP_BYTES).toString("utf8");
  const tail = buf.subarray(buf.length - TRANSCRIPT_KEEP_BYTES).toString("utf8");
  return { text: `${head}\n...\n${tail}`, bytes: buf.length };
}

/** Cuts `owner[key]` when it is a long string, marking `owner`; whether it changed anything. */
function cutField(owner: Json, key: string): boolean {
  const v = owner[key];
  if (typeof v !== "string" || owner[TRUNCATED] !== undefined) return false;
  const c = cut(v);
  if (c === null) return false;
  owner[key] = c.text;
  owner[TRUNCATED] = { bytes: c.bytes };
  return true;
}

/** Whether a `control_response` is the answer to `get_context_usage` (it carries the usage categories). */
function isContextUsageResponse(m: Json): boolean {
  const r = m.response;
  if (!isObj(r) || !isObj(r.response)) return false;
  return Array.isArray(r.response.categories) && typeof r.response.totalTokens === "number";
}

/**
 * The line to persist: the same string when nothing changes, a shorter one when an output is cut,
 * null when the line is not kept at all. A line that is not JSON is kept as it is.
 */
export function compactTranscriptLine(line: string): string | null {
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
  if (dropsDelta && m.method === COMMAND_OUTPUT_DELTA) return null;
  if (mayBeUsage && m.type === "control_response" && isContextUsageResponse(m)) return null;
  if (!mayBeBig) return line;
  let changed = false;
  if (m.method === ITEM_COMPLETED && isObj(m.params) && isObj(m.params.item)) {
    const item = m.params.item;
    if (item.type === "commandExecution") changed = cutField(item, "aggregatedOutput");
  } else if (m.type === "user" && isObj(m.message) && Array.isArray(m.message.content)) {
    for (const block of m.message.content) {
      if (!isObj(block) || block.type !== "tool_result") continue;
      if (typeof block.content === "string") changed = cutField(block, "content") || changed;
      else if (Array.isArray(block.content)) {
        for (const part of block.content) {
          if (isObj(part) && part.type === "text") changed = cutField(part, "text") || changed;
        }
      }
    }
  }
  return changed ? JSON.stringify(m) : line;
}
