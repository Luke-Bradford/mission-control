import {
  cutAtWord,
  isObj,
  LIVE_DETAIL_MAX,
  type LiveTask,
  leadSentence,
  MC_MCP_SERVER,
  type Run,
  type RunDigest,
  type SubagentInfo,
  type TokenUsage,
  workSummary,
} from "@mc/core";
import { cleanText } from "./clean.ts";
import { str } from "./util.ts";

export interface TranscriptFacts {
  sessionId: string | null;
  model: string | null;
  permissionMode: string | null;
  branch: string | null;
  costUsd: number | null;
  tokens: TokenUsage;
  resultCount: number;
  isError: boolean;
  rateLimits: { window: "5h" | "7d"; utilization: number; resetsAt: number; at: number }[];
  digest: RunDigest;
  /** GitHub PRs from `code_change_published`, each once, in first-seen order. */
  prs: Run["prs"];
  /** workSummary of the latest `result` line's text (a result without text keeps the last one). */
  summary: string | null;
}

// Token de-dup state (last-seen usage per message id). Kept out of the public facts shape so
// facts stay plain/serialisable; it travels with the facts object across incremental folds.
const seenUsage = new WeakMap<TranscriptFacts, Map<string, TokenUsage>>();

// Where the current branch came from. `vcs_state_changed` is preferred; `code_change_published`
// is the fallback (studio fires never emit the former with a branch). Travels with the facts.
const branchSources = new WeakMap<
  TranscriptFacts,
  { vcs: string | null; published: string | null }
>();

const WINDOWS = { five_hour: "5h", seven_day: "7d" } as const;

const MC_TOOL_PREFIX = `mcp__${MC_MCP_SERVER}__`;
const MINUTE_MS = 60_000;
/** minuteTokens covers the hour up to the newest event. */
const MINUTES_WINDOW_MS = 60 * MINUTE_MS;
const TURN_USAGE_KEEP = 60;
const DURATIONS_KEEP = 50;
/**
 * How a `stream_event` line starts (most of a TA transcript's bytes): every reader of a transcript
 * or a session's stdout skips it by this prefix, before JSON.parse.
 */
export const STREAM_EVENT_PREFIX = '{"type":"stream_event"';
/**
 * `task_updated` / `task_notification` status → SubagentInfo status; others leave it unchanged.
 * Looked up with Object.hasOwn, so `__proto__` / `constructor` are just unknown statuses.
 */
const TASK_STATUS: Record<string, SubagentInfo["status"]> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  killed: "stopped",
  stopped: "stopped",
};

/**
 * The digest's working state, kept out of the facts like the token de-dup state. Copied on every
 * fold (never mutated in place), so folding on from an earlier facts object stays correct.
 */
interface DigestState {
  tasks: Map<string, LiveTask>;
  taskPatches: Map<string, Json>;
  taskCalls: Map<string, { name: string; input: Json }>;
  appliedTasks: Set<string>;
  lastEventAt: number | null;
  contextTokens: number | null;
  /** contextWindow per model from the latest `result` line. */
  windows: Record<string, number> | null;
  toolCalls: number;
  /**
   * Tool calls without a result yet (every frame): id → name, timestamp, and `live`: a top-level
   * call made since the latest `result` line, so it can be the live tool.
   */
  pending: Map<string, { name: string; at: number | null; live: boolean; detail: string | null }>;
  tools: RunDigest["tools"];
  /** Top-level message id → usage, in first-seen order. */
  turns: Map<string, { input: number; output: number; cacheRead: number }>;
  /** Every frame's message id → its minute bucket and tokens (input + output). */
  usage: Map<string, { minute: number | null; at: number | null; tokens: number }>;
  minutes: Map<number, number>;
  subagents: Map<string, SubagentInfo>;
  /** Subagents whose task_notification (final numbers) has arrived. */
  finals: Set<string>;
  /** Tasks in flight (any task_type), in start order. */
  background: Map<string, RunDigest["background"][number]>;
  /** Top-level `compact_boundary` lines. */
  compactions: number;
  /** The run's working directory, from the `init` line. */
  cwd: string | null;
  /** leadSentence of the newest top-level assistant text block. */
  lastText: string | null;
  /** `all` tokens at the latest `result` line with a numeric cost; null before one. */
  costTokens: number | null;
  /** The newest top-level `user` frame's time since the last top-level assistant message. */
  asked: number | null;
  /** Top-level message id → when it was asked, when its last frame came, its output tokens. */
  replies: Map<
    string,
    { asked: number; firstSeen: boolean; first: number | null; last: number | null; output: number }
  >;
}

const digestStates = new WeakMap<TranscriptFacts, DigestState>();

const emptyDigestState = (): DigestState => ({
  tasks: new Map(),
  taskPatches: new Map(),
  taskCalls: new Map(),
  appliedTasks: new Set(),
  lastEventAt: null,
  contextTokens: null,
  windows: null,
  toolCalls: 0,
  pending: new Map(),
  tools: Object.create(null),
  turns: new Map(),
  usage: new Map(),
  minutes: new Map(),
  subagents: new Map(),
  finals: new Set(),
  background: new Map(),
  compactions: 0,
  cwd: null,
  lastText: null,
  costTokens: null,
  asked: null,
  replies: new Map(),
});

function copyDigestState(d: DigestState): DigestState {
  const tools: DigestState["tools"] = Object.create(null);
  for (const [name, t] of Object.entries(d.tools)) {
    tools[name] = { ...t, durationsMs: [...t.durationsMs] };
  }
  return {
    ...d,
    tasks: new Map([...d.tasks].map(([id, task]) => [id, { ...task }])),
    taskPatches: new Map(d.taskPatches),
    taskCalls: new Map(d.taskCalls),
    appliedTasks: new Set(d.appliedTasks),
    pending: new Map(d.pending),
    tools,
    turns: new Map(d.turns),
    usage: new Map(d.usage),
    minutes: new Map(d.minutes),
    subagents: new Map([...d.subagents].map(([id, s]) => [id, { ...s }])),
    finals: new Set(d.finals),
    background: new Map(d.background),
    replies: new Map([...d.replies].map(([id, r]) => [id, { ...r }])),
  };
}

export type Json = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
/** A transcript string made inert (see cleanText); null when absent or cleaned to nothing. */
const cleanStr = (v: unknown): string | null => {
  const s = str(v);
  return s === null ? null : str(cleanText(s));
};
/** A positive integer, from a number or a string of digits (`identifier` is a string). */
const prNumber = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};
export const timeOf = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};
/** A frame with no (or a null) parent_tool_use_id is the run's own; otherwise a subagent's. */
const isTopLevel = (ev: Json): boolean =>
  ev.parent_tool_use_id === null || ev.parent_tool_use_id === undefined;

function sumTokens(seen: Map<string, TokenUsage>): TokenUsage {
  const t: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const u of seen.values()) {
    t.input += u.input;
    t.output += u.output;
    t.cacheRead += u.cacheRead;
    t.cacheCreate += u.cacheCreate;
  }
  return t;
}

/** The first line of `s` that has anything on it, trimmed; "" when none. */
const firstLine = (s: string): string =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "") ?? "";

/** A command without a leading `cd <cwd>` and its `&&`, `;` or line break, which says nothing about what it does. */
function withoutCd(command: string, cwd: string | null): string {
  if (cwd === null) return command;
  const dir = cwd.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return command.replace(new RegExp(`^\\s*cd\\s+["']?${dir}/?["']?\\s*(?:&&|;|\\n)\\s*`), "");
}

/**
 * What a tool call touches, from its input: a Bash command's first line, a file tool's path
 * (relative to `cwd` when inside it), a search's pattern, an mc tool's own name; else null.
 */
function toolDetail(name: string, input: unknown, cwd: string | null): string | null {
  if (name.startsWith(MC_TOOL_PREFIX)) return str(name.slice(MC_TOOL_PREFIX.length));
  if (!isObj(input)) return null;
  let detail: string | null = null;
  if (name === "Bash") {
    const command = cleanStr(input.command);
    detail = command === null ? null : withoutCd(command, cwd);
  } else if (name === "Read" || name === "Edit" || name === "Write") {
    const path = cleanStr(input.file_path);
    const root = cwd === null ? null : `${cwd.replace(/\/+$/, "")}/`;
    detail =
      path !== null && root !== null && path.startsWith(root) ? path.slice(root.length) : path;
  } else if (name === "Agent" || name === "Task") {
    detail = cleanStr(input.subagent_type) ?? cleanStr(input.description);
  } else if (name === "Grep" || name === "Glob") {
    detail = cleanStr(input.pattern);
  }
  return detail === null ? null : str(cutAtWord(firstLine(detail), LIVE_DETAIL_MAX));
}

function toolStats(d: DigestState, name: string) {
  let t = d.tools[name];
  if (!t) {
    t = { calls: 0, failed: 0, durationsMs: [] };
    d.tools[name] = t;
  }
  return t;
}

/** Task tools belong to the top-level plan, independently of background task notifications. */
function foldTasks(d: DigestState, ev: Json, content: unknown[]): void {
  const status = (v: unknown): LiveTask["status"] | null =>
    v === "completed" || v === "done" ? "done" : v === "in_progress" || v === "pending" ? v : null;
  for (const b of content) {
    if (!isObj(b)) continue;
    if (ev.type === "assistant" && b.type === "tool_use") {
      const id = str(b.id);
      if (id === null || d.appliedTasks.has(id) || !isObj(b.input)) continue;
      const input = b.input;
      if (b.name === "TaskCreate") {
        d.taskCalls.set(id, { name: "TaskCreate", input });
        continue;
      }
      if (b.name === "TaskUpdate") {
        d.taskCalls.set(id, { name: "TaskUpdate", input });
        continue;
      }
      if (b.name === "TodoWrite" && Array.isArray(input.todos)) {
        if (
          input.todos.some(
            (todo) =>
              !isObj(todo) || cleanStr(todo.content) === null || status(todo.status) === null,
          )
        )
          continue;
        const tasks = new Map<string, LiveTask>();
        for (const [i, todo] of input.todos.entries()) {
          if (!isObj(todo)) continue;
          const text = cleanStr(todo.content);
          const st = status(todo.status);
          if (text !== null && st !== null) {
            const taskId = str(todo.id) ?? `todo-${i + 1}`;
            tasks.set(taskId, { id: taskId, text, status: st });
          }
        }
        d.tasks = tasks;
      } else continue;
      d.appliedTasks.add(id);
    } else if (ev.type === "user" && b.type === "tool_result" && b.is_error !== true) {
      const id = str(b.tool_use_id);
      const call = id === null ? undefined : d.taskCalls.get(id);
      if (!call || id === null || d.appliedTasks.has(id)) continue;
      if (call.name === "TaskUpdate") {
        const input = call.input;
        const taskId = str(input.taskId);
        if (taskId === null) continue;
        const task = d.tasks.get(taskId);
        if (!task) {
          d.taskPatches.set(taskId, { ...d.taskPatches.get(taskId), ...input });
        } else if (input.status === "deleted") d.tasks.delete(taskId);
        else
          d.tasks.set(taskId, {
            ...task,
            text: cleanStr(input.subject) ?? task.text,
            status: status(input.status) ?? task.status,
          });
        d.appliedTasks.add(id);
        continue;
      }
      const raw =
        typeof b.content === "string"
          ? b.content
          : Array.isArray(b.content)
            ? b.content
                .filter(isObj)
                .map((x) => str(x.text) ?? "")
                .join("\n")
            : "";
      const taskId = /Task #(\d+) created/.exec(raw)?.[1];
      const text = cleanStr(call.input.subject);
      if (taskId && text !== null) {
        const patch = d.taskPatches.get(taskId);
        if (patch?.status !== "deleted")
          d.tasks.set(taskId, {
            id: taskId,
            text: cleanStr(patch?.subject) ?? text,
            status: status(patch?.status) ?? "pending",
          });
        d.taskPatches.delete(taskId);
        d.appliedTasks.add(id);
      }
    }
  }
}

/** An assistant or user frame's content blocks: tool calls, tool results, usage, timestamps. */
function digestFrame(d: DigestState, ev: Json): void {
  const at = timeOf(ev.timestamp);
  if (at !== null && (d.lastEventAt === null || at > d.lastEventAt)) d.lastEventAt = at;
  const top = isTopLevel(ev);
  const msg = isObj(ev.message) ? ev.message : null;
  const content = msg && Array.isArray(msg.content) ? msg.content : [];

  if (ev.type === "user" && top && at !== null) d.asked = at;
  if (ev.type === "assistant" && top && msg) {
    const id = str(msg.id);
    if (id !== null) {
      let reply = d.replies.get(id);
      // The first frame of a message takes the ask; a message with none is left out.
      if (!reply && !d.turns.has(id) && d.asked !== null) {
        reply = { asked: d.asked, firstSeen: false, first: null, last: null, output: 0 };
        d.replies.set(id, reply);
      }
      if (!d.turns.has(id)) d.asked = null;
      if (reply) {
        if (isObj(msg.usage)) reply.output = num(msg.usage.output_tokens);
        if (
          !reply.firstSeen &&
          content.some(
            (b) =>
              isObj(b) && ((b.type === "text" && str(b.text) !== null) || b.type === "tool_use"),
          )
        ) {
          reply.firstSeen = true;
          if (at !== null && at >= reply.asked) reply.first = at;
        }
        if (at !== null && (reply.last === null || at > reply.last)) reply.last = at;
      }
    }
  }

  if (
    ev.type === "assistant" &&
    msg &&
    isObj(msg.usage) &&
    (numOrNull(msg.usage.input_tokens) !== null || numOrNull(msg.usage.output_tokens) !== null)
  ) {
    const u = msg.usage;
    const input = num(u.input_tokens);
    const output = num(u.output_tokens);
    const cacheRead = num(u.cache_read_input_tokens);
    const id = str(msg.id);
    if (id !== null) {
      const tokens = input + output;
      const prev = d.usage.get(id);
      const minute = prev ? prev.minute : at === null ? null : at - (at % MINUTE_MS);
      if (minute !== null) {
        d.minutes.set(minute, (d.minutes.get(minute) ?? 0) - (prev?.tokens ?? 0) + tokens);
      }
      d.usage.set(id, { minute, at: prev?.at ?? at, tokens });
      if (top) d.turns.set(id, { input, output, cacheRead });
    }
    if (top) d.contextTokens = input + cacheRead + num(u.cache_creation_input_tokens);
  }

  if (top) foldTasks(d, ev, content);

  for (const block of content) {
    if (!isObj(block)) continue;
    if (ev.type === "assistant" && block.type === "tool_use") {
      const id = str(block.id);
      const name = cleanStr(block.name) ?? "(unnamed)";
      if (id === null || d.pending.has(id)) continue;
      d.pending.set(id, { name, at, live: top, detail: toolDetail(name, block.input, d.cwd) });
      toolStats(d, name).calls += 1;
      if (top) d.toolCalls += 1;
    } else if (ev.type === "assistant" && block.type === "text" && top) {
      const text = typeof block.text === "string" ? leadSentence(cleanText(block.text)) : null;
      if (text !== null) d.lastText = text;
    } else if (ev.type === "user" && block.type === "tool_result") {
      const id = str(block.tool_use_id);
      const use = id === null ? undefined : d.pending.get(id);
      if (id === null || !use) continue;
      d.pending.delete(id);
      const t = toolStats(d, use.name);
      if (block.is_error === true) t.failed += 1;
      if (at !== null && use.at !== null) {
        const durationMs = Math.max(0, at - use.at);
        if (t.slowest == null || durationMs > t.slowest.durationMs) {
          t.slowest = { detail: use.detail, durationMs };
        }
        t.durationsMs.push(durationMs);
        if (t.durationsMs.length > DURATIONS_KEEP) t.durationsMs.shift();
      }
    }
  }
}

/**
 * `task_*` system lines. Every task is in flight from `task_started` until its
 * `task_notification` or a `task_updated` with a final status; subagents are the `local_agent`
 * tasks only (`local_bash` is a shell).
 */
function digestTask(d: DigestState, ev: Json): void {
  const taskId = str(ev.task_id);
  if (taskId === null) return;
  const status = (v: unknown) =>
    typeof v === "string" && Object.hasOwn(TASK_STATUS, v) ? TASK_STATUS[v] : undefined;
  if (ev.subtype === "task_started") {
    if (!d.background.has(taskId)) {
      d.background.set(taskId, {
        taskId,
        description: cleanText(typeof ev.description === "string" ? ev.description : ""),
        type: cleanStr(ev.task_type) ?? "task",
      });
    }
    if (ev.task_type !== "local_agent" || d.subagents.has(taskId)) return;
    d.subagents.set(taskId, {
      taskId,
      type: cleanText(str(ev.subagent_type) ?? "agent"),
      description: cleanText(typeof ev.description === "string" ? ev.description : ""),
      status: "running",
      tokens: null,
      toolUses: null,
      durationMs: null,
    });
    return;
  }
  if (ev.subtype === "task_notification") d.background.delete(taskId);
  if (ev.subtype === "task_updated") {
    const s = status(isObj(ev.patch) ? ev.patch.status : null);
    if (s !== undefined && s !== "running") d.background.delete(taskId);
  }
  const sub = d.subagents.get(taskId);
  if (!sub) return;
  const takeUsage = (u: unknown) => {
    if (!isObj(u)) return;
    sub.tokens = numOrNull(u.total_tokens) ?? sub.tokens;
    sub.toolUses = numOrNull(u.tool_uses) ?? sub.toolUses;
    sub.durationMs = numOrNull(u.duration_ms) ?? sub.durationMs;
  };
  if (ev.subtype === "task_progress") {
    if (!d.finals.has(taskId)) takeUsage(ev.usage);
  } else if (ev.subtype === "task_updated") {
    sub.status = status(isObj(ev.patch) ? ev.patch.status : null) ?? sub.status;
  } else if (ev.subtype === "task_notification") {
    sub.status = status(ev.status) ?? sub.status;
    if (isObj(ev.usage)) {
      takeUsage(ev.usage);
      d.finals.add(taskId);
    }
  }
}

function buildDigest(d: DigestState, model: string | null): RunDigest {
  let liveTool: RunDigest["liveTool"] = null;
  for (const use of d.pending.values()) {
    if (!use.live) continue;
    const since = use.at ?? d.lastEventAt;
    if (since !== null) liveTool = { name: use.name, since, detail: use.detail };
  }
  const tools: RunDigest["tools"] = Object.create(null);
  for (const [name, t] of Object.entries(d.tools)) {
    tools[name] = { ...t, durationsMs: [...t.durationsMs] };
  }
  // Buckets that overlap the hour up to lastEventAt, oldest first.
  const from =
    d.lastEventAt === null ? Number.NEGATIVE_INFINITY : d.lastEventAt - MINUTES_WINDOW_MS;
  const minuteTokens = [...d.minutes]
    .filter(([start]) => start + MINUTE_MS > from)
    .sort((a, b) => a[0] - b[0]);
  const window = model !== null && d.windows ? d.windows[model] : undefined;
  return {
    tasks: [...d.tasks.values()].map((task) => ({ ...task })),
    attemptUsage: [...d.usage].map(([id, u]) => ({ id, at: u.at, tokens: u.tokens })),
    toolCalls: d.toolCalls,
    turns: d.turns.size,
    lastEventAt: d.lastEventAt,
    model,
    contextTokens: d.contextTokens,
    contextWindow: window ?? null,
    liveTool,
    lastText: d.lastText,
    tools,
    subagents: [...d.subagents.values()].map((x) => ({ ...x })),
    minuteTokens,
    turnUsage: [...d.turns.values()].slice(-TURN_USAGE_KEEP).map((u) => ({ ...u })),
    background: [...d.background.values()].map((b) => ({ ...b })),
    compactions: d.compactions,
    costTokens: d.costTokens,
    speed: replySpeed(d),
  };
}

/** Output tokens per second and the mean turn time over the replies with an ask and a last frame. */
function replySpeed(d: DigestState): NonNullable<RunDigest["speed"]> {
  let firstMs = 0;
  let firstN = 0;
  let output = 0;
  let ms = 0;
  let n = 0;
  for (const r of d.replies.values()) {
    if (r.first !== null) {
      firstMs += r.first - r.asked;
      firstN += 1;
    }
    if (r.last === null) continue;
    output += r.output;
    ms += Math.max(0, r.last - r.asked);
    n += 1;
  }
  return {
    firstTokenMs: firstN > 0 ? firstMs / firstN : null,
    tokensPerSec: n > 0 && ms > 0 ? output / (ms / 1000) : null,
    turnMs: n > 0 ? ms / n : null,
  };
}

/**
 * Fold new stream-json lines into `prev` (null to start). Returns a new facts object; folding a
 * transcript in several chunks equals folding it at once. Non-JSON and truncated lines are skipped.
 * The token de-dup state is tied to the returned object (WeakMap): facts that are deserialised or
 * object-spread lose it, so callers must then re-fold from offset 0.
 * `fileMtime` stamps rate-limit samples, as the lines themselves carry no timestamp.
 *
 * Lines are read as an allowlist: `assistant`, `user`, `result`, `rate_limit_event` and the
 * `system` subtypes used below; everything else is skipped (`stream_event` — most of a TA
 * transcript's bytes — by its prefix, before JSON.parse). `tool_progress` heartbeats carry no
 * timestamp and are never a subagent's frame: only the file mtime reflects them, so they fold
 * to nothing. The digest (see RunDigest) travels with the facts like the token de-dup state.
 */
export function foldTranscript(
  prev: TranscriptFacts | null,
  lines: string[],
  fileMtime: number,
): TranscriptFacts {
  const facts: TranscriptFacts = prev
    ? { ...prev, rateLimits: [...prev.rateLimits], prs: [...prev.prs] }
    : {
        sessionId: null,
        model: null,
        permissionMode: null,
        branch: null,
        costUsd: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        resultCount: 0,
        isError: false,
        rateLimits: [],
        digest: buildDigest(emptyDigestState(), null),
        prs: [],
        summary: null,
      };
  const seen = new Map((prev && seenUsage.get(prev)) ?? []);
  const src = {
    ...((prev && branchSources.get(prev)) ?? { vcs: prev?.branch ?? null, published: null }),
  };
  let anon = seen.size;
  const prevDigest = prev && digestStates.get(prev);
  const d = prevDigest ? copyDigestState(prevDigest) : emptyDigestState();

  for (const line of lines) {
    if (!line.startsWith("{") || line.startsWith(STREAM_EVENT_PREFIX)) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(ev)) continue;

    if (ev.type === "system") {
      if (ev.subtype === "init") {
        facts.sessionId = str(ev.session_id) ?? facts.sessionId;
        facts.model = cleanStr(ev.model) ?? facts.model;
        facts.permissionMode = str(ev.permissionMode) ?? facts.permissionMode;
        d.cwd = cleanStr(ev.cwd) ?? d.cwd;
      } else if (ev.subtype === "vcs_state_changed") {
        src.vcs = cleanStr(ev.branch) ?? src.vcs;
      } else if (ev.subtype === "code_change_published") {
        src.published = cleanStr(ev.branch) ?? src.published;
        const repo = ev.provider === "github" ? cleanStr(ev.repo) : null;
        const number = prNumber(ev.identifier);
        if (
          repo !== null &&
          number !== null &&
          !facts.prs.some((p) => p.repo === repo && p.number === number)
        ) {
          facts.prs.push({ repo, number });
        }
      } else if (ev.subtype === "compact_boundary") {
        if (isTopLevel(ev)) d.compactions += 1;
      } else if (typeof ev.subtype === "string" && ev.subtype.startsWith("task_")) {
        digestTask(d, ev);
      }
    } else if (ev.type === "rate_limit_event") {
      const windows = isObj(ev.rate_limit_info) ? ev.rate_limit_info.unifiedWindows : null;
      if (!isObj(windows)) continue;
      for (const [key, window] of Object.entries(WINDOWS)) {
        const w = windows[key];
        if (!isObj(w) || typeof w.utilization !== "number" || typeof w.resetsAt !== "number") {
          continue;
        }
        facts.rateLimits.push({
          window,
          utilization: Math.round(w.utilization * 10000) / 100,
          resetsAt: w.resetsAt * 1000,
          at: fileMtime,
        });
      }
    } else if (ev.type === "user") {
      digestFrame(d, ev);
    } else if (ev.type === "assistant") {
      digestFrame(d, ev);
      const msg = ev.message;
      if (!isObj(msg) || !isObj(msg.usage)) continue;
      const u = msg.usage;
      const id = str(msg.id) ?? `anon-${anon++}`;
      seen.set(id, {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheCreate: num(u.cache_creation_input_tokens),
      });
    } else if (ev.type === "result") {
      facts.resultCount += 1;
      if (typeof ev.total_cost_usd === "number") {
        facts.costUsd = ev.total_cost_usd;
        const t = sumTokens(seen);
        d.costTokens = t.input + t.output + t.cacheRead + t.cacheCreate;
      }
      d.asked = null;
      facts.isError = ev.is_error === true;
      if (typeof ev.result === "string") facts.summary = workSummary(cleanText(ev.result));
      // The turn is over: a call still without a result is not live any more. It stays pending,
      // so a late result still records its duration.
      for (const [id, use] of d.pending) if (use.live) d.pending.set(id, { ...use, live: false });
      if (isObj(ev.modelUsage)) {
        const windows: Record<string, number> = Object.create(null);
        for (const [model, mu] of Object.entries(ev.modelUsage)) {
          const w = isObj(mu) ? numOrNull(mu.contextWindow) : null;
          // Keyed like facts.model, which is cleaned.
          if (w !== null) windows[cleanText(model)] = w;
        }
        d.windows = windows;
      }
    }
  }

  facts.branch = src.vcs ?? src.published;
  branchSources.set(facts, src);
  facts.tokens = sumTokens(seen);
  seenUsage.set(facts, seen);
  facts.digest = buildDigest(d, facts.model);
  digestStates.set(facts, d);
  return facts;
}

export { isObj } from "@mc/core";

export { str } from "./util.ts";
