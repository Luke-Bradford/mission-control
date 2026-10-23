import type { TestLockState } from "@mc/core";
import type { ChangeBus, Topic } from "../bus.ts";
import type { LockHoldRow } from "../store.ts";

/**
 * What a lock change touches: its own state and the guard resources ("guard"), the lock
 * Needs-you item ("attention") and the crew table's "in line for the test lock" ("agents").
 */
export const LOCK_TOPICS: readonly Topic[] = ["guard", "attention", "agents"];

/** The `onChange` that tells every LOCK_TOPICS subscriber. */
export const lockChanged = (bus: ChangeBus) => (): void => {
  for (const t of LOCK_TOPICS) bus.emit(t);
};

/** One tool call: the run it belongs to and the model's tool_use id. */
export interface LockKey {
  runId: string;
  toolUseId: string;
}

/** Where the lock's holds are kept across a restart (the Store). */
export interface LockHolds {
  addLockHold(h: LockHoldRow): void;
  deleteLockHold(runId: string, toolUseId: string, at?: number): void;
  deleteLockHolds(runId: string, at?: number): void;
}

interface Holder {
  runId: string;
  seatId: string;
  command: string;
  since: number;
  /** The run's calls that hold it; the lock is free once the last one is released. */
  calls: Set<string>;
}

interface Waiter {
  key: LockKey;
  seatId: string;
  command: string;
  since: number;
  signal: AbortSignal;
  settle: (granted: boolean) => void;
}

/**
 * The test lock: one full suite at a time across every seat (spec §5, catalogue §5.5). One run
 * holds it, oldest waiter first. The holder's run re-entering (a parallel call) is granted at once.
 * A call releases with its own tool_use id (the Post hooks); `releaseRun` frees a run that ended or
 * was interrupted, whose calls fire no Post (spike 2026-10-21).
 */
export class TestLock {
  private holder: Holder | null = null;
  private readonly waiting: Waiter[] = [];
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly holds: LockHolds | undefined;
  private readonly log: (msg: string) => void;

  /** `onChange` runs after the holder or the queue changed (the HUD refetches on it). */
  constructor(
    opts: {
      now?: () => number;
      onChange?: () => void;
      holds?: LockHolds;
      log?: (msg: string) => void;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange ?? (() => {});
    this.holds = opts.holds;
    this.log = opts.log ?? (() => {});
  }

  /** Puts back holds stored by an earlier hub (at start, before anything acquires). */
  restore(rows: readonly LockHoldRow[]): void {
    const first = rows[0];
    if (first === undefined || this.holder !== null || this.waiting.length > 0) return;
    this.holder = {
      runId: first.runId,
      seatId: first.seatId,
      command: first.command,
      since: first.since,
      calls: new Set(rows.filter((r) => r.runId === first.runId).map((r) => r.toolUseId)),
    };
    for (const other of new Set(rows.map((r) => r.runId))) {
      if (other !== first.runId) this.store((s) => s.deleteLockHolds(other, this.now()));
    }
    this.onChange();
  }

  /**
   * Resolves true once `key` holds the lock, false after `waitMs` or once `signal` aborts (the
   * hook hung up). A waiter whose signal has aborted is never granted.
   */
  acquire(
    key: LockKey,
    seatId: string,
    command: string,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.holder === null) {
      this.hold(key, seatId, command);
      this.onChange();
      return Promise.resolve(true);
    }
    if (this.holder.runId === key.runId) {
      this.holder.calls.add(key.toolUseId);
      this.storeAdd(this.holder, key.toolUseId, this.now());
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const drop = () => {
        const i = this.waiting.indexOf(waiter);
        if (i !== -1) this.waiting.splice(i, 1);
      };
      const onAbort = () => {
        drop();
        waiter.settle(false);
        this.onChange();
      };
      const timer = setTimeout(onAbort, waitMs);
      const waiter: Waiter = {
        key,
        seatId,
        command,
        since: this.now(),
        signal,
        settle: (granted) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(granted);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
      this.onChange();
    });
  }

  /** The call `key` ended: frees the lock when it was the run's last holding call. */
  release(key: LockKey): void {
    const h = this.holder;
    if (h === null || h.runId !== key.runId || !h.calls.delete(key.toolUseId)) return;
    this.store((s) => s.deleteLockHold(key.runId, key.toolUseId, this.now()));
    if (h.calls.size === 0) {
      this.grantNext();
      this.onChange();
    }
  }

  /** The run ended or was interrupted: frees its hold and drops its waiting calls. */
  releaseRun(runId: string): void {
    let changed = false;
    for (const w of this.waiting.filter((x) => x.key.runId === runId)) {
      this.waiting.splice(this.waiting.indexOf(w), 1);
      w.settle(false);
      changed = true;
    }
    if (this.holder?.runId === runId) {
      this.store((s) => s.deleteLockHolds(runId, this.now()));
      this.grantNext();
      changed = true;
    }
    if (changed) this.onChange();
  }

  state(): TestLockState {
    const h = this.holder;
    return {
      holder:
        h === null
          ? null
          : { runId: h.runId, seatId: h.seatId, command: h.command, since: h.since },
      waiting: this.waiting.map((w) => ({ runId: w.key.runId, seatId: w.seatId, since: w.since })),
    };
  }

  private hold(key: LockKey, seatId: string, command: string, queuedAt = this.now()): Holder {
    this.holder = {
      runId: key.runId,
      seatId,
      command,
      since: this.now(),
      calls: new Set([key.toolUseId]),
    };
    this.storeAdd(this.holder, key.toolUseId, this.holder.since, queuedAt);
    return this.holder;
  }

  private storeAdd(h: Holder, toolUseId: string, since: number, queuedAt = since): void {
    this.store((s) =>
      s.addLockHold({
        runId: h.runId,
        toolUseId,
        seatId: h.seatId,
        command: h.command,
        since,
        queuedAt,
      }),
    );
  }

  /** Runs a store call; the lock never depends on it succeeding. */
  private store(f: (s: LockHolds) => void): void {
    if (this.holds === undefined) return;
    try {
      f(this.holds);
    } catch (e) {
      this.log(`test lock: could not store a hold: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Hands the lock to the oldest live waiter, with its run's other waiting calls. */
  private grantNext(): void {
    this.holder = null;
    for (;;) {
      const next = this.waiting.shift();
      if (next === undefined) return;
      if (next.signal.aborted) {
        next.settle(false);
        continue;
      }
      const h = this.hold(next.key, next.seatId, next.command, next.since);
      next.settle(true);
      for (const w of this.waiting.filter((x) => x.key.runId === h.runId)) {
        this.waiting.splice(this.waiting.indexOf(w), 1);
        if (w.signal.aborted) {
          w.settle(false);
          continue;
        }
        h.calls.add(w.key.toolUseId);
        this.storeAdd(h, w.key.toolUseId, this.now(), w.since);
        w.settle(true);
      }
      return;
    }
  }
}
