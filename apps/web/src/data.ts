/**
 * Server data for the pages: one cached resource per API path, fetched while something renders
 * it, and refetched when the SSE stream says its topic changed. No state library: a Map plus
 * useSyncExternalStore.
 */
import {
  type CrewRow,
  GUARD_WINDOW_DAYS,
  type PullRequestView,
  TOPICS,
  type Topic,
} from "@mc/core";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { apiGet } from "./api.ts";

export interface Resource<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
}

/**
 * An API resource: its path, and the SSE topic that invalidates it (null: no topic; static, or
 * refreshed by its component).
 */
export interface ResourceRef {
  path: string;
  topic: Topic | null;
}

export const RUNS_LIMIT = 50;
/** How often a running seat's context is asked of its CLI (each fetch is a live control request). */
export const SEAT_CONTEXT_REFRESH_MS = 30_000;
const enc = encodeURIComponent;

/** The one place the web app names API paths and their topics. */
export const RESOURCES = {
  teams: { path: "/api/sources/teams", topic: "attention" },
  teamsSelection: { path: "/api/sources/teams/selection", topic: null },
  // The HUD's views (Plan 3).
  crew: { path: "/api/crew", topic: "agents" },
  // Reads each session's checkout folders from disk on each fetch, so once per visit.
  crewSessions: { path: "/api/crew/sessions", topic: null },
  // Whether this server runs crew sessions (off on a preview, or when another server holds
  // the lock).
  crewStatus: { path: "/api/crew/status", topic: "agents" },
  // What the last read of config.yaml says against what runs (pending seat changes, errors).
  crewChanges: { path: "/api/crew/changes", topic: "config" },
  discussion: (key: string, id = ""): ResourceRef => ({
    path: `/api/attention/${enc(key)}/discussion${id ? `?id=${enc(id)}` : ""}`,
    topic: "attention",
  }),
  attention: { path: "/api/attention", topic: "attention" },
  notificationPreferences: { path: "/api/notification-preferences", topic: "settings" },
  notificationEvents: { path: "/api/notifications/events", topic: "attention" },
  notifications: { path: "/api/notifications", topic: "attention" },
  // TODO(#232): topic becomes "flight" once core names it; "agents" meanwhile, as FLIGHT's seat is one.
  flight: { path: "/api/flight", topic: "agents" },
  drafts: { path: "/api/drafts", topic: "flight" },
  flightSchedule: { path: "/api/flight/schedule", topic: "flight" },
  flightIncoming: { path: "/api/flight/incoming", topic: "flight" },
  flightBrief: { path: "/api/flight/brief", topic: "flight" },
  machine: { path: "/api/machine", topic: "machine" },
  away: { path: "/api/settings/away", topic: "settings" },
  /** `range` is checked against TELEMETRY_RANGES by the caller; "" for agent/account/ticket is all. */
  telemetry: (range: string, agent = "", account = "", ticket = ""): ResourceRef => ({
    path:
      `/api/telemetry?range=${enc(range)}` +
      (agent === "" ? "" : `&agent=${enc(agent)}`) +
      (account === "" ? "" : `&account=${enc(account)}`) +
      (ticket === "" ? "" : `&ticket=${enc(ticket)}`),
    topic: "agents",
  }),
  comms: (agentId: string): ResourceRef => ({
    path: `/api/comms/${enc(agentId)}`,
    topic: "agents",
  }),
  stream: (agentId: string): ResourceRef => ({
    path: `/api/agents/${enc(agentId)}/stream`,
    topic: "agents",
  }),
  // Only the PRs linked to a ticket: the Board, the one reader, shows no other (#26 A1).
  prs: (repoId: string): ResourceRef => ({
    path: `/api/repos/${enc(repoId)}/prs?linked=1`,
    topic: "boards",
  }),
  // Runs git in the worktree on each fetch, so it is fetched once per visit.
  files: (agentId: string): ResourceRef => ({
    path: `/api/agents/${enc(agentId)}/files`,
    topic: null,
  }),
  // One listed file's diff: git again, so fetched when the file is opened.
  fileDiff: (agentId: string, path: string): ResourceRef => ({
    path: `/api/agents/${enc(agentId)}/files/diff?path=${enc(path)}`,
    topic: null,
  }),
  escalations: { path: "/api/escalations", topic: "escalations" },
  /** Who holds the full-suite lock and who waits; the server emits "guard" when that changes. */
  testLockHistory: { path: "/api/test-lock/history", topic: "guard" },
  testLock: { path: "/api/test-lock", topic: "guard" },
  guardHits: { path: `/api/guard/hits?days=${GUARD_WINDOW_DAYS}`, topic: "guard" },
  accountStatus: { path: "/api/accounts/status", topic: "config" },
  limits: { path: "/api/limits", topic: "limits" },
  // Changes with each GitHub poll, which emits `limits`.
  githubRate: { path: "/api/limits/github", topic: "limits" },
  repos: { path: "/api/repos", topic: "config" },
  repoProfiles: { path: "/api/repos/profiles", topic: "boards" },
  health: { path: "/api/health", topic: "health" },
  // Run-derived: refetched when runs change.
  activity: { path: "/api/activity", topic: "agents" },
  config: { path: "/api/config", topic: "config" },
  // Runs git in the hub's checkout (a fetch at most every 10 minutes), so once per visit.
  version: { path: "/api/version", topic: null },
  boards: (repoId: string): ResourceRef => ({
    path: `/api/boards/${enc(repoId)}`,
    topic: "boards",
  }),
  // Live from GitHub on each fetch, so once per visit rather than on board ticks.
  ticket: (repoId: string, issueNumber: number): ResourceRef => ({
    path: `/api/boards/${enc(repoId)}/items/${issueNumber}`,
    topic: null,
  }),
  // Read live from the CLI on each fetch, so not tied to agents events: the Context tile
  // refetches it every SEAT_CONTEXT_REFRESH_MS while the seat runs, and when its turn ends.
  seatContext: (seatId: string): ResourceRef => ({
    path: `/api/seats/${enc(seatId)}/context`,
    topic: null,
  }),
  runs: (agentId: string): ResourceRef => ({
    path: `/api/agents/${enc(agentId)}/runs?limit=${RUNS_LIMIT}`,
    topic: "agents",
  }),
  /** A run's loop (`RunLoopView`: loop, events, tries, round, budget, review); `loop.aside` is set while it is off its seat. */
  runLoop: (runId: string): ResourceRef => ({
    path: `/api/runs/${enc(runId)}/loop`,
    topic: "agents",
  }),
} as const satisfies Record<
  string,
  | ResourceRef
  | ((id: string) => ResourceRef)
  | ((id: string, n: number) => ResourceRef)
  | ((id: string, s: string) => ResourceRef)
>;

/** POST endpoints. */
export const ACTIONS = {
  notificationPreferences: RESOURCES.notificationPreferences.path,
  notificationTest: "/api/notifications/test",
  commsRead: (agentId: string) => `/api/comms/${enc(agentId)}/read`,
  addAccount: "/api/accounts",
  checkAccount: (id: string) => `/api/accounts/${enc(id)}/check`,
  postDraft: (id: string) => `/api/drafts/${enc(id)}/post`,
  discardDraft: (id: string) => `/api/drafts/${enc(id)}/discard`,
  pause: (agentId: string) => `/api/agents/${enc(agentId)}/pause`,
  resume: (agentId: string) => `/api/agents/${enc(agentId)}/resume`,
  /** Body `{ keys: string[] }`. */
  ack: "/api/attention/ack",
  /** Body `{}`; a 404 `{ error }` when the server will not dismiss it. */
  dismiss: (key: string) => `/api/attention/${enc(key)}/dismiss`,
  /** Body `{}`; a 404 `{ error }` when the thread is no longer open. Local only. */
  handled: (key: string) => `/api/attention/${enc(key)}/handled`,
  /** Body: the whole AwaySettings. */
  away: RESOURCES.away.path,
  /** Body `{ github, project }`; answers a RepoPreview and writes nothing. */
  previewRepo: "/api/repos/preview",
  /** Body: a NewRepo; answers `{ repo, backup }` after writing config.yaml. */
  addRepo: "/api/repos",
  /** GET answers a BoardSetupStatus (a GitHub read); POST `{}` creates what is missing. */
  boardSetup: (repoId: string) => `/api/boards/${enc(repoId)}/setup`,
  /** Body `{ issue }`, or `{}` for FLIGHT; answers `{ runId, branch? }`. */
  seatStart: (seatId: string) => `/api/seats/${enc(seatId)}/start`,
  /** Body `{ text, interrupt? }`. */
  seatMessage: (seatId: string) => `/api/seats/${enc(seatId)}/message`,
  /** Body `{}`. */
  seatInterrupt: (seatId: string) => `/api/seats/${enc(seatId)}/interrupt`,
  /** Body `{}`: ends the run. */
  seatEnd: (seatId: string) => `/api/seats/${enc(seatId)}/end`,
  /** Body `{}`: ends a run set aside in review, without waking it; a 409 if it is not aside. */
  runEnd: (runId: string) => `/api/runs/${enc(runId)}/end`,
  /** Body `{ base, seats }`; answers `{ backup, changes }` after writing config.yaml. */
  crewSeats: (sessionId: string) => `/api/crew/sessions/${enc(sessionId)}/seats`,
  /** Body `{}`; answers a ReloadResult. */
  reloadConfig: "/api/config/reload",
  /** Body `{}`: fetches origin/main now (at most every 15 s); answers a VersionInfo. */
  versionCheck: "/api/version/check",
  /** Body `{}`: pulls main, builds, and restarts the hub (202), or answers `{ upToDate }`. */
  update: "/api/update",
} as const;

interface Entry {
  path: string;
  topic: Topic | null;
  snap: Resource<unknown>;
  listeners: Set<() => void>;
  inflight: boolean;
  again: boolean;
}

const IDLE: Resource<never> = { data: undefined, error: null, loading: false };

class Hub {
  private readonly entries = new Map<string, Entry>();
  /** Bumped by clear(): a response to a request from an older generation is dropped. */
  private generation = 0;

  private entry(path: string, topic: Topic | null): Entry {
    let e = this.entries.get(path);
    if (!e) {
      e = { path, topic, snap: IDLE, listeners: new Set(), inflight: false, again: false };
      this.entries.set(path, e);
    }
    return e;
  }

  private set(e: Entry, snap: Resource<unknown>): void {
    e.snap = snap;
    for (const fn of [...e.listeners]) fn();
  }

  snapshot(path: string, topic: Topic | null): Resource<unknown> {
    return this.entry(path, topic).snap;
  }

  subscribe(path: string, topic: Topic | null, fn: () => void): () => void {
    const e = this.entry(path, topic);
    e.listeners.add(fn);
    if (e.listeners.size === 1) void this.fetch(e);
    return () => {
      e.listeners.delete(fn);
    };
  }

  /** One request per path at a time; a change during a fetch queues exactly one more. */
  private async fetch(e: Entry): Promise<void> {
    if (e.inflight) {
      e.again = true;
      return;
    }
    const gen = this.generation;
    e.inflight = true;
    this.set(e, { ...e.snap, loading: true });
    let next: Resource<unknown>;
    try {
      next = { data: await apiGet<unknown>(e.path), error: null, loading: false };
    } catch (err) {
      // Keep the last good data on screen; show the error beside it.
      const error = err instanceof Error ? err : new Error(String(err));
      next = { ...e.snap, error, loading: false };
    }
    if (gen !== this.generation) return; // cleared meanwhile: this answer belongs to the old session
    e.inflight = false;
    this.set(e, next);
    if (e.again) {
      e.again = false;
      void this.fetch(e);
    }
  }

  refetch(path: string): void {
    const e = this.entries.get(path);
    if (e && e.listeners.size > 0) void this.fetch(e);
  }

  /** Refetch only what is on screen and belongs to the changed topic. */
  refetchTopic(topic: Topic): void {
    for (const e of this.entries.values()) {
      // The server filters watch rows using both the lock and crew state. Refetch
      // the brief when either changes, including rows omitted from its last response.
      const briefChanged =
        e.path === RESOURCES.flightBrief.path && (topic === "guard" || topic === "agents");
      const notificationSettingsChanged =
        topic === "settings" && e.path === RESOURCES.notificationEvents.path;
      if (
        (e.topic === topic || briefChanged || notificationSettingsChanged) &&
        e.listeners.size > 0
      )
        void this.fetch(e);
    }
  }

  refetchAll(): void {
    for (const e of this.entries.values()) if (e.listeners.size > 0) void this.fetch(e);
  }

  /**
   * Forget cached data (the tests' reset between cases: the hub is a module singleton).
   * Requests still in flight are abandoned: their responses are dropped when they arrive.
   * What is still on screen is fetched again at once, rather than left idle until the next event.
   */
  clear(): void {
    this.generation++;
    for (const e of this.entries.values()) {
      e.inflight = false;
      e.again = false;
      this.set(e, IDLE);
    }
    this.refetchAll();
  }
}

export const hub = new Hub();

export function useResource<T>(ref: ResourceRef | null): Resource<T> {
  const path = ref?.path ?? null;
  const topic = ref?.topic ?? null;
  const subscribe = useCallback(
    (fn: () => void) => (path ? hub.subscribe(path, topic, fn) : () => {}),
    [path, topic],
  );
  const get = useCallback(() => (path ? hub.snapshot(path, topic) : IDLE), [path, topic]);
  return useSyncExternalStore(subscribe, get) as Resource<T>;
}

/**
 * The PRs of a crew seat's repo while it has an open review, where the title of the PR it waits on
 * is (a crew run's own `prs` is always empty); undefined while they load. Nothing is fetched for
 * any other row, nor for one with a note (its doing line is the note, see seatReview). A failed
 * load gives none, so the line settles on the seat's last words.
 */
export function useReviewPrs(
  row: Pick<CrewRow, "kind" | "note" | "repoId" | "review"> | undefined,
): PullRequestView[] | undefined {
  const wanted = row?.kind === "crew" && row.review !== null && !row.note;
  const prs = useResource<PullRequestView[]>(wanted ? RESOURCES.prs(row.repoId) : null);
  return prs.data ?? (prs.error ? [] : undefined);
}

const NONE: Resource<never>[] = [];

/**
 * Several resources of one shape (a board per repo); the list may change length between renders.
 * Returns the same array while no snapshot changed.
 */
export function useResources<T>(refs: ResourceRef[]): Resource<T>[] {
  const key = refs.map((r) => r.path).join("\n");
  const last = useRef<Resource<unknown>[]>(NONE);
  const current = useRef(refs);
  current.current = refs;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the refs' contents
  const subscribe = useCallback(
    (fn: () => void) => {
      const offs = current.current.map((r) => hub.subscribe(r.path, r.topic, fn));
      return () => {
        for (const off of offs) off();
      };
    },
    [key],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the refs' contents
  const get = useCallback(() => {
    const next = current.current.map((r) => hub.snapshot(r.path, r.topic));
    const prev = last.current;
    if (next.length === prev.length && next.every((s, i) => s === prev[i])) return prev;
    last.current = next;
    return next;
  }, [key]);
  return useSyncExternalStore(subscribe, get) as Resource<T>[];
}

export function parseTopic(data: unknown): Topic | null {
  if (typeof data !== "string") return null;
  try {
    const t = (JSON.parse(data) as { topic?: unknown }).topic;
    return TOPICS.find((x) => x === t) ?? null;
  } catch {
    return null;
  }
}

const RETRY_MS = 5000;

/**
 * Subscribe to `/api/stream`. Each `changed` event refetches that topic only. After a reconnect
 * everything on screen is refetched, since events sent while disconnected are lost. If the stream
 * is refused it retries after a pause.
 */
export function startStream(): () => void {
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let connectedBefore = false;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    const source = new EventSource("/api/stream");
    es = source;
    source.addEventListener("open", () => {
      if (connectedBefore) hub.refetchAll();
      connectedBefore = true;
    });
    source.addEventListener("changed", (ev) => {
      const topic = parseTopic((ev as MessageEvent).data);
      if (topic) hub.refetchTopic(topic);
    });
    source.addEventListener("error", () => {
      if (source.readyState !== EventSource.CLOSED) return; // the browser is reconnecting
      source.close();
      retry = setTimeout(() => {
        hub.refetchAll();
        connect();
      }, RETRY_MS);
    });
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    es?.close();
  };
}
