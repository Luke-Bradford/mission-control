import { existsSync, globSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type CrewVendor,
  MAP_RECENT_MS,
  type MapCall,
  type MapChange,
  type MapDelta,
  type MapTests,
  namesOnly,
} from "@mc/core";
import { cleanText } from "../clean.ts";
import { codexTool, transcriptVendor } from "../codex-transcript.ts";
import { isObj, type Json, timeOf } from "../streamjson.ts";
import { offsetSince, readNewLines } from "../tail.ts";
import { originalBytes } from "../util.ts";
import { SeatDiff } from "./diff.ts";

/** How long the ring keeps a finished call: as long as the map shows it on a seat's path. */
const KEEP_MS = MAP_RECENT_MS;
const POLL_MS = 1000;
type DeltaPayload<T = MapDelta> = T extends MapDelta ? Omit<T, "seq"> : never;
export interface RingSource {
  id: string;
  seat: string;
  repoId: string;
  cwd: string;
  transcriptPath: string;
  vendor?: CrewVendor;
  turnScoped?: boolean;
  current?: boolean;
}
export interface RingCall extends MapCall {
  id: string;
  runId: string;
  repoId: string;
  end: number | null;
  resultSize: number;
  resultTok: number;
  writeTok?: number;
  error: boolean;
  refused: boolean;
  why: string | null;
  tests: MapTests | null;
  churn: MapChange[];
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const lines = (s: string): number =>
  s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
function resultText(v: unknown): string {
  return Array.isArray(v)
    ? v
        .filter(isObj)
        .filter((b) => b.type === "text")
        .map((b) => text(b.text))
        .join("\n")
    : text(v);
}
function tests(output: string): MapTests {
  // Strip terminal colouring without truncating: the summary may be at the end of a large result.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: runner ANSI colouring.
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const summary = [...plain.matchAll(/^\s*Tests\s+(.+)$/gm)].at(-1)?.[1];
  if (!summary) return { runner: null, status: "unknown" };
  const passed = Number(summary.match(/(\d+) passed/)?.[1] ?? 0);
  const failed = Number(summary.match(/(\d+) failed/)?.[1] ?? 0);
  if (!passed && !failed) return { runner: null, status: "unknown" };
  return { runner: "vitest", status: failed ? "failed" : "passed", passed, failed };
}

interface RunScope {
  read: string[];
  /** Edit churn from the run's Edit and Write calls: never the branch's real change. */
  modified: MapChange[];
  /** file → when a call last edited it. */
  touched: Record<string, number>;
  /** Each edit's churn and time, so churn can be counted since a commit rather than for the run. */
  edits: { file: string; add: number; rem: number; at: number }[];
  editedAt: number;
  tests: { tests: MapTests; at: number } | null;
}

/** Raw payload measurements stay separate from the cleaned strings exposed to the map. */
export class CallRing {
  private runScopes = new Map<string, RunScope>();

  scope(runId: string): RunScope {
    return structuredClone(
      this.runScopes.get(runId) ?? {
        read: [],
        modified: [],
        touched: {},
        edits: [],
        editedAt: 0,
        tests: null,
      },
    );
  }

  private rows = new Map<string, RingCall[]>();
  private stats = new Map<string, boolean>();
  private tails = new Map<string, { offset: number; path: string }>();
  private sources: () => RingSource[];
  private sequences = new Map<string, number>();
  private listeners = new Map<string, Set<(delta: MapDelta) => void>>();
  private diffs = new Map<string, { source: RingSource; diff: SeatDiff }>();
  /** Runs no longer current whose transcript has been read to its end: not polled again. */
  private settled = new Set<string>();
  /** Per repo: deltas published and calls aged out; with the diffs' reads, what `revision` counts. */
  private changes = new Map<string, number>();
  private wake: (() => void) | null = null;

  constructor(sources: () => RingSource[]) {
    this.sources = sources;
  }

  sequence(repoId: string): number {
    return this.sequences.get(repoId) ?? 0;
  }

  /**
   * Moves whenever something the map shows from this ring changes: a delta published, a call aged
   * out, a branch diff read. A cache keyed on it is valid until it moves.
   */
  revision(repoId: string): number {
    let reads = 0;
    for (const e of this.diffs.values()) if (e.source.repoId === repoId) reads += e.diff.reads();
    return (this.changes.get(repoId) ?? 0) + reads;
  }

  /** True while any map client listens for deltas. */
  hasClients(): boolean {
    return this.listeners.size > 0;
  }

  subscribe(repoId: string, fn: (delta: MapDelta) => void): () => void {
    const listeners = this.listeners.get(repoId) ?? new Set();
    const first = !this.hasClients();
    this.listeners.set(repoId, listeners);
    listeners.add(fn);
    if (first) this.wake?.();
    return () => {
      listeners.delete(fn);
      if (!listeners.size) {
        this.listeners.delete(repoId);
        this.wake?.();
      }
    };
  }

  private touch(repoId: string): void {
    this.changes.set(repoId, (this.changes.get(repoId) ?? 0) + 1);
  }

  private publish(repoId: string, delta: DeltaPayload): void {
    const seq = this.sequence(repoId) + 1;
    this.sequences.set(repoId, seq);
    this.touch(repoId);
    for (const listener of [...(this.listeners.get(repoId) ?? [])]) {
      try {
        listener({ ...delta, seq });
      } catch {
        // One disconnected client must not interrupt the transcript fold.
      }
    }
  }

  private edits(source: RingSource, call: RingCall, previous: MapChange[] = []): void {
    const changes = new Map<string, { add: number; rem: number }>();
    for (const [churn, sign] of [
      [call.churn, 1],
      [previous, -1],
    ] as const) {
      for (const { file, add, rem } of churn) {
        const total = changes.get(file) ?? { add: 0, rem: 0 };
        total.add += sign * add;
        total.rem += sign * rem;
        changes.set(file, total);
      }
    }
    for (const [file, { add, rem }] of changes)
      if (add || rem)
        this.publish(source.repoId, {
          type: "edit",
          seat: source.seat,
          sourceId: source.id,
          file,
          add,
          rem,
        });
  }

  /**
   * The run's real branch change (`git diff --numstat` from its merge base to the worktree, cached
   * per HEAD and index), or null while it is unread or unavailable.
   */
  diff(runId: string): MapChange[] | null {
    return this.diffs.get(runId)?.diff.changes() ?? null;
  }

  /** The branch that diff was read on: the worktree's checkout, which may be a later run's. */
  diffBranch(runId: string): string | null {
    return this.diffs.get(runId)?.diff.branch() ?? null;
  }

  /** The worktree's untracked, unignored files, read with that diff; null while unknown. */
  untracked(runId: string): string[] | null {
    return this.diffs.get(runId)?.diff.untracked() ?? null;
  }

  calls(seat: string): RingCall[] {
    return structuredClone(this.rows.get(seat) ?? []);
  }

  modified(seat: string, repoId?: string): MapChange[] {
    const entries = [...this.diffs.values()].filter(
      (e) => e.source.seat === seat && (repoId === undefined || e.source.repoId === repoId),
    );
    const entry = entries.find((e) => e.source.current) ?? entries.at(-1);
    const real = entry?.diff.changes();
    if (real != null) return real;
    const churn = new Map<string, MapChange>();
    for (const call of this.rows.get(seat) ?? []) {
      if (entry && call.runId !== entry.source.id) continue;
      for (const change of call.churn) {
        const previous = churn.get(change.file);
        churn.set(change.file, {
          ...change,
          add: (previous?.add ?? 0) + change.add,
          rem: (previous?.rem ?? 0) + change.rem,
        });
      }
    }
    return [...churn.values()];
  }

  scopes(repoId: string): { seat: string; scope: { modified: MapChange[] } }[] {
    const seats = new Set(
      [...this.diffs.values()].filter((e) => e.source.repoId === repoId).map((e) => e.source.seat),
    );
    return [...seats].map((seat) => ({ seat, scope: { modified: this.modified(seat, repoId) } }));
  }

  /** Polls every second while a map client is connected. */
  start(): () => void {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const schedule = () => {
      clearTimeout(timer);
      if (stopped) return;
      if (!this.hasClients()) return;
      timer = setTimeout(() => {
        this.poll();
        schedule();
      }, POLL_MS);
      timer.unref();
    };
    this.wake = schedule;
    schedule();
    return () => {
      stopped = true;
      this.wake = null;
      clearTimeout(timer);
    };
  }

  private readTail(source: RingSource, now: number): void {
    let tail = this.tails.get(source.id);
    if (!tail || tail.path !== source.transcriptPath) {
      // after a restart only the window the map shows is read, not the transcript from its start
      tail = {
        offset: offsetSince(source.transcriptPath, now - KEEP_MS),
        path: source.transcriptPath,
      };
      this.tails.set(source.id, tail);
    }
    if (source.current === false) this.settled.add(source.id);
    else this.settled.delete(source.id);
    for (;;) {
      const next = readNewLines(source.transcriptPath, tail.offset);
      if (next.reset) {
        this.runScopes.delete(source.id);
        this.rows.set(
          source.seat,
          (this.rows.get(source.seat) ?? []).filter((c) => c.runId !== source.id),
        );
        this.publish(source.repoId, { type: "invalidate" });
      }
      for (const line of next.lines) {
        try {
          const ev: unknown = JSON.parse(line);
          if (isObj(ev)) this.fold(source, ev, now);
        } catch {
          // Partial and non-JSON frames carry no calls.
        }
      }
      if (next.nextOffset === tail.offset) break;
      tail.offset = next.nextOffset;
    }
  }

  poll(): void {
    const now = Date.now();
    this.stats.clear();
    const sources = this.sources();
    for (const source of sources) {
      // a finished run is read once more, then only its diff is kept fresh
      if (!(source.current === false && this.settled.has(source.id))) this.readTail(source, now);
      let entry = this.diffs.get(source.id);
      if (!entry || entry.source.cwd !== source.cwd) {
        entry = {
          source,
          diff: new SeatDiff(() => this.publish(source.repoId, { type: "invalidate" })),
        };
        this.diffs.set(source.id, entry);
      }
      entry.source = source;
      const revision = (this.rows.get(source.seat) ?? [])
        .filter((c) => c.runId === source.id && (c.writeTok !== undefined || c.tool === "Bash"))
        .map((c) => `${c.runId}:${c.id}:${c.end}:${c.churn.length}`)
        .join("|");
      entry.diff.poll(source.cwd, revision);
    }
    for (const [seat, calls] of this.rows) {
      const kept = calls.filter((c) => c.end === null || c.end >= now - KEEP_MS);
      if (kept.length < calls.length)
        for (const repoId of new Set(calls.map((c) => c.repoId))) this.touch(repoId);
      if (kept.length) this.rows.set(seat, kept);
      else this.rows.delete(seat);
    }
    const active = new Set(sources.map((s) => s.id));
    for (const id of this.tails.keys()) {
      if (!active.has(id)) {
        this.tails.delete(id);
        this.settled.delete(id);
        this.runScopes.delete(id);
      }
    }
    for (const id of this.diffs.keys()) if (!active.has(id)) this.diffs.delete(id);
  }

  private safe(s: string): string {
    return cleanText(
      s
        .split(`${homedir()}/`)
        .join("~/")
        .replace(/\/(?:Users|home)\/[^/\s]+\//g, "~/"),
    );
  }

  // one stat per path per poll: folders are never tracked, only files
  private isFile(absolute: string): boolean {
    let known = this.stats.get(absolute);
    if (known === undefined) {
      try {
        known = statSync(absolute).isFile();
      } catch {
        known = false;
      }
      this.stats.set(absolute, known);
    }
    return known;
  }

  private file(source: RingSource, value: unknown, existing = false): string | null {
    if (typeof value !== "string" || !value) return null;
    const absolute = resolve(source.cwd, value);
    const path = relative(source.cwd, absolute);
    if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) return null;
    if (existsSync(absolute)) {
      try {
        if (!this.isFile(absolute)) return null;
        const real = relative(realpathSync(source.cwd), realpathSync(absolute));
        if (real === ".." || real.startsWith("../") || isAbsolute(real)) return null;
      } catch {
        return null;
      }
    } else if (existing) return null;
    return this.safe(path);
  }

  private glob(source: RingSource, input: Json): string[] {
    const base = resolve(source.cwd, text(input.path) || ".");
    const pattern = text(input.pattern);
    if (!pattern) return [];
    try {
      for (const path of [
        relative(source.cwd, base),
        relative(realpathSync(source.cwd), realpathSync(base)),
      ]) {
        if (path === ".." || path.startsWith("../") || isAbsolute(path)) return [];
      }
      if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) return [];
      return globSync(pattern, { cwd: base })
        .filter((path) => statSync(resolve(base, path)).isFile())
        .map((path) => this.file(source, resolve(base, path), true))
        .filter((path): path is string => path !== null);
    } catch {
      return [];
    }
  }

  private begin(
    source: RingSource,
    id: string,
    tool: string,
    input: Json,
    at: number,
    changes?: unknown,
  ): RingCall {
    const calls = this.rows.get(source.seat) ?? [];
    this.rows.set(source.seat, calls);
    const found = calls.find((c) => c.runId === source.id && c.id === id);
    if (found && (!changes || found.end !== null)) return found;
    const paths = [
      input.file_path,
      input.notebook_path,
      ...(tool === "Glob" ? this.glob(source, input) : [input.path]),
      ...(Array.isArray(input.paths) ? input.paths : []),
    ];
    if (tool === "Bash")
      paths.push(
        ...(text(input.command).match(/[^\s'"`|;&()<>]+/g) ?? []).map((p) =>
          p.replace(/:\d+(?::\d+)?$/, ""),
        ),
      );
    const files = [
      ...new Set(
        paths
          .map((p) => this.file(source, p, tool === "Bash"))
          .filter((p): p is string => p !== null),
      ),
    ];
    const churn: MapChange[] = [];
    let written = tool === "NotebookEdit" ? text(input.new_source).length : 0;
    const edits =
      tool === "MultiEdit" && Array.isArray(input.edits) ? input.edits.filter(isObj) : [input];
    if (["Edit", "Write", "MultiEdit"].includes(tool) && files[0] && !changes) {
      for (const edit of edits) {
        const content = tool === "Write" ? text(edit.content) : text(edit.new_string);
        written += content.length;
        churn.push({
          file: files[0],
          add: lines(content),
          rem: tool === "Write" ? 0 : lines(text(edit.old_string)),
          source: "churn",
        });
      }
    }
    if (Array.isArray(changes)) {
      for (const change of changes.filter(isObj)) {
        const file = this.file(source, change.path);
        if (!file) continue;
        let add = 0;
        let rem = 0;
        const diff = text(change.diff);
        let inHunk = !diff.includes("@@");
        let added = false;
        for (const line of diff.split("\n")) {
          if (line.startsWith("@@")) {
            inHunk = true;
            added = false;
            continue;
          }
          if (!inHunk) continue;
          if (line.startsWith("\\ No newline")) {
            if (added) written--;
            added = false;
            continue;
          }
          added = line.startsWith("+");
          if (added) {
            add++;
            written += line.slice(1).length + 1;
          }
          if (line.startsWith("-")) rem++;
        }
        churn.push({ file, add, rem, source: "churn" });
      }
    }
    const call: RingCall = {
      id,
      runId: source.id,
      repoId: source.repoId,
      tool: this.safe(tool),
      detail: this.safe(text(input.command) || files[0] || text(input.pattern) || tool),
      files,
      since: at,
      end: null,
      resultSize: 0,
      resultTok: 0,
      error: false,
      refused: false,
      why: null,
      tests: null,
      churn,
      ...(["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)
        ? { writeTok: Math.ceil(written / 4) }
        : {}),
    };
    if (found) {
      const previous = found.churn;
      found.files = call.files;
      found.churn = call.churn;
      found.writeTok = call.writeTok;
      found.detail = call.detail;
      this.edits(source, found, previous);
      return found;
    }
    calls.push(call);
    this.publish(source.repoId, {
      type: "call.start",
      sourceId: source.id,
      id: JSON.stringify([call.runId, call.id]),
      since: call.since,
      seat: source.seat,
      tool: call.tool,
      detail: call.detail,
      files: call.files,
      ...(call.writeTok === undefined ? {} : { writeTok: call.writeTok }),
    });
    this.edits(source, call);
    return call;
  }

  private finish(
    source: RingSource,
    id: string,
    output: string,
    error: boolean,
    refused: boolean,
    at: number,
    original: number | null = null,
  ): void {
    const call = this.rows.get(source.seat)?.find((c) => c.runId === source.id && c.id === id);
    if (!call || call.end !== null) return;
    call.end = at;
    // a result the transcript holds cut is as long as it was, not as long as what is kept
    const size = original ?? output.length;
    call.resultSize = size;
    call.resultTok = Math.ceil(size / 4);
    call.refused = refused;
    call.error = error && !refused;
    call.why =
      call.error || refused
        ? this.safe(output) || (refused ? "Permission denied" : "Tool failed")
        : null;
    call.tests = call.tool === "Bash" ? tests(output) : null;
    const scope = this.runScopes.get(source.id) ?? {
      read: [],
      modified: [],
      touched: {},
      edits: [],
      editedAt: 0,
      tests: null,
    };
    this.runScopes.set(source.id, scope);
    if (!error && !refused) {
      // a name-only listing (Glob) opened none of its files: they aren't read
      if (call.writeTok === undefined && !namesOnly(call.tool))
        scope.read = [...new Set([...scope.read, ...call.files])];
      for (const change of call.churn) {
        const previous = scope.modified.find((c) => c.file === change.file);
        if (previous) {
          previous.add += change.add;
          previous.rem += change.rem;
        } else scope.modified.push({ ...change });
        scope.touched[change.file] = Math.max(scope.touched[change.file] ?? 0, call.since);
        scope.edits.push({ ...change, at: call.since });
        if (scope.edits.length > 2000) scope.edits.shift();
        scope.editedAt = Math.max(scope.editedAt, call.since);
      }
    }
    if (
      call.tests &&
      !refused &&
      (call.tests.runner !== null ||
        /\b(?:test|tests|pytest|jest|vitest|mocha)\b/.test(call.detail)) &&
      at >= (scope.tests?.at ?? 0)
    )
      scope.tests = { tests: call.tests, at };
    this.publish(source.repoId, {
      type: "call.end",
      sourceId: source.id,
      id: JSON.stringify([call.runId, call.id]),
      at,
      seat: source.seat,
      files: call.files,
      resultTok: call.resultTok,
      error: call.error,
      refused: call.refused,
      why: call.why,
      tests: call.tests,
    });
    if (call.writeTok !== undefined && !error && !refused)
      this.publish(source.repoId, { type: "invalidate" });
  }

  private fold(source: RingSource, ev: Json, now: number): void {
    const at = timeOf(ev.timestamp) ?? now;
    if (
      source.turnScoped &&
      (ev.type === "result" || ev.method === "turn/completed" || ev.method === "turn/started")
    ) {
      this.touch(source.repoId);
      this.runScopes.delete(source.id);
      this.rows.set(
        source.seat,
        (this.rows.get(source.seat) ?? []).filter((c) => c.runId !== source.id),
      );
      return;
    }

    if (transcriptVendor(ev, source.vendor) === "codex") {
      const p = isObj(ev.params) ? ev.params : {};
      if (!isObj(p.item)) return;
      const item = p.item;
      const tool = codexTool(item);
      if (!tool || typeof item.id !== "string") return;
      const input: unknown = tool.input ? JSON.parse(tool.input) : {};
      if (ev.method === "item/started" || ev.method === "item/completed") {
        this.begin(
          source,
          item.id,
          tool.name,
          isObj(input) ? input : {},
          at,
          item.type === "fileChange" ? item.changes : undefined,
        );
        if (ev.method === "item/completed")
          this.finish(
            source,
            item.id,
            tool.result,
            tool.error,
            item.status === "declined",
            at,
            tool.originalBytes,
          );
      }
      return;
    }
    if (ev.parent_tool_use_id != null) return;
    if (ev.type === "system" && ev.subtype === "permission_denied") {
      this.finish(
        source,
        text(ev.tool_use_id),
        text(ev.message) || text(ev.reason),
        false,
        true,
        at,
      );
      return;
    }
    const message = isObj(ev.message) ? ev.message : {};
    if (!Array.isArray(message.content)) return;
    for (const block of message.content.filter(isObj)) {
      if (ev.type === "assistant" && block.type === "tool_use" && typeof block.id === "string")
        this.begin(source, block.id, text(block.name), isObj(block.input) ? block.input : {}, at);
      if (ev.type === "user" && block.type === "tool_result") {
        const output = resultText(block.content);
        this.finish(
          source,
          text(block.tool_use_id),
          output,
          block.is_error === true,
          false,
          at,
          originalBytes(block, output.length),
        );
      }
    }
  }
}
