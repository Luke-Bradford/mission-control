import { type CpuInfo, homedir } from "node:os";
import { join } from "node:path";
import {
  type AccountId,
  type AgentId,
  BACKFILL_COLLECTOR,
  type CrewRow,
  ENGINE_TICK_MS,
  FLIGHT_LOOPS_SETTING,
  flowCollector,
  GITHUB_SLOWED_PREFIX,
  githubCollector,
  type HudState,
  hudColumnOf,
  MACHINE_COLLECTOR,
  type MachineSample,
  NOTABLE_STATES,
  prSweepCollector,
  type RepoId,
  type Run,
  seatTurnText,
  stateChangeText,
  type TestLockState,
  type UsageSample,
  usageCollector,
} from "@mc/core";
import { codexProfile } from "./account-bindings.ts";
import { evaluateHolds } from "./attention-holds.ts";
import { backfillRuns, fillTicketTitles, rewriteCrewSummaries } from "./backfill.ts";
import type { ChangeBus, Topic } from "./bus.ts";
import {
  CLI_COLLECTOR,
  CLI_NOTE_KEY,
  CLI_RETRY_MS,
  CLI_UPDATE_INTERVAL_MS,
  CLI_UPGRADE_FAILED,
  CLI_UPGRADE_NOTE_KEY,
  type CliCheck,
  CliHold,
  checkCli,
  cliFailedText,
  NOT_A_CASK,
  realExec,
} from "./cli-update.ts";
import { collectorName, DIGEST_RETENTION_MS, FOLD_WINDOW_MS } from "./collectors/common.ts";
import { collectFlow } from "./collectors/flow.ts";
import {
  collectGithub,
  collectWaitedPrs,
  fetchTicket,
  githubToken,
  MISSING_SCOPE_PREFIX,
  makeGql,
  missingScopeLine,
  sweepPullRequests,
} from "./collectors/github.ts";
import { type LaunchctlRunner, launchctl } from "./collectors/launchd.ts";
import { type MachineResult, realMachineDeps, sampleMachine } from "./collectors/machine.ts";
import {
  collectNotifications,
  makeRest,
  NOTIFICATIONS_COLLECTOR,
  type Rest,
} from "./collectors/notifications.ts";
import { nextBackoff, RateLimits } from "./collectors/rate-limit.ts";
import { defaultIsAlive, type LiveSession, readSessions } from "./collectors/sessions.ts";
import { collectStudioLoop, newStudioState } from "./collectors/studio-loop.ts";
import { collectTaLoop, newTaState } from "./collectors/ta-loop.ts";
import { collectTeams } from "./collectors/teams.ts";
import {
  OAUTH_USAGE_SOURCE,
  sampleClaude,
  USAGE_BACKOFF_CAP_MS,
  USAGE_BACKOFF_FACTOR,
  USAGE_BACKOFF_SETTING,
  USAGE_RATE_LIMIT_MAX_AGE_MS,
} from "./collectors/usage-claude.ts";
import { sampleCodex } from "./collectors/usage-codex.ts";
import { WINDOWS } from "./collectors/usage-common.ts";
import {
  appServer,
  fetchUsage,
  latestRollout,
  latestTranscriptLimits,
  UsageRateLimited,
} from "./collectors/usage-sources.ts";
import { raiseStalledCommsDecisions } from "./comms-decisions.ts";
import type { CcConfig } from "./config.ts";
import { configuredAgents, TRANSCRIPT_RETENTION_DEFAULTS } from "./config.ts";
import { applyDecisionDefaults } from "./decision-defaults.ts";
import { ENDED_RECONCILE_MS } from "./engine/engine.ts";
import { flightLoopHeartbeat } from "./flight/signals.ts";
import { flightSeat } from "./flight/state.ts";
import { followPrs } from "./github-board.ts";
import {
  attentionItems,
  crew,
  flightNotTriagingDueAt,
  forgetViews,
  NO_LOCK,
  stateInputs,
} from "./hud.ts";
import {
  MACHINE_CAPACITY_DEFAULTS,
  MACHINE_CAPACITY_KEY,
  machineCapacity,
  machineCapacitySince,
} from "./machine-capacity.ts";
import type { Supervisor } from "./runtime/supervisor.ts";
import type { Store } from "./store.ts";
import { healthContent, TopicGate } from "./topic-gate.ts";
import {
  maintainTranscripts,
  TRANSCRIPT_PASS_FIRST_DELAY_MS,
  TRANSCRIPT_PASS_INTERVAL_MS,
} from "./transcript-lifecycle.ts";
import { VERSION_CHECK_MS } from "./update.ts";

export type Job =
  | "teams"
  | "ta"
  | "studio"
  | "sessions"
  | "github"
  | "usage"
  | "maintenance"
  | "transcripts"
  | "machine"
  | "prs"
  | "flow"
  | "backfill"
  | "engine"
  | "update"
  | "cli";
const SIGNAL_LOOPS: readonly Job[] = ["engine", "ta", "studio", "sessions"];

/** start() order: sessions first, so the first studio tick reuses that read of the registry. */
export const JOBS: readonly Job[] = [
  "sessions",
  "teams",
  "ta",
  "studio",
  "github",
  "usage",
  "maintenance",
  "transcripts",
  "machine",
  "prs",
  "flow",
  "backfill",
  "engine",
  "update",
  "cli",
];
/** start() delays the first engine tick: the first GitHub poll has read the boards and PRs by then. */
export const ENGINE_FIRST_DELAY_MS = 30_000;
export const LOOP_INTERVAL_MS = 15_000;
/** Machine collection is expensive (it reads process state); capacity decisions need no finer cadence. */
export const MACHINE_INTERVAL_MS = 10_000;
/** The machine collector status is rewritten at most this often while it does not change. */
export const MACHINE_STATUS_MS = 60_000;
export const MAINTENANCE_INTERVAL_MS = 60 * 60_000;
/** The PR sweep pages through GitHub hourly; the budget is shared with the loops on the operator's account. */
export const PR_SWEEP_MS = 60 * 60_000;
/** start() delays the first sweep, so restarting a server (or a preview) does not spend the budget at once. */
export const PR_SWEEP_FIRST_DELAY_MS = 5 * 60_000;
/** Flow history (cycle time, first-push CI) is read hourly. */
export const FLOW_INTERVAL_MS = 60 * 60_000;
/**
 * start() delays the first flow run until after the first PR sweep (PR_SWEEP_FIRST_DELAY_MS), so
 * the board and the PRs it reads have both been polled.
 */
export const FLOW_FIRST_DELAY_MS = 7 * 60_000;
/**
 * Topics emitted within this window go out once, together, at its end: the ta and studio ticks
 * fire together every 15 s and would otherwise each make every page refetch (#26 A1).
 */
export const EMIT_COALESCE_MS = 1000;
export { DIGEST_RETENTION_MS };
/** Recorded HUD state changes are kept this long. */
export const AGENT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** The backfill reads a slice of older runs this often, for at most BACKFILL_BUDGET_MS each. */
export const BACKFILL_INTERVAL_MS = 30_000;
/** start() delays the first backfill, so a (re)started server serves its first ticks unhindered. */
export const BACKFILL_FIRST_DELAY_MS = 60_000;
export const BACKFILL_BUDGET_MS = 1500;
/** A trigger's board read waits this long, so a burst of triggers is one read. */
export const BOARD_TRIGGER_DELAY_MS = 2000;
/** Triggered board reads run at most once per this window (counted from the last board read). */
export const BOARD_REFRESH_DEBOUNCE_MS = 30_000;

/**
 * The PRs the engine waits on in `repoId`: a looped run in CI or review, or one whose merge has not
 * happened yet. Deduplicated, ascending.
 */
export function waitedPrNumbers(runs: Run[], repoId: RepoId): number[] {
  const out = new Set<number>();
  for (const r of runs) {
    const loop = r.loop;
    if (r.repoId !== repoId || !loop || loop.prNumber === null) continue;
    const waiting =
      loop.phase === "ci" ||
      loop.phase === "review" ||
      (loop.merging != null && !loop.merging.done.includes("merge"));
    if (waiting) out.add(loop.prNumber);
  }
  return [...out].sort((a, b) => a - b);
}

/** Asks `refresh` for a board read each time a seat's run ends (the seat is free for new work). */
export function refreshOnSeatFree(on: Supervisor["on"], refresh: () => void): () => void {
  return on((e) => {
    if (e.kind === "run-ended") refresh();
  });
}

type Gql = ReturnType<typeof makeGql>;
type OnError = (source: string, err: unknown) => void;

/** The collectors a scheduler drives; the defaults bind the real ones, tests pass stubs. */
export interface Collectors {
  ta: typeof collectTaLoop;
  studio: typeof collectStudioLoop;
  /** Read-only `launchctl print` for the loops' launchd-job check. */
  launchctl: LaunchctlRunner;
  sessions: () => LiveSession[];
  githubToken: () => Promise<string>;
  /** `rates` is where every answer's `rateLimit` is recorded. */
  makeGql: (token: string, rates: RateLimits) => Gql;
  github: typeof collectGithub;
  /** Re-reads only the PRs the engine waits on, between board reads. */
  githubPrs: typeof collectWaitedPrs;
  /** Moves each ticket's card to follow its PRs, after a board read. */
  followPrs: typeof followPrs;
  /** The REST client for the operator's notifications (read-only, api.github.com only). */
  makeRest: (token: string) => Rest;
  notifications: typeof collectNotifications;
  prSweep: typeof sweepPullRequests;
  flow: typeof collectFlow;
  backfill: typeof backfillRuns;
  /** The one-off rewrite of past crew runs' summaries. */
  rewriteSummaries: typeof rewriteCrewSummaries;
  /** One CLI update check (`updates.cli: between_runs`): brew outdated, upgrade, smoke test. */
  cli: (beforeUpgrade: () => void) => Promise<CliCheck>;
  /** The one-off fill of past crew runs' missing ticket titles, read from GitHub. */
  fillTitles: typeof fillTicketTitles;
  claude: (acct: AccountId, onError: OnError, now: number) => Promise<UsageSample[]>;
  codex: (acct: AccountId, onError: OnError, now: number) => Promise<UsageSample[]>;
  machine: (
    prevCpus: CpuInfo[] | null,
    prev: MachineSample | null,
    now: number,
    testCommand: string | null,
    /** Whether the reading may spawn `vm_stat`, `sysctl`, `memory_pressure` and `ps`. */
    spawn: boolean,
  ) => Promise<MachineResult>;
  transcripts?: typeof maintainTranscripts;
}

export interface SchedulerDeps {
  config: CcConfig;
  teamsEnabled?: boolean;
  store: Store;
  bus: ChangeBus;
  now?: () => number;
  collectors?: Partial<Collectors>;
  /** Debug lines (each backfill tick's count and duration); dropped when absent. */
  debug?: (line: string) => void;
  /** Lines for the server log (a gh token missing a scope); dropped when absent. */
  log?: (line: string) => void;
  /** The test lock's state: a seat in line for it is waiting, not stalled. Default: no lock. */
  lockState?: () => TestLockState;
  /** Active browser streams; absent in unit callers, which keep the historical eager behaviour. */
  hasViewClients?: () => boolean;
  /**
   * A ticket or review waits for the machine guard to admit it. Default: from the stored queues,
   * queued reviews and Ready cards. Only read while no browser is connected.
   */
  startPending?: () => boolean;
  /** `updates.hub: auto`: the check the `update` job runs every VERSION_CHECK_MS. Absent: no job. */
  autoUpdate?: () => Promise<unknown>;
  /** Where the CLI update check holds new runs while the CLI fails its smoke test. */
  cliHold?: CliHold;
  /** Hands an applied default to the seat that asked it. */
  deliverDefault?: (seatId: string, text: string) => Promise<void>;
  /** The PRs the engine waits on in a repo (CI running, a merge queued). Default: from the loop runs. */
  waitedPrs?: (repoId: RepoId) => number[];
}

/** What the scheduler asks of the first loop's engine. */
export interface EngineHooks {
  tick(): Promise<void>;
  reconcileRepo(repoId: string): Promise<void>;
}

export interface Scheduler {
  /**
   * Hands the scheduler the engine, which is built after it: until then the `engine` job and the
   * after-poll hook do nothing.
   */
  setEngine(engine: EngineHooks | null): void;
  /** Runs every job now, then each on its interval. Reads the GitHub token once. */
  start(): void;
  /** Clears the timers, waits for in-flight runs, then sends any topics still queued. */
  stop(): Promise<void>;
  /** Runs one job unless its previous run is still in flight. Never throws. */
  tick(job: Job): Promise<"ran" | "skipped">;
  /**
   * Asks for a full GitHub read (boards, escalations, PRs) within BOARD_TRIGGER_DELAY_MS, at most
   * once per BOARD_REFRESH_DEBOUNCE_MS.
   */
  refreshBoards(): void;
  /** The live Claude Code sessions from the latest sessions read ([] before one / after a failure). */
  sessions(): LiveSession[];
  /** The latest machine sample; null before the first one. */
  machine(): MachineSample | null;
}

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

export function realCollectors(config: CcConfig): Collectors {
  return {
    ta: collectTaLoop,
    studio: collectStudioLoop,
    launchctl,
    sessions: () => readSessions(SESSIONS_DIR, defaultIsAlive),
    githubToken,
    makeGql: (token, rates) => makeGql(token, fetch, rates),
    github: collectGithub,
    githubPrs: collectWaitedPrs,
    followPrs,
    makeRest: (token) => makeRest(token),
    notifications: collectNotifications,
    prSweep: sweepPullRequests,
    flow: collectFlow,
    backfill: backfillRuns,
    rewriteSummaries: rewriteCrewSummaries,
    cli: (beforeUpgrade) => checkCli({ exec: realExec, beforeUpgrade }),
    fillTitles: fillTicketTitles,
    claude: (acct, onError, now) =>
      sampleClaude(
        acct,
        {
          fetchUsage: () => fetchUsage(),
          latestTranscriptLimits: () => latestTranscriptLimits(config.loops, { now }),
          onError,
        },
        now,
      ),
    codex: (acct, onError, now) => {
      const account = config.accounts.find((a) => a.id === acct);
      const profile = account === undefined ? undefined : codexProfile(account);
      return sampleCodex(
        acct,
        {
          appServer: () => appServer({ cliProfile: profile }),
          latestRollout: () =>
            latestRollout(profile === undefined ? undefined : join(profile, "sessions")),
          onError,
        },
        now,
      );
    },
    machine: (prevCpus, prev, now, testCommand, spawn) =>
      sampleMachine({ ...realMachineDeps(), prevCpus, prev, now, testCommand, spawn }),
    transcripts: maintainTranscripts,
  };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { config, store, bus } = deps;
  const now = deps.now ?? Date.now;
  const c: Collectors = { ...realCollectors(config), ...deps.collectors };
  const taState = newTaState();
  const studioState = newStudioState();
  const inFlight = new Map<Job, Promise<void>>();
  const timers: NodeJS.Timeout[] = [];
  /** The latest session-registry read; null before the first read and after a failed one. */
  let liveSessions: LiveSession[] | null = null;
  let sessionsRead = false;
  let gql: Promise<Gql | Error> | null = null;
  /** The REST client made with the same token as `gql`; null until the token is read. */
  let rest: Rest | null = null;
  const rates = new RateLimits(store);
  /** The repos whose missing-scope line is logged already. */
  const scopeLogged = new Set<string>();
  /** The GitHub poll interval is this many times the configured one while the rate limit is low. */
  let githubBackoff = 1;
  let githubNotBefore = 0;
  /** The reset of the reading that caused the back-off; the back-off ends then, whoever reads next. */
  let githubResetAt = 0;
  // All Claude accounts use the same Keychain token and OAuth endpoint.
  let usageBackoff: { waitMs: number; notBefore: number } | null = null;
  let usageRetryTimer: NodeJS.Timeout | null = null;
  /** When the last board read began; boards are read on the first poll. */
  let lastBoardAt = Number.NEGATIVE_INFINITY;
  /** A trigger asked for a board read that has not run yet. */
  let boardWanted = false;
  let triggerTimer: NodeJS.Timeout | null = null;
  /** Absent (a hand-built config): 0, so every GitHub poll reads the boards. */
  const boardMs = (config.poll.boardMinutes ?? 0) * 60_000;
  const waitedPrs =
    deps.waitedPrs ??
    ((repoId: RepoId) => waitedPrNumbers(store.loopRuns(now() - ENDED_RECONCILE_MS), repoId));
  let latestMachine: MachineSample | null = null;
  let machineCpus: CpuInfo[] | null = null;
  let machineMinute = -1;
  /** The capacity guard held new starts at the last stored sample. */
  let machineBlocked = false;
  /**
   * Whether this machine reading may spawn commands. The swap and memory-pressure thresholds (the
   * swap hard limit always applies) need `sysctl` and `memory_pressure`, so a browser, a start
   * waiting at the guard, or a held guard (to see it clear) spawns; an idle hub reads os values.
   */
  const machineSpawns = (): boolean =>
    !noViewClients() || machineBlocked || (deps.startPending ?? defaultStartPending)();
  /** A queued ticket or review, an open run, or a Ready card on a repo with a crew session. */
  const defaultStartPending = (): boolean =>
    store.hasPendingStart() ||
    (config.crew?.sessions ?? []).some((session) =>
      store.board(session.repoId).some((card) => hudColumnOf(card) === "Ready"),
    );
  let lastSpawned = false;
  let machineStatus: { ok: boolean; error: string | null; at: number } | null = null;
  /** The last backfill left nothing to read: later ticks only count until something is left. */
  let backfillDone = false;
  let summariesDone = false;
  let titlesDone = false;
  let engine: EngineHooks | null = null;
  const cliHold = deps.cliHold ?? new CliHold();
  /** The re-check armed while new runs are held. */
  let cliRetry: NodeJS.Timeout | null = null;
  // A hold from before a restart stands until a check passes: the supervisor's resume runs next.
  const heldNote = store.notes().find((n) => n.key === CLI_NOTE_KEY);
  if (heldNote !== undefined) {
    if (config.updates?.cli === "between_runs") cliHold.hold(heldNote.text);
    else store.clearNote(CLI_NOTE_KEY, now());
  }

  /** Each agent's HUD state at its last recorded change or last look; seeded so a restart is no change. */
  const lastStates = new Map<AgentId, HudState>(store.latestAgentStates());

  /** Topics queued for the current coalescing window, and the timer that ends it. */
  const pending = new Set<Topic>();
  /** Topics queued to go out only if their content changed (see TopicGate). */
  const gated = new Set<Topic>();
  let emitTimer: NodeJS.Timeout | null = null;

  /** What each gated topic's page shows, hashed on each flush to tell a changed topic from a re-poll. */
  const gate = new TopicGate({
    agents: () => crew(config, store, now(), deps.lockState?.() ?? NO_LOCK).rows,
    health: () => healthContent(store.status()),
    // keys and owners only: an item's relative text changes every minute and is no news
    attention: () =>
      attentionItems(config, store, now(), deps.lockState?.() ?? NO_LOCK).map((i) => [
        i.key,
        i.owner,
      ]),
  });

  /** Sends each queued topic once, and each gated topic that changed. Attention items are built from agents and escalations. */
  const flushEmits = () => {
    if (emitTimer !== null) clearTimeout(emitTimer);
    emitTimer = null;
    const topics = [...pending];
    const maybe = [...gated].filter((t) => !pending.has(t));
    pending.clear();
    gated.clear();
    if (noViewClients()) {
      // no crew view is built for a hash while nobody watches; the next flush with a viewer sends
      topics.push(...maybe);
      gate.reset();
    } else {
      // a forced topic is hashed too, so the stored hash follows what was sent
      for (const t of topics) gate.changed(t);
      for (const t of maybe) if (gate.changed(t)) topics.push(t);
    }
    // attention follows agents or escalations, and also goes out alone when its items changed
    // (a clock-only item, such as an unanswered question turning due, changes no crew row)
    const follows = topics.includes("agents") || topics.includes("escalations");
    if (follows && !topics.includes("attention")) {
      if (!noViewClients()) gate.changed("attention"); // keep the stored hash in step
      topics.push("attention");
    }
    for (const t of topics) bus.emit(t);
  };

  const arm = () => {
    if (emitTimer === null && (pending.size > 0 || gated.size > 0)) {
      emitTimer = setTimeout(flushEmits, EMIT_COALESCE_MS);
      emitTimer.unref();
    }
  };

  /** Queues topics; the window's first emit starts the EMIT_COALESCE_MS timer. */
  const emit = (...topics: Topic[]) => {
    for (const t of topics) pending.add(t);
    arm();
  };

  /** Queues topics that go out only if their content changed since they were last sent. */
  const emitIfChanged = (...topics: Topic[]) => {
    for (const t of topics) gated.add(t);
    arm();
  };

  const applyDefaults = async () => {
    try {
      const raised = raiseStalledCommsDecisions({ config, store, now: now() });
      if (raised > 0) bus.emit("attention");
      const n = await applyDecisionDefaults({
        config,
        store,
        now: now(),
        lock: deps.lockState?.(),
        deliver: deps.deliverDefault,
      });
      if (n > 0) bus.emit("attention");
    } catch (e) {
      deps.log?.(`decision defaults: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  let triageTimer: NodeJS.Timeout | null = null;
  let triageAt = 0;
  const scheduleTriage = () => {
    const at = now();
    if (triageTimer !== null && triageAt <= at) return;
    if (triageTimer !== null) clearTimeout(triageTimer);
    triageTimer = null;
    const due = attentionItems(config, store, at, deps.lockState?.() ?? NO_LOCK).flatMap((item) =>
      [item.triageDueAt, item.defaultDueAt].flatMap((t) => (t !== undefined && t > at ? [t] : [])),
    );
    // a FLIGHT that is not running shows as not triaging once its restart grace has passed
    const shows = flightNotTriagingDueAt(config, store, at);
    if (shows !== null && shows > at) due.push(shows);
    if (due.length === 0) return;
    triageAt = Math.min(...due);
    triageTimer = setTimeout(() => {
      triageTimer = null;
      // never read a view built earlier in this second: the timer's reason is that time has passed
      forgetViews(store);
      void applyDefaults();
      bus.emit("attention");
    }, triageAt - at);
    triageTimer.unref();
  };

  /** True when the hub knows no browser is connected; a caller that cannot tell reads eagerly. */
  const noViewClients = (): boolean => deps.hasViewClients?.() === false;

  /** Drops acks whose item has been gone for ACK_ABSENT_MS (after each loop tick / GitHub poll). */
  const sweepAcks = (rows?: CrewRow[]) => {
    const at = now();
    const lock = deps.lockState?.() ?? NO_LOCK;
    // Rows are read only if a hold needs them, and then without event timelines (the sweep keeps
    // none).
    const currentRows = (): CrewRow[] =>
      rows ?? crew(config, store, at, lock, undefined, true).rows;
    let waiting: Set<string> | undefined;
    if (
      evaluateHolds(
        store,
        at,
        (ticket) => {
          const [repoId, number] = ticket.split("#");
          return store
            .pullRequests(repoId ?? "")
            .some(
              (p) =>
                p.state === "merged" &&
                (p.ticket === ticket || p.closingIssues?.includes(Number(number))),
            );
        },
        (since) =>
          currentRows().some((r) => {
            if (r.kind !== "crew" || r.role === "FLIGHT" || r.hudState === "stopped") return false;
            const seat = store.seatSession(r.id);
            return seat !== null && seat.state !== "stopped" && seat.updatedAt > since;
          }),
        (pr) => {
          const [repoId, number] = pr.split("#");
          return (
            store.pullRequests(repoId ?? "").find((p) => p.number === Number(number))?.ci ?? null
          );
        },
        (key) => {
          waiting ??= new Set(
            attentionItems(config, store, at, lock, rows, null, true).map((i) => i.key),
          );
          return !waiting.has(key);
        },
      )
    )
      emit("attention");
    void applyDefaults();
    // The ack sweep is housekeeping: a hub with no browser leaves it to the next poll with one.
    if (noViewClients()) return;
    store.sweepAcks(new Set(attentionItems(config, store, at, lock, rows).map((i) => i.key)), at);
  };

  /**
   * Records each agent's change of HUD state when either side is notable (running <-> idle is
   * only for a crew seat: its turn start and end). An agent seen for the first time has no earlier state, so nothing is recorded for it.
   */
  const recordStateChanges = (rows: CrewRow[], at: number): number => {
    let recorded = 0;
    for (const row of rows) {
      const from = lastStates.get(row.id);
      lastStates.set(row.id, row.hudState);
      if (from === undefined || from === row.hudState) continue;
      const turn = row.kind === "crew" ? seatTurnText(from, row.hudState) : null;
      if (
        turn === null &&
        !NOTABLE_STATES.includes(from) &&
        !NOTABLE_STATES.includes(row.hudState)
      ) {
        continue;
      }
      store.addAgentEvent({
        agentId: row.id,
        at,
        from,
        to: row.hudState,
        text: turn ?? stateChangeText(from, row.hudState, row),
      });
      recorded++;
    }
    return recorded;
  };

  /** After a loop tick: one crew read serves the state-change record and the ack sweep. */
  let lastInputs: string | null = null;
  /** States that turn with the clock; the others turn only with the inputs `stateInputs` reads. */
  const TIMED_STATES: readonly HudState[] = ["running", "stalled", "waiting"];
  const afterLoopTick = () => {
    const inputs = noViewClients() ? stateInputs(config, store) : null;
    // an agent no longer configured keeps its last event, and no row of it changes
    const configured = new Set(configuredAgents(config).map((a) => a.id));
    const quiet =
      inputs !== null &&
      inputs === lastInputs &&
      !store.hasActiveRun() &&
      ![...lastStates].some(([id, s]) => configured.has(id) && TIMED_STATES.includes(s));
    // nothing can change state: no crew read
    if (quiet) return sweepAcks();
    lastInputs = inputs;
    const at = now();
    // with no browser the rows are the summary: state changes need no event timelines
    const lock = deps.lockState?.() ?? NO_LOCK;
    const rows = (
      noViewClients()
        ? crew(config, store, at, lock, undefined, true)
        : crew(config, store, at, lock)
    ).rows;
    recordStateChanges(rows, at);
    sweepAcks(rows);
  };

  /** Crew rows change between loop ticks: record them on the `agents` event, at most once a second. */
  let unsubscribeCrew: (() => void) | null = null;
  let crewTimer: NodeJS.Timeout | null = null;
  const recordCrewSoon = () => {
    if (crewTimer !== null || noViewClients()) return;
    crewTimer = setTimeout(() => {
      crewTimer = null;
      if (noViewClients()) return;
      try {
        const at = now();
        // The feed refetches on `agents`; announce what was just recorded (the re-read finds no change).
        if (recordStateChanges(crew(config, store, at, deps.lockState?.() ?? NO_LOCK).rows, at) > 0)
          emit("agents");
        recordStatus("scheduler:crew", true, null);
      } catch (e) {
        recordStatus("scheduler:crew", false, msg(e));
      }
    }, EMIT_COALESCE_MS);
    crewTimer.unref();
  };

  /**
   * Records a collector status without ever throwing: a failed write (e.g. "database is locked")
   * goes to stderr with the collector name and the DB error only, never the status text itself.
   */
  const recordStatus = (collector: string, ok: boolean, error: string | null) => {
    try {
      store.setStatus(collector, ok, error);
    } catch (e) {
      try {
        process.stderr.write(`cc: could not record status for ${collector}: ${msg(e)}\n`);
      } catch {
        // nowhere left to report
      }
    }
  };

  /** Runs `fn`; anything it throws is recorded as `collector`'s status instead. Never throws. */
  const guarded = async (collector: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      recordStatus(collector, false, msg(e));
    }
  };

  /** The gql client; a failed token read is retried on the next GitHub tick until one succeeds. */
  const loadGql = (): Promise<Gql | Error> => {
    // Never rejects (start() fires it with `void`): any failure becomes an Error value.
    gql ??= c
      .githubToken()
      .then((token) => {
        rest = c.makeRest(token);
        return c.makeGql(token, rates);
      })
      .catch((e: unknown) => new Error(msg(e)));
    return gql;
  };

  const noteUsageLimited = (acct: AccountId, notBefore: number) => {
    const readings = WINDOWS.flatMap((w) => store.latestUsage(acct, w) ?? []);
    const latest = readings.sort((a, b) => b.at - a.at)[0];
    const reading = readings.find((r) => r.window === "7d") ?? latest;
    const at = now();
    const date = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: config.operator.timezone,
    });
    const time = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: config.operator.timezone,
    });
    const format = (value: number) =>
      `${date.format(value) === date.format(at) ? "" : `${date.format(value)} `}${time.format(value)}`;
    const last = reading
      ? `last reading ${format(reading.at)} (${reading.pct}% ${reading.window})`
      : "no previous reading";
    recordStatus(
      usageCollector(acct),
      latest !== undefined && at - latest.at < USAGE_RATE_LIMIT_MAX_AGE_MS,
      `rate limited by Anthropic; ${last}; next try ${format(notBefore)}`,
    );
  };

  const usageFor = async (acct: CcConfig["accounts"][number]) => {
    const backoff = usageBackoff;
    if (acct.vendor === "claude" && backoff && now() < backoff.notBefore) {
      if (backoff.waitMs > 0) noteUsageLimited(acct.id, backoff.notBefore);
      return;
    }
    const errors: string[] = [];
    let rateLimited = false;
    const onError: OnError = (source, err) => {
      errors.push(`${source}: ${msg(err)}`);
      if (acct.vendor !== "claude" || source !== OAUTH_USAGE_SOURCE) return;
      if (!(err instanceof UsageRateLimited)) return;
      rateLimited = true;
      const waitMs = Math.min(
        USAGE_BACKOFF_CAP_MS,
        backoff?.waitMs ? backoff.waitMs * USAGE_BACKOFF_FACTOR : intervals.usage,
      );
      const at = now();
      const retryAt =
        err.retryAfterMs !== null || err.retryAt !== null ? err.notBefore(at) : at + waitMs;
      usageBackoff = { waitMs, notBefore: retryAt };
      store.setSetting(USAGE_BACKOFF_SETTING, JSON.stringify(usageBackoff));
      scheduleUsageRetry();
    };
    const sample = acct.vendor === "claude" ? c.claude : c.codex;
    const samples = await sample(acct.id, onError, now());
    // A fallback source can return the same reading on every poll; addUsage keeps one row of it.
    for (const s of samples) store.addUsage(s);
    if (rateLimited) {
      const held = usageBackoff;
      if (held) noteUsageLimited(acct.id, held.notBefore);
      return;
    }
    if (acct.vendor === "claude" && samples.some((s) => s.source === OAUTH_USAGE_SOURCE)) {
      // The provider has recovered, so the next 429 starts a new back-off sequence.
      usageBackoff = null;
      store.deleteSetting(USAGE_BACKOFF_SETTING);
      clearUsageRetry();
    }
    const missing = WINDOWS.filter((w) => !samples.some((s) => s.window === w));
    const collector = usageCollector(acct.id);
    if (samples.length === 0) {
      recordStatus(collector, false, errors.join("; ") || "no usable reading from any source");
    } else {
      // Notes, not failure: earlier source failures (a later source succeeded) and missing windows.
      const notes = [...errors, ...missing.map((w) => `no usable ${w} reading`)];
      recordStatus(collector, true, notes.length > 0 ? notes.join("; ") : null);
    }
  };

  /** While backed off, adds "slowed: rate limit low (N left, resets HH:MM)" to each healthy GitHub collector. */
  const noteSlowed = () => {
    const latest = rates.latest();
    if (githubBackoff === 1 || !latest) return;
    const reset = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: config.operator.timezone,
    }).format(latest.resetAt);
    const slowed = `${GITHUB_SLOWED_PREFIX} rate limit low (${latest.remaining} left, resets ${reset})`;
    const rows = store.status();
    for (const repo of config.repos) {
      const collector = githubCollector(repo.id);
      const row = rows.find((r) => r.collector === collector);
      if (!row?.ok) continue;
      const kept = (row.error ?? "")
        .split("; ")
        .filter((n) => n !== "" && !n.startsWith(GITHUB_SLOWED_PREFIX));
      recordStatus(collector, true, [...kept, slowed].join("; "));
    }
  };

  /** True when the GitHub job should run on this interval tick: not while backed off, until the reset. */
  const githubDue = (): boolean => {
    if (githubBackoff === 1) return true;
    if (now() >= githubResetAt) {
      githubBackoff = 1;
      return true;
    }
    // Half an interval of slack: timers drift, and a tick just short of the mark is the mark.
    return now() >= githubNotBefore - intervals.github / 2;
  };

  /** One registry read, shared by the sessions job and (through liveSessions) the studio job. */
  const readLiveSessions = () =>
    guarded("sessions", async () => {
      sessionsRead = true;
      liveSessions = null;
      liveSessions = c.sessions();
      recordStatus("sessions", true, null);
    });

  const jobs: Record<Job, () => Promise<void>> = {
    ta: async () => {
      for (const loop of config.loops.filter((l) => l.kind === "ta-loop")) {
        await guarded(collectorName(loop.kind, loop.id), () =>
          c.ta(loop, store, now(), taState, undefined, c.launchctl),
        );
      }
      emitIfChanged("agents", "health", "attention");
      afterLoopTick();
    },
    studio: async () => {
      // The studio liveness check reuses the sessions tick's read; only the very first studio tick
      // (start() runs every job at once) may need to read the registry itself.
      if (!sessionsRead) await readLiveSessions();
      for (const loop of config.loops.filter((l) => l.kind === "studio-loop")) {
        await guarded(collectorName(loop.kind, loop.id), () =>
          c.studio(
            loop,
            store,
            config.operator.timezone,
            now(),
            studioState,
            liveSessions,
            c.launchctl,
          ),
        );
      }
      emitIfChanged("agents", "health", "attention");
      afterLoopTick();
    },
    sessions: readLiveSessions,
    github: async () => {
      if (config.repos.length === 0) return;
      const client = await loadGql();
      if (client instanceof Error) gql = null; // retry next tick
      const changed = { boards: false, escalations: false };
      const startedAt = now();
      const spentBefore = rates.startPoll();
      // Half an interval of slack, as in githubDue: a tick just short of the mark is the mark.
      const boardDue = boardWanted || startedAt - lastBoardAt >= boardMs - intervals.github / 2;
      if (!boardDue && !(client instanceof Error)) {
        // Between board reads only the PRs the engine waits on are read (CI, a merge).
        for (const repo of config.repos) {
          const numbers = waitedPrs(repo.id);
          if (numbers.length === 0) continue;
          await guarded(githubCollector(repo.id), async () => {
            const r = await c.githubPrs(
              repo,
              store,
              client,
              numbers,
              now,
              flightSeat(config)?.session.repoId === repo.id,
            );
            changed.boards ||= r.boards;
            if (await c.followPrs({ gql: client, store, config, now }, repo.id))
              changed.boards = true;
          });
        }
      }
      for (const repo of boardDue ? config.repos : []) {
        const collector = githubCollector(repo.id);
        if (client instanceof Error) recordStatus(collector, false, client.message);
        else {
          await guarded(collector, async () => {
            const r = await c.github(
              repo,
              store,
              client,
              now(),
              now,
              flightSeat(config)?.session.repoId === repo.id,
            );
            changed.boards ||= r.boards;
            changed.escalations ||= r.escalations;
            // Whoever opened a ticket's PR, its card follows (the engine moves only its runs').
            if (await c.followPrs({ gql: client, store, config, now }, repo.id))
              changed.boards = true;
          });
          const error = store.status().find((s) => s.collector === collector)?.error;
          if (error?.includes(MISSING_SCOPE_PREFIX)) {
            // `gh auth refresh` issues a new token: read it again on the next tick.
            gql = null;
            // Once per repo, after its first poll: the health row has it, the server log should too.
            if (!scopeLogged.has(repo.id)) {
              const line = missingScopeLine(error);
              if (line !== null) deps.log?.(`github ${repo.id}: ${line}`);
            }
          }
          scopeLogged.add(repo.id);
        }
      }
      if (!(client instanceof Error) && boardDue) {
        lastBoardAt = startedAt;
        boardWanted = false;
      }
      if (!(client instanceof Error)) {
        // A waited-PR tick leaves `pollCost` at the last full poll's cost.
        if (boardDue) rates.endPoll(spentBefore);
        const cause = rates.pollCause();
        githubBackoff = nextBackoff(githubBackoff, cause, now());
        githubNotBefore = startedAt + githubBackoff * intervals.github;
        // No known reset: the back-off lasts its one interval.
        githubResetAt = cause?.resetAt ? cause.resetAt : githubNotBefore;
        noteSlowed();
      }
      // The operator's notifications ride the poll: same token, same back-off (it runs only when due).
      let notified = false;
      if (!(client instanceof Error) && rest !== null) {
        const read = rest;
        await guarded(NOTIFICATIONS_COLLECTOR, async () => {
          notified = (await c.notifications(config.repos, store, read, now())).changed;
        });
      }
      if (notified) emit("attention");
      // Board rows and PRs reach the board, escalations the attention items, only when they changed.
      if (changed.boards) emit("boards");
      if (changed.escalations) emit("escalations");
      emitIfChanged("agents", "health", "attention");
      emit("limits");
      sweepAcks();
      // the poll is what the loop waits on (a PR's CI, a merge): each looped run is judged on it
      // (not awaited: a push or a PR may take a while, and the poll's next tick must not wait on it)
      for (const repo of config.repos) void engine?.reconcileRepo(repo.id);
    },
    engine: async () => {
      await engine?.tick();
    },
    update: async () => {
      if (config.updates?.hub !== "auto") return;
      await deps.autoUpdate?.();
    },
    cli: async () => {
      if (config.updates?.cli !== "between_runs") return;
      // runs must not start on a version the smoke test has not passed: held from the upgrade on
      const r = await c.cli(() =>
        cliHold.hold("claude CLI is upgrading; no new runs start until it passes its smoke test"),
      );
      if (!r.cask) {
        // nothing is changed, and a CLI we do not manage holds no run (an earlier hold ends)
        recordStatus(CLI_COLLECTOR, false, r.found ? NOT_A_CASK : "claude is not on PATH");
        store.clearNote(CLI_NOTE_KEY, now());
        cliHold.release();
        emit("health", "attention");
        return;
      }
      const problems = [r.brewProblem].filter((p) => p !== null);
      if (r.smokeFailure === null) {
        const version = r.version === null ? "claude" : `claude ${r.version}`;
        const notes = [`${version}${r.upgraded ? ", upgraded" : ""}`, ...problems];
        recordStatus(CLI_COLLECTOR, problems.length === 0, notes.join("; "));
        store.clearNote(CLI_NOTE_KEY, now());
        if (r.brewProblem?.startsWith(CLI_UPGRADE_FAILED)) {
          store.refreshNote({
            key: CLI_UPGRADE_NOTE_KEY,
            kind: "blocked",
            runId: null,
            seatId: null,
            repoId: null,
            text: `claude CLI upgrade failed: ${r.brewProblem}; runs stay on ${r.version ?? "the installed version"}`,
            at: now(),
          });
        } else {
          store.clearNote(CLI_UPGRADE_NOTE_KEY, now());
        }
        if (cliRetry !== null) clearTimeout(cliRetry);
        cliRetry = null;
        cliHold.release();
      } else {
        const text = cliFailedText(r.version, r.smokeFailure);
        recordStatus(CLI_COLLECTOR, false, [text, ...problems].join("; "));
        store.raiseNote({
          key: CLI_NOTE_KEY,
          kind: "blocked",
          runId: null,
          seatId: null,
          repoId: null,
          text,
          at: now(),
        });
        cliHold.hold(text);
        // a usage limit or a network blip passes sooner than the next 6-hourly check
        if (cliRetry === null) {
          cliRetry = setTimeout(() => {
            cliRetry = null;
            void tick("cli");
          }, CLI_RETRY_MS);
          cliRetry.unref();
        }
      }
      emit("health", "attention");
    },
    usage: async () => {
      for (const acct of config.accounts) {
        await guarded(usageCollector(acct.id), () => usageFor(acct));
      }
      emit("limits", "health");
    },
    maintenance: async () => {
      await store.pruneHistory(now());
      store.pruneDigests(now() - DIGEST_RETENTION_MS);
      store.pruneAgentEvents(now() - AGENT_EVENT_RETENTION_MS);
    },
    prs: async () => {
      if (config.repos.length === 0) return;
      const client = await loadGql();
      if (client instanceof Error) gql = null; // retry next sweep
      let boards = false;
      for (const repo of config.repos) {
        const collector = prSweepCollector(repo.id);
        if (client instanceof Error) recordStatus(collector, false, client.message);
        else {
          await guarded(collector, async () => {
            if (
              (
                await c.prSweep(
                  repo,
                  store,
                  client,
                  now(),
                  flightSeat(config)?.session.repoId === repo.id,
                )
              ).boards
            )
              boards = true;
            if (await c.followPrs({ gql: client, store, config, now }, repo.id)) boards = true;
          });
        }
      }
      if (boards) emit("boards");
    },
    teams: async () => {
      if (deps.teamsEnabled === false) return;
      if ((await collectTeams(config, store, now())).changed) {
        emit("attention");
        emit("flight");
      }
    },
    flow: async () => {
      if (config.repos.length === 0) return;
      const client = await loadGql();
      if (client instanceof Error) gql = null; // retry next run
      for (const repo of config.repos) {
        const collector = flowCollector(repo.id);
        if (client instanceof Error) recordStatus(collector, false, client.message);
        else await guarded(collector, () => c.flow(repo, store, client, now()));
      }
    },
    backfill: () =>
      guarded(BACKFILL_COLLECTOR, async () => {
        const at = now();
        // One budgeted job per tick: the one-offs (summaries, then titles), then the fold backfill.
        if (!summariesDone) {
          const s = c.rewriteSummaries({ config, store, budgetMs: BACKFILL_BUDGET_MS });
          summariesDone = s.done;
          if (s.rewritten > 0) emit("agents");
          if (s.rewritten > 0 || !s.done) return; // it spent this tick's budget
        }
        if (!titlesDone && githubDue()) {
          const client = await loadGql();
          if (client instanceof Error)
            gql = null; // retry next run; the fold backfill goes on
          else {
            const t = await c.fillTitles({
              config,
              store,
              fetchTicket: (repo, n) => fetchTicket(repo, n, client, config.repos),
            });
            titlesDone = t.done;
            if (t.filled > 0) emit("agents");
            if (t.filled > 0) return;
          }
        }
        if (backfillDone && store.countToFold(at - FOLD_WINDOW_MS) === 0) return;
        const t0 = performance.now();
        const r = c.backfill({ config, store, now: at, budgetMs: BACKFILL_BUDGET_MS });
        backfillDone = r.left === 0;
        const note =
          r.failed > 0
            ? `${r.left} older runs left to read · ${r.failed} failed`
            : r.left > 0
              ? `${r.left} older runs left to read`
              : null;
        recordStatus(BACKFILL_COLLECTOR, true, note);
        if (r.folded > 0) emit("agents");
        deps.debug?.(
          `backfill: ${r.folded} runs in ${Math.round(performance.now() - t0)} ms, ${r.left} left`,
        );
      }),
    transcripts: async () => {
      const r = await (c.transcripts ?? maintainTranscripts)({
        store,
        now: now(),
        retention: config.crew?.transcripts ?? TRANSCRIPT_RETENTION_DEFAULTS,
      });
      if (r.gzipped || r.deleted || r.failed.length)
        deps.log?.(
          `transcripts: ${r.gzipped} gzipped, ${r.deleted} deleted, ${r.failed.length} failed`,
        );
    },
    machine: async () => {
      if (deps.hasViewClients?.() === false && !config.crew?.sessions.length) return;
      const at = now();
      const spawn = machineSpawns();
      // the first fresh reading after an idle spell is stored at once, so the guard sees it
      if (spawn && !lastSpawned) machineMinute = -1;
      lastSpawned = spawn;
      const r = await c.machine(
        machineCpus,
        latestMachine,
        at,
        deps.lockState?.().holder?.command ?? null,
        spawn,
      );
      machineCpus = r.cpus;
      latestMachine = r.sample;
      emit("machine");
      const ok = r.errors.length === 0;
      const error = ok ? null : r.errors.join("; ");
      const last = machineStatus;
      if (!last || last.ok !== ok || last.error !== error || at - last.at >= MACHINE_STATUS_MS) {
        machineStatus = { ok, error, at };
        recordStatus(MACHINE_COLLECTOR, ok, error);
      }
      const minute = Math.floor(at / 60_000);
      if (minute !== machineMinute) {
        store.addMachineSample(r.sample);
        machineMinute = minute;
        const capacityConfig = deps.config.crew?.machineCapacity ?? MACHINE_CAPACITY_DEFAULTS;
        const capacity = machineCapacity(
          store.machineSamples(machineCapacitySince(at, capacityConfig)),
          at,
          capacityConfig,
        );
        machineBlocked = capacity.blocked;
        if (capacity.blocked) {
          const gb = (bytes: number | null | undefined): string =>
            bytes === null || bytes === undefined ? "—" : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
          const diskPct =
            r.sample.diskFreeBytes !== null &&
            r.sample.diskTotalBytes !== null &&
            r.sample.diskTotalBytes > 0
              ? `${((r.sample.diskFreeBytes / r.sample.diskTotalBytes) * 100).toFixed(1)}%`
              : "—";
          const consumers = r.sample.topConsumers?.length
            ? r.sample.topConsumers
                .map(
                  (p) =>
                    `${p.command} (pid ${p.pid}, ${gb(p.rssBytes)}, ${p.cpuPct.toFixed(1)}% CPU)`,
                )
                .join("; ")
            : "unavailable";
          store.refreshNote({
            key: MACHINE_CAPACITY_KEY,
            kind: "flag",
            runId: null,
            seatId: null,
            repoId: null,
            text: `Machine headroom is tight: ${capacity.reason}. Disk: ${gb(r.sample.diskFreeBytes)} free (${diskPct}). Swap used: ${gb(r.sample.swapUsedBytes)}. RAM: ${gb(r.sample.memTotalBytes)}. Memory pressure free: ${r.sample.memoryPressureFreePct?.toFixed(1) ?? "—"}%. Load: ${r.sample.load1?.toFixed(1) ?? "—"} on ${r.sample.cores} cores. Top consumers: ${consumers}. New crew runs and reviews are paused; running work continues.`,
            at,
          });
        } else {
          store.clearNote(MACHINE_CAPACITY_KEY, at);
        }
        emit("attention");
      }
    },
  };

  /** Never rejects: the timers call it as `void tick(job)`, where a rejection would kill the process. */
  const tick = async (job: Job): Promise<"ran" | "skipped"> => {
    if (inFlight.has(job)) return "skipped";
    const p = (async () => {
      try {
        await jobs[job]();
      } catch (e) {
        recordStatus(`scheduler:${job}`, false, msg(e));
      }
    })();
    inFlight.set(job, p);
    await p;
    if (SIGNAL_LOOPS.includes(job)) {
      flightLoopHeartbeat(store, job, now(), intervals[job]);
    }
    inFlight.delete(job);
    return "ran";
  };

  const clearUsageRetry = () => {
    if (usageRetryTimer !== null) clearTimeout(usageRetryTimer);
    usageRetryTimer = null;
  };

  const scheduleUsageRetry = () => {
    clearUsageRetry();
    const backoff = usageBackoff;
    if (!backoff || backoff.waitMs === 0 || backoff.notBefore <= now()) return;
    usageRetryTimer = setTimeout(() => {
      usageRetryTimer = null;
      void tick("usage");
    }, backoff.notBefore - now());
    usageRetryTimer.unref();
  };

  const intervals: Record<Job, number> = {
    teams: 60_000,
    ta: LOOP_INTERVAL_MS,
    studio: LOOP_INTERVAL_MS,
    sessions: LOOP_INTERVAL_MS,
    github: config.poll.githubSeconds * 1000,
    usage: config.poll.usageMinutes * 60_000,
    maintenance: MAINTENANCE_INTERVAL_MS,
    transcripts: TRANSCRIPT_PASS_INTERVAL_MS,
    machine: MACHINE_INTERVAL_MS,
    prs: PR_SWEEP_MS,
    flow: FLOW_INTERVAL_MS,
    backfill: BACKFILL_INTERVAL_MS,
    engine: ENGINE_TICK_MS,
    update: VERSION_CHECK_MS,
    cli: CLI_UPDATE_INTERVAL_MS,
  };

  const FIRST_DELAY_MS: Partial<Record<Job, number>> = {
    engine: ENGINE_FIRST_DELAY_MS,
    prs: PR_SWEEP_FIRST_DELAY_MS,
    flow: FLOW_FIRST_DELAY_MS,
    backfill: BACKFILL_FIRST_DELAY_MS,
    transcripts: TRANSCRIPT_PASS_FIRST_DELAY_MS,
  };

  const refreshBoards = () => {
    boardWanted = true;
    if (triggerTimer !== null) return;
    const wait = Math.max(BOARD_TRIGGER_DELAY_MS, lastBoardAt + BOARD_REFRESH_DEBOUNCE_MS - now());
    triggerTimer = setTimeout(() => {
      triggerTimer = null;
      // while backed off the ask stays (boardWanted): the first tick after the back-off reads
      if (!githubDue()) return;
      // a poll still in flight is asked again
      void tick("github").then((r) => {
        if (r === "skipped") refreshBoards();
      });
    }, wait);
    triggerTimer.unref();
  };

  return {
    setEngine(e) {
      engine = e;
    },
    refreshBoards,
    start() {
      if (timers.length > 0) return;
      const at = now();
      const saved = store.getSetting(USAGE_BACKOFF_SETTING);
      if (saved !== null) {
        try {
          const parsed = JSON.parse(saved);
          if (
            parsed &&
            Number.isFinite(parsed.waitMs) &&
            parsed.waitMs > 0 &&
            Number.isFinite(parsed.notBefore)
          ) {
            usageBackoff = {
              waitMs: Math.min(parsed.waitMs, USAGE_BACKOFF_CAP_MS),
              notBefore: Math.min(parsed.notBefore, at + USAGE_BACKOFF_CAP_MS),
            };
            store.setSetting(USAGE_BACKOFF_SETTING, JSON.stringify(usageBackoff));
          } else store.deleteSetting(USAGE_BACKOFF_SETTING);
        } catch {
          store.deleteSetting(USAGE_BACKOFF_SETTING);
        }
      }
      if (!usageBackoff) {
        const recent = config.accounts
          .filter((acct) => acct.vendor === "claude")
          .flatMap((acct) => WINDOWS.flatMap((w) => store.usage(acct.id, w, at - intervals.usage)))
          .filter((s) => s.source === OAUTH_USAGE_SOURCE && at - s.at < intervals.usage)
          .sort((a, b) => b.at - a.at)[0];
        if (recent) usageBackoff = { waitMs: 0, notBefore: recent.at + intervals.usage };
      }
      scheduleUsageRetry();
      store.setSetting(FLIGHT_LOOPS_SETTING, "{}");
      unsubscribeCrew = bus.subscribe((t) => {
        if (t === "agents") recordCrewSoon();
        if (["agents", "escalations", "attention", "flight", "boards", "config"].includes(t))
          scheduleTriage();
      });
      scheduleTriage();
      if (config.repos.length > 0) void loadGql();
      for (const job of JOBS) {
        // no engine, no engine timer (a scheduler without one has nothing to tick)
        if (job === "engine" && engine === null) continue;
        // `updates.hub: off` (the default) starts no update timer
        if (job === "update" && (deps.autoUpdate === undefined || config.updates?.hub !== "auto"))
          continue;
        // `updates.cli: off` (the default) starts no update timer
        if (job === "cli" && config.updates?.cli !== "between_runs") continue;
        const every = () => {
          const t = setInterval(() => {
            if (job === "github" && !githubDue()) return;
            void tick(job);
          }, intervals[job]);
          t.unref();
          timers.push(t);
        };
        const delay = FIRST_DELAY_MS[job];
        if (SIGNAL_LOOPS.includes(job)) {
          flightLoopHeartbeat(store, job, now() + (delay ?? 0), intervals[job], false);
        }
        if (delay === undefined) {
          void tick(job);
          every();
          continue;
        }
        // An interval shorter than the delay starts with the first run (else it would run the job
        // early); a longer one keeps its phase from start().
        const late = intervals[job] < delay;
        const first = setTimeout(() => {
          void tick(job);
          if (late) every();
        }, delay);
        first.unref();
        timers.push(first);
        if (!late) every();
      }
    },
    async stop() {
      for (const t of timers.splice(0)) clearTimeout(t); // also clears intervals
      clearUsageRetry();
      unsubscribeCrew?.();
      unsubscribeCrew = null;
      if (triageTimer !== null) clearTimeout(triageTimer);
      triageTimer = null;
      if (cliRetry !== null) clearTimeout(cliRetry);
      cliRetry = null;
      if (triggerTimer !== null) clearTimeout(triggerTimer);
      triggerTimer = null;
      if (crewTimer !== null) clearTimeout(crewTimer);
      crewTimer = null;
      await Promise.all([...inFlight.values()]);
      store.setSetting(FLIGHT_LOOPS_SETTING, "{}");
      flushEmits();
    },
    tick,
    sessions: () => liveSessions ?? [],
    machine: () => latestMachine,
  };
}
