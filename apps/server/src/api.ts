import { readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ACK_BATCH_MAX,
  type AgentStream,
  type AttentionItem,
  type AwaySettings,
  areaOwnsFolder,
  type ChangedFiles,
  type CliAccountStatus,
  COMMS_CAPCOM,
  type ContextUsage,
  CREW_DISABLED,
  type Crew,
  type CrewChanges,
  type CrewMode,
  type CrewSessionFolders,
  DEFAULT_AWAY,
  DRAFT_BAD_TARGET,
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
  guardDecision,
  guardDenyOutput,
  ISSUE_REQUIRED,
  type LimitRow,
  LOCK_WAIT_MS,
  LOOPBACK_HOST,
  lockBusyText,
  type MachineSample,
  type MachineView,
  MC_TEXT_MAX,
  type McToolName,
  METER_FULL_PCT,
  NEW_LOOP,
  pace5h,
  projectAtReset,
  READONLY_FILES_NOTE,
  REVIEW_ROUNDS,
  type RepoProfile,
  type RepoView,
  type RunLoopView,
  type RunView,
  reviewStatusOf,
  seatCallSign,
  seatDef,
  startOfLocalDay,
  stopForecast,
  TELEMETRY_RANGES,
  TEST_LOCK_UNAVAILABLE_TEXT,
  type Telemetry,
  type TelemetryRange,
  type TestLockHistory,
  type TestLockState,
  TYPE_LABELS,
  UPDATE_UNAVAILABLE,
  type UsageSample,
  type VersionInfo,
  watchStartRefusedText,
} from "@mc/core";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { readAccountStatus } from "./accounts.ts";
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
import { DEFAULT_MAX_AGE_MS, WINDOWS } from "./collectors/usage-common.ts";
import { COMMS_SNAPSHOT_LIMIT, threadMessages } from "./comms.ts";
import {
  agentIds,
  type CcConfig,
  configuredAgents,
  crewSeatDef,
  crewSeatGrants,
  crewSeatMode,
  DEFAULT_MAX_SEATS,
} from "./config.ts";
import {
  accountDuplicateReason,
  addAccount,
  addRepo,
  ConfigWriteError,
  duplicateReason,
  NewAccountBody,
  NewRepoBody,
  RepoLocation,
  SeatsBody,
  setSessionSeats,
} from "./config-write.ts";
import type { CrewReloader } from "./crew-apply.ts";
import type { Engine } from "./engine/engine.ts";
import {
  changedFiles,
  committedLines,
  fileDiff,
  type GitExec,
  GitFailed,
  NO_WORKTREE_NOTE,
} from "./files.ts";
import { flightBriefView, flightSeat, flightView } from "./flight/state.ts";
import { ensureFields, ensureLabels, missingLabels, setupStatus } from "./github-setup.ts";
import type { TestLock } from "./guard/lock.ts";
import {
  attentionItems,
  attentionVersion,
  CREW_ERROR_KEY,
  crew,
  NO_LOCK,
  NOTE_KEY,
} from "./hud.ts";
import { LocalNotifications, NotificationPreferencesBody } from "./local-notifications.ts";
import { loopTries } from "./loophistory.ts";
import { createGh, type GhRunner } from "./mcp/gh.ts";
import { bearer, type McpCalls, type McTool, registerMcp, UNKNOWN_RUN } from "./mcp/server.ts";
import type { RunTokens } from "./mcp/tokens.ts";
import { evidenceProblemText, type McToolsDeps, prTextProblem, readKnown } from "./mcp/tools.ts";
import { profilesView } from "./profiles.ts";
import { PreviewError, repoPreview, repoProfiles } from "./repo-profile.ts";
import { adminDirOf, CheckoutError } from "./runtime/checkouts.ts";
import { CrewGitError, crewGit } from "./runtime/git.ts";
import { CREW_ACTION_FAILED, type Supervisor, SupervisorError } from "./runtime/supervisor.ts";
import { type BoardTitleCache, type PrCache, runPrs, runTicket, runView } from "./runview.ts";
import { commsPosition, crewDir, crewPrBodyPath, type Store } from "./store.ts";
import { lastOutputAt, readStream } from "./stream.ts";
import { median, telemetry } from "./telemetry.ts";

import { UPDATE_FAILED, UpdateError, type Updater } from "./update.ts";
import { activity, configView } from "./views.ts";
import { webHandler } from "./web.ts";

export const TELEMETRY_COMMIT_READ_LIMIT = 32;
const TELEMETRY_COMMIT_CONCURRENCY = 4;

/** The only Host names (and Origin hosts) the server answers: loopback, any port. */
/** GitHub issue numbers are 32-bit; anything larger cannot exist. */
const MAX_ISSUE_NUMBER = 2 ** 31 - 1;

export const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", LOOPBACK_HOST]);

/** Every API route is under this prefix. */
const API_PREFIX = "/api";
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
/** The settings-table key of the Away settings. */
export const AWAY_SETTING = "away";
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
    'headers["set-cookie"]',
  ],
  censor: "[redacted]",
};

const VIEWER_QUERY = "query { viewer { login } }";
const GITHUB_LOGIN_RETRY_MS = 5 * 60_000;

export interface AppDeps {
  config: CcConfig;
  gh?: GhRunner;
  knownSecrets?: McToolsDeps["knownSecrets"];
  store: Store;
  bus: ChangeBus;
  /** The latest machine sample (for `/api/machine`); default: none yet. */
  machine?: () => MachineSample | null;
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
  /** Reads a transcript for `/api/agents/:id/stream`; default: `readStream`. */
  readStream?: typeof readStream;
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
  engine?: Pick<Engine, "onOperatorMessage" | "status">;
  /** The Update button (`update.ts`); absent: version says why, and update answers 409. */
  updater?: Updater;
  /** The per-run tokens that authorise `/mcp`; absent: the endpoint is not served. */
  tokens?: RunTokens;
  /** The `/mcp` calls in flight, which a restart waits for; default: not counted. */
  mcpCalls?: McpCalls;
  /** The mc tools `/mcp` serves; default: none (the tools arrive with their tasks). */
  mcpTools?: () => McTool[];
  /** A seat's mode, which decides the mc tools it is offered; default: read-only. */
  seatMode?: (seatId: string) => CrewMode;
  /** The extra mc tools a seat's role holds; default: none. */
  seatGrants?: (seatId: string) => readonly string[];
  /** The test lock the guard takes for a full suite; absent: a full suite is denied, never run unlocked. */
  lock?: TestLock;
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
): {
  tokens: RunTokens;
  lock: TestLock;
  seatMode: (seatId: string) => CrewMode;
  seatGrants: (seatId: string) => McToolName[];
} {
  return {
    tokens,
    lock,
    seatMode: (seatId) => crewSeatMode(config, seatId),
    seatGrants: (seatId) => crewSeatGrants(config, seatId),
  };
}

/** `POST /api/seats/:id/start`: a GitHub issue number. */
const StartBody = z.strictObject({
  issue: z
    .int()
    .min(1)
    .max(2 ** 31 - 1)
    .optional(),
});

/**
 * `POST /api/seats/:id/message`. The text is sent on as typed; it only has to
 * hold something besides whitespace.
 */
const MessageBody = z.strictObject({
  text: z
    .string()
    .max(8000)
    .refine((t) => t.trim() !== "", "must not be blank"),
  interrupt: z.boolean().optional(),
});

/** `POST /api/seats/:id/interrupt` and `/end`: no fields. */
const NoBody = z.strictObject({});

// Ending a run frees the seat for its next ticket; `hold` also takes it out of rotation.
const EndBody = z.strictObject({ hold: z.boolean().optional() });

/**
 * `POST /api/guard/check`: what the guard hook sends (`guard/hook.ts`), and nothing else. A Post
 * event carries no input.
 */
const GuardCheckBody = z.strictObject({
  hook_event_name: z.enum(GUARD_HOOK_EVENTS),
  tool_name: z.string().min(1).max(256),
  tool_use_id: z.string().min(1).max(256),
  tool_input: z
    .strictObject({
      command: z.string().optional(),
      file_path: z.string().optional(),
      run_in_background: z.boolean().optional(),
    })
    .optional(),
});

const MAX_GUARD_DAYS = 30;
const GUARD_DAYS = /^[1-9]\d?$/;

/** `GET /api/agents/:id/files/diff?path=`: one path, as the file list gives it. */
const DiffPath = z.string().min(1).max(4096);

/** `POST /api/attention/ack`. */
const AckBody = z.strictObject({
  keys: z.array(z.string().min(1).max(200)).min(1).max(ACK_BATCH_MAX),
});

/** The answer to a dismiss of a key that is not an open note (a seat's question is not a note). */
export const NO_OPEN_NOTE = "no such open note";

/** `YYYY-MM-DD` naming a real calendar day. */
const isCalendarDate = (s: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
};

/** A full AwaySettings: `until` is empty (until turned off) or a real `YYYY-MM-DD`. */
const AwayBody = z.strictObject({
  on: z.boolean(),
  until: z.string().refine((s) => s === "" || isCalendarDate(s), {
    message: "must be empty or a calendar date YYYY-MM-DD",
  }),
  may: z.strictObject({
    pickUp: z.boolean(),
    research: z.boolean(),
    check: z.boolean(),
    status: z.boolean(),
    safePr: z.boolean(),
  }),
}) satisfies z.ZodType<AwaySettings>;

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
  result: ReturnType<typeof readStream>;
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

/** `?limit=` as an integer 1..max (absent: `fallback`), or null when invalid. */
function parseLimit(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !RUNS_LIMIT.test(raw) || Number(raw) > max) return null;
  return Number(raw);
}

export const ACCOUNT_STATUS_CACHE_MS = 60_000;

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, store, bus } = deps;
  const now = deps.now ?? Date.now;
  const accountStatuses = new Map<string, { status: CliAccountStatus; expiresAt: number }>();
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
  const readTranscript = deps.readStream ?? readStream;
  const worktreeFiles = deps.changedFiles ?? changedFiles;
  const worktreeDiff = deps.fileDiff ?? fileDiff;
  const streamCache = new Map<string, StreamCacheEntry>();

  const app = Fastify({
    bodyLimit: 16 * 1024,
    logger: deps.logger
      ? {
          level: "info",
          redact: LOG_REDACT,
          ...(typeof deps.logger === "object" ? { stream: deps.logger.stream } : {}),
        }
      : false,
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
    if (req.method === "POST" && mediaType(req.headers["content-type"]) !== "application/json") {
      return reply.code(415).send({ error: "POST requires Content-Type: application/json" });
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (req.method === "POST" && origin !== undefined && !isLocalOrigin(origin)) {
      return reply.code(403).send({ error: "cross-origin request refused" });
    }
  });

  // The Origin hook covers POST only, and a cross-site no-cors GET (an <img>, fetch with
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
    });
  }

  const notifications = new LocalNotifications(store, config, bus, now);
  const reconcileNotifications = () =>
    notifications.reconcile(
      attentionItems(
        config,
        store,
        now(),
        deps.lock?.state() ?? NO_LOCK,
        undefined,
        deps.hubLogin?.() ?? null,
      ),
    );
  const unsubscribeNotifications = bus.subscribe((topic) => {
    if (["attention", "agents", "limits", "boards", "escalations", "settings"].includes(topic))
      reconcileNotifications();
  });
  app.addHook("onReady", async () => {
    reconcileNotifications();
  });
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => {
    unsubscribeNotifications();
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
      api.get<{ Params: { id: string }; Querystring: { limit?: unknown } }>(
        "/agents/:id/stream",
        async (req, reply): Promise<AgentStream | FastifyReply> => {
          const limit = parseLimit(req.query.limit, DEFAULT_STREAM_LIMIT, MAX_STREAM_LIMIT);
          if (limit === null) {
            return reply
              .code(400)
              .send({ error: `limit must be an integer 1..${MAX_STREAM_LIMIT}` });
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
          const st = await stat(path).catch(() => null);
          if (!st?.isFile()) return missing();
          const { size, mtimeMs } = st;
          let entry = streamCache.get(agent.id);
          if (
            !entry ||
            entry.path !== path ||
            entry.size !== size ||
            entry.mtimeMs !== mtimeMs ||
            entry.limit !== limit
          ) {
            let result: StreamCacheEntry["result"];
            try {
              result = readTranscript(path, limit);
            } catch {
              return missing();
            }
            entry = { path, size, mtimeMs, limit, result };
            streamCache.set(agent.id, entry);
          }
          return {
            runId: run.id,
            tasks: store.digest(run.id)?.tasks ?? [],
            events: entry.result.events,
            truncated: entry.result.truncated,
            lastOutputAt: lastOutputAt(lastEventAt, Math.floor(mtimeMs)),
            reason: null,
          };
        },
      );

      // Reader: apps/web/src/comms/Conversation.tsx (thread snapshot; web wiring is a separate ticket)
      api.get<{ Params: { id: string } }>("/comms/:id", async (req, reply) => {
        if (!agentById(req.params.id)) return reply.code(404).send({ error: "unknown agent" });
        return {
          messages: threadMessages(store, req.params.id, agentById(req.params.id)?.kind === "crew"),
        };
      });

      // Reader: apps/web/src/comms/Conversation.tsx (opening a thread; web wiring is a separate ticket)
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
              const first = readStream(run.transcriptPath, 200).events[0];
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
            // Only the command, exit code and signal: git's message and any path stay out of the log.
            const git = e instanceof GitFailed ? e : null;
            reply.log.warn(
              {
                command: git?.command ?? null,
                exitCode: git?.exitCode ?? null,
                signal: git?.signal ?? null,
              },
              `file list failed for ${req.params.id}`,
            );
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
            // GitFailed's message is git's own, the worktree path already taken out
            const git = e instanceof GitFailed ? e.message : "not git";
            reply.log.warn({ git }, `file diff failed for ${req.params.id}`);
            return reply.code(502).send({ error: "git failed" });
          }
          if (diff === null) return reply.code(404).send({ error: "unknown file" });
          return diff;
        },
      );

      // The guard (spec §5): the hook asks before every tool call, with its run's token.
      const tokens = deps.tokens;
      const lock = deps.lock;
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
            lock?.release(key);
            return answer();
          }
          const verdict = guardDecision(
            { tool: body.data.tool_name, input: body.data.tool_input ?? {} },
            {
              mode: seatMode(who.seatId),
              repo: "dev",
              fullSuite: config.repos.find((r) => r.id === seat.repoId)?.fullSuite ?? [],
            },
          );
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
              // after `finish` is not seen here: Task 6's `releaseRun` covers it.
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

      api.get("/test-lock", async (): Promise<TestLockState> => lock?.state() ?? NO_LOCK);

      // Reader: apps/web/src/telemetry/CapacityGroup.tsx (the Test lock table), Kpis.tsx (Lock wait) and components/LockLines.tsx (usually about)
      api.get("/test-lock/history", async (): Promise<TestLockHistory> => {
        const at = now();
        const runs = store.lockRuns(at - TELEMETRY_RANGES["7d"] * 60_000);
        const today = runs.filter(
          (r) => r.startedAt >= startOfLocalDay(at, config.operator.timezone),
        );
        const lengths = new Map<string, number[]>();
        for (const r of runs) {
          if (r.outcome !== "done" || r.endedAt === null) continue;
          const list = lengths.get(r.command) ?? [];
          list.push(r.endedAt - r.startedAt);
          lengths.set(r.command, list);
        }
        return {
          runs,
          today: {
            runs: today.length,
            waitMs: today.reduce((sum, r) => sum + r.startedAt - r.queuedAt, 0),
          },
          usualMs: Object.fromEntries(
            [...lengths]
              .filter(([, list]) => list.length >= 3)
              .map(([command, list]) => [command, median(list) as number]),
          ),
        };
      });

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

      // Reader: apps/web/src/setup/Accounts.tsx (account status; UI integration follows)
      api.get("/accounts/status", async () =>
        Promise.all(config.accounts.map((account) => accountStatus(account))),
      );
      // Reader: apps/web/src/setup/Accounts.tsx (Check; UI integration follows)
      api.post<{ Params: { id: string } }>("/accounts/:id/check", async (req, reply) => {
        const account = config.accounts.find((a) => a.id === req.params.id);
        if (!account) return reply.code(404).send({ error: "account not found" });
        return accountStatus(account, true);
      });
      // Reader: apps/web/src/setup/Accounts.tsx (Add account; UI integration follows)
      api.post("/accounts", async (req, reply) => {
        if (!deps.configPath) return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        const body = NewAccountBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        const duplicate = accountDuplicateReason(config.accounts, body.data);
        if (duplicate) return reply.code(409).send({ error: duplicate });
        try {
          const result = await addAccount(deps.configPath, body.data, now());
          const added = result.config.accounts.find((a) => a.id === body.data.name);
          if (added) config.accounts.push(added);
          bus.emit("config");
          return { account: added };
        } catch (e) {
          if (e instanceof ConfigWriteError) {
            return reply
              .code(e.kind === "duplicate" || e.kind === "current" ? 409 : 500)
              .send({ error: e.message });
          }
          return reply.code(500).send({ error: CONFIG_WRITE_FAILED });
        }
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

      // Reader: docs/runbook.md#what-it-observes (by hand until the HUD's refresh button reads it)
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
          if (e instanceof PreviewError) return reply.code(e.status).send({ error: e.message });
          return reply
            .code(502)
            .send({ error: e instanceof Error ? e.message : "github: request failed" });
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

      // `?linked=1`: only the PRs linked to a ticket, the ones the Board can show (#26 A1).
      api.get<{ Params: { repoId: string }; Querystring: { linked?: unknown } }>(
        "/repos/:repoId/prs",
        async (req, reply) => {
          const { linked } = req.query;
          if (linked !== undefined && linked !== "1") {
            return reply.code(400).send({ error: "linked must be 1" });
          }
          const repo = config.repos.find((r) => r.id === req.params.repoId);
          if (!repo) return reply.code(404).send({ error: "unknown repo" });
          const prs = store.pullRequests(repo.id);
          return linked === "1" ? prs.filter((p) => p.ticket !== null) : prs;
        },
      );

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
            // area labels: plan 7a Task 3
            const labelsCreated = await ensureLabels(gql, repo.github, TYPE_LABELS);
            return { ...fields, labelsCreated };
          });
          return result;
        } catch (e) {
          return setupFailed(reply, e);
        }
      });

      api.get("/escalations", async () => store.escalations());

      api.get("/health", async () => store.status());
      api.get("/machine", async (): Promise<MachineView> => {
        const sessions = config.crew?.sessions ?? [];
        const counts = sessions.map((s) => s.seats.length);
        return {
          latest: machine(),
          maxSeats: config.crew?.maxSeats ?? DEFAULT_MAX_SEATS,
          seats: counts.reduce((a, b) => a + b, 0),
          perSessionMax: Math.max(0, ...counts),
        };
      });

      api.get("/activity", async () => activity(config, store, now()));

      api.get("/config", async () =>
        configView(
          config,
          deps.profilesPath === undefined ? undefined : profilesView(deps.profilesPath),
          await readGithubLogin(),
        ),
      );

      // Re-reads the config.yaml the server started with now (no request names a path); a file that
      // does not load changes nothing.
      // Reader: docs/runbook.md#reloading-the-config (by hand until Setup › Sessions, #22, reads it)
      api.post("/config/reload", async (_req, reply) => {
        if (deps.crewReloader === undefined) {
          return reply.code(409).send({ error: CONFIG_WRITES_UNAVAILABLE });
        }
        const result = await deps.crewReloader.reload();
        if (result.error !== null) return reply.code(400).send({ error: result.error });
        return result;
      });

      // Reader: docs/runbook.md#reloading-the-config (by hand until Setup's seat editor reads it)
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

      // Reader: docs/runbook.md#reloading-the-config (by hand until Setup › Sessions, #22, reads it)
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
      ) =>
        api.post<{ Params: { id: string } }>(path, async (req, reply) => {
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
      seatAction("/seats/:id/start", StartBody, (sup, id, b) => {
        const loop = crewSeatDef(config, id).loop;
        // the watch seat runs the crew and takes no ticket; every other seat needs one
        if (loop === "watch") {
          if (b.issue !== undefined) {
            throw new SupervisorError(400, watchStartRefusedText(seatCallSign(id)));
          }
          return sup.startWatch(id);
        }
        if (b.issue === undefined) throw new SupervisorError(400, ISSUE_REQUIRED);
        return deps.engine?.status().on === true && loop === "build"
          ? sup.startRun(id, b.issue, { loop: NEW_LOOP })
          : sup.startRun(id, b.issue);
      });
      seatAction("/seats/:id/message", MessageBody, async (sup, id, b) => {
        const runId = sup.seat(id)?.runId ?? null;
        const ticket = runId === null ? null : (store.run(runId)?.ticket ?? null);
        await sup.message(id, b.text, { interrupt: b.interrupt === true });
        store.addComms({ at: now(), from: COMMS_CAPCOM, to: id, ticket, text: b.text });
        // The operator's word to a parked, looped run's seat un-parks it; the engine decides whether it may
        if (runId !== null && store.run(runId)?.loop) void deps.engine?.onOperatorMessage(runId);
        return { ok: true };
      });
      seatAction("/seats/:id/interrupt", NoBody, async (sup, id) => {
        await sup.interrupt(id);
        return { ok: true };
      });
      seatAction("/seats/:id/end", EndBody, async (sup, id, b) => {
        await sup.endRun(id, { hold: b.hold });
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
      // Reader: apps/web/src/shell/Dock.tsx#Dock (FLIGHT ticket 4)
      api.get("/flight", async () => flightView(config, store, Date.now()));
      // Reader: apps/web/src/shell/Dock.tsx#Dock (FLIGHT page brief, web follow-up of #225)
      api.get("/flight/brief", async () => flightBriefView(config, store));
      api.get("/crew/status", async () => ({
        ...(supervisor?.status() ?? { enabled: false, note: null }),
        ...(deps.engine === undefined ? {} : { engine: deps.engine.status() }),
      }));
      // Reader: apps/web/src/flight/Drafts.tsx and Situation.tsx
      api.get("/drafts", async () => store.drafts());
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
        try {
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
            } catch {
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
          const result = await (deps.gh ?? createGh())(
            [draft.kind, "comment", String(n), `--repo=${repo.github}`, `--body-file=${file}`],
            { cwd: crewDir(store.path) },
          );
          if (result.code !== 0)
            return reply.code(502).send({ error: "GitHub refused the comment." });
          store.finishDraft(id, "posted", body);
          if (thread) {
            store.markNotificationHandled(thread.id, thread.updatedAt, "replied", now());
            bus.emit("attention");
          }
          bus.emit("flight");
          return { ok: true };
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
      api.post<{ Params: { id: string } }>("/drafts/:id/discard", async (req, reply) => {
        const id = Number(req.params.id);
        if (postingDrafts.has(id)) return reply.code(409).send({ error: "Draft is being posted." });
        if (!store.drafts().some((d) => d.id === id))
          return reply.code(404).send({ error: "No pending draft." });
        store.finishDraft(id, "discarded");
        bus.emit("flight");
        return { ok: true };
      });

      // The operator ends a run set aside in review, without waking it.
      // Reader: apps/web/src/agent/LoopSteps.tsx (the End action on a set-aside run; the web part follows)
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
      // A looped run's state and its Activity rows, on demand.
      // Reader: apps/web/src/agent/LoopSteps.tsx (the Steps view; it reads this once Plan 7a Task 8 lands)
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
            ? Math.min(REVIEW_ROUNDS, 1 + fixesSent(store.claimedKeys(run.id), run.id, loop.epoch))
            : null,
          budget:
            loop && config.crew?.runTokenBudget !== undefined
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

      api.get(
        "/crew",
        async (): Promise<Crew> => crew(config, store, now(), deps.lock?.state() ?? NO_LOCK),
      );

      // The Update button. Texts are fixed; the commands' output goes to update.log only.
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
          if (e instanceof UpdateError) {
            return reply.code(e.status).send({ error: e.message, checkedAt: e.checkedAt ?? null });
          }
          reply.log.warn({ err: e instanceof Error ? e.name : typeof e }, "version check failed");
          return reply.code(500).send({ error: CHECK_FAILED });
        }
      });
      api.post(
        "/update",
        {
          // The exit is scheduled only once the 202 has gone out.
          onResponse: async (_req, reply) => {
            if (reply.statusCode === 202) updater?.restart();
          },
        },
        async (req, reply) => {
          const body = NoBody.safeParse(req.body);
          if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
          if (!updater) return reply.code(409).send({ error: UPDATE_UNAVAILABLE });
          try {
            const out = await updater.update();
            return "restarting" in out ? reply.code(202).send(out) : out;
          } catch (e) {
            if (e instanceof UpdateError) return reply.code(e.status).send({ error: e.message });
            reply.log.warn({ err: e instanceof Error ? e.name : typeof e }, "update failed");
            return reply.code(500).send({ error: UPDATE_FAILED });
          }
        },
      );

      api.get(
        "/attention",
        async (): Promise<AttentionItem[]> =>
          attentionItems(
            config,
            store,
            now(),
            deps.lock?.state() ?? NO_LOCK,
            undefined,
            deps.hubLogin?.() ?? null,
          ),
      );

      const discussionSends = new Set<string>();
      const currentDiscussionItem = (key: string) => {
        const item = attentionItems(
          config,
          store,
          now(),
          deps.lock?.state() ?? NO_LOCK,
          undefined,
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
            text: z.string().trim().min(1).max(4000),
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
        } catch {
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

      // Reader: apps/web/src/comms/NeedsList.tsx (the Needs-you Dismiss button; the web side is its own ticket)
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

      // Reader: apps/web/src/data.ts (notification settings; web wiring is a separate ticket)
      api.get("/notification-preferences", async () => notifications.preferences());

      // Reader: apps/web/src/data.ts (notification settings; web wiring is a separate ticket)
      api.post("/notification-preferences", async (req, reply) => {
        const body = NotificationPreferencesBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        notifications.setPreferences(body.data);
        return notifications.preferences();
      });

      // Reader: apps/web/src/notifications.ts (local notification feed; web wiring is a separate ticket)
      api.get("/notifications/events", async () => {
        reconcileNotifications();
        return notifications.events();
      });

      // Reader: apps/web/src/notifications.ts (Send a test notification; web wiring is a separate ticket)
      api.post("/notifications/test", async (req, reply) => {
        const body = NoBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        return notifications.test();
      });

      // Reader: apps/web/src/flight/AskedOfYou.tsx (the person cards; the web side is its own ticket)
      api.get(
        "/notifications",
        async (): Promise<NotificationsView> => notificationsView(config, store, now()),
      );

      // Reader: apps/web/src/shell/ItemPanel.tsx (the person variant's Mark handled; the web side is its own ticket)
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

      api.get("/settings/away", async (): Promise<AwaySettings> => {
        const raw = store.getSetting(AWAY_SETTING);
        if (raw === null) return DEFAULT_AWAY;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return DEFAULT_AWAY;
        }
        const stored = AwayBody.safeParse(parsed);
        return stored.success ? stored.data : DEFAULT_AWAY;
      });

      api.post("/settings/away", async (req, reply) => {
        const body = AwayBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: zodError(body.error) });
        store.setSetting(AWAY_SETTING, JSON.stringify(body.data));
        bus.emit("settings");
        return body.data;
      });

      api.get("/stream", (_req, reply) => {
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(": connected\n\n");
        const unsubscribe = bus.subscribe((topic) => {
          res.write(`event: changed\ndata: ${JSON.stringify({ topic })}\n\n`);
        });
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), heartbeatMs);
        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          streams.delete(end);
        };
        const end = () => {
          cleanup();
          res.end();
        };
        streams.add(end);
        res.on("close", cleanup);
      });
    },
    { prefix: API_PREFIX },
  );

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
