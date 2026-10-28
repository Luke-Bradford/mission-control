/**
 * Keeps FLIGHT running and wakes it. The hub starts the watch seat, restarts it after a hub
 * restart or a crash (at most FLIGHT_STARTS_MAX an hour), gives it a fresh session after
 * FLIGHT_MAX_WAKES wakes, and writes it a digest line, between turns, when what needs FLIGHT
 * changes. The operator's Stop holds. It starts only the watch seat, never another seat or a loop.
 */
import {
  FLIGHT_DEBOUNCE_MS,
  FLIGHT_DOWN_NOTE_KEY,
  FLIGHT_DOWN_STALL_MS,
  FLIGHT_HOUR_MS,
  FLIGHT_MAX_WAKES,
  FLIGHT_MIN_WAKE_GAP_MS,
  FLIGHT_NOTE_KEY,
  FLIGHT_REWAKE_MS,
  FLIGHT_STARTS_MAX,
  FLIGHT_TICK_MS,
  type FlightState,
  flightDownText,
  flightStartFailedText,
  type TestLockState,
  wakeKey,
  wakeLine,
} from "@mc/core";
import { runAccountId } from "../account-bindings.ts";
import type { ChangeBus } from "../bus.ts";
import type { CcConfig } from "../config.ts";
import { accountAtStop } from "../engine/queue.ts";
import { transcriptMtime } from "../hud.ts";
import type { Supervisor } from "../runtime/supervisor.ts";
import type { Store } from "../store.ts";
import { lastOutputAt } from "../stream.ts";
import { markRetrospectiveShown, prepareRetrospective, retrospectiveDue } from "./retrospective.ts";
import { markFlightSignalsShown } from "./signals.ts";
import {
  deliveredFacts,
  type FlightWakeSnapshot,
  flightLive,
  flightSeat,
  flightState,
  flightWake,
  flightWakes,
  markPrsShown,
  operatorItems,
  pending,
  wakeFacts,
} from "./state.ts";

export interface FlightWatchDeps {
  config: CcConfig;
  refreshAuthors?: (repoId: string) => Promise<void>;
  store: Store;
  bus: ChangeBus;
  supervisor: Pick<
    Supervisor,
    "on" | "send" | "seatFacts" | "startWatch" | "endRunByEngine" | "busy" | "status"
  >;
  /** main.ts passes engineOn: off in a preview, with MC_NO_LOOP_WRITES=1, or with no crew. */
  enabled: boolean;
  /** The hub's own `gh` login, to tell another login's draft PRs from its own; null when unread. */
  login?: string | null;
  lockState?: () => TestLockState;
  /** True while the seat has a pending change; FLIGHT is not started until it settles. */
  blocked?: (seatId: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface FlightWatch {
  start(): void;
  stop(): void;
  /** One pass; serialised; never throws. */
  check(): Promise<void>;
  /** Refreshes FLIGHT between turns without consuming a crash restart. */
  rotate(): void;
  /** The full state just returned to this run by flight_state. */
  seen(runId: string, state: FlightState): void;
}

/** Whether any list of a `wakeFacts` string has an entry. */
const hasFacts = (facts: string): boolean =>
  Object.values(JSON.parse(facts) as Record<string, unknown[]>).some((l) => l.length > 0);

/** Describe changes against the same baseline used to decide whether a wake is due. */
export const changedWakeFacts = (previous: string, current: string): string[] => {
  const before = JSON.parse(previous || "{}") as Record<string, unknown[]>;
  const after = JSON.parse(current) as Record<string, unknown[]>;
  return Object.keys(after)
    .filter((key) => JSON.stringify(before[key] ?? []) !== JSON.stringify(after[key]))
    .map((key) => {
      const old = new Set((before[key] ?? []).map((v) => JSON.stringify(v)));
      const current = new Set((after[key] ?? []).map((v) => JSON.stringify(v)));
      const count =
        [...current].filter((v) => !old.has(v)).length +
        [...old].filter((v) => !current.has(v)).length;
      return `${key} (${count})`;
    });
};

export function createFlightWatch(deps: FlightWatchDeps): FlightWatch {
  const { config, store, bus, supervisor, enabled } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  let lastFacts = "";
  let lastWakeAt = 0;
  let delivered: { runId: string; snapshot: FlightWakeSnapshot } | null = null;
  /** When FLIGHT's last turn ended: the gap runs from this too, so a long turn can't wake itself. */
  let lastTurnEndAt = 0;
  let stopped = false;
  /** When FLIGHT itself was started; a rotation is left out. */
  let starts: number[] = [];
  let rotating = false;
  let rotationRequested = false;
  let lastFailure: string | null = null;
  const announced = new Set<string>();
  let preparingDay: string | null = null;
  let attemptedDay: string | null = null;
  let retryAt = 0;
  function prepareDaily(t: number): void {
    const day = retrospectiveDue(config, store, t);
    if (day === null || day === attemptedDay || preparingDay !== null || stopped || t < retryAt)
      return;
    preparingDay = day;
    attemptedDay = day;
    void prepareRetrospective(config, store, t)
      .catch((e) => {
        attemptedDay = null;
        retryAt = now() + FLIGHT_HOUR_MS;
        log(`flight retrospective: ${e instanceof Error ? e.message : e}`);
      })
      .finally(() => {
        preparingDay = null;
        if (!stopped) void check();
      });
  }

  const noteOpen = (): boolean => store.notes().some((n) => n.key === FLIGHT_NOTE_KEY);
  const downOpen = (): boolean => store.notes().some((n) => n.key === FLIGHT_DOWN_NOTE_KEY);
  /** Says FLIGHT is down (parked, at a stop line, silent mid-turn) until it is back. */
  const raiseDown = (seatId: string, repoId: string, reason: string, t: number): void => {
    if (downOpen()) return;
    store.raiseNote({
      key: FLIGHT_DOWN_NOTE_KEY,
      kind: "blocked",
      runId: null,
      seatId,
      repoId,
      text: flightDownText(reason),
      at: t,
    });
    bus.emit("attention");
  };
  const clearDown = (t: number): void => {
    if (!downOpen()) return;
    store.clearNote(FLIGHT_DOWN_NOTE_KEY, t);
    bus.emit("attention");
  };

  async function pass(): Promise<void> {
    if (stopped || !enabled || !supervisor.status().enabled) return;
    const found = flightSeat(config);
    if (found === null) return;
    const id = found.seat.id;
    const t = now();
    await deps.refreshAuthors?.(found.session.repoId);

    let added = false;
    let nextDue = Infinity;
    for (const item of operatorItems(
      config,
      store,
      t,
      deps.login ?? null,
      undefined,
      deps.lockState?.(),
    )) {
      if (item.flightTriage === "waiting" && item.triageDueAt !== undefined)
        nextDue = Math.min(nextDue, item.triageDueAt);
      const identity = `${item.key}:${item.at}`;
      if (item.flightTriage === "missed" && !announced.has(identity)) {
        announced.add(identity);
        added = true;
      }
    }
    if (triageTimer !== null) clearTimeout(triageTimer);
    triageTimer = null;
    if (Number.isFinite(nextDue)) {
      triageTimer = setTimeout(
        () => {
          triageTimer = null;
          bus.emit("attention");
          void check();
        },
        Math.max(0, nextDue - now()),
      );
      triageTimer.unref();
    }
    if (added) bus.emit("attention");

    const row = store.seatSession(id);
    if (!flightLive(config, store)) {
      const accountId = runAccountId(store, row?.runId ?? null, found.seat.accountId);
      const atStop = accountAtStop(config, store, accountId, t);
      // The operator's own Stop is not an outage; parked or held at a stop line is.
      if (row?.state === "stopped") clearDown(t);
      else if (row?.state === "parked") raiseDown(id, found.session.repoId, "it is parked", t);
      else if (atStop) raiseDown(id, found.session.repoId, `${accountId} is at its stop line`, t);
      if (row?.state === "stopped" || row?.state === "parked" || noteOpen() || atStop) {
        return;
      }
      starts = starts.filter((s) => s > t - FLIGHT_HOUR_MS);
      if (starts.length >= FLIGHT_STARTS_MAX && !rotating) {
        store.raiseNote({
          key: FLIGHT_NOTE_KEY,
          kind: "blocked",
          runId: null,
          seatId: id,
          repoId: found.session.repoId,
          text: flightStartFailedText(lastFailure ?? "it stopped 3 times in an hour"),
          at: t,
        });
        bus.emit("attention");
        return;
      }
      if (deps.blocked?.(id) === true) return;
      prepareDaily(t);
      const state = flightState({
        config,
        store,
        busy: supervisor.busy(),
        now: t,
        hubLogin: deps.login ?? null,
        lock: deps.lockState?.(),
      });
      if (!rotating) starts.push(t);
      rotating = false;
      rotationRequested = false; // the fresh session already sees the current config
      try {
        const { digest, snapshot } = flightWake(state, undefined, store.flightMemory(state.repo));
        const causes = changedWakeFacts(lastFacts, wakeFacts(state));
        const { runId } = await supervisor.startWatch(id, {
          first: wakeLine(state, digest, causes.length > 0 ? causes : ["initial"]),
        });
        delivered = { runId, snapshot };
        markFlightSignalsShown(store, state, t);
        markPrsShown(store, state);
        markRetrospectiveShown(store, state);
        lastFacts = deliveredFacts(state);
        lastWakeAt = t;
      } catch (e) {
        lastFailure = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        log(`flight watch: start failed: ${lastFailure}`);
      }
      return;
    }

    if (noteOpen()) {
      store.clearNote(FLIGHT_NOTE_KEY, t);
      starts = [];
      bus.emit("attention");
    }
    const runId = row?.runId;
    const facts = supervisor.seatFacts(id);
    const run = runId == null ? null : store.run(runId);
    const output =
      run == null
        ? null
        : (lastOutputAt(
            store.digest(run.id)?.lastEventAt ?? null,
            transcriptMtime(run.transcriptPath),
          ) ?? run.startedAt);
    if (facts?.inTurn === true && output !== null && t - output >= FLIGHT_DOWN_STALL_MS)
      raiseDown(
        id,
        found.session.repoId,
        `no output for ${Math.floor((t - output) / 60_000)} min in a turn`,
        t,
      );
    else clearDown(t);
    if (runId == null || facts === null || facts.inTurn) return;
    if (facts.rateLimitedUntil !== null && facts.rateLimitedUntil > t) return;
    const n = flightWakes(store, runId);
    if (rotationRequested || n >= FLIGHT_MAX_WAKES) {
      rotating = true;
      await supervisor.endRunByEngine(runId);
      rotationRequested = false;
      return;
    }
    prepareDaily(t);
    const state = flightState({
      config,
      store,
      busy: supervisor.busy(),
      now: t,
      hubLogin: deps.login ?? null,
      lock: deps.lockState?.(),
    });
    const wake = wakeFacts(state);
    const listed = hasFacts(wake);
    const due =
      (wake !== lastFacts && listed) || (pending(state) && t - lastWakeAt >= FLIGHT_REWAKE_MS);
    const since = Math.max(lastWakeAt, lastTurnEndAt);
    if (due && t - since < FLIGHT_MIN_WAKE_GAP_MS) {
      later(since + FLIGHT_MIN_WAKE_GAP_MS - t);
      return;
    }
    if (due) {
      const { digest, snapshot } = flightWake(
        state,
        delivered?.runId === runId ? delivered.snapshot : undefined,
        store.flightMemory(state.repo),
      );
      if (
        (await supervisor.send(
          runId,
          wakeKey(runId, n + 1),
          wakeLine(state, digest, changedWakeFacts(lastFacts, wake)),
        )) === "sent"
      ) {
        delivered = { runId, snapshot };
        markFlightSignalsShown(store, state, t);
        markPrsShown(store, state);
        markRetrospectiveShown(store, state);
        lastFacts = deliveredFacts(state);
        lastWakeAt = t;
      }
    } else if (!listed) {
      lastFacts = wake;
    }
  }

  let chain: Promise<void> = Promise.resolve();
  function check(): Promise<void> {
    chain = chain
      .then(pass)
      .catch((e) => log(`flight watch: ${e instanceof Error ? e.message : e}`));
    return chain;
  }

  let triageTimer: NodeJS.Timeout | null = null;
  let timer: NodeJS.Timeout | null = null;
  function schedule(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, FLIGHT_DEBOUNCE_MS);
    timer.unref();
  }

  let gapTimer: NodeJS.Timeout | null = null;
  /** Checks again once the wake gap has passed; one pending re-check at a time. */
  function later(ms: number): void {
    if (gapTimer !== null || stopped) return;
    gapTimer = setTimeout(() => {
      gapTimer = null;
      void check();
    }, ms);
    gapTimer.unref();
  }

  let interval: NodeJS.Timeout | null = null;
  let offSupervisor: (() => void) | null = null;
  let offBus: (() => void) | null = null;

  return {
    check,
    seen(runId, state) {
      const seatId = flightSeat(config)?.seat.id;
      if (!seatId || store.seatSession(seatId)?.runId !== runId) return;
      delivered = {
        runId,
        snapshot: flightWake(
          state,
          delivered?.runId === runId ? delivered.snapshot : undefined,
          [],
          true,
        ).snapshot,
      };
    },
    rotate() {
      rotationRequested = true;
      void check();
    },
    start() {
      if (interval !== null) return;
      stopped = false;
      offSupervisor = supervisor.on((e) => {
        if (e.seatId === flightSeat(config)?.seat.id) {
          if (e.kind === "idle") lastTurnEndAt = now();
          if (!flightLive(config, store)) bus.emit("attention");
          void check();
        } else schedule();
      });
      offBus = bus.subscribe((topic) => {
        if (topic === "attention" || topic === "boards" || topic === "flight") schedule();
      });
      interval = setInterval(() => void check(), FLIGHT_TICK_MS);
      interval.unref();
      void check();
    },
    stop() {
      stopped = true;
      offSupervisor?.();
      offBus?.();
      offSupervisor = null;
      offBus = null;
      if (interval !== null) clearInterval(interval);
      interval = null;
      if (triageTimer !== null) clearTimeout(triageTimer);
      triageTimer = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (gapTimer !== null) clearTimeout(gapTimer);
      gapTimer = null;
    },
  };
}
