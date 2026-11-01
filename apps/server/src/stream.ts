import type { CrewVendor, StreamEvent } from "@mc/core";
import { cleanText } from "./clean.ts";
import {
  CODEX_APPROVAL_DECISION,
  codexPlan,
  codexTool,
  transcriptVendor,
} from "./codex-transcript.ts";
import { CODEX_MCP_ELICITATION } from "./runtime/codex-wire.ts";
import { isObj, type Json, STREAM_EVENT_PREFIX, str, timeOf } from "./streamjson.ts";
import { openTranscript } from "./transcript-file.ts";
import { originalBytes } from "./util.ts";

export const STREAM_CHUNK_BYTES = 256 * 1024;
export const STREAM_SCAN_BYTES = 8 * 1024 * 1024;

const NEWLINE = 0x0a;
const STREAM_EVENT_BYTES = Buffer.from(STREAM_EVENT_PREFIX);
export const EARLIER_CALL = "(earlier call)";

/**
 * One line's contribution: a finished event, or half of a tool event (its call or its result).
 * `id` is the call's tool_use id; `key` (`{line offset}:{index}`) becomes the event's id.
 */
type Item =
  | { k: "ev"; ev: Omit<StreamEvent, "id"> }
  | {
      k: "use";
      id: string;
      name: string;
      input: string;
      at: number | null;
      tool?: NonNullable<StreamEvent["tool"]>;
    }
  | {
      k: "res";
      id: string;
      result: string;
      error: boolean;
      at: number | null;
      tool?: NonNullable<StreamEvent["tool"]>;
    };
type Keyed = Item & { key: string };

/** A tool result's content: a string, or blocks whose text parts are joined. */
/** What the reader is told when the transcript holds only the ends of a result. */
const cutNote = (bytes: number | null) => (bytes === null ? "" : `\n(cut from ${bytes} bytes)`);

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Json => isObj(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** The items a top-level frame or a shown system line yields, in line order. */
function itemsOf(ev: Json): Item[] {
  const at = timeOf(ev.timestamp);
  const sys = (text: string): Item => ({ k: "ev", ev: { at, kind: "sys", text: cleanText(text) } });
  if (ev.type === "system") {
    if (ev.subtype === "compact_boundary") return [sys("Context compacted")];
    if (ev.subtype === "task_started" && ev.task_type === "local_agent") {
      const type = str(ev.subagent_type) ?? "agent";
      const description = typeof ev.description === "string" ? ev.description : "";
      return [sys(`Subagent started: ${type} · ${description}`)];
    }
    if (ev.subtype === "vcs_state_changed" && ev.kind === "push") {
      const branch = str(ev.branch);
      return [sys(branch ? `Pushed ${branch}` : "Pushed")];
    }
    if (ev.subtype === "code_change_published") {
      return [sys(`PR ${str(ev.action) ?? "updated"}: ${str(ev.url) ?? ""}`)];
    }
    return [];
  }
  if (ev.type !== "assistant" && ev.type !== "user") return [];
  if (ev.parent_tool_use_id !== null && ev.parent_tool_use_id !== undefined) return [];
  const msg = isObj(ev.message) ? ev.message : null;
  if (!msg) return [];
  if (ev.type === "user" && typeof msg.content === "string") {
    return [{ k: "ev", ev: { at, kind: "op", text: cleanText(msg.content) } }];
  }
  if (!Array.isArray(msg.content)) return [];
  const out: Item[] = [];
  for (const b of msg.content) {
    if (!isObj(b)) continue;
    if (ev.type === "assistant") {
      if (b.type === "text" && typeof b.text === "string") {
        out.push({ k: "ev", ev: { at, kind: "msg", text: cleanText(b.text) } });
      } else if (b.type === "thinking") {
        const text = typeof b.thinking === "string" && b.thinking !== "" ? b.thinking : "thinking";
        out.push({ k: "ev", ev: { at, kind: "think", text: cleanText(text) } });
      } else if (b.type === "tool_use" && str(b.id)) {
        out.push({
          k: "use",
          id: b.id as string,
          name: cleanText(str(b.name) ?? "(unnamed)"),
          input: b.input === undefined ? "" : cleanText(JSON.stringify(b.input)),
          at,
        });
      }
    } else if (b.type === "text" && typeof b.text === "string") {
      out.push({ k: "ev", ev: { at, kind: "op", text: cleanText(b.text) } });
    } else if (b.type === "tool_result" && str(b.tool_use_id)) {
      const text = resultText(b.content);
      out.push({
        k: "res",
        id: b.tool_use_id as string,
        result: cleanText(text) + cutNote(originalBytes(b, text.length)),
        error: b.is_error === true,
        at,
      });
    }
  }
  return out;
}

function codexItems(ev: Json): Item[] {
  const p = isObj(ev.params) ? ev.params : {};
  const at = timeOf(ev.timestamp);
  const note = (text: string): Item[] => [
    { k: "ev", ev: { at, kind: "sys", text: cleanText(text) } },
  ];
  if (ev.method === CODEX_APPROVAL_DECISION) {
    return note(`Approval ${p.decision === "accept" ? "approved" : "declined"}: ${p.requestId}`);
  }
  if (
    typeof ev.method === "string" &&
    (ev.method.endsWith("/requestApproval") || ev.method === CODEX_MCP_ELICITATION)
  ) {
    return note(`Approval requested: ${str(p.command) ?? str(p.itemId) ?? ev.id}`);
  }
  if (ev.method === "turn/plan/updated") {
    const plan = codexPlan(p);
    return plan === null ? [] : note(plan);
  }
  if (!isObj(p.item)) return [];
  const item = p.item;
  if (
    ev.method === "item/completed" &&
    item.type === "agentMessage" &&
    typeof item.text === "string"
  ) {
    return [{ k: "ev", ev: { at, kind: "msg", text: cleanText(item.text) } }];
  }
  const found = codexTool(item);
  const id = str(item.id);
  if (!found || id === null) return [];
  const { originalBytes: original, ...tool } = found;
  tool.input = cleanText(tool.input);
  tool.result = cleanText(tool.result) + cutNote(original);
  tool.name = cleanText(tool.name);
  if (ev.method === "item/started")
    return [
      { k: "use", id, name: tool.name, input: tool.input, at, tool: { ...tool, result: null } },
    ];
  if (ev.method === "item/completed")
    return [{ k: "res", id, result: tool.result, error: tool.error, at, tool }];
  return [];
}

/** A line's items, keyed by the line's byte offset in the file and their index in it. */
function parseLine(buf: Buffer, offset: number, vendor?: CrewVendor): Keyed[] {
  if (buf.length === 0 || buf[0] !== 0x7b) return [];
  if (buf.subarray(0, STREAM_EVENT_BYTES.length).equals(STREAM_EVENT_BYTES)) return [];
  let ev: unknown;
  try {
    ev = JSON.parse(buf.toString("utf8"));
  } catch {
    return [];
  }
  return isObj(ev)
    ? (transcriptVendor(ev, vendor) === "codex" ? codexItems(ev) : itemsOf(ev)).map((it, i) => ({
        ...it,
        key: `${offset}:${i}`,
      }))
    : [];
}

/** Pairs each tool call with its result into one `tool` event; oldest first. */
function toEvents(items: Keyed[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  const open = new Map<string, { ev: StreamEvent; at: number | null }>();
  for (const it of items) {
    if (it.k === "ev") {
      events.push({ id: it.key, ...it.ev });
    } else if (it.k === "use") {
      const ev: StreamEvent = {
        id: it.key,
        at: it.at,
        kind: "tool",
        text: it.name,
        tool: it.tool ?? { name: it.name, input: it.input, result: null, ms: null, error: false },
      };
      events.push(ev);
      open.set(it.id, { ev, at: it.at });
    } else {
      const use = open.get(it.id);
      if (use?.ev.tool) {
        open.delete(it.id);
        if (it.tool) Object.assign(use.ev.tool, it.tool);
        use.ev.tool.result = it.result;
        use.ev.tool.error = it.error;
        use.ev.tool.ms =
          it.tool?.ms ?? (it.at !== null && use.at !== null ? Math.max(0, it.at - use.at) : null);
      } else {
        events.push({
          id: it.key,
          at: it.at,
          kind: "tool",
          text: it.tool?.name ?? EARLIER_CALL,
          tool: it.tool ?? {
            name: EARLIER_CALL,
            input: "",
            result: it.result,
            ms: null,
            error: it.error,
          },
        });
      }
    }
  }
  return events;
}

/**
 * The newest `limit` events of a stream-json transcript, oldest first. Reads backwards from the end
 * in STREAM_CHUNK_BYTES chunks until it has `limit` events or has scanned STREAM_SCAN_BYTES (then
 * `truncated`). Partial, non-JSON and `stream_event` lines are skipped, as is a line longer than the
 * scan cap (it never completes inside the window). Top-level frames only; every text goes through
 * `cleanText`. A tool call and its result become one `tool` event; a result whose call lies before
 * the scan window is a tool event named `(earlier call)`. Each event's `id` is its line's byte
 * offset and its index in the line, so it holds while the transcript grows. Pure apart from
 * reading `path`.
 */
export function readStream(
  path: string,
  limit: number,
  vendor?: CrewVendor,
): { events: StreamEvent[]; truncated: boolean } {
  const { events, truncated } = readStreamPage(path, limit, vendor);
  return { events, truncated };
}

/**
 * `readStream`, and with `before` (an event's id) the `limit` events ahead of that one. `more` says
 * older events remain beyond what it returned, so the dock can offer them on scroll.
 */
export function readStreamPage(
  path: string,
  limit: number,
  vendor?: CrewVendor,
  before?: string,
): { events: StreamEvent[]; truncated: boolean; more: boolean } {
  const fd = openTranscript(path);
  try {
    const size = fd.size;
    const cut = before === undefined ? null : /^(\d+):(\d+)$/.exec(before);
    if (vendor === undefined) {
      const first = Buffer.alloc(Math.min(size, STREAM_CHUNK_BYTES));
      fd.read(first, 0, first.length, 0);
      for (const line of first.toString("utf8").split("\n")) {
        try {
          const ev: unknown = JSON.parse(line);
          if (isObj(ev)) vendor = transcriptVendor(ev);
          if (vendor !== undefined) break;
        } catch {
          // Partial and non-JSON lines do not establish the format.
        }
      }
    }
    let pos = size;
    if (cut !== null) {
      // Only the line the event sits on and the ones before it: end the read at that line's end.
      pos = Number(cut[1]);
      const probe = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
      for (;;) {
        const n = fd.read(probe, 0, Math.min(probe.length, size - pos), pos);
        if (n === 0) break;
        const nl = probe.subarray(0, n).indexOf(NEWLINE);
        if (nl !== -1) {
          pos += nl;
          break;
        }
        pos += n;
      }
    }
    // The event the page starts before is read too, then dropped.
    const want = cut === null ? limit : limit + 1;
    let scanned = 0;
    let count = 0;
    let firstTaken = false;
    /** Lines' items, newest line first. */
    const lines: Keyed[][] = [];
    /** Results already met (newer than anything still to read), so their call is not counted again. */
    const results = new Set<string>();
    /** The pieces of the line being assembled (it started before the bytes read so far). */
    let carry: Buffer[] = [];

    const take = (buf: Buffer, offset: number) => {
      const items = parseLine(buf, offset, vendor);
      if (items.length === 0) return;
      for (const it of items) {
        if (it.k === "res") results.add(it.id);
        if (it.k !== "use" || !results.has(it.id)) count++;
      }
      lines.push(items);
    };

    while (pos > 0 && count < want && scanned < STREAM_SCAN_BYTES) {
      const len = Math.min(STREAM_CHUNK_BYTES, pos, STREAM_SCAN_BYTES - scanned);
      pos -= len;
      scanned += len;
      const chunk = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fd.read(chunk, got, len - got, pos + got);
        if (n === 0) break;
        got += n;
      }
      let end = got;
      while (end > 0 && count < want) {
        const nl = chunk.lastIndexOf(NEWLINE, end - 1);
        if (nl === -1) break;
        take(Buffer.concat([chunk.subarray(nl + 1, end), ...carry]), pos + nl + 1);
        carry = [];
        end = nl;
      }
      carry.unshift(chunk.subarray(0, end));
    }
    // The file's first line, complete once the read reached offset 0.
    if (pos === 0 && count < want) {
      take(Buffer.concat(carry), 0);
      firstTaken = true;
    }

    const items = lines.reverse().flat();
    const older = (id: string): boolean => {
      if (cut === null) return true;
      const [offset = 0, block = 0] = id.split(":").map(Number);
      return offset < Number(cut[1]) || (offset === Number(cut[1]) && block < Number(cut[2]));
    };
    const events = toEvents(items).filter((e) => older(e.id));
    return {
      events: events.slice(-limit),
      truncated: pos > 0 && count < want,
      more: events.length > limit || pos > 0 || (!firstTaken && carry.some((b) => b.length > 0)),
    };
  } finally {
    fd.close();
  }
}

/** "Last output": the later of the newest transcript event and the transcript file's mtime. */
export function lastOutputAt(lastEventAt: number | null, mtimeMs: number | null): number | null {
  if (lastEventAt === null) return mtimeMs;
  if (mtimeMs === null) return lastEventAt;
  return Math.max(lastEventAt, mtimeMs);
}
