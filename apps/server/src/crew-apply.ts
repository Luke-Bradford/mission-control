import { statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { type CrewChanges, type PendingSeatChange, type ReloadResult, seatDef } from "@mc/core";
import type { ChangeBus } from "./bus.ts";
import {
  type CcConfig,
  ConfigError,
  type CrewSeatConfig,
  type CrewSessionConfig,
  flightPowersOf,
  isInside,
  loadConfig,
  realish,
  seatInput,
  writerAreaConflict,
} from "./config.ts";
import { ConfigWriteError, noSessionText, sessionActiveText } from "./config-write.ts";
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
  // Free removals across every session release their identity and capacity before additions.
  const remaining = appliedSessions.map((session) => {
    const next = targetSessions.find(
      (x) => x.id === session.id && x.repoId === session.repoId && x.checkout === session.checkout,
    );
    return {
      ...session,
      seats: session.seats.filter(
        (seat) => next === undefined || next.seats.some((s) => s.id === seat.id) || busy(seat.id),
      ),
    };
  });
  let total = remaining.reduce((n, s) => n + s.seats.length, 0);

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
      if (was && was.focus !== seat.focus) {
        was = { ...was, focus: seat.focus };
        plan.applied.push(`seat ${seat.id} focus changed`);
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
        const elsewhere = remaining.find(
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
          ...remaining.filter((x) => x.id !== session.id).flatMap((x) => x.seats),
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
    // `flight_powers` reloads live (`settle` copies it), so it never asks for a restart
    const strip = (c: CcConfig) =>
      key === "repos" ? c.repos.map(({ flightPowers: _p, ...rest }) => rest) : c[key];
    if (!isDeepStrictEqual(strip(applied), strip(target))) out.push(key);
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
  if (!isDeepStrictEqual(a.allowRead, b.allowRead)) out.push("crew.allow_read");
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
  /** Holds live removal across the save; a failed save restores the exact session. */
  removeSession?<T extends { config: CcConfig }>(
    id: string,
    save: (stopped: (id: string) => boolean, session: CrewSessionConfig) => Promise<T>,
  ): Promise<T>;
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
  supervisor: Pick<Supervisor, "on" | "seatBusy" | "holdsCrewLock" | "endRemovedAside">;
  /** The watch rotates FLIGHT between turns, outside its crash restart limit. */
  rotateFlight?: () => void;
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
  let removing = false;
  let settling = false;

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
      const removed = !(target.crew?.sessions ?? []).some((s) =>
        s.seats.some((seat) => seat.id === seatId),
      );
      const run = store.seatRun(seatId);
      return (
        supervisor.seatBusy(seatId) ||
        (run?.endedAt === null && !(removed && run.loop?.aside)) ||
        store.queue(seatId).some((q) => q.takenAt !== null) ||
        // an aside run has no process or seat row, but the seat is working
        (!removed && store.asideRuns().some((r) => r.agentId === seatId))
      );
    } catch {
      return true;
    }
  };

  function settle(): string[] {
    if (removing || settling) return [];
    settling = true;
    // Guards read powers per call. Apply them even if unrelated crew edits cannot settle.
    const powersApplied: string[] = [];
    try {
      for (const repo of config.repos) {
        const next = flightPowersOf(target, repo.id);
        if ((repo.flightPowers ?? "standard") === next) continue;
        repo.flightPowers = next;
        powersApplied.push(`repo ${repo.id} flight_powers ${next}`);
      }
      if (powersApplied.length > 0) {
        // Refresh the session's context after its turn; permissions already changed above.
        deps.rotateFlight?.();
        bus.emit("config");
        bus.emit("agents");
      }
      // A newly created session has no agents or runtime state to migrate.
      if (
        config.crew &&
        target.crew &&
        isDeepStrictEqual(config.loops, target.loops) &&
        config.crew.worktrees === target.crew.worktrees &&
        isDeepStrictEqual(config.crew.denyRead, target.crew.denyRead) &&
        isDeepStrictEqual(config.crew.allowRead, target.crew.allowRead)
      ) {
        for (const session of target.crew.sessions) {
          if (
            session.seats.length === 0 &&
            config.crew.sessions.every((s) => s.seats.every((seat) => !busy(seat.id))) &&
            !config.crew.sessions.some((s) => s.id === session.id) &&
            config.repos.some((r) => r.id === session.repoId) &&
            config.crew.sessions.every(
              (s) =>
                !isInside(realish(s.checkout), realish(session.checkout)) &&
                !isInside(realish(session.checkout), realish(s.checkout)),
            )
          ) {
            config.crew.sessions.push(structuredClone(session));
            powersApplied.push(`session ${session.id} added`);
            bus.emit("config");
          }
        }
      }
      const plan = planCrew(config, target, busy);
      const nextRestart = restartNeeded(config, target);
      // all reads are done: from here nothing awaits, and the swap is last
      if (plan.drop.length > 0) {
        store.replaceQueues([...new Set(plan.drop)].map((seatId) => ({ seatId, items: [] })));
      }
      const held = new Set(
        (config.crew?.sessions ?? []).flatMap((s) =>
          (plan.sessions.get(s.id) ?? s.seats).map((seat) => seat.id),
        ),
      );
      const wanted = new Set(
        (target.crew?.sessions ?? []).flatMap((s) => s.seats.map((seat) => seat.id)),
      );
      const removed = new Set(
        [
          ...(config.crew?.sessions ?? []).flatMap((s) => s.seats.map((seat) => seat.id)),
          ...store.openQuestions().map((q) => q.agentId),
          ...store.notes().flatMap((n) => (n.seatId === null ? [] : [n.seatId])),
          ...store.asideRuns().map((r) => r.agentId),
        ].filter((id) => !held.has(id) && !wanted.has(id)),
      );
      const at = now();
      for (const seatId of removed) {
        if (!supervisor.holdsCrewLock?.() || supervisor.seatBusy(seatId)) continue;
        const open = store
          .runsActiveSince(Number.MAX_SAFE_INTEGER)
          .filter((run) => run.agentId === seatId && run.endedAt === null);
        // A removed aside may be ended deliberately; every other open run keeps its attention.
        if (open.some((run) => !run.loop?.aside)) continue;
        for (const run of open) {
          if (!supervisor.endRemovedAside?.(run.id)) continue;
          store.addComms({
            at,
            from: "CAPCOM",
            to: seatId,
            ticket: run.ticket,
            text: `Seat ${seatId} removed; ended set-aside run ${run.id}.`,
          });
        }
        if (
          store
            .runsActiveSince(Number.MAX_SAFE_INTEGER)
            .some((run) => run.agentId === seatId && run.endedAt === null)
        )
          continue;
        if (!supervisor.holdsCrewLock?.() || supervisor.seatBusy(seatId)) continue;
        store.answerQuestions(seatId, at);
        for (const note of store.notes()) {
          if (note.seatId === seatId) store.clearNote(note.key, at);
        }
      }
      if (removed.size > 0) {
        bus.emit("attention");
        bus.emit("agents");
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
        config.crew.machineCapacity = structuredClone(target.crew.machineCapacity);
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
      return [...powersApplied, ...plan.applied];
    } catch (e) {
      log(`could not apply config.yaml: ${e instanceof Error ? e.message : String(e)}`);
      return powersApplied;
    } finally {
      settling = false;
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
      settle();
      timer = setInterval(poll, CONFIG_POLL_MS);
      timer.unref();
      off = supervisor.on((e) => {
        if (e.kind === "run-ended") settle();
        // An ended run already settles on run-ended, after its process is released.
        if (e.kind === "seat-free" && store.run(e.runId)?.endedAt == null) settle();
      });
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      off?.();
      off = undefined;
    },
    removeSession(id, save) {
      const run = chain.then(async () => {
        const sessions = config.crew?.sessions;
        const index = sessions?.findIndex((s) => s.id === id) ?? -1;
        const session = sessions?.[index];
        if (!sessions || !session) throw new ConfigWriteError("missing", noSessionText(id));
        const stopped = (seatId: string) =>
          store.seatSession(seatId)?.state === "stopped" && !busy(seatId);
        const active = session.seats.filter((s) => !stopped(s.id)).length;
        if (active) throw new ConfigWriteError("conflict", sessionActiveText(id, active));
        // Removing it synchronously prevents any new supervisor start during the file write.
        removing = true;
        sessions.splice(index, 1);
        let saved = false;
        try {
          const result = await save(stopped, session);
          saved = true;
          target = structuredClone(result.config);
          pending = pending.filter((p) => p.sessionId !== id);
          restart = restartNeeded(config, target);
          store.replaceQueues(session.seats.map((s) => ({ seatId: s.id, items: [] })));
          bus.emit("config");
          bus.emit("agents");
          return result;
        } finally {
          if (!saved) sessions.splice(index, 0, session);
          removing = false;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
    reload,
    settle,
    status,
  };
}
