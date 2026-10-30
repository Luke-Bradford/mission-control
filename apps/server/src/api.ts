import { statSync } from "node:fs";
import { readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ACK_BATCH_MAX,
  ACTIVITY_LIMIT,
  type AccountModelsView,
  type AgentStream,
  API_PREFIX,
  type AttentionItem,
  type AuditRunKind,
  AWAY_SETTING,
  type AwaySettings,
  areaOwnsFolder,
  type BoardItem,
  type ChangedFiles,
  CI_TRIES,
  type CiRunsView,
  type CliAccountStatus,
  COMMS_CANT_REASON_MAX,
  COMMS_CAPCOM,
  COMMS_CAPCOM_ESCALATION_MS,
  COMMS_CHATTER_WINDOW_MS,
  COMMS_CREW,
  COMMS_FLIGHT_ESCALATION_MS,
  COMMS_LABELS,
  COMMS_MC,
  COMMS_MESSAGE_BODY_LIMIT,
  COMMS_MESSAGE_MAX,
  COMMS_PAGE_DEFAULT,
  COMMS_PAGE_MAX,
  COMMS_REACTIONS,
  COMMS_REF,
  COMMS_TICKET,
  CONTROLLER_CHECK_PARK,
  CONTROLLER_CHECK_USE_ROUTE,
  type ContextUsage,
  CREW_DISABLED,
  type Crew,
  type CrewChanges,
  type CrewMode,
  type CrewPause,
  type CrewRow,
  type CrewSessionFolders,
  type CrewVendor,
  capAudit,
  crewSummary,
  DEFAULT_REPO_RULES,
  DISCUSSION_TEXT_MAX,
  DRAFT_BAD_TARGET,
  ENGINE_TICK_MS,
  effectiveHardRules,
  type FileDiff,
  fixesSent,
  fullAt5h,
  GITHUB_RATE_SETTING,
  type GithubRateState,
  GUARD_ACK_PREFIX,
  GUARD_ALLOW_OUTPUT,
  GUARD_BODY_LIMIT,
  GUARD_CHECK_PATH,
  GUARD_HITS_LIMIT,
  GUARD_HOOK_EVENTS,
  GUARD_WINDOW_DAYS,
  type GuardHitsView,
  guardAckKey,
  guardDenyOutput,
  HUD_RENDERER_HEADER,
  ISSUE_REQUIRED,
  type LimitRow,
  LOCK_WAIT_MS,
  LOOPBACK_HOST,
  lockBusyText,
  type MachineSample,
  type MachineView,
  type MapSnapshot,
  MC_TEXT_MAX,
  type McToolName,
  METER_FULL_PCT,
  type MilestonesView,
  NEW_LOOP,
  OPERATOR_BOOTSTRAP_PATH,
  OPERATOR_HEADER,
  OPERATOR_TOKEN_REQUIRED,
  PR_LIST_DAYS,
  PR_LIST_DAYS_MAX,
  type PullRequestListRow,
  type PullRequestSummary,
  type PullRequestView,
  pace5h,
  projectAtReset,
  QA_RETENTION_DAYS,
  type QaFindingsView,
  READONLY_FILES_NOTE,
  REVIEW_ROUNDS,
  type RepoId,
  type RepoProfile,
  type RepoView,
  type RunLoopView,
  type RunView,
  reviewStatusOf,
  type StreamEvent,
  seatCallSign,
  seatDef,
  startOfLocalDay,
  stopForecast,
  TELEMETRY_RANGES,
  TEST_LOCK_UNAVAILABLE_TEXT,
  type Telemetry,
  type TelemetryRange,
  type TestLockHistory,
  type TestLockView,
  type Topic,
  TYPE_LABELS,
  UPDATE_LOG_UNREADABLE,
  UPDATE_UNAVAILABLE,
  type UpdateLog,
  type UsageSample,
  type VersionInfo,
  watchStartRefusedText,
} from "@mc/core";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from "fastify";
import { z } from "zod";
import { type AccountModels, discoverAccountModels, readAccountStatus } from "./accounts.ts";
import {
  AttentionHoldInput,
  attentionHoldError,
  holdItem,
  releaseHold,
} from "./attention-holds.ts";
import {
  AWAY_STARTED_SETTING,
  AwayBody,
  activeAway,
  awayDigest,
  readAwaySettings,
} from "./away.ts";
import type { ChangeBus } from "./bus.ts";
import { fetchTicket, type Gql, githubToken, makeGql, projectUrlOf } from "./collectors/github.ts";
import {
  makeRest,
  NO_OPEN_THREAD,
  type NotificationsView,
  notificationOpen,
  notificationsView,
  parsePersonKey,
  type Rest,
  sourceMessage,
  sourceReadUrl,
} from "./collectors/notifications.ts";
import { isPaused, PAUSE_FILE } from "./collectors/ta-loop.ts";
import { teamsStatus } from "./collectors/teams.ts";
import { USAGE_BACKOFF_CAP_MS, USAGE_BACKOFF_SETTING } from "./collectors/usage-claude.ts";
import { DEFAULT_MAX_AGE_MS, WINDOWS } from "./collectors/usage-common.ts";
import {
  COMMS_SNAPSHOT_LIMIT,
  pinComms,
  reactComms,
  sendComms,
  threadMessages,
  validateCommsText,
} from "./comms.ts";
import {
  agentIds,
  type CcConfig,
  configuredAgents,
  crewSeatDef,
  crewSeatMode,
  DEFAULT_MAX_SEATS,
  flightPowersOf,
  TeamsSelection,
} from "./config.ts";
import {
  AccountBody,
  accountDuplicateReason,
  addAccount,
  addRepo,
  ConfigWriteError,
  closeSession,
  createSession,
  duplicateReason,
  NewAccountBody,
  NewRepoBody,
  NewSessionBody,
  onboardRepo,
  RepoLocation,
  RepoOnboardBody,
  RepoSetupBody,
  removeAccount,
  SeatsBody,
  setAccount,
  setRepoSetup,
  setSessionSeats,
  setTeamsSelection,
} from "./config-write.ts";
import type { CrewReloader } from "./crew-apply.ts";
import {
  CrewPauseBody,
  pausedSeat,
  readCrewPause,
  startUnpausedRun,
  writeCrewPause,
} from "./crew-pause.ts";
import { type Engine, operatorRefusalText } from "./engine/engine.ts";
import { RepoRulesError, readRepoRules } from "./engine/rules.ts";
import { overrunText, TICKS_COLLECTOR, tickLogOf } from "./engine/ticks.ts";
import {
  changedFiles,
  committedLines,
  fileDiff,
  type GitExec,
  GitFailed,
  NO_WORKTREE_NOTE,
} from "./files.ts";
import type { HudShotStore } from "./flight/hud-store.ts";
import { FlightLedgerArgs, flightLedgerView, flightSummary } from "./flight/ledger.ts";
import { FlightMemoryInput, FlightMemoryTopic } from "./flight/memory.ts";
import { flightBriefView, flightScheduleView, flightSeat, flightView } from "./flight/state.ts";
import { seatFocus } from "./focus.ts";
import { ensureFields, ensureLabels, missingLabels, setupStatus } from "./github-setup.ts";
import type { CheckRecorder } from "./guard/check-runs.ts";
import { crewGuardDecision } from "./guard/decision.ts";
import type { TestLock } from "./guard/lock.ts";
import { rereadDenial } from "./guard/rereads.ts";
import {
  attentionItems,
  attentionVersion,
  CREW_ERROR_KEY,
  crew,
  forgetViews,
  NO_LOCK,
  NOTE_KEY,
} from "./hud.ts";
import { LocalNotifications, NotificationPreferencesBody } from "./local-notifications.ts";
import { loopTries } from "./loophistory.ts";
import {
  MACHINE_CAPACITY_DEFAULTS,
  machineCapacity,
  machineCapacitySince,
} from "./machine-capacity.ts";
import { MapConflicts } from "./map/conflicts.ts";
import { CallRing, type RingSource } from "./map/ring.ts";
import { mapSeats } from "./map/seats.ts";
import { type MapPersist, mapHead, mapTree } from "./map/snapshot.ts";
import { createGh, type GhRunner } from "./mcp/gh.ts";
import { bearer, type McpCalls, type McTool, registerMcp, UNKNOWN_RUN } from "./mcp/server.ts";
import type { RunIdentity, RunTokens } from "./mcp/tokens.ts";
import { evidenceProblemText, type McToolsDeps, prTextProblem, readKnown } from "./mcp/tools.ts";
import { metricsView } from "./metrics.ts";
import { BOOTSTRAP_REFUSED, operatorTokenMatches } from "./operator.ts";
import { overviewSummary } from "./overview.ts";
import { PREVIEW_ACTIVITY_HEADER, PreviewHubError, type PreviewManager } from "./previews.ts";
import { createProfile, NewProfileBody, profilesView } from "./profiles.ts";
import {
  proposeQueueReorder,
  type QueueReorderDeps,
  QueueReorderError,
  resolveQueueReorder,
} from "./queue-reorder.ts";
import { PreviewError, repoPreview, repoProfiles } from "./repo-profile.ts";
import {
  adminDirOf,
  CheckoutError,
  removeSessionCheckout,
  validateSessionCheckout,
} from "./runtime/checkouts.ts";
import { type CodexModels, codexModelsFor } from "./runtime/codex-models.ts";
import { CrewGitError, crewGit } from "./runtime/git.ts";
import { runSeatGrants } from "./runtime/grants.ts";
import { CREW_ACTION_FAILED, type Supervisor, SupervisorError } from "./runtime/supervisor.ts";
import {
  type BoardTitleCache,
  type PrCache,
  runPrs,
  runTicket,
  runUsage,
  runView,
} from "./runview.ts";
import { setSeatFocus } from "./seat-focus.ts";
import {
  type CommsReadScope,
  commsMessageNumber,
  commsPosition,
  crewDir,
  crewPrBodyPath,
  type Store,
} from "./store.ts";
import { lastOutputAt, readStream, readStreamPage } from "./stream.ts";
import { lockView, telemetry, usualLockMs } from "./telemetry.ts";
import { overviewTimeline } from "./timeline.ts";
import { transcriptFilePath } from "./transcript-file.ts";
import { transcriptFootprint } from "./transcript-lifecycle.ts";
import { UPDATE_FAILED, UpdateError, type Updater } from "./update.ts";
import { activity, configView } from "./views.ts";
import { webHandler } from "./web.ts";

export const TELEMETRY_COMMIT_READ_LIMIT = 32;
const TELEMETRY_COMMIT_CONCURRENCY = 4;

/** The only Host names (and Origin hosts) the server answers: loopback, any port. */
/** GitHub issue numbers are 32-bit; anything larger cannot exist. */
const MAX_ISSUE_NUMBER = 2 ** 31 - 1;

export const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", LOOPBACK_HOST]);
/** The socket addresses of a caller on this machine. */
const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set([
  LOOPBACK_HOST,
  "::1",
  `::ffff:${LOOPBACK_HOST}`,
]);

/** `GUARD_CHECK_PATH` as registered inside the API prefix. */
export const GUARD_CHECK_ROUTE = GUARD_CHECK_PATH.slice(API_PREFIX.length);
if (`${API_PREFIX}${GUARD_CHECK_ROUTE}` !== GUARD_CHECK_PATH) {
  throw new Error(`${GUARD_CHECK_PATH} is not under ${API_PREFIX}`);
}

export const STUDIO_PAUSE_ERROR = "pause for studio-loop arrives with cutover";
export const HEARTBEAT_MS = 25_000;
export const LOOP_WRITES_DISABLED = "loop writes are disabled on this server";
export const CONFIG_WRITES_UNAVAILABLE = "config writes are not available on this server";
export const CONFIG_WRITE_FAILED = "could not write config.yaml";
/** The check route's answer to a failure outside the updater's own (502) errors. */
export const CHECK_FAILED = "could not check for updates";
export { AWAY_SETTING } from "@mc/core";

const DEFAULT_RUNS_LIMIT = 50;
const MAX_RUNS_LIMIT = 500;
const DEFAULT_STREAM_LIMIT = 200;
const MAX_STREAM_LIMIT = 500;
export const NO_RUNS_YET = "no runs yet";
export const TRANSCRIPT_NOT_FOUND = "transcript not found";
const DEFAULT_TELEMETRY_RANGE = "6h";
const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const FIVE_HOURS_MS = 5 * HOUR_MS;

/** Never log credentials: request/response headers that can carry them are censored. */
export const LOG_REDACT = {
  paths: [
    "req.headers.cookie",
    "req.headers.authorization",
    'res.headers["set-cookie"]',
    "headers.cookie",
    "headers.authorization",
    'req.headers["x-mc-operator"]',
    'headers["x-mc-operator"]',
    'headers["set-cookie"]',
  ],
  censor: "[redacted]",
};

const VIEWER_QUERY = "query { viewer { login } }";
const GITHUB_LOGIN_RETRY_MS = 5 * 60_000;

export interface AppDeps {
  /** The live hub's bounded set of branch-preview children; absent on preview hubs and unit apps. */
  previews?: PreviewManager;
  /** The repository whose checkout runs this hub; only its branches can become preview hubs. */
  previewRepoId?: RepoId;
  /** A child preview reports browser activity to its parent without exposing an operator token. */
  previewActivity?: () => void;
  /** FLIGHT's stored HUD screenshots; absent: the retrieval route answers 404. */
  hudShots?: HudShotStore;
  queueReorder?: QueueReorderDeps;
  mapRing?: CallRing;
  /** Build each repo's map payload in the background once the app is ready (the hub's start). */
  warmMap?: boolean;
  config: CcConfig;
  /** Cached Codex model catalogs, isolated by each account's CLI binding. */
  codexModelsFor?: (account: CcConfig["accounts"][number]) => Pick<CodexModels, "entries">;
  /** The per-boot operator token every mutating /api route requires; absent: not required (tests). */
  operatorToken?: string;
  /** The mc tools only a `flight_powers: superuser` repo's seats may call; default: core's list. */
  superuserTools?: readonly McToolName[];
  gh?: GhRunner;
  knownSecrets?: McToolsDeps["knownSecrets"];
  /** Delivers a direct Comms message to a local live seat. */
  deliverComms?: (seatId: string, text: string, from: string) => void;
  store: Store;
  bus: ChangeBus;
  /** The latest machine sample (for `/api/machine`); default: none yet. */
  machine?: () => MachineSample | null;
  /** Receives the number of open browser event streams. */
  onStreamCount?: (count: number) => void;
  now?: () => number;
  /** true: log to stdout; an object: log to that stream; false/absent: no logging. */
  logger?: boolean | { stream: { write(msg: string): void } };
  heartbeatMs?: number;
  /** profiles.yaml beside config.yaml, shown by /api/config; absent: no profiles in the view. */
  profilesPath?: string;
  /** The GitHub client for board setup; default: a token from `gh auth token`, read on each use. */
  githubGql?: () => Promise<Gql>;
  /** Read-only source revalidation before approving a person reply. */
  notificationRest?: Rest;
  /** Asked to refresh the boards after a setup that changed GitHub; default: a "boards" change. */
  refreshBoards?: () => void;
  /** The built web app (apps/web/dist), served for unmatched GET/HEAD outside /api; absent: none. */
  webRoot?: string;
  /** Reads a transcript for `/api/agents/:id/stream`; default: `readStreamPage`. */
  readStream?: (
    path: string,
    limit: number,
    vendor?: CrewVendor,
    before?: string,
  ) => { events: StreamEvent[]; truncated: boolean; more?: boolean };
  /** Reads a worktree's changed files for `/api/agents/:id/files`; default: read-only git. */
  changedFiles?: (worktree: string, exec?: GitExec) => Promise<ChangedFiles>;
  /** Reads one listed file's diff for `/api/agents/:id/files/diff`; default: read-only git. */
  fileDiff?: (worktree: string, path: string, exec?: GitExec) => Promise<FileDiff | null>;
  /**
   * Preview servers (`MC_NO_LOOP_WRITES=1`): Pause/Resume answer 409 before touching any loop file,
   * so a preview can never write into a live loop.
   */
  noLoopWrites?: boolean;
  /** The config.yaml the server loaded, which `POST /api/repos` appends to; absent: no config writes. */
  configPath?: string;
  /** Applies seat and role changes from config.yaml live; absent: no reload route. */
  crewReloader?: CrewReloader;
  /** True when this server may write crew seats to `configPath` (not a preview on the live file). */
  seatWrites?: boolean;
  /** Starts, messages and ends the crew's seats; absent: crew routes answer 409 (disabled). */
  supervisor?: Supervisor;
  /** The first loop's engine: told of the operator's messages, and says why it is off. Absent: none. */
  engine?: Pick<Engine, "onOperatorMessage" | "status"> &
    Partial<Pick<Engine, "controllerCheck" | "holdMerge" | "releaseMergeHold">>;
  /** The Update button (`update.ts`); absent: version says why, and update answers 409. */
  updater?: Updater;
  /** The per-run tokens that authorise `/mcp`; absent: the endpoint is not served. */
  tokens?: RunTokens;
  /** The `/mcp` calls in flight, which a restart waits for; default: not counted. */
  mcpCalls?: McpCalls;
  /** The mc tools `/mcp` serves; default: none. */
  mcpTools?: () => McTool[];
  /** A seat's mode, which decides the mc tools it is offered; default: read-only. */
  seatMode?: (seatId: string) => CrewMode;
  /** The extra mc tools a seat's role holds; default: none. */
  seatGrants?: (seatId: string) => readonly string[];
  /** The extra mc tools an authenticated run holds; default: none. */
  runGrants?: (who: RunIdentity) => readonly string[];
  /** The test lock the guard takes for a full suite; absent: a full suite is denied, never run unlocked. */
  lock?: TestLock;
  /** Records the configured checks a seat's shell calls run (the push gate reads them); absent: none. */
  checks?: CheckRecorder;
  /** The hub's own `gh` login, for telling another login's draft PRs from its own; default: unknown. */
  hubLogin?: () => string | null;
}

/**
 * What the guard route and `/mcp` need from main.ts: the run tokens, the test lock, and each seat's
 * mode from its configured role (anything that is not a configured seat is read-only).
 */
export function crewGuardDeps(
  config: CcConfig,
  tokens: RunTokens,
  lock: TestLock,
  store: Store,
): {
  tokens: RunTokens;
  lock: TestLock;
  seatMode: (seatId: string) => CrewMode;
  runGrants: (who: RunIdentity) => McToolName[];
} {
  return {
    tokens,
    lock,
    seatMode: (seatId) => crewSeatMode(config, seatId),
    runGrants: (who) => runSeatGrants(config, store, who),
  };
}

/** `POST /api/seats/:id/start`: a GitHub issue number. */
const StartBody = z.strictObject({
  issue: z
    .int()
    .min(1)
    .max(2 ** 31 - 1)
    .optional(),
  /** An operator may explicitly start through a temporary machine-capacity hold. */
  force: z.boolean().optional(),
});
const PreviewBody = z.strictObject({
  pr: z
    .int()
    .min(1)
    .max(2 ** 31 - 1),
});

/**
 * `POST /api/seats/:id/message`. The text is sent on as typed; it only has to
 * hold something besides whitespace.
 */
const MessageBody = z.strictObject({
  text: z
    .string()
    .max(COMMS_MESSAGE_MAX)
    .refine((t) => t.trim() !== "", "must not be blank"),
  interrupt: z.boolean().optional(),
});

/** `POST /api/seats/:id/interrupt` and `/end`: no fields. */
const NoBody = z.strictObject({});
/** `POST /api/runs/:id/merge-hold`: the controller holds a run's merge (with a reason) or releases it. */
const MergeHoldBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("hold"), reason: z.string().trim().min(1).max(300) }),
  z.strictObject({ action: z.literal("release") }),
]);
const ControllerCheckBody = z
  .strictObject({
    verdict: z.enum(["pass", "fail"]),
    /** The head the operator checked (7 or more characters of its sha). */
    sha: z.string().regex(/^[0-9a-f]{7,40}$/i),
    note: z.string().max(COMMS_MESSAGE_MAX).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.verdict === "fail" && (b.note === undefined || b.note.trim() === ""))
      ctx.addIssue({ code: "custom", path: ["note"], message: "a failed check needs a note" });
  });

// Ending a run frees the seat for its next ticket; `hold` also takes it out of rotation.
const EndBody = z.strictObject({
  hold: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  watch: z
    .strictObject({
      id: z.string().min(1).max(100),
      runId: z.string().min(1).max(200),
      toolUseId: z.string().min(1).max(200),
      since: z.number().int().nonnegative(),
    })
    .optional(),
});

/**
 * `POST /api/guard/check`: what the guard hook sends (`guard/hook.ts`), and nothing else. A Post
 * event carries no input.
 */
const GuardCheckBody = z.strictObject({
  hook_event_name: z.enum(GUARD_HOOK_EVENTS),
  tool_name: z.string().min(1).max(256),
  tool_use_id: z.string().min(1).max(256),
  agent_id: z.string().min(1).max(256).optional(),
  tool_input: z
    .strictObject({
      command: z.string().optional(),
      file_path: z.string().optional(),
      run_in_background: z.boolean().optional(),
      pages: z.string().optional(),
      offset: z.number().optional(),
      limit: z.number().optional(),
    })
    .optional(),
});

const MAX_GUARD_DAYS = 30;
const GUARD_DAYS = /^[1-9]\d?$/;
/** The `days` of a QA board read: whole days, 1..QA_RETENTION_DAYS; null when it is not. */
function qaDays(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^[1-9]\d{0,2}$/.test(raw)) return null;
  return Number(raw) <= QA_RETENTION_DAYS ? Number(raw) : null;
}
const QA_DAYS_ERROR = `days must be an integer 1..${QA_RETENTION_DAYS}`;

/** `GET /api/agents/:id/files/diff?path=`: one path, as the file list gives it. */
const DiffPath = z.string().min(1).max(4096);

/** `POST /api/attention/ack`. */
const AckBody = z.strictObject({
  keys: z.array(z.string().min(1).max(200)).min(1).max(ACK_BATCH_MAX),
});

/** The answer to a dismiss of a key that is not an open note (a seat's question is not a note). */
export const NO_OPEN_NOTE = "no such open note";

/** The first zod issue as `path: message`, for a 400 body. */
const zodError = (e: z.ZodError): string => {
  const issue = e.issues[0];
  if (!issue) return "invalid body";
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
};

/** One cached stream per agent: reused while its latest run's transcript is unchanged. */
interface StreamCacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  limit: number;
  before: string | undefined;
  result: ReturnType<NonNullable<AppDeps["readStream"]>>;
}

/** Projection applies to 7d windows only (ruling); a 5h row shows `used` and `resetAt`. */
export type { LimitRow };

type LimitRowBase = Omit<LimitRow, "window" | "projected" | "stopForecast" | "fullAt">;

const RUNS_LIMIT = /^[1-9]\d{0,2}$/;

const mediaType = (ct: string | undefined): string =>
  (ct ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

const isLocalOrigin = (origin: string): boolean => {
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const errCode = (e: unknown): unknown => (e as NodeJS.ErrnoException | null)?.code;

/** A PR as `?shape=summary` sends it: the fields a list shows, the checks as the `ci` rollup. */
function prSummaryRow(pr: PullRequestView): PullRequestSummary {
  return {
    repoId: pr.repoId,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    branch: pr.branch,
    headSha: pr.headSha,
    ticket: pr.ticket,
    state: pr.state,
    isDraft: pr.isDraft,
    review: pr.review,
    ci: pr.ci,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
  };
}

/** A PR as a list sends it by default: its checks by name and state only. */
function prSummary(pr: PullRequestView): PullRequestListRow {
  const { checks, ...rest } = pr;
  return checks === undefined
    ? rest
    : {
        ...rest,
        checks: checks.map(({ name, kind, state, attempt }) => ({ name, kind, state, attempt })),
      };
}

/** `?limit=` as an integer 1..max (absent: `fallback`), or null when invalid. */
function parseLimit(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !RUNS_LIMIT.test(raw) || Number(raw) > max) return null;
  return Number(raw);
}

export const ACCOUNT_STATUS_CACHE_MS = 60_000;

const NOTIFICATION_RECONCILE_MS = 1000;
const HUD_MEMO_MS = 2_000;
/** Longest a map payload is reused: the backstop for fields that age without any input changing. */
const MAP_CACHE_MS = 15_000;

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, store, bus } = deps;
  const now = deps.now ?? Date.now;
  let transcriptFootprintCache: {
    at: number;
    value: ReturnType<typeof transcriptFootprint>;
  } | null = null;
  const mapConflicts = new MapConflicts();
  const mapSources = new Map<string, RingSource>();
  const mapRing = new CallRing(() => {
    const sources: RingSource[] = [];
    const recent = store.runsActiveSince(now() - 15 * 60_000);
    for (const agent of configuredAgents(config)) {
      if (agent.kind !== "crew") continue;
      const seat = store.seatSession(agent.id);
      const current = store.seatRun(agent.id);
      const flight = agent.seat.role === "FLIGHT";
      const runs = [
        ...new Map(
          [
            ...(current ? [current] : []),
            ...(!flight
              ? [
                  ...store.mapAsideRuns(agent.id),
                  ...recent.filter((r) => r.agentId === agent.id && r.repoId === agent.repoId),
                ]
              : []),
          ].map((r) => [r.id, r]),
        ).values(),
      ];
      for (const run of runs) {
        const repos = flight ? config.repos : config.repos.filter((r) => r.id === run.repoId);
        for (const repo of repos) {
          const id = flight ? `${run.id}:${repo.id}` : run.id;
          const cwd = flight
            ? config.crew?.sessions.find((s) => s.repoId === repo.id)?.checkout
            : ((seat?.runId === run.id ? seat.worktree : null) ??
              run.loop?.aside?.worktree ??
              mapSources.get(id)?.cwd);
          if (!cwd) continue;
          const source: RingSource = {
            id,
            seat: agent.id,
            repoId: repo.id,
            cwd,
            transcriptPath: run.transcriptPath,
            vendor: run.vendor ?? seat?.vendor,
            turnScoped: flight,
            current: current?.id === run.id,
          };
          sources.push(source);
          mapSources.set(id, source);
        }
      }
    }
    const active = new Set(sources.map((s) => s.id));
    for (const id of mapSources.keys()) if (!active.has(id)) mapSources.delete(id);
    return sources;
  });
  let stopMapRing: (() => void) | undefined;
  const mapStore: MapPersist = {
    get: (kind, scope, key) => store.mapCacheGet(kind, scope, key),
    put: (kind, scope, key, value, exclusive) =>
      store.mapCachePut(kind, scope, key, value, exclusive),
  };
  const mapPayloads = new Map<string, { key: string; at: number; payload: Promise<MapSnapshot> }>();
  const buildMapPayload = async (
    repo: (typeof config.repos)[number],
    checkout: string,
    crewRows: CrewRow[],
    lock: typeof NO_LOCK,
    prs: PullRequestView[],
    board: BoardItem[],
    log: FastifyBaseLogger,
  ): Promise<MapSnapshot> => {
    const tree = await mapTree(checkout, "origin/HEAD", prs, board, now(), mapStore);
    const data = mapSeats(
      crewRows,
      store,
      mapRing,
      lock,
      now(),
      flightSeat(config)?.seat.id ?? null,
    );
    for (const seat of data.seats) {
      const context = store.seatSession(
        seat.seat === "FLIGHT" ? (flightSeat(config)?.seat.id ?? seat.seat) : seat.seat,
      )?.runId
        ? await deps.supervisor
            ?.contextUsage(
              seat.seat === "FLIGHT" ? (flightSeat(config)?.seat.id ?? seat.seat) : seat.seat,
            )
            .catch(() => null)
        : null;
      seat.context = context ? { total: context.total, window: context.window } : null;
    }
    const conflicts = await mapConflicts.check(checkout, prs);
    const read = await readRepoRules(repo.github, checkout, repo.rules);
    // Unreadable repo rules leave the configured ones: the map still draws.
    const rules = read instanceof RepoRulesError ? (repo.rules ?? DEFAULT_REPO_RULES) : read;
    for (const failure of conflicts.failures)
      log.warn(failure, "map conflict check failed for a pair; reported unchecked");
    return {
      repoId: repo.id,
      ...tree,
      ...data,
      conflicts: conflicts.conflicts,
      conflictsUnchecked: conflicts.unchecked,
      rules: {
        areas: rules.areas,
        hardRules: effectiveHardRules(rules, flightPowersOf(config, repo.id)),
      },
      // Slice 1b will publish sequenced deltas; none have been emitted yet.
      seq: 0,
    };
  };
  /** The cached map payload, built (once, however many ask) when an input has changed. */
  const mapPayloadFor = async (
    repo: (typeof config.repos)[number],
    checkout: string,
    log: FastifyBaseLogger,
  ): Promise<MapSnapshot> => {
    const head = await mapHead(checkout);
    if (!stopMapRing) stopMapRing = mapRing.start();
    mapRing.poll();
    // Map keys include mutable seat configuration. Unlike GET /crew, this path must also serve
    // an in-memory config edit before its reloader emits `config` (the editor preview does this).
    const crewRows = crew(config, store, now(), deps.lock?.state() ?? NO_LOCK)
      .rows.filter((r) => r.kind === "crew" && (r.repoId === repo.id || r.role === "FLIGHT"))
      .map((r) => (r.role === "FLIGHT" ? { ...r, repoId: repo.id } : r));
    const lock = deps.lock?.state() ?? NO_LOCK;
    const prs = store.pullRequests(repo.id);
    const board = store.board(repo.id);
    // reused until the default branch, the ring, the seats (rows and lock), the PRs, the
    // board or the rules change; the time-driven fields (ages, context) get the backstop
    const key = JSON.stringify([
      head,
      mapRing.revision(repo.id),
      crewRows,
      lock,
      prs,
      board,
      flightPowersOf(config, repo.id),
      repo.rules,
    ]);
    const at = now();
    const cached = mapPayloads.get(repo.id);
    if (cached && cached.key === key && at - cached.at < MAP_CACHE_MS) return await cached.payload;
    const payload = buildMapPayload(repo, checkout, crewRows, lock, prs, board, log);
    const entry = { key, at, payload };
    mapPayloads.set(repo.id, entry);
    payload.catch(() => {
      if (mapPayloads.get(repo.id) === entry) mapPayloads.delete(repo.id);
    });
    return await payload;
  };

  const accountStatuses = new Map<string, { status: CliAccountStatus; expiresAt: number }>();
  const accountModels = new Map<string, AccountModels>();
  let localAccountUpdate: Promise<void> | null = null;
  const withAccountUpdate = <T>(fn: () => Promise<T>): Promise<T> => {
    if (deps.supervisor) return deps.supervisor.withAccountUpdate(fn);
    const update = (localAccountUpdate ?? Promise.resolve()).then(fn);
    const settled = update
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        if (localAccountUpdate === settled) localAccountUpdate = null;
      });
    localAccountUpdate = settled;
    return update;
  };
  const accountReads = new Map<string, Promise<CliAccountStatus>>();
  const accountStatus = (account: CcConfig["accounts"][number], refresh = false) => {
    const key = `${account.vendor}:${account.id}`;
    const pending = accountReads.get(key);
    if (pending) return pending;
    const cached = accountStatuses.get(key);
    if (!refresh && cached && now() < cached.expiresAt) return Promise.resolve(cached.status);
    const read = readAccountStatus(account, now())
      .then((status) => {
        accountStatuses.set(key, { status, expiresAt: now() + ACCOUNT_STATUS_CACHE_MS });
        return status;
      })
      .finally(() => accountReads.delete(key));
    accountReads.set(key, read);
    return read;
  };

  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const githubGql = deps.githubGql ?? (async () => makeGql(await githubToken()));
  // The login the hub acts as: kept once read; null when it cannot be, and not tried again for
  // GITHUB_LOGIN_RETRY_MS. Concurrent requests share one read.
  let githubLogin: string | null = null;
  let loginRead: Promise<string | null> | null = null;
  let loginFailedAt = Number.NEGATIVE_INFINITY;
  const readGithubLogin = (): Promise<string | null> | string | null => {
    if (githubLogin !== null) return githubLogin;
    if (loginRead) return loginRead;
    if (now() - loginFailedAt < GITHUB_LOGIN_RETRY_MS) return null;
    loginRead = (async () => {
      try {
        const gql = await githubGql();
        const data = (await gql(VIEWER_QUERY, {})) as { viewer?: { login?: unknown } };
        const login = data?.viewer?.login;
        if (typeof login === "string" && login !== "") githubLogin = login;
      } catch {
        // not signed in to gh, or GitHub unreachable: the view says null
      }
      if (githubLogin === null) loginFailedAt = now();
      loginRead = null;
      return githubLogin;
    })();
    return loginRead;
  };
  const refreshBoards = deps.refreshBoards ?? (() => bus.emit("boards"));
  const machine = deps.machine ?? (() => null);
  const readTranscript = deps.readStream ?? readStreamPage;
  const worktreeFiles = deps.changedFiles ?? changedFiles;
  const worktreeDiff = deps.fileDiff ?? fileDiff;
  const streamCache = new Map<string, StreamCacheEntry>();

  const app = Fastify({
    bodyLimit: 16 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    logger: deps.logger
      ? {
          level: "info",
          redact: LOG_REDACT,
          ...(typeof deps.logger === "object" ? { stream: deps.logger.stream } : {}),
        }
      : false,
  });

  const requestErrors = new WeakMap<object, Error>();
  app.addHook("onError", async (req, _reply, error) => {
    requestErrors.set(req, error);
  });

  // Routes that translate exceptions into response objects must retain the caught
  // error before Fastify serializes the public (sometimes deliberately generic) text.
  const captureError = (reply: FastifyReply, error: unknown) => {
    requestErrors.set(reply.request, error instanceof Error ? error : new Error(String(error)));
  };

  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode >= 400 || reply.elapsedTime > 1000) {
      // path only: a query string is the caller's, and the operator token travels as a header
      const fields = {
        res: reply,
        responseTime: reply.elapsedTime,
        method: req.method,
        url: req.url.split("?")[0],
      };
      if (reply.statusCode >= 500) {
        req.log.error(
          { ...fields, err: requestErrors.get(req) ?? new Error(`HTTP ${reply.statusCode}`) },
          "request completed",
        );
      } else {
        req.log.warn(fields, "request completed");
      }
    }
  });

  // DNS-rebinding defence: a page on another name that resolves to 127.0.0.1 sends its own Host.
  app.addHook("onRequest", async (req, reply) => {
    if (!LOCAL_HOSTS.has((req.hostname ?? "").toLowerCase())) {
      return reply.code(421).send({ error: "unexpected host" });
    }
  });

  // CSRF defence (there is no login, so these are the only cross-site guard): a cross-site form
  // cannot send application/json, and a cross-site fetch carries a foreign Origin.
  app.addHook("onRequest", async (req, reply) => {
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const hasBody =
      Number(req.headers["content-length"] ?? 0) > 0 ||
      req.headers["transfer-encoding"] !== undefined;
    const previewActivity = req.routeOptions.url === "/api/previews/:pr/activity";
    if (
      mutating &&
      (req.method !== "DELETE" || hasBody) &&
      !previewActivity &&
      mediaType(req.headers["content-type"]) !== "application/json"
    ) {
      return reply
        .code(415)
        .send({ error: `${req.method} requires Content-Type: application/json` });
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      origin !== undefined &&
      !isLocalOrigin(origin)
    ) {
      return reply.code(403).send({ error: "cross-origin request refused" });
    }
  });

  // A cross-site no-cors GET (an <img>, fetch with
  // mode: "no-cors") carries no Origin. The page cannot read the answer, but it could drain the
  // GitHub rate limit or spawn gh and git. Browsers mark such a request Sec-Fetch-Site: cross-site;
  // callers that send no header (the guard hook, curl) are unaffected. The matched route is
  // checked because the router decodes %XX in the path, so the raw URL may not start with /api/.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.routeOptions.url ?? req.url;
    if (path.startsWith("/api/") && req.headers["sec-fetch-site"] === "cross-site") {
      return reply.code(403).send({ error: "cross-site request refused" });
    }
  });

  // A preview child owns no live loop. Its parent uses these pings only to expire an unused child.
  app.addHook("onRequest", async () => deps.previewActivity?.());

  // Code on the machine and a bad HUD bundle can reach every mutating route; only the page the
  // hub served can read the operator token (bootstrap route), so holding it is the key. The guard
  // check keeps its own run token; /mcp is outside /api.
  const operatorToken = deps.operatorToken;
  if (operatorToken !== undefined) {
    app.addHook("onRequest", async (req, reply) => {
      const path = req.routeOptions.url ?? req.url;
      if (
        req.method !== "GET" &&
        req.method !== "HEAD" &&
        req.method !== "OPTIONS" &&
        path.startsWith("/api/") &&
        path !== GUARD_CHECK_PATH &&
        !(
          path === "/api/previews/:pr/activity" &&
          req.headers[PREVIEW_ACTIVITY_HEADER] !== undefined
        ) &&
        !operatorTokenMatches(operatorToken, req.headers[OPERATOR_HEADER])
      ) {
        return reply.code(401).send({ error: OPERATOR_TOKEN_REQUIRED });
      }
    });
  }

  // Unmatched GET/HEAD outside /api: the web app.
  const serveWeb = deps.webRoot ? webHandler(deps.webRoot) : null;
  app.setNotFoundHandler((req, reply) => {
    if (serveWeb && (req.method === "GET" || req.method === "HEAD")) return serveWeb(req, reply);
    return reply.code(404).send({ error: "not found" });
  });

  if (deps.tokens) {
    registerMcp(app, {
      tokens: deps.tokens,
      ...(deps.mcpCalls === undefined ? {} : { calls: deps.mcpCalls }),
      mcpTools: deps.mcpTools ?? (() => []),
      seatMode: deps.seatMode ?? (() => "read-only"),
      ...(deps.seatGrants === undefined ? {} : { seatGrants: deps.seatGrants }),
      ...(deps.runGrants === undefined ? {} : { runGrants: deps.runGrants }),
    });
  }

  // These aggregates repeat expensive store/filesystem reads. Topics invalidate immediately;
  // the short TTL also refreshes elapsed times and files changed outside the collectors.
  const responseCache = new Map<string, { payload: string; at: number; stamp: string }>();
  const responseStamp = () => {
    let profiles = "";
    if (deps.profilesPath !== undefined) {
      try {
        const file = statSync(deps.profilesPath);
        profiles = `${file.mtimeMs}:${file.ctimeMs}:${file.size}`;
      } catch {
        /* A missing profiles file uses the built-ins. */
      }
    }
    return JSON.stringify([
      store.readVersion(),
      config,
      profiles,
      deps.lock?.state(),
      deps.hubLogin?.(),
    ]);
  };
  let responseRevision = 0;
  const revisions = new WeakMap<object, { revision: number; stamp: string }>();
  const cachedPaths = new Set(["/api/telemetry", "/api/attention", "/api/config"]);
  app.addHook("preHandler", async (req, reply) => {
    if (req.method !== "GET" || !cachedPaths.has(req.url.split("?")[0] ?? "")) return;
    const stamp = responseStamp();
    revisions.set(req, { revision: responseRevision, stamp });
    const cached = responseCache.get(req.url);
    if (cached && cached.stamp === stamp && now() - cached.at < 10_000)
      return reply.type("application/json").send(cached.payload);
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const started = revisions.get(req);
    if (
      !started ||
      started.revision !== responseRevision ||
      reply.statusCode !== 200 ||
      typeof payload !== "string"
    )
      return;
    // Telemetry may fill only part of its commit cache this call; keep reading next time.
    if (started.stamp !== responseStamp()) return;
    const cached = responseCache.get(req.url);
    if (cached && cached.stamp === started.stamp && now() - cached.at < 10_000) return;
    if (responseCache.size >= 64) responseCache.clear();
    responseCache.set(req.url, { payload, at: now(), stamp: started.stamp });
  });

  // The configured crew changes only through routes and reloads, which emit one of these topics.
  // Keep a small local revision rather than serialising the full config for every GET /api/crew.
  let crewRevision = 0;
  const crewTopics = new Set<Topic>([
    "agents",
    "boards",
    "escalations",
    "health",
    "settings",
    "config",
    "guard",
  ]);
  let crewMemo: { bucket: number; revision: number; lockKey: string; value: Crew } | undefined;
  const sharedCrew = (at = now()): Crew => {
    const bucket = Math.floor(at / HUD_MEMO_MS);
    const lock = deps.lock?.state() ?? NO_LOCK;
    const lockKey = JSON.stringify(lock);
    if (
      crewMemo?.bucket !== bucket ||
      crewMemo.revision !== crewRevision ||
      crewMemo.lockKey !== lockKey
    )
      crewMemo = { bucket, revision: crewRevision, lockKey, value: crew(config, store, at, lock) };
    return crewMemo.value;
  };

  let crewSummaryMemo:
    | { bucket: number; revision: number; lockKey: string; value: Crew }
    | undefined;
  /** The Overview's crew: built without event timelines, so a many-run hub does not pay for them. */
  const sharedCrewSummary = (at = now()): Crew => {
    const bucket = Math.floor(at / HUD_MEMO_MS);
    const lock = deps.lock?.state() ?? NO_LOCK;
    const lockKey = JSON.stringify(lock);
    if (
      crewSummaryMemo?.bucket !== bucket ||
      crewSummaryMemo.revision !== crewRevision ||
      crewSummaryMemo.lockKey !== lockKey
    )
      crewSummaryMemo = {
        bucket,
        revision: crewRevision,
        lockKey,
        value: crew(config, store, at, lock, undefined, true),
      };
    return crewSummaryMemo.value;
  };

  let attentionMemo: { at: number; items: AttentionItem[] } | undefined;
  const sharedAttention = (): AttentionItem[] => {
    const at = now();
    if (!attentionMemo || at - attentionMemo.at >= HUD_MEMO_MS) {
      attentionMemo = {
        at,
        items: attentionItems(
          config,
          store,
          at,
          deps.lock?.state() ?? NO_LOCK,
          sharedCrew(at).rows,
          deps.hubLogin?.() ?? null,
        ),
      };
    }
    return attentionMemo.items;
  };
  const notifications = new LocalNotifications(store, config, bus, now);
  const reconcileNotifications = () => notifications.reconcile(sharedAttention());
  let notificationTimer: ReturnType<typeof setTimeout> | undefined;
  let reconcilingNotifications = false;
  const scheduleNotifications = () => {
    if (notificationTimer !== undefined || reconcilingNotifications) return;
    notificationTimer = setTimeout(() => {
      notificationTimer = undefined;
      reconcilingNotifications = true;
      try {
        reconcileNotifications();
      } finally {
        reconcilingNotifications = false;
      }
    }, NOTIFICATION_RECONCILE_MS);
    notificationTimer.unref();
  };
  const unsubscribeNotifications = bus.subscribe((topic) => {
    if (topic !== "machine") {
      responseRevision++;
      responseCache.clear();
      attentionMemo = undefined;
      forgetViews(store);
    }
    if (crewTopics.has(topic)) {
      crewRevision++;
      crewMemo = undefined;
    }
    if (["attention", "agents", "limits", "boards", "escalations", "settings"].includes(topic))
      scheduleNotifications();
  });
  app.addHook("onReady", async () => {
    scheduleNotifications();
  });
  app.addHook("onReady", async () => {
    // Map work starts from a map SSE subscription, not from the idle hub lifecycle.
  });
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => {
    unsubscribeNotifications();
    stopMapRing?.();
    clearTimeout(notificationTimer);
    for (const end of [...streams]) end();
  });

  app.register(
    async (api) => {
      api.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found" }));

      const loopById = (id: string) => config.loops.find((l) => l.id === id);
      const agentById = (id: string) => configuredAgents(config).find((a) => a.id === id);

      api.get<{ Params: { id: string }; Querystring: { limit?: unknown } }>(
        "/agents/:id/runs",
        async (req, reply) => {
          const limit = parseLimit(req.query.limit, DEFAULT_RUNS_LIMIT, MAX_RUNS_LIMIT);
          if (limit === null) {
            return reply.code(400).send({ error: `limit must be an integer 1..${MAX_RUNS_LIMIT}` });
          }
          if (!agentIds(config).includes(req.params.id)) {
            return reply.code(404).send({ error: "unknown agent" });
          }
          const cache: PrCache = new Map();
          const boards: BoardTitleCache = new Map();
          return store
            .runs(req.params.id, limit)
            .map((r): RunView => runView(config, store, r, cache, boards));
        },
      );

      // The latest run's transcript (a loop's or a seat's), read on demand. Responses carry fixed
      // text, never the path.
      // `?before=<event id>`: the events ahead of that one, for the dock's older-on-scroll (#1192).
      api.get<{ Params: { id: string }; Querystring: { limit?: unknown; before?: unknown } }>(
        "/agents/:id/stream",
        async (req, reply): Promise<AgentStream | FastifyReply> => {
          const limit = parseLimit(req.query.limit, DEFAULT_STREAM_LIMIT, MAX_STREAM_LIMIT);
          if (limit === null) {
            return reply
              .code(400)
              .send({ error: `limit must be an integer 1..${MAX_STREAM_LIMIT}` });
          }
          const { before } = req.query;
          if (before !== undefined && (typeof before !== "string" || !/^\d+:\d+$/.test(before))) {
            return reply.code(400).send({ error: "before must be an event id" });
          }
          const agent = agentById(req.params.id);
          if (!agent) return reply.code(404).send({ error: "unknown agent" });
          const run = store.seatRun(agent.id);
          if (!run) {
            return {
              runId: null,
              events: [],
              truncated: false,
              lastOutputAt: null,
              reason: NO_RUNS_YET,
            };
          }
          const lastEventAt = store.digest(run.id)?.lastEventAt ?? null;
          const missing = (): AgentStream => ({
            runId: run.id,
            tasks: store.digest(run.id)?.tasks ?? [],
            events: [],
            truncated: false,
            lastOutputAt: lastOutputAt(lastEventAt, null),
            reason: TRANSCRIPT_NOT_FOUND,
          });
          const path = run.transcriptPath;
          if (path === "") return missing();
          const st = await stat(transcriptFilePath(path)).catch(() => null);
          if (!st?.isFile()) return missing();
          const { size, mtimeMs } = st;
          let entry = streamCache.get(agent.id);
          if (
            !entry ||
            entry.path !== path ||
            entry.size !== size ||
            entry.mtimeMs !== mtimeMs ||
            entry.limit !== limit ||
            entry.before !== before
          ) {
            let result: StreamCacheEntry["result"];
            try {
              result =
                before === undefined
                  ? readTranscript(path, limit, run.vendor)
                  : readTranscript(path, limit, run.vendor, before);
            } catch {
              return missing();
            }
            entry = { path, size, mtimeMs, limit, before, result };
            streamCache.set(agent.id, entry);
          }
          return {
            runId: run.id,
            tasks: store.digest(run.id)?.tasks ?? [],
            events: entry.result.events,
            truncated: entry.result.truncated,
            hasMore: entry.result.more ?? false,
            lastOutputAt: lastOutputAt(lastEventAt, Math.floor(mtimeMs)),
            reason: null,
          };
        },
      );

      // Reader: apps/web/src/pages/Comms.tsx#Comms (unanswered questions and blockers)
      api.get("/comms/open", () => {
        const at = now();
        return {
          items: store.openCommsItems().map((item) => {
            const flightAt = item.at + COMMS_FLIGHT_ESCALATION_MS;
            const atFlight = at >= flightAt;
            return {
              id: item.id,
              label: item.label,
              from: item.from,
              to: item.to,
              ticket: item.ticket,
              waitedMs: Math.max(0, at - item.at),
              nextStep: atFlight ? ("flight-not-triaging" as const) : ("flight" as const),
              nextAt: atFlight ? flightAt + COMMS_CAPCOM_ESCALATION_MS : flightAt,
            };
          }),
        };
      });
      // Reader: apps/web/src/comms/Conversation.tsx (thread snapshot)
      api.get<{ Params: { id: string } }>("/comms/:id", async (req, reply) => {
        if (!agentById(req.params.id)) return reply.code(404).send({ error: "unknown agent" });
        return {
          messages: threadMessages(store, req.params.id, agentById(req.params.id)?.kind === "crew"),
        };
      });

      // Reader: apps/web/src/comms/Conversation.tsx (opening a thread)
      api.post<{ Params: { id: string } }>("/comms/:id/read", async (req, reply) => {
        const id = req.params.id;
        if (!agentById(id)) return reply.code(404).send({ error: "unknown agent" });
        const body = z
          .object({ messageIds: z.array(z.string().max(300)).max(COMMS_SNAPSHOT_LIMIT) })
          .strict()
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        const latest = new Map<string, { offset: number; block: number }>();
        for (const message of threadMessages(store, id, agentById(id)?.kind === "crew")) {
          const p = commsPosition(message.id);
          if (!p) continue;
          const prev = latest.get(p.source);
          if (!prev || p.offset > prev.offset || (p.offset === prev.offset && p.block > prev.block))
            latest.set(p.source, p);
        }
        const valid = body.data.messageIds.every((key) => {
          if (!store.threadOwnsMessage(id, key)) return false;
          const p = commsPosition(key);
          const last = p && latest.get(p.source);
          if (p && !last && p.source.startsWith("stream:")) {
            const run = store.run(p.source.slice("stream:".length));
            if (!run?.transcriptPath) return false;
            try {
              // With no messages left, only positions before the current event window
              // may be stale snapshot IDs. Future offsets must still be rejected.
              const first = readStream(run.transcriptPath, 200, run.vendor).events[0];
              const boundary = first && commsPosition(`stream:${run.id}:${first.id}`);
              return boundary !== null && boundary !== undefined && p.offset < boundary.offset;
            } catch {
              return false;
            }
          }
          return (
            p &&
            last &&
            (p.offset < last.offset || (p.offset === last.offset && p.block <= last.block))
          );
        });
        if (!valid) return reply.code(400).send({ error: "unknown thread message" });
        store.markThreadRead(id, body.data.messageIds);
        bus.emit("attention");
        bus.emit("agents");
        return { ok: true };
      });

      const commsCrew = () =>
        configuredAgents(config)
          .filter((agent) => agent.kind === "crew")
          .map((agent) => agent.id);
      const commsSendBody = z.strictObject({
        to: z.string().min(1),
        text: z.string().min(1).max(COMMS_MESSAGE_MAX),
        label: z.enum(COMMS_LABELS).optional(),
        ref: z.string().regex(COMMS_REF).optional(),
        replyTo: z
          .string()
          .regex(/^comms:\d+$/)
          .optional(),
      });
      // Reader: apps/web/src/App.tsx#App (operator messages)
      api.post("/comms", async (req, reply) => {
        const body = commsSendBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        try {
          const message = await sendComms(
            {
              store,
              crew: commsCrew,
              knownSecrets: deps.knownSecrets ?? (async () => []),
              now,
              seatSender: false,
              notify: (seatId, text, from) => deps.deliverComms?.(seatId, text, from),
            },
            COMMS_CAPCOM,
            body.data,
          );
          bus.emit("agents");
          bus.emit("attention");
          return { message };
        } catch (e) {
          return reply
            .code(400)
            .send({ error: e instanceof Error ? e.message : "Comms message refused." });
        }
      });
      // Reader: apps/web/src/App.tsx#App (operator reactions)
      api.post<{ Params: { id: string } }>("/comms/:id/reactions", async (req, reply) => {
        if (commsMessageNumber(req.params.id) === null)
          return reply.code(400).send({ error: "invalid Comms message id" });
        const body = z
          .strictObject({
            reaction: z.enum(COMMS_REACTIONS),
            reason: z.string().max(COMMS_CANT_REASON_MAX).optional(),
          })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        try {
          const reaction = reactComms(
            store,
            COMMS_CAPCOM,
            req.params.id,
            body.data.reaction,
            body.data.reason,
            now(),
          );
          bus.emit("agents");
          bus.emit("attention");
          return { reaction };
        } catch (e) {
          return reply
            .code(400)
            .send({ error: e instanceof Error ? e.message : "Comms reaction refused." });
        }
      });
      const pinRoute =
        (pinned: boolean) =>
        async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
          if (commsMessageNumber(req.params.id) === null)
            return reply.code(400).send({ error: "invalid Comms message id" });
          try {
            pinComms(store, COMMS_CAPCOM, req.params.id, pinned, now());
            bus.emit("agents");
            return { pinned };
          } catch (e) {
            return reply
              .code(404)
              .send({ error: e instanceof Error ? e.message : "Unknown Comms message." });
          }
        };
      // Reader: apps/web/src/App.tsx#App (operator pins)
      api.put<{ Params: { id: string } }>("/comms/:id/pin", pinRoute(true));
      // Reader: apps/web/src/App.tsx#App (operator pins)
      api.delete<{ Params: { id: string } }>("/comms/:id/pin", pinRoute(false));

      const storedCommsMessage = (
        row: ReturnType<Store["commsMessage"]>,
        pins: ReadonlySet<string> = new Set(store.commsPins().map((pin) => pin.id)),
      ) => {
        if (row === null) throw new Error("Unknown Comms message.");
        return {
          ...row,
          reactions: store.commsReactions(row.id),
          pinned: pins.has(row.id),
          operator: row.from === COMMS_CAPCOM,
        };
      };
      const storedCommsMessages = (rows: ReturnType<Store["commsForCrew"]>) => {
        const pins = new Set(store.commsPins().map((pin) => pin.id));
        return rows.map((row) => storedCommsMessage(row, pins));
      };
      const knownCommsAgent = (id: string) => commsCrew().includes(id) || id === COMMS_CAPCOM;
      const pairScope = (a: string, b: string) => `pair:${[a, b].sort().join(":")}`;
      /** `?limit=&before=` of a Comms read; null when either is malformed (the caller answers 400). */
      const commsPaging = (query: {
        limit?: unknown;
        before?: unknown;
      }): { limit: number; before: string | undefined } | null => {
        const limit = parseLimit(query.limit, COMMS_PAGE_DEFAULT, COMMS_PAGE_MAX);
        const { before } = query;
        if (limit === null) return null;
        if (
          before !== undefined &&
          (typeof before !== "string" || !/^comms:[1-9]\d*$/.test(before))
        )
          return null;
        return { limit, before };
      };
      const COMMS_PAGING_ERROR = `limit must be an integer 1..${COMMS_PAGE_MAX}; before must be a message id`;
      /** One page of a scope: the newest messages, the read cursor, unread over the whole scope. */
      const commsScopePage = (
        scope: CommsReadScope,
        cursorKey: string,
        paging: { limit: number; before: string | undefined },
        countsOnly = false,
      ) => {
        const page = countsOnly
          ? { rows: [], hasMore: false }
          : store.commsPage(scope, paging.limit, paging.before);
        const cursor = store.commsScopeCursor(cursorKey);
        return {
          messages: storedCommsMessages(page.rows),
          hasMore: page.hasMore,
          cursor,
          unread: store.commsCounts(scope, cursor).unread,
        };
      };
      const commsScope = (
        scope: string,
      ): { key: string; rows: ReturnType<Store["commsForCrew"]> } | null => {
        if (scope === "crew") return { key: scope, rows: store.commsForCrew() };
        const flight = flightSeat(config)?.seat.id;
        if (scope === "flight")
          return {
            key: scope,
            rows: flight === undefined ? [] : store.commsForPair(COMMS_CAPCOM, flight),
          };
        const agent = scope.match(/^agent-all:([A-Za-z0-9_-]+)$/)?.[1];
        if (agent !== undefined && knownCommsAgent(agent))
          return { key: `agent-all:${agent}`, rows: store.commsForAgent(agent) };
        const inbox = scope.match(/^inbox:([A-Za-z0-9_-]+)$/)?.[1];
        if (inbox !== undefined && knownCommsAgent(inbox))
          return { key: `inbox:${inbox}`, rows: store.commsInbox(inbox) };
        const pair = scope.match(/^pair:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/);
        if (pair !== null && knownCommsAgent(pair[1]) && knownCommsAgent(pair[2]))
          return { key: pairScope(pair[1], pair[2]), rows: store.commsForPair(pair[1], pair[2]) };
        return null;
      };

      // Reader: apps/web/src/App.tsx#App (crew Comms)
      api.get<{ Querystring: { limit?: unknown; before?: unknown } }>(
        "/comms/crew",
        (req, reply) => {
          const paging = commsPaging(req.query);
          if (paging === null) return reply.code(400).send({ error: COMMS_PAGING_ERROR });
          return commsScopePage({ crew: true }, "crew", paging);
        },
      );
      // Reader: apps/web/src/App.tsx#App (FLIGHT Comms)
      api.get<{ Querystring: { limit?: unknown; before?: unknown } }>(
        "/comms/flight",
        (req, reply) => {
          const paging = commsPaging(req.query);
          if (paging === null) return reply.code(400).send({ error: COMMS_PAGING_ERROR });
          const flight = flightSeat(config)?.seat.id;
          if (flight === undefined)
            return { messages: [], hasMore: false, cursor: null, unread: 0 };
          return commsScopePage({ pair: [COMMS_CAPCOM, flight] }, "flight", paging);
        },
      );
      // Reader: apps/web/src/App.tsx#App (agent Comms)
      api.get<{
        Params: { id: string };
        Querystring: { limit?: unknown; before?: unknown; summary?: unknown };
      }>("/comms/agents/:id", (req, reply) => {
        const id = req.params.id;
        if (!knownCommsAgent(id)) return reply.code(404).send({ error: "unknown Comms agent" });
        const paging = commsPaging(req.query);
        if (paging === null) return reply.code(400).send({ error: COMMS_PAGING_ERROR });
        const { summary } = req.query;
        if (summary !== undefined && summary !== "1")
          return reply.code(400).send({ error: "summary must be 1" });
        // `?summary=1`: the conversation list and counts only, no messages (the nav rows' read).
        const none = { rows: [], hasMore: false };
        const all = commsScopePage({ agent: id }, `agent-all:${id}`, paging, summary === "1");
        const inboxCursor = store.commsScopeCursor(`inbox:${id}`);
        const inbox =
          summary === "1" ? none : store.commsPage({ inbox: id }, paging.limit, paging.before);
        // The conversation list: one line per contact, from counts, never their histories.
        const contacts = store
          .commsContactIds(id)
          .filter((contact) => contact !== id && contact !== COMMS_CREW)
          .map((contact) => {
            const scope: CommsReadScope = { pair: [id, contact] };
            const counts = store.commsCounts(scope, store.commsScopeCursor(pairScope(id, contact)));
            const last = store.commsPage(scope, 1).rows[0];
            return {
              id: contact,
              lastMessage: last === undefined ? null : storedCommsMessage(last),
              count: counts.count,
              unread: counts.unread,
            };
          });
        return {
          ...all,
          inbox: storedCommsMessages(inbox.rows),
          inboxHasMore: inbox.hasMore,
          contacts,
          inboxCursor,
          inboxUnread: store.commsCounts({ inbox: id }, inboxCursor).unread,
          // Needs you no longer counts direct-line replies; the thread does (#757)
          directUnread:
            id === COMMS_CAPCOM
              ? 0
              : threadMessages(store, id, true, "attention").filter((m) => !m.seen && m.direct)
                  .length,
        };
      });
      // Reader: apps/web/src/App.tsx#App (agent contact Comms)
      api.get<{
        Params: { id: string; contact: string };
        Querystring: { limit?: unknown; before?: unknown };
      }>("/comms/agents/:id/contacts/:contact", (req, reply) => {
        if (!knownCommsAgent(req.params.id) || !knownCommsAgent(req.params.contact))
          return reply.code(404).send({ error: "unknown Comms agent" });
        const paging = commsPaging(req.query);
        if (paging === null) return reply.code(400).send({ error: COMMS_PAGING_ERROR });
        return commsScopePage(
          { pair: [req.params.id, req.params.contact] },
          pairScope(req.params.id, req.params.contact),
          paging,
        );
      });
      // Reader: apps/web/src/App.tsx#App (pair Comms)
      api.get<{
        Params: { a: string; b: string };
        Querystring: { limit?: unknown; before?: unknown };
      }>("/comms/pairs/:a/:b", (req, reply) => {
        if (!knownCommsAgent(req.params.a) || !knownCommsAgent(req.params.b))
          return reply.code(404).send({ error: "unknown Comms agent" });
        const paging = commsPaging(req.query);
        if (paging === null) return reply.code(400).send({ error: COMMS_PAGING_ERROR });
        return commsScopePage(
          { pair: [req.params.a, req.params.b] },
          pairScope(req.params.a, req.params.b),
          paging,
        );
      });
      // Reader: apps/web/src/App.tsx#App (ticket Comms)
      api.get<{ Params: { ref: string }; Querystring: { ticket?: string } }>(
        "/comms/tickets/:ref",
        (req, reply) => {
          const supplied = decodeURIComponent(req.params.ref);
          if (!COMMS_REF.test(supplied))
            return reply.code(400).send({ error: "invalid Comms ref" });
          if (req.query.ticket !== undefined && !COMMS_TICKET.test(req.query.ticket))
            return reply.code(400).send({ error: "invalid Comms ticket" });
          const context = store.commsForTicket(supplied, req.query.ticket);
          const issueNumber = context.ref.startsWith("#") ? Number(context.ref.slice(1)) : null;
          const board =
            issueNumber === null ||
            context.repoId === null ||
            !config.repos.some((repo) => repo.id === context.repoId)
              ? undefined
              : store.board(context.repoId).find((item) => item.issueNumber === issueNumber);
          return {
            messages: storedCommsMessages(context.rows),
            ticket: {
              ref: context.ref,
              linkedPr: context.linkedPr,
              title: board?.title ?? null,
              status: board?.status ?? null,
              owner: board?.owner ?? null,
              repoId: board?.repoId ?? null,
              issueNumber: board?.issueNumber ?? null,
            },
          };
        },
      );
      // Reader: apps/web/src/App.tsx#App (CAPCOM mentions)
      api.get("/comms/mentions", () => ({
        mentions: store.commsMentions(COMMS_CAPCOM).map((row) => ({
          message: storedCommsMessage(row),
          seen: store.commsMentionSeen(COMMS_CAPCOM, row.id),
        })),
      }));
      // Reader: apps/web/src/App.tsx#App (CAPCOM mention read state)
      api.post("/comms/mentions/seen", (req, reply) => {
        const body = z
          .strictObject({ ids: z.array(z.string().regex(/^comms:\d+$/)).max(500) })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        if (body.data.ids.some((id) => store.commsMessage(id) === null))
          return reply.code(400).send({ error: "unknown Comms message" });
        store.markCommsMentionsSeen(COMMS_CAPCOM, body.data.ids, now());
        return { ok: true };
      });
      // Reader: apps/web/src/App.tsx#App (pinned Comms)
      api.get("/comms/pins", () => ({ messages: storedCommsMessages(store.commsPins()) }));
      // Reader: apps/web/src/comms/CommsGraph.tsx (Comms link activity and newest-message preview)
      api.get("/comms/links", () => {
        // The preview only where both ends are ones the Comms routes already serve; a removed
        // seat's link keeps its count but not its words.
        const served = (id: string) => knownCommsAgent(id) || id === COMMS_CREW || id === COMMS_MC;
        return {
          links: store
            .commsLinkCounts(now() - 24 * 60 * 60 * 1000, now())
            .map((link) =>
              served(link.from) && served(link.to)
                ? link
                : { from: link.from, to: link.to, count: link.count },
            ),
        };
      });
      // Reader: apps/web/src/comms/CommsGraph.tsx (24 hour Comms Traffic bars)
      api.get("/comms/traffic", () => ({
        hours: store.commsHourlyLinkCounts(now() - 24 * 60 * 60 * 1000),
      }));
      // Reader: apps/web/src/comms/CommsGraph.tsx (ticket conversations needing FLIGHT)
      api.get("/comms/chatter", () => ({
        pairs: store.commsChatter(
          now() - COMMS_CHATTER_WINDOW_MS,
          now(),
          flightSeat(config)?.seat.id,
        ),
      }));
      // Reader: apps/web/src/App.tsx#App (Comms read cursors)
      api.post("/comms/read", (req, reply) => {
        const body = z
          .strictObject({
            scope: z.string().min(1).max(200),
            messageId: z.string().regex(/^comms:\d+$/),
          })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        const scope = commsScope(body.data.scope);
        if (scope === null || !scope.rows.some((row) => row.id === body.data.messageId))
          return reply.code(400).send({ error: "invalid Comms read cursor" });
        store.markCommsScopeRead(scope.key, body.data.messageId);
        return { ok: true };
      });

      const isSeat = (id: string) => agentById(id)?.kind === "crew";

      /**
       * Where a writer seat's files are read: its worktree (the seat's own, else the one its run
       * set aside in review is in), and a git runner that goes through `crewGit`, so the worktree
       * must still be the clone's own (a seat can write its `.git` pointer). Null: no such worktree.
       */
      const seatTree = async (
        id: string,
      ): Promise<{ worktree: string; exec: GitExec; redirected: () => boolean } | null> => {
        const agent = agentById(id);
        if (agent?.kind !== "crew") return null;
        const checkout = config.crew?.sessions.find((s) => s.id === agent.sessionId)?.checkout;
        const worktree =
          store.seatSession(id)?.worktree ?? store.seatRun(id)?.loop?.aside?.worktree;
        if (!checkout || !worktree) return null;
        const isDir = await stat(worktree).then(
          (st) => st.isDirectory(),
          () => false,
        );
        const common = isDir ? await realpath(join(checkout, ".git")).catch(() => null) : null;
        const gitDir =
          common === null ? null : await adminDirOf(common, worktree).catch(() => null);
        if (common === null || gitDir === null) return null;
        let redirected = false;
        const exec: GitExec = (args) =>
          crewGit(worktree, args, common, { gitDir }).catch((e: unknown) => {
            if (e instanceof CrewGitError) redirected = true;
            throw e;
          });
        return { worktree, exec, redirected: () => redirected };
      };

      // Read-only git in the loop's or the writer seat's worktree, on demand. Responses carry fixed
      // text, never the path.
      api.get<{ Params: { id: string } }>(
        "/agents/:id/files",
        async (req, reply): Promise<ChangedFiles | FastifyReply> => {
          let worktree: string;
          let exec: GitExec | undefined;
          let redirected = () => false;
          if (isSeat(req.params.id)) {
            if (crewSeatMode(config, req.params.id) !== "writer") {
              return { files: [], note: READONLY_FILES_NOTE, sha: null };
            }
            const tree = await seatTree(req.params.id);
            if (tree === null) return { files: [], note: NO_WORKTREE_NOTE, sha: null };
            ({ worktree, exec, redirected } = tree);
          } else {
            const loop = loopById(req.params.id);
            if (!loop) return reply.code(404).send({ error: "unknown agent" });
            const isDir = await stat(loop.worktree).then(
              (st) => st.isDirectory(),
              () => false,
            );
            if (!isDir) return reply.code(503).send({ error: "worktree missing" });
            worktree = loop.worktree;
          }
          try {
            return await worktreeFiles(worktree, exec);
          } catch (e) {
            captureError(reply, e);
            const git = e instanceof GitFailed ? e : null;
            // The filter check's fixed note survives a total failure, unless git never ran at all
            // because the checkout's git dir is not the clone's.
            return reply
              .code(502)
              .send(
                git?.note && !redirected()
                  ? { error: "git failed", note: git.note }
                  : { error: "git failed" },
              );
          }
        },
      );

      // One listed file's diff: the path must be in the current list, so no other path is read.
      api.get<{ Params: { id: string }; Querystring: { path?: unknown } }>(
        "/agents/:id/files/diff",
        async (req, reply): Promise<FileDiff | FastifyReply> => {
          let worktree: string;
          let exec: GitExec | undefined;
          const seat = isSeat(req.params.id);
          const loop = loopById(req.params.id);
          if (!seat && !loop) return reply.code(404).send({ error: "unknown agent" });
          const path = DiffPath.safeParse(req.query.path);
          if (!path.success) return reply.code(400).send({ error: "path required" });
          if (loop === undefined) {
            // a read-only seat, or one with no worktree, has no file to show
            const tree =
              crewSeatMode(config, req.params.id) === "writer"
                ? await seatTree(req.params.id)
                : null;
            if (tree === null) return reply.code(404).send({ error: "unknown file" });
            ({ worktree, exec } = tree);
          } else {
            const isDir = await stat(loop.worktree).then(
              (st) => st.isDirectory(),
              () => false,
            );
            if (!isDir) return reply.code(503).send({ error: "worktree missing" });
            worktree = loop.worktree;
          }
          let diff: FileDiff | null;
          try {
            diff = await worktreeDiff(worktree, path.data, exec);
          } catch (e) {
            captureError(reply, e);
            return reply.code(502).send({ error: "git failed" });
          }
          if (diff === null) return reply.code(404).send({ error: "unknown file" });
          return diff;
        },
      );

      // The guard (spec §5): the hook asks before every tool call, with its run's token.
      const tokens = deps.tokens;
      const lock = deps.lock;
      const checks = deps.checks;
      const seatMode = deps.seatMode ?? (() => "read-only");
      const caller = (req: FastifyRequest) => tokens?.resolve(bearer(req)) ?? null;
      // Reader: apps/server/src/guard/hook.ts (the guard hook each seat's CLI runs before every tool call)
      api.post(
        GUARD_CHECK_ROUTE,
        {
          bodyLimit: GUARD_BODY_LIMIT,
          // before the body is parsed: an unknown caller is refused without being read
          onRequest: async (req, reply) => {
            if (caller(req) === null) return reply.code(401).send({ error: UNKNOWN_RUN });
          },
        },
        async (req, reply) => {
          const who = caller(req);
          // a seat no longer configured has no rules to judge it by
          const seat = configuredAgents(config).find(
            (a) => a.kind === "crew" && a.id === who?.seatId,
          );
          if (who === null || seat === undefined) {
            return reply.code(401).send({ error: UNKNOWN_RUN });
          }
          const body = GuardCheckBody.safeParse(req.body);
          if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
          const key = { runId: who.runId, toolUseId: body.data.tool_use_id };
          // the hook rebuilds what it prints; these are the only two bodies it accepts
          const answer = (deny?: string) =>
            reply
              .type("application/json")
              .send(deny === undefined ? GUARD_ALLOW_OUTPUT : guardDenyOutput(deny));
          if (body.data.hook_event_name !== "PreToolUse") {
            const failed = body.data.hook_event_name === "PostToolUseFailure";
            // a read that failed gave the seat nothing to scroll back to
            if (failed) store.forgetRunRead(who.runId, body.data.tool_use_id);
            lock?.release(key, failed);
            await checks?.end(key, !failed);
            return answer();
          }
          let verdict = crewGuardDecision(
            config,
            seat.repoId,
            seatMode(who.seatId),
            { tool: body.data.tool_name, input: body.data.tool_input ?? {} },
            deps.superuserTools,
            deps.runGrants?.(who) ?? deps.seatGrants?.(who.seatId),
            store.seatSession(who.seatId)?.worktree ?? undefined,
          );
          // a large file this run already read whole, unchanged, is not given again
          if (verdict.kind === "allow") {
            const reread = rereadDenial(
              store,
              { ...key, agentId: body.data.agent_id ?? "" },
              store.seatSession(who.seatId)?.worktree ?? undefined,
              { tool: body.data.tool_name, input: body.data.tool_input ?? {} },
              now(),
            );
            if (reread !== null) return answer(reread);
          }
          // a shell call the guard lets run: note the clone it starts on, for the check record
          const command = body.data.tool_input?.command;
          // a configured check (lint, typecheck) is as heavy as the suite: it takes the lock too
          if (
            verdict.kind === "allow" &&
            body.data.tool_name === "Bash" &&
            typeof command === "string"
          ) {
            const check = await checks?.lockedBy(who.runId, command);
            if (check) verdict = { kind: "lock", command: check };
          }
          if (
            verdict.kind !== "deny" &&
            body.data.tool_name === "Bash" &&
            typeof command === "string"
          ) {
            await checks?.begin(key, command);
          }
          if (verdict.kind === "allow") return answer();
          if (verdict.kind === "deny") {
            store.addGuardHit({
              agentId: who.seatId,
              runId: who.runId,
              rule: verdict.rule,
              text: verdict.text,
              at: now(),
            });
            bus.emit("guard");
            return answer(verdict.text);
          }
          if (lock === undefined) return answer(TEST_LOCK_UNAVAILABLE_TEXT);
          // The hook hung up (killed, or its CLI interrupted) when the reply closes unanswered. The
          // request's own close is not it: that fires once the body has been read.
          const res = reply.raw;
          const hungUp = new AbortController();
          const onClose = () => {
            if (!res.writableEnded) hungUp.abort();
          };
          res.on("close", onClose);
          try {
            const granted = await lock.acquire(
              key,
              who.seatId,
              verdict.command,
              LOCK_WAIT_MS,
              hungUp.signal,
            );
            if (granted && !hungUp.signal.aborted) {
              // `finish` means the answer was handed to the kernel, not that the hook received it.
              // On a real socket this release only catches an async gap between the send and the
              // end (the hook hung up after the grant, before the answer went out). A peer that dies
              // after `finish` is not seen here: `releaseRun` covers it.
              let delivered = false;
              res.once("finish", () => {
                delivered = true;
              });
              res.once("close", () => {
                if (!delivered) lock.release(key);
              });
              return answer();
            }
            // a grant that landed after the hang-up: nobody will run that call
            if (granted) lock.release(key);
            const h = lock.state().holder;
            return answer(
              lockBusyText(
                h === null ? "another seat" : seatCallSign(h.seatId),
                h?.command ?? "a full suite",
              ),
            );
          } finally {
            res.off("close", onClose);
          }
        },
      );

      // Reader: apps/web/src/data.ts#RESOURCES (testLock; the Machine panel's Test lock box reads label and usualMs in the Overview web follow-up)
      api.get(
        "/test-lock",
        async (): Promise<TestLockView> => lockView(config, store, lock?.state() ?? NO_LOCK, now()),
      );

      // Reader: apps/web/src/telemetry/CapacityGroup.tsx (the Test lock table), Kpis.tsx (Lock wait) and components/LockLines.tsx (usually about)
      api.get<{ Querystring: { days?: unknown } }>(
        "/test-lock/history",
        async (req, reply): Promise<TestLockHistory | FastifyReply> => {
          const days = qaDays(req.query.days, 7);
          if (days === null) return reply.code(400).send({ error: QA_DAYS_ERROR });
          const at = now();
          const runs = store.lockRuns(at - days * DAY_MS);
          const today = runs.filter(
            (r) => r.startedAt >= startOfLocalDay(at, config.operator.timezone),
          );
          return {
            runs,
            today: {
              runs: today.length,
              waitMs: today.reduce((sum, r) => sum + r.startedAt - r.queuedAt, 0),
            },
            usualMs: usualLockMs(runs),
          };
        },
      );

      // Reader: docs/runbook.md#qa-board-data (the CI run history behind the QA board's flaky-test and green-rate views)
      api.get<{ Querystring: { days?: unknown } }>(
        "/qa/ci-runs",
        async (req, reply): Promise<CiRunsView | FastifyReply> => {
          const days = qaDays(req.query.days, 7);
          if (days === null) return reply.code(400).send({ error: QA_DAYS_ERROR });
          return { runs: store.ciRuns(now() - days * DAY_MS) };
        },
      );

      // Reader: docs/runbook.md#qa-board-data (review findings and per-round RETRO summaries)
      api.get<{ Querystring: { days?: unknown } }>(
        "/qa/findings",
        async (req, reply): Promise<QaFindingsView | FastifyReply> => {
          const days = qaDays(req.query.days, 30);
          if (days === null) return reply.code(400).send({ error: QA_DAYS_ERROR });
          const since = now() - days * DAY_MS;
          return { findings: store.qaFindings(since), reviews: store.qaReviewRounds(since) };
        },
      );

      // Reader: docs/runbook.md#qa-board-data (milestones with due dates and progress)
      api.get(
        "/qa/milestones",
        async (): Promise<MilestonesView> => ({
          milestones: store.milestones(),
        }),
      );

      api.get<{ Querystring: { days?: unknown } }>(
        "/guard/hits",
        async (req, reply): Promise<GuardHitsView | FastifyReply> => {
          const raw = req.query.days;
          const days =
            raw === undefined
              ? GUARD_WINDOW_DAYS
              : typeof raw === "string" && GUARD_DAYS.test(raw) && Number(raw) <= MAX_GUARD_DAYS
                ? Number(raw)
                : null;
          if (days === null) {
            return reply.code(400).send({ error: `days must be an integer 1..${MAX_GUARD_DAYS}` });
          }
          const since = now() - days * DAY_MS;
          const acks = store.acks();
          return {
            hits: store.guardHits(since, GUARD_HITS_LIMIT).map((h) => ({
              ...h,
              acked: acks.has(guardAckKey(h.id)),
            })),
            counts: store.guardHitCounts(since),
          };
        },
      );

      // Reader: apps/web/src/setup/Accounts.tsx (account status)
      api.get("/accounts/status", async () =>
        Promise.all(config.accounts.map((account) => accountStatus(account))),
      );
      // Reader: apps/web/src/setup/Repos.tsx (seat model pickers). Only providers which have actually published a catalog
      // are selectable here; role defaults are configuration, not model discovery.
      api.get("/accounts/models", (): AccountModelsView[] => {
        const catalogFor = deps.codexModelsFor ?? codexModelsFor;
        return config.accounts.map((account) => ({
          accountId: account.id,
          // Claude currently exposes no model/list equivalent. An empty catalog is more honest
          // than offering values inferred from roles (which can include Codex-only models).
          models:
            account.vendor === "codex"
              ? catalogFor(account)
                  .entries()
                  .map(({ model, efforts }) => ({
                    model,
                    efforts: [...efforts],
                  }))
              : [],
        }));
      });
      // Reader: apps/web/src/setup/Accounts.tsx (Check)
      api.post<{ Params: { id: string } }>("/accounts/:id/check", async (req, reply) => {
        const account = config.accounts.find((a) => a.id === req.params.id);
        if (!account) return reply.code(404).send({ error: "account not found" });
        return accountStatus(account, true);
      });
      // Reader/writer: Setup › Accounts model list. A failed refresh is retained and shown stale.
      api.get<{ Params: { id: string } }>("/accounts/:id/models", async (req, reply) => {
        const account = config.accounts.find((a) => a.id === req.params.id);
        if (!account) return reply.code(404).send({ error: "account not found" });
        const listed = accountModels.get(account.id);
        if (listed) return listed;
        const models = await discoverAccountModels(account, now());
        accountModels.set(account.id, models);
        return models;
      });
      api.post<{ Params: { id: string } }>("/accounts/:id/models/refresh", async (req, reply) => {
        const account = config.accounts.find((a) => a.id === req.params.id);
        if (!account) return reply.code(404).send({ error: "account not found" });
        const models = await discoverAccountModels(account, now());
        const previous = accountModels.get(account.id);
        const next =
          models.error === null || !previous ? models : { ...models, models: previous.models };
        accountModels.set(account.id, next);
        return next;
      });
      // Reader: apps/web/src/setup/Accounts.tsx (Add account)
      api.post("/accounts", async (req, reply) => {
        if (!deps.configPath) return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        const configPath = deps.configPath;
        const body = NewAccountBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        const update = async () => {
          if (
            (body.data.cliProfile !== undefined || body.data.provider === "codex") &&
            (store.liveSeatRuns().length > 0 || (deps.supervisor?.busy().length ?? 0) > 0)
          )
            return reply
              .code(409)
              .send({ error: "end existing seat processes before adding a CLI profile" });
          const duplicate = accountDuplicateReason(config.accounts, body.data);
          if (duplicate) return reply.code(409).send({ error: duplicate });
          try {
            const result = await addAccount(configPath, body.data, now());
            const added = result.config.accounts.find((a) => a.id === body.data.name);
            if (added) config.accounts.push(added);
            bus.emit("config");
            return { account: added };
          } catch (e) {
            captureError(reply, e);
            if (e instanceof ConfigWriteError) {
              return reply
                .code(e.kind === "duplicate" || e.kind === "current" ? 409 : 500)
                .send({ error: e.message });
            }
            return reply.code(500).send({ error: CONFIG_WRITE_FAILED });
          }
        };
        return withAccountUpdate(update);
      });

      const accountUsers = (id: string): string[] => [
        ...config.loops.filter((loop) => loop.accountId === id).map((loop) => `loop ${loop.id}`),
        ...(config.crew?.sessions ?? []).flatMap((session) =>
          session.seats
            .filter((seat) => seat.accountId === id)
            .map((seat) => `seat ${seat.id} in ${session.id}`),
        ),
      ];
      const applyAccounts = (next: CcConfig) => {
        config.accounts.splice(0, config.accounts.length, ...next.accounts);
        accountStatuses.clear();
        accountModels.clear();
      };
      // Writer: Setup › Accounts (edit an account; its id is deliberately immutable).
      // Reader: apps/web/src/setup/Accounts.tsx (Edit account, via ACTIONS.account)
      api.put<{ Params: { id: string } }>("/accounts/:id", async (req, reply) => {
        if (!deps.configPath) return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        const body = AccountBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        const current = config.accounts.find((account) => account.id === req.params.id);
        if (!current) return reply.code(404).send({ error: "account not found" });
        const bindingChanged =
          current.vendor !== body.data.provider || current.cliProfile !== body.data.cliProfile;
        const update = async () => {
          if (
            bindingChanged &&
            (store.liveSeatRuns().length > 0 || (deps.supervisor?.busy().length ?? 0) > 0)
          )
            return reply
              .code(409)
              .send({ error: "end existing seat processes before changing a CLI profile" });
          try {
            const result = await setAccount(
              deps.configPath as string,
              req.params.id,
              body.data,
              now(),
            );
            applyAccounts(result.config);
            bus.emit("config");
            return {
              account: result.config.accounts.find((account) => account.id === req.params.id),
            };
          } catch (e) {
            captureError(reply, e);
            if (e instanceof ConfigWriteError)
              return reply
                .code(
                  e.kind === "missing"
                    ? 404
                    : e.kind === "current" || e.kind === "invalid"
                      ? 409
                      : 500,
                )
                .send({ error: e.message });
            return reply.code(500).send({ error: CONFIG_WRITE_FAILED });
          }
        };
        return withAccountUpdate(update);
      });
      // Writer: Setup › Accounts (only orphaned accounts can be removed).
      // Reader: apps/web/src/setup/Accounts.tsx (Remove account, via ACTIONS.account)
      api.delete<{ Params: { id: string } }>("/accounts/:id", async (req, reply) => {
        if (!deps.configPath) return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        if (!config.accounts.some((account) => account.id === req.params.id))
          return reply.code(404).send({ error: "account not found" });
        const users = accountUsers(req.params.id);
        if (users.length > 0)
          return reply.code(409).send({ error: `account is in use by ${users.join(", ")}` });
        const update = async () => {
          if (store.liveSeatRuns().length > 0 || (deps.supervisor?.busy().length ?? 0) > 0)
            return reply
              .code(409)
              .send({ error: "end existing seat processes before removing an account" });
          try {
            const result = await removeAccount(deps.configPath as string, req.params.id, now());
            applyAccounts(result.config);
            bus.emit("config");
            return { removed: req.params.id };
          } catch (e) {
            captureError(reply, e);
            if (e instanceof ConfigWriteError)
              return reply
                .code(e.kind === "missing" ? 404 : e.kind === "current" ? 409 : 500)
                .send({ error: e.message });
            return reply.code(500).send({ error: CONFIG_WRITE_FAILED });
          }
        };
        return withAccountUpdate(update);
      });

      api.get("/limits", async () => limitRows(config, store, now()));
      // Reader: apps/web/src/data.ts#RESOURCES (the Limits view's GitHub row)
      api.get("/limits/github", async () => githubRate(store));

      api.get(
        "/repos",
        async (): Promise<RepoView[]> =>
          config.repos.map((r) => ({
            id: r.id,
            github: r.github,
            project: r.project,
            projectUrl: projectUrlOf(store, r.id),
          })),
      );

      api.get("/repos/profiles", async (): Promise<RepoProfile[]> => repoProfiles(config, store));

      // Configuration-only fields from Setup › Repos & seats. This never reads a board or
      // changes a queue: guidance is handed to FLIGHT as advice when it next starts.
      api.post<{ Params: { repoId: string } }>("/repos/:repoId/setup", async (req, reply) => {
        const configPath = deps.configPath;
        if (configPath === undefined)
          return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        const body = RepoSetupBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        try {
          const result = await setRepoSetup(configPath, req.params.repoId, body.data, now());
          const index = config.repos.findIndex((repo) => repo.id === req.params.repoId);
          if (index < 0) return reply.code(404).send({ error: "unknown repo" });
          // Disk can contain unapplied crew/rotation changes.  This narrow route must never make
          // any of them live; it owns only these two card fields.
          const repo = config.repos[index];
          if (!repo) return reply.code(404).send({ error: "unknown repo" });
          if (body.data.defaultAccountId === null) delete repo.defaultAccountId;
          else repo.defaultAccountId = body.data.defaultAccountId;
          const guidance = body.data.guidance;
          if (
            guidance.priority.length === 0 &&
            guidance.milestone.length === 0 &&
            guidance.labels.length === 0 &&
            guidance.labelMode === "any" &&
            guidance.avoid.length === 0 &&
            guidance.direction === ""
          )
            delete repo.guidance;
          else repo.guidance = { ...guidance };
          bus.emit("config");
          return { backup: basename(result.backup) };
        } catch (e) {
          captureError(reply, e);
          if (e instanceof ConfigWriteError) {
            const status: Partial<Record<ConfigWriteError["kind"], number>> = {
              missing: 404,
              invalid: 400,
              current: 409,
            };
            const code = status[e.kind];
            if (code !== undefined) return reply.code(code).send({ error: e.message });
          }
          return reply.code(500).send({ error: CONFIG_WRITE_FAILED });
        }
      });

      // Reader: docs/runbook.md#what-it-observes
      api.post("/github/refresh", async (_req, reply) => {
        refreshBoards();
        return reply.code(202).send({ ok: true });
      });

      // What adding a repo would mean, read live from GitHub (reads only; nothing is written).
      api.post("/repos/preview", async (req, reply) => {
        const body = RepoLocation.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        try {
          return await repoPreview(await githubGql(), body.data, config, store);
        } catch (e) {
          captureError(reply, e);
          if (e instanceof PreviewError) return reply.code(e.status).send({ error: e.message });
          return reply
            .code(502)
            .send({ error: e instanceof Error ? e.message : "github: request failed" });
        }
      });

      // Read-only preflight for the add/convert stepper.  Session creation repeats this check
      // immediately before its write, but this lets Setup reject a bad checkout before any config
      // path is changed.
      api.post("/repos/checkout-preview", async (req, reply) => {
        const body = z
          .strictObject({
            github: z.string().min(3),
            source: z.string().min(1),
            branch: z.string().min(1).max(255),
            defaultBranch: z.string().min(1).max(255),
          })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        if (body.data.branch !== body.data.defaultBranch) {
          return reply
            .code(400)
            .send({ error: "the checkout branch must match GitHub's default branch" });
        }
        try {
          await validateSessionCheckout(
            body.data.source,
            body.data.branch,
            body.data.github,
            true,
            [
              ...config.loops.map((loop) => ({
                label: `loop ${loop.id} worktree`,
                dir: loop.worktree,
              })),
              ...(config.crew?.sessions ?? []).map((session) => ({
                label: `session ${session.id} checkout`,
                dir: session.checkout,
              })),
            ],
          );
          return { ok: true };
        } catch (e) {
          return reply.code(400).send({
            error: e instanceof Error ? e.message : "could not validate the checkout",
          });
        }
      });

      // The add/convert stepper has exactly one durable operation. Its GitHub and checkout
      // validation runs again here, immediately before the one atomic config replacement.
      api.post("/repos/onboard", async (req, reply) => {
        const configPath = deps.configPath;
        if (!configPath) return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        const body = RepoOnboardBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        if (body.data.session && (!deps.crewReloader || !deps.seatWrites)) {
          return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        }
        const liveRepo = config.repos.find((repo) => repo.id === body.data.repoId);
        const known = body.data.repo ?? liveRepo;
        if (!known) return reply.code(404).send({ error: `unknown repo ${body.data.repoId}` });
        // Conversion updates only this card's setup fields. Capture its live identity before the
        // writer re-reads config.yaml, so a concurrent/manual config edit cannot apply setup to
        // a different repo that happens to share the checkout's default branch.
        const conversionIdentity =
          body.data.repo === undefined && liveRepo
            ? { github: liveRepo.github, project: liveRepo.project }
            : undefined;
        try {
          const result = await onboardRepo(configPath, body.data, now(), async (repo) => {
            if (
              conversionIdentity &&
              (repo.github !== conversionIdentity.github ||
                repo.project !== conversionIdentity.project)
            )
              throw new ConfigWriteError(
                "conflict",
                "the repo identity changed in config.yaml; refresh and try again",
              );
            const preview = await repoPreview(
              await githubGql(),
              { github: repo.github, project: repo.project },
              config,
              store,
            );
            if (body.data.checkout.branch !== preview.defaultBranch)
              throw new ConfigWriteError(
                "invalid",
                "the checkout branch must match GitHub's default branch",
              );
          });
          const onboarded = result.config.repos.find((repo) => repo.id === body.data.repoId);
          if (!onboarded)
            throw new ConfigWriteError("write", "the new config.yaml has no added repo");
          // Disk can include pending crew edits.  Only make this card's setup live here; the
          // reloader owns every crew change so it can drain seats before applying it.
          const index = config.repos.findIndex((repo) => repo.id === body.data.repoId);
          if (body.data.repo) config.repos.push(onboarded);
          else if (index >= 0) {
            const live = config.repos[index];
            if (!live) throw new ConfigWriteError("missing", `unknown repo ${body.data.repoId}`);
            if (body.data.defaultAccountId === null) delete live.defaultAccountId;
            else live.defaultAccountId = onboarded.defaultAccountId;
            if (onboarded.guidance === undefined) delete live.guidance;
            else live.guidance = { ...onboarded.guidance };
          }
          if (body.data.session) await deps.crewReloader?.reload();
          bus.emit("config");
          bus.emit("boards");
          if (body.data.repo) refreshBoards();
          return { backup: basename(result.backup) };
        } catch (e) {
          captureError(reply, e);
          if (e instanceof PreviewError) return reply.code(e.status).send({ error: e.message });
          if (e instanceof ConfigWriteError) {
            const status = {
              invalid: 400,
              missing: 404,
              duplicate: 409,
              current: 409,
              conflict: 409,
            }[e.kind as string];
            if (status !== undefined) return reply.code(status).send({ error: e.message });
          }
          return reply.code(500).send({ error: CONFIG_WRITE_FAILED });
        }
      });

      // The one local write besides PAUSE: append a repo to the config.yaml the server started with
      // (no request names a path), then apply it live. Every collector and route reads
      // `config.repos` per call, so the next GitHub tick polls the new repo.
      api.post("/repos", async (req, reply) => {
        const configPath = deps.configPath;
        if (configPath === undefined) {
          return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        }
        const body = NewRepoBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        const repo = body.data;
        // Also against what is loaded: a repo removed from the file by hand is still polled.
        const loaded = duplicateReason(config.repos, repo);
        if (loaded) return reply.code(409).send({ error: loaded });
        let result: Awaited<ReturnType<typeof addRepo>>;
        try {
          result = await addRepo(configPath, repo, now());
        } catch (e) {
          captureError(reply, e);
          if (e instanceof ConfigWriteError && (e.kind === "duplicate" || e.kind === "current")) {
            return reply.code(409).send({ error: e.message });
          }
          // ConfigWriteError messages never carry file contents; anything else is logged by name only.
          const detail =
            e instanceof ConfigWriteError
              ? { kind: e.kind, reason: e.message }
              : { kind: "unexpected", reason: e instanceof Error ? e.name : typeof e };
          reply.log.warn(detail, "config write failed");
          return reply.code(500).send({ error: CONFIG_WRITE_FAILED });
        }
        // Only this route adds to config.repos, and two concurrent adds of one repo meet in the
        // serialised file check, so the loaded list cannot have gained it during the await.
        const added = result.config.repos.find((r) => r.id === repo.id);
        if (added) config.repos.push(added);
        bus.emit("config");
        bus.emit("boards");
        refreshBoards();
        const view: RepoView = {
          id: repo.id,
          github: repo.github,
          project: repo.project,
          projectUrl: projectUrlOf(store, repo.id),
        };
        return { repo: view, backup: basename(result.backup) };
      });

      // The Map page's snapshot: apps/web/src/map/CrewMap.tsx reads it through RESOURCES.repoMap.
      api.get<{ Params: { repoId: string } }>(
        "/repos/:repoId/map",
        async (req, reply): Promise<MapSnapshot | FastifyReply> => {
          const repo = config.repos.find((r) => r.id === req.params.repoId);
          if (!repo) return reply.code(404).send({ error: "unknown repo" });
          const checkout = config.crew?.sessions.find((s) => s.repoId === repo.id)?.checkout;
          if (!checkout) return reply.code(503).send({ error: "map checkout unavailable" });
          try {
            if (!(await stat(checkout).catch(() => null))?.isDirectory()) {
              return reply.code(503).send({ error: "map checkout unavailable" });
            }
            return await mapPayloadFor(repo, checkout, reply.log);
          } catch (e) {
            reply.log.warn(
              { reason: e instanceof Error ? e.message : String(e) },
              "map snapshot unavailable",
            );
            return reply.code(503).send({ error: "map snapshot unavailable" });
          }
        },
      );

      // Reader: apps/web/src/data.ts (none in the web: the Map reads modified scope from the snapshot; for diagnosis)
      api.get<{ Params: { repoId: string } }>("/repos/:repoId/map/diff", async (req, reply) => {
        if (!config.repos.some((r) => r.id === req.params.repoId))
          return reply.code(404).send({ error: "unknown repo" });
        if (!deps.mapRing) return reply.code(503).send({ error: "map collector unavailable" });
        return { seats: deps.mapRing.scopes(req.params.repoId) };
      });

      // Reader: apps/web/src/data.ts (none in the web: the Map reads conflicts from the snapshot; for diagnosis)
      api.get<{ Params: { repoId: string } }>(
        "/repos/:repoId/map/conflicts",
        async (req, reply) => {
          const repo = config.repos.find((r) => r.id === req.params.repoId);
          if (!repo) return reply.code(404).send({ error: "unknown repo" });
          const checkout = config.crew?.sessions.find((s) => s.repoId === repo.id)?.checkout;
          if (!checkout) return reply.code(503).send({ error: "map checkout unavailable" });
          try {
            if (!(await stat(checkout).catch(() => null))?.isDirectory()) {
              return reply.code(503).send({ error: "map checkout unavailable" });
            }
            const { conflicts, unchecked, failures } = await mapConflicts.check(
              checkout,
              store.pullRequests(repo.id),
            );
            for (const failure of failures)
              reply.log.warn(failure, "map conflict check failed for a pair; reported unchecked");
            return { conflicts, unchecked };
          } catch (e) {
            reply.log.warn(
              { reason: e instanceof Error ? e.message : String(e) },
              "map conflicts unavailable",
            );
            return reply.code(503).send({ error: "map conflicts unavailable" });
          }
        },
      );

      // `?linked=1`: only the PRs linked to a ticket, the ones the Board can show (#26 A1).
      // A list is the open PRs plus those updated in the last PR_LIST_DAYS (`?days=N` reaches
      // back further, `?all=1` is every one), each with its checks as name and state; `?detail=1`
      // or the PR's own route carries the full row; `?shape=summary` is the list's own fields only (#1192).
      api.get<{
        Params: { repoId: string };
        Querystring: {
          linked?: unknown;
          days?: unknown;
          all?: unknown;
          detail?: unknown;
          shape?: unknown;
        };
      }>("/repos/:repoId/prs", async (req, reply) => {
        const { linked, days, all, detail, shape } = req.query;
        if (shape !== undefined && shape !== "summary") {
          return reply.code(400).send({ error: "shape must be summary" });
        }
        if (linked !== undefined && linked !== "1") {
          return reply.code(400).send({ error: "linked must be 1" });
        }
        if (all !== undefined && all !== "1") {
          return reply.code(400).send({ error: "all must be 1" });
        }
        if (detail !== undefined && detail !== "1") {
          return reply.code(400).send({ error: "detail must be 1" });
        }
        const window = parseLimit(days, PR_LIST_DAYS, PR_LIST_DAYS_MAX);
        if (window === null) {
          return reply.code(400).send({ error: `days must be an integer 1..${PR_LIST_DAYS_MAX}` });
        }
        const repo = config.repos.find((r) => r.id === req.params.repoId);
        if (!repo) return reply.code(404).send({ error: "unknown repo" });
        const listed = store.pullRequestsSince(
          repo.id,
          all === "1" ? null : now() - window * 86_400_000,
        );
        const prs = linked === "1" ? listed.filter((p) => p.ticket !== null) : listed;
        const previewFor = (number: number) =>
          repo.id === deps.previewRepoId ? (deps.previews?.get(number) ?? null) : null;
        if (shape === "summary")
          return prs.map((pr) => ({ ...prSummaryRow(pr), preview: previewFor(pr.number) }));
        return detail === "1"
          ? prs.map((pr) => ({ ...pr, preview: previewFor(pr.number) }))
          : prs.map((pr) => ({ ...prSummary(pr), preview: previewFor(pr.number) }));
      });
      // Reader: docs/hud-response-budgets.md#pull-request-lists (a PR's full detail on demand)
      api.get<{ Params: { repoId: string; number: string } }>(
        "/repos/:repoId/prs/:number",
        async (req, reply) => {
          const repo = config.repos.find((r) => r.id === req.params.repoId);
          if (!repo) return reply.code(404).send({ error: "unknown repo" });
          const pr = /^[1-9]\d{0,9}$/.test(req.params.number)
            ? store.pullRequest(repo.id, Number(req.params.number))
            : null;
          if (!pr) return reply.code(404).send({ error: "unknown pull request" });
          return {
            ...pr,
            preview:
              repo.id === deps.previewRepoId ? (deps.previews?.get(pr.number) ?? null) : null,
          };
        },
      );

      // Reader: apps/web/src/data.ts (the Board and Agent PR chips)
      api.get("/previews", async (req, reply) => {
        if (
          operatorToken !== undefined &&
          !operatorTokenMatches(operatorToken, req.headers[OPERATOR_HEADER])
        )
          return reply.code(401).send({ error: OPERATOR_TOKEN_REQUIRED });
        return deps.previews?.list() ?? [];
      });

      // Reader: apps/server/src/main.ts#PreviewManager (child-preview idle activity)
      api.post<{ Params: { pr: string } }>("/previews/:pr/activity", async (req, reply) => {
        const pr = /^[1-9]\d*$/.test(req.params.pr) ? Number(req.params.pr) : 0;
        const token = req.headers[PREVIEW_ACTIVITY_HEADER];
        if (pr === 0 || typeof token !== "string" || !deps.previews?.activity(pr, token))
          return reply.code(404).send({ error: "preview not found" });
        return reply.code(204).send();
      });

      // Reader: apps/web/src/data.ts (the Board and Agent PR chips)
      api.post("/previews", async (req, reply) => {
        const parsed = PreviewBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
        if (!deps.previews)
          return reply.code(409).send({ error: "previews are unavailable on this server" });
        const repo = config.repos.find((candidate) => candidate.id === deps.previewRepoId);
        if (!repo)
          return reply.code(409).send({ error: "previews run Mission Control branches only" });
        const pr = store
          .pullRequests(repo.id)
          .find((candidate) => candidate.number === parsed.data.pr && candidate.state === "open");
        if (!pr) return reply.code(404).send({ error: "open PR not found" });
        const match = {
          repo,
          pr,
          checkout: config.crew?.sessions.find((s) => s.repoId === repo.id)?.checkout,
        };
        if (!match.checkout) return reply.code(409).send({ error: "PR checkout is unavailable" });
        try {
          return await deps.previews.start({
            pr: match.pr.number,
            branch: match.pr.branch,
            checkout: match.checkout,
          });
        } catch (e) {
          if (e instanceof PreviewHubError)
            return reply.code(409).send({ error: e.message, code: e.code });
          throw e;
        }
      });

      // Reader: apps/web/src/data.ts (the Board and Agent PR chips)
      api.delete<{ Params: { pr: string } }>("/previews/:pr", async (req, reply) => {
        const pr = /^[1-9]\d*$/.test(req.params.pr) ? Number(req.params.pr) : 0;
        if (pr === 0) return reply.code(404).send({ error: "preview not found" });
        if (!deps.previews)
          return reply.code(409).send({ error: "previews are unavailable on this server" });
        if (!(await deps.previews.close(pr)))
          return reply.code(404).send({ error: "preview not found" });
        return reply.code(204).send();
      });

      api.get<{ Params: { repoId: string } }>("/boards/:repoId", async (req, reply) => {
        const repo = config.repos.find((r) => r.id === req.params.repoId);
        if (!repo) return reply.code(404).send({ error: "unknown repo" });
        return store.board(repo.id);
      });

      // Read live from GitHub (the board's rows carry no body); the number is validated here.
      api.get<{ Params: { repoId: string; number: string } }>(
        "/boards/:repoId/items/:number",
        async (req, reply) => {
          const repo = config.repos.find((r) => r.id === req.params.repoId);
          if (!repo) return reply.code(404).send({ error: "unknown repo" });
          const n = /^[1-9]\d*$/.test(req.params.number) ? Number(req.params.number) : 0;
          if (n === 0 || n > MAX_ISSUE_NUMBER) {
            return reply.code(404).send({ error: "unknown issue" });
          }
          try {
            const ticket = await fetchTicket(repo, n, await githubGql(), config.repos);
            return ticket ?? reply.code(404).send({ error: "unknown issue" });
          } catch (e) {
            captureError(reply, e);
            return reply
              .code(502)
              .send({ error: `GitHub failed: ${e instanceof Error ? e.message : String(e)}` });
          }
        },
      );

      // Setup runs one at a time per repo, so a second tab pressing it waits and then finds the fields.
      const setupLocks = new Map<string, Promise<unknown>>();
      const serialised = <T>(repoId: string, fn: () => Promise<T>): Promise<T> => {
        const run = (setupLocks.get(repoId) ?? Promise.resolve()).then(fn, fn);
        const tail = run.catch(() => undefined);
        setupLocks.set(repoId, tail);
        void tail.then(() => {
          if (setupLocks.get(repoId) === tail) setupLocks.delete(repoId);
        });
        return run;
      };
      // Fixed text plus GitHub's own message (makeGql never puts the token in one).
      const setupFailed = (reply: FastifyReply, e: unknown) =>
        reply
          .code(502)
          .send({ error: `GitHub setup failed: ${e instanceof Error ? e.message : String(e)}` });

      // Reader: docs/runbook.md#project-fields (the status check the setup call is run after)
      api.get<{ Params: { repoId: string } }>("/boards/:repoId/setup", async (req, reply) => {
        const repo = config.repos.find((r) => r.id === req.params.repoId);
        if (!repo) return reply.code(404).send({ error: "unknown repo" });
        try {
          const gql = await githubGql();
          const { projectId: _projectId, ...status } = await setupStatus(
            gql,
            repo.github.split("/")[0] ?? "",
            repo.project,
          );
          return { ...status, missingLabels: await missingLabels(gql, repo.github, TYPE_LABELS) };
        } catch (e) {
          captureError(reply, e);
          return setupFailed(reply, e);
        }
      });

      // Reader: docs/runbook.md#project-fields (the one-time setup call, run by hand)
      api.post<{ Params: { repoId: string } }>("/boards/:repoId/setup", async (req, reply) => {
        const repo = config.repos.find((r) => r.id === req.params.repoId);
        if (!repo) return reply.code(404).send({ error: "unknown repo" });
        try {
          const result = await serialised(repo.id, async () => {
            const gql = await githubGql();
            const fields = await ensureFields(gql, repo.github.split("/")[0] ?? "", repo.project);
            // Refresh now: the fields exist even if a label below fails.
            if (fields.created.length > 0) refreshBoards();
            const labelsCreated = await ensureLabels(gql, repo.github, TYPE_LABELS);
            return { ...fields, labelsCreated };
          });
          return result;
        } catch (e) {
          captureError(reply, e);
          return setupFailed(reply, e);
        }
      });

      api.get("/escalations", async () => store.escalations());

      // Reader: docs/runbook.md#hud-screenshots (the operator opens the reference FLIGHT cites)
      api.get<{ Params: { id: string } }>("/hud-screenshots/:id", async (req, reply) => {
        // Not a mutating route, so the operator-token hook skips it: check the token here. The
        // HUD renderer never holds it (the bootstrap refuses its header), nor does a page's script.
        if (
          operatorToken !== undefined &&
          !operatorTokenMatches(operatorToken, req.headers[OPERATOR_HEADER])
        )
          return reply.code(401).send({ error: OPERATOR_TOKEN_REQUIRED });
        const png = deps.hudShots?.read(req.params.id) ?? null;
        if (!png) return reply.code(404).send({ error: "not found" });
        return reply
          .header("cache-control", "private, no-store")
          .header("x-content-type-options", "nosniff")
          .type("image/png")
          .send(png);
      });

      if (operatorToken !== undefined) {
        // Reader: apps/web/src/api.ts#loadOperatorToken (the HUD reads the token at page load)
        api.get(OPERATOR_BOOTSTRAP_PATH.slice(API_PREFIX.length), async (req, reply) => {
          if (
            !LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "") ||
            req.headers["sec-fetch-site"] !== "same-origin" ||
            req.headers[HUD_RENDERER_HEADER] !== undefined
          ) {
            return reply.code(403).send({ error: BOOTSTRAP_REFUSED });
          }
          return reply.header("cache-control", "no-store").send({ token: operatorToken });
        });
      }

      api.get("/health", async () => {
        const ticks = tickLogOf(store);
        const recent = ticks.recent();
        const last = recent.at(-1);
        const running = ticks.running();
        if (recent.length === 0 && running === null) return store.status();
        return [
          ...store.status(),
          // the engine's recent tick durations; `error` names a tick still running past its interval
          {
            collector: TICKS_COLLECTOR,
            ok: running === null || now() - running.startedAt < ENGINE_TICK_MS,
            error: running === null ? null : overrunText(running.startedAt, running.steps),
            at: last?.endedAt ?? 0,
            lastOkAt: last?.endedAt ?? null,
            ticks: recent,
          },
        ];
      });
      // Reader: docs/reviews/2026-10-28/audit-qa-datamap.md#audit-board (operator audit board)
      api.get<{ Querystring: { range?: string } }>("/audit", async (req, reply) => {
        const range = req.query.range ?? "30d";
        const match = /^(7|30|90|365)d$/.exec(range);
        if (!match) return reply.code(400).send({ error: "range must be 7d, 30d, 90d, or 365d" });
        const until = now();
        const kinds = new Map<string, AuditRunKind>(
          configuredAgents(config).map((a) => [
            a.id,
            a.kind === "loop" ? "observed" : seatDef(a.seat).loop,
          ]),
        );
        return capAudit(store.audit(until - Number(match[1]) * 86_400_000, until, kinds));
      });
      api.get("/machine", async (): Promise<MachineView> => {
        const cached = transcriptFootprintCache;
        const footprint =
          cached !== null && now() - cached.at < 60_000
            ? cached.value
            : (() => {
                const value = transcriptFootprint(store);
                transcriptFootprintCache = { at: now(), value };
                return value;
              })();
        const sessions = config.crew?.sessions ?? [];
        const counts = sessions.map((s) => s.seats.length);
        const latest = machine();
        const capacityConfig = config.crew?.machineCapacity ?? MACHINE_CAPACITY_DEFAULTS;
        const capacity = machineCapacity(
          latest === null
            ? store.machineSamples(machineCapacitySince(now(), capacityConfig))
            : [...store.machineSamples(machineCapacitySince(now(), capacityConfig)), latest],
          now(),
          capacityConfig,
        );
        return {
          latest,
          warning: capacity.reason,
          maxSeats: config.crew?.maxSeats ?? DEFAULT_MAX_SEATS,
          seats: counts.reduce((a, b) => a + b, 0),
          perSessionMax: Math.max(0, ...counts),
          transcripts: footprint,
        };
      });

      // Reader: apps/web/src/data.ts
      api.get<{ Querystring: { since?: string; limit?: string } }>(
        "/activity",
        async (req, reply) => {
          const { since, limit } = req.query;
          const integer = (value: unknown) =>
            typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
          if (
            (since !== undefined && !integer(since)) ||
            (limit !== undefined && (!integer(limit) || Number(limit) < 1))
          )
            return reply.code(400).send({
              error: "since must be a non-negative timestamp; limit must be a positive integer",
            });
          return activity(config, store, now(), {
            ...(since === undefined ? {} : { since: Number(since) }),
            ...(limit === undefined ? {} : { limit: Math.min(Number(limit), ACTIVITY_LIMIT) }),
          });
        },
      );

      api.get("/config", async () =>
        configView(
          config,
          deps.profilesPath === undefined
            ? undefined
            : profilesView(
                deps.profilesPath,
                crew(config, store, now(), deps.lock?.state() ?? NO_LOCK).rows.filter(
                  (row) => row.run?.endedAt === null,
                ),
              ),
          await readGithubLogin(),
        ),
      );

      // Reader: apps/web/src/setup/Loops.tsx (Setup template creation)
      api.post("/profiles", async (req, reply) => {
        if (!deps.profilesPath)
          return reply.code(409).send({ error: "template writes are unavailable" });
        const body = NewProfileBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        try {
          const result = await createProfile(
            deps.profilesPath,
            body.data.profile,
            body.data.base,
            now(),
          );
          bus.emit("config");
          return reply.code(201).send(result);
        } catch (e) {
          if (e instanceof ConfigWriteError)
            return reply.code(e.kind === "invalid" ? 400 : 409).send({ error: e.message });
          return reply.code(500).send({ error: "could not save template" });
        }
      });

      // Re-reads the config.yaml the server started with now (no request names a path); a file that
      // does not load changes nothing.
      // Reader: docs/runbook.md#reloading-the-config
      api.post("/config/reload", async (_req, reply) => {
        if (deps.crewReloader === undefined) {
          return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        }
        const result = await deps.crewReloader.reload();
        if (result.error !== null) return reply.code(400).send({ error: result.error });
        return result;
      });

      // Reader: docs/runbook.md#reloading-the-config
      api.post("/crew/sessions", async (req, reply) => {
        const { configPath, crewReloader, seatWrites } = deps;
        if (!configPath || !crewReloader || !seatWrites) {
          return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        }
        const body = NewSessionBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        try {
          const result = await createSession(configPath, body.data, now(), config);
          const changes = await crewReloader.reload();
          return {
            id: body.data.id,
            folders: result.folders,
            backup: basename(result.backup),
            changes,
          };
        } catch (e) {
          if (e instanceof ConfigWriteError) {
            return reply
              .code(e.kind === "invalid" ? 400 : e.kind === "write" ? 500 : 409)
              .send({ error: e.message });
          }
          captureError(reply, e);
          return reply.code(500).send({ error: CONFIG_WRITE_FAILED });
        }
      });

      // Reader: docs/runbook.md#reloading-the-config
      api.post<{ Params: { id: string } }>("/crew/sessions/:id/close", async (req, reply) => {
        const { configPath, crewReloader, seatWrites } = deps;
        if (!configPath || !crewReloader?.removeSession || !seatWrites) {
          return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        }
        try {
          const result = await crewReloader.removeSession(req.params.id, (stopped, session) =>
            closeSession(configPath, req.params.id, stopped, now(), session),
          );
          const checkout = await removeSessionCheckout(result.session, result.worktrees);
          return {
            id: req.params.id,
            checkout,
            backup: basename(result.backup),
            retainedPath: checkout === "removed" ? null : result.session.checkout,
            outcome:
              checkout === "retained-unproven"
                ? "Checkout retained: ownership or safe removal is unproven (a seat worktree may still be registered)."
                : checkout === "removal-failed-partway"
                  ? "Checkout removal failed partway."
                  : checkout,
          };
        } catch (e) {
          if (e instanceof ConfigWriteError) {
            return reply
              .code(
                e.kind === "missing"
                  ? 404
                  : e.kind === "invalid"
                    ? 400
                    : e.kind === "write"
                      ? 500
                      : 409,
              )
              .send({ error: e.message });
          }
          captureError(reply, e);
          return reply.code(500).send({ error: CONFIG_WRITE_FAILED });
        }
      });

      // Reader: apps/web/src/pages/Agent.tsx (Queue focus)
      api.get<{ Params: { id: string } }>("/seats/:id/focus", async (req, reply) => {
        const seat = config.crew?.sessions
          .flatMap((s) => s.seats)
          .find((s) => s.id === req.params.id);
        if (!seat) return reply.code(404).send({ error: "Seat unavailable." });
        return { focus: seat.focus ?? null };
      });

      // Reader: apps/web/src/pages/Agent.tsx (Queue focus Change)
      api.post<{ Params: { id: string } }>("/seats/:id/focus", async (req, reply) => {
        const body = z.strictObject({ focus: seatFocus }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        if (!deps.seatWrites || !deps.configPath || !deps.crewReloader)
          return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        try {
          return await setSeatFocus(
            config,
            deps.configPath,
            deps.crewReloader,
            req.params.id,
            body.data.focus,
            now(),
          );
        } catch (e) {
          return reply
            .code(e instanceof ConfigWriteError && e.kind === "missing" ? 404 : 409)
            .send({ error: e instanceof ConfigWriteError ? e.message : CONFIG_WRITE_FAILED });
        }
      });

      // Reader: apps/web/src/pages/Agent.tsx (Queue move-up approval item)
      api.post<{ Params: { id: string } }>("/seats/:id/queue/reorder", async (req, reply) => {
        const body = z
          .strictObject({ move: z.string().min(1).max(100), above: z.string().min(1).max(100) })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        if (!deps.queueReorder || deps.noLoopWrites)
          return reply.code(409).send({ error: "Queue Priority writes unavailable." });
        try {
          const result = await proposeQueueReorder(
            deps.queueReorder,
            req.params.id,
            body.data.move,
            body.data.above,
          );
          bus.emit("attention");
          return result;
        } catch (e) {
          return reply.code(409).send({
            error:
              e instanceof QueueReorderError ? e.message : "Queue changed; refresh and try again.",
          });
        }
      });

      // Reader: apps/web/src/shell/ItemPanel.tsx (operator Priority approval)
      api.post<{ Params: { key: string } }>("/queue/reorder/:key", async (req, reply) => {
        const body = z.strictObject({ action: z.enum(["approve", "deny"]) }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        if (!deps.queueReorder || deps.noLoopWrites)
          return reply.code(409).send({ error: "Queue Priority writes unavailable." });
        try {
          const result = await resolveQueueReorder(
            deps.queueReorder,
            req.params.key,
            body.data.action,
          );
          bus.emit("attention");
          bus.emit("boards");
          bus.emit("agents");
          return reply.code(result.ok ? 200 : 409).send(result);
        } catch (e) {
          return reply.code(409).send({
            error:
              e instanceof QueueReorderError ? e.message : "Queue changed; refresh and try again.",
          });
        }
      });

      // Reader: docs/runbook.md#reloading-the-config
      // Replaces one session's seats in the config.yaml the server started with (no request names a
      // path), then reloads so the change applies live. A POST so the CSRF hook covers it.
      api.post<{ Params: { sessionId: string } }>(
        "/crew/sessions/:sessionId/seats",
        async (req, reply) => {
          const { configPath, crewReloader, seatWrites } = deps;
          if (configPath === undefined || crewReloader === undefined || !seatWrites) {
            return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
          }
          const body = SeatsBody.safeParse(req.body);
          if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
          let result: Awaited<ReturnType<typeof setSessionSeats>>;
          try {
            result = await setSessionSeats(
              configPath,
              req.params.sessionId,
              body.data.base,
              body.data.seats,
              now(),
            );
          } catch (e) {
            captureError(reply, e);
            if (e instanceof ConfigWriteError) {
              const status = { missing: 404, conflict: 409, invalid: 400, current: 409 }[
                e.kind as string
              ];
              if (status !== undefined) return reply.code(status).send({ error: e.message });
            }
            const detail =
              e instanceof ConfigWriteError
                ? { kind: e.kind, reason: e.message }
                : { kind: "unexpected", reason: e instanceof Error ? e.name : typeof e };
            reply.log.warn(detail, "config write failed");
            return reply.code(500).send({ error: CONFIG_WRITE_FAILED });
          }
          const changes = await crewReloader.reload();
          return { backup: basename(result.backup), changes };
        },
      );

      // Reader: docs/runbook.md#reloading-the-config
      api.get("/crew/changes", async (): Promise<CrewChanges> => {
        return (
          deps.crewReloader?.status() ?? {
            sessions: [],
            pending: [],
            restartNeeded: [],
            error: null,
            checkedAt: null,
          }
        );
      });

      // Reader: apps/web/src/pages/Telemetry.tsx
      api.get<{
        Querystring: { range?: unknown; agent?: unknown; account?: unknown; ticket?: unknown };
      }>("/telemetry", async (req, reply): Promise<Telemetry | FastifyReply> => {
        const range = req.query.range ?? DEFAULT_TELEMETRY_RANGE;
        if (typeof range !== "string" || !Object.hasOwn(TELEMETRY_RANGES, range)) {
          return reply
            .code(400)
            .send({ error: `range must be one of ${Object.keys(TELEMETRY_RANGES).join(", ")}` });
        }
        // Each scope is optional; an empty value means all, anything else must be configured.
        const { agent, account, ticket } = req.query;
        if (
          ticket !== undefined &&
          ticket !== "" &&
          (typeof ticket !== "string" ||
            !config.repos.some(
              (r) =>
                ticket.startsWith(`${r.id}#`) &&
                /^[1-9]\d*$/.test(ticket.slice(r.id.length + 1)) &&
                Number.isSafeInteger(Number(ticket.slice(r.id.length + 1))),
            ))
        ) {
          return reply.code(400).send({
            error: "ticket must be a configured repo id and positive issue number (repo#issue)",
          });
        }
        if (
          agent !== undefined &&
          agent !== "" &&
          (typeof agent !== "string" || !agentIds(config).includes(agent))
        ) {
          return reply.code(400).send({ error: "agent must be a configured agent id" });
        }
        if (
          account !== undefined &&
          account !== "" &&
          (typeof account !== "string" || !config.accounts.some((a) => a.id === account))
        ) {
          return reply.code(400).send({ error: "account must be a configured account id" });
        }
        const at = now();
        const scope = {
          ticket: ticket === undefined || ticket === "" ? null : (ticket as string),
          agent: agent === undefined || agent === "" ? null : (agent as string),
          account: account === undefined || account === "" ? null : (account as string),
        };
        const counts = new Map<string, { additions: number | null; deletions: number | null }>();
        const scopedCommits: { key: string; sha: string }[] = [];
        const pending = new Map<string, { key: string; worktree: string }>();
        const agents = configuredAgents(config);
        for (const c of store.telemetryCommits(
          at - TELEMETRY_RANGES[range as TelemetryRange] * 60_000,
          at,
        )) {
          const key = `${c.repoId}#${c.sha}`;
          if (counts.has(key)) continue;
          const run = store.run(c.runId);
          if (!run) continue;
          const agent = agents.find((a) => a.id === run.agentId);
          if (
            !agent ||
            (scope.agent !== null && scope.agent !== agent.id) ||
            (scope.account !== null && scope.account !== agent.accountId) ||
            (scope.ticket !== null && runTicket(run, runPrs(config, store, run)) !== scope.ticket)
          )
            continue;
          scopedCommits.push({ key, sha: c.sha });
          const cached = store.commitLines(c.sha);
          if (cached) {
            counts.set(key, cached);
            continue;
          }
          const worktree =
            agent?.kind === "crew"
              ? config.crew?.sessions.find((s) => s.id === agent.sessionId)?.checkout
              : agent?.loop.worktree;
          if (worktree && pending.size < TELEMETRY_COMMIT_READ_LIMIT && !pending.has(c.sha))
            pending.set(c.sha, { key, worktree });
        }
        const jobs = [...pending];
        let next = 0;
        await Promise.all(
          Array.from({ length: TELEMETRY_COMMIT_CONCURRENCY }, async () => {
            while (next < jobs.length) {
              const job = jobs[next++];
              if (!job) break;
              const [sha, { key, worktree }] = job;
              const lines = await committedLines(worktree, sha);
              store.setCommitLines(sha, lines);
              counts.set(key, lines);
            }
          }),
        );
        // A sha can occur in more than one repository.
        for (const { key, sha } of scopedCommits) {
          const lines = store.commitLines(sha);
          if (lines) counts.set(key, lines);
        }
        return telemetry(config, store, range as TelemetryRange, at, scope, counts);
      });

      const setPaused = async (id: string, paused: boolean, reply: FastifyReply) => {
        const loop = loopById(id);
        if (!loop) return reply.code(404).send({ error: "unknown agent" });
        if (deps.noLoopWrites) return reply.code(409).send({ error: LOOP_WRITES_DISABLED });
        if (loop.kind !== "ta-loop") return reply.code(409).send({ error: STUDIO_PAUSE_ERROR });
        // Responses carry fixed text only: never the loop's absolute paths.
        const isDir = await stat(loop.stateDir).then(
          (st) => st.isDirectory(),
          () => false,
        );
        if (!isDir) return reply.code(503).send({ error: "source missing" });
        // The only writes Mission Control makes into a loop's files: create / remove PAUSE.
        const path = join(loop.stateDir, PAUSE_FILE);
        try {
          if (paused) await writeFile(path, "", { flag: "wx" });
          else await unlink(path);
        } catch (e) {
          captureError(reply, e);
          const benign = paused ? errCode(e) === "EEXIST" : errCode(e) === "ENOENT";
          if (!benign) {
            reply.log.warn({ code: errCode(e) }, `pause state update failed for ${loop.id}`);
            return reply.code(503).send({ error: "could not update pause state" });
          }
        }
        bus.emit("agents");
        return { id: loop.id, paused: isPaused(loop) };
      };
      api.post<{ Params: { id: string } }>("/agents/:id/pause", (req, reply) =>
        setPaused(req.params.id, true, reply),
      );
      api.post<{ Params: { id: string } }>("/agents/:id/resume", (req, reply) =>
        setPaused(req.params.id, false, reply),
      );

      // Crew seats. The supervisor answers with fixed texts; a route never relays a path or stderr.
      const supervisor = deps.supervisor;
      const crewGate = (id: string, reply: FastifyReply): boolean => {
        const st = supervisor?.status() ?? { enabled: false, note: null };
        if (!st.enabled) {
          void reply.code(409).send({ error: st.note ?? CREW_DISABLED });
          return false;
        }
        const known = configuredAgents(config).some((a) => a.kind === "crew" && a.id === id);
        if (!known) {
          void reply.code(404).send({ error: "unknown seat" });
          return false;
        }
        return true;
      };
      const crewFail = (e: unknown, reply: FastifyReply) => {
        captureError(reply, e);
        if (e instanceof CheckoutError) {
          // the detail (a path, git's own text) goes to the log, never into the response
          if (e.detail !== null) reply.log.warn({ detail: e.detail }, "crew checkout refused");
          return reply.code(422).send({ error: e.message });
        }
        if (e instanceof SupervisorError) return reply.code(e.status).send({ error: e.message });
        reply.log.warn(
          {
            err: e instanceof Error ? e.name : typeof e,
            message: e instanceof Error ? e.message : String(e),
          },
          "crew action failed",
        );
        return reply.code(500).send({ error: CREW_ACTION_FAILED });
      };
      const seatAction = <B>(
        path: string,
        schema: z.ZodType<B>,
        act: (sup: Supervisor, id: string, body: B) => Promise<unknown>,
        options: { bodyLimit?: number } = {},
      ) =>
        api.post<{ Params: { id: string } }>(path, options, async (req, reply) => {
          const id = req.params.id;
          if (!crewGate(id, reply) || !supervisor) return reply;
          const body = schema.safeParse(req.body);
          if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
          try {
            const out = await act(supervisor, id, body.data);
            bus.emit("agents");
            return out;
          } catch (e) {
            return crewFail(e, reply);
          }
        });
      // A writer's run is looped whenever the engine is on, in a draft repo too (its card is
      // never moved there); a read-only seat's run has no loop.
      seatAction("/seats/:id/start", StartBody, async (sup, id, b) => {
        const pause = pausedSeat(store, id);
        if (pause) throw new SupervisorError(409, `Paused: ${pause.reason}`);
        const at = now();
        const capacityConfig = config.crew?.machineCapacity ?? MACHINE_CAPACITY_DEFAULTS;
        const capacity = machineCapacity(
          store.machineSamples(machineCapacitySince(at, capacityConfig)),
          at,
          capacityConfig,
        );
        if (capacity.blocked && b.force !== true)
          throw new SupervisorError(409, `Machine capacity held: ${capacity.reason}`);
        const loop = crewSeatDef(config, id).loop;
        let started: unknown;
        // the watch seat runs the crew and takes no ticket; every other seat needs one
        if (loop === "watch") {
          if (b.issue !== undefined) {
            throw new SupervisorError(400, watchStartRefusedText(seatCallSign(id)));
          }
          started = await sup.startWatch(id);
        } else {
          if (b.issue === undefined) throw new SupervisorError(400, ISSUE_REQUIRED);
          started = await (deps.engine?.status().on === true && loop === "build"
            ? startUnpausedRun(store, sup, id, b.issue, { loop: NEW_LOOP, operator: true })
            : startUnpausedRun(store, sup, id, b.issue, { operator: true }));
        }
        if (capacity.blocked && b.force === true) {
          const repoId = configuredAgents(config).find(
            (agent) => agent.kind === "crew" && agent.id === id,
          )?.repoId;
          store.addFlightDecision({
            at,
            kind: "start",
            seatId: id,
            targetRunId: null,
            ref: repoId === undefined || b.issue === undefined ? null : `${repoId}#${b.issue}`,
            questionId: null,
            about: "machine capacity",
            decision: `Operator override: started ${seatCallSign(id)} despite machine capacity hold.`,
            basis: capacity.reason ?? "machine capacity held",
          });
        }
        return started;
      });
      seatAction(
        "/seats/:id/message",
        MessageBody,
        async (sup, id, b) => {
          const runId = sup.seat(id)?.runId ?? null;
          const ticket = runId === null ? null : (store.run(runId)?.ticket ?? null);
          try {
            await sendComms(
              {
                store,
                crew: commsCrew,
                knownSecrets: deps.knownSecrets ?? (async () => []),
                now,
                seatSender: false,
                notify: async (seatId, text) => {
                  await sup.message(seatId, text, { interrupt: b.interrupt === true });
                },
              },
              COMMS_CAPCOM,
              {
                to: id,
                text: b.text,
                ...(b.interrupt === true ? { label: "handoff" as const } : {}),
                ref: ticket ?? undefined,
              },
            );
          } catch (e) {
            if (e instanceof SupervisorError) throw e;
            throw new SupervisorError(
              400,
              e instanceof Error ? e.message : "Comms message refused.",
            );
          }
          return { ok: true };
        },
        // Bound the encoded request before parsing; accepted messages stay whole.
        { bodyLimit: COMMS_MESSAGE_BODY_LIMIT },
      );
      // Reader: apps/web/src/agent/Header.tsx
      api.post<{ Params: { id: string } }>("/seats/:id/transfer", async (req, reply) => {
        if (!crewGate(req.params.id, reply) || !supervisor) return reply;
        const body = z.strictObject({ accountId: z.string().min(1).max(40) }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        try {
          const result = await supervisor.transferAccount(req.params.id, body.data.accountId);
          bus.emit("agents");
          return result;
        } catch (e) {
          return crewFail(e, reply);
        }
      });
      seatAction("/seats/:id/interrupt", NoBody, async (sup, id) => {
        await sup.interrupt(id);
        return { ok: true };
      });
      seatAction("/seats/:id/end", EndBody, async (sup, id, b) => {
        if (b.watch) {
          const action = flightBriefView(
            config,
            store,
            deps.lock?.state() ?? NO_LOCK,
            now(),
          ).watch?.find((entry) => entry.id === b.watch?.id)?.action;
          if (
            action?.kind !== "lock-hold" ||
            action.runId !== b.watch.runId ||
            action.toolUseId !== b.watch.toolUseId ||
            action.since !== b.watch.since ||
            store.seatSession(id)?.runId !== action.runId
          )
            throw new SupervisorError(
              409,
              "Watch target changed; refresh before stopping the run.",
            );
        }
        await sup.endRun(id, { hold: b.hold });
        const stopped = store.seatSession(id);
        if (stopped?.state === "stopped")
          store.setSeatSession({
            ...stopped,
            stop: { by: config.operator.id, reason: b.reason ?? null, at: now() },
          });
        return { ok: true };
      });
      api.get<{ Params: { id: string } }>(
        "/seats/:id/context",
        async (req, reply): Promise<ContextUsage | null | FastifyReply> => {
          if (!crewGate(req.params.id, reply) || !supervisor) return reply;
          try {
            return await supervisor.contextUsage(req.params.id);
          } catch (e) {
            return crewFail(e, reply);
          }
        },
      );
      // Reader: apps/web/src/shell/Dock.tsx#Dock
      // `live` is judged from FLIGHT's session, not only its run row (#798)
      api.get("/flight", async () =>
        flightView(config, store, Date.now(), (id) => supervisor?.sessionAlive?.(id) ?? null),
      );
      // Reader: apps/web/src/shell/Dock.tsx#Dock (FLIGHT page brief)
      api.get("/flight/brief", async () =>
        flightBriefView(config, store, deps.lock?.state() ?? NO_LOCK, now()),
      );
      // Reader: apps/web/src/flight/Incoming.tsx (recorded outcomes)
      api.get("/flight/incoming", async () => ({ entries: store.flightIncoming() }));
      // Reader: apps/web/src/flight/Situation.tsx (planned-work timeline)
      api.get("/flight/schedule", async () => flightScheduleView(config, store, now()));
      // Reader: roles/FLIGHT.md#repo-memory-and-the-daily-retrospective (operator memory API)
      api.get("/flight/memory", async (req, reply) => {
        const parsed = z.object({ repo: z.string().min(1) }).safeParse(req.query);
        if (!parsed.success) return reply.code(400).send({ error: "Invalid repo" });
        if (!config.repos.some((r) => r.id === parsed.data.repo))
          return reply.code(404).send({ error: "Unknown repo" });
        return { notes: store.flightMemory(parsed.data.repo) };
      });
      const MemoryParams = z.object({ repo: z.string().min(1), topic: FlightMemoryTopic });
      // Reader: roles/FLIGHT.md#repo-memory-and-the-daily-retrospective (operator memory API)
      api.put("/flight/memory/:repo/:topic", async (req, reply) => {
        const params = MemoryParams.safeParse(req.params);
        const body = FlightMemoryInput.omit({ topic: true }).strict().safeParse(req.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ error: "Invalid memory note" });
        if (!config.repos.some((r) => r.id === params.data.repo))
          return reply.code(404).send({ error: "Unknown repo" });
        try {
          store.putFlightMemory({
            ...body.data,
            topic: params.data.topic,
            repoId: params.data.repo,
            author: "operator",
            updatedAt: now(),
          });
        } catch (e) {
          return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) });
        }
        bus.emit("flight");
        return { ok: true };
      });
      // Reader: roles/FLIGHT.md#repo-memory-and-the-daily-retrospective (operator memory API)
      api.delete("/flight/memory/:repo/:topic", async (req, reply) => {
        const params = MemoryParams.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: "Invalid memory topic" });
        if (!config.repos.some((r) => r.id === params.data.repo))
          return reply.code(404).send({ error: "Unknown repo" });
        if (!store.deleteFlightMemory(params.data.repo, params.data.topic))
          return reply.code(404).send({ error: `No note named ${params.data.topic}.` });
        bus.emit("flight");
        return { ok: true };
      });
      // Reader: apps/web/src/flight/Summary.tsx (high-level tracking summary)
      api.get("/flight/summary", async () =>
        flightSummary(
          config,
          store,
          now(),
          deps.lock?.state() ?? NO_LOCK,
          deps.hubLogin?.() ?? null,
        ),
      );
      // Reader: apps/web/src/flight/Summary.tsx (full tracking details)
      api.get("/flight/ledger", async (req, reply) => {
        const query = FlightLedgerArgs.extend({
          limit: z.preprocess(
            (v) => (typeof v === "string" ? Number(v) : v),
            FlightLedgerArgs.shape.limit,
          ),
          offset: z.preprocess(
            (v) => (typeof v === "string" ? Number(v) : v),
            FlightLedgerArgs.shape.offset,
          ),
        }).safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: "Invalid ledger query" });
        return flightLedgerView(config, store, query.data);
      });

      api.get("/crew/status", async () => ({
        ...(supervisor?.status() ?? { enabled: false, note: null }),
        ...(deps.engine === undefined ? {} : { engine: deps.engine.status() }),
      }));
      // Reader: apps/web/src/flight/Drafts.tsx and Situation.tsx
      api.get("/drafts", async () => store.drafts());
      // Reader: apps/web/src/flight/Drafts.tsx (finished draft history)
      api.get("/drafts/history", async () => store.draftHistory());
      const postingDrafts = new Set<number>();
      const postingItems = new Set<string>();
      const postDraft = async (id: number, input: unknown, reply: FastifyReply) => {
        const source = store.draftSource(id);
        if (source?.state === "posted") return { ok: true };
        const draft = store.drafts().find((d) => d.id === id);
        if (!draft) return reply.code(404).send({ error: "No pending draft." });
        if (postingDrafts.has(id) || (source && postingItems.has(source.itemKey)))
          return reply.code(409).send({ error: "Draft is being posted." });
        const parsed = z
          .strictObject({ text: z.string().trim().min(1).max(MC_TEXT_MAX).optional() })
          .safeParse(input);
        if (!parsed.success) return reply.code(400).send({ error: "Invalid draft text." });
        const match = /^([^#]+)#([1-9][0-9]*)$/.exec(draft.target);
        const repo = config.repos.find((r) => r.id === match?.[1]);
        const n = Number(match?.[2]);
        if (
          !repo ||
          !Number.isSafeInteger(n) ||
          n > 2 ** 31 - 1 ||
          draft.via !== "GitHub" ||
          (draft.kind !== "issue" && draft.kind !== "pr")
        ) {
          return reply.code(400).send({ error: DRAFT_BAD_TARGET });
        }
        const thread = source ? parsePersonKey(source.itemKey) : null;
        if (source) {
          const n = thread ? store.notification(thread.id) : null;
          if (
            !n ||
            !notificationOpen(n) ||
            n.updatedAt !== thread?.updatedAt ||
            source.source.kind !== "github" ||
            !n.message ||
            JSON.stringify(source.source) !== JSON.stringify(n.message.source) ||
            draft.target !== `${n.repoId}#${n.number}` ||
            draft.kind !== (n.subjectType === "PullRequest" ? "pr" : "issue")
          )
            return reply
              .code(409)
              .send({ error: "Source changed; refresh the item before posting." });
        }
        const body = parsed.data.text ?? draft.text;
        postingDrafts.add(id);
        if (source) postingItems.add(source.itemKey);
        const file = crewPrBodyPath(store.path);
        let wroteBody = false;
        const attemptKey = `draft-post:${id}`;
        const finish = () => {
          store.finishDraft(id, "posted", body);
          store.deleteSetting(attemptKey);
          if (thread) {
            store.markNotificationHandled(thread.id, thread.updatedAt, "replied", now());
            bus.emit("attention");
          }
          bus.emit("flight");
          return { ok: true };
        };
        try {
          if (store.getSetting(attemptKey)) {
            const latest = await (deps.gh ?? createGh())(
              [draft.kind, "view", String(n), `--repo=${repo.github}`, "--json=comments"],
              { cwd: crewDir(store.path) },
            );
            let comments: { body: string }[] | undefined;
            try {
              comments = z
                .object({ comments: z.array(z.object({ body: z.string() })) })
                .parse(JSON.parse(latest.stdout)).comments;
            } catch {
              /* A failed read must not turn into a second post. */
            }
            if (latest.code !== 0 || !comments)
              return reply
                .code(502)
                .send({ error: "Could not verify the latest comment. Nothing was posted." });
            if (comments.at(-1)?.body === body && store.getSetting(attemptKey) === body)
              return finish();
          }
          if (source && thread) {
            try {
              const rest = deps.notificationRest ?? makeRest(await githubToken());
              const { body: current } = await rest(
                `https://api.github.com/notifications/threads/${thread.id}`,
              );
              const parsedThread = z
                .object({
                  updated_at: z.string(),
                  subject: z.object({ url: z.string(), latest_comment_url: z.string().nullable() }),
                })
                .safeParse(current);
              const expected = `https://api.github.com/repos/${repo.github}/${draft.kind === "pr" ? "pulls" : "issues"}/${n}`;
              if (
                !parsedThread.success ||
                Date.parse(parsedThread.data.updated_at) !== thread.updatedAt ||
                !sourceReadUrl(repo.github, parsedThread.data.subject.url) ||
                parsedThread.data.subject.url.split("/").slice(6).join("/") !==
                  expected.split("/").slice(6).join("/")
              )
                return reply
                  .code(409)
                  .send({ error: "Source changed; refresh the item before posting." });
              const url = parsedThread.data.subject.latest_comment_url ?? expected;
              if (!sourceReadUrl(repo.github, url))
                return reply.code(409).send({ error: "Invalid source target." });
              const currentMessage = sourceMessage((await rest(url)).body, "", thread.updatedAt);
              if (
                !currentMessage ||
                JSON.stringify(currentMessage.source) !== JSON.stringify(source.source)
              )
                return reply
                  .code(409)
                  .send({ error: "Source changed; refresh the item before posting." });
              const latest = store.notification(thread.id);
              if (!latest || !notificationOpen(latest) || latest.updatedAt !== thread.updatedAt)
                return reply
                  .code(409)
                  .send({ error: "Source changed; refresh the item before posting." });
            } catch (e) {
              captureError(reply, e);
              return reply
                .code(502)
                .send({ error: "Could not verify the source. Nothing was posted." });
            }
          }
          const known = await readKnown(
            { knownSecrets: deps.knownSecrets ?? (async () => [await githubToken()]) },
            "post_draft",
          );
          const problem = prTextProblem(body, {
            repo: repo.github,
            issue: n,
            known,
            label: "draft",
            unclosed: true,
            allowOwnRepoRefs: true,
          });
          if (problem) return reply.code(400).send({ error: evidenceProblemText(problem) });
          await writeFile(file, body, { mode: 0o600, flag: "wx" });
          wroteBody = true;
          store.setSetting(attemptKey, body);
          const result = await (deps.gh ?? createGh())(
            [draft.kind, "comment", String(n), `--repo=${repo.github}`, `--body-file=${file}`],
            { cwd: crewDir(store.path) },
          );
          if (result.code !== 0)
            return reply.code(502).send({ error: "GitHub refused the comment." });
          return finish();
        } finally {
          postingDrafts.delete(id);
          if (source) postingItems.delete(source.itemKey);
          if (wroteBody) await rm(file, { force: true });
        }
      };
      // Reader: apps/web/src/flight/Drafts.tsx (operator approval only)
      api.post<{ Params: { id: string } }>("/drafts/:id/post", async (req, reply) =>
        postDraft(Number(req.params.id), req.body, reply),
      );
      // Reader: apps/web/src/shell/ItemPanel.tsx (explicit Post on GitHub approval)
      api.post<{ Params: { key: string; replyId: string } }>(
        "/attention/:key/replies/:replyId/post",
        async (req, reply) => {
          const draft = store
            .briefs()
            .get(req.params.key)
            ?.person?.replies?.find((r) => r.id === req.params.replyId);
          if (!draft?.draftId) return reply.code(404).send({ error: "No suggested GitHub reply." });
          const source = store.draftSource(draft.draftId);
          if (source?.itemKey !== req.params.key || source.replyId !== req.params.replyId)
            return reply.code(409).send({ error: "Reply target changed." });
          return postDraft(draft.draftId, req.body, reply);
        },
      );
      // Reader: apps/web/src/flight/Drafts.tsx
      api.post<{ Params: { id: string } }>("/drafts/:id/copied", async (req, reply) => {
        const id = Number(req.params.id);
        const draft = store.draft(id);
        if (!draft) return reply.code(404).send({ error: "No draft." });
        if (draft.via !== "Teams" || draft.state !== "pending")
          return reply.code(409).send({ error: "Only pending Teams drafts can be copied." });
        store.finishDraft(id, "copied");
        store.deleteSetting(`draft-post:${id}`);
        bus.emit("flight");
        return { ok: true };
      });
      // Reader: apps/web/src/flight/Drafts.tsx
      api.post<{ Params: { id: string } }>("/drafts/:id/discard", async (req, reply) => {
        const id = Number(req.params.id);
        if (postingDrafts.has(id)) return reply.code(409).send({ error: "Draft is being posted." });
        if (!store.drafts().some((d) => d.id === id))
          return reply.code(404).send({ error: "No pending draft." });
        store.finishDraft(id, "discarded");
        store.deleteSetting(`draft-post:${id}`);
        bus.emit("flight");
        return { ok: true };
      });

      // The operator ends a run set aside in review, without waking it.
      // Reader: apps/web/src/agent/LoopSteps.tsx (the End action on a set-aside run)
      api.post<{ Params: { id: string } }>("/runs/:id/end", async (req, reply) => {
        const run = store.run(req.params.id);
        if (run === null || !supervisor) return reply.code(404).send({ error: "unknown run" });
        if (!crewGate(run.agentId, reply)) return reply;
        const body = NoBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        try {
          await supervisor.endAsideRun(run.id);
          bus.emit("agents");
          return { ok: true };
        } catch (e) {
          return crewFail(e, reply);
        }
      });
      // The operator accepts a parked, looped run's review findings for a run whose seat no longer holds
      // it (set aside at CI or review) too. Unlike a message to the seat, this explicit Resume action
      // waives a review or review-ruling park's findings. The answer waits for the engine's pass, so
      // "ok" means the park was lifted.
      // Reader: docs/runbook.md#resume-a-parked-run
      api.post<{ Params: { id: string } }>("/runs/:id/resume", async (req, reply) => {
        const run = store.run(req.params.id);
        if (run === null) return reply.code(404).send({ error: "unknown run" });
        if (!run.loop) return reply.code(404).send({ error: "not a looped run" });
        if (!crewGate(run.agentId, reply)) return reply;
        const body = NoBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        if (deps.engine?.status().on !== true) {
          return reply.code(409).send({ error: "the loop engine is off" });
        }
        if (run.loop.parked?.kind === CONTROLLER_CHECK_PARK) {
          return reply
            .code(409)
            .send({ error: `nothing to resume: ${CONTROLLER_CHECK_USE_ROUTE}` });
        }
        const reviewWaiver =
          run.loop.parked?.kind === "review" || run.loop.parked?.kind === "review-ruling";
        const lifted = reviewWaiver
          ? await deps.engine.onOperatorMessage(run.id, "CAPCOM", { action: "accept" })
          : await deps.engine.onOperatorMessage(run.id, "CAPCOM");
        if (!lifted.lifted) {
          return reply
            .code(409)
            .send({ error: `nothing to resume: ${operatorRefusalText(lifted.reason)}` });
        }
        return { ok: true };
      });
      // The operator's verdict on a run parked on its ticket's `## Controller check`. FLIGHT has no
      // tool for this; the operator token is required like every mutating route.
      // Reader: docs/runbook.md#record-a-controller-check
      api.post<{ Params: { id: string } }>(
        "/runs/:id/controller-check",
        { bodyLimit: COMMS_MESSAGE_BODY_LIMIT },
        async (req, reply) => {
          const run = store.run(req.params.id);
          if (run === null) return reply.code(404).send({ error: "unknown run" });
          if (!run.loop) return reply.code(404).send({ error: "not a looped run" });
          if (!crewGate(run.agentId, reply)) return reply;
          const body = ControllerCheckBody.safeParse(req.body);
          if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
          if (deps.noLoopWrites) return reply.code(409).send({ error: LOOP_WRITES_DISABLED });
          if (deps.engine?.controllerCheck === undefined || deps.engine.status().on !== true) {
            return reply.code(409).send({ error: "the loop engine is off" });
          }
          if (body.data.note !== undefined) {
            try {
              await validateCommsText(deps.knownSecrets ?? (async () => []), body.data.note);
            } catch (e) {
              return crewFail(
                new SupervisorError(400, e instanceof Error ? e.message : "Comms message refused."),
                reply,
              );
            }
          }
          const result = await deps.engine.controllerCheck(
            run.id,
            body.data.verdict,
            body.data.sha,
            body.data.note,
          );
          if (!result.lifted) {
            return reply.code(409).send({
              error: `controller check not recorded: ${operatorRefusalText(result.reason)}`,
            });
          }
          return { ok: true };
        },
      );
      // The controller holds a run's PR from merging, or releases a hold (FLIGHT's or its own).
      // FLIGHT's hold_pr tool cannot release one set here; the operator token is required.
      // Reader: docs/runbook.md#hold-a-run-from-merging
      api.post<{ Params: { id: string } }>("/runs/:id/merge-hold", async (req, reply) => {
        const run = store.run(req.params.id);
        if (run === null) return reply.code(404).send({ error: "unknown run" });
        if (!run.loop) return reply.code(404).send({ error: "not a looped run" });
        if (!crewGate(run.agentId, reply)) return reply;
        const body = MergeHoldBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        if (deps.noLoopWrites) return reply.code(409).send({ error: LOOP_WRITES_DISABLED });
        const engine = deps.engine;
        if (!engine?.holdMerge || !engine.releaseMergeHold || engine.status().on !== true) {
          return reply.code(409).send({ error: "the loop engine is off" });
        }
        const result =
          body.data.action === "hold"
            ? await engine.holdMerge(run.id, "CAPCOM", body.data.reason)
            : await engine.releaseMergeHold(run.id, "CAPCOM");
        if (!result.ok)
          return reply.code(409).send({ error: `merge hold not changed: ${result.text}` });
        return { ok: true };
      });
      // Rework reaches a set-aside run through Comms, rather than interrupting whichever newer run
      // now occupies its seat. The engine wakes the set-aside run after the message is stored.
      // Reader: docs/runbook.md#rework-a-parked-run
      api.post<{ Params: { id: string } }>(
        "/runs/:id/message",
        { bodyLimit: COMMS_MESSAGE_BODY_LIMIT },
        async (req, reply) => {
          const run = store.run(req.params.id);
          if (run === null) return reply.code(404).send({ error: "unknown run" });
          if (!run.loop) return reply.code(404).send({ error: "not a looped run" });
          if (!crewGate(run.agentId, reply)) return reply;
          if (deps.noLoopWrites) return reply.code(409).send({ error: LOOP_WRITES_DISABLED });
          const body = MessageBody.safeParse(req.body);
          if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
          if (deps.engine?.status().on !== true)
            return reply.code(409).send({ error: "the loop engine is off" });
          const kind = run.loop.parked?.kind;
          if (kind !== "review" && kind !== "review-ruling")
            return reply.code(409).send({ error: "rework is only available for review parks" });
          const knownSecrets = deps.knownSecrets ?? (async () => []);
          try {
            await validateCommsText(knownSecrets, body.data.text);
          } catch (e) {
            return crewFail(
              new SupervisorError(400, e instanceof Error ? e.message : "Comms message refused."),
              reply,
            );
          }
          let commsError: unknown = null;
          const result = await deps.engine.onOperatorMessage(run.id, "CAPCOM", {
            kinds: [kind],
            beforeLift: async () => {
              try {
                await sendComms({ store, crew: commsCrew, knownSecrets, now }, COMMS_CAPCOM, {
                  to: run.agentId,
                  text: body.data.text,
                  ref: run.ticket ?? undefined,
                  targetRunId: run.id,
                });
                return true;
              } catch (e) {
                commsError = e;
                return false;
              }
            },
          });
          if (commsError !== null)
            return crewFail(
              new SupervisorError(
                400,
                commsError instanceof Error ? commsError.message : "Comms message refused.",
              ),
              reply,
            );
          if (!result.lifted)
            return reply.code(409).send({
              error: `the review park could not be resumed for rework: ${operatorRefusalText(result.reason)}`,
            });
          return { ok: true };
        },
      );
      // Reader: apps/web/src/agent/LoopSteps.tsx (future attempt history)
      api.get<{ Params: { id: string } }>("/runs/:id/attempts", async (req, reply) => {
        const run = store.run(req.params.id);
        if (run === null) return reply.code(404).send({ error: "unknown run" });
        return { runId: run.id, attempts: store.runAttempts(run.id) };
      });
      // A looped run's state and its Activity rows, on demand.
      // Reader: apps/web/src/agent/LoopSteps.tsx (the Steps view)
      api.get<{ Params: { id: string } }>("/runs/:id/loop", async (req, reply) => {
        const run = store.run(req.params.id);
        if (run === null) return reply.code(404).send({ error: "unknown run" });
        const loop = run.loop ?? null;
        const events = store.loopEventsOfRun(run.id);
        const pushed = store.runPush(run.id);
        const review =
          loop && pushed
            ? reviewStatusOf(
                store.reviewsOfRun(run.id),
                loop.epoch,
                pushed.sha,
                loop.reviewWaivedSha ?? null,
              )
            : null;
        const view: RunLoopView = {
          runId: run.id,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          limits: {
            tries: run.profile?.profile.tries ?? CI_TRIES,
            rounds: run.profile?.profile.rounds ?? REVIEW_ROUNDS,
          },
          usage: runUsage(store, run, now()),
          noReport: run.noReport ?? null,
          loop,
          events,
          tries: loopTries(run, events, review, [
            ...(store.digest(run.id)?.attemptUsage ?? []),
            ...store
              .reviewsOfRun(run.id)
              .flatMap((r) =>
                r.runId === null ? [] : (store.digest(r.runId)?.attemptUsage ?? []),
              ),
          ]),
          round: loop
            ? Math.min(
                run.profile?.profile.rounds ?? REVIEW_ROUNDS,
                1 + fixesSent(store.claimedKeys(run.id), run.id, loop.epoch),
              )
            : null,
          budget:
            loop &&
            config.crew?.runTokenBudget !== undefined &&
            run.tokens !== null &&
            run.tokens.cacheRead + run.tokens.cacheCreate === 0
              ? config.crew.runTokenBudget + loop.budgetExtra
              : null,
          review,
        };
        return view;
      });

      // Read-only: the top-level directories of each session's checkout, with the writer that owns
      // each. A checkout that cannot be read is `readable: false` with no folders, never a 500.
      api.get(
        "/crew/sessions",
        async (): Promise<CrewSessionFolders[]> =>
          Promise.all(
            (config.crew?.sessions ?? []).map(async (session) => {
              const writers = session.seats.filter((s) => seatDef(s).mode === "writer");
              try {
                const entries = await readdir(session.checkout, { withFileTypes: true });
                const folders = entries
                  .filter((e) => e.isDirectory() && !e.name.startsWith("."))
                  .map((e) => e.name)
                  .sort()
                  .map((name) => ({
                    name,
                    owners: writers.filter((w) => areaOwnsFolder(w.area, name)).map((w) => w.id),
                  }));
                return { id: session.id, readable: true, folders };
              } catch {
                return { id: session.id, readable: false, folders: [] };
              }
            }),
          ),
      );

      api.get("/overview/timeline", async () => overviewTimeline(config, store, now()));

      // `?shape=summary`: what the Overview reads, without each row's event timelines and whole
      // digest (#1192); `/crew/:id` is one row in full, for the Agent page.
      api.get<{ Querystring: { shape?: unknown } }>("/crew", async (req, reply) => {
        const { shape } = req.query;
        if (shape !== undefined && shape !== "summary")
          return reply.code(400).send({ error: "shape must be summary" });
        return shape === "summary" ? crewSummary(sharedCrewSummary()) : sharedCrew();
      });
      // Reader: docs/hud-response-budgets.md#crew (one crew row in full)
      api.get<{ Params: { id: string } }>("/crew/:id", async (req, reply) => {
        const row = sharedCrew().rows.find((r) => r.id === req.params.id);
        return row ?? reply.code(404).send({ error: "unknown agent" });
      });

      // The header's session filter: its repo, else every repo (the pipeline: the crew's repos).
      const viewScope = (selected: string | undefined) => {
        const session = config.crew?.sessions.find((s) => s.id === selected);
        if (selected !== undefined && session === undefined) return null;
        return {
          repoIds: session ? [session.repoId] : config.repos.map((r) => r.id),
          pipelineRepoIds: session
            ? [session.repoId]
            : [...new Set(config.crew?.sessions.map((s) => s.repoId))],
          timezone: config.operator.timezone,
        };
      };

      // The registry figures the server measures (METRICS in @mc/core); read-only.
      api.get<{ Querystring: { session?: string } }>("/metrics", (req, reply) => {
        const scope = viewScope(req.query.session);
        if (scope === null) return reply.code(404).send({ error: "unknown session" });
        return metricsView(store, now(), scope);
      });

      api.get<{ Querystring: { session?: string } }>("/overview", (req, reply) => {
        const scope = viewScope(req.query.session);
        if (scope === null) return reply.code(404).send({ error: "unknown session" });
        const at = now();
        return overviewSummary(store, at, {
          repoIds: scope.repoIds,
          pipelineRepoIds: scope.pipelineRepoIds,
          timezone: config.operator.timezone,
          attention: sharedAttention(),
        });
      });

      // The Update button. Its texts are fixed. The commands' output goes to update.log, which GET
      // /update/log returns as raw output (paths and stderr included) with credentials redacted.
      const updater = deps.updater;
      const unavailableVersion: VersionInfo = {
        sha: "",
        behind: null,
        checkedAt: null,
        canUpdate: false,
        reason: UPDATE_UNAVAILABLE,
      };
      api.get(
        "/version",
        async (): Promise<VersionInfo> => (updater ? updater.version() : unavailableVersion),
      );
      api.post("/version/check", async (req, reply): Promise<VersionInfo | undefined> => {
        const body = NoBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        if (!updater) return unavailableVersion;
        try {
          return await updater.check();
        } catch (e) {
          captureError(reply, e);
          if (e instanceof UpdateError) {
            return reply.code(e.status).send({ error: e.message, checkedAt: e.checkedAt ?? null });
          }
          reply.log.warn({ err: e instanceof Error ? e.name : typeof e }, "version check failed");
          return reply.code(500).send({ error: CHECK_FAILED });
        }
      });
      api.post("/update", async (req, reply) => {
        const body = NoBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        if (!updater) return reply.code(409).send({ error: UPDATE_UNAVAILABLE, logged: false });
        try {
          const out = await updater.update();
          if ("restarting" in out) updater.restart();
          if (!("upToDate" in out)) store.addHubEvent("Updated manually", now());
          return "restarting" in out ? reply.code(202).send(out) : out;
        } catch (e) {
          captureError(reply, e);
          // logged: update.log says why (the page opens it); false for a refusal before the log
          if (e instanceof UpdateError)
            return reply.code(e.status).send({ error: e.message, logged: e.logged });
          reply.log.warn({ err: e instanceof Error ? e.name : typeof e }, "update failed");
          return reply.code(500).send({ error: UPDATE_FAILED, logged: false });
        }
      });
      // Reader: apps/web/src/setup/UpdateLog.tsx (why the last update failed)
      api.get("/update/log", async (_req, reply) => {
        try {
          const log: UpdateLog = { text: updater ? await updater.log() : null };
          return log;
        } catch (e) {
          // never the errno text or the path: the page says only that it could not be read
          reply.log.warn({ err: e instanceof Error ? e.name : typeof e }, "update log read failed");
          return reply.code(500).send({ error: UPDATE_LOG_UNREADABLE });
        }
      });

      api.get(
        "/attention",
        async (): Promise<AttentionItem[]> =>
          sharedAttention().map((item) =>
            item.kind === "tag" && item.text.length > 170
              ? { ...item, text: `${item.text.slice(0, 169)}…` }
              : item,
          ),
      );
      // Reader: apps/web/src/shell/ItemPanel.tsx (whole tag message on open)
      api.get<{ Params: { key: string } }>("/attention/:key", async (req, reply) => {
        const item = sharedAttention().find((item) => item.key === req.params.key);
        return item ?? reply.code(404).send({ error: "Item is no longer open." });
      });
      // Reader: apps/web/src/flight/AskedOfYou.tsx (the Held group)
      api.get("/attention/held", async () =>
        attentionItems(
          config,
          store,
          now(),
          deps.lock?.state() ?? NO_LOCK,
          sharedCrew().rows,
          deps.hubLogin?.() ?? null,
          true,
        ).filter((i) => i.hold),
      );
      // Reader: apps/web/src/comms/Decisions.tsx
      api.post<{ Params: { key: string } }>("/attention/:key/hold", async (req, reply) => {
        const body = AttentionHoldInput.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: attentionHoldError(body.error) });
        if (!sharedAttention().some((i) => i.key === req.params.key))
          return reply.code(404).send({ error: "Item is no longer waiting." });
        if (
          !holdItem(store, req.params.key, body.data.reason, body.data.condition, "operator", now())
        )
          return reply
            .code(409)
            .send({ error: "That item waits on this one, so neither would ever release." });
        bus.emit("attention");
        return { ok: true };
      });
      // Reader: apps/web/src/flight/AskedOfYou.tsx (the Held group)
      api.post<{ Params: { key: string } }>("/attention/:key/hold/release", async (req, reply) => {
        if (!NoBody.safeParse(req.body).success)
          return reply.code(400).send({ error: "Expected an empty object." });
        if (!releaseHold(store, req.params.key, now()))
          return reply.code(404).send({ error: "No active hold." });
        bus.emit("attention");
        return { ok: true };
      });

      const discussionSends = new Set<string>();
      const currentDiscussionItem = (key: string) => {
        const item = attentionItems(
          config,
          store,
          now(),
          deps.lock?.state() ?? NO_LOCK,
          sharedCrew().rows,
          deps.hubLogin?.() ?? null,
        ).find((item) => item.key === key && !item.acked);
        return item ? { ...item, version: attentionVersion(item) } : undefined;
      };
      const openDiscussion = (item: AttentionItem & { version: string }) => {
        const brief = item.brief;
        const recommended = brief?.recommendedOptionId
          ? brief.options.find((o) => o.id === brief.recommendedOptionId)
          : undefined;
        const text = recommended?.description
          ? `Short version: ${brief?.recommendation} I lean towards "${recommended.label}": ${recommended.description}. What would help you decide? I can pull the Teams thread or the code.`
          : "Anything you want to check before you decide? I can show the full text, the ticket or the numbers behind it.";
        return store.ensureDiscussion(item.key, item.version, { text, at: now() });
      };
      // Reader: apps/web/src/shell/ItemPanel.tsx
      api.get<{ Params: { key: string }; Querystring: { id?: string } }>(
        "/attention/:key/discussion",
        async (req, reply) => {
          const { key } = req.params;
          if (req.query.id) {
            const thread = store.discussion(key, req.query.id);
            return thread ?? reply.code(404).send({ error: "Unknown discussion." });
          }
          const item = currentDiscussionItem(key);
          if (!item?.version) return reply.code(404).send({ error: "No current item." });
          return openDiscussion({ ...item, version: item.version });
        },
      );
      // Reader: apps/web/src/shell/ItemPanel.tsx
      api.post<{ Params: { key: string } }>("/attention/:key/discussion", async (req, reply) => {
        const body = z
          .strictObject({
            version: z.string().min(1).max(100),
            messageId: z.string().regex(/^[a-zA-Z0-9:_-]{1,100}$/),
            text: z.string().trim().min(1).max(DISCUSSION_TEXT_MAX),
          })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        const item = currentDiscussionItem(req.params.key);
        if (!item || item.version !== body.data.version)
          return reply.code(409).send({ error: "Item changed or ended; refresh before sending." });
        const thread = openDiscussion({ ...item, version: body.data.version });
        const { messageId, text } = body.data;
        try {
          store.askDiscussion(thread.id, messageId, text, now());
        } catch {
          return reply.code(409).send({ error: "Message id already used." });
        }
        if (store.discussionSent(thread.id, messageId))
          return store.discussion(item.key, thread.id);
        const flight = flightSeat(config);
        if (!flight || !supervisor || !crewGate(flight.seat.id, reply))
          return reply.sent ? reply : reply.code(503).send({ error: "FLIGHT is unavailable." });
        const sendKey = `${thread.id}:${messageId}`;
        if (discussionSends.has(sendKey))
          return reply.code(409).send({ error: "Message is being sent." });
        discussionSends.add(sendKey);
        try {
          await supervisor.message(
            flight.seat.id,
            JSON.stringify({
              kind: "item-discussion",
              discussion: { id: thread.id, replyTo: messageId },
              item,
              question: text,
              instruction:
                "Reply using log_decision with discussion.id, discussion.replyTo and a stable discussion.messageId. Discussion is chat only; do not execute a choice.",
            }),
            { interrupt: false, questions: "none" },
          );
          store.markDiscussionSent(thread.id, messageId);
          bus.emit("attention");
          return store.discussion(item.key, thread.id);
        } catch (e) {
          captureError(reply, e);
          return reply.code(503).send({ error: "Could not send to FLIGHT. Retry this message." });
        } finally {
          discussionSends.delete(sendKey);
        }
      });

      api.post("/attention/ack", async (req, reply) => {
        const body = AckBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        const keys = [...new Set(body.data.keys)];
        store.ack(keys, now());
        // a crew error stays listed until acked: its row is marked, so it leaves Needs you
        for (const k of keys) {
          const id = k.startsWith(CREW_ERROR_KEY) ? k.slice(CREW_ERROR_KEY.length) : "";
          if (/^[1-9]\d{0,15}$/.test(id)) store.ackCrewError(Number(id));
        }
        bus.emit("attention");
        if (keys.some((k) => k.startsWith(GUARD_ACK_PREFIX))) bus.emit("guard");
        return { acked: keys.length };
      });

      // Reader: apps/web/src/comms/answer.ts
      api.post<{ Params: { key: string } }>("/attention/:key/dismiss", async (req, reply) => {
        const body = NoBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        const key = req.params.key;
        const noteKey = key.startsWith(NOTE_KEY) ? key.slice(NOTE_KEY.length) : "";
        if (key.length > 200 || noteKey === "" || !store.dismissNote(noteKey, now())) {
          return reply.code(404).send({ error: NO_OPEN_NOTE });
        }
        bus.emit("attention");
        return { dismissed: key };
      });

      // Reader: apps/web/src/data.ts (notification settings)
      api.get("/notification-preferences", async () => notifications.preferences());

      // Reader: apps/web/src/data.ts (notification settings)
      api.post("/notification-preferences", async (req, reply) => {
        const body = NotificationPreferencesBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        notifications.setPreferences(body.data);
        return notifications.preferences();
      });

      // Reader: apps/web/src/notifications.ts (local notification feed)
      api.get("/notifications/events", async () => {
        return notifications.events();
      });

      // Reader: apps/web/src/notifications.ts (Send a test notification)
      api.post("/notifications/test", async (req, reply) => {
        const body = NoBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        return notifications.test();
      });

      // Reader: apps/web/src/data.ts (Sources status)
      api.get("/sources/teams", async () => teamsStatus(config, store));

      // Reader: apps/web/src/data.ts (Sources selection)
      api.post("/sources/teams/selection", async (req, reply) => {
        const body = z.strictObject({ selected: TeamsSelection }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "Invalid Teams selection" });
        if (!deps.configPath || deps.seatWrites === false)
          return reply.code(409).send({ error: "Config writes unavailable" });
        if (
          body.data.selected.some(
            (s) => s.lane !== "work" || !config.repos.some((r) => r.id === s.repoId),
          )
        )
          return reply
            .code(400)
            .send({ error: "Teams sources must belong to a configured work repo" });
        try {
          const next = await setTeamsSelection(deps.configPath, body.data.selected, now());
          config.sources = next.sources;
          bus.emit("attention");
          return teamsStatus(config, store);
        } catch {
          return reply.code(409).send({ error: "Teams selection could not be saved" });
        }
      });

      // Reader: apps/web/src/flight/AskedOfYou.tsx (the person cards)
      api.get(
        "/notifications",
        async (): Promise<NotificationsView> => notificationsView(config, store, now()),
      );

      // Reader: apps/web/src/shell/ItemPanel.tsx (the person variant's Mark handled)
      api.post<{ Params: { key: string } }>("/attention/:key/handled", async (req, reply) => {
        const body = z
          .strictObject({
            how: z.enum(["marked", "copied", "flight"]).optional(),
            replyId: z.string().max(100).optional(),
          })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        const key = req.params.key;
        const how = body.data.how ?? "marked";
        const person = store.briefs().get(key)?.person;
        if (
          how === "copied" &&
          (person?.source.kind !== "teams" ||
            !person.replies?.some((r) => r.id === body.data.replyId))
        )
          return reply.code(400).send({ error: "No suggested Teams reply." });
        const thread = key.length > 200 ? null : parsePersonKey(key);
        // Local only: the thread stays unread on GitHub.
        if (
          thread === null ||
          !store.markNotificationHandled(thread.id, thread.updatedAt, how, now())
        ) {
          return reply.code(404).send({ error: NO_OPEN_THREAD });
        }
        bus.emit("attention");
        return {
          handled: key,
          ...(how === "flight"
            ? {
                message: `I will handle ${store.notification(thread.id)?.author ?? "Someone"}'s message: I will check what is needed, draft a reply and bring it back to you before anything is sent.`,
              }
            : {}),
        };
      });

      // Reader: apps/web/src/components/CrewPause.tsx
      api.get("/settings/crew-pause", async () => readCrewPause(store));

      // Reader: apps/web/src/components/CrewPause.tsx
      api.post("/settings/crew-pause", async (req, reply) => {
        const body = CrewPauseBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        const seats = body.data.seats;
        const known = configuredAgents(config)
          .filter((a) => a.kind === "crew")
          .map((a) => a.id);
        if (Array.isArray(seats) && seats.some((id) => !known.includes(id)))
          return reply.code(400).send({ error: "unknown seat" });
        const pause: CrewPause | null =
          seats === null
            ? null
            : {
                seats,
                reason: body.data.reason,
                at: now(),
                by: config.operator.id,
              };
        writeCrewPause(store, pause, now());
        bus.emit("settings");
        bus.emit("agents");
        return pause;
      });

      api.get("/settings/away", async (): Promise<AwaySettings> => readAwaySettings(store));

      // Reader: apps/web/src/shell/AwayDigest.tsx
      api.get("/away/digest", async (req, reply) => {
        const query = z
          .object({ since: z.coerce.number().finite().nonnegative().optional() })
          .safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: zodError(query.error) });
        return awayDigest(
          store,
          activeAway(store, now(), config.operator.timezone) !== null,
          attentionItems(
            config,
            store,
            now(),
            deps.lock?.state() ?? NO_LOCK,
            sharedCrew().rows,
            deps.hubLogin?.() ?? null,
          ),
          config.repos.map((r) => r.id),
          now(),
          query.data.since,
        );
      });

      api.post("/settings/away", async (req, reply) => {
        const body = AwayBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        if (body.data.on && !activeAway(store, now(), config.operator.timezone))
          store.setSetting(AWAY_STARTED_SETTING, String(now()));
        store.setSetting(AWAY_SETTING, JSON.stringify(body.data));
        bus.emit("settings");
        return body.data;
      });

      // Reader: apps/web/src/data.ts#startStream (EventSource topic invalidations and reconnects)
      api.get<{ Querystring: { map?: string } }>("/stream", (req, reply) => {
        const repoId = req.query.map;
        if (repoId !== undefined && !config.repos.some((r) => r.id === repoId))
          return reply.code(404).send({ error: "repo not found" });
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(": connected\n\n");
        let machineTimer: ReturnType<typeof setTimeout> | undefined;
        const send = (topic: Topic) =>
          res.write(`event: changed\ndata: ${JSON.stringify({ topic })}\n\n`);
        const unsubscribe = bus.subscribe((topic) => {
          if (topic !== "machine") {
            send(topic);
            return;
          }
          if (machineTimer !== undefined) return;
          machineTimer = setTimeout(() => {
            machineTimer = undefined;
            send("machine");
          }, 10_000);
        });
        // Map clients refetch the snapshot on reconnect or a gap; deltas are not replayed.
        let unsubscribeMap: (() => void) | undefined;
        if (repoId !== undefined) {
          stopMapRing ??= mapRing.start();
          unsubscribeMap = mapRing.subscribe(repoId, (delta) => {
            res.write(`event: map\ndata: ${JSON.stringify(delta)}\n\n`);
          });
        }
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), heartbeatMs);
        const cleanup = () => {
          clearTimeout(machineTimer);
          clearInterval(heartbeat);
          unsubscribe();
          unsubscribeMap?.();
          streams.delete(end);
          deps.onStreamCount?.(streams.size);
        };
        const end = () => {
          cleanup();
          res.end();
        };
        streams.add(end);
        deps.onStreamCount?.(streams.size);
        res.on("close", cleanup);
      });
    },
    { prefix: API_PREFIX },
  );

  app.addHook("onClose", async () => stopMapRing?.());
  return app;
}

/** The Limits view's GitHub row: the last `rateLimit` reading per query and the last poll's cost. */
export function githubRate(store: Store): GithubRateState {
  const raw = store.getSetting(GITHUB_RATE_SETTING);
  if (raw === null) return { queries: {}, pollCost: null };
  try {
    return JSON.parse(raw) as GithubRateState;
  } catch {
    return { queries: {}, pollCost: null };
  }
}

/**
 * One row per account and window that has samples. Only 7d rows are projected (5h windows are too
 * short for the 24h pace model), from the current window's samples only (`at >= resetAt - 7d`,
 * resetAt from the latest sample), so a previous window's pace never leaks into the projection.
 */
export function limitRows(config: CcConfig, store: Store, now: number): LimitRow[] {
  const rows: LimitRow[] = [];
  for (const acct of config.accounts) {
    let nextTryAt: number | undefined;
    if (acct.vendor === "claude") {
      try {
        const backoff = JSON.parse(store.getSetting(USAGE_BACKOFF_SETTING) ?? "null");
        if (
          backoff &&
          Number.isFinite(backoff.waitMs) &&
          backoff.waitMs > 0 &&
          Number.isFinite(backoff.notBefore)
        ) {
          const capped = Math.min(backoff.notBefore, now + USAGE_BACKOFF_CAP_MS);
          if (capped > now) nextTryAt = capped;
        }
      } catch {
        // An invalid scheduler setting is ignored here; the scheduler removes it on start.
      }
    }
    for (const window of WINDOWS) {
      const latest = store.latestUsage(acct.id, window);
      if (!latest) continue;
      const { resetAt } = latest;
      const base: LimitRowBase = {
        accountId: acct.id,
        used: latest.pct,
        resetAt,
        alertAt: acct.alertAt,
        stopAt: acct.stopAt,
        stale: now - latest.at > DEFAULT_MAX_AGE_MS,
        source: latest.source,
        sampledAt: latest.at,
        ...(nextTryAt === undefined ? {} : { nextTryAt }),
      };
      if (window === "5h") {
        const fiveH: UsageSample[] = store.usage(acct.id, window, resetAt - FIVE_HOURS_MS);
        rows.push({
          ...base,
          window,
          projected: null,
          stopForecast: null,
          fullAt: fullAt5h(fiveH, resetAt),
          paceReady: pace5h(fiveH) !== null,
        });
        continue;
      }
      const samples: UsageSample[] = store.usage(acct.id, window, resetAt - WEEK_MS);
      rows.push({
        ...base,
        window,
        projected: projectAtReset(samples, resetAt),
        stopForecast: stopForecast(samples, acct.stopAt, resetAt),
        fullAt: stopForecast(samples, METER_FULL_PCT, resetAt),
      });
    }
  }
  return rows;
}
