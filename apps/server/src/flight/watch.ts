/**
 * Keeps FLIGHT running and wakes it. The hub starts the watch seat, restarts it after a hub
 * restart or a crash (at most FLIGHT_STARTS_MAX an hour), gives it a fresh session after
 * FLIGHT_MAX_WAKES wakes, and writes it a digest line, between turns, when what needs FLIGHT
 * changes. The operator's Stop holds. It starts only the watch seat, never another seat or a loop.
 */
import {
  FLIGHT_DEBOUNCE_MS,
  FLIGHT_HOUR_MS,
  FLIGHT_MAX_WAKES,
  FLIGHT_MIN_WAKE_GAP_MS,
  FLIGHT_NOTE_KEY,
  FLIGHT_REWAKE_MS,
  FLIGHT_STARTS_MAX,
  FLIGHT_TICK_MS,
  flightStartFailedText,
  type TestLockState,
  wakeKey,
  wakeLine,
} from "@mc/core";
import type { ChangeBus } from "../bus.ts";
import type { CcConfig } from "../config.ts";
import { accountAtStop } from "../engine/queue.ts";
import type { Supervisor } from "../runtime/supervisor.ts";
import type { Store } from "../store.ts";
import {
  deliveredFacts,
  flightLive,
  flightSeat,
  flightState,
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
}

/** Whether any list of a `wakeFacts` string has an entry. */
const hasFacts = (facts: string): boolean =>
  Object.values(JSON.parse(facts) as Record<string, unknown[]>).some((l) => l.length > 0);

export function createFlightWatch(deps: FlightWatchDeps): FlightWatch {
  const { config, store, bus, supervisor, enabled } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  let lastFacts = "";
  let lastWakeAt = 0;
  /** When FLIGHT's last turn ended: the gap runs from this too, so a long turn can't wake itself. */
  let lastTurnEndAt = 0;
  let stopped = false;
  /** When FLIGHT itself was started; a rotation is left out. */
  let starts: number[] = [];
  let rotating = false;
  let rotationRequested = false;
  let lastFailure: string | null = null;
  const announced = new Set<string>();

  const noteOpen = (): boolean => store.notes().some((n) => n.key === FLIGHT_NOTE_KEY);

  async function pass(): Promise<void> {
    if (!enabled || !supervisor.status().enabled) return;
    const found = flightSeat(config);
    if (found === null) return;
    const id = found.seat.id;
    const t = now();
    await deps.refreshAuthors?.(found.session.repoId);

    let added = false;
    for (const item of operatorItems(
      config,
      store,
      t,
      deps.login ?? null,
      undefined,
      deps.lockState?.(),
    )) {
      const identity = `${item.key}:${item.at}`;
      if (item.flightTriage === "missed" && !announced.has(identity)) {
        announced.add(identity);
        added = true;
      }
    }
    if (added) bus.emit("attention");

    const row = store.seatSession(id);
    if (!flightLive(config, store)) {
      if (
        row?.state === "stopped" ||
        row?.state === "parked" ||
        noteOpen() ||
        accountAtStop(config, store, found.seat.accountId, t)
      ) {
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
        await supervisor.startWatch(id, { first: wakeLine(state) });
        markPrsShown(store, state);
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
    if (runId == null || facts === null || facts.inTurn) return;
    if (facts.rateLimitedUntil !== null && facts.rateLimitedUntil > t) return;
    const n = flightWakes(store, runId);
    if (rotationRequested || n >= FLIGHT_MAX_WAKES) {
      rotating = true;
      await supervisor.endRunByEngine(runId);
      rotationRequested = false;
      return;
    }
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
      if ((await supervisor.send(runId, wakeKey(runId, n + 1), wakeLine(state))) === "sent") {
        markPrsShown(store, state);
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
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (gapTimer !== null) clearTimeout(gapTimer);
      gapTimer = null;
    },
  };
}
