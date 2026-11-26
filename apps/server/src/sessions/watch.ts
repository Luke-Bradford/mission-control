/**
 * Watch mode: hub code, not an agent, reads every cmux session and tells the operator in Needs you
 * when one starts waiting on him, or goes from working to idle. One note per change: an unchanged
 * state raises nothing, and a first sight raises nothing.
 */
import {
  type FlightMode,
  SESSION_NOTE_PREFIX,
  SESSION_WATCH_MS,
  sessionFinishedText,
  sessionWaitingText,
} from "@mc/core";
import type { ChangeBus } from "../bus.ts";
import type { Store } from "../store.ts";
import type { SessionsService } from "./sessions.ts";

/** The part of the Sessions service the watch reads. */
export type WatchedSessions = Pick<SessionsService, "view">;

export interface SessionWatch {
  start(): void;
  stop(): void;
  /** One read and its notes; the timer calls it every SESSION_WATCH_MS. */
  check(): Promise<void>;
}

export function createSessionWatch(deps: {
  sessions: WatchedSessions;
  store: Store;
  bus: ChangeBus;
  mode: () => FlightMode;
  now?: () => number;
  log?: (line: string) => void;
}): SessionWatch {
  const { sessions, store, bus } = deps;
  const now = deps.now ?? Date.now;
  /** Each session's state at the last read, kept only while in watch mode. */
  const last = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  // true at first, so a hub that starts outside watch mode clears notes an earlier one left
  let watching = true;

  const key = (id: string) => `${SESSION_NOTE_PREFIX}${id}`;
  const note = (id: string, kind: "question" | "flag", text: string, at: number) =>
    store.refreshNote({ key: key(id), kind, runId: null, seatId: null, repoId: null, text, at });

  /** Leaving watch mode forgets every state and clears every session note. */
  function standDown(at: number): void {
    last.clear();
    let cleared = false;
    for (const n of store.notes()) {
      if (!n.key.startsWith(SESSION_NOTE_PREFIX)) continue;
      store.clearNote(n.key, at);
      cleared = true;
    }
    if (cleared) bus.emit("attention");
  }

  async function check(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const t = now();
      if (deps.mode() !== "watch") {
        if (watching) standDown(t);
        watching = false;
        return;
      }
      watching = true;
      const view = await sessions.view();
      // a failed read says nothing about any session
      if (!view.ok || deps.mode() !== "watch") return;
      let changed = false;
      const seen = new Set<string>();
      for (const row of view.sessions) {
        seen.add(row.id);
        const before = last.get(row.id);
        last.set(row.id, row.state);
        if (before === undefined || before === row.state) continue;
        if (row.state === "waiting") {
          note(row.id, "question", sessionWaitingText(row.name), t);
          changed = true;
        } else if (before === "working" && row.state === "idle") {
          note(row.id, "flag", sessionFinishedText(row.name), t);
          changed = true;
        } else if (row.state === "working") {
          store.clearNote(key(row.id), t);
          changed = true;
        }
      }
      for (const id of [...last.keys()]) {
        if (seen.has(id)) continue;
        last.delete(id);
        store.clearNote(key(id), t);
        changed = true;
      }
      if (changed) bus.emit("attention");
    } catch (e) {
      deps.log?.(`session watch: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => void check(), SESSION_WATCH_MS);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    check,
  };
}
