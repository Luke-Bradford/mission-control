import type { EngineTick } from "@mc/core";
import type { Store } from "../store.ts";

/** How many finished ticks are kept. */
export const TICKS_KEPT = 30;

/** The `/api/health` row that carries the recent ticks. */
export const TICKS_COLLECTOR = "engine:ticks";

/** The engine's tick in progress and its recent history (in memory: a restart starts afresh). */
export interface TickLog {
  begin(at: number): void;
  /** Marks a step the running tick is on; the returned function ends it. No tick running, no mark. */
  step(label: string): () => void;
  /** Ends the running tick. */
  end(at: number): void;
  /** The running tick, with the steps it is on; null between ticks. */
  running(): { startedAt: number; steps: string[] } | null;
  /** Notes that the running tick passed its interval; returns its steps the first time only. */
  overrun(): string[] | null;
  recent(): EngineTick[];
  /** The newest tick that overran and its steps, for a tick that has since ended. */
  lastOverrun(): EngineTick | null;
}

function createTickLog(): TickLog {
  let current: { startedAt: number; steps: Map<symbol, string>; overran: string[] | null } | null =
    null;
  const done: EngineTick[] = [];
  const stepsOf = (c: NonNullable<typeof current>): string[] => [...c.steps.values()];
  return {
    begin(at) {
      current = { startedAt: at, steps: new Map(), overran: null };
    },
    step(label) {
      const tick = current;
      if (tick === null) return () => {};
      const id = Symbol(label);
      tick.steps.set(id, label);
      return () => {
        tick.steps.delete(id);
      };
    },
    end(at) {
      if (current === null) return;
      done.push({
        startedAt: current.startedAt,
        endedAt: at,
        durationMs: at - current.startedAt,
        overranOn: current.overran,
      });
      if (done.length > TICKS_KEPT) done.shift();
      current = null;
    },
    running() {
      return current === null ? null : { startedAt: current.startedAt, steps: stepsOf(current) };
    },
    overrun() {
      if (current === null || current.overran !== null) return null;
      current.overran = stepsOf(current);
      return current.overran;
    },
    recent: () => [...done],
    lastOverrun: () => done.findLast((t) => t.overranOn !== null) ?? null,
  };
}

const logs = new WeakMap<Store, TickLog>();

/** The store's tick log: the engine writes it, the health route and the FLIGHT signals read it. */
export function tickLogOf(store: Store): TickLog {
  let log = logs.get(store);
  if (log === undefined) {
    log = createTickLog();
    logs.set(store, log);
  }
  return log;
}

/** What a stuck engine was doing, for a log line or a signal's evidence; null when it is not known. */
export function overrunText(startedAt: number, steps: string[]): string {
  return `tick started ${new Date(startedAt).toISOString()} still running; on ${steps.length === 0 ? "no step" : steps.join(", ")}`;
}
