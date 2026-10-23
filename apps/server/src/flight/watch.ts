/**
 * Keeps FLIGHT running and wakes it. The hub starts the watch seat, restarts it after a hub
 * restart or a crash (at most FLIGHT_STARTS_MAX an hour), gives it a fresh session after
 * FLIGHT_MAX_WAKES wakes, and writes it a digest line, between turns, when what needs FLIGHT
 * changes. The operator's Stop holds. It starts only the watch seat, never another seat or a loop.
 */
import {
  FLIGHT_ANSWER_WAIT_MS,
  FLIGHT_DEBOUNCE_MS,
  FLIGHT_HOUR_MS,
  FLIGHT_MAX_WAKES,
  FLIGHT_NOTE_KEY,
  FLIGHT_REWAKE_MS,
  FLIGHT_STARTS_MAX,
  FLIGHT_TICK_MS,
  flightStartFailedText,
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
  flightOwnSeatIds,
  flightSeat,
  flightState,
  markPrsShown,
  pending,
  wakeFacts,
} from "./state.ts";

export interface FlightWatchDeps {
  config: CcConfig;
  store: Store;
  bus: ChangeBus;
  supervisor: Pick<
    Supervisor,
    "on" | "send" | "seatFacts" | "startWatch" | "endRunByEngine" | "busy" | "status"
  >;
  /** main.ts passes engineOn: off in a preview, with MC_NO_LOOP_WRITES=1, or with no crew. */
  enabled: boolean;
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
  /** When FLIGHT itself was started; a rotation is left out. */
  let starts: number[] = [];
  let rotating = false;
  let lastFailure: string | null = null;
  const announced = new Set<number>();

  const noteOpen = (): boolean => store.notes().some((n) => n.key === FLIGHT_NOTE_KEY);

  async function pass(): Promise<void> {
    if (!enabled || !supervisor.status().enabled) return;
    const found = flightSeat(config);
    if (found === null) return;
    const id = found.seat.id;
    const t = now();

    const own = flightOwnSeatIds(config);
    let added = false;
    for (const q of store.openQuestions()) {
      if (
        own.has(q.agentId) &&
        q.passedAt === null &&
        t - q.at >= FLIGHT_ANSWER_WAIT_MS &&
        !announced.has(q.id)
      ) {
        announced.add(q.id);
        added = true;
      }
    }
    if (added) bus.emit("attention");

    const row = store.seatSession(id);
    if (!flightLive(config, store)) {
      if (
        row?.state === "stopped" ||
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
      const state = flightState({ config, store, busy: supervisor.busy(), now: t });
      if (!rotating) starts.push(t);
      rotating = false;
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
    const prefix = `flight:wake:${runId}:`;
    const n = Object.keys(store.claimedKeys(runId)).filter((k) => k.startsWith(prefix)).length;
    if (n >= FLIGHT_MAX_WAKES) {
      rotating = true;
      await supervisor.endRunByEngine(runId);
      return;
    }
    const state = flightState({ config, store, busy: supervisor.busy(), now: t });
    const wake = wakeFacts(state);
    const listed = hasFacts(wake);
    const due =
      (wake !== lastFacts && listed) || (pending(state) && t - lastWakeAt >= FLIGHT_REWAKE_MS);
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

  let interval: NodeJS.Timeout | null = null;
  let offSupervisor: (() => void) | null = null;
  let offBus: (() => void) | null = null;

  return {
    check,
    start() {
      if (interval !== null) return;
      offSupervisor = supervisor.on((e) => {
        if (e.seatId === flightSeat(config)?.seat.id) void check();
        else schedule();
      });
      offBus = bus.subscribe((topic) => {
        if (topic === "attention" || topic === "boards") schedule();
      });
      interval = setInterval(() => void check(), FLIGHT_TICK_MS);
      interval.unref();
      void check();
    },
    stop() {
      offSupervisor?.();
      offBus?.();
      offSupervisor = null;
      offBus = null;
      if (interval !== null) clearInterval(interval);
      interval = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
