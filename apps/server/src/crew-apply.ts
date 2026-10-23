import { statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { type CrewChanges, type PendingSeatChange, type ReloadResult, seatDef } from "@mc/core";
import type { ChangeBus } from "./bus.ts";
import {
  type CcConfig,
  ConfigError,
  type CrewSeatConfig,
  type CrewSessionConfig,
  loadConfig,
  seatInput,
  writerAreaConflict,
} from "./config.ts";
import type { Supervisor } from "./runtime/supervisor.ts";
import type { Store } from "./store.ts";

export const CONFIG_POLL_MS = 5_000;
export const RETIRE_WAIT = "removed; leaves when it is free";
export const EDIT_WAIT = "changed; applies when it is free";
export const accountNewText = (a: string) => `account "${a}" is new; restart the hub to use it`;
export const seatMovingText = (id: string, s: string) => `waits for ${id} to leave s/${s}`;
export const watchWaitText = (id: string) => `waits for ${id} to leave the watch seat`;
export const maxSeatsText = (n: number) => `max_seats ${n} is full until a removed seat leaves`;
export const areaWaitText = (other: string) =>
  `its area overlaps ${other}'s, which has not changed yet`;

const READ_FAILED = "cannot read config.yaml";

export interface CrewPlan {
  /** Per applied session id: the seats to hold now. */
  sessions: Map<string, CrewSeatConfig[]>;
  pending: PendingSeatChange[];
  /** `seat x added|changed|removed|retiring|kept` */
  applied: string[];
  /** Seats whose untaken queue rows go: removed, retiring or changed. */
  drop: string[];
}

/** Deep equality of two seats, ignoring display metadata and `retiring` (a changed `def` counts). */
const same = (a: CrewSeatConfig, b: CrewSeatConfig): boolean =>
  isDeepStrictEqual(
    { ...a, retiring: undefined, displayCallSign: undefined },
    { ...b, retiring: undefined, displayCallSign: undefined },
  );

const withoutRetiring = (seat: CrewSeatConfig): CrewSeatConfig => {
  if (!seat.retiring) return seat;
  const { retiring: _retiring, ...rest } = seat;
  return rest;
};

/**
 * What the applied config should hold for each of its crew sessions to match `target`, and what has
 * to wait. A session matches a target one with the same id, repo and checkout; the others keep
 * their seats. Pure: `busy` says whether a seat is working.
 */
export function planCrew(
  applied: CcConfig,
  target: CcConfig,
  busy: (seatId: string) => boolean,
): CrewPlan {
  const plan: CrewPlan = { sessions: new Map(), pending: [], applied: [], drop: [] };
  const appliedSessions = applied.crew?.sessions ?? [];
  const targetSessions = target.crew?.sessions ?? [];
  const maxSeats = target.crew?.maxSeats ?? 0;
  let total = appliedSessions.reduce((n, s) => n + s.seats.length, 0);

  for (const session of appliedSessions) {
    const t = targetSessions.find(
      (x) => x.id === session.id && x.repoId === session.repoId && x.checkout === session.checkout,
    );
    if (t === undefined) continue;
    const old = new Map(session.seats.map((s) => [s.id, s]));
    const wanted = new Set(t.seats.map((s) => s.id));
    /** What the session holds so far, by seat id. */
    const held = new Map<string, CrewSeatConfig>();
    const retiring: CrewSeatConfig[] = [];
    const edits: CrewSeatConfig[] = [];
    const adds: CrewSeatConfig[] = [];
    const pend = (seatId: string, change: PendingSeatChange["change"], reason: string) =>
      plan.pending.push({ sessionId: session.id, seatId, change, reason });

    // 1. held
    for (const seat of t.seats) {
      const previous = old.get(seat.id);
      let was = previous;
      if (previous && previous.displayCallSign !== seat.displayCallSign) {
        const { displayCallSign: _displayCallSign, ...rest } = previous;
        was = {
          ...rest,
          ...(seat.displayCallSign === undefined ? {} : { displayCallSign: seat.displayCallSign }),
        };
        plan.applied.push(`seat ${seat.id} renamed`);
      }
      if (was === undefined) {
        adds.push(seat);
      } else if (same(was, seat)) {
        held.set(seat.id, withoutRetiring(was));
        if (was.retiring) plan.applied.push(`seat ${seat.id} kept`);
      } else if (busy(seat.id)) {
        held.set(seat.id, withoutRetiring(was));
        pend(seat.id, "edit", EDIT_WAIT);
      } else {
        held.set(seat.id, withoutRetiring(was)); // its old self holds the place until the edit applies
        edits.push(seat);
      }
    }
    // 2. removed
    for (const was of session.seats) {
      if (wanted.has(was.id)) continue;
      plan.drop.push(was.id);
      if (busy(was.id)) {
        retiring.push({ ...was, retiring: true });
        pend(was.id, "remove", RETIRE_WAIT);
        if (!was.retiring) plan.applied.push(`seat ${was.id} retiring`);
      } else {
        total--;
        plan.applied.push(`seat ${was.id} removed`);
      }
    }
    // 3. candidates: free edits, then additions
    const others = () => [...held.values(), ...retiring];
    const overlapping = (seat: CrewSeatConfig): string | null => {
      for (const w of others()) {
        if (w.id !== seat.id && writerAreaConflict([w, seat]) !== null) return w.id;
      }
      return null;
    };
    for (const seat of [...edits, ...adds]) {
      const isAdd = !old.has(seat.id);
      const change = isAdd ? "add" : "edit";
      if (!applied.accounts.some((a) => a.id === seat.accountId)) {
        pend(seat.id, change, accountNewText(seat.accountId));
        continue;
      }
      if (isAdd) {
        const elsewhere = appliedSessions.find(
          (s) => s.id !== session.id && s.seats.some((x) => x.id === seat.id),
        );
        if (elsewhere !== undefined) {
          pend(seat.id, change, seatMovingText(seat.id, elsewhere.id));
          continue;
        }
        if (total >= maxSeats) {
          pend(seat.id, change, maxSeatsText(maxSeats));
          continue;
        }
      }
      if (seatDef(seat).loop === "watch") {
        const rival = [
          ...others(),
          ...appliedSessions.filter((x) => x.id !== session.id).flatMap((x) => x.seats),
        ].find((w) => w.id !== seat.id && seatDef(w).loop === "watch");
        if (rival !== undefined) {
          pend(seat.id, change, watchWaitText(rival.id));
          continue;
        }
      }
      const other = overlapping(seat);
      if (other !== null) {
        pend(seat.id, change, areaWaitText(other));
        continue;
      }
      held.set(seat.id, seat);
      if (isAdd) {
        total++;
        plan.applied.push(`seat ${seat.id} added`);
      } else {
        plan.applied.push(`seat ${seat.id} changed`);
        plan.drop.push(seat.id);
      }
    }
    // 4. order: target order, then the retiring ones in their old order
    const seats = t.seats.flatMap((s) => {
      const h = held.get(s.id);
      return h === undefined ? [] : [h];
    });
    plan.sessions.set(session.id, [...seats, ...retiring]);
  }
  return plan;
}

const lists = (c: CcConfig["crew"]) => c?.sessions.map((s) => [s.id, s.repoId, s.checkout]);

/** Config keys that differ and only apply after a restart. */
export function restartNeeded(applied: CcConfig, target: CcConfig): string[] {
  const out: string[] = [];
  for (const key of ["operator", "accounts", "repos", "loops", "poll"] as const) {
    if (!isDeepStrictEqual(applied[key], target[key])) out.push(key);
  }
  const a = applied.crew;
  const b = target.crew;
  if (a === undefined || b === undefined) {
    if (a !== b) out.push("crew");
    return out;
  }
  if (!isDeepStrictEqual(a.worktrees, b.worktrees)) out.push("crew.worktrees");
  if (!isDeepStrictEqual(a.node, b.node)) out.push("crew.node");
  if (!isDeepStrictEqual(a.denyRead, b.denyRead)) out.push("crew.deny_read");
  if (!isDeepStrictEqual(a.runTokenBudget, b.runTokenBudget)) out.push("crew.run_token_budget");
  if (!isDeepStrictEqual(lists(a), lists(b))) out.push("crew.sessions");
  return out;
}

export interface CrewReloader {
  start(): void;
  stop(): void;
  /** Reads config.yaml now and applies what it can; never throws. */
  reload(): Promise<ReloadResult>;
  /** Applies what waited for a seat to be free; returns what it did. */
  settle(): string[];
  status(): CrewChanges;
}

interface FileStat {
  mtimeMs: number;
  size: number;
  ino: number;
}

export function createCrewReloader(deps: {
  configPath: string;
  config: CcConfig;
  store: Store;
  bus: ChangeBus;
  supervisor: Pick<Supervisor, "on" | "seatBusy">;
  now?: () => number;
  log?: (line: string) => void;
  /** Default `loadConfig`. */
  load?: (path: string) => CcConfig;
}): CrewReloader {
  const { configPath, config, store, bus, supervisor } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => process.stderr.write(`crew: ${line}\n`));
  const load = deps.load ?? loadConfig;

  /** The last good load. */
  let target: CcConfig = structuredClone(config);
  let last: FileStat | null = null;
  let error: string | null = null;
  let checkedAt: number | null = null;
  let pending: PendingSeatChange[] = [];
  let restart: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let off: (() => void) | undefined;

  const statFile = (): FileStat => {
    const s = statSync(configPath);
    return { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino };
  };

  const status = (): CrewChanges => ({
    sessions: (target.crew?.sessions ?? []).map((s) => ({
      id: s.id,
      seats: s.seats.map(seatInput),
    })),
    pending,
    restartNeeded: restart,
    error,
    checkedAt,
  });

  const setError = (next: string | null) => {
    if (next === error) return;
    error = next;
    bus.emit("config");
  };

  const busy = (seatId: string): boolean => {
    try {
      return (
        supervisor.seatBusy(seatId) ||
        store.queue(seatId).some((q) => q.takenAt !== null) ||
        // an aside run has no process or seat row, but the seat is working
        store.asideRuns().some((r) => r.agentId === seatId)
      );
    } catch {
      return true;
    }
  };

  function settle(): string[] {
    try {
      const plan = planCrew(config, target, busy);
      const nextRestart = restartNeeded(config, target);
      // all reads are done: from here nothing awaits, and the swap is last
      if (plan.drop.length > 0) {
        store.replaceQueues([...new Set(plan.drop)].map((seatId) => ({ seatId, items: [] })));
      }
      for (const [id, seats] of plan.sessions) {
        const session: CrewSessionConfig | undefined = config.crew?.sessions.find(
          (s) => s.id === id,
        );
        session?.seats.splice(0, session.seats.length, ...seats);
      }
      if (config.crew !== undefined && target.crew !== undefined) {
        config.crew.roles = target.crew.roles;
        config.crew.maxSeats = target.crew.maxSeats;
        config.crew.maxOpenRunsPerSeat = target.crew.maxOpenRunsPerSeat;
        if (target.crew.lane === undefined) delete config.crew.lane;
        else config.crew.lane = target.crew.lane;
        config.crew.laneDefault = target.crew.laneDefault ?? false;
      }
      const changed =
        !isDeepStrictEqual(pending, plan.pending) || !isDeepStrictEqual(restart, nextRestart);
      pending = plan.pending;
      restart = nextRestart;
      if (plan.applied.length > 0 || changed) {
        bus.emit("config");
        bus.emit("agents");
      }
      return plan.applied;
    } catch (e) {
      log(`could not apply config.yaml: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  async function readAndApply(): Promise<ReloadResult> {
    checkedAt = now();
    try {
      last = statFile();
    } catch {
      last = null;
    }
    let loaded: CcConfig;
    try {
      loaded = load(configPath);
    } catch (e) {
      setError(e instanceof ConfigError ? e.message : READ_FAILED);
      return { ...status(), applied: [] };
    }
    target = loaded;
    setError(null);
    const applied = settle();
    return { ...status(), applied };
  }

  function reload(): Promise<ReloadResult> {
    const run = chain.then(readAndApply, readAndApply);
    chain = run;
    return run;
  }

  function poll(): void {
    let seen: FileStat;
    try {
      seen = statFile();
    } catch {
      last = null;
      setError(READ_FAILED);
      return;
    }
    if (
      last === null ||
      seen.mtimeMs !== last.mtimeMs ||
      seen.size !== last.size ||
      seen.ino !== last.ino
    ) {
      void reload();
    } else if (pending.length > 0) {
      settle();
    }
  }

  return {
    start() {
      if (timer !== undefined) return;
      try {
        last = statFile();
      } catch {
        last = null;
      }
      timer = setInterval(poll, CONFIG_POLL_MS);
      timer.unref();
      off = supervisor.on((e) => {
        if (e.kind === "run-ended") settle();
      });
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      off?.();
      off = undefined;
    },
    reload,
    settle,
    status,
  };
}
