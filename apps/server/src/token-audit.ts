import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  type RunTokenAudit,
  TOKEN_REWRITE_MIN_WRITE,
  TOKEN_REWRITE_READ_RATIO,
  TOKEN_SOURCE_HUB_LINE,
  TOKEN_SOURCE_OWN_OUTPUT,
  TOKEN_SOURCE_START,
  TOKEN_SOURCE_UNATTRIBUTED,
  type TokenCall,
  type TokenCounts,
} from "@mc/core";
import { type CcConfig, findHubRoot } from "./config.ts";
import { crewDirPath, type Store } from "./store.ts";
import { isObj, STREAM_EVENT_PREFIX } from "./streamjson.ts";
import { GZ_MAX_INFLATED_BYTES } from "./transcript-file.ts";

/** The tool whose first call marks the end of a run's real work. */
export const REPORT_EVIDENCE_TOOL = "mcp__mc__report_evidence";
/** About 4 characters of text per token, to share a call's growth between what arrived. */
const CHARS_PER_TOKEN = 4;
const COMMAND_MAX = 40;
const AUDIT_BATCH = 25;
const LINES_PER_YIELD = 2000;
/** A pass stops starting new runs after this long. */
export const TOKEN_AUDIT_BUDGET_MS = 20_000;
/** How far back the pass looks for ended runs it has not read. */
export const TOKEN_AUDIT_LOOKBACK_MS = 365 * 86_400_000;
/** A controller session file untouched this long is a finished session. */
const CONTROLLER_IDLE_MS = 60 * 60_000;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isTop = (ev: Record<string, unknown>): boolean =>
  ev.parent_tool_use_id === null || ev.parent_tool_use_id === undefined;

/** A Bash command's first word, or `pnpm <script>`; a leading `cd <dir> &&` says nothing. */
export function commandClass(command: string): string {
  const cmd = command.trim().replace(/^(cd\s+\S+\s*(&&|;)\s*)+/, "");
  const words = cmd.split(/\s+/).filter((w) => w !== "");
  const first = words[0];
  if (first === undefined) return "(empty)";
  if (first === "pnpm" || first === "npm" || first === "npx" || first === "yarn") {
    const rest = words.slice(1).filter((w) => !w.startsWith("-"));
    const script = rest[0] === "run" || rest[0] === "exec" || rest[0] === "dlx" ? rest[1] : rest[0];
    return `${first} ${script ?? ""}`.trim().slice(0, COMMAND_MAX);
  }
  return first.slice(0, COMMAND_MAX);
}

interface Incoming {
  source: string;
  command: string | null;
  chars: number;
}
interface Call extends TokenCall {
  id: string;
  /** What arrived since the previous call. */
  incoming: Incoming[];
  /** Characters of the previous call's own output (text, thinking, tool input). */
  prevOwnChars: number;
}

const bump = (map: Record<string, TokenCounts>, name: string, added: number, left: number) => {
  const c = map[name] ?? { added: 0, reread: 0, events: 0 };
  map[name] = c;
  c.added += added;
  c.reread += added * left;
  c.events += 1;
};

/** One run's transcript, folded line by line so a large one can be read in chunks. */
export class TranscriptAuditor {
  private calls: Call[] = [];
  private byId = new Map<string, Call>();
  private pending = new Map<string, { name: string; command: string | null }>();
  private incoming: Incoming[] = [];
  private ownChars = 0;
  private reportCall: number | null = null;
  private resultOutput: number | null = null;

  push(line: string): void {
    if (!line.startsWith("{") || line.startsWith(STREAM_EVENT_PREFIX)) return;
    if (!line.includes('"message"') && !line.includes('"type":"result"')) return;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(ev)) return;
    if (ev.type === "result") {
      if (isObj(ev.usage) && typeof ev.usage.output_tokens === "number") {
        this.resultOutput = (this.resultOutput ?? 0) + ev.usage.output_tokens;
      }
      return;
    }
    if (!isTop(ev)) return;
    const msg = isObj(ev.message) ? ev.message : null;
    if (msg === null) return;
    const content: unknown[] = Array.isArray(msg.content) ? msg.content : [];
    if (ev.type === "assistant") this.assistant(msg, content);
    else if (ev.type === "user") this.user(msg.content, content);
  }

  private assistant(msg: Record<string, unknown>, content: unknown[]): void {
    const id = typeof msg.id === "string" ? msg.id : null;
    if (id === null || !isObj(msg.usage)) return;
    const u = msg.usage;
    let call = this.byId.get(id);
    if (call === undefined) {
      const cacheRead = num(u.cache_read_input_tokens);
      const cacheWrite = num(u.cache_creation_input_tokens);
      call = {
        id,
        context: num(u.input_tokens) + cacheRead + cacheWrite,
        cacheRead,
        cacheWrite,
        output: 0,
        added: [],
        incoming: this.incoming,
        prevOwnChars: this.ownChars,
      };
      this.calls.push(call);
      this.byId.set(id, call);
      this.incoming = [];
      this.ownChars = 0;
    }
    call.output = Math.max(call.output, num(u.output_tokens));
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === "tool_use") {
        const name = typeof b.name === "string" ? b.name : "(unnamed)";
        const input = isObj(b.input) ? b.input : {};
        this.ownChars += JSON.stringify(input).length;
        const useId = typeof b.id === "string" ? b.id : null;
        if (useId !== null) {
          const command =
            name === "Bash" && typeof input.command === "string" ? input.command : null;
          this.pending.set(useId, {
            name,
            command: command === null ? null : commandClass(command),
          });
        }
        if (name === REPORT_EVIDENCE_TOOL && this.reportCall === null) {
          this.reportCall = this.calls.length - 1;
        }
      } else if (b.type === "text" && typeof b.text === "string") {
        this.ownChars += b.text.length;
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        this.ownChars += b.thinking.length;
      }
    }
  }

  private user(raw: unknown, content: unknown[]): void {
    if (typeof raw === "string") {
      this.incoming.push({ source: TOKEN_SOURCE_HUB_LINE, command: null, chars: raw.length });
      return;
    }
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === "text" && typeof b.text === "string") {
        this.incoming.push({ source: TOKEN_SOURCE_HUB_LINE, command: null, chars: b.text.length });
      } else if (b.type === "tool_result") {
        const useId = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
        const use = useId === null ? undefined : this.pending.get(useId);
        if (useId !== null) this.pending.delete(useId);
        const body = b.content;
        const chars =
          typeof body === "string"
            ? body.length
            : Array.isArray(body)
              ? body.reduce(
                  (n: number, x) =>
                    n + (isObj(x) && typeof x.text === "string" ? x.text.length : 0),
                  0,
                )
              : 0;
        this.incoming.push({
          source: (use?.name ?? "(unknown tool)").replace("mcp__mc__", "mc "),
          command: use?.command ?? null,
          chars: Math.max(chars, 1),
        });
      }
    }
  }

  finish(): { audit: RunTokenAudit; calls: TokenCall[] } {
    const n = this.calls.length;
    const bySource: Record<string, TokenCounts> = {};
    const byCommand: Record<string, TokenCounts> = {};
    let rewrites = 0;
    let rewriteTokens = 0;
    this.calls.forEach((c, i) => {
      const left = n - i;
      const add = (source: string, tokens: number, command: string | null = null) => {
        if (tokens <= 0) return;
        c.added.push({ source, command, tokens });
        bump(bySource, source, tokens, left);
        if (command !== null) bump(byCommand, command, tokens, left);
      };
      const prev = this.calls[i - 1];
      if (prev === undefined) {
        add(TOKEN_SOURCE_START, c.context);
        return;
      }
      if (
        c.cacheWrite > TOKEN_REWRITE_MIN_WRITE &&
        c.cacheRead < TOKEN_REWRITE_READ_RATIO * prev.context
      ) {
        rewrites += 1;
        rewriteTokens += c.cacheWrite;
      }
      const delta = c.context - prev.context;
      // A context that shrank was compacted or reset: nothing was added.
      if (delta <= 0) return;
      const own = Math.min(delta, Math.floor(c.prevOwnChars / CHARS_PER_TOKEN));
      add(TOKEN_SOURCE_OWN_OUTPUT, own);
      const rest = delta - own;
      if (c.incoming.length === 0) {
        add(TOKEN_SOURCE_UNATTRIBUTED, rest);
        return;
      }
      const total = c.incoming.reduce((s, x) => s + x.chars, 0);
      let given = 0;
      c.incoming.forEach((x, k) => {
        const share =
          k === c.incoming.length - 1 ? rest - given : Math.floor((rest * x.chars) / total);
        given += share;
        add(x.source, share, x.command);
      });
    });
    const contexts = this.calls.map((c) => c.context).sort((a, b) => a - b);
    const cacheRead = this.calls.reduce((s, c) => s + c.cacheRead, 0);
    const readAfterReport =
      this.reportCall === null
        ? null
        : this.calls.slice(this.reportCall + 1).reduce((s, c) => s + c.cacheRead, 0);
    const calls: TokenCall[] = this.calls.map((c) => ({
      context: c.context,
      cacheRead: c.cacheRead,
      cacheWrite: c.cacheWrite,
      output: c.output,
      added: c.added,
    }));
    return {
      calls,
      audit: {
        calls: n,
        peakContext: contexts.at(-1) ?? 0,
        medianContext: contexts[n >> 1] ?? 0,
        cacheRead,
        cacheWrite: this.calls.reduce((s, c) => s + c.cacheWrite, 0),
        // The CLI's own count, from its result events; the streamed per-call figure is only a part.
        output: this.resultOutput ?? this.calls.reduce((s, c) => s + c.output, 0),
        rewrites,
        rewriteTokens,
        readAfterReport,
        bySource,
        byCommand,
      },
    };
  }
}

/** The audit of a whole transcript (its lines, in order). */
export function auditTranscript(lines: Iterable<string>) {
  const a = new TranscriptAuditor();
  for (const line of lines) a.push(line);
  return a.finish();
}

/** What the pass reads from disk; the default is the real file system. Tests record the paths. */
export interface AuditFiles {
  read(path: string): Promise<Buffer | null>;
  list(dir: string): Promise<string[]>;
  mtimeMs(path: string): Promise<number | null>;
}

export const realAuditFiles: AuditFiles = {
  read: async (path) => {
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  },
  list: async (dir) => {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  },
  mtimeMs: async (path) => {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return null;
    }
  },
};

const gunzipAsync = promisify(gunzip);
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A transcript's text, plain or gzip sibling; null when missing or too large. */
async function readText(files: AuditFiles, path: string): Promise<string | null> {
  const plain = await files.read(path);
  if (plain !== null) return plain.length > GZ_MAX_INFLATED_BYTES ? null : plain.toString("utf8");
  const zipped = await files.read(`${path}.gz`);
  if (zipped === null) return null;
  try {
    const data = await gunzipAsync(zipped, { maxOutputLength: GZ_MAX_INFLATED_BYTES });
    return data.toString("utf8");
  } catch {
    return null;
  }
}

/** Folds `text` line by line, giving the event loop back every few thousand lines. */
async function foldText<T>(text: string, push: (line: string) => void, done: () => T): Promise<T> {
  let from = 0;
  let count = 0;
  while (from < text.length) {
    let to = text.indexOf("\n", from);
    if (to === -1) to = text.length;
    push(text.slice(from, to));
    from = to + 1;
    if (++count % LINES_PER_YIELD === 0) await yieldLoop();
  }
  return done();
}

const EMPTY_AUDIT: RunTokenAudit = {
  calls: 0,
  peakContext: 0,
  medianContext: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  rewrites: 0,
  rewriteTokens: 0,
  readAfterReport: null,
  bySource: {},
  byCommand: {},
};

/** The Claude Code folder name for a checkout: every character but letters and digits is a dash. */
export const claudeProjectSlug = (checkout: string): string =>
  checkout.replace(/[^A-Za-z0-9]/g, "-");

/** One assistant message's usage numbers from a controller session file; no text is kept. */
export interface ControllerMessage {
  id: string;
  at: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** The distinct assistant messages of one session file, each once (the larger output wins). */
export async function controllerMessages(text: string, fallbackAt: number) {
  const seen = new Map<string, ControllerMessage>();
  await foldText(
    text,
    (line) => {
      if (!line.startsWith("{") || !line.includes('"usage"')) return;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObj(ev) || ev.type !== "assistant" || !isObj(ev.message) || !isObj(ev.message.usage))
        return;
      const id = typeof ev.message.id === "string" ? ev.message.id : null;
      if (id === null) return;
      const u = ev.message.usage;
      const prev = seen.get(id);
      const at = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : Number.NaN;
      seen.set(id, {
        id,
        at: prev?.at ?? (Number.isFinite(at) ? at : fallbackAt),
        input: num(u.input_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheWrite: num(u.cache_creation_input_tokens),
        output: Math.max(num(u.output_tokens), prev?.output ?? 0),
      });
    },
    () => undefined,
  );
  return [...seen.values()];
}

export interface TokenAuditPassSummary {
  audited: number;
  empty: number;
  controllerSessions: number;
}

/**
 * Reads each ended run's transcript once and stores where its tokens went (parse once per run,
 * after it ends). Only a transcript in the hub's own crew folder is read; any other run (an
 * observed loop, a Codex run, a missing file) is stored as an empty audit, so it is never retried.
 * With `config.audit.controllerSessions` on, usage numbers of finished controller sessions on the
 * crew's checkouts are read from `home`'s Claude Code session folder; off, nothing outside the
 * data folder is listed or read.
 */
export async function auditEndedRuns(i: {
  store: Store;
  config: CcConfig;
  now: number;
  files?: AuditFiles;
  home?: string;
  budgetMs?: number;
  clock?: () => number;
}): Promise<TokenAuditPassSummary> {
  const files = i.files ?? realAuditFiles;
  const clock = i.clock ?? (() => performance.now());
  const start = clock();
  const budget = i.budgetMs ?? TOKEN_AUDIT_BUDGET_MS;
  const dir = crewDirPath(i.store.path);
  const out: TokenAuditPassSummary = { audited: 0, empty: 0, controllerSessions: 0 };
  outer: while (clock() - start < budget) {
    const batch = i.store.runsToAuditTokens(i.now - TOKEN_AUDIT_LOOKBACK_MS, AUDIT_BATCH);
    if (batch.length === 0) break;
    for (const run of batch) {
      if (clock() - start >= budget) break outer;
      let result: ReturnType<TranscriptAuditor["finish"]> | null = null;
      if (run.vendor !== "codex" && run.transcriptPath === `${dir}/${run.id}.jsonl`) {
        try {
          const text = await readText(files, run.transcriptPath);
          if (text !== null) {
            const a = new TranscriptAuditor();
            result = await foldText(
              text,
              (l) => a.push(l),
              () => a.finish(),
            );
          }
        } catch {
          result = null;
        }
      }
      if (result === null || result.audit.calls === 0) {
        i.store.saveRunTokenAudit(run.id, i.now, EMPTY_AUDIT, []);
        out.empty += 1;
      } else {
        i.store.saveRunTokenAudit(run.id, i.now, result.audit, result.calls);
        out.audited += 1;
      }
      await yieldLoop();
    }
  }
  if (i.config.audit?.controllerSessions === true) {
    out.controllerSessions = await readControllerSessions({ ...i, files, clock, start, budget });
  }
  return out;
}

async function readControllerSessions(i: {
  store: Store;
  config: CcConfig;
  now: number;
  files: AuditFiles;
  home?: string;
  clock: () => number;
  start: number;
  budget: number;
}): Promise<number> {
  // The controller works in the operator's own checkout of this repo (the hub's), not in the
  // crew's clones or worktrees, so that is the folder Claude Code keeps its sessions under.
  const checkout = i.config.audit?.controllerCheckout ?? findHubRoot();
  if (checkout == null) return 0;
  const dir = join(i.home ?? homedir(), ".claude", "projects", claudeProjectSlug(checkout));
  // Session files, and each session's subagent files; (path, session id)
  const found: { path: string; session: string }[] = [];
  for (const name of await i.files.list(dir)) {
    if (name.endsWith(".jsonl")) {
      found.push({ path: join(dir, name), session: name.slice(0, -".jsonl".length) });
    } else {
      const sub = join(dir, name, "subagents");
      for (const f of await i.files.list(sub)) {
        if (f.endsWith(".jsonl")) found.push({ path: join(sub, f), session: name });
      }
    }
  }
  let stored = 0;
  for (const { path, session } of found) {
    if (i.clock() - i.start >= i.budget) break;
    const mtime = await i.files.mtimeMs(path);
    // A file still being written is read once it has been idle; one read before is read again if it grew.
    if (mtime === null || i.now - mtime < CONTROLLER_IDLE_MS) continue;
    if (i.store.controllerFileMtime(path) === mtime) continue;
    const buf = await i.files.read(path);
    if (buf === null || buf.length > GZ_MAX_INFLATED_BYTES) continue;
    const messages = await controllerMessages(buf.toString("utf8"), mtime);
    i.store.saveControllerMessages(session, messages);
    i.store.markControllerFile(path, mtime);
    stored += 1;
  }
  return stored;
}
