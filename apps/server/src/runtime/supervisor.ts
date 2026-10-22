/**
 * The crew supervisor: owns the seats' sessions (spec §5, Agent runtime). It starts a run (a
 * checkout in Mission Control's own clone, then one long-lived `claude -p`), routes Send,
 * Interrupt-and-send and Stop, tracks each seat's state from the session's events, and folds the
 * run's transcript into its `runs` row exactly as the loop collectors do.
 *
 * Every action here is an outward one taken on the operator's click (§4.3); nothing starts a seat on its
 * own. Only one process may run crew: `start()` takes `<crew.worktrees>/.mc-crew.lock`, and a
 * server that cannot (or runs with `enabled: false`) answers every action with a 409.
 *
 * On hub shutdown (`stopAll`) processes are ended but their runs stay active, so the next start
 * resumes them rather than marking them failed.
 *
 * Each process gets the mc tools (`--mcp-config`) and the guard hook, both keyed to a per-run token
 * issued at its spawn (a resume gets a new one). The token lives in hub memory and in two 0600
 * files in `{DB dir}/crew/`, which only the hub and the hook (outside the sandbox) read; argv, env
 * and settings carry the files' paths only. When the process exits, for any reason, the token is
 * revoked, the run's test-lock hold freed and both files removed.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  BLOCKING_SEVERITIES,
  type ContextUsage,
  CREW_CLI_ENV,
  CREW_DISABLED,
  clockHm,
  compactUtc,
  crewCliArgs,
  crewMcpConfig,
  crewPnpmStoreDir,
  DEFAULT_CREW_NODE,
  GUARD_CHECK_PATH,
  GUARD_HOOK_TIMEOUT_S,
  guardHookCommand,
  inferTicket,
  LOOPBACK_HOST,
  MCP_PATH,
  modeOfSeat,
  NOT_ASIDE,
  notReviewSeatText,
  notWatchSeatText,
  PNPM_STORE_ENV,
  REVIEW_NOT_WANTED,
  ROLE_PROMPT_DIR,
  type Run,
  type RunLoop,
  retiringText,
  reworkFirstText,
  type SeatSessionRow,
  type SeatState,
  scratchStartRefusedText,
  seatCallSign,
  seatDef,
  type TicketView,
  ticketInReviewText,
  watchCheckoutName,
  watchStartRefusedText,
} from "@mc/core";
import type { ChangeBus } from "../bus.ts";
import type { CliHold } from "../cli-update.ts";
import { probeClaudeVersion } from "../cli-version.ts";
import { applyFacts, type FoldState, foldPath, persistDigest } from "../collectors/common.ts";
import {
  type CcConfig,
  type CrewSeatConfig,
  type CrewSessionConfig,
  crewOwnFolders,
  gitCommonDir,
  isInside,
  realish,
} from "../config.ts";
import { wakeDueAsideRun } from "../engine/aside.ts";
import { HOOK_ENTRY } from "../guard/hook.ts";
import type { TestLock } from "../guard/lock.ts";
import type { RunTokens } from "../mcp/tokens.ts";
import { issueOf } from "../mcp/tools.ts";
import { SHUTDOWN_TIMEOUT_MS } from "../shutdown.ts";
import {
  ACTIVE_SEAT_STATES,
  CREW_PR_BODY_FILE,
  crewDir,
  crewMcpPath,
  crewPromptPath,
  crewTokenPath,
  crewTranscriptPath,
  type Store,
} from "../store.ts";
import { readRepoClaudeMd, reviewBrief, rolePrompt, ticketBrief, watchBrief } from "./brief.ts";
import {
  existingCheckout,
  existingScratch,
  prepareCheckout,
  prepareDetachedCheckout,
  preparePlanCheckout,
  prepareScratch,
  removeCheckout,
  writeReviewInputs,
} from "./checkouts.ts";
import { type CrewSession, type SessionEvent, startSession } from "./session.ts";

/** In `crew.worktrees`; holds the pid of the one process that runs crew. */
export const CREW_LOCK_FILE = ".mc-crew.lock";
/** How long hub shutdown waits for crew processes to exit: half its whole allowance. */
export const CREW_STOP_WAIT_MS = SHUTDOWN_TIMEOUT_MS / 2;
/** A running seat's transcript is folded at most this often while it writes. */
export const CREW_FOLD_EVERY_MS = 1000;
/** The only variables a crew process inherits from the hub (no tokens, no `ANTHROPIC_*`). */
const CREW_ENV_KEYS = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SHELL",
  "TERM",
] as const;
const LAST_TURN_ERROR = "last turn ended in an error";
const SHUTTING_DOWN = "the server is shutting down";
const CANNOT_START = "could not start the CLI";
const RESUMED = "resumed after a restart; send a message to continue";
const RESUME_FAILED = "could not resume the session";
const RESUME_MODE_CHANGED = "could not resume: the seat's mode changed";
/**
 * A resumed process that exits this soon after its spawn failed to resume. The real CLI prints
 * nothing until its first user line, so an early exit is the only early sign.
 */
export const RESUME_WINDOW_MS = 5000;
/** A run's token and MCP files, and the temp names they are written under, in `{DB dir}/crew/`. */
const RUN_SECRET_FILE = /\.(token|mcp\.json)(\.tmp-[0-9a-f-]+)?$/;

/**
 * What a seat of session `sessionId` may not read beyond the credential folders and the data dir,
 * deduped, in order: the hub's checkout, every loop's worktree, state dir and logs dir, every
 * other crew session's checkout, then `crew.deny_read`. The hub's checkout and each loop's
 * worktree are followed by their git common dir, which lies elsewhere when they are linked
 * worktrees (a loop's worktree of `~/code/shop-app`). A loop's common dir that is `<repo>/.git` is
 * followed by `<repo>` itself, the repo's main working tree (`~/code/shop-app`), unless that folder is
 * or holds one the seat needs (`crewOwnFolders`). Each by its real path (a folder that doesn't
 * exist yet by its deepest existing ancestor's), since the sandbox matches real paths. `extra`
 * (a review seat's session-mates' worktrees) comes last.
 */
export function seatDenyRead(
  config: CcConfig,
  hubRoot: string,
  sessionId: string,
  extra: readonly string[] = [],
): string[] {
  const own = config.crew ? crewOwnFolders(config.crew) : [];
  const withGitDir = (dir: string, mainTree: boolean) => {
    const common = gitCommonDir(dir);
    if (common === null) return [dir];
    const repo = dirname(common);
    const denyRepo = mainTree && basename(common) === ".git" && !own.some((f) => isInside(f, repo));
    return denyRepo ? [dir, common, repo] : [dir, common];
  };
  const paths = [
    ...withGitDir(hubRoot, false),
    ...config.loops.flatMap((l) => [
      ...withGitDir(l.worktree, true),
      l.stateDir,
      ...(l.logsDir ? [l.logsDir] : []),
    ]),
    ...(config.crew?.sessions ?? []).filter((x) => x.id !== sessionId).map((x) => x.checkout),
    ...(config.crew?.denyRead ?? []),
    ...extra,
  ];
  return [...new Set(paths.map(realish))];
}

/**
 * Writes one of a run's private files atomically: a temp name created at 0600 (never an existing
 * file), then renamed into place, so a reader never sees it partly written or more open.
 */
function writePrivate(path: string, text: string): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the start's own failure is the one to report
    }
    throw e;
  }
}

/** What a crew action that failed unexpectedly says to a caller: no path, no git text. */
export const CREW_ACTION_FAILED = "crew action failed";

/** A refused action, with the HTTP status a route answers it with. */
export class SupervisorError extends Error {
  readonly status: number;
  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SupervisorError";
    this.status = status;
  }
}

export interface SupervisorDeps {
  config: CcConfig;
  store: Store;
  bus: ChangeBus;
  /** The DB path: transcripts and prompt files live in `{its dir}/crew/`. */
  dbPath: string;
  now?: () => number;
  /** Default `"claude"`; tests pass `process.execPath` and the fake CLI in `commandArgs`. */
  command?: string;
  /** Put before the CLI's own arguments. */
  commandArgs?: string[];
  fetchTicket: (repo: CcConfig["repos"][number], n: number) => Promise<TicketView | null>;
  /** Assigns the hub's own login to the issue, when a run starts on it (any repo, `merge` or `draft`). */
  claim?: (repo: CcConfig["repos"][number], n: number) => Promise<void>;
  /** false: `MC_NO_CREW=1`, or no `crew` config. */
  enabled: boolean;
  /** Per-run tokens for `/mcp` and the guard: issued at each spawn, revoked at its exit. */
  tokens: RunTokens;
  /** The test lock: a run's hold goes when its call's tool_result comes, its turn ends or it exits. */
  lock: TestLock;
  /** The hub's port on loopback: the seats' MCP and guard URLs. */
  hubPort: number;
  /** The hub's own checkout: the roles and the guard hook's entry (`HOOK_ENTRY`). */
  hubRoot: string;
  /** Default `{hub root}/roles`. */
  rolesDir?: string;
  /** Where a failure no caller sees goes (a fold that cannot write). Default: stderr. */
  log?: (msg: string) => void;
  /**
   * While it holds, no run starts or resumes (the CLI failed its smoke test); runs going are left
   * alone, and the held resumes are tried again when the hold is released.
   */
  cliHold?: CliHold;
  /** The `claude` CLI's version, recorded on each run that starts. Default: `claude --version`, cached. */
  cliVersion?: () => Promise<string | null>;
  /** Default RESUME_WINDOW_MS. */
  resumeWindowMs?: number;
  /** Tests shorten the session's timeouts. */
  controlTimeoutMs?: number;
  stopGraceMs?: number;
}

/** Who ended a run. */
export type EndedBy = NonNullable<Run["endedBy"]>;

/**
 * What the supervisor tells its listeners. `idle`: a seat with an active run left a turn, or was
 * resumed. `run-ended`: after the store has the end, from every end path. `evidence`: the seat
 * reported through `mc report_evidence`.
 */
export type SupervisorEvent =
  | { kind: "idle"; seatId: string; runId: string; resumed: boolean }
  | { kind: "run-ended"; seatId: string; runId: string; endedBy: EndedBy }
  | { kind: "evidence"; seatId: string; runId: string }
  | { kind: "findings"; seatId: string; runId: string };

/** What `send` did with a keyed line. */
export type SendResult = "sent" | "busy" | "dup" | "gone";

/** What the snapshot reads of a seat's process. */
export interface SeatFacts {
  inTurn: boolean;
  /** `Date.now()` at the resume that spawned the process; null for a fresh start. */
  resumedAt: number | null;
  /** When the rate limit that parked the seat lifts (ms); null once a line has been written. */
  rateLimitedUntil: number | null;
}

export interface Supervisor {
  /** Calls `fn` for each event from now on; returns the unsubscribe. A throwing `fn` is logged. */
  on(fn: (e: SupervisorEvent) => void): () => void;
  /** Tells listeners a seat's run got evidence (`mc report_evidence` calls this after recording). */
  emitEvidence(seatId: string, runId: string): void;
  /** Tells listeners a review run reported its findings (`mc report_findings` calls this). */
  emitFindings(seatId: string, runId: string): void;
  /**
   * Writes the hub's keyed line to the seat, only between turns. `gone`: the run ended or is not
   * its seat's current run; `busy`: no live process yet, or a turn is on (the key stays free), or
   * this server does not run crew (disabled, or without the crew lock); `dup`: the key was used.
   * Allowed while the seat is rate-limited. Never answers questions.
   */
  send(runId: string, key: string, text: string): Promise<SendResult>;
  /** null when the seat has no live process. */
  seatFacts(seatId: string): SeatFacts | null;
  /**
   * Ends the run `ok`, `endedBy: "engine"`, only when it is its seat's current run, closes its
   * process, removes its worktree (a failure leaves a `cleanup:<run>` blocked note) and leaves the
   * seat idle. An ended or unknown run is left alone, with no event. A run Stop is already ending
   * stays Stop's (endedBy operator, seat stopped, worktree kept). Does nothing on a server that
   * does not run crew (disabled, or without the crew lock).
   */
  endRunByEngine(runId: string): Promise<void>;
  /**
   * Takes the run off its seat while it is in review: the process is closed, the worktree kept and
   * the seat left idle with no run; the run is not ended and no event is emitted. Null (nothing
   * done) unless the seat holds the run, its process is alive between turns and no start is on.
   * Never throws.
   */
  setAside(runId: string): Promise<{ worktree: string } | null>;
  /**
   * Puts a set-aside run back on its seat: its CLI session resumed in its own worktree, with no
   * "carry on" line. A 409 while the seat is busy (or the run is not aside); a run that cannot be
   * resumed is ended `failed` and a 500 thrown.
   */
  wakeRun(runId: string): Promise<void>;
  /**
   * Takes the crew lock, then resumes every active run once, in the background. Does nothing when
   * disabled; never throws (a failure leaves crew off with a note, or one seat in error).
   */
  start(): void;
  /** Ends every process (runs stay active for the reattach) and releases the lock. */
  stopAll(): Promise<void>;
  /** `opts.loop`: the run row is created with this loop state. */
  startRun(
    seatId: string,
    issue: number,
    opts?: { loop: RunLoop },
  ): Promise<{ runId: string; branch: string }>;
  /**
   * Starts the watch seat (FLIGHT): no ticket and no branch, a detached worktree of the default
   * branch, and the watch brief as its one first line, then `opts.first` after a blank line.
   */
  startWatch(seatId: string, opts?: { first?: string }): Promise<{ runId: string }>;
  /**
   * Starts a review run on a scratch seat: a detached worktree at the review's sha with the diff
   * files in `.mc-review/`, the CLI in scratch mode (its session-mates' worktrees, the author's
   * included, are read-denied) and RETRO's brief. Refuses a review that is no longer wanted. The
   * worktree goes when the run ends, however it ends.
   */
  startReview(seatId: string, reviewId: number): Promise<{ runId: string }>;
  /**
   * `questions` says which of the seat's open questions the message closes: all (the default, the
   * operator's reply), only those not passed to the operator, or none.
   */
  message(
    seatId: string,
    text: string,
    opts: { interrupt: boolean; questions?: "all" | "unpassed" | "none" },
  ): Promise<void>;
  interrupt(seatId: string): Promise<void>;
  endRun(seatId: string): Promise<void>;
  /** null when the seat has no live session, or it did not answer. */
  contextUsage(seatId: string): Promise<ContextUsage | null>;
  seat(seatId: string): SeatSessionRow | null;
  /**
   * Seats busy in memory, which their rows may not show yet: a start or resume before its process
   * runs (its checkout, its install), and a seat mid-turn (a line written counts at once, before
   * the CLI's turn starts). Never throws.
   */
  busy(): SeatBusy[];
  /** Whether the seat is starting, has a process, or its seat row is active; a store error counts as busy. */
  seatBusy(seatId: string): boolean;
  status(): { enabled: boolean; note: string | null };
  /**
   * Runs `fn` after everything queued for the clone `checkout` (a checkout, a commit); a failure
   * does not block what follows. The mc tools' git writes go through here.
   */
  inClone<T>(checkout: string, fn: () => Promise<T>): Promise<T>;
}

/** One seat `busy()` names. */
export interface SeatBusy {
  seatId: string;
  state: Extract<SeatState, "starting" | "running">;
}

interface SeatInfo {
  seat: CrewSeatConfig;
  session: CrewSessionConfig;
  repo: CcConfig["repos"][number];
}

/** A seat with a process. */
interface Live {
  info: SeatInfo;
  session: CrewSession;
  run: Run;
  /** Every line and control request goes through here, so they keep their order. */
  chain: Promise<void>;
  /** A user line has been written and its turn's `result` has not come. */
  inTurn: boolean;
  /** An interrupt was sent during this turn: its error result is the interrupt, not a failure. */
  interrupted: boolean;
  /** A `rejected` rate limit came this turn: the seat stays parked until the next line. */
  parkedTurn: boolean;
  /** The operator or the engine ended the run: the exit is `ok`, not a crash. */
  ending: Promise<void> | null;
  /** Who is ending the run, while `ending` is set. */
  endedBy: Exclude<EndedBy, "exit"> | null;
  /** When the rate limit that parked this turn lifts (ms); null until one comes, and after a line. */
  rateLimitedUntil: number | null;
  lastFoldAt: number;
  foldTimer: NodeJS.Timeout | undefined;
  /** `Date.now()` at a resume's spawn; null for a fresh start. */
  resumedAt: number | null;
  /** Stops this seat's events reaching the supervisor (a process being discarded). */
  off: () => void;
  /** The process's last stderr line (cleaned), for the reason when it crashes. */
  lastStderr: string | null;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const pidAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: alive, owned by someone else
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** `get_context_usage`'s answer, or null when it is not the shape the CLI sends (spike). */
function toContextUsage(v: unknown): ContextUsage | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.categories)) return null;
  const categories: ContextUsage["categories"] = [];
  for (const c of r.categories) {
    const name = (c as { name?: unknown })?.name;
    const tokens = (c as { tokens?: unknown })?.tokens;
    if (typeof name === "string" && typeof tokens === "number" && Number.isFinite(tokens)) {
      categories.push({ name: name.slice(0, 100), tokens });
    }
  }
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const total = num(r.totalTokens);
  if (total === null) return null;
  return { categories, total, window: num(r.maxTokens) };
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const { config, store, bus } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => process.stderr.write(`crew: ${msg}\n`));
  const crew = config.crew;

  /** Read per call: the crew reloader changes the config's seats while the hub runs. */
  function findSeat(seatId: string): SeatInfo | undefined {
    for (const session of crew?.sessions ?? []) {
      const seat = session.seats.find((s) => s.id === seatId);
      if (seat === undefined) continue;
      const repo = config.repos.find((r) => r.id === session.repoId);
      return repo === undefined ? undefined : { seat, session, repo }; // the loader refuses a missing repo
    }
    return undefined;
  }

  const live = new Map<string, Live>();
  /** Seats whose start is between the busy check and the first seat row. */
  const starting = new Set<string>();
  /** Per clone: `prepareCheckout` calls queue here (concurrent fetch/prune race on ref locks). */
  const cloneQueues = new Map<string, Promise<unknown>>();
  const transcripts = new Map<string, FoldState>();
  /** Per run: its newest spawn, which owns the run's token, files and test-lock hold. */
  const spawns = new Map<string, object>();
  const digests = new Map<string, string>();
  let started = false;
  let holdsLock = false;
  let lockNote: string | null = null;
  let stopping = false;
  /** Stops listening for the CLI hold's release (set by `start`). */
  let unholdResume: (() => void) | undefined;
  const listeners = new Set<(e: SupervisorEvent) => void>();

  /** Never throws: a listener's failure is logged and the others still hear the event. */
  function emit(e: SupervisorEvent): void {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch (err) {
        log(`${e.seatId}: a ${e.kind} listener failed: ${errText(err)}`);
      }
    }
  }

  const lockPath = () => join(crew?.worktrees ?? "", CREW_LOCK_FILE);

  /** Whether this server runs crew now: enabled, configured, no lock note and holding the lock. */
  const mayAct = () => deps.enabled && crew !== undefined && lockNote === null && holdsLock;

  /** `gone`: the run is unknown, ended, or not its seat's current one. */
  const runGone = (runId: string, seatId: string): boolean =>
    store.run(runId)?.endedAt !== null || store.seatSession(seatId)?.runId !== runId;

  /** Throws unless this server runs crew; returns the seat. */
  function need(seatId: string): SeatInfo {
    if (!mayAct()) throw new SupervisorError(409, lockNote ?? CREW_DISABLED);
    const info = findSeat(seatId);
    if (!info) throw new SupervisorError(404, "unknown seat");
    return info;
  }

  /** Throws while the CLI is held back (it failed its smoke test): nothing starts or resumes. */
  function refuseWhileHeld(): void {
    const why = deps.cliHold?.reason;
    if (why != null) throw new SupervisorError(409, why);
  }

  /**
   * The run's `cliVersion` field: the version it starts on, else nothing. Called just before the
   * run is created, so it also refuses a start the hold caught during the checkout or the read.
   */
  async function startedOn(): Promise<{ cliVersion?: string }> {
    refuseWhileHeld();
    let v: string | null = null;
    try {
      v = await (deps.cliVersion ?? probeClaudeVersion)();
    } catch {
      // the run starts without a recorded version
    }
    refuseWhileHeld();
    return v === null ? {} : { cliVersion: v };
  }

  /** The seat's call sign in every message and commit (`guido-1` → `GUIDO-1`). */
  const call = (info: SeatInfo): string => seatCallSign(info.seat.id);
  const noLive = (info: SeatInfo) =>
    new SupervisorError(409, `${call(info)} has no live session; start it on a ticket`);

  function liveOrRefuse(info: SeatInfo): Live {
    const l = live.get(info.seat.id);
    if (!l?.session.alive || l.ending !== null) throw noLive(info);
    return l;
  }

  function setSeat(seatId: string, patch: Partial<SeatSessionRow>): void {
    const prev = store.seatSession(seatId) ?? {
      seatId,
      runId: null,
      cliSessionId: null,
      state: "idle" as SeatState,
      reason: null,
      worktree: null,
      updatedAt: 0,
    };
    store.setSeatSession({ ...prev, ...patch, seatId, updatedAt: now() });
    bus.emit("agents");
  }

  const setState = (l: Live, state: SeatState, reason: string | null) => {
    const row = store.seatSession(l.info.seat.id);
    if (row?.state === state && row.reason === reason) return;
    setSeat(l.info.seat.id, { state, reason });
  };

  /**
   * Folds new transcript lines into the run row (written when it changed, or when `write`) and its
   * digest. The row is marked folded only when the fold read the transcript. Never throws: it runs
   * from a timer, where a store error (a locked DB) would crash the hub; a failure is logged and
   * the next fold writes again.
   */
  function fold(l: Live, write = false): void {
    clearTimeout(l.foldTimer);
    l.foldTimer = undefined;
    l.lastFoldAt = Date.now();
    let facts: ReturnType<typeof foldPath> = null;
    try {
      facts = foldPath(transcripts, l.run.transcriptPath);
    } catch {
      // unreadable now: the next fold (or the backfill, once ended) reads it again
    }
    const r: Run = { ...l.run };
    if (facts) applyFacts(r, facts);
    try {
      if (write || JSON.stringify(r) !== JSON.stringify(l.run)) {
        store.upsertRun(r, facts !== null);
        l.run = r;
        bus.emit("agents");
      }
      if (facts) persistDigest(store, digests, r.id, facts.digest);
    } catch (e) {
      // `l.run` keeps the last row written, so the next fold sees the change and writes it
      if (write) l.run = r;
      log(`${l.info.seat.id}: could not record run ${r.id}: ${errText(e)}`);
    }
  }

  function foldSoon(l: Live): void {
    if (l.foldTimer !== undefined) return;
    const wait = Math.max(0, l.lastFoldAt + CREW_FOLD_EVERY_MS - Date.now());
    l.foldTimer = setTimeout(() => fold(l), wait);
    l.foldTimer.unref();
  }

  function onExit(l: Live, e: { code: number | null; signal: string | null }): void {
    const seatId = l.info.seat.id;
    if (live.get(seatId) === l) live.delete(seatId);
    if (stopping && l.ending === null) {
      // The hub is going down: the run stays active and is resumed on the next start.
      fold(l);
      return;
    }
    // The engine's end was recorded when it began (its time and status stand).
    const byEngine = l.endedBy === "engine";
    l.run = {
      ...l.run,
      endedAt: byEngine ? (l.run.endedAt ?? now()) : now(),
      status: l.ending !== null ? "ok" : "failed",
    };
    fold(l, true);
    transcripts.delete(l.run.transcriptPath);
    digests.delete(l.run.id);
    if (byEngine) return;
    store.setRunEnded(l.run.id, l.run.endedAt as number, l.run.status, l.endedBy ?? "exit");
    closeRunItems(l.info);
    // read before the seat row changes
    const worktree = store.seatSession(seatId)?.worktree ?? null;
    if (l.run.reviewId != null) void dropScratch(l.info, l.run.id, l.run.seq, worktree);
    if (l.ending !== null) {
      setSeat(seatId, { state: "stopped", reason: null, runId: null });
    } else {
      // Neither a code nor a signal: the CLI never started (its stderr event says why).
      const how = e.code ?? e.signal;
      const resumeWindow = deps.resumeWindowMs ?? RESUME_WINDOW_MS;
      const failedResume = l.resumedAt !== null && Date.now() - l.resumedAt < resumeWindow;
      const why = failedResume
        ? RESUME_FAILED
        : how === null
          ? CANNOT_START
          : `process exited ${how}`;
      // A CLI that ran and failed: its own last word (already cleaned and cut) says why. One that
      // never started keeps the fixed text (the spawn error names the command's path; it is logged).
      const said = how !== null && l.lastStderr !== null ? `: ${l.lastStderr}` : "";
      setSeat(seatId, { state: "error", reason: `${why}${said}` });
    }
    emit({ kind: "run-ended", seatId, runId: l.run.id, endedBy: l.endedBy ?? "exit" });
  }

  function onEvent(l: Live, e: SessionEvent): void {
    switch (e.kind) {
      case "turn-start":
        l.inTurn = true;
        if (!l.parkedTurn) setState(l, "running", null);
        break;
      case "tool-result":
        // the call has ended, however it ended: its hold goes (a Post hook may never come)
        deps.lock.release({ runId: l.run.id, toolUseId: e.toolUseId });
        break;
      case "result": {
        // no call is in flight once the turn has ended: whatever the run held is freed
        deps.lock.releaseRun(l.run.id);
        const interrupted = l.interrupted;
        l.inTurn = false;
        l.interrupted = false;
        fold(l);
        if (l.parkedTurn) {
          l.parkedTurn = false; // parked stays until the next line starts a turn
          break;
        }
        // An interrupted turn ends `is_error` (error_during_execution): that is the interrupt.
        setState(l, "idle", e.isError && !interrupted ? LAST_TURN_ERROR : null);
        store.setSeatTurnEnded(l.info.seat.id, now());
        // a run being ended is no one's to nudge
        if (l.ending === null) {
          emit({ kind: "idle", seatId: l.info.seat.id, runId: l.run.id, resumed: false });
        }
        break;
      }
      case "rate-limit":
        if (e.status === "rejected") {
          l.parkedTurn = true;
          l.rateLimitedUntil = e.resetsAt;
          const until = e.resetsAt === null ? "—" : clockHm(e.resetsAt, config.operator.timezone);
          setState(l, "parked", `rate limited until ${until}`);
        }
        break;
      case "output":
        foldSoon(l);
        break;
      case "stderr":
        l.lastStderr = e.text;
        log(`${l.info.seat.id}: ${e.text}`);
        break;
      case "exit":
        onExit(l, e);
        break;
      default:
        break;
    }
  }

  /** Runs `fn` after everything queued for the seat; a failure does not block what follows. */
  function enqueue<T = void>(l: Live, fn: () => Promise<T> | T): Promise<T> {
    const p = l.chain.then(fn);
    l.chain = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  function writeLine(l: Live, text: string): void {
    try {
      l.session.send(text);
    } catch {
      throw noLive(l.info);
    }
    l.inTurn = true;
    l.parkedTurn = false;
    l.rateLimitedUntil = null;
  }

  async function sendInterrupt(l: Live): Promise<void> {
    l.interrupted = true;
    try {
      await l.session.control("interrupt");
    } catch (e) {
      if (errText(e) === "session ended") throw noLive(l.info);
      throw new SupervisorError(504, `${call(l.info)} did not answer the interrupt`, { cause: e });
    }
  }

  function inClone<T>(checkout: string, fn: () => Promise<T>): Promise<T> {
    const prev = cloneQueues.get(checkout) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => {});
    cloneQueues.set(checkout, tail);
    void tail.then(() => {
      if (cloneQueues.get(checkout) === tail) cloneQueues.delete(checkout);
    });
    return p;
  }

  /**
   * No git identity: a seat cannot commit, and the mc commit tool names each commit's author.
   * pnpm's store is the seat's own, in the sandbox's temp root, never inside the worktree.
   */
  function crewEnv(seatId: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of CREW_ENV_KEYS) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    env.HOME = homedir();
    const uid = process.getuid?.();
    if (uid !== undefined) env[PNPM_STORE_ENV] = crewPnpmStoreDir(uid, seatId);
    return { ...env, ...CREW_CLI_ENV };
  }

  /**
   * A run has ended (however it ended): its open questions close and its strays go. Never throws;
   * the end itself is already recorded.
   */
  function closeRunItems(info: SeatInfo): void {
    try {
      const seatId = info.seat.id;
      const mine = store
        .strays()
        .filter((x) => x.sessionId === info.session.id && x.agentId === seatId)
        .map((x) => x.path);
      store.clearStrays(info.session.id, mine);
      store.answerQuestions(seatId, now());
      bus.emit("attention");
    } catch (e) {
      log(`${info.seat.id}: could not close the run's questions and strays: ${errText(e)}`);
    }
  }

  const rolesDir = (): string => deps.rolesDir ?? join(deps.hubRoot, "roles");

  /**
   * Token and MCP files a hub that went down without seeing its processes exit left behind: their
   * tokens died with its memory. Run once the crew lock is held, before any spawn. The lock lives
   * in `crew.worktrees`, not beside the DB, so the files of every run the DB still holds active are
   * kept (their resume rewrites them); only the rest go. Every draft PR body file goes too. A
   * store that cannot say which runs are active removes nothing.
   */
  function sweepRunFiles(): void {
    try {
      const active = new Set(store.activeSeatSessions().map((r) => r.runId));
      const dir = crewDir(deps.dbPath);
      for (const name of readdirSync(dir)) {
        // a PR body file left by a hub that died during `gh pr create`: no draft_pr runs before
        // this start, since every older process's token died with that hub
        const stale =
          CREW_PR_BODY_FILE.test(name) ||
          (RUN_SECRET_FILE.test(name) && !active.has(name.replace(RUN_SECRET_FILE, "")));
        if (!stale) continue;
        rmSync(join(dir, name), { force: true });
      }
    } catch (e) {
      log(`could not clear old run files: ${errText(e)}`);
    }
  }

  const isActive = (row: SeatSessionRow | null) =>
    row !== null && row.runId !== null && ACTIVE_SEAT_STATES.includes(row.state);

  /**
   * The one way a seat's process is spawned, fresh or resumed: the prompt file (role brief + the
   * repo's CLAUDE.md at the run's base, `claudeMd`), a new token with its two 0600 files, the guard
   * hook and the sandbox for this worktree, the minimal env, and the run's transcript (appended
   * to). A resume keeps the run's own prompt file (R28). It does not know the run's base, so it
   * rebuilds a missing one from the role brief alone: never from the worktree, which is the
   * seat's to write. Registers the live seat and its events; throws when the hook command cannot
   * be built (before any token exists) or the spawn itself throws (after undoing the token and
   * files).
   */
  function launch(
    info: SeatInfo,
    run: Run,
    cliSessionId: string,
    checkout: { path: string; branch: string; gitDir: string },
    resume: boolean,
    claudeMd: string | null,
  ): Live {
    const def = seatDef(info.seat);
    const tokenPath = crewTokenPath(deps.dbPath, run.id);
    const mcpPath = crewMcpPath(deps.dbPath, run.id);
    const hub = `http://${LOOPBACK_HOST}:${deps.hubPort}`;
    // throws for a path it cannot quote: the start is refused before a token exists
    const hookCommand = guardHookCommand({
      node: crew?.node ?? DEFAULT_CREW_NODE,
      entry: join(deps.hubRoot, HOOK_ENTRY),
      tokenFile: tokenPath,
      url: `${hub}${GUARD_CHECK_PATH}`,
    });
    const promptPath = crewPromptPath(deps.dbPath, run.id);
    if (!resume || !existsSync(promptPath)) {
      if (resume) {
        log(
          `${info.seat.id}: prompt file missing on resume; rebuilt from the role brief, without the repo's CLAUDE.md`,
        );
      }
      // The role's prompt becomes the system prompt: only a file whose real path is in the roles folder.
      const promptFile = realpathSync(
        join(rolesDir(), def.prompt.slice(ROLE_PROMPT_DIR.length + 1)),
      );
      if (!isInside(promptFile, realpathSync(rolesDir()))) {
        throw new Error(`crew: ${def.prompt} is outside the roles folder`);
      }
      const roleBrief = readFileSync(promptFile, "utf8");
      writeFileSync(promptPath, rolePrompt(roleBrief, claudeMd), {
        mode: 0o600,
      });
    }
    const spawn = {};
    spawns.set(run.id, spawn);
    // A resume's earlier token (its process gone) is dropped before the new one is issued.
    deps.tokens.revoke(run.id);
    const token = deps.tokens.issue(info.seat.id, run.id);
    /**
     * Undoes this spawn's grant: unless a later spawn of the run has taken it over. Defensive, and
     * untested: the supervisor never runs two processes for one run, so a later spawn cannot exist
     * while this one lives (it would take overlapping processes no code path makes).
     */
    const release = () => {
      if (spawns.get(run.id) !== spawn) return;
      spawns.delete(run.id);
      deps.tokens.revoke(run.id);
      deps.lock.releaseRun(run.id);
      for (const p of [tokenPath, mcpPath]) {
        try {
          rmSync(p, { force: true });
        } catch (e) {
          log(`${info.seat.id}: could not remove ${p}: ${errText(e)}`);
        }
      }
    };
    let session: CrewSession;
    try {
      writePrivate(tokenPath, token);
      writePrivate(mcpPath, crewMcpConfig(`${hub}${MCP_PATH}`, token));
      const cwd = realpathSync(checkout.path);
      // a review seat reads nothing of its session-mates': the author's worktree is among them
      const mates =
        modeOfSeat(info.seat) === "scratch"
          ? [
              ...info.session.seats.flatMap((s) => {
                const w = s.id === info.seat.id ? null : store.seatSession(s.id)?.worktree;
                return w == null ? [] : [realish(w)];
              }),
              // a run set aside in review has no seat row to name its worktree
              ...store.asideRuns().flatMap((r) => {
                const w = r.loop?.aside?.worktree;
                const mate = info.session.seats.some((s) => s.id === r.agentId);
                return w == null || !mate || r.agentId === info.seat.id ? [] : [realish(w)];
              }),
            ]
          : [];
      const args = crewCliArgs({
        model: info.seat.model,
        effort: info.seat.effort,
        mode: def.mode,
        mcTools: def.mcTools,
        rolePromptFile: promptPath,
        sessionId: cliSessionId,
        resume,
        area: info.seat.area,
        sandbox: {
          cwd,
          gitCommonDir: realpathSync(join(info.session.checkout, ".git")),
          worktreeGitDir: realpathSync(checkout.gitDir),
          home: homedir(),
          dataDir: realpathSync(dirname(deps.dbPath)),
          denyRead: seatDenyRead(deps.config, deps.hubRoot, info.session.id, mates),
        },
        mcpConfigFile: mcpPath,
        hook: { command: hookCommand, timeoutS: GUARD_HOOK_TIMEOUT_S },
      });
      session = startSession({
        command: deps.command,
        args: [...(deps.commandArgs ?? []), ...args],
        cwd,
        transcriptPath: run.transcriptPath,
        env: crewEnv(info.seat.id),
        controlTimeoutMs: deps.controlTimeoutMs,
        stopGraceMs: deps.stopGraceMs,
      });
    } catch (e) {
      release();
      throw e;
    }
    // First, so it runs before the seat's own exit handling: never removed, unlike `l.off`, so a
    // discarded process still revokes its token when it exits.
    session.on((e) => {
      if (e.kind === "exit") release();
    });
    const l: Live = {
      info,
      session,
      run,
      chain: Promise.resolve(),
      inTurn: false,
      interrupted: false,
      parkedTurn: false,
      ending: null,
      endedBy: null,
      rateLimitedUntil: null,
      lastFoldAt: 0,
      foldTimer: undefined,
      resumedAt: resume ? Date.now() : null,
      off: () => {},
      lastStderr: null,
    };
    live.set(info.seat.id, l);
    l.off = session.on((e) => onEvent(l, e));
    return l;
  }

  /** Ends a run that cannot be resumed: the run failed, the seat in error with `reason`. */
  function failResume(row: SeatSessionRow, reason: string): void {
    const run = row.runId === null ? null : store.run(row.runId);
    const open = run !== null && run.endedAt === null;
    if (open) {
      const at = now();
      store.upsertRun({ ...run, endedAt: at, status: "failed" });
      store.setRunEnded(run.id, at, "failed", "exit");
    }
    setSeat(row.seatId, { state: "error", reason });
    const info = findSeat(row.seatId);
    if (info) closeRunItems(info);
    if (open) emit({ kind: "run-ended", seatId: row.seatId, runId: run.id, endedBy: "exit" });
    if (info && run?.reviewId != null) void dropScratch(info, run.id, run.seq, row.worktree);
  }

  /**
   * Removes a review run's scratch worktree once the run is over. Never throws: a failure is
   * logged and raised as the same blocked note the engine's end raises.
   */
  async function dropScratch(
    info: SeatInfo,
    runId: string,
    seq: number,
    worktree: string | null,
  ): Promise<void> {
    if (worktree === null) return;
    const seatId = info.seat.id;
    try {
      await inClone(info.session.checkout, () =>
        removeCheckout(info.session.checkout, worktree, { force: true }),
      );
    } catch (e) {
      log(`${seatId}: could not remove ${worktree}: ${errText(e)}`);
      try {
        store.raiseNote({
          key: `cleanup:${runId}`,
          kind: "blocked",
          runId,
          seatId,
          repoId: info.repo.id,
          text: `${call(info)}'s worktree for run #${seq} could not be removed; remove ${worktree} by hand.`,
          at: now(),
        });
        bus.emit("attention");
      } catch (err) {
        log(`${seatId}: could not record the cleanup note: ${errText(err)}`);
      }
    }
  }

  /**
   * Review worktrees no active run owns (left by a crash, or by a run that ended while the hub
   * was down) are removed. Never throws.
   */
  async function sweepScratch(): Promise<void> {
    if (!crew) return;
    let names: string[];
    try {
      names = readdirSync(crew.worktrees);
    } catch (e) {
      log(`could not list ${crew.worktrees}: ${errText(e)}`);
      return;
    }
    for (const session of crew.sessions) {
      for (const seat of [...session.seats]) {
        if (modeOfSeat(seat) !== "scratch") continue;
        const mine = `${seat.id}-review-`;
        for (const name of names) {
          if (!name.startsWith(mine) || !/^\d+$/.test(name.slice(mine.length))) continue;
          const path = join(crew.worktrees, name);
          try {
            await inClone(session.checkout, async () => {
              // read inside the queue: a review being started by now owns its path
              const row = store.seatSession(seat.id);
              const runEnd = row?.runId == null ? undefined : store.run(row.runId)?.endedAt;
              const active = row?.worktree === path && runEnd === null;
              if (active || starting.has(seat.id) || live.has(seat.id)) return;
              await removeCheckout(session.checkout, path, { force: true });
            });
          } catch (e) {
            log(`${seat.id}: could not remove ${path}: ${errText(e)}`);
          }
        }
      }
    }
  }

  /**
   * Resumes every active run once, after the lock is taken (spec §8b.2): its process is respawned
   * with `--resume` in its own worktree, and the seat waits idle for the operator's next message. A run
   * that cannot be resumed is failed with the reason. One row's failure never stops the others;
   * a store that cannot list the runs is logged (the caller catches it, so no rejection escapes).
   */
  async function reattach(): Promise<void> {
    for (const row of store.activeSeatSessions()) {
      if (stopping) return;
      // a seat with a process, or a start under way, has nothing to resume
      if (starting.has(row.seatId) || live.has(row.seatId)) continue;
      if (deps.cliHold?.reason != null) {
        // the run stays active; the release of the hold resumes it
        log(`${row.seatId}: resume held: ${deps.cliHold.reason}`);
        continue;
      }
      starting.add(row.seatId);
      try {
        await resumeOne(row);
      } catch (e) {
        log(`${row.seatId}: could not resume: ${errText(e)}`);
        try {
          failResume(row, RESUME_FAILED);
        } catch {
          // the store is failing too: already logged
        }
      } finally {
        starting.delete(row.seatId);
      }
    }
  }

  async function resumeOne(row: SeatSessionRow): Promise<void> {
    const info = findSeat(row.seatId);
    if (!info) return failResume(row, "could not resume: seat removed");
    const run = row.runId === null ? null : store.run(row.runId);
    if (
      run === null ||
      run.endedAt !== null ||
      row.cliSessionId === null ||
      (run.branch === null && run.reviewId == null)
    ) {
      return failResume(row, RESUME_FAILED); // an ended run is left as it ended
    }
    if ((modeOfSeat(info.seat) === "scratch") !== (run.reviewId != null)) {
      return failResume(row, RESUME_MODE_CHANGED); // a scratch seat resumes only review runs
    }
    let checkout: { path: string; branch: string; gitDir: string } | null = null;
    try {
      if (row.worktree === null) throw new Error("no worktree recorded");
      if (run.reviewId != null) {
        // still the clone's worktree, detached at the review's sha
        const sha = store.review(run.reviewId)?.sha ?? "";
        checkout = {
          branch: "",
          ...(await existingScratch(info.session.checkout, row.worktree, sha)),
        };
      } else if (run.branch !== null) {
        // still the clone's worktree, its git dirs not redirected, still on the run's branch
        checkout = await existingCheckout(info.session.checkout, row.worktree, run.branch);
      }
    } catch {
      // failed below, unless the run was ended meanwhile
    }
    // The checkout check awaited: the engine or the operator may have ended the run meanwhile. Whoever did
    // recorded the end and set the seat; a resume must not launch for it or overwrite the seat.
    if (runGone(run.id, row.seatId)) return;
    if (checkout === null) return failResume(row, "could not resume: checkout missing");
    if (stopping) return;
    let l: Live;
    try {
      // A spawn that fails asynchronously, or a CLI that cannot find the session, exits inside
      // the resume window: the exit handler records it.
      l = launch(info, run, row.cliSessionId, checkout, true, null);
    } catch (e) {
      log(`${row.seatId}: could not start: ${errText(e)}`);
      return failResume(row, RESUME_FAILED);
    }
    try {
      setSeat(row.seatId, { state: "idle", reason: RESUMED });
    } catch (e) {
      // Not recorded as resumed: discard the process rather than leave one nobody can see.
      l.off();
      if (live.get(row.seatId) === l) live.delete(row.seatId);
      void l.session.close();
      throw e;
    }
    emit({ kind: "idle", seatId: row.seatId, runId: run.id, resumed: true });
  }

  async function startRun(seatId: string, issue: number, opts?: { loop: RunLoop }) {
    const info = need(seatId);
    refuseWhileHeld();
    if (info.seat.retiring) throw new SupervisorError(409, retiringText(call(info)));
    const def = seatDef(info.seat);
    if (def.mode === "scratch") {
      throw new SupervisorError(409, scratchStartRefusedText(call(info)));
    }
    if (def.loop === "watch") {
      throw new SupervisorError(409, watchStartRefusedText(call(info)));
    }
    const busy = new SupervisorError(409, `${call(info)} already has a run`);
    if (stopping) throw new SupervisorError(409, SHUTTING_DOWN);
    if (starting.has(seatId) || live.has(seatId) || isActive(store.seatSession(seatId))) {
      throw busy;
    }
    // Rework goes first, and a ticket in review has its run already.
    const waiting = store.asideRuns();
    const rework = wakeDueAsideRun(store, seatId);
    if (rework) {
      throw new SupervisorError(409, reworkFirstText(call(info), rework.ticket ?? rework.id));
    }
    const ref = `${info.repo.id}#${issue}`;
    if (waiting.some((r) => r.ticket === ref)) {
      throw new SupervisorError(409, ticketInReviewText(ref));
    }
    starting.add(seatId);
    try {
      let ticket: TicketView | null;
      try {
        ticket = await deps.fetchTicket(info.repo, issue);
      } catch (e) {
        throw new SupervisorError(502, `could not read ${info.repo.github}#${issue} from GitHub`, {
          cause: e,
        });
      }
      if (ticket === null) throw new SupervisorError(404, "unknown issue");
      const title = ticket.title;
      // A planner has no branch: a detached checkout of the default branch, for reading only
      const planner = def.loop === "plan";
      // A CheckoutError goes out as it is: the route answers it with its own status (R26).
      // The repo's CLAUDE.md as origin's default branch has it, never as the worktree does.
      const { checkout, claudeMd } = await inClone(info.session.checkout, async () => {
        const where = {
          checkout: info.session.checkout,
          worktreesRoot: crew?.worktrees ?? "",
          seatId,
          issue,
        };
        const c = planner
          ? await preparePlanCheckout(where)
          : await prepareCheckout({ ...where, title });
        return { checkout: c, claudeMd: await readRepoClaudeMd(info.session.checkout, c.baseSha) };
      });
      if (stopping) throw new SupervisorError(409, SHUTTING_DOWN);
      // A writer claims the ticket for this hub (another hub on the board skips an assigned card);
      // a claim GitHub refuses stops the start, since an unclaimed run could meet another hub's.
      // A planner or reviewer has no branch to share, so it leaves the assignee alone.
      if (def.mode === "writer") {
        try {
          await deps.claim?.(info.repo, issue);
        } catch (e) {
          throw new SupervisorError(502, `could not claim ${info.repo.github}#${issue} on GitHub`, {
            cause: e,
          });
        }
      }
      if (stopping) throw new SupervisorError(409, SHUTTING_DOWN);

      const on = await startedOn();
      const startedAt = now();
      const last = store.runs(seatId, 1)[0];
      const seq = (last?.seq ?? 0) + 1;
      let runId = `${seatId}:${compactUtc(startedAt)}`;
      if (store.run(runId) !== null) runId = `${runId}-${seq}`;
      const cliSessionId = randomUUID();
      const run: Run = {
        id: runId,
        agentId: seatId,
        repoId: info.repo.id,
        seq,
        startedAt,
        endedAt: null,
        status: "running",
        sessionId: cliSessionId,
        model: info.seat.model,
        ...on,
        branch: planner ? null : checkout.branch,
        ticket: planner
          ? `${info.repo.id}#${issue}`
          : (inferTicket(checkout.branch, info.repo.id) ?? `${info.repo.id}#${issue}`),
        ticketTitle: title,
        costUsd: null,
        tokens: null,
        transcriptPath: crewTranscriptPath(deps.dbPath, runId),
        prs: [],
        summary: null,
        ...(opts ? { loop: opts.loop } : {}),
      };
      store.upsertRun(run);
      let l: Live;
      try {
        l = launch(info, run, cliSessionId, checkout, false, claudeMd);
      } catch (e) {
        log(`${seatId}: could not start: ${errText(e)}`);
        const at = now();
        store.upsertRun({ ...run, endedAt: at, status: "failed" });
        store.setRunEnded(runId, at, "failed", "exit");
        setSeat(seatId, {
          runId,
          cliSessionId,
          state: "error",
          reason: CANNOT_START,
          worktree: checkout.path,
        });
        emit({ kind: "run-ended", seatId, runId, endedBy: "exit" });
        throw new SupervisorError(500, CANNOT_START, { cause: e });
      }
      const session = l.session;
      setSeat(seatId, {
        runId,
        cliSessionId,
        state: "starting",
        reason: null,
        worktree: checkout.path,
      });
      // The CLI prints nothing (not even init) until its first line: the brief goes at once.
      const brief = ticketBrief({
        call: call(info),
        role: info.seat.role,
        mode: def.mode,
        loop: def.loop,
        here: def.here,
        repo: info.repo.github,
        issue,
        title,
        body: ticket.body,
        bodyTruncated: ticket.bodyTruncated,
        bodyLength: ticket.bodyLength ?? ticket.body.length,
        branch: checkout.branch,
        area: info.seat.area,
      });
      await enqueue(l, () => writeLine(l, brief)).catch(() => {});
      if (!session.alive) {
        // The spawn failed (no such command, a bad cwd): it reports asynchronously, so wait for
        // its exit, which marks the run failed and the seat in error, rather than claim a start.
        await session.close();
        throw new SupervisorError(500, CANNOT_START);
      }
      return { runId, branch: checkout.branch };
    } finally {
      starting.delete(seatId);
    }
  }

  async function startWatch(seatId: string, opts?: { first?: string }): Promise<{ runId: string }> {
    const info = need(seatId);
    refuseWhileHeld();
    if (seatDef(info.seat).loop !== "watch") {
      throw new SupervisorError(409, notWatchSeatText(call(info)));
    }
    if (info.seat.retiring) throw new SupervisorError(409, retiringText(call(info)));
    if (stopping) throw new SupervisorError(409, SHUTTING_DOWN);
    if (starting.has(seatId) || live.has(seatId) || isActive(store.seatSession(seatId))) {
      throw new SupervisorError(409, `${call(info)} already has a run`);
    }
    starting.add(seatId);
    try {
      // No ticket and no branch: a detached checkout of the default branch, for reading only.
      const { checkout, claudeMd } = await inClone(info.session.checkout, async () => {
        const c = await prepareDetachedCheckout({
          checkout: info.session.checkout,
          worktreesRoot: crew?.worktrees ?? "",
          name: watchCheckoutName(seatId),
        });
        return { checkout: c, claudeMd: await readRepoClaudeMd(info.session.checkout, c.baseSha) };
      });
      if (stopping) throw new SupervisorError(409, SHUTTING_DOWN);

      const on = await startedOn();
      const startedAt = now();
      const last = store.runs(seatId, 1)[0];
      const seq = (last?.seq ?? 0) + 1;
      let runId = `${seatId}:${compactUtc(startedAt)}`;
      if (store.run(runId) !== null) runId = `${runId}-${seq}`;
      const cliSessionId = randomUUID();
      const run: Run = {
        id: runId,
        agentId: seatId,
        repoId: info.repo.id,
        seq,
        startedAt,
        endedAt: null,
        status: "running",
        sessionId: cliSessionId,
        model: info.seat.model,
        ...on,
        branch: null,
        ticket: null,
        costUsd: null,
        tokens: null,
        transcriptPath: crewTranscriptPath(deps.dbPath, runId),
        prs: [],
        summary: null,
      };
      store.upsertRun(run);
      let l: Live;
      try {
        l = launch(
          info,
          run,
          cliSessionId,
          { path: checkout.path, branch: "", gitDir: checkout.gitDir },
          false,
          claudeMd,
        );
      } catch (e) {
        log(`${seatId}: could not start: ${errText(e)}`);
        const at = now();
        store.upsertRun({ ...run, endedAt: at, status: "failed" });
        store.setRunEnded(runId, at, "failed", "exit");
        setSeat(seatId, {
          runId,
          cliSessionId,
          state: "error",
          reason: CANNOT_START,
          worktree: checkout.path,
        });
        emit({ kind: "run-ended", seatId, runId, endedBy: "exit" });
        throw new SupervisorError(500, CANNOT_START, { cause: e });
      }
      const session = l.session;
      setSeat(seatId, {
        runId,
        cliSessionId,
        state: "starting",
        reason: null,
        worktree: checkout.path,
      });
      const first = opts?.first;
      const brief = watchBrief({ call: call(info), repo: info.repo.github });
      await enqueue(l, () =>
        writeLine(l, first !== undefined && first.trim() !== "" ? `${brief}\n\n${first}` : brief),
      ).catch(() => {});
      if (!session.alive) {
        await session.close();
        throw new SupervisorError(500, CANNOT_START);
      }
      return { runId };
    } finally {
      starting.delete(seatId);
    }
  }

  async function startReview(seatId: string, reviewId: number): Promise<{ runId: string }> {
    const info = need(seatId);
    refuseWhileHeld();
    if (info.seat.retiring) throw new SupervisorError(409, retiringText(call(info)));
    if (modeOfSeat(info.seat) !== "scratch") {
      throw new SupervisorError(409, notReviewSeatText(call(info)));
    }
    if (stopping) throw new SupervisorError(409, SHUTTING_DOWN);
    if (starting.has(seatId) || live.has(seatId) || isActive(store.seatSession(seatId))) {
      throw new SupervisorError(409, `${call(info)} already has a run`);
    }
    starting.add(seatId);
    try {
      const notWanted = new SupervisorError(409, REVIEW_NOT_WANTED);
      const review = store.review(reviewId);
      const author = review === null ? null : store.run(review.authorRunId);
      if (review?.state !== "starting" || author === null || author.endedAt !== null) {
        throw notWanted;
      }
      const issue = issueOf(author);
      if (
        author.repoId !== info.repo.id ||
        issue === null ||
        store.runPush(author.id)?.sha !== review.sha
      ) {
        throw notWanted;
      }
      let ticket: TicketView | null;
      try {
        ticket = await deps.fetchTicket(info.repo, issue);
      } catch (e) {
        throw new SupervisorError(502, `could not read ${info.repo.github}#${issue} from GitHub`, {
          cause: e,
        });
      }
      if (ticket === null) throw new SupervisorError(404, "unknown issue");

      const checkout = info.session.checkout;
      const prev =
        store
          .reviewsOfRun(author.id)
          .filter((r) => r.id < reviewId && r.epoch === review.epoch && r.state === "reported")
          .at(-1) ?? null;
      // A CheckoutError goes out as it is: the route answers it with its own status.
      const { scratch, inputs, claudeMd } = await inClone(checkout, async () => {
        const s = await prepareScratch({
          checkout,
          worktreesRoot: crew?.worktrees ?? "",
          seatId,
          reviewId,
          sha: review.sha,
        });
        try {
          return {
            scratch: s,
            inputs: await writeReviewInputs(checkout, s, review.sha, prev?.sha ?? null),
            claudeMd: await readRepoClaudeMd(checkout, s.baseSha),
          };
        } catch (e) {
          await removeCheckout(checkout, s.path, { force: true }).catch(() => {});
          throw e;
        }
      });
      if (stopping) {
        await inClone(checkout, () =>
          removeCheckout(checkout, scratch.path, { force: true }),
        ).catch(() => {});
        throw new SupervisorError(409, SHUTTING_DOWN);
      }

      const on = await startedOn();
      const startedAt = now();
      const seq = (store.runs(seatId, 1)[0]?.seq ?? 0) + 1;
      let runId = `${seatId}:${compactUtc(startedAt)}`;
      if (store.run(runId) !== null) runId = `${runId}-${seq}`;
      const cliSessionId = randomUUID();
      const run: Run = {
        id: runId,
        agentId: seatId,
        repoId: info.repo.id,
        seq,
        startedAt,
        endedAt: null,
        status: "running",
        sessionId: cliSessionId,
        model: info.seat.model,
        ...on,
        branch: null,
        ticket: author.ticket,
        ticketTitle: author.ticketTitle ?? ticket.title,
        costUsd: null,
        tokens: null,
        transcriptPath: crewTranscriptPath(deps.dbPath, runId),
        prs: [],
        summary: null,
        reviewId,
      };
      store.upsertRun(run);
      let l: Live;
      try {
        l = launch(
          info,
          run,
          cliSessionId,
          { path: scratch.path, branch: "", gitDir: scratch.gitDir },
          false,
          claudeMd,
        );
      } catch (e) {
        log(`${seatId}: could not start: ${errText(e)}`);
        const at = now();
        store.upsertRun({ ...run, endedAt: at, status: "failed" });
        store.setRunEnded(runId, at, "failed", "exit");
        setSeat(seatId, {
          runId,
          cliSessionId,
          state: "error",
          reason: CANNOT_START,
          worktree: scratch.path,
        });
        emit({ kind: "run-ended", seatId, runId, endedBy: "exit" });
        await dropScratch(info, runId, seq, scratch.path);
        throw new SupervisorError(500, CANNOT_START, { cause: e });
      }
      const session = l.session;
      setSeat(seatId, {
        runId,
        cliSessionId,
        state: "starting",
        reason: null,
        worktree: scratch.path,
      });
      const touches = author.loop?.touches;
      const brief = reviewBrief({
        call: call(info),
        repo: info.repo.github,
        issue,
        title: ticket.title,
        prNumber: review.prNumber,
        sha: review.sha,
        mergeBase: scratch.mergeBase,
        round: review.round,
        body: ticket.body,
        bodyTruncated: ticket.bodyTruncated,
        bodyLength: ticket.bodyLength ?? ticket.body.length,
        notes: store.evidenceNotes(author.id).map((e) => e.note),
        prevSha: prev?.sha ?? null,
        prevFindings: prev
          ? store.findingsOf(prev.id).filter((f) => BLOCKING_SEVERITIES.includes(f.severity))
          : [],
        diffCut: inputs.diffCut,
        since: inputs.since,
        touches: touches?.sha === review.sha ? touches.paths : [],
      });
      await enqueue(l, () => writeLine(l, brief)).catch(() => {});
      if (!session.alive) {
        await session.close();
        throw new SupervisorError(500, CANNOT_START);
      }
      return { runId };
    } finally {
      starting.delete(seatId);
    }
  }

  async function endRun(seatId: string): Promise<void> {
    const info = need(seatId);
    const l = live.get(seatId);
    if (l) {
      if (l.ending === null) {
        l.endedBy = "operator";
        l.ending = closeLive(l);
      }
      return l.ending;
    }
    // No process: a run left active by a hub that stopped (before it is resumed), or none.
    const row = store.seatSession(seatId);
    if (!isActive(row) || row?.runId == null) {
      throw new SupervisorError(409, `${call(info)} has no run`);
    }
    const run = store.run(row.runId);
    const open = run !== null && run.endedAt === null;
    if (open) {
      const at = now();
      // The transcript's last word, so a summary folded before summaries described the work
      // ("DONE.") is replaced; a transcript that cannot be read leaves the row as it is.
      const ended: Run = { ...run, endedAt: at, status: "ok" };
      let facts: ReturnType<typeof foldPath> = null;
      try {
        facts = foldPath(new Map(), run.transcriptPath);
        if (facts) applyFacts(ended, facts);
      } catch {
        facts = null;
      }
      store.upsertRun(ended, facts !== null);
      if (facts) persistDigest(store, digests, run.id, facts.digest);
      store.setRunEnded(run.id, at, "ok", "operator");
    }
    setSeat(seatId, { state: "stopped", reason: null, runId: null });
    closeRunItems(info);
    if (open) emit({ kind: "run-ended", seatId, runId: run.id, endedBy: "operator" });
    if (run?.reviewId != null) void dropScratch(info, run.id, run.seq, row.worktree);
  }

  /** Interrupts a turn in flight, then closes the process; the exit handler records the end. */
  function closeLive(l: Live): Promise<void> {
    return enqueue(l, async () => {
      if (l.inTurn) await sendInterrupt(l).catch(() => {});
      await l.session.close();
    });
  }

  async function endRunByEngine(runId: string): Promise<void> {
    if (!mayAct()) return;
    const run = store.run(runId);
    if (run === null || run.endedAt !== null) return;
    const seatId = run.agentId;
    const info = findSeat(seatId);
    const row = store.seatSession(seatId);
    if (info === undefined) return;
    if (row?.runId !== runId) {
      // a run set aside in review: no process, no seat; its worktree is all it holds
      const aside = run.loop?.aside;
      if (aside && live.get(seatId)?.run.id !== runId) {
        const at = now();
        store.upsertRun({ ...run, endedAt: at, status: "ok" });
        store.setRunEnded(runId, at, "ok", "engine");
        transcripts.delete(run.transcriptPath);
        digests.delete(run.id);
        emit({ kind: "run-ended", seatId, runId, endedBy: "engine" });
        await dropScratch(info, runId, run.seq, aside.worktree);
      }
      return;
    }
    const worktree = row.worktree;
    const l = live.get(seatId);
    if (l && l.run.id === runId && l.ending !== null) {
      // The operator's Stop is already ending it (the seat ends stopped, endedBy operator)
      await l.ending;
      return;
    }
    // Recorded first, so nothing after it can end the run twice.
    const at = now();
    store.upsertRun({ ...run, endedAt: at, status: "ok" });
    store.setRunEnded(runId, at, "ok", "engine");
    let closing: Promise<void> | null = null;
    if (l && l.run.id === runId) {
      l.endedBy = "engine";
      l.run = { ...l.run, endedAt: at, status: "ok" };
      closing = l.ending ??= closeLive(l);
    }
    setSeat(seatId, { state: "idle", reason: null, runId: null });
    closeRunItems(info);
    emit({ kind: "run-ended", seatId, runId, endedBy: "engine" });
    await closing;
    if (worktree === null) return;
    try {
      await inClone(info.session.checkout, () =>
        removeCheckout(info.session.checkout, worktree, { force: true }),
      );
    } catch (e) {
      log(`${seatId}: could not remove ${worktree}: ${errText(e)}`);
      try {
        store.raiseNote({
          key: `cleanup:${runId}`,
          kind: "blocked",
          runId,
          seatId,
          repoId: info.repo.id,
          text: `${call(info)}'s worktree for run #${run.seq} could not be removed; remove ${worktree} by hand.`,
          at: now(),
        });
        bus.emit("attention");
      } catch (err) {
        log(`${seatId}: could not record the cleanup note: ${errText(err)}`);
      }
    }
  }

  async function setAside(runId: string): Promise<{ worktree: string } | null> {
    if (!mayAct()) return null;
    const run = store.run(runId);
    if (run === null || run.endedAt !== null) return null;
    const seatId = run.agentId;
    const row = store.seatSession(seatId);
    const l = live.get(seatId);
    if (row?.runId !== runId || row.worktree === null || starting.has(seatId)) return null;
    if (l === undefined || l.run.id !== runId || !l.session.alive) return null;
    if (l.inTurn || l.ending !== null) return null;
    const worktree = row.worktree;
    fold(l, true);
    l.off();
    live.delete(seatId);
    // the process's exit takes its token and files (`release`); the run goes on
    setSeat(seatId, {
      runId: null,
      cliSessionId: null,
      state: "idle",
      reason: null,
      worktree: null,
    });
    try {
      await l.session.close();
    } catch (e) {
      log(`${seatId}: could not close the set-aside process: ${errText(e)}`);
    }
    return { worktree };
  }

  async function wakeRun(runId: string): Promise<void> {
    const run = store.run(runId);
    const aside = run?.endedAt === null ? run.loop?.aside : null;
    if (run === null || !aside) throw new SupervisorError(409, NOT_ASIDE);
    const seatId = run.agentId;
    const info = need(seatId);
    refuseWhileHeld();
    if (stopping) throw new SupervisorError(409, SHUTTING_DOWN);
    if (starting.has(seatId) || live.has(seatId) || isActive(store.seatSession(seatId))) {
      throw new SupervisorError(409, `${call(info)} already has a run`);
    }
    starting.add(seatId);
    try {
      /** The run cannot go back: it ends `failed`, the seat (another run's now) untouched. */
      const fail = (reason: string, cause?: unknown): never => {
        // its worktree is no one's now (a failed removal raises its own cleanup note)
        if (existsSync(aside.worktree)) void dropScratch(info, runId, run.seq, aside.worktree);
        const at = now();
        store.upsertRun({ ...run, endedAt: at, status: "failed" });
        store.setRunEnded(runId, at, "failed", "exit");
        emit({ kind: "run-ended", seatId, runId, endedBy: "exit" });
        throw new SupervisorError(500, reason, { cause });
      };
      if (run.branch === null || run.sessionId === null) return fail(RESUME_FAILED);
      // a seat changed to scratch mode, or off the build loop, cannot take a writer run back
      if (modeOfSeat(info.seat) === "scratch" || seatDef(info.seat).loop !== "build") {
        return fail(RESUME_MODE_CHANGED);
      }
      let checkout: { path: string; branch: string; gitDir: string };
      try {
        checkout = await existingCheckout(info.session.checkout, aside.worktree, run.branch);
      } catch (e) {
        return fail("could not resume: checkout missing", e);
      }
      if (stopping) throw new SupervisorError(409, SHUTTING_DOWN);
      // the check awaited: the engine may have ended the run meanwhile
      if (store.run(runId)?.endedAt !== null) throw new SupervisorError(409, NOT_ASIDE);
      // the seat's last turn was another run's
      store.setSeatTurnEnded(seatId, null);
      let l: Live;
      try {
        l = launch(info, run, run.sessionId, checkout, true, null);
      } catch (e) {
        log(`${seatId}: could not start: ${errText(e)}`);
        return fail(CANNOT_START, e);
      }
      // no "carry on" line goes ahead of the fix the engine is about to send
      l.resumedAt = null;
      try {
        setSeat(seatId, {
          runId,
          cliSessionId: run.sessionId,
          state: "idle",
          reason: null,
          worktree: checkout.path,
        });
      } catch (e) {
        // not recorded on the seat: discard the process rather than leave one nobody can see
        l.off();
        if (live.get(seatId) === l) live.delete(seatId);
        void l.session.close();
        return fail(CANNOT_START, e);
      }
    } finally {
      starting.delete(seatId);
    }
  }

  async function send(runId: string, key: string, text: string): Promise<SendResult> {
    if (!mayAct()) return "busy";
    const run = store.run(runId);
    if (run === null) return "gone";
    const seatId = run.agentId;
    if (runGone(runId, seatId)) return "gone";
    const l = live.get(seatId);
    if (!l?.session.alive || l.ending !== null || l.run.id !== runId) return "busy";
    return enqueue(l, (): SendResult => {
      // the run may have ended while this waited its turn in the chain
      if (runGone(runId, seatId)) return "gone";
      if (l.ending !== null) return "busy";
      if (l.inTurn) return "busy";
      const claimed = store.claimLine(key, { runId, seatId, origin: "engine", text, at: now() });
      if (!claimed) return "dup";
      try {
        writeLine(l, text);
      } catch {
        store.dropLine(key);
        return "busy";
      }
      return "sent";
    });
  }

  return {
    start() {
      if (!deps.enabled || !crew || started) return;
      started = true;
      // a crew.node that failed its check at load: crew stays off with the reason, the hub runs on
      if (crew.nodeNote !== undefined) {
        lockNote = crew.nodeNote;
        log(crew.nodeNote);
        return;
      }
      // Never throws: an unwritable crew dir (EACCES, EROFS, ENOSPC…) leaves crew off with a note,
      // not the hub crash-looping under launchd.
      const cannot = (e: unknown) => {
        lockNote = `crew lock could not be taken: ${(e as NodeJS.ErrnoException).code ?? errText(e)}`;
      };
      try {
        mkdirSync(crew.worktrees, { recursive: true });
      } catch (e) {
        cannot(e);
        return;
      }
      for (let attempt = 0; attempt < 2 && !holdsLock; attempt++) {
        try {
          writeFileSync(lockPath(), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
          holdsLock = true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
            cannot(e);
            return;
          }
          let pid = Number.NaN;
          try {
            pid = Number.parseInt(readFileSync(lockPath(), "utf8"), 10);
          } catch {
            continue; // removed meanwhile: try again
          }
          // this process's own pid is a lock left by an earlier process the pid was reused from
          // (one process runs one supervisor, and start() runs once)
          if (pid !== process.pid && pidAlive(pid)) {
            lockNote = `crew lock held by pid ${pid}`;
            return;
          }
          try {
            unlinkSync(lockPath()); // left by a process that has gone
          } catch {
            // removed meanwhile
          }
        }
      }
      if (!holdsLock) {
        lockNote = "crew lock could not be taken";
        return;
      }
      sweepRunFiles();
      void sweepScratch();
      // runs whose resume was held back go once the CLI passes its smoke test again
      unholdResume = deps.cliHold?.onRelease(() => {
        if (!stopping) {
          reattach().catch((e: unknown) => log(`could not resume crew runs: ${errText(e)}`));
        }
      });
      reattach().catch((e: unknown) => log(`could not resume crew runs: ${errText(e)}`));
    },

    async stopAll() {
      if (!holdsLock) return;
      stopping = true;
      unholdResume?.();
      // stdin's end lets an idle CLI exit at once; one mid-turn may finish the turn first. The
      // wait is bounded so the rest of shutdown runs; a process still going then gets EOF'd stdin
      // and ends with the hub's process group (launchd), and its run is resumed on the next start.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([...live.values()].map((l) => l.session.close())),
        new Promise<void>((r) => {
          timer = setTimeout(r, CREW_STOP_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      try {
        if (readFileSync(lockPath(), "utf8").trim() === String(process.pid)) unlinkSync(lockPath());
      } catch {
        // already gone
      }
      holdsLock = false;
    },

    startRun,

    startWatch,

    startReview,

    async message(seatId, text, opts) {
      const l = liveOrRefuse(need(seatId));
      return enqueue(l, async () => {
        if (opts.interrupt && l.inTurn) await sendInterrupt(l).catch(rethrowIfDead);
        writeLine(l, text);
        // The operator replies to a seat's ask_operator by messaging it: its open questions are answered
        try {
          if (opts.questions !== "none") {
            store.answerQuestions(seatId, now(), opts.questions === "unpassed");
            bus.emit("attention");
          }
        } catch (e) {
          log(`${seatId}: could not mark its questions answered: ${errText(e)}`);
        }
      });
    },

    async interrupt(seatId) {
      const l = liveOrRefuse(need(seatId));
      return enqueue(l, async () => {
        if (l.inTurn) await sendInterrupt(l);
      });
    },

    endRun,

    endRunByEngine,

    setAside,

    wakeRun,

    send,

    on(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    emitEvidence(seatId, runId) {
      emit({ kind: "evidence", seatId, runId });
    },

    emitFindings(seatId, runId) {
      emit({ kind: "findings", seatId, runId });
    },

    seatFacts(seatId) {
      const l = live.get(seatId);
      if (!l?.session.alive) return null;
      return { inTurn: l.inTurn, resumedAt: l.resumedAt, rateLimitedUntil: l.rateLimitedUntil };
    },

    async contextUsage(seatId) {
      need(seatId);
      const l = live.get(seatId);
      if (!l?.session.alive) return null;
      try {
        return toContextUsage(await l.session.control("get_context_usage"));
      } catch {
        return null;
      }
    },

    seat(seatId) {
      need(seatId);
      return store.seatSession(seatId);
    },

    seatBusy(seatId) {
      if (starting.has(seatId) || live.has(seatId)) return true;
      try {
        return isActive(store.seatSession(seatId));
      } catch {
        return true;
      }
    },

    busy() {
      const out: SeatBusy[] = [...starting].map((seatId) => ({ seatId, state: "starting" }));
      for (const [seatId, l] of live) {
        if (l.inTurn && !starting.has(seatId)) out.push({ seatId, state: "running" });
      }
      return out;
    },

    status() {
      return { enabled: holdsLock, note: lockNote };
    },

    inClone,
  };
}

/** Interrupt-and-send: an interrupt that times out still lets the line through. */
function rethrowIfDead(e: unknown): void {
  if (e instanceof SupervisorError && e.status === 409) throw e;
}
