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
 * Each seat's `claude` runs under a keeper (`keeper.ts`), a detached process that outlives the hub.
 * On hub shutdown (`stopAll`) the hub only lets go of the keepers' sockets: seats keep working, their
 * runs stay active, and the next start attaches to each keeper and replays the lines it missed
 * (`reattach`). A run whose keeper is gone (a reboot) is resumed with `--resume`; one whose CLI
 * exited meanwhile is recorded as ended; one whose keeper speaks another version is ended, then
 * resumed, so two CLIs never run one session.
 *
 * Each process gets the mc tools (`--mcp-config`) and the guard hook, both keyed to a per-run token
 * issued at its spawn (a resume gets a new one; a hub restart first restores each active run's token and test-lock holds (`restoreRuns`), which an attached run keeps and `start()` drops for every run it does not reattach). The token lives in hub memory and in two 0600
 * files in `{DB dir}/crew/`, which only the hub and the hook (outside the sandbox) read; argv, env
 * and settings carry the files' paths only. When the process exits, for any reason, the token is
 * revoked, the run's test-lock hold freed and both files removed.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  AWAY_QUOTA_REFUSED,
  BLOCKING_SEVERITIES,
  CANNOT_START,
  CODEX_COMMAND,
  CODEX_SEAT_TOKEN_ENV,
  CODEX_SHELL,
  type ContextUsage,
  CREW_CLI_ENV,
  CREW_DISABLED,
  CREW_GIT_ENV,
  CREW_PNPM_ENV,
  carriedFrom,
  clockHm,
  compactUtc,
  conflictKey,
  conflictText,
  crewCliArgs,
  crewMcpConfig,
  crewProfileOf,
  DEFAULT_CREW_NODE,
  DEFAULT_PROFILES,
  doneWhenItems,
  eligibleToStart,
  errorText as errText,
  GUARD_CHECK_PATH,
  GUARD_HOOK_TIMEOUT_S,
  grantRefusedText,
  grantUngrantableText,
  guardHookCommand,
  HUD_STATE_LABEL,
  hasPlanSection,
  inferTicket,
  isProtectedPath,
  isResumeLineKey,
  LOOPBACK_HOST,
  MC_TMP_DIR_NAME,
  MCP_PATH,
  type McToolName,
  mainConflictText,
  mergedMainText,
  modeOfSeat,
  NOT_ASIDE,
  notOnBoardText,
  notReviewSeatText,
  notWatchSeatText,
  PLAN_SIZES,
  PNPM_STORE_ENV,
  type Profile,
  type ProfileOverride,
  pathGrantProblem,
  pathInArea,
  REVIEW_FULL_MODEL,
  REVIEW_NOT_WANTED,
  type RepoId,
  type RepoRules,
  ROLE_PROMPT_DIR,
  type Run,
  type RunLoop,
  type RunPlan,
  retiringText,
  reviewDepth,
  reworkFirstText,
  type SeatSessionRow,
  type SeatState,
  START_NO_RULES,
  STDERR_TEXT_MAX,
  STOP_GRACE_MS,
  sandboxReadDenies,
  scratchName,
  scratchStartRefusedText,
  seatBusyText,
  seatCallSign,
  seatDef,
  type TicketView,
  TOOL_OUTPUT_DIR,
  TRIM_HOOK_TIMEOUT_S,
  ticketControllerCheck,
  ticketInReviewText,
  ticketPathGrants,
  trimHookCommand,
  watchCheckoutName,
  watchStartRefusedText,
} from "@mc/core";
import { accountBindingProblem, codexProfile } from "../account-bindings.ts";
import { activeAway } from "../away.ts";
import type { ChangeBus } from "../bus.ts";
import { cleanText } from "../clean.ts";
import type { CliHold } from "../cli-update.ts";
import { probeClaudeVersion } from "../cli-version.ts";
import { applyFacts, type FoldState, foldPath, persistDigest } from "../collectors/common.ts";
import {
  applySeatAccount,
  type CcConfig,
  type CrewSeatConfig,
  type CrewSessionConfig,
  crewOwnFolders,
  gitCommonDir,
  isInside,
  realish,
  seatUnavailable,
} from "../config.ts";
import { pausedSeat } from "../crew-pause.ts";
import { waitReader } from "../dependencies.ts";
import { wakeDueAsideRun } from "../engine/aside.ts";
import { accountAtStop, awayQuotaReserve, awayQuotaUnknown } from "../engine/queue.ts";
import { RepoRulesError } from "../engine/rules.ts";
import type { CheckRecorder } from "../guard/check-runs.ts";
import { HOOK_ENTRY } from "../guard/hook.ts";
import type { TestLock } from "../guard/lock.ts";
import { TRIM_ENTRY } from "../guard/trim.ts";
import { assertScratchStorage } from "../mcp/restore.ts";
import type { RunTokens } from "../mcp/tokens.ts";
import { issueOf } from "../mcp/tools.ts";
import { approvedPaths, runPathGrants, setRunPathGrants } from "../path-grants.ts";
import { chooseRunProfile, type ProfilesError, profileHash } from "../profiles.ts";
import {
  mergeSections,
  type PromptPiece,
  promptSections,
  textBytes,
  ticketPiece,
} from "../prompt-cost.ts";
import { SHUTDOWN_TIMEOUT_MS } from "../shutdown.ts";
import {
  ACTIVE_SEAT_STATES,
  CREW_CODEX_DIR,
  CREW_KEEPER_DIR,
  CREW_PR_BODY_FILE,
  CREW_SKILLS_DIR,
  crewCodexDir,
  crewDir,
  crewKeeperDir,
  crewMcpPath,
  crewPromptPath,
  crewSkillsDir,
  crewTokenPath,
  crewTranscriptPath,
  type KeeperCursor,
  type Store,
} from "../store.ts";
import {
  AGENTS_MD_HEADING,
  CLAUDE_MD_HEADING,
  cutNoteText,
  type RepoDocs,
  repoReferenceIndex,
  reviewBrief,
  rolePrompt,
  ticketBrief,
  transferBrief,
  watchBrief,
} from "./brief.ts";
import {
  existingCheckout,
  existingDetached,
  existingReadOnlyCheckout,
  existingScratch,
  installAfterSync,
  prepareCheckout,
  prepareDetachedCheckout,
  preparePlanCheckout,
  prepareReadOnlyCheckout,
  prepareScratch,
  prepareSharedPnpmStore,
  type RepoPeer,
  removeCheckout,
  sharedPnpmStoreDir,
  sweepPnpmStores,
  syncReusedWorktree,
  writeReviewInputs,
} from "./checkouts.ts";
import { createCodexApprover } from "./codex-approval.ts";
import { codexSeatConfig } from "./codex-floor.ts";
import { attachCodexSession, CODEX_OUTBOX_FILE, startCodexSession } from "./codex-session.ts";
import { probeCodexVersion } from "./codex-version.ts";
import { assertSeatGitConfig, assertSeatGitVersion, SeatGitError } from "./git.ts";
import { runSeatGrants } from "./grants.ts";
import {
  CODEX_DELIVERY,
  endKeeper,
  KEEPER_ENTRY,
  type KeeperHello,
  keeperAlive,
  pidAlive,
  processInfo,
} from "./keeper.ts";
import { recordNoReport } from "./no-report.ts";
import {
  attachSession,
  type CrewSession,
  endsAtResult,
  type KeeperSession,
  SessionControlError,
  type SessionEvent,
  startSession,
} from "./session.ts";
import { copySkillsToCodexHome, readRepoDocsAndSkills, writeSkillPlugin } from "./skills.ts";
import { seatToolchainDirs } from "./toolchain.ts";

/** Short spelling for Claude's 44-byte temp-path budget, including its claude-<uid> suffix. */
export function crewTempRoot(dbPath: string, runId: string, uid: number): string {
  const key = createHash("sha256").update(`${dbPath}:${runId}`).digest("hex").slice(0, 12);
  return `/tmp/m${uid.toString(36)}/${key}`;
}

/** In `crew.worktrees`; holds the pid of the one process that runs crew. */
export const CREW_LOCK_FILE = ".mc-crew.lock";
/** A running seat's transcript is folded at most this often while it writes. */
export const CREW_FOLD_EVERY_MS = 1000;
const NO_BRANCH_YET = "(none yet: a detached copy of origin's default branch)";
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
const STDERR_RECENT_MS = 10_000;
const LOCK_REUSE_MARGIN_MS = 60_000;
const LAST_TURN_ERROR = "last turn ended in an error";
const SHUTTING_DOWN = "the server is shutting down";
const RESUMED = "resumed after a restart; send a message to continue";
const RESUME_FAILED = "could not resume the session";
/** How long `stopAll` waits for a Stop's `close` line to reach its keeper's socket. */
const CLOSE_SENT_WAIT_MS = 1000;
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
 * other crew session's checkout and worktree folder (`<crew.worktrees>/<id>`), then `crew.deny_read`. The hub's checkout and each loop's
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
    const denyRepo =
      mainTree && basename(common) === ".git" && ownFolderIn(own, repo) === undefined;
    return denyRepo ? [dir, common, repo] : [dir, common];
  };
  const paths = [
    ...withGitDir(hubRoot, false),
    ...config.loops.flatMap((l) => [
      ...withGitDir(l.worktree, true),
      l.stateDir,
      ...(l.logsDir ? [l.logsDir] : []),
    ]),
    ...(config.crew?.sessions ?? [])
      .filter((x) => x.id !== sessionId)
      .flatMap((x) => [x.checkout, ...(config.crew ? [join(config.crew.worktrees, x.id)] : [])]),
    ...(config.crew?.denyRead ?? []),
    ...extra,
  ];
  return [...new Set(paths.map(realish))];
}

/** The first of the crew's own folders that `repo` is or holds, if any. */
function ownFolderIn(own: readonly string[], repo: string): string | undefined {
  return own.find((f) => isInside(f, repo));
}

/**
 * The loops whose repo's main working tree `seatDenyRead` leaves readable because it holds one of
 * the crew's own folders, with that folder.
 */
export function keptLoopRepos(
  config: CcConfig,
): { loopId: string; repo: string; folder: string }[] {
  if (!config.crew) return [];
  const own = crewOwnFolders(config.crew);
  return config.loops.flatMap((l) => {
    const common = gitCommonDir(l.worktree);
    if (common === null || basename(common) !== ".git") return [];
    const repo = realish(dirname(common));
    const folder = ownFolderIn(own, repo);
    return folder === undefined ? [] : [{ loopId: l.id, repo, folder }];
  });
}

/** The folders whose git repository a crew clone must not share: the hub's checkout and each loop's worktree. */
export function clonePeers(config: CcConfig, hubRoot: string): RepoPeer[] {
  return [
    { label: "the hub's checkout", dir: hubRoot },
    ...config.loops.map((l) => ({ label: `loop ${l.id} worktree`, dir: l.worktree })),
  ];
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

/** Keep Codex's worktree-local temp files out of its own `git status`, once per checkout. */
function addMcTmpExclude(gitCommonDir: string): void {
  const path = join(gitCommonDir, "info", "exclude");
  const line = `${MC_TMP_DIR_NAME}/`;
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.split("\n").includes(line)) return;
  appendFileSync(path, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}${line}\n`, {
    mode: 0o600,
  });
}

/** What a crew action that failed unexpectedly says to a caller: no path, no git text. */
export const CREW_ACTION_FAILED = "crew action failed";

/** A refused action, with the HTTP status a route answers it with. */
export class SupervisorError extends Error {
  readonly status: number;
  readonly deadSession: boolean;
  constructor(
    status: number,
    message: string,
    options?: { cause?: unknown; deadSession?: boolean },
  ) {
    super(message, options);
    this.name = "SupervisorError";
    this.status = status;
    this.deadSession = options?.deadSession === true;
  }
}

export interface SupervisorDeps {
  config: CcConfig;
  store: Store;
  bus: ChangeBus;
  /** The DB path: transcripts and prompt files live in `{its dir}/crew/`. */
  dbPath: string;
  /** A repo's board rules (read at origin/HEAD); an error refuses every start in the repo. */
  rules: (repoId: RepoId) => Promise<RepoRules | RepoRulesError>;
  /** The hub's own `gh` login; null when it could not be read, so any assigned card is another's. */
  login: () => string | null;
  /** The template profiles, read from user config on each call; default `DEFAULT_PROFILES`. */
  profiles?: () => readonly Profile[] | ProfilesError;
  now?: () => number;
  /** Process identity lookup for lock reuse; defaults to processInfo. */
  processStart?: (pid: number) => { startedAt: number; command: string } | null;
  /** Default `"claude"`; tests pass `process.execPath` and the fake CLI in `commandArgs`. */
  command?: string;
  /** Put before the CLI's own arguments. */
  commandArgs?: string[];
  /** Default "codex"; its version and app-server are run through the same binary. */
  codexCommand?: string;
  /** Defaults to ~/.codex/auth.json; tests supply an isolated fake login. */
  codexAuthPath?: string;
  superuserTools?: readonly McToolName[];
  fetchTicket: (repo: CcConfig["repos"][number], n: number) => Promise<TicketView | null>;
  /** Assigns the hub's own login to the issue, when a run starts on it (any repo, `merge` or `draft`). */
  claim?: (repo: CcConfig["repos"][number], n: number) => Promise<void>;
  /** false: `MC_NO_CREW=1`, or no `crew` config. */
  enabled: boolean;
  /** Per-run tokens for `/mcp` and the guard: issued at each spawn, revoked at its exit. */
  tokens: RunTokens;
  /** The test lock: a run's hold goes when its call's tool_result comes, its turn ends or it exits. */
  lock: TestLock;
  /** Records the configured checks a seat's shell calls run; absent: none. */
  checks?: CheckRecorder;
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
   * alone if their binding and sandbox policy are safe; held resumes are tried on release.
   */
  cliHold?: CliHold;
  /** The `claude` CLI's version, recorded on each run that starts. Default: `claude --version`, cached. */
  cliVersion?: () => Promise<string | null>;
  /** Default RESUME_WINDOW_MS. */
  resumeWindowMs?: number;
  /** Tests shorten the session's timeouts. */
  controlTimeoutMs?: number;
  stopGraceMs?: number;
  /** Bounded Comms context appended to each user line that starts a seat turn. */
  inbox?: (seatId: string, runId: string) => InboxContext;
}

export interface InboxContext {
  text: string;
  messageIds: readonly string[];
}

/** Who ended a run. */
export type EndedBy = NonNullable<Run["endedBy"]>;

/**
 * What the supervisor tells its listeners. `idle`: a seat with an active run left a turn, or was
 * resumed. `run-ended`: after the store has the end, from every end path. `evidence`: the seat
 * reported through `mc report_evidence`. `seat-free`: after exit cleanup releases the process.
 */
export type SupervisorEvent =
  | { kind: "idle"; seatId: string; runId: string; resumed: boolean }
  | { kind: "seat-free"; seatId: string; runId: string }
  | { kind: "run-ended"; seatId: string; runId: string; endedBy: EndedBy }
  | { kind: "evidence"; seatId: string; runId: string }
  | { kind: "findings"; seatId: string; runId: string };

/** What `send` did with a keyed line. */
export type SendResult = "sent" | "busy" | "no-session" | "dup" | "gone";

/** What the snapshot reads of a seat's process. */
export interface SeatFacts {
  inTurn: boolean;
  /** `Date.now()` at the resume that spawned the process; null for a fresh start. */
  resumedAt: number | null;
  /** When the rate limit that parked the seat lifts (ms); null once a line has been written. */
  rateLimitedUntil: number | null;
}

export type AccountTransferResult =
  | { outcome: "resumed" | "fresh" }
  | { outcome: "refused"; reason: string };

interface AccountTransfer {
  source: string;
  target: string;
  pending: boolean;
  continuationId?: string;
  supersededContinuationIds?: string[];
  handoffId?: string;
  handoffSessionId?: string;
  queued?: [string, string][];
}

export interface Supervisor {
  /** Excludes process launches and recovery until account config is committed. */
  withAccountUpdate<T>(fn: () => Promise<T>): Promise<T>;
  transferAccount(seatId: string, accountId: string): Promise<AccountTransferResult>;
  /** Calls `fn` for each event from now on; returns the unsubscribe. A throwing `fn` is logged. */
  on(fn: (e: SupervisorEvent) => void): () => void;
  /** Tells listeners a seat's run got evidence (`mc report_evidence` calls this after recording). */
  emitEvidence(seatId: string, runId: string): void;
  /** Tells listeners a review run reported its findings (`mc report_findings` calls this). */
  emitFindings(seatId: string, runId: string): void;
  /**
   * Writes the hub's keyed line to the seat, only between turns. `gone`: the run ended or is not
   * its seat's current run; `no-session`: the CLI is gone; `busy`: a start, resume, turn or end is
   * on, or this server does not run crew (disabled, or without the crew lock). Neither claims
   * the key. `dup`: the key was used.
   * Allowed while the seat is rate-limited. Never answers questions.
   */
  send(
    runId: string,
    key: string,
    text: string,
    cost?: { wake: number; pieces: readonly PromptPiece[] },
  ): Promise<SendResult>;
  /**
   * Takes back a held run with no live CLI as at restart; a failed resume ends it once. Does
   * nothing while crew is off, stopping, during startup reattach, or while a start, attach or
   * end is in progress. A CLI hold defers launches, but still checks preserved process safety.
   */
  resumeRun(runId: string): Promise<void>;
  /** Retry pause-deferred recoveries before supervising their reviews. */
  resumeDeferredRuns?(): Promise<void>;
  /** null when the seat has no live process. */
  seatFacts(seatId: string): SeatFacts | null;
  /**
   * Whether the seat's CLI session is attached and alive, for the run its row holds: the process
   * the hub holds, not the run row. Null while the hub cannot tell: crew is off or stopping, the startup take-back is running,
   * or a start, resume or account move for the seat is under way. Never throws.
   */
  sessionAlive?(seatId: string): boolean | null;
  /**
   * Ends the run `ok`, `endedBy: "engine"` (`"superseded"` when the hub drops a review, so the missing report is no error), only when it is its seat's current run, closes its
   * process (with none attached, ends any keeper it left and revokes its token), removes its worktree (a failure leaves a `cleanup:<run>` blocked note) and leaves the
   * seat idle. An ended or unknown run is left alone, with no event. A run Stop is already ending
   * stays Stop's (endedBy operator, seat stopped, worktree kept). Does nothing on a server that
   * does not run crew (disabled, or without the crew lock).
   */
  endRunByEngine(runId: string, reason?: "superseded"): Promise<void>;
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
   * The operator ends a run that is set aside, without waking a CLI: the run ends ok (endedBy
   * operator), its worktree is removed and the seat is left as it is. A 409 when the run is not
   * set aside.
   */
  endAsideRun(runId: string): Promise<void>;
  /**
   * Takes the crew lock, then resumes every active run once, in the background. Does nothing when
   * disabled; never throws (a failure leaves crew off with a note, or one seat in error).
   */
  start(): void;
  /** Ends every process (runs stay active for the reattach) and releases the lock. */
  stopAll(): Promise<void>;
  /**
   * `opts.loop`: the run row is created with this loop state. `opts.override`: the template
   * profile to use instead of the routed one; it is stored for the ticket before the run starts.
   * `opts.flight`: FLIGHT explicitly cleared this start while away; its PR still goes through the away gate.
   * `opts.operator`: a manual HUD start, exempt from away-only start restrictions.
   */
  startRun(
    seatId: string,
    issue: number,
    opts?: { loop?: RunLoop; override?: ProfileOverride; flight?: boolean; operator?: boolean },
  ): Promise<{ runId: string; branch: string }>;
  /**
   * Starts the watch seat (FLIGHT): no ticket and no branch, a detached worktree of the default
   * branch, and the watch brief as its one first line, then `opts.first` after a blank line.
   */
  startWatch(
    seatId: string,
    opts?: { first?: string; firstPieces?: readonly PromptPiece[] },
  ): Promise<{ runId: string }>;
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
    opts: { interrupt: boolean; questions?: "all" | "unpassed" | "none"; enforcePause?: boolean },
  ): Promise<void>;
  interrupt(seatId: string): Promise<void>;
  /** Ends the run and leaves the seat idle for its next ticket; `hold` benches it (stopped) instead. */
  endRun(seatId: string, opts?: { hold?: boolean }): Promise<void>;
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
  holdsCrewLock?(): boolean;
  /** Ends a removed seat's detached aside and publishes its lifecycle event synchronously. */
  endRemovedAside?(runId: string): boolean;
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
  /** An interrupt was accepted during this turn: its error result is the interrupt, not a failure. */
  interrupted: boolean;
  /** A `rejected` rate limit came this turn: the seat stays parked until the next line. */
  parkedTurn: boolean;
  /** The operator or the engine ended the run: the exit is `ok`, not a crash. */
  ending: Promise<void> | null;
  /** Who is ending the run, while `ending` is set. */
  endedBy: Exclude<EndedBy, "exit"> | null;
  /** The operator also took the seat out of rotation: it ends stopped, not idle. */
  hold: boolean;
  /** When the rate limit that parked this turn lifts (ms); null until one comes, and after a line. */
  rateLimitedUntil: number | null;
  lastFoldAt: number;
  foldTimer: NodeJS.Timeout | undefined;
  /** `Date.now()` at a resume's spawn; null for a fresh start, and for a woken run (no carry-on line). */
  resumedAt: number | null;
  /** `Date.now()` at a resume's spawn, however it was resumed; null for a fresh start. */
  spawnedAt: number | null;
  /** Stops this seat's events reaching the supervisor (a process being discarded). */
  off: () => void;
  /** The process's last stderr line (cleaned), for the reason when it crashes. */
  lastStderr: string | null;
  /** now() when lastStderr came; the reason uses it only within STDERR_RECENT_MS of the exit. */
  lastStderrAt: number | null;
  /** The keeper's id: the stored cursor counts the lines of this one keeper only. */
  spawn: string;
  /** Attached to a keeper that is still replaying the lines the hub missed: no line goes out yet. */
  attaching: boolean;
  /** At an attach: the keeper's line count, below which the lines are a replay of what the last hub missed. */
  replayedBelow: number;
  /** At an attach: the keeper said a turn was open. A replayed `result` is then an earlier turn's. */
  awaitingAtAttach: boolean;
}

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

/** After a failed context ask, how long before a read asks again (ms). */
const CONTEXT_RETRY_MS = 30 * 1000;

/**
 * A seat's last context usage. The CLI is asked once per turn, after it ends, never per request:
 * every answer is a 30 KB line in the CLI's output (#934).
 */
interface ContextCache {
  usage: ContextUsage | null;
  /** A turn has ended since `usage` was asked for (or it never was): the next read asks once. */
  stale: boolean;
  inflight: Promise<void> | null;
  /** After a failed ask: the earliest time (ms) the next read may ask again, inside the same turn. */
  retryAt: number;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const { config, store, bus } = deps;
  const contextCaches = new WeakMap<Live, ContextCache>();
  /** Asks the seat's CLI for its context usage and caches the answer; at most one ask at a time. */
  const refreshContext = (l: Live): Promise<void> => {
    let cache = contextCaches.get(l);
    if (!cache) {
      cache = { usage: null, stale: true, inflight: null, retryAt: 0 };
      contextCaches.set(l, cache);
    }
    if (cache.inflight) return cache.inflight;
    const c = cache;
    c.stale = false;
    c.inflight = (async () => {
      try {
        const usage = toContextUsage(await l.session.control("get_context_usage"));
        if (usage === null) throw new Error("not the usage shape");
        c.usage = usage;
      } catch {
        // keep the last answer (old, not wrong), and ask again soon rather than next turn
        c.stale = true;
        c.retryAt = now() + CONTEXT_RETRY_MS;
      } finally {
        c.inflight = null;
      }
    })();
    return c.inflight;
  };
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => process.stderr.write(`crew: ${msg}\n`));
  /** A message waiting at a resume leads: the hub's "carry on" must not be the seat's first word. */
  const withInbox = (
    seatId: string,
    runId: string,
    text: string,
    inboxFirst = false,
  ): InboxContext => {
    const inbox = deps.inbox?.(seatId, runId) ?? { text: "", messageIds: [] };
    const joined = inboxFirst ? `${inbox.text}\n\n${text}` : `${text}\n\n${inbox.text}`;
    return {
      text: inbox.text === "" ? text : text === "" ? inbox.text : joined,
      messageIds: inbox.messageIds,
    };
  };
  const markInboxRead = (seatId: string, inbox: InboxContext) =>
    store.markCommsInboxRead(seatId, inbox.messageIds);
  const crew = config.crew;

  function seatForAccount(seat: CrewSeatConfig, accountId: string): CrewSeatConfig {
    const account = config.accounts.find((a) => a.id === accountId);
    const bound = { ...seat };
    // Direct supervisor fixtures may omit the loader's resolved model metadata.
    if (account === undefined || bound.modelVendor === undefined) bound.accountId = accountId;
    else applySeatAccount(bound, account);
    return bound;
  }

  /** Read per call: the crew reloader changes the config's seats while the hub runs. */
  function findSeat(seatId: string): SeatInfo | undefined {
    for (const session of crew?.sessions ?? []) {
      const seat = session.seats.find((s) => s.id === seatId);
      if (seat === undefined) continue;
      const repo = config.repos.find((r) => r.id === session.repoId);
      const runId = store.seatSession(seatId)?.runId;
      const binding =
        runId == null || store.run(runId)?.endedAt !== null ? null : transferState(runId);
      const bound = binding === null ? seat : seatForAccount(seat, binding.target);
      return repo === undefined ? undefined : { seat: bound, session, repo }; // the loader refuses a missing repo
    }
    return undefined;
  }

  const transferKey = (runId: string) => `account-transfer:${runId}`;
  function transferState(runId: string): AccountTransfer | null {
    const text = store.getSetting(transferKey(runId));
    return text === null ? null : (JSON.parse(text) as AccountTransfer);
  }
  function runBindingProblem(run: Run, accountId: string): boolean {
    const account = config.accounts.find((a) => a.id === accountId);
    if (!account) return true;
    // Legacy machine-login runs keep their saved provider across config edits.
    return (
      (transferState(run.id) !== null || account.cliProfile !== undefined) &&
      account.vendor !== (run.vendor ?? "claude")
    );
  }

  let accountUpdate: Promise<void> | null = null;
  function withAccountUpdate<T>(fn: () => Promise<T>): Promise<T> {
    const update = (accountUpdate ?? Promise.resolve()).then(fn);
    const settled = update
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        if (accountUpdate === settled) accountUpdate = null;
      });
    accountUpdate = settled;
    return update;
  }

  const transfers = new Map<string, Promise<AccountTransferResult>>();
  const profilePolicyKey = (runId: string) => `account-profile-denies:${runId}`;
  const profileDenies = () =>
    config.accounts.flatMap((a) => {
      const profile = a.vendor === "codex" ? codexProfile(a) : a.cliProfile;
      return profile === undefined ? [] : [realish(profile)];
    });

  const live = new Map<string, Live>();
  /** Seats whose start is between the busy check and the first seat row. */
  const starting = new Set<string>();
  const deferredRecoveries = new Set<string>();
  let recoveringDeferred: Promise<void> | null = null;
  let unpauseResume: (() => void) | undefined;
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
  let reattaching: Promise<void> | null = null;
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
  const isCodex = (info: SeatInfo) =>
    config.accounts.find((a) => a.id === info.seat.accountId)?.vendor === "codex";

  const resumeModel = (info: SeatInfo, run: Run): string => {
    if (run.model !== null) return run.model;
    const vendor = run.vendor ?? "claude";
    if (config.accounts.find((a) => a.id === info.seat.accountId)?.vendor !== vendor)
      throw new Error(`${CANNOT_START}: saved model missing and account vendor changed`);
    // Codex runs always save their model. Only legacy Claude rows need a fallback.
    if (vendor === "codex") throw new Error(`${CANNOT_START}: saved Codex model missing`);
    return info.seat.model;
  };

  async function startedOn(info: SeatInfo): Promise<{ cliVersion?: string }> {
    if (isCodex(info)) return {};
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
    new SupervisorError(409, `${call(info)} has no live session; start it on a ticket`, {
      deadSession: true,
    });

  function liveOrRefuse(info: SeatInfo): Live {
    const l = live.get(info.seat.id);
    if (!l?.session.alive) {
      const row = store.seatSession(info.seat.id);
      if (row?.runId != null && row.state !== "stopped" && store.run(row.runId)?.endedAt === null) {
        void resumeRun(row.runId).catch((e: unknown) =>
          log(`${info.seat.id}: could not resume: ${errText(e)}`),
        );
        throw new SupervisorError(409, `${call(info)} is being resumed; try again in a moment`);
      }
      throw noLive(info);
    }
    if (l.ending !== null) throw noLive(info);
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
      facts = foldPath(transcripts, l.run.transcriptPath, undefined, l.run.vendor);
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

  function noteMissingReport(
    info: SeatInfo,
    run: Run,
    exit: Pick<NonNullable<Run["noReport"]>, "code" | "signal" | "lastStderr"> & {
      error?: string;
      lastStderrAt?: number | null;
      endReason?: string | null;
    },
    facts: ReturnType<typeof foldPath>,
    at: number,
  ): void {
    try {
      if (
        recordNoReport(
          store,
          run,
          seatDef(info.seat).loop,
          {
            code: exit.code,
            signal: exit.signal,
            error: exit.error === undefined ? undefined : cleanText(exit.error, STDERR_TEXT_MAX),
            lastStderr: recentStderr(exit, at),
          },
          facts,
          at,
        )
      )
        bus.emit("attention");
    } catch (e) {
      log(`${run.agentId}: could not record missing report for ${run.id}: ${errText(e)}`);
    }
  }

  function onExit(
    l: Live,
    e: { code: number | null; signal: string | null; reason?: string },
  ): void {
    const seatId = l.info.seat.id;
    if (transferState(l.run.id)?.pending) return;
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
    const fresh = store.run(l.run.id);
    const parked = fresh?.loop?.parked?.kind;
    const failedReview =
      fresh?.reviewId != null && store.review(fresh.reviewId)?.state === "failed";
    if (l.endedBy === null || parked === "silent" || parked === "budget" || failedReview)
      noteMissingReport(
        l.info,
        l.run,
        { ...e, lastStderr: l.lastStderr, lastStderrAt: l.lastStderrAt },
        transcripts.get(l.run.transcriptPath)?.facts ?? null,
        l.run.endedAt as number,
      );
    transcripts.delete(l.run.transcriptPath);
    digests.delete(l.run.id);
    if (byEngine) {
      emit({ kind: "seat-free", seatId, runId: l.run.id });
      return;
    }
    store.setRunEnded(l.run.id, l.run.endedAt as number, l.run.status, l.endedBy ?? "exit");
    removeRunFiles(l.run.id);
    closeRunItems(l.info);
    // read before the seat row changes
    const worktree = store.seatSession(seatId)?.worktree ?? null;
    if (l.run.reviewId != null) void dropScratch(l.info, l.run.id, l.run.seq, worktree);
    if (l.ending !== null) {
      setSeat(seatId, { state: l.hold ? "stopped" : "idle", reason: null, runId: null });
    } else {
      // Neither a code nor a signal: the CLI never started (its stderr event says why).
      const how = e.code ?? e.signal;
      const resumeWindow = deps.resumeWindowMs ?? RESUME_WINDOW_MS;
      const failedResume = l.spawnedAt !== null && Date.now() - l.spawnedAt < resumeWindow;
      const why = how === null ? CANNOT_START : `process exited ${how}`;
      // A CLI that ran and failed: its own last word (already cleaned and cut) says why. One that
      // never started keeps the fixed text (the spawn error names the command's path; it is logged).
      const said =
        how !== null &&
        l.lastStderr &&
        l.lastStderrAt !== null &&
        now() - l.lastStderrAt <= STDERR_RECENT_MS
          ? l.lastStderr
          : null;
      const reason = failedResume
        ? `${RESUME_FAILED}: ${said ?? why}`
        : `${why}${said === null ? "" : `: ${said}`}`;
      setSeat(seatId, { state: "error", reason: e.reason ?? reason });
    }
    emit({ kind: "run-ended", seatId, runId: l.run.id, endedBy: l.endedBy ?? "exit" });
  }

  function onEvent(l: Live, e: SessionEvent): void {
    switch (e.kind) {
      case "init":
        if (l.run.vendor === "codex") {
          l.run = { ...l.run, sessionId: e.sessionId };
          store.upsertRun(l.run);
          setSeat(l.info.seat.id, { cliSessionId: e.sessionId });
        }
        break;
      case "turn-refused":
        if (!e.active) {
          l.inTurn = false;
          setState(l, "idle", LAST_TURN_ERROR);
        }
        break;
      case "turn-start":
        l.inTurn = true;
        store.setSeatTurnStarted(l.info.seat.id, now());
        if (!l.parkedTurn) setState(l, "running", null);
        break;
      case "tool-result":
        // the call has ended, however it ended: its hold goes (a Post hook may never come)
        deps.lock.release({ runId: l.run.id, toolUseId: e.toolUseId });
        // a Codex command says how it exited; a Claude call's end comes by its Post hook instead
        if (e.ok !== undefined) {
          void deps.checks?.end({ runId: l.run.id, toolUseId: e.toolUseId }, e.ok, e.exitCode);
        }
        // a result replayed at an attach was counted by the keeper that first saw it
        if (
          e.bytes !== undefined &&
          e.bytes > 0 &&
          !(l.awaitingAtAttach && l.session.lines <= l.replayedBelow)
        ) {
          try {
            store.addToolResultBytes(l.run.id, e.bytes, now());
          } catch (err) {
            log(`${l.run.agentId}: could not count a tool result: ${errText(err)}`);
          }
        }
        break;
      case "result": {
        // No call is in flight once the turn has ended: whatever the run held is freed. Not for a
        // result replayed at an attach while a later turn is open: its hold is that turn's.
        if (!(l.awaitingAtAttach && l.session.lines <= l.replayedBelow)) {
          deps.lock.releaseRun(l.run.id);
          deps.checks?.dropRun(l.run.id);
        }
        const interrupted = l.interrupted;
        l.inTurn = false;
        l.interrupted = false;
        const cache = contextCaches.get(l);
        if (cache) {
          cache.stale = true;
          cache.retryAt = 0;
        }
        fold(l);
        if (l.parkedTurn) {
          l.parkedTurn = false; // parked stays until the next line starts a turn
        } else {
          // An interrupted turn ends `is_error` (error_during_execution): that is the interrupt.
          setState(l, "idle", e.isError && !interrupted ? LAST_TURN_ERROR : null);
          store.setSeatTurnEnded(l.info.seat.id, now());
          // a run being ended is no one's to nudge; nor is one still replaying (`onAttached` says)
          if (l.ending === null && !l.attaching) {
            emit({ kind: "idle", seatId: l.info.seat.id, runId: l.run.id, resumed: false });
          }
        }
        // after the result's effects, which a replay of it applies again without harm
        saveCursor(l);
        break;
      }
      case "attached":
        onAttached(l, e.awaiting);
        break;
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
        l.lastStderrAt = now();
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
    // A completed Codex interrupt leaves the seat idle until the replacement is sent.
    if (l.run.vendor === "codex") setState(l, "running", null);
  }

  async function sendInterrupt(l: Live): Promise<void> {
    try {
      await l.session.control("interrupt", {
        onSuccess: () => {
          // Codex reports interrupted turns separately from failed ones.
          if (l.run.vendor !== "codex") l.interrupted = true;
        },
      });
    } catch (e) {
      if (e instanceof SessionControlError && e.kind === "ended") throw noLive(l.info);
      if (e instanceof SessionControlError && e.kind === "timeout")
        throw new SupervisorError(504, `${call(l.info)} did not answer the interrupt`, {
          cause: e,
        });
      throw new SupervisorError(409, `${call(l.info)} refused the interrupt: ${errText(e)}`, {
        cause: e,
      });
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

  /** Python's and its tools' caches, the seat's own in the sandbox's temp root; `uv run` uses the hub's install, offline. */
  function crewPythonEnv(tmp: string, seatId: string): Record<string, string> {
    return {
      UV_NO_SYNC: "1",
      UV_OFFLINE: "1",
      UV_CACHE_DIR: `${tmp}/mc-uv-cache/${seatId}`,
      PYTHONPYCACHEPREFIX: `${tmp}/mc-pycache/${seatId}`,
      RUFF_CACHE_DIR: `${tmp}/mc-ruff-cache/${seatId}`,
      MYPY_CACHE_DIR: `${tmp}/mc-mypy-cache/${seatId}`,
      COVERAGE_FILE: `${tmp}/mc-pycache/${seatId}/.coverage`,
      PYTEST_ADDOPTS: "-p no:cacheprovider",
    };
  }

  /**
   * No git identity: a seat cannot commit, and the mc commit tool names each commit's author.
   * pnpm's store is hub-owned below crew.worktrees, never inside a worktree or seat temp root.
   * Python's caches likewise (`crewPythonEnv`). pnpm stays on its installed version (`CREW_PNPM_ENV`).
   */
  function crewEnv(seatId: string, tmp: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of CREW_ENV_KEYS) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    env.HOME = homedir();
    env.TMPDIR = tmp;
    env.TMP = tmp;
    env.TEMP = tmp;
    env.CLAUDE_CODE_TMPDIR = tmp;
    env[PNPM_STORE_ENV] = sharedPnpmStoreDir(crew?.worktrees ?? "");
    Object.assign(env, crewPythonEnv(tmp, seatId));
    return { ...env, ...CREW_CLI_ENV, ...CREW_PNPM_ENV, ...CREW_GIT_ENV };
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

  /** The audit identity includes both generated developer instructions and the first user brief. */
  function recordPromptVersion(
    run: Run,
    rolePath: string,
    brief: string,
    briefPieces: readonly PromptPiece[],
    system: readonly PromptPiece[] | null,
  ): void {
    const instructions = readFileSync(crewPromptPath(deps.dbPath, run.id), "utf8");
    const payload = ["developer-instructions", instructions, "first-brief", brief].join("\0");
    store.setRunPromptVersion(
      run.id,
      createHash("sha256").update(payload).digest("hex"),
      rolePath,
      now(),
    );
    // a launch that kept its prompt file (a resume, a transfer) sent nothing new
    if (system === null) return;
    try {
      store.recordPromptSections(
        run.id,
        0,
        now(),
        mergeSections(
          promptSections(instructions, system, "role"),
          promptSections(brief, briefPieces, "orders"),
        ),
      );
    } catch (e) {
      log(`${run.agentId}: could not record the prompt's sections: ${errText(e)}`);
    }
  }

  /**
   * Token and MCP files a hub that went down without seeing its processes exit left behind: their
   * tokens died with its memory. Run once the crew lock is held, before any spawn. The lock lives
   * in `crew.worktrees`, not beside the DB, so the files of every run the DB still holds active are
   * kept (their resume rewrites them); only the rest go. Every draft PR body file goes too. A
   * store that cannot say which runs are active removes nothing.
   */
  function sweepRunFiles(): void {
    try {
      const activeRows = heldSessions();
      const active = new Set(activeRows.map((r) => r.runId));
      const keeping = new Set(
        activeRows.flatMap((r) =>
          r.runId === null ? [] : [basename(crewKeeperDir(deps.dbPath, r.runId))],
        ),
      );
      const ended = store.runsActiveSince(0).filter((r) => r.endedAt !== null);
      const endedKeepers = new Map(
        ended.map((r) => [basename(crewKeeperDir(deps.dbPath, r.id)), r.id]),
      );
      const removeOrphan = (folder: string) => {
        rmSync(folder, { recursive: true, force: true });
        const runId = endedKeepers.get(basename(folder));
        if (runId !== undefined) removeRunFiles(runId);
      };
      const dir = crewDir(deps.dbPath);
      const codexHomes = new Set(
        store
          .runsActiveSince(Number.MAX_SAFE_INTEGER)
          .filter((r) => r.endedAt === null && r.vendor === "codex")
          .map((r) => basename(crewCodexDir(deps.dbPath, r.id))),
      );
      const skillsDirs = new Set(
        store
          .runsActiveSince(Number.MAX_SAFE_INTEGER)
          .filter((r) => r.endedAt === null && r.vendor !== "codex")
          .map((r) => basename(crewSkillsDir(deps.dbPath, r.id))),
      );
      for (const name of readdirSync(dir)) {
        if (CREW_CODEX_DIR.test(name) && !codexHomes.has(name)) {
          rmSync(join(dir, name), { recursive: true, force: true });
          continue;
        }
        if (CREW_SKILLS_DIR.test(name) && !skillsDirs.has(name)) {
          rmSync(join(dir, name), { recursive: true, force: true });
          continue;
        }
        // a keeper's folder of a run that is no longer active: its keeper and CLI are ended, then it goes
        if (CREW_KEEPER_DIR.test(name)) {
          const folder = join(dir, name);
          if (keeping.has(name) && !endedKeepers.has(name)) continue;
          if (!keeperAlive(folder)) {
            removeOrphan(folder);
            continue;
          }
          void endKeeper(folder, keeperEndWait(), log).then((ended) => {
            if (ended) removeOrphan(folder);
            else log(`could not end the orphan keeper in ${folder}; its folder is kept`);
          });
          continue;
        }
        // a PR body file left by a hub that died during `gh pr create`: no draft_pr runs before
        // this start, since every older process's token died with that hub
        const stale =
          CREW_PR_BODY_FILE.test(name) ||
          (RUN_SECRET_FILE.test(name) && !active.has(name.replace(RUN_SECRET_FILE, "")));
        if (!stale) continue;
        rmSync(join(dir, name), { force: true });
      }
      // Also covers a crash after the keeper folder went but before its temp root did.
      for (const run of ended) removeRunFiles(run.id);
    } catch (e) {
      log(`could not clear old run files: ${errText(e)}`);
    }
  }

  const isActive = (row: SeatSessionRow | null) =>
    row !== null && row.runId !== null && ACTIVE_SEAT_STATES.includes(row.state);

  /**
   * The one way a seat's process is spawned, fresh or resumed: the prompt file (role brief + the
   * repo's CLAUDE.md and reference index, read from verified objects at the run's base), a new
   * token with its two 0600 files, the guard hook and the sandbox for this worktree, the minimal env, and the run's transcript (appended
   * to). A resume keeps the run's own prompt file (R28). It does not know the run's base, so it
   * rebuilds a missing one from the role brief alone: never from the worktree, which is the
   * seat's to write. Registers the live seat and its events; throws when the hook command cannot
   * be built (before any token exists) or the spawn itself throws (after undoing the token and
   * files).
   */
  async function checkedLaunch(
    configured: SeatInfo,
    run: Run,
    cliSessionId: string,
    checkout: { path: string; branch: string; gitDir: string },
    resume: boolean,
    repoDocs: RepoDocs | null,
    references = "",
    keepPrompt = false,
    beforeLaunch?: () => Run | undefined,
    beforeSpawn?: (system: readonly PromptPiece[] | null) => void,
  ): Promise<Live> {
    const binding = transferState(run.id);
    const info =
      binding === null
        ? configured
        : { ...configured, seat: seatForAccount(configured.seat, binding.target) };
    if (runBindingProblem(run, info.seat.accountId))
      throw new SupervisorError(
        409,
        "configured run account is missing or has a different provider",
      );
    await assertSeatGitVersion();
    await assertSeatGitConfig(
      checkout.path,
      [...(modeOfSeat(info.seat) === "read-only" ? [] : [checkout.path]), seatTmp(run.id)],
      [dirname(deps.dbPath)],
    );
    // Every seat receives this read-only sandbox grant, even if this repository has no pnpm
    // lockfile and therefore did not run installation.
    await prepareSharedPnpmStore(crew?.worktrees ?? "", info.seat.id);
    const unavailable = seatUnavailable(info.seat, run.model ?? undefined, run.vendor ?? "claude");
    if (unavailable) throw new SupervisorError(409, unavailable);
    if (run.vendor === "codex") {
      const cliVersion = await probeCodexVersion(deps.codexCommand ?? CODEX_COMMAND);
      if (stopping) throw new Error(SHUTTING_DOWN);
      store.setRunCliVersionIfLive(run.id, cliVersion);
    }
    while (accountUpdate !== null) await accountUpdate;
    if (stopping) throw new Error(SHUTTING_DOWN);
    const bindingProblem = accountBindingProblem(config.accounts);
    if (bindingProblem) throw new SupervisorError(409, bindingProblem);
    const current = beforeLaunch?.();
    if (current !== undefined) run = current;
    return launch(
      info,
      run,
      cliSessionId,
      checkout,
      resume,
      repoDocs,
      references,
      keepPrompt,
      beforeSpawn,
    );
  }

  function launch(
    info: SeatInfo,
    run: Run,
    cliSessionId: string,
    checkout: { path: string; branch: string; gitDir: string },
    resume: boolean,
    repoDocs: RepoDocs | null,
    references = "",
    keepPrompt = false,
    beforeSpawn?: (system: readonly PromptPiece[] | null) => void,
  ): Live {
    const pause = pausedSeat(store, info.seat.id);
    if (pause) throw new SupervisorError(409, `Paused: ${pause.reason}`);
    const def = seatDef(info.seat);
    const model =
      resume || keepPrompt
        ? resumeModel(info, run)
        : run.reviewId != null && run.model !== null
          ? run.model
          : info.seat.model;
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
    let system: PromptPiece[] | null = null;
    if ((!resume && !keepPrompt) || !existsSync(promptPath)) {
      if (resume) {
        log(
          `${info.seat.id}: prompt file missing on resume; rebuilt from the role brief, without the repo's CLAUDE.md, AGENTS.md or reference index`,
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
      // Repo guidance is operator-written advice for FLIGHT, not a gate used by the scheduler or
      // by seats. It is deliberately appended only to the watch seat's prompt.
      const guidance =
        def.loop === "watch"
          ? deps.config.repos.find((repo) => repo.id === info.session.repoId)?.guidance
          : undefined;
      const advice =
        guidance === undefined
          ? ""
          : [
              "# Mission Control work guidance (advice, not rules)",
              guidance.priority.length ? `Prefer priority: ${guidance.priority.join(", ")}.` : "",
              guidance.milestone.length
                ? `Prefer milestone: ${guidance.milestone.join(", ")}.`
                : "",
              guidance.labels.length
                ? `Labels (${guidance.labelMode}): ${guidance.labels.join(", ")}.`
                : "",
              guidance.avoid.length ? `Avoid: ${guidance.avoid.join(", ")}.` : "",
              guidance.direction,
            ]
              .filter((line) => line !== "")
              .join("\n");
      writeFileSync(
        promptPath,
        rolePrompt(
          roleBrief,
          repoDocs?.claudeMd ?? null,
          [advice, references].filter(Boolean).join("\n\n"),
          repoDocs?.agentsMd ?? null,
        ),
        {
          mode: 0o600,
        },
      );
      const block = (heading: string, body: string | null | undefined): number =>
        body == null || body.trim() === "" ? 0 : textBytes(`\n\n${heading}\n\n${body}`);
      system = [
        { section: "orders", bytes: textBytes(advice) },
        {
          section: "rules",
          bytes:
            textBytes(references) +
            block(CLAUDE_MD_HEADING, repoDocs?.claudeMd) +
            block(AGENTS_MD_HEADING, repoDocs?.agentsMd),
        },
      ];
    }
    beforeSpawn?.(system);
    const keeperSpawn = randomUUID();
    const release = grant(info, run);
    // A resume's earlier token (its process gone) is dropped before the new one is issued.
    deps.tokens.revoke(run.id);
    const token = deps.tokens.issue(info.seat.id, run.id);
    let session: CrewSession;
    try {
      // the cursor of an earlier keeper counts that keeper's lines, not this one's
      store.deleteKeeperCursor(run.id);
      for (const why of repoDocs?.skills?.refused ?? []) {
        log(`${info.seat.id}: skill left out of the run: ${why}`);
      }
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
      const tmpPath = run.vendor === "codex" ? codexSeatTmp(cwd, run.id) : seatTmp(run.id);
      for (const path of [dirname(tmpPath), tmpPath]) {
        try {
          mkdirSync(path, { mode: 0o700 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const st = lstatSync(path);
        if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700)
          throw new Error("crew temp root must be a private directory owned by the server");
      }
      const tmp = realpathSync(tmpPath);
      // made here, before the seat runs: the trim hook writes in it outside the sandbox
      if (run.vendor !== "codex") {
        const outDir = join(tmp, TOOL_OUTPUT_DIR);
        try {
          mkdirSync(outDir, { mode: 0o700 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const st = lstatSync(outDir);
        if (!st.isDirectory() || st.uid !== process.getuid?.())
          throw new Error("crew tool-output folder must be a directory owned by the server");
      }
      const pnpmStore = sharedPnpmStoreDir(crew?.worktrees ?? "");
      if (run.vendor === "codex")
        store.setSetting(codexTmpKey(run.id), JSON.stringify({ worktree: cwd, tmp }));
      const gitCommonDir = realpathSync(join(info.session.checkout, ".git"));
      const sandboxBase = {
        cwd,
        ...(run.vendor === "codex" ? {} : { tempRoot: tmp }),
        gitCommonDir,
        worktreeGitDir: realpathSync(checkout.gitDir),
        home: homedir(),
        dataDir: realpathSync(dirname(deps.dbPath)),
        pnpmStoreDir: pnpmStore,
        denyRead: [
          ...seatDenyRead(deps.config, deps.hubRoot, info.session.id, mates),
          ...profileDenies(),
          ...(run.vendor === "codex"
            ? [`/tmp/claude-${process.getuid?.()}`, `/private/tmp/claude-${process.getuid?.()}`]
            : []),
        ],
      };
      const sandbox = {
        ...sandboxBase,
        toolchainDirs: seatToolchainDirs(
          process.execPath,
          process.env.PATH ?? "",
          homedir(),
          sandboxReadDenies(sandboxBase),
        ),
        allowRead: crew?.allowRead ?? [],
      };
      if (run.vendor === "codex") {
        addMcTmpExclude(gitCommonDir);
        const claudeTmpParentPath = dirname(seatTmp(run.id));
        try {
          mkdirSync(claudeTmpParentPath, { mode: 0o700 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const parentStat = lstatSync(claudeTmpParentPath);
        if (
          !parentStat.isDirectory() ||
          parentStat.uid !== process.getuid?.() ||
          (parentStat.mode & 0o777) !== 0o700
        )
          throw new Error("crew temp root must be a private directory owned by the server");
        const claudeTmpParent = realpathSync(claudeTmpParentPath);
        let auth: string;
        try {
          const account = config.accounts.find((a) => a.id === info.seat.accountId);
          if (!account || runBindingProblem(run, info.seat.accountId))
            throw new Error("configured Codex account is missing or has a different provider");
          const profile = codexProfile(account);
          const path =
            account?.cliProfile === undefined && deps.codexAuthPath !== undefined
              ? deps.codexAuthPath
              : join(profile, "auth.json");
          auth = readFileSync(path, "utf8");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT")
            throw new Error("no Codex login", { cause: e });
          throw e;
        }
        const command = deps.codexCommand ?? CODEX_COMMAND;
        const dir = crewKeeperDir(deps.dbPath, run.id);
        const runDir = crewCodexDir(deps.dbPath, run.id);
        const home = join(runDir, "codex-home");
        const zdotdir = join(runDir, "zsh-empty");
        const env = Object.fromEntries(
          Object.entries(crewEnv(info.seat.id, tmp)).filter(
            (e): e is [string, string] => !e[0].startsWith("CLAUDE_") && typeof e[1] === "string",
          ),
        );
        Object.assign(env, {
          CODEX_HOME: home,
          [CODEX_SEAT_TOKEN_ENV]: token,
          SHELL: CODEX_SHELL,
          ZDOTDIR: zdotdir,
          TMPDIR: tmp,
          TMP: tmp,
          TEMP: tmp,
          [PNPM_STORE_ENV]: pnpmStore,
          UV_CACHE_DIR: join(tmp, "uv-cache"),
          PYTHONPYCACHEPREFIX: join(tmp, "pycache"),
          RUFF_CACHE_DIR: join(tmp, "ruff-cache"),
          MYPY_CACHE_DIR: join(tmp, "mypy-cache"),
          COVERAGE_FILE: join(tmp, ".coverage"),
        });
        const marker = `mc_run="${run.id}"`;
        session = startCodexSession({
          command,
          args: ["app-server", "-c", marker],
          cwd,
          env,
          transcriptPath: run.transcriptPath,
          node: crew?.node ?? DEFAULT_CREW_NODE,
          entry: join(deps.hubRoot, KEEPER_ENTRY),
          dir,
          spawn: keeperSpawn,
          marker,
          model,
          effort: info.seat.effort ?? null,
          developerInstructions: readFileSync(promptPath, "utf8"),
          resumeThreadId: resume ? cliSessionId : null,
          outboxPath: join(runDir, CODEX_OUTBOX_FILE),
          approve: codexApprover(info, run, cwd),
          log,
          controlTimeoutMs: deps.controlTimeoutMs,
          stopGraceMs: deps.stopGraceMs,
          prepare: () => {
            mkdirSync(runDir, { recursive: true, mode: 0o700 });
            mkdirSync(home, { recursive: true, mode: 0o700 });
            mkdirSync(zdotdir, { recursive: true, mode: 0o700 });
            writePrivate(
              join(home, "config.toml"),
              // Close the shared parent of the Claude seats' temp roots (`crewTempRoot`): the
              // Codex root-read base would otherwise reach them. Codex's own temp root is in
              // its worktree, so this deny no longer sits above anything the seat resolves.
              codexSeatConfig(sandbox, def.mode, `${hub}${MCP_PATH}`, tmp).replace(
                '":root"="read"',
                ['":root"="read"', `${JSON.stringify(claudeTmpParent)}="deny"`].join("\n"),
              ),
            );
            writePrivate(join(home, "auth.json"), auth);
            // a resume has no skills read; its home already holds the run's
            if (repoDocs?.skills !== undefined) {
              copySkillsToCodexHome(home, repoDocs.skills.skills);
            }
          },
        });
      } else {
        const skillsDir = crewSkillsDir(deps.dbPath, run.id);
        // a resume has no skills read; the folder the start built is still there
        if (repoDocs?.skills !== undefined && repoDocs.skills.skills.length > 0) {
          writeSkillPlugin(skillsDir, info.repo.id, repoDocs.skills.skills);
        }
        const args = crewCliArgs({
          pluginDir: existsSync(join(skillsDir, ".claude-plugin")) ? skillsDir : undefined,
          commands: info.repo.commands,
          protectedFiles: info.repo.protectedFiles,
          granted: runPathGrants(store, run.id),
          model,
          effort: info.seat.effort,
          mode: def.mode,
          profile: crewProfileOf(info.seat.role, def.loop),
          mcTools: def.mcTools,
          runTools: runSeatGrants(config, store, { seatId: info.seat.id, runId: run.id }).filter(
            (tool) => !def.mcTools.includes(tool),
          ),
          rolePromptFile: promptPath,
          sessionId: cliSessionId,
          resume,
          area: info.seat.area,
          sandbox,
          mcpConfigFile: mcpPath,
          hook: {
            command: hookCommand,
            timeoutS: GUARD_HOOK_TIMEOUT_S,
            trim: {
              command: trimHookCommand({
                node: crew?.node ?? DEFAULT_CREW_NODE,
                entry: join(deps.hubRoot, TRIM_ENTRY),
                dir: join(tmp, TOOL_OUTPUT_DIR),
              }),
              timeoutS: TRIM_HOOK_TIMEOUT_S,
            },
          },
        });
        session = startSession({
          command: deps.command,
          args: [...(deps.commandArgs ?? []), ...args],
          cwd,
          transcriptPath: run.transcriptPath,
          env: crewEnv(info.seat.id, tmpPath),
          node: crew?.node ?? DEFAULT_CREW_NODE,
          entry: join(deps.hubRoot, KEEPER_ENTRY),
          dir: crewKeeperDir(deps.dbPath, run.id),
          spawn: keeperSpawn,
          cliSessionId,
          log,
          controlTimeoutMs: deps.controlTimeoutMs,
          stopGraceMs: deps.stopGraceMs,
        });
      }
    } catch (e) {
      release();
      throw e;
    }
    store.setSetting(profilePolicyKey(run.id), JSON.stringify(profileDenies()));
    const l = track(info, run, session, release, {
      spawn: keeperSpawn,
      resumedAt: resume && !transferState(run.id)?.pending ? Date.now() : null,
      spawnedAt: resume ? Date.now() : null,
    });
    // the resume window runs from the CLI's start, not from the keeper's: its own boot is not the CLI's
    if (resume) {
      void session.ready.then(() => {
        if (l.spawnedAt !== null) l.spawnedAt = Date.now();
      });
    }
    return l;
  }

  function codexApprover(info: SeatInfo, run: Run, cwd: string) {
    return createCodexApprover({
      config,
      repoId: info.repo.id,
      seatId: info.seat.id,
      runId: run.id,
      mode: seatDef(info.seat).mode,
      area: info.seat.area,
      granted: runPathGrants(store, run.id),
      cwd,
      lock: deps.lock,
      ...(deps.checks === undefined ? {} : { checks: deps.checks }),
      superuserTools: deps.superuserTools,
      runGrants: () => runSeatGrants(config, store, { seatId: info.seat.id, runId: run.id }),
      record: (rule, text) => {
        store.addGuardHit({ agentId: info.seat.id, runId: run.id, rule, text, at: now() });
        bus.emit("guard");
      },
    });
  }

  function removeRunFiles(runId: string): void {
    try {
      if (keeperAlive(crewKeeperDir(deps.dbPath, runId))) return;
      // The Codex dir (its auth copy) goes first, whatever happens to the temp root.
      rmSync(crewCodexDir(deps.dbPath, runId), { recursive: true, force: true });
      rmSync(crewSkillsDir(deps.dbPath, runId), { recursive: true, force: true });
      const codexTmp = store.getSetting(codexTmpKey(runId));
      if (codexTmp === null) rmSync(seatTmp(runId), { recursive: true, force: true });
      else if (!removeCodexTmp(runId, codexTmp))
        log(`could not remove run files of ${runId}: temp root changed`);
    } catch (e) {
      log(`could not remove run files of ${runId}: ${errText(e)}`);
    }
  }

  function seatTmp(runId: string): string {
    return crewTempRoot(deps.dbPath, runId, process.getuid?.() ?? 0);
  }

  function codexSeatTmp(worktree: string, runId: string): string {
    const key = createHash("sha256").update(`${deps.dbPath}:${runId}`).digest("hex").slice(0, 12);
    return join(worktree, MC_TMP_DIR_NAME, key);
  }

  function codexTmpKey(runId: string): string {
    return `codex-tmp:${runId}`;
  }

  /** A seat can write its worktree, so validate this whole path before recursive cleanup. */
  function removeCodexTmp(runId: string, value: string): boolean {
    let saved: { worktree: string; tmp: string };
    try {
      saved = JSON.parse(value) as { worktree: string; tmp: string };
      if (typeof saved.worktree !== "string" || typeof saved.tmp !== "string") return false;
      const parent = dirname(saved.tmp);
      const key = basename(saved.tmp);
      const worktree = realpathSync(saved.worktree);
      const expected = join(worktree, MC_TMP_DIR_NAME, key);
      try {
        const parentStat = lstatSync(parent);
        if (
          !parentStat.isDirectory() ||
          parentStat.uid !== process.getuid?.() ||
          (parentStat.mode & 0o777) !== 0o700
        )
          return false;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          store.deleteSetting(codexTmpKey(runId));
          return true;
        }
        return false;
      }
      try {
        const tmpStat = lstatSync(saved.tmp);
        if (
          !tmpStat.isDirectory() ||
          tmpStat.uid !== process.getuid?.() ||
          (tmpStat.mode & 0o777) !== 0o700 ||
          realpathSync(saved.tmp) !== expected
        )
          return false;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          store.deleteSetting(codexTmpKey(runId));
          return true;
        }
        return false;
      }
      rmSync(saved.tmp, { recursive: true, force: true });
      store.deleteSetting(codexTmpKey(runId));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        store.deleteSetting(codexTmpKey(runId));
        return true;
      }
      return false;
    }
  }

  /**
   * One spawn's grant on a run: it owns the run's token, files, keeper folder and test-lock hold.
   * The returned release undoes it, unless a later spawn of the run has taken it over. Defensive, and
   * untested: the supervisor never runs two processes for one run, so a later spawn cannot exist
   * while this one lives (it would take overlapping processes no code path makes).
   */
  function grant(info: SeatInfo, run: Run): () => void {
    const spawn = {};
    spawns.set(run.id, spawn);
    return () => {
      if (spawns.get(run.id) !== spawn) return;
      spawns.delete(run.id);
      deps.tokens.revoke(run.id);
      deps.lock.releaseRun(run.id);
      for (const p of [crewTokenPath(deps.dbPath, run.id), crewMcpPath(deps.dbPath, run.id)]) {
        try {
          rmSync(p, { force: true });
        } catch (e) {
          log(`${info.seat.id}: could not remove ${p}: ${errText(e)}`);
        }
      }
      try {
        rmSync(seatTmp(run.id), { recursive: true, force: true });
      } catch (e) {
        log(`${info.seat.id}: could not remove crew temp files: ${errText(e)}`);
      }
      removeKeeper(info.seat.id, run.id);
    };
  }

  /** Removes a run's keeper folder and its cursor. Never throws. */
  function removeKeeper(seatId: string, runId: string): void {
    try {
      rmSync(crewKeeperDir(deps.dbPath, runId), { recursive: true, force: true });
      store.deleteKeeperCursor(runId);
      if (store.run(runId)?.endedAt != null) removeRunFiles(runId);
    } catch (e) {
      log(`${seatId}: could not remove the keeper folder of ${runId}: ${errText(e)}`);
    }
  }

  /** How long `endKeeper` waits for a keeper and CLI to take the SIGTERM: their stop grace twice, and a margin. */
  const keeperEndWait = () => 2 * (deps.stopGraceMs ?? STOP_GRACE_MS) + 5000;

  /**
   * Ends a run's keeper and CLI, then removes the folder and the cursor. A folder whose keeper is
   * not alive goes at once; one whose processes will not end is kept (and said), so the next start
   * finds it. True when the keeper is gone. Never throws.
   */
  async function endAndRemoveKeeper(seatId: string, runId: string): Promise<boolean> {
    const dir = crewKeeperDir(deps.dbPath, runId);
    try {
      if (keeperAlive(dir) && !(await endKeeper(dir, keeperEndWait(), log))) {
        log(`${seatId}: could not end the keeper of ${runId}; its folder is kept`);
        return false;
      }
    } catch (e) {
      log(`${seatId}: could not end the keeper of ${runId}: ${errText(e)}`);
      return false;
    }
    removeKeeper(seatId, runId);
    return true;
  }

  /** Registers a seat's process: its exit releases the grant, and its events reach `onEvent`. */
  function track(
    info: SeatInfo,
    run: Run,
    session: CrewSession,
    release: () => void,
    init: Partial<Live> & { spawn: string },
  ): Live {
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
      hold: false,
      rateLimitedUntil: null,
      lastFoldAt: 0,
      foldTimer: undefined,
      resumedAt: null,
      spawnedAt: null,
      off: () => {},
      lastStderr: null,
      lastStderrAt: null,
      attaching: false,
      replayedBelow: 0,
      awaitingAtAttach: false,
      ...init,
    };
    live.set(info.seat.id, l);
    l.off = session.on((e) => onEvent(l, e));
    return l;
  }

  /** Ends a run that cannot be resumed: the run failed, the seat in error with `reason`. */
  function failResume(
    row: SeatSessionRow,
    reason: string,
    opts: {
      record?: boolean;
      exit?: Pick<NonNullable<Run["noReport"]>, "code" | "signal" | "lastStderr"> & { at: number };
    } = {},
  ): void {
    const run = row.runId === null ? null : store.run(row.runId);
    const open = run !== null && run.endedAt === null;
    if (open) {
      const at = now();
      const facts = foldOpenRun(run);
      store.setRunEnded(run.id, at, "failed", "exit");
      removeRunFiles(run.id);
      const info = findSeat(row.seatId);
      if (info && opts.record !== false)
        noteMissingReport(
          info,
          run,
          opts.exit ?? { code: null, signal: null, lastStderr: null, error: reason },
          facts,
          opts.exit?.at ?? at,
        );
    }
    setSeat(row.seatId, { state: "error", reason });
    if (row.runId !== null) {
      // the run's token goes with it, and so does its keeper: nothing is left running for a failed run
      dropGrant(row.seatId, row.runId);
      void endAndRemoveKeeper(row.seatId, row.runId);
    }
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
   * With more than one session, worktrees still directly in `crew.worktrees` (made before each
   * session had a folder) are readable by every seat until their runs end: said once at start.
   */
  function noteFlatWorktrees(): void {
    if (!crew || crew.sessions.length < 2) return;
    const seatIds = crew.sessions.flatMap((s) => s.seats.map((x) => x.id));
    let names: string[];
    try {
      names = readdirSync(crew.worktrees);
    } catch {
      return;
    }
    const n = names.filter((name) => seatIds.some((id) => name.startsWith(`${id}-`))).length;
    if (n > 0) {
      log(
        `crew: ${n} worktrees of other sessions are in the old flat layout and stay readable until their runs end`,
      );
    }
  }

  /**
   * Review worktrees no active run owns (left by a crash, or by a run that ended while the hub
   * was down) are removed. Never throws.
   */
  async function sweepScratch(): Promise<void> {
    if (!crew) return;
    const list = (dir: string): string[] => {
      try {
        return readdirSync(dir);
      } catch (e) {
        // a session folder not made yet is not worth a line
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || dir === crew.worktrees) {
          log(`could not list ${dir}: ${errText(e)}`);
        }
        return [];
      }
    };
    for (const session of crew.sessions) {
      // a review worktree is in its session's folder, or flat if it was made before the folders
      const found = [crew.worktrees, join(crew.worktrees, session.id)].flatMap((dir) =>
        list(dir).map((name) => join(dir, name)),
      );
      for (const seat of [...session.seats]) {
        if (modeOfSeat(seat) !== "scratch") continue;
        const mine = `${seat.id}-review-`;
        for (const path of found) {
          const name = basename(path);
          if (!name.startsWith(mine) || !/^\d+$/.test(name.slice(mine.length))) continue;
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
    // after the worktrees above are gone: a private pnpm store outlives a worktree that was
    // removed some other way, and a crash leaves one behind
    try {
      const n = await sweepPnpmStores([
        crew.worktrees,
        ...crew.sessions.map((session) => join(crew.worktrees, session.id)),
      ]);
      if (n > 0) log(`crew: removed ${n} pnpm stores of worktrees that no longer exist`);
    } catch (e) {
      log(`could not sweep pnpm stores: ${errText(e)}`);
    }
  }

  /**
   * Revokes the token and frees the test-lock holds of a run whose process the hub does not
   * reattach, and removes its token files. Never throws.
   */
  function dropGrant(seatId: string, runId: string): void {
    try {
      deps.tokens.revoke(runId);
      deps.lock.releaseRun(runId);
      for (const p of [crewTokenPath(deps.dbPath, runId), crewMcpPath(deps.dbPath, runId)]) {
        rmSync(p, { force: true });
      }
    } catch (e) {
      log(`${seatId}: could not drop the grant of ${runId}: ${errText(e)}`);
    }
  }

  /**
   * Folds a run's transcript into its (still open) row, as Stop does for a run with no process, so
   * the end that follows keeps what the seat did while no hub was watching. Never throws a fold's
   * failure: the next read of the transcript (the backfill) has it.
   */
  function foldOpenRun(run: Run): ReturnType<typeof foldPath> {
    const r: Run = { ...run };
    let facts: ReturnType<typeof foldPath> = null;
    try {
      facts = foldPath(new Map(), run.transcriptPath, undefined, run.vendor);
      if (facts) applyFacts(r, facts);
      store.upsertRun(r, facts !== null);
      if (facts) persistDigest(store, digests, run.id, facts.digest);
    } catch (e) {
      log(`${run.agentId}: could not fold run ${run.id}: ${errText(e)}`);
    }
    return facts;
  }

  /** Held unended runs are recovered even after an error; stopped seats stay stopped. */
  function heldSessions(): SeatSessionRow[] {
    const rows = new Map(store.activeSeatSessions().map((row) => [row.seatId, row]));
    for (const { seatId } of store.liveSeatRuns()) {
      if (rows.has(seatId)) continue;
      const row = store.seatSession(seatId);
      if (row !== null) rows.set(seatId, row);
    }
    return [...rows.values()].filter((row) => row.state !== "stopped");
  }

  /**
   * Takes each active run's seat back after the lock is taken (spec §8b.2), once, in order. A seat
   * still running under its keeper is attached to: the lines it wrote meanwhile are replayed and
   * nothing is respawned or sent. A run whose CLI exited while no hub was attached is ended
   * `failed`. A run with no keeper (a reboot) is resumed with `--resume` in its own worktree; one
   * whose keeper speaks another version has the keeper ended first, so two CLIs never run one
   * session. A run that cannot be taken back is failed with the reason. One row's failure never
   * stops the others; a store that cannot list the runs is logged (the caller catches it, so no
   * rejection escapes).
   */
  function reattach(): Promise<void> {
    if (reattaching !== null) return reattaching;
    reattaching = (async () => {
      for (const row of heldSessions()) {
        if (stopping) return;
        await recoverSession(row);
      }
    })().finally(() => {
      reattaching = null;
    });
    return reattaching;
  }

  async function recoverSession(row: SeatSessionRow, retry = false): Promise<void> {
    // With no config write pending, claim recovery before start() returns to its caller.
    while (accountUpdate !== null) await accountUpdate;
    const current = store.seatSession(row.seatId);
    if (
      row.runId === null ||
      current?.runId !== row.runId ||
      current.state === "stopped" ||
      store.run(row.runId)?.endedAt !== null
    )
      return;
    row = current;
    const seat = findSeat(row.seatId)?.seat;
    const run = store.run(row.runId ?? "");

    const l = live.get(row.seatId);
    if (starting.has(row.seatId) || l?.session.alive || l?.ending != null) return;
    starting.add(row.seatId);
    try {
      if (l !== undefined) {
        fold(l);
        l.off();
        l.session.detach();
        live.delete(row.seatId);
      }
      const transfer = transferState(row.runId as string);
      if (seat && run) {
        const dir = crewKeeperDir(deps.dbPath, run.id);
        if (runBindingProblem(run, seat.accountId)) {
          if (!(await endKeeper(dir, keeperEndWait(), log))) return;
          dropGrant(row.seatId, run.id);
          setSeat(row.seatId, {
            state: "error",
            reason: "configured run account is missing or has a different provider",
          });
          return;
        }
        const denied = JSON.parse(store.getSetting(profilePolicyKey(run.id)) ?? "[]") as string[];
        if (profileDenies().some((profile) => !denied.includes(profile))) {
          if (!(await endKeeper(dir, keeperEndWait(), log))) return;
          dropGrant(row.seatId, run.id);
          if (
            deps.cliHold?.reason != null ||
            stopping ||
            seatUnavailable(seat, run.model ?? undefined, run.vendor ?? "claude")
          )
            return;
          if (!transfer?.pending) return await resumeOne(row);
        }
        if (seatUnavailable(seat, run.model ?? undefined, run.vendor ?? "claude")) return;
      }
      // Startup can attach a safe keeper while held; later retries only validate its safety.
      if (retry && deps.cliHold?.reason != null) return;
      if (transfer?.pending) {
        if (deps.cliHold?.reason != null) {
          log(`${row.seatId}: resume held: ${deps.cliHold.reason}`);
          return;
        }
        try {
          const moving = moveAccount(row.seatId, transfer);
          transfers.set(row.seatId, moving);
          try {
            await moving;
          } finally {
            transfers.delete(row.seatId);
          }
        } catch (e) {
          log(`${row.seatId}: account transfer recovery failed: ${errText(e)}`);
          setSeat(row.seatId, {
            state: "error",
            reason: "account transfer interrupted; run retained for recovery",
          });
        }
      } else await takeBack(row);
    } catch (e) {
      log(`${row.seatId}: could not resume: ${errText(e)}`);
      try {
        failResume(row, `${RESUME_FAILED}: ${cleanText(errText(e), STDERR_TEXT_MAX).trim()}`);
      } catch {
        // the store is failing too: already logged
      }
    } finally {
      starting.delete(row.seatId);
    }
  }

  async function resumeRun(runId: string): Promise<void> {
    if (!mayAct() || stopping) return;
    if (reattaching !== null) {
      // Discovery can finish while Claude recovery is still running; recover Codex after it.
      if (store.run(runId)?.vendor !== "codex") return;
      await reattaching;
    }
    if (!mayAct() || stopping) return;
    const run = store.run(runId);
    if (run === null || runGone(runId, run.agentId)) return;
    const row = store.seatSession(run.agentId);
    if (row !== null) await recoverSession(row, true);
  }

  function resumeDeferredRuns(): Promise<void> {
    if (recoveringDeferred !== null) return recoveringDeferred;
    recoveringDeferred = (async () => {
      if (reattaching !== null) await reattaching;
      if (!mayAct() || stopping || deps.cliHold?.reason != null) return;
      for (const runId of deferredRecoveries) {
        const run = store.run(runId);
        if (run === null || runGone(runId, run.agentId)) {
          deferredRecoveries.delete(runId);
          continue;
        }
        if (pausedSeat(store, run.agentId)) continue;
        await resumeRun(runId);
        if (live.get(run.agentId)?.session.alive || runGone(runId, run.agentId))
          deferredRecoveries.delete(runId);
      }
    })().finally(() => {
      recoveringDeferred = null;
    });
    return recoveringDeferred;
  }

  async function readOnlyCheckout(info: SeatInfo, row: SeatSessionRow, run: Run) {
    const path = row.worktree;
    if (path === null) throw new Error("no worktree recorded");
    return inClone(info.session.checkout, async () => {
      const checkout = await existingReadOnlyCheckout(info.session.checkout, path, run.branch);
      if (runGone(run.id, row.seatId)) throw new Error("run ended during checkout validation");
      if (run.branch !== null) {
        const current = store.run(run.id);
        if (current === null) throw new Error("run missing");
        store.upsertRun({ ...current, branch: null });
        run.branch = null;
      }
      return { branch: "", ...checkout };
    });
  }

  /** One active run's seat after a restart: attach to its keeper, record its end, or resume it. */
  async function takeBack(row: SeatSessionRow): Promise<void> {
    const runId = row.runId;
    if (runId === null) return;
    const dir = crewKeeperDir(deps.dbPath, runId);
    const cursor = store.keeperCursor(runId);
    let checkoutMissing = false;
    const info = findSeat(row.seatId);
    const run = store.run(runId);
    if (info && run?.endedAt === null && run.reviewId == null) {
      const def = seatDef(info.seat);
      if (def.mode === "read-only" && def.loop !== "plan") {
        try {
          await readOnlyCheckout(info, row, run);
        } catch {
          if (runGone(runId, row.seatId)) return;
          // Discover the keeper first: an exit keeps its reason; a missing keeper goes through resume.
          checkoutMissing = true;
        }
      }
    }
    if (runGone(runId, row.seatId) || stopping) return;
    const found = await attachSession({
      dir,
      // the cursor counts the lines of the keeper it was taken from; any other keeper is read from 0
      // Codex needs earlier item paths and unresolved requests even before the saved cursor.
      from: (h) => (row.vendor === "codex" ? 0 : cursor?.spawn === h.spawn ? cursor.line : 0),
      // A Claude keeper from before #798 never saw a `result` (the CLI does not print `type`
      // first), so it says a turn is open after every turn, and the seat would wait on it forever
      // (FLIGHT never woken). The transcript says whether the CLI is between turns. One gap: a
      // keeper whose transcript write failed holds later lines in memory only, so the file can end
      // at an older result while a turn runs. The seat then looks idle until the turn's next line
      // starts a turn again (a replayed one does at once).
      awaiting: (h) =>
        h.awaiting &&
        (row.vendor === "codex" ||
          h.parsedResults === true ||
          run === null ||
          !endsAtResult(run.transcriptPath)),
      raw: row.vendor === "codex",
      controlTimeoutMs: deps.controlTimeoutMs,
      stopGraceMs: deps.stopGraceMs,
      log,
    });
    // The attach awaited: the operator or the engine may have ended the run meanwhile. Whoever did
    // recorded the end and set the seat; nothing here may overwrite it.
    const moved = () => store.seatSession(row.seatId)?.runId !== runId;
    if (moved()) {
      // whoever ended the run found no process to end, so the run's token and holds are still here
      dropGrant(row.seatId, runId);
      if (found.kind === "attached") await found.session.close();
      // endRunByEngine may be ending this folder too (no live entry): same pids, forced removal
      await endAndRemoveKeeper(row.seatId, runId);
      return;
    }
    if (found.kind === "attached") {
      if (stopping) return found.session.detach();
      if (checkoutMissing) {
        dropGrant(row.seatId, runId);
        await found.session.close();
        if (runGone(runId, row.seatId)) return;
        return failResume(row, "could not resume: checkout missing");
      }
      // no await before the seat is tracked: the replay's first line must find its listeners
      return attachOne(row, runId, found.session, found.hello, cursor);
    }
    if (stopping) return;
    if (found.kind === "exited") {
      // The CLI exited while no hub was attached: the end is recorded as the exit path would.
      dropGrant(row.seatId, runId);
      const how = found.exit.code ?? found.exit.signal;
      const said = recentStderr(found.exit, found.exit.at)?.trim() ?? "";
      return failResume(
        row,
        how === null
          ? found.exit.endReason === null
            ? CANNOT_START
            : said
          : `process exited ${how}${said === "" ? "" : `: ${said}`}`,
        { exit: found.exit },
      );
    }
    // No keeper to attach to: a reboot took it, or it speaks a version this hub does not.
    if (found.version !== null) {
      log(`${row.seatId}: keeper speaks version ${found.version}; ending it before the resume`);
    }
    dropGrant(row.seatId, runId);
    if (deps.cliHold?.reason != null) {
      // the run stays active; the release of the hold resumes it
      log(`${row.seatId}: resume held: ${deps.cliHold.reason}`);
      return;
    }
    // Two CLIs must never run one session: the old keeper and its CLI are gone before the resume.
    const ended = await endKeeper(dir, keeperEndWait(), log);
    if (moved()) return;
    if (!ended) {
      log(`${row.seatId}: could not end the old keeper`);
      return failResume(row, `${RESUME_FAILED}: could not end the old keeper`);
    }
    return resumeOne(row);
  }

  /**
   * Takes over a seat whose CLI kept running under its keeper: no spawn, no resume and no "Carry
   * on" line (`resumedAt` stays null). The seat's turn state comes from the replay and the keeper's
   * `awaiting`; nothing is sent until the replay is in (`attached`).
   */
  async function attachOne(
    row: SeatSessionRow,
    runId: string,
    session: KeeperSession,
    hello: KeeperHello,
    cursor: KeeperCursor | null,
  ): Promise<void> {
    const info = findSeat(row.seatId);
    const run = store.run(runId);
    const refuse = async (reason: string) => {
      dropGrant(row.seatId, runId);
      await session.close();
      return failResume(row, reason, { record: reason !== RESUME_MODE_CHANGED });
    };
    if (info === undefined) return refuse("could not resume: seat removed");
    if (run === null) return refuse(`${RESUME_FAILED}: run missing`);
    // No branch is needed: nothing is checked out again (a watch or plan run has none).
    let refusal: string | null = null;
    if (run.endedAt !== null) {
      refusal = `${RESUME_FAILED}: run already ended`;
    } else if (row.cliSessionId === null) {
      refusal = `${RESUME_FAILED}: CLI session ID missing`;
    } else if ((modeOfSeat(info.seat) === "scratch") !== (run.reviewId != null)) {
      refusal = RESUME_MODE_CHANGED; // a scratch seat takes back only review runs
    }
    if (refusal !== null) return refuse(refusal);
    let developerInstructions = "";
    if (row.vendor === "codex") {
      try {
        if (row.worktree === null) return refuse(CANNOT_START);
        developerInstructions = readFileSync(crewPromptPath(deps.dbPath, runId), "utf8");
      } catch {
        return refuse(CANNOT_START);
      }
    }
    // restoreRuns has put the token back; this makes sure of it for a hub that did not run it
    try {
      deps.tokens.adopt(row.seatId, runId, readFileSync(crewTokenPath(deps.dbPath, runId), "utf8"));
    } catch (e) {
      log(`${row.seatId}: could not read the token of ${runId}: ${errText(e)}`);
    }
    let unblock = () => {};
    const chain = new Promise<void>((r) => {
      unblock = r;
    });
    let driver: CrewSession;
    try {
      driver =
        row.vendor === "codex"
          ? attachCodexSession(
              {
                from: cursor?.spawn === hello.spawn ? cursor.line : 0,
                threadId: row.cliSessionId as string,
                cwd: row.worktree as string,
                developerInstructions,
                model: resumeModel(info, run),
                outboxPath: join(crewCodexDir(deps.dbPath, run.id), CODEX_OUTBOX_FILE),
                effort: info.seat.effort ?? null,
                approve: codexApprover(info, run, row.worktree ?? ""),
                controlTimeoutMs: deps.controlTimeoutMs,
                log,
              },
              session,
            )
          : session;
    } catch (e) {
      return refuse(`${CANNOT_START}: ${errText(e)}`);
    }
    track(info, run, driver, grant(info, run), {
      spawn: hello.spawn,
      attaching: true,
      replayedBelow: hello.lines,
      awaitingAtAttach: hello.awaiting,
      inTurn: hello.awaiting,
      parkedTurn: hello.awaiting && row.state === "parked",
      rateLimitedUntil: cursor?.spawn === hello.spawn ? cursor.rateLimitedUntil : null,
      chain,
    });
    const off = driver.on((e) => {
      if (e.kind !== "attached" && e.kind !== "exit") return;
      off();
      unblock();
    });
  }

  /** The replay is in: the seat's state is what the keeper's lines say. */
  function onAttached(l: Live, awaiting: boolean): void {
    const seatId = l.info.seat.id;
    l.attaching = false;
    l.inTurn ||= awaiting;
    fold(l, true);
    saveCursor(l);
    const row = store.seatSession(seatId);
    if (row === null) return;
    if (row.state === "starting" && !awaiting && l.session.lines === 0) {
      // The hub went down before the brief was sent: the CLI has no conversation to continue.
      l.off();
      if (live.get(seatId) === l) live.delete(seatId);
      starting.add(seatId);
      void l.session
        .close()
        .then(() => failResume(row, `${RESUME_FAILED}: initial brief was not sent`))
        .finally(() => starting.delete(seatId));
      return;
    }
    if (!l.inTurn) emit({ kind: "idle", seatId, runId: l.run.id, resumed: false });
  }

  /** Records where in its keeper's output the hub has got to, for the next hub to replay from. */
  function saveCursor(l: Live): void {
    try {
      store.setKeeperCursor({
        runId: l.run.id,
        spawn: l.spawn,
        line: l.session.lines,
        rateLimitedUntil: l.rateLimitedUntil,
      });
    } catch (e) {
      log(`could not save the keeper cursor of ${l.run.id}: ${errText(e)}`);
    }
  }

  async function resumeOne(row: SeatSessionRow): Promise<void> {
    const info = findSeat(row.seatId);
    if (!info) return failResume(row, "could not resume: seat removed");
    const run = row.runId === null ? null : store.run(row.runId);
    if (run === null) return failResume(row, `${RESUME_FAILED}: run missing`);
    if (run.endedAt !== null) return failResume(row, `${RESUME_FAILED}: run already ended`);
    if (row.cliSessionId === null) {
      return failResume(row, `${RESUME_FAILED}: CLI session ID missing`);
    }
    if ((modeOfSeat(info.seat) === "scratch") !== (run.reviewId != null)) {
      return failResume(row, RESUME_MODE_CHANGED, { record: false }); // a scratch seat resumes only review runs
    }
    const def = seatDef(info.seat);
    const readOnly = def.mode === "read-only" && def.loop !== "plan";
    if (run.branch === null && run.reviewId == null && !readOnly && def.loop !== "watch") {
      return failResume(row, `${RESUME_FAILED}: no branch recorded for the run`);
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
      } else if (readOnly) {
        checkout = await readOnlyCheckout(info, row, run);
      } else if (run.branch !== null) {
        // still the clone's worktree, its git dirs not redirected, still on the run's branch
        checkout = await existingCheckout(info.session.checkout, row.worktree, run.branch);
      } else if (seatDef(info.seat).loop === "watch") {
        checkout = {
          branch: "",
          ...(await existingDetached(info.session.checkout, row.worktree)),
        };
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
      l = await checkedLaunch(info, run, row.cliSessionId, checkout, true, null);
    } catch (e) {
      log(`${row.seatId}: could not start: ${errText(e)}`);
      if (e instanceof SupervisorError && e.status === 409 && pausedSeat(store, row.seatId)) {
        deferredRecoveries.add(run.id);
        return;
      }
      return failResume(row, `${RESUME_FAILED}: ${CANNOT_START}`);
    }
    // Keep the error that the successful resume is about to replace in Activity.
    if (row.state === "error") {
      const why = row.reason ? `: ${row.reason}` : "";
      try {
        store.addAgentEvent({
          agentId: row.seatId,
          at: now(),
          from: row.state,
          to: "idle",
          text: `${HUD_STATE_LABEL[row.state]} → ${HUD_STATE_LABEL.idle}${why} (run #${run.seq} resumed)`,
        });
      } catch (e) {
        log(`${row.seatId}: could not record its previous state: ${errText(e)}`);
      }
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

  async function discard(l: Live): Promise<void> {
    fold(l);
    if (l.foldTimer !== undefined) clearTimeout(l.foldTimer);
    l.off();
    await l.session.close();
    if (live.get(l.info.seat.id) === l) live.delete(l.info.seat.id);
  }

  async function moveAccount(
    seatId: string,
    transfer: AccountTransfer,
  ): Promise<AccountTransferResult> {
    const refused = (reason: string): AccountTransferResult => ({ outcome: "refused", reason });
    const row = store.seatSession(seatId);
    const run = row?.runId == null ? null : store.run(row.runId);
    const info = findSeat(seatId);
    if (!info || !row || !run || !row.worktree || !row.cliSessionId || run.endedAt !== null)
      return refused("seat has no run to move");
    const target = config.accounts.find((a) => a.id === transfer.target);
    if (!target || target.vendor !== run.vendor) {
      if (!(await endKeeper(crewKeeperDir(deps.dbPath, run.id), keeperEndWait(), log)))
        return refused("old CLI process could not be safely ended");
      dropGrant(seatId, run.id);
      setSeat(seatId, {
        state: "error",
        reason: "transfer account is missing or has a different provider",
      });
      return refused("transfer account is missing or has a different provider");
    }
    const save = () => store.setSetting(transferKey(run.id), JSON.stringify(transfer));
    // A replaced keeper may already have receipted the previous continuation.
    // Its replacement needs a new delivery, while user-message IDs stay stable.
    const superseded = new Set(transfer.supersededContinuationIds ?? []);
    if (transfer.continuationId) superseded.add(transfer.continuationId);
    transfer.supersededContinuationIds = [...superseded];
    transfer.continuationId = randomUUID();
    const outboxPath = join(crewCodexDir(deps.dbPath, run.id), CODEX_OUTBOX_FILE);
    // A late source receipt can rewrite the file from its older in-memory queue.
    // Persist the snapshot before yielding, including across a hub restart.
    transfer.queued = [
      ...new Map<string, string>([
        ...(transfer.queued ?? []),
        ...(existsSync(outboxPath) ? JSON.parse(readFileSync(outboxPath, "utf8")) : []),
      ]),
    ].filter(([id]) => id !== transfer.handoffId && !superseded.has(id));
    save();
    const old = live.get(seatId);
    if (old) {
      await old.chain;
      await discard(old);
    } else {
      if (
        !(await endKeeper(
          crewKeeperDir(deps.dbPath, run.id),
          deps.stopGraceMs ?? STOP_GRACE_MS,
          log,
        ))
      )
        return refused("old CLI process could not be safely ended; run retained for recovery");
    }
    dropGrant(seatId, run.id);
    if (stopping) return refused(SHUTTING_DOWN);
    const sourceSessionId = row.cliSessionId;
    const checkout =
      run.reviewId != null
        ? {
            branch: "",
            ...(await existingScratch(
              info.session.checkout,
              row.worktree,
              store.review(run.reviewId)?.sha ?? "",
            )),
          }
        : run.branch === null
          ? { branch: "", ...(await existingDetached(info.session.checkout, row.worktree)) }
          : await existingCheckout(info.session.checkout, row.worktree, run.branch);
    if (stopping || runGone(run.id, seatId)) return refused(SHUTTING_DOWN);
    const mergeOutbox = (handoff = false) => {
      const entries = existsSync(outboxPath)
        ? new Map<string, string>(JSON.parse(readFileSync(outboxPath, "utf8")))
        : new Map<string, string>();
      for (const id of superseded) entries.delete(id);
      for (const [id, text] of transfer.queued ?? []) entries.set(id, text);
      if (!handoff)
        entries.set(
          transfer.continuationId as string,
          "Continue your work after the account transfer.",
        );
      else entries.delete(transfer.continuationId as string);
      if (handoff) {
        if (transfer.handoffSessionId !== sourceSessionId) {
          transfer.handoffId = randomUUID();
          transfer.handoffSessionId = sourceSessionId;
        }
        const current = store.run(run.id) ?? run;
        const queued = [...entries];
        entries.clear();
        entries.set(
          transfer.handoffId as string,
          transferBrief({
            call: call(info),
            ticket: run.ticket,
            title: run.ticketTitle ?? null,
            branch: run.branch,
            summary: current.summary,
            plan: current.latestPlan ?? null,
          }),
        );
        for (const [id, text] of queued) if (id !== transfer.handoffId) entries.set(id, text);
      }
      // The keeper receipts survive both a refused resume and a hub restart.
      if (existsSync(run.transcriptPath)) {
        for (const line of readFileSync(run.transcriptPath, "utf8").split("\n")) {
          try {
            const receipt = JSON.parse(line);
            if (receipt.type === CODEX_DELIVERY) entries.delete(receipt.id);
          } catch {
            // A partial final transcript line has no receipt yet.
          }
        }
      }
      mkdirSync(crewCodexDir(deps.dbPath, run.id), { recursive: true, mode: 0o700 });
      writePrivate(outboxPath, JSON.stringify([...entries]));
      transfer.queued = [...entries].filter(([id]) => id !== transfer.handoffId);
      save();
    };
    let launched: Live | undefined;
    const attempt = async (accountId: string, resume: boolean): Promise<Live | null> => {
      const bound = { ...info, seat: seatForAccount(info.seat, accountId) };
      try {
        mergeOutbox(!resume);
        launched = await checkedLaunch(
          bound,
          store.run(run.id) ?? run,
          sourceSessionId,
          checkout,
          resume,
          null,
          "",
          true,
        );
        await launched.session.ready;
        if (launched.session.alive) return launched;
      } catch (e) {
        log(`${seatId}: account transfer launch failed: ${errText(e)}`);
      }
      if (launched) await discard(launched);
      launched = undefined;
      return null;
    };
    let outcome: "resumed" | "fresh" = "resumed";
    let moved = await attempt(transfer.target, true);
    if (!moved && !stopping) {
      outcome = "fresh";
      moved = await attempt(transfer.target, false);
    }
    if (stopping) return refused(SHUTTING_DOWN);
    if (!moved) {
      transfer.target = transfer.source;
      // A failed fresh start must not deliver its handoff to the recovered source.
      if (transfer.handoffId && existsSync(outboxPath)) {
        const entries = new Map<string, string>(JSON.parse(readFileSync(outboxPath, "utf8")));
        entries.delete(transfer.handoffId);
        writePrivate(outboxPath, JSON.stringify([...entries]));
      }
      save();
      moved = await attempt(transfer.source, true);
      transfer.pending = false;
      delete transfer.queued;
      save();
      if (!moved) {
        setSeat(seatId, {
          state: "error",
          reason: "account transfer failed; source resume failed; run retained",
        });
        return refused("account transfer failed; source resume failed; run retained for recovery");
      }
      setSeat(seatId, { state: "idle", reason: null });
      return refused("account transfer failed; source session recovered");
    }
    transfer.pending = false;
    delete transfer.queued;
    save();
    if (!moved.inTurn) setSeat(seatId, { state: "idle", reason: null });
    emit({ kind: "idle", seatId, runId: run.id, resumed: outcome === "resumed" });
    return { outcome };
  }

  async function transferAccount(
    seatId: string,
    accountId: string,
  ): Promise<AccountTransferResult> {
    const refused = (reason: string): AccountTransferResult => ({ outcome: "refused", reason });
    const info = need(seatId);
    refuseWhileHeld();
    if (starting.has(seatId) || transfers.has(seatId)) return refused("seat is busy");
    const row = store.seatSession(seatId);
    const run = row?.runId == null ? null : store.run(row.runId);
    if (!run || run.endedAt !== null || row?.cliSessionId == null || row.worktree === null)
      return refused("seat has no run to move");
    if ((modeOfSeat(info.seat) === "scratch") !== (run.reviewId != null))
      return refused("seat mode changed; run cannot be transferred");
    const source = config.accounts.find((a) => a.id === info.seat.accountId);
    const target = config.accounts.find((a) => a.id === accountId);
    if (!source || !target) return refused("unknown account");
    if (target.vendor !== source.vendor || target.vendor !== (run.vendor ?? "claude"))
      return refused("destination must use the same provider");
    if (target.id === source.id) return refused("destination uses the same login");
    if (target.vendor !== "codex")
      return refused("provider cannot isolate an independently logged-in CLI profile");
    const problem = accountBindingProblem([source, target]);
    if (problem !== null) return refused(problem);
    if (live.get(seatId)?.ending != null) return refused("seat is ending");
    const transfer: AccountTransfer = { source: source.id, target: target.id, pending: true };
    store.setSetting(transferKey(run.id), JSON.stringify(transfer));
    starting.add(seatId);
    const moving = moveAccount(seatId, transfer)
      .catch((e: unknown) => {
        log(`${seatId}: account transfer failed: ${errText(e)}`);
        setSeat(seatId, {
          state: "error",
          reason: "account transfer interrupted; run retained for recovery",
        });
        return refused("account transfer interrupted; run retained for recovery");
      })
      .finally(() => {
        transfers.delete(seatId);
        starting.delete(seatId);
      });
    transfers.set(seatId, moving);
    return moving;
  }

  async function startRun(
    seatId: string,
    issue: number,
    opts?: { loop?: RunLoop; override?: ProfileOverride; flight?: boolean; operator?: boolean },
  ) {
    const info = need(seatId);
    const unavailable = seatUnavailable(info.seat);
    if (unavailable) throw new SupervisorError(409, unavailable);
    refuseWhileHeld();
    if (info.seat.retiring) throw new SupervisorError(409, retiringText(call(info)));
    const def = seatDef(info.seat);
    const planner = def.loop === "plan";
    const readOnly = def.mode === "read-only" && !planner;
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
    const waiting = store.asideRuns();
    const ref = `${info.repo.id}#${issue}`;
    const inReview = !readOnly
      ? waiting.find(
          (r) =>
            r.ticket === ref &&
            r.agentId === seatId &&
            r.loop?.phase === "review" &&
            r.loop.parked == null,
        )
      : undefined;
    const rework = wakeDueAsideRun(store, seatId);
    // Rework still goes first, except for the ticket explicitly being resumed.
    if (rework && rework.id !== inReview?.id) {
      throw new SupervisorError(409, reworkFirstText(call(info), rework.ticket ?? rework.id));
    }
    // An explicit start of a ticket in review means resume that ticket's own preserved run.
    // `wakeRun` retains its worktree and session guards, rather than creating a competing run.
    if (inReview !== undefined) {
      const branch = inReview.branch;
      if (branch === null) throw new SupervisorError(409, NOT_ASIDE);
      await wakeRun(inReview.id, { reviewResume: true });
      return { runId: inReview.id, branch };
    }
    if (!readOnly && waiting.some((r) => r.ticket === ref)) {
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
      // Every way a run starts ends here: the one eligibility check, before a worktree or a claim.
      const board = store.board(info.repo.id);
      const card = board.find((i) => i.issueNumber === issue);
      if (card === undefined) throw new SupervisorError(422, notOnBoardText(ref));
      const rules = await deps.rules(info.repo.id);
      if (rules instanceof RepoRulesError) throw new SupervisorError(502, START_NO_RULES);
      const profiles = deps.profiles?.() ?? DEFAULT_PROFILES;
      const chosen = chooseRunProfile(
        profiles,
        ticket.labels,
        card.size,
        opts?.override ?? store.profileOverride(info.repo.id, issue),
      );
      if ("refusal" in chosen) {
        throw new SupervisorError(profiles instanceof Error ? 502 : 422, chosen.refusal);
      }
      const away = activeAway(store, now(), config.operator.timezone);
      if (
        away &&
        !opts?.operator &&
        (accountAtStop(config, store, info.seat.accountId, now()) ||
          awayQuotaUnknown(config, store, info.seat.accountId, now()) ||
          awayQuotaReserve(config, store, info.seat.accountId, now()))
      ) {
        throw new SupervisorError(422, AWAY_QUOTA_REFUSED);
      }
      // A detached reader does not compete for the ticket or its assignee.
      const refusal = eligibleToStart({
        ...(away && !opts?.operator
          ? { away: { pickUp: away.may.pickUp, flight: opts?.flight === true } }
          : {}),
        repoId: info.repo.id,
        issue,
        card: {
          labels: ticket.labels,
          assignees: readOnly ? [] : (card.assignees ?? []),
          blockedBy: card.blockedBy,
          size: card.size,
          status: card.status,
          state: card.state,
          closed: card.closed,
        },
        rules,
        seat: { call: call(info), area: info.seat.area, loop: def.loop },
        login: deps.login(),
        hasRun:
          !readOnly &&
          (store.activeTickets().has(ref) ||
            store
              .staleTakes(Number.POSITIVE_INFINITY)
              .some((r) => r.repoId === info.repo.id && r.issue === issue && r.seatId !== seatId)),
        lane: config.crew?.lane,
        laneDefault: config.crew?.laneDefault ?? false,
        body: ticket.body,
        closed: (n) => board.find((i) => i.issueNumber === n)?.closed,
        waits: waitReader(store, info.repo.id)(card),
      });
      if (refusal !== null) throw new SupervisorError(422, refusal);
      // Files the ticket lists outside the seat's area (or that a protected-file rule covers) are
      // written only on FLIGHT's logged approval; the run holds exactly those.
      const grants: string[] = [];
      if (def.mode === "writer" && !planner) {
        const extra = info.repo.protectedFiles ?? [];
        for (const p of ticketPathGrants(ticket.body)) {
          const why = pathGrantProblem(p, extra);
          if (why !== null) throw new SupervisorError(422, grantUngrantableText(p, why));
          if (!pathInArea(info.seat.area, p) || isProtectedPath(p, extra)) grants.push(p);
        }
        const approved = approvedPaths(store, ref);
        const unapproved = grants.filter((p) => !approved.includes(p));
        if (unapproved.length > 0)
          throw new SupervisorError(422, grantRefusedText(ref, unapproved));
      }
      // only a build run works from the ticket's plan; planner and review runs record none
      const plan: RunPlan | undefined =
        def.loop !== "build"
          ? undefined
          : hasPlanSection(ticket.body)
            ? (store.ticketPlan(info.repo.id, ref) ?? { by: null, at: null, ref })
            : card.size !== null && !PLAN_SIZES.includes(card.size)
              ? { skipped: `Size ${card.size}` }
              : undefined;
      const title = ticket.title;
      // A CheckoutError goes out as it is: the route answers it with its own status (R26).
      // The repo's CLAUDE.md and index as origin's default branch has them, never the worktree.
      const { checkout, repoDocs, references } = await inClone(info.session.checkout, async () => {
        const where = {
          checkout: info.session.checkout,
          worktreesRoot: crew?.worktrees ?? "",
          sessionId: info.session.id,
          seatId,
          issue,
          peers: clonePeers(deps.config, deps.hubRoot),
        };
        const c = planner
          ? await preparePlanCheckout(where)
          : readOnly
            ? await prepareReadOnlyCheckout(where)
            : await prepareCheckout({
                ...where,
                title,
                pending: {
                  isPending: (path) => store.checkoutPending(path),
                  markPending: (path) => store.markCheckoutPending(path, now()),
                  clearPending: (path) => store.clearCheckoutPending(path),
                },
              });
        return {
          checkout: c,
          repoDocs: await readRepoDocsAndSkills(info.session.checkout, c.baseSha),
          references: await repoReferenceIndex(info.session.checkout, c.baseSha),
        };
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

      const on = await startedOn(info);
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
        vendor: isCodex(info) ? "codex" : "claude",
        model: info.seat.model,
        accountId: info.seat.accountId,
        effort: info.seat.effort ?? null,
        loopKind: def.loop,
        ...on,
        branch: planner || readOnly ? null : checkout.branch,
        ticket:
          planner || readOnly
            ? `${info.repo.id}#${issue}`
            : (inferTicket(checkout.branch, info.repo.id) ?? `${info.repo.id}#${issue}`),
        ticketTitle: title,
        costUsd: null,
        tokens: null,
        transcriptPath: crewTranscriptPath(deps.dbPath, runId),
        prs: [],
        summary: null,
        ...(opts?.loop
          ? {
              loop: {
                ...opts.loop,
                // a ticket that lists a controller check needs the controller's pass, whatever it says later
                ...(ticketControllerCheck(ticket) === null
                  ? {}
                  : { controllerCheckRequired: true }),
              },
            }
          : {}),
        profile: { ...chosen, hash: profileHash(chosen.profile) },
        ...(plan === undefined ? {} : { plan }),
      };
      if (opts?.override) store.setProfileOverride(info.repo.id, issue, opts.override, startedAt);
      store.upsertRun(run);
      setRunPathGrants(store, runId, grants);
      // the lines report_evidence will hold the seat to, as the ticket words them now
      if (def.loop === "build" && !readOnly)
        store.setRunDoneWhen(runId, doneWhenItems(ticket.body));
      if ((checkout.leftoverChanges?.length ?? 0) > 0) {
        store.addLoopEvent(
          `${runId}:leftover-changes`,
          runId,
          `started on a worktree with ${checkout.leftoverChanges?.length} uncommitted files`,
          startedAt,
        );
      }
      let installNote: string | undefined;
      const synced = await inClone(info.session.checkout, async () => {
        const result = await syncReusedWorktree(info.session.checkout, checkout, {
          syncMain: opts?.loop !== undefined,
        });
        if (result?.kind === "merged") {
          store.addRunCommit({
            runId,
            repoId: info.repo.id,
            branch: checkout.branch,
            sha: result.sha,
            at: startedAt,
          });
          store.addLoopEvent(
            `${runId}:update:${result.sha}`,
            runId,
            mergedMainText(checkout.baseSha),
            startedAt,
          );
          installNote = await installAfterSync(
            info.session.checkout,
            checkout,
            result.before,
            crew?.worktrees ?? "",
          );
          if (installNote) {
            log(`${seatId}: ${installNote}`);
            store.addLoopEvent(
              `${runId}:update-install:${result.sha}`,
              runId,
              installNote,
              startedAt,
            );
          }
        } else if (result?.kind === "conflict") {
          const loop = store.run(runId)?.loop;
          if (loop) {
            run.loop = { ...loop, mainMerge: { mainSha: result.mainSha, files: result.files } };
            store.setRunLoop(runId, run.loop);
          }
          store.claimLine(conflictKey(runId, result.mainSha), {
            runId,
            seatId,
            origin: "engine",
            text: conflictText(result.files),
            at: startedAt,
          });
          store.addLoopEvent(
            `${runId}:update-conflict:${result.mainSha}`,
            runId,
            mainConflictText(result.mainSha, result.files.length),
            startedAt,
          );
        } else if (result?.kind === "skipped") {
          log(`${seatId}: main not brought into the reused worktree (${result.why})`);
        }
        return result;
      });
      let brief = ticketBrief({
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
        branch: readOnly && checkout.branch === "" ? NO_BRANCH_YET : checkout.branch,
        area: info.seat.area,
        granted: grants,
        commands:
          def.mode === "writer"
            ? (info.repo.commands?.writer ?? [])
            : (info.repo.commands?.review ?? []),
        fullSuite: info.repo.fullSuite ?? [],
        leftoverChanges: checkout.leftoverChanges,
        ...(run.profile ? { profile: run.profile } : {}),
        ...(def.loop === "build" && plan === undefined ? { planless: true } : {}),
        ...(Array.isArray(profiles) ? { profileNames: profiles.map((p) => p.name) } : {}),
      });
      if (installNote) brief += `\n\n${installNote}`;
      if (synced?.kind === "conflict") brief += `\n\n${conflictText(synced.files)}`;
      const briefPieces = [
        ticketPiece(
          ticket.body,
          cutNoteText(ticket.body, ticket.bodyTruncated, ticket.bodyLength ?? ticket.body.length),
        ),
      ];
      const inbox = withInbox(seatId, runId, brief);
      brief = inbox.text;
      let l: Live;
      try {
        l = await checkedLaunch(
          info,
          run,
          cliSessionId,
          checkout,
          false,
          repoDocs,
          references,
          false,
          undefined,
          (system) => recordPromptVersion(run, def.prompt, brief, briefPieces, system),
        );
      } catch (e) {
        log(`${seatId}: could not start: ${errText(e)}`);
        const at = now();
        store.upsertRun({ ...run, endedAt: at, status: "failed" });
        store.setRunEnded(runId, at, "failed", "exit");
        removeRunFiles(runId);
        setSeat(seatId, {
          runId,
          cliSessionId,
          vendor: run.vendor,
          state: "error",
          reason: e instanceof SeatGitError ? `${CANNOT_START}: ${e.message}` : CANNOT_START,
          worktree: checkout.path,
        });
        emit({ kind: "run-ended", seatId, runId, endedBy: "exit" });
        if (e instanceof SupervisorError && e.status === 409) {
          setSeat(seatId, {
            runId: null,
            cliSessionId: null,
            state: "idle",
            reason: e.message,
            worktree: null,
          });
          throw e;
        }
        throw new SupervisorError(
          500,
          e instanceof SeatGitError ? `${CANNOT_START}: ${e.message}` : CANNOT_START,
          { cause: e },
        );
      }
      const session = l.session;
      setSeat(seatId, {
        runId,
        cliSessionId,
        vendor: run.vendor,
        state: "starting",
        reason: null,
        worktree: checkout.path,
      });
      // The keeper starts the CLI and reports a failure (no such command, a bad cwd) once it has
      // answered. The Codex handshake also confirms its seat floor: do not even put a brief in
      // its outbox until that confirmation has succeeded.
      await session.ready;
      if (!session.alive) {
        await session.close();
        throw new SupervisorError(500, CANNOT_START);
      }
      // The CLI prints nothing (not even init) until its first line: the brief goes at once.
      await enqueue(l, () => {
        writeLine(l, brief);
        markInboxRead(seatId, inbox);
      }).catch(() => {});
      return { runId, branch: checkout.branch };
    } finally {
      starting.delete(seatId);
    }
  }

  async function startWatch(
    seatId: string,
    opts?: { first?: string; firstPieces?: readonly PromptPiece[] },
  ): Promise<{ runId: string }> {
    const info = need(seatId);
    const def = seatDef(info.seat);
    const unavailable = seatUnavailable(info.seat);
    if (unavailable) throw new SupervisorError(409, unavailable);
    refuseWhileHeld();
    if (def.loop !== "watch") {
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
      const { checkout, repoDocs, references } = await inClone(info.session.checkout, async () => {
        const c = await prepareDetachedCheckout({
          checkout: info.session.checkout,
          worktreesRoot: crew?.worktrees ?? "",
          sessionId: info.session.id,
          name: watchCheckoutName(seatId),
          peers: clonePeers(deps.config, deps.hubRoot),
        });
        return {
          checkout: c,
          repoDocs: await readRepoDocsAndSkills(info.session.checkout, c.baseSha),
          references: await repoReferenceIndex(info.session.checkout, c.baseSha),
        };
      });
      if (stopping) throw new SupervisorError(409, SHUTTING_DOWN);

      const on = await startedOn(info);
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
        vendor: isCodex(info) ? "codex" : "claude",
        model: info.seat.model,
        accountId: info.seat.accountId,
        effort: info.seat.effort ?? null,
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
      const first = opts?.first;
      const brief = watchBrief({
        call: call(info),
        repo: info.repo.github,
        seats: info.session.seats
          .filter((s) => seatDef(s).mode === "writer")
          .map((s) => ({ call: seatCallSign(s.id), area: s.area })),
        fullSuite: info.repo.fullSuite ?? [],
      });
      const inbox = withInbox(
        seatId,
        runId,
        first !== undefined && first.trim() !== "" ? `${brief}\n\n${first}` : brief,
      );
      const firstBrief = inbox.text;
      let l: Live;
      try {
        l = await checkedLaunch(
          info,
          run,
          cliSessionId,
          { path: checkout.path, branch: "", gitDir: checkout.gitDir },
          false,
          repoDocs,
          references,
          false,
          undefined,
          (system) =>
            recordPromptVersion(run, def.prompt, firstBrief, opts?.firstPieces ?? [], system),
        );
      } catch (e) {
        log(`${seatId}: could not start: ${errText(e)}`);
        const at = now();
        store.upsertRun({ ...run, endedAt: at, status: "failed" });
        store.setRunEnded(runId, at, "failed", "exit");
        removeRunFiles(runId);
        setSeat(seatId, {
          runId,
          cliSessionId,
          vendor: run.vendor,
          state: "error",
          reason: e instanceof SeatGitError ? `${CANNOT_START}: ${e.message}` : CANNOT_START,
          worktree: checkout.path,
        });
        emit({ kind: "run-ended", seatId, runId, endedBy: "exit" });
        if (e instanceof SupervisorError && e.status === 409) {
          setSeat(seatId, {
            runId: null,
            cliSessionId: null,
            state: "idle",
            reason: e.message,
            worktree: null,
          });
          throw e;
        }
        throw new SupervisorError(
          500,
          e instanceof SeatGitError ? `${CANNOT_START}: ${e.message}` : CANNOT_START,
          { cause: e },
        );
      }
      const session = l.session;
      setSeat(seatId, {
        runId,
        cliSessionId,
        vendor: run.vendor,
        state: "starting",
        reason: null,
        worktree: checkout.path,
      });
      await session.ready;
      if (!session.alive) {
        await session.close();
        throw new SupervisorError(500, CANNOT_START);
      }
      await enqueue(l, () => {
        writeLine(l, firstBrief);
        markInboxRead(seatId, inbox);
      }).catch(() => {});
      return { runId };
    } finally {
      starting.delete(seatId);
    }
  }

  async function startReview(seatId: string, reviewId: number): Promise<{ runId: string }> {
    const info = need(seatId);
    const def = seatDef(info.seat);
    const unavailable = seatUnavailable(info.seat);
    if (unavailable) throw new SupervisorError(409, unavailable);
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
      const head = store.runPush(author.id)?.sha ?? null;
      if (
        author.repoId !== info.repo.id ||
        issue === null ||
        (head !== review.sha &&
          (head === null ||
            carriedFrom(author.loop?.carry, author.loop?.reviewWaivedSha, head) !== review.sha))
      ) {
        throw notWanted;
      }
      try {
        assertScratchStorage(
          join(crew?.worktrees ?? "", info.session.id, scratchName(seatId, reviewId)),
          dirname(deps.dbPath),
        );
      } catch (e) {
        throw new SupervisorError(409, (e as Error).message, { cause: e });
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
      const card = store.board(info.repo.id).find((i) => i.issueNumber === issue);
      // a Claude full-depth profile wins; a Codex seat always keeps its configured model
      const model =
        author.profile?.profile.reviewer.depth === "full"
          ? isCodex(info)
            ? info.seat.model
            : REVIEW_FULL_MODEL
          : info.seat.lightModel !== undefined &&
              reviewDepth({ labels: ticket.labels, size: card?.size ?? null }) === "light"
            ? info.seat.lightModel
            : info.seat.model;

      const checkout = info.session.checkout;
      const prev =
        store
          .reviewsOfRun(author.id)
          .filter((r) => r.id < reviewId && r.epoch === review.epoch && r.state === "reported")
          .at(-1) ?? null;
      // A CheckoutError goes out as it is: the route answers it with its own status.
      const { scratch, inputs, repoDocs, references } = await inClone(checkout, async () => {
        const s = await prepareScratch({
          checkout,
          worktreesRoot: crew?.worktrees ?? "",
          sessionId: info.session.id,
          seatId,
          reviewId,
          sha: review.sha,
          peers: clonePeers(deps.config, deps.hubRoot),
        });
        try {
          return {
            scratch: s,
            inputs: await writeReviewInputs(checkout, s, review.sha, prev?.sha ?? null),
            repoDocs: await readRepoDocsAndSkills(checkout, s.baseSha),
            references: await repoReferenceIndex(checkout, s.baseSha),
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

      const on = await startedOn(info);
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
        vendor: isCodex(info) ? "codex" : "claude",
        model,
        accountId: info.seat.accountId,
        effort: info.seat.effort ?? null,
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
      if (inputs.changedSince !== null) store.setReviewChangedSince(reviewId, inputs.changedSince);
      const touches = author.loop?.touches;
      const evidence = store.evidenceNotes(author.id);
      const prevReply =
        prev === null
          ? null
          : (evidence.filter((e) => e.at >= (prev.endedAt ?? 0)).at(-1)?.note ?? null);
      let brief = reviewBrief({
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
        notes: evidence.map((e) => e.note),
        doneWhen: evidence.at(-1)?.doneWhen ?? [],
        prevSha: prev?.sha ?? null,
        prevReviewId: prev?.id ?? null,
        prevFindings: prev
          ? store.findingsOf(prev.id).filter((f) => BLOCKING_SEVERITIES.includes(f.severity))
          : [],
        prevReply,
        diffCut: inputs.diffCut,
        since: inputs.since,
        touches: touches?.sha === review.sha ? touches.paths : [],
        commands: info.repo.commands?.review ?? [],
        fullSuite: info.repo.fullSuite ?? [],
      });
      const briefPieces = [
        ticketPiece(
          ticket.body,
          cutNoteText(ticket.body, ticket.bodyTruncated, ticket.bodyLength ?? ticket.body.length),
        ),
      ];
      const inbox = withInbox(seatId, runId, brief);
      brief = inbox.text;
      let l: Live;
      try {
        l = await checkedLaunch(
          info,
          run,
          cliSessionId,
          { path: scratch.path, branch: "", gitDir: scratch.gitDir },
          false,
          repoDocs,
          references,
          false,
          undefined,
          (system) => recordPromptVersion(run, def.prompt, brief, briefPieces, system),
        );
      } catch (e) {
        log(`${seatId}: could not start: ${errText(e)}`);
        const at = now();
        store.upsertRun({ ...run, endedAt: at, status: "failed" });
        store.setRunEnded(runId, at, "failed", "exit");
        removeRunFiles(runId);
        setSeat(seatId, {
          runId,
          cliSessionId,
          vendor: run.vendor,
          state: "error",
          reason: e instanceof SeatGitError ? `${CANNOT_START}: ${e.message}` : CANNOT_START,
          worktree: scratch.path,
        });
        emit({ kind: "run-ended", seatId, runId, endedBy: "exit" });
        await dropScratch(info, runId, seq, scratch.path);
        if (e instanceof SupervisorError && e.status === 409) {
          setSeat(seatId, {
            runId: null,
            cliSessionId: null,
            state: "idle",
            reason: e.message,
            worktree: null,
          });
          throw e;
        }
        throw new SupervisorError(
          500,
          e instanceof SeatGitError ? `${CANNOT_START}: ${e.message}` : CANNOT_START,
          { cause: e },
        );
      }
      const session = l.session;
      setSeat(seatId, {
        runId,
        cliSessionId,
        vendor: run.vendor,
        state: "starting",
        reason: null,
        worktree: scratch.path,
      });
      await session.ready;
      if (!session.alive) {
        await session.close();
        throw new SupervisorError(500, CANNOT_START);
      }
      await enqueue(l, () => {
        writeLine(l, brief);
        markInboxRead(seatId, inbox);
      }).catch(() => {});
      return { runId };
    } finally {
      starting.delete(seatId);
    }
  }

  async function endRun(seatId: string, opts: { hold?: boolean } = {}): Promise<void> {
    if (transfers.has(seatId)) await transfers.get(seatId);
    const info = need(seatId);
    // FLIGHT's seat is never dealt a ticket: ending it always benches it, or the watch restarts it
    const hold = opts.hold ?? seatDef(info.seat).loop === "watch";
    const l = live.get(seatId);
    if (l) {
      if (hold) l.hold = true;
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
        facts = foldPath(new Map(), run.transcriptPath, undefined, run.vendor);
        if (facts) applyFacts(ended, facts);
      } catch {
        facts = null;
      }
      store.upsertRun(ended, facts !== null);
      if (facts) persistDigest(store, digests, run.id, facts.digest);
      store.setRunEnded(run.id, at, "ok", "operator");
      removeRunFiles(run.id);
    }
    setSeat(seatId, { state: hold ? "stopped" : "idle", reason: null, runId: null });
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

  /** Ends a run set aside in review: no process, no seat; its worktree is all it holds. */
  async function endAside(
    run: Run,
    info: SeatInfo,
    worktree: string,
    endedBy: Exclude<EndedBy, "exit">,
  ): Promise<void> {
    const at = now();
    store.upsertRun({ ...run, endedAt: at, status: "ok" });
    store.setRunEnded(run.id, at, "ok", endedBy);
    removeRunFiles(run.id);
    transcripts.delete(run.transcriptPath);
    digests.delete(run.id);
    emit({ kind: "run-ended", seatId: run.agentId, runId: run.id, endedBy });
    await dropScratch(info, run.id, run.seq, worktree);
  }

  async function endRunByEngine(runId: string, reason?: "superseded"): Promise<void> {
    if (!mayAct()) return;
    const moving = transfers.get(store.run(runId)?.agentId ?? "");
    if (moving) await moving;
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
        await endAside(run, info, aside.worktree, reason ?? "engine");
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
    store.setRunEnded(runId, at, "ok", reason ?? "engine");
    removeRunFiles(runId);
    let closing: Promise<void> | null = null;
    if (l && l.run.id === runId) {
      l.endedBy = "engine";
      l.run = { ...l.run, endedAt: at, status: "ok" };
      closing = l.ending ??= closeLive(l);
    } else {
      // No process here (a take-back that left the run with no session, #798): the run's token
      // is revoked and a keeper that lives on is ended before the seat is freed. A keeper that
      // will not end is said in a blocked note: its CLI may still be running beside the seat's
      // next run. (A take-back finishing now may end the same folder too: the same pids, and
      // the folder's removal is forced, so the second does nothing.)
      dropGrant(seatId, runId);
      if (!(await endAndRemoveKeeper(seatId, runId))) {
        try {
          store.raiseNote({
            key: `cleanup:${runId}`,
            kind: "blocked",
            runId,
            seatId,
            repoId: info.repo.id,
            text: `${call(info)}'s run #${run.seq} was ended, but its CLI could not be stopped and may still be running; stop it by hand (its keeper folder is ${crewKeeperDir(deps.dbPath, runId)}).`,
            at: now(),
          });
          bus.emit("attention");
        } catch (e) {
          log(`${seatId}: could not record the cleanup note: ${errText(e)}`);
        }
      }
      removeRunFiles(runId);
    }
    setSeat(seatId, { state: "idle", reason: null, runId: null });
    closeRunItems(info);
    await closing;
    if (l && live.get(seatId) === l) live.delete(seatId);
    // Closing can replay late turn events; the engine's final seat state must stand.
    setSeat(seatId, { state: "idle", reason: null, runId: null });
    emit({ kind: "run-ended", seatId, runId, endedBy: "engine" });
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
    // In the seat's chain, behind any line already queued for it.
    return enqueue(l, async () => {
      // that line may have started a turn, or the run may be ending: it is not set aside then
      if (l.inTurn || l.ending !== null || live.get(seatId) !== l || !l.session.alive) return null;
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
    });
  }

  /** The operator ends a run set aside in review: no CLI is woken, the seat is left as it is. */
  async function endAsideRun(runId: string): Promise<void> {
    const run = store.run(runId);
    const aside = run?.endedAt === null ? run.loop?.aside : null;
    if (run === null || !aside) throw new SupervisorError(409, NOT_ASIDE);
    const info = need(run.agentId);
    if (stopping) throw new SupervisorError(409, SHUTTING_DOWN);
    // a wake, or another run starting, holds the seat
    if (starting.has(run.agentId)) throw new SupervisorError(409, seatBusyText(call(info)));
    if (
      live.get(run.agentId)?.run.id === runId ||
      store.seatSession(run.agentId)?.runId === runId
    ) {
      throw new SupervisorError(409, NOT_ASIDE);
    }
    await endAside(run, info, aside.worktree, "operator");
  }

  async function wakeRun(runId: string, options: { reviewResume?: boolean } = {}): Promise<void> {
    const run = store.run(runId);
    const aside = run?.endedAt === null ? run.loop?.aside : null;
    if (run === null || !aside) throw new SupervisorError(409, NOT_ASIDE);
    const seatId = run.agentId;
    const info = need(seatId);
    const unavailable = seatUnavailable(info.seat, run.model ?? undefined, run.vendor ?? "claude");
    if (unavailable) throw new SupervisorError(409, unavailable);
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
        removeRunFiles(runId);
        emit({ kind: "run-ended", seatId, runId, endedBy: "exit" });
        throw new SupervisorError(500, reason, { cause });
      };
      if (run.branch === null) return fail(`${RESUME_FAILED}: no branch recorded for the run`);
      if (run.sessionId === null) return fail(`${RESUME_FAILED}: CLI session ID missing`);
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
      const reviewResumeStillAllowed = (): Run | null => {
        const current = store.run(runId);
        const loop = current?.loop;
        if (
          current === null ||
          current.endedAt !== null ||
          loop?.phase !== "review" ||
          loop.parked !== null ||
          loop.aside?.worktree !== aside.worktree ||
          loop.aside.wake !== aside.wake
        )
          return null;
        return current;
      };
      let reviewResumeBlocked = false;
      const beforeLaunch = options.reviewResume
        ? () => {
            const current = reviewResumeStillAllowed();
            if (current === null) {
              reviewResumeBlocked = true;
              throw new SupervisorError(409, NOT_ASIDE);
            }
            // the seat's last turn was another run's
            store.setSeatTurnEnded(seatId, null);
            return current;
          }
        : () => {
            // the seat's last turn was another run's
            store.setSeatTurnEnded(seatId, null);
            return undefined;
          };
      let l: Live;
      try {
        l = await checkedLaunch(
          info,
          run,
          run.sessionId,
          checkout,
          true,
          null,
          "",
          false,
          beforeLaunch,
        );
      } catch (e) {
        log(`${seatId}: could not start: ${errText(e)}`);
        if (reviewResumeBlocked) throw e;
        if (e instanceof SupervisorError && e.status === 409 && pausedSeat(store, seatId)) throw e;
        return fail(CANNOT_START, e);
      }
      // no "carry on" line goes ahead of the fix the engine is about to send
      l.resumedAt = null;
      // the seat's last word (a crash, a stop) is overwritten below: keep it as an Activity row
      const prev = store.seatSession(seatId);
      if (prev?.state === "error" || prev?.state === "stopped") {
        const why = prev.reason ? `: ${prev.reason}` : "";
        try {
          store.addAgentEvent({
            agentId: seatId,
            at: now(),
            from: prev.state,
            to: "idle",
            text: `${HUD_STATE_LABEL[prev.state]} → ${HUD_STATE_LABEL.idle}${why} (run #${run.seq} woken)`,
          });
        } catch (e) {
          log(`${seatId}: could not record its previous state: ${errText(e)}`);
        }
      }
      try {
        setSeat(seatId, {
          runId,
          cliSessionId: run.sessionId,
          vendor: run.vendor,
          state: "idle",
          reason: null,
          worktree: checkout.path,
        });
      } catch (e) {
        // not recorded on the seat: discard the process rather than leave one nobody can see
        l.off();
        if (live.get(seatId) === l) live.delete(seatId);
        void l.session.close();
        if (e instanceof SupervisorError && e.status === 409 && pausedSeat(store, seatId)) throw e;
        return fail(CANNOT_START, e);
      }
      if (options.reviewResume) {
        const current = store.run(runId)?.loop;
        if (current !== null && current !== undefined)
          store.setRunLoop(runId, { ...current, aside: null });
      }
    } finally {
      starting.delete(seatId);
    }
  }

  async function send(
    runId: string,
    key: string,
    text: string,
    cost?: { wake: number; pieces: readonly PromptPiece[] },
  ): Promise<SendResult> {
    if (!mayAct() || stopping) return "busy";
    const run = store.run(runId);
    if (run === null) return "gone";
    const seatId = run.agentId;
    if (runGone(runId, seatId)) return "gone";
    const l = live.get(seatId);
    if (starting.has(seatId) || l?.ending != null) return "busy";
    if (!l?.session.alive) return "no-session";
    if (l.run.id !== runId || l.attaching) return "busy";
    return enqueue(l, (): SendResult => {
      // the run may have ended while this waited its turn in the chain
      if (runGone(runId, seatId)) return "gone";
      if (l.ending !== null) return "busy";
      if (!l.session.alive) return "no-session";
      if (l.inTurn) return "busy";
      const claimed = store.claimLine(key, { runId, seatId, origin: "engine", text, at: now() });
      if (!claimed) return "dup";
      try {
        const inbox = withInbox(seatId, runId, text, isResumeLineKey(key));
        writeLine(l, inbox.text);
        markInboxRead(seatId, inbox);
        if (cost !== undefined) {
          try {
            store.recordPromptSections(
              runId,
              cost.wake,
              now(),
              promptSections(inbox.text, cost.pieces, "orders"),
            );
          } catch (e) {
            log(`${seatId}: could not record the wake's sections: ${errText(e)}`);
          }
        }
      } catch {
        store.dropLine(key);
        return l.session.alive ? "busy" : "no-session";
      }
      return "sent";
    });
  }

  /** Revokes the token and frees the test-lock holds `restoreRuns` put back, for every active run. */
  function dropRestored(): void {
    try {
      for (const row of heldSessions()) {
        if (row.runId === null) continue;
        deps.tokens.revoke(row.runId);
        deps.lock.releaseRun(row.runId);
      }
    } catch (e) {
      log(`could not drop restored runs: ${errText(e)}`);
    }
  }

  return {
    withAccountUpdate,
    start() {
      if (!deps.enabled || !crew || started) return;
      started = true;
      // a crew.node that failed its check at load: crew stays off with the reason, the hub runs on
      if (crew.nodeNote !== undefined) {
        lockNote = crew.nodeNote;
        log(crew.nodeNote);
        dropRestored();
        return;
      }
      // Never throws: an unwritable crew dir (EACCES, EROFS, ENOSPC…) leaves crew off with a note,
      // not the hub crash-looping under launchd.
      const cannot = (e: unknown) => {
        lockNote = `crew lock could not be taken: ${(e as NodeJS.ErrnoException).code ?? errText(e)}`;
      };
      try {
        mkdirSync(crew.worktrees, { recursive: true });
        for (const s of crew.sessions) {
          mkdirSync(join(crew.worktrees, s.id), { recursive: true, mode: 0o700 });
        }
      } catch (e) {
        cannot(e);
        dropRestored();
        return;
      }
      noteFlatWorktrees();
      for (const k of keptLoopRepos(deps.config)) {
        log(
          `crew: loop ${k.loopId}'s repo ${k.repo} stays readable to seats: it holds ${k.folder}`,
        );
      }
      for (let attempt = 0; attempt < 2 && !holdsLock; attempt++) {
        try {
          writeFileSync(lockPath(), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
          holdsLock = true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
            cannot(e);
            dropRestored();
            return;
          }
          let pid: number;
          let checked: ReturnType<typeof statSync>;
          try {
            checked = statSync(lockPath());
            pid = Number.parseInt(readFileSync(lockPath(), "utf8"), 10);
          } catch {
            continue; // No reliable snapshot: never unlink.
          }
          // This process's own pid is from an earlier run (one supervisor per process).
          if (pid !== process.pid && pidAlive(pid)) {
            let reused = false;
            try {
              const info = (deps.processStart ?? processInfo)(pid);
              reused =
                info !== null &&
                Number.isFinite(info.startedAt) &&
                info.startedAt > checked.mtimeMs + LOCK_REUSE_MARGIN_MS &&
                !info.command.includes("apps/server/src/main.ts");
            } catch {
              // Every lookup failure keeps the lock (fail closed): an uncertain pid may be a
              // live hub. The margin tolerates clock skew and coarse filesystem timestamps.
            }
            if (!reused) {
              lockNote = `crew lock held by pid ${pid}`;
              dropRestored();
              return;
            }
          }
          try {
            const current = statSync(lockPath());
            if (
              current.ino !== checked.ino ||
              current.mtimeMs !== checked.mtimeMs ||
              Number.parseInt(readFileSync(lockPath(), "utf8"), 10) !== pid
            )
              continue;
            unlinkSync(lockPath()); // The checked lock still belongs to the stale process.
          } catch {
            // removed meanwhile
          }
        }
      }
      if (!holdsLock) {
        lockNote = "crew lock could not be taken";
        dropRestored();
        return;
      }
      sweepRunFiles();
      // each run's restored token and holds are kept for a seat that is attached to, and dropped
      // (`dropGrant`) for every run that is not
      void sweepScratch();
      // runs whose resume was held back go once the CLI passes its smoke test again
      unholdResume = deps.cliHold?.onRelease(() => {
        if (!stopping) {
          // a pass still running has already skipped the held runs: take them back after it
          (reattaching ?? Promise.resolve())
            .then(() => (stopping ? undefined : reattach()))
            .catch((e: unknown) => log(`could not resume crew runs: ${errText(e)}`));
        }
      });
      unpauseResume = bus.subscribe((topic) => {
        if (topic === "settings")
          void resumeDeferredRuns().catch((e: unknown) =>
            log(`could not resume paused crew runs: ${errText(e)}`),
          );
      });
      reattach().catch((e: unknown) => log(`could not resume crew runs: ${errText(e)}`));
    },

    async stopAll() {
      if (!holdsLock) return;
      stopping = true;
      unholdResume?.();
      unpauseResume?.();
      // The seats and their keepers keep running: the hub lets go of their sockets, with the lines
      // it has acted on stored, and keeps their tokens, files and holds for the next hub.
      // A seat whose Stop or engine end is under way finishes it first, so `onExit` records the end
      // as it always did: a detach would cut its close off. The wait is bounded.
      const endingSeats = [...live.values()].filter((l) => l.ending !== null);
      // The close goes first, not after the interrupt the Stop waits on (up to the control timeout):
      // a hub that exits before that must not leave the seat running.
      for (const l of endingSeats) void l.session.close();
      const ending = endingSeats.map((l) => (l.ending as Promise<void>).catch(() => {}));
      if (ending.length > 0) {
        let t: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all(ending),
          new Promise<void>((r) => {
            t = setTimeout(r, SHUTDOWN_TIMEOUT_MS / 2);
          }),
        ]);
        clearTimeout(t);
        // whatever the race left: the close is on the socket before the hub's exit
        let c: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all(endingSeats.map((l) => l.session.closeSent)),
          new Promise<void>((r) => {
            c = setTimeout(r, CLOSE_SENT_WAIT_MS);
          }),
        ]);
        clearTimeout(c);
      }
      for (const l of [...live.values()]) {
        if (l.ending !== null) continue; // still ending: its socket stays, so the close goes through
        fold(l);
        saveCursor(l);
        l.off();
        l.session.detach();
      }
      live.clear();
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

    transferAccount,

    async message(seatId, text, opts) {
      const moving = transfers.get(seatId);
      if (moving) await moving;
      const l = liveOrRefuse(need(seatId));
      return enqueue(l, async () => {
        const inbox = l.inTurn ? { text, messageIds: [] } : withInbox(seatId, l.run.id, text);
        if (opts.interrupt && l.inTurn) {
          if (l.run.vendor === "codex") await sendInterrupt(l);
          else await sendInterrupt(l).catch(rethrowIfDead);
        }
        if (opts.enforcePause) {
          const pause = pausedSeat(store, seatId);
          if (pause) throw new SupervisorError(409, `Paused: ${pause.reason}`);
        }
        writeLine(l, inbox.text);
        markInboxRead(seatId, inbox);
        // A message answers the seat's open ask_flight questions (FLIGHT's answer, or the operator's
        // reply to FLIGHT's brief)
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
      if (transfers.has(seatId)) await transfers.get(seatId);
      const l = liveOrRefuse(need(seatId));
      return enqueue(l, async () => {
        if (l.inTurn) await sendInterrupt(l);
      });
    },

    endRun,

    endRunByEngine,

    setAside,

    wakeRun,

    endAsideRun,

    send,

    resumeRun,

    resumeDeferredRuns,

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

    sessionAlive(seatId) {
      if (
        !mayAct() ||
        stopping ||
        reattaching !== null ||
        starting.has(seatId) ||
        transfers.has(seatId)
      )
        return null;
      const l = live.get(seatId);
      // a process for another run than the row's (one being ended) is not this run's session
      return l?.session.alive === true && l.run.id === store.seatSession(seatId)?.runId;
    },

    async contextUsage(seatId) {
      need(seatId);
      const l = live.get(seatId);
      if (!l?.session.alive) return null;
      // Codex answers from its own live token counts: nothing to ask, nothing written
      if (l.run.vendor === "codex") {
        try {
          return toContextUsage(await l.session.control("get_context_usage"));
        } catch {
          return null;
        }
      }
      // from the cache; the CLI is asked once per turn (when a turn has ended since it last was),
      // and again after a failed ask once CONTEXT_RETRY_MS has passed
      const cache = contextCaches.get(l);
      if (!cache || (cache.stale && now() >= cache.retryAt)) await refreshContext(l);
      else if (cache.inflight) await cache.inflight;
      return contextCaches.get(l)?.usage ?? null;
    },

    seat(seatId) {
      need(seatId);
      return store.seatSession(seatId);
    },

    holdsCrewLock: mayAct,

    endRemovedAside(runId) {
      if (!mayAct()) return false;
      const run = store.run(runId);
      if (!run || run.endedAt !== null || !run.loop?.aside) return false;
      if (starting.has(run.agentId) || live.has(run.agentId)) return false;
      if (
        store
          .runsActiveSince(Number.MAX_SAFE_INTEGER)
          .some((r) => r.agentId === run.agentId && r.endedAt === null && !r.loop?.aside)
      )
        return false;
      store.setRunEnded(run.id, now(), "ok", "operator");
      removeRunFiles(run.id);
      transcripts.delete(run.transcriptPath);
      digests.delete(run.id);
      emit({ kind: "run-ended", seatId: run.agentId, runId, endedBy: "operator" });
      return true;
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

/** Interrupt-and-send: a refused or timed-out interrupt still lets the line through. */
function rethrowIfDead(e: unknown): void {
  if (e instanceof SupervisorError && e.deadSession) throw e;
}

function recentStderr(
  exit: { lastStderr: string | null; lastStderrAt?: number | null; endReason?: string | null },
  at: number,
): string | null {
  const text =
    exit.endReason ??
    (exit.lastStderrAt != null && at - exit.lastStderrAt <= STDERR_RECENT_MS
      ? exit.lastStderr
      : null);
  return text === null ? null : cleanText(text, STDERR_TEXT_MAX);
}
