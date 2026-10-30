/**
 * Server data for the pages: one cached resource per API path, fetched while something renders
 * it, and refetched when the SSE stream says its topic changed. No state library: a Map plus
 * useSyncExternalStore.
 */
import {
  ACTIVITY_LIMIT,
  ACTIVITY_WINDOW_MS,
  type ActivityRow,
  type CrewRow,
  type FlightLedgerView,
  GUARD_WINDOW_DAYS,
  type PullRequestView,
  TOPICS,
  type Topic,
} from "@mc/core";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { apiGet } from "./api.ts";
import { store } from "./shell/store.ts";

export interface Resource<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
}

/**
 * An API resource: its path, and the SSE topics that invalidate it (null: no topic; static, or
 * refreshed by its component).
 */
export interface ResourceRef {
  path: string;
  topic: Topic | readonly Topic[] | null;
}

export const RUNS_LIMIT = 50;
/** How often a running seat's context is asked of its CLI (each fetch is a live control request). */
export const SEAT_CONTEXT_REFRESH_MS = 30_000;
// Full loads reconcile mutable activity rows and arrivals older than the delta cursor.
const ACTIVITY_FULL_LOAD_MS = 60_000;
const enc = encodeURIComponent;
const OVERVIEW_TOPICS: readonly Topic[] = ["agents", "boards", "limits", "attention", "machine"];
const METRICS_TOPICS: readonly Topic[] = ["agents", "boards"];
const FLIGHT_MEMORY_PATH = "/api/flight/memory";

type PageDocument = {
  visibilityState: "hidden" | "visible" | string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

const pageDocument = (): PageDocument | undefined =>
  (globalThis as { document?: PageDocument }).document;

/** The one place the web app names API paths and their topics. */
export const RESOURCES = {
  teams: { path: "/api/sources/teams", topic: "attention" },
  teamsSelection: { path: "/api/sources/teams/selection", topic: null },
  // The HUD's views (Plan 3).
  overviewTimeline: { path: "/api/overview/timeline", topic: "agents" },
  overview: (session = ""): ResourceRef => ({
    path: `/api/overview${session && session !== "all" ? `?session=${enc(session)}` : ""}`,
    topic: OVERVIEW_TOPICS,
  }),
  // The metric registry's server figures (METRICS in @mc/core), for the header's session filter.
  metrics: (session = ""): ResourceRef => ({
    path: `/api/metrics${session && session !== "all" ? `?session=${enc(session)}` : ""}`,
    topic: METRICS_TOPICS,
  }),
  focus: (id: string): ResourceRef => ({ path: `/api/seats/${enc(id)}/focus`, topic: "config" }),
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
  heldAttention: { path: "/api/attention/held", topic: "attention" },
  attention: { path: "/api/attention", topic: "attention" },
  attentionItem: (key: string): ResourceRef => ({
    path: `/api/attention/${enc(key)}`,
    topic: "attention",
  }),
  notificationPreferences: { path: "/api/notification-preferences", topic: "settings" },
  notificationEvents: { path: "/api/notifications/events", topic: "attention" },
  notifications: { path: "/api/notifications", topic: "attention" },
  // TODO(#232): topic becomes "flight" once core names it; "agents" meanwhile, as FLIGHT's seat is one.
  flight: { path: "/api/flight", topic: "agents" },
  drafts: { path: "/api/drafts", topic: "flight" },
  draftHistory: { path: "/api/drafts/history", topic: "flight" },
  flightSchedule: { path: "/api/flight/schedule", topic: "flight" },
  flightIncoming: { path: "/api/flight/incoming", topic: "flight" },
  flightBrief: { path: "/api/flight/brief", topic: "flight" },
  flightSummary: { path: "/api/flight/summary", topic: "flight" },
  flightLedgerOpen: { path: "/api/flight/ledger?status=open", topic: "flight" },
  flightLedger: { path: "/api/flight/ledger?status=all", topic: "flight" },
  flightMemory: (repoId: string): ResourceRef => ({
    path: `${FLIGHT_MEMORY_PATH}?repo=${enc(repoId)}`,
    topic: "flight",
  }),
  machine: { path: "/api/machine", topic: "machine" },
  awayDigest: (since = ""): ResourceRef => ({
    path: `/api/away/digest${since ? `?since=${enc(since)}` : ""}`,
    topic: "settings",
  }),
  crewPause: { path: "/api/settings/crew-pause", topic: "settings" },
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
  audit: (range: string): ResourceRef => ({
    path: `/api/audit?range=${enc(range)}`,
    topic: "agents",
  }),
  comms: (agentId: string): ResourceRef => ({
    path: `/api/comms/${enc(agentId)}`,
    topic: "agents",
  }),
  /** The stored Comms views.  Unlike the older transcript endpoint above, these include labels,
   * replies, reactions, pins and read cursors. */
  commsCrew: { path: "/api/comms/crew", topic: "agents" },
  commsFlight: { path: "/api/comms/flight", topic: "agents" },
  commsAgent: (agentId: string): ResourceRef => ({
    path: `/api/comms/agents/${enc(agentId)}`,
    topic: "agents",
  }),
  commsContact: (agentId: string, contactId: string): ResourceRef => ({
    path: `/api/comms/agents/${enc(agentId)}/contacts/${enc(contactId)}`,
    topic: "agents",
  }),
  commsMentions: { path: "/api/comms/mentions", topic: "agents" },
  commsPins: { path: "/api/comms/pins", topic: "agents" },
  commsLinks: { path: "/api/comms/links", topic: "agents" },
  commsTraffic: { path: "/api/comms/traffic", topic: "agents" },
  commsChatter: { path: "/api/comms/chatter", topic: "agents" },
  stream: (agentId: string): ResourceRef => ({
    path: `/api/agents/${enc(agentId)}/stream`,
    topic: "agents",
  }),
  // Only the PRs linked to a ticket: the Board, the one reader, shows no other (#26 A1).
  prs: (repoId: string): ResourceRef => ({
    path: `/api/repos/${enc(repoId)}/prs?linked=1`,
    topic: "boards",
  }),
  // Every PR of the repo, linked to a ticket or not: the command palette reaches them all.
  allPrs: (repoId: string): ResourceRef => ({
    path: `/api/repos/${enc(repoId)}/prs`,
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
  allAccountModels: { path: "/api/accounts/models", topic: "config" },
  accountModels: (id: string): ResourceRef => ({
    path: `/api/accounts/${enc(id)}/models`,
    topic: null,
  }),
  limits: { path: "/api/limits", topic: "limits" },
  // Changes with each GitHub poll, which emits `limits`.
  githubRate: { path: "/api/limits/github", topic: "limits" },
  /** A GitHub read of what the board lacks (field and label setup); read fresh, once per check. */
  boardSetup: (repoId: string): ResourceRef => ({
    path: `/api/boards/${enc(repoId)}/setup`,
    topic: null,
  }),
  repoMap: (id: string): ResourceRef => ({ path: `/api/repos/${enc(id)}/map`, topic: null }),
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

/** Mutation endpoints. */
export const ACTIONS = {
  /** Body `{ base, profile }`; returns the refreshed template profiles. */
  createProfile: "/api/profiles",
  flightMemory: (repoId: string, topic: string) =>
    `${FLIGHT_MEMORY_PATH}/${enc(repoId)}/${enc(topic)}`,
  notificationPreferences: RESOURCES.notificationPreferences.path,
  notificationTest: "/api/notifications/test",
  commsRead: (agentId: string) => `/api/comms/${enc(agentId)}/read`,
  commsSend: "/api/comms",
  addAccount: "/api/accounts",
  account: (id: string) => `/api/accounts/${enc(id)}`,
  checkAccount: (id: string) => `/api/accounts/${enc(id)}/check`,
  refreshAccountModels: (id: string) => `/api/accounts/${enc(id)}/models/refresh`,
  postDraft: (id: string) => `/api/drafts/${enc(id)}/post`,
  copyDraft: (id: string) => `/api/drafts/${enc(id)}/copied`,
  discardDraft: (id: string) => `/api/drafts/${enc(id)}/discard`,
  pause: (agentId: string) => `/api/agents/${enc(agentId)}/pause`,
  resume: (agentId: string) => `/api/agents/${enc(agentId)}/resume`,
  /** Body `{ keys: string[] }`. */
  hold: (key: string) => `/api/attention/${enc(key)}/hold`,
  releaseHold: (key: string) => `/api/attention/${enc(key)}/hold/release`,
  ack: "/api/attention/ack",
  /** Body `{}`; a 404 `{ error }` when the server will not dismiss it. */
  dismiss: (key: string) => `/api/attention/${enc(key)}/dismiss`,
  /** Body `{}`; a 404 `{ error }` when the thread is no longer open. Local only. */
  handled: (key: string) => `/api/attention/${enc(key)}/handled`,
  /** Body: the whole AwaySettings. */
  crewPause: RESOURCES.crewPause.path,
  away: RESOURCES.away.path,
  /** Body `{ github, project }`; answers a RepoPreview and writes nothing. */
  previewRepo: "/api/repos/preview",
  /** Read-only git/remote/branch preflight for adding or converting a crew repo. */
  previewCheckout: "/api/repos/checkout-preview",
  /** Body: a NewRepo; answers `{ repo, backup }` after writing config.yaml. */
  addRepo: "/api/repos",
  /** Atomically writes a new/converted repo, its setup fields and optional empty crew session. */
  onboardRepo: "/api/repos/onboard",
  /** Body `{ defaultAccountId, guidance }`; saves a repo card's configuration. */
  repoSetup: (repoId: string) => `/api/repos/${enc(repoId)}/setup`,
  /** GET answers a BoardSetupStatus (a GitHub read); POST `{}` creates what is missing. */
  boardSetup: (repoId: string) => RESOURCES.boardSetup(repoId).path,
  /** Body `{ accountId }`; answers resumed, fresh or refused with a reason. */
  seatTransfer: (seatId: string) => `/api/seats/${enc(seatId)}/transfer`,
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
  /** Body `{}`: explicitly accepts a parked review's findings and resumes its run. */
  runResume: (runId: string) => `/api/runs/${enc(runId)}/resume`,
  /** Body `{ text }`: sends a review park's findings back for rework without waiving them. */
  runMessage: (runId: string) => `/api/runs/${enc(runId)}/message`,
  /** Body `{ base, seats }`; answers `{ backup, changes }` after writing config.yaml. */
  addSession: "/api/crew/sessions",
  closeSession: (sessionId: string) => `/api/crew/sessions/${enc(sessionId)}/close`,
  crewSeats: (sessionId: string) => `/api/crew/sessions/${enc(sessionId)}/seats`,
  /** Body `{}`; answers a ReloadResult. */
  reloadConfig: "/api/config/reload",
  /** Body `{}`: fetches origin/main now (at most every 15 s); answers a VersionInfo. */
  versionCheck: "/api/version/check",
  /** Body `{}`: pulls main, builds, and restarts the hub (202), or answers `{ upToDate }`. */
  update: "/api/update",
} as const;

/** Stable identity for the activity API, which currently supplies no source id. */
export function activityKey(row: ActivityRow): string {
  if (row.runId && (row.kind === "run-start" || row.kind === "run-end")) {
    return JSON.stringify([row.kind, row.runId]);
  }
  return JSON.stringify([
    row.at,
    row.who,
    row.kind,
    row.runId,
    row.ref,
    row.kind === "comms" ? row.to : null,
    row.text,
  ]);
}

export function compareActivity(a: ActivityRow, b: ActivityRow): number {
  const ak = activityKey(a);
  const bk = activityKey(b);
  return b.at - a.at || (ak < bk ? -1 : ak > bk ? 1 : 0);
}

function reconcileActivity(incoming: ActivityRow[], previous: ActivityRow[]): ActivityRow[] {
  const cached = new Map<string, ActivityRow[]>();
  for (const row of previous) {
    const key = activityKey(row);
    const group = cached.get(key) ?? [];
    group.push(row);
    cached.set(key, group);
  }
  const rows = incoming
    .map((row) => {
      const old = cached.get(activityKey(row))?.shift();
      return old && JSON.stringify(old) === JSON.stringify(row) ? old : row;
    })
    .sort(compareActivity);
  return rows.length === previous.length && rows.every((row, i) => row === previous[i])
    ? previous
    : rows;
}

interface Entry {
  path: string;
  topic: Topic | readonly Topic[] | null;
  snap: Resource<unknown>;
  listeners: Set<() => void>;
  inflight: boolean;
  again: boolean;
  queued?: boolean;
  fullAgain?: boolean;
  activityFullAt?: number;
  activityTimer?: ReturnType<typeof setTimeout>;
  /** The start sequence of the newest answer kept: an older request must not replace it. */
  appliedSeq: number;
  settled: number;
  settledListeners: Set<() => void>;
}

const IDLE: Resource<never> = { data: undefined, error: null, loading: false };

class Hub {
  private readonly entries = new Map<string, Entry>();
  /** Bumped by clear(): a response to a request from an older generation is dropped. */
  private generation = 0;
  /** Stamps each request as it starts, so answers can be told apart by age. */
  private seq = 0;

  private entry(path: string, topic: Topic | readonly Topic[] | null): Entry {
    let e = this.entries.get(path);
    if (!e) {
      e = {
        path,
        topic,
        snap: IDLE,
        listeners: new Set(),
        inflight: false,
        again: false,
        appliedSeq: 0,
        settled: 0,
        settledListeners: new Set(),
      };
      this.entries.set(path, e);
    }
    return e;
  }

  private set(e: Entry, snap: Resource<unknown>): void {
    if (e.snap === snap) return;
    e.snap = snap;
    for (const fn of [...e.listeners]) fn();
  }

  snapshot(path: string, topic: Topic | readonly Topic[] | null): Resource<unknown> {
    return this.entry(path, topic).snap;
  }

  /** Read-only coordination for consumers that must wait for two related snapshots to settle. */
  isFetching(path: string): boolean {
    return this.entries.get(path)?.inflight ?? false;
  }

  settled(path: string, topic: Topic | readonly Topic[] | null): number {
    return this.entry(path, topic).settled;
  }

  subscribeSettled(
    path: string,
    topic: Topic | readonly Topic[] | null,
    fn: () => void,
  ): () => void {
    const e = this.entry(path, topic);
    e.settledListeners.add(fn);
    return () => e.settledListeners.delete(fn);
  }

  private settle(e: Entry): void {
    e.settled++;
    for (const fn of [...e.settledListeners]) fn();
  }

  subscribe(path: string, topic: Topic | readonly Topic[] | null, fn: () => void): () => void {
    const e = this.entry(path, topic);
    e.listeners.add(fn);
    if (e.listeners.size === 1 && !e.inflight) {
      // A new visit reconciles the activity window before following deltas.
      void this.fetch(e, path === RESOURCES.activity.path);
    }
    return () => {
      e.listeners.delete(fn);
      if (e.listeners.size === 0) {
        clearTimeout(e.activityTimer);
        e.activityTimer = undefined;
      }
    };
  }

  /** One request per path at a time; a change during a fetch queues exactly one more. */
  private async fetch(e: Entry, full = false): Promise<void> {
    // Timers and stream events can still fire in a background tab. Keep their data cache quiet
    // until the tab is visible again, when startStream refreshes every mounted resource once.
    if (pageDocument()?.visibilityState === "hidden") return;
    if (e.inflight) {
      e.again = true;
      e.fullAgain ||= full;
      return;
    }
    const gen = this.generation;
    const seq = ++this.seq;
    e.inflight = true;
    // A refresh with usable data is not a loading transition. Besides avoiding a visual flash,
    // this lets identical responses retain their complete snapshot identity.
    if (e.snap.data === undefined && !e.snap.loading) this.set(e, { ...e.snap, loading: true });
    let next: Resource<unknown>;
    try {
      const activity = e.path === RESOURCES.activity.path;
      const startedAt = Date.now();
      const delta =
        activity &&
        !full &&
        e.snap.data !== undefined &&
        e.activityFullAt !== undefined &&
        startedAt - e.activityFullAt < ACTIVITY_FULL_LOAD_MS;
      const previous = delta ? (e.snap.data as ActivityRow[] | undefined) : undefined;
      if (activity && !delta) {
        clearTimeout(e.activityTimer);
        e.activityTimer = undefined;
      }
      // Re-read the newest millisecond as well: several rows can share a timestamp.
      const since = previous === undefined ? undefined : (previous[0]?.at ?? 1);
      const path = since === undefined ? e.path : `${e.path}?since=${Math.max(0, since - 1)}`;
      let data = await apiGet<unknown>(path);
      if (e.path === RESOURCES.flightLedger.path || e.path === RESOURCES.flightLedgerOpen.path) {
        const ledger = data as FlightLedgerView;
        let page = ledger;
        while (page.more && page.nextOffset !== null) {
          page = await apiGet<FlightLedgerView>(`${path}&offset=${page.nextOffset}`);
          if (page.session !== ledger.session)
            throw new Error("FLIGHT session changed while reading the ledger.");
          ledger.entries.push(...page.entries);
        }
        ledger.entries = [...new Map(ledger.entries.map((entry) => [entry.key, entry])).values()];
        ledger.more = false;
        ledger.nextOffset = null;
      }
      if (previous && since !== undefined) {
        const incoming = data as ActivityRow[];
        const counts = new Map<string, number>();
        for (const row of incoming) {
          const key = activityKey(row);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        data = [
          ...incoming,
          ...previous.filter((row) => {
            const key = activityKey(row);
            const count = counts.get(key) ?? 0;
            if (count === 0) return true;
            counts.set(key, count - 1);
            return false;
          }),
        ]
          .filter((r) => r.at >= Date.now() - ACTIVITY_WINDOW_MS)
          .sort(compareActivity)
          .slice(0, ACTIVITY_LIMIT);
      }
      if (activity) {
        data = reconcileActivity(
          data as ActivityRow[],
          (e.snap.data as ActivityRow[] | undefined) ?? [],
        );
      }
      if (gen !== this.generation) return;
      if (activity) {
        if (!delta) e.activityFullAt = startedAt;
        else if (e.listeners.size > 0 && e.activityTimer === undefined) {
          e.activityTimer = setTimeout(
            () => {
              e.activityTimer = undefined;
              if (e.listeners.size > 0) void this.fetch(e, true);
            },
            Math.max(0, (e.activityFullAt ?? startedAt) + ACTIVITY_FULL_LOAD_MS - Date.now()),
          );
        }
      }
      next =
        sameJson(data, e.snap.data) && e.snap.error === null
          ? e.snap
          : { data, error: null, loading: false };
    } catch (err) {
      // Keep the last good data on screen; show the error beside it.
      const error = err instanceof Error ? err : new Error(String(err));
      next = { ...e.snap, error, loading: false };
    }
    if (gen !== this.generation) return; // cleared meanwhile: this answer belongs to the old session
    // A read that started later may already have stored a newer answer: keep that one.
    if (seq < e.appliedSeq) next = e.snap;
    else e.appliedSeq = seq;
    e.inflight = false;
    this.set(e, next);
    this.settle(e);
    if (e.again) {
      e.again = false;
      const fullAgain = e.fullAgain;
      e.fullAgain = false;
      if (e.listeners.size > 0) void this.fetch(e, fullAgain);
    }
  }

  /**
   * A fresh read for a decision or a check that must not use a copy that may be stale: it asks the
   * server now, stores the answer in the cache so every other consumer of the resource shares it,
   * and returns it.
   */
  async read<T>(ref: ResourceRef): Promise<T> {
    const gen = this.generation;
    const seq = ++this.seq;
    const data = await apiGet<T>(ref.path);
    const e = this.entry(ref.path, ref.topic);
    if (gen === this.generation && seq > e.appliedSeq) {
      e.appliedSeq = seq;
      if (e.snap.error !== null || !sameJson(data, e.snap.data)) {
        this.set(e, { data, error: null, loading: false });
      }
    }
    return data;
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
      const activityChanged =
        e.path === RESOURCES.activity.path &&
        (topic === "guard" || topic === "health" || topic === "boards");
      const timelineChanged = e.path === RESOURCES.overviewTimeline.path && topic === "guard";
      const briefChanged =
        e.path === RESOURCES.flightBrief.path && (topic === "guard" || topic === "agents");
      const notificationSettingsChanged =
        topic === "settings" && e.path === RESOURCES.notificationEvents.path;
      const summaryChanged =
        e.path === RESOURCES.flightSummary.path &&
        (topic === "agents" ||
          topic === "boards" ||
          topic === "attention" ||
          topic === "guard" ||
          topic === "config");
      if (
        ((Array.isArray(e.topic) ? e.topic.includes(topic) : e.topic === topic) ||
          activityChanged ||
          timelineChanged ||
          briefChanged ||
          notificationSettingsChanged ||
          summaryChanged) &&
        e.listeners.size > 0
      ) {
        if (Array.isArray(e.topic) || (summaryChanged && topic === "agents")) {
          if (!e.queued) {
            e.queued = true;
            setTimeout(
              () => {
                e.queued = false;
                if (e.listeners.size) void this.fetch(e);
              },
              summaryChanged && topic === "agents" ? 100 : 0,
            );
          }
        } else void this.fetch(e);
      }
    }
  }

  refetchAll(): void {
    for (const e of this.entries.values()) if (e.listeners.size > 0) void this.fetch(e, true);
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
      e.fullAgain = false;
      e.activityFullAt = undefined;
      clearTimeout(e.activityTimer);
      e.activityTimer = undefined;
      this.set(e, IDLE);
    }
    this.refetchAll();
  }
}

/** API data is JSON. Equality is deliberately structural so a repeated decoded response keeps its cache identity. */
function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
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

/** A fetch-completion revision for the rare consumers that coordinate separate resource responses. */
export function useResourceSettled(ref: ResourceRef | null): number {
  const path = ref?.path ?? null;
  const topic = ref?.topic ?? null;
  const subscribe = useCallback(
    (fn: () => void) => (path ? hub.subscribeSettled(path, topic, fn) : () => {}),
    [path, topic],
  );
  const get = useCallback(() => (path ? hub.settled(path, topic) : 0), [path, topic]);
  return useSyncExternalStore(subscribe, get);
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

export const streamStatus = store<{
  connected: boolean;
  reconnecting: boolean;
  lastMessageAt: number | null;
}>({
  connected: false,
  reconnecting: false,
  lastMessageAt: null,
});

const RETRY_MS = 5000;
const STREAM_OPEN_TIMEOUT_MS = 10_000;

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

  streamStatus.set({ connected: false, reconnecting: false, lastMessageAt: null });
  const opening = setTimeout(() => {
    if (!connectedBefore) streamStatus.set({ ...streamStatus.get(), reconnecting: true });
  }, STREAM_OPEN_TIMEOUT_MS);
  const received = () => streamStatus.set({ ...streamStatus.get(), lastMessageAt: Date.now() });
  const doc = pageDocument();
  const onVisibility = () => {
    if (doc?.visibilityState === "visible") hub.refetchAll();
  };
  doc?.addEventListener("visibilitychange", onVisibility);

  const connect = () => {
    if (stopped) return;
    const source = new EventSource("/api/stream");
    es = source;
    source.addEventListener("open", () => {
      if (stopped || source !== es || source.readyState !== EventSource.OPEN) return;
      clearTimeout(opening);
      streamStatus.set({ ...streamStatus.get(), connected: true, reconnecting: false });
      if (connectedBefore) hub.refetchAll();
      connectedBefore = true;
    });
    source.addEventListener("message", received);
    source.addEventListener("changed", (ev) => {
      received();
      const topic = parseTopic((ev as MessageEvent).data);
      if (topic) hub.refetchTopic(topic);
    });
    source.addEventListener("error", () => {
      if (stopped || source !== es || source.readyState === EventSource.OPEN) return;
      streamStatus.set({
        ...streamStatus.get(),
        connected: false,
        reconnecting: connectedBefore || streamStatus.get().reconnecting,
      });
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
    streamStatus.set({ connected: false, reconnecting: false, lastMessageAt: null });
    clearTimeout(opening);
    clearTimeout(retry);
    es?.close();
    doc?.removeEventListener("visibilitychange", onVisibility);
  };
}
