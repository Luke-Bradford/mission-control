/**
 * Every cmux workspace on this Mac, the operator's own and the crew's, read from cmux with no agent:
 * what each is doing, for how long, its last line, its status and its app. It writes to a workspace
 * only when the operator asks (the page, or FLIGHT citing his message), and logs each write with who
 * asked. There is deliberately no close: a session the operator started is his.
 */
import { lstat, open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  branchIssue,
  CMUX_WORKSPACE_ID,
  type CmuxSessionRow,
  type CmuxSessionState,
  type CmuxSessionsView,
  COMMS_CAPCOM,
  type OpenSessionInput,
  SESSION_APP_STATUS_KEY,
  SESSION_LINE_MAX,
  SESSION_NO_APP_TEXT,
  SESSION_TEXT_MAX,
  SESSION_UNKNOWN_TEXT,
  SIDEBAR_KEY_PREFIX,
  sortSessions,
} from "@mc/core";
import { cleanText } from "../repo/clean.ts";
import {
  CMUX_REFUSED_TEXT,
  type Cmux,
  type CmuxAgent,
  type CmuxInboxMessage,
  type CmuxWorkspace,
} from "../runtime/cmux.ts";
import { sessionSpendFor } from "../spend/sessions.ts";
import type { Store } from "../store.ts";
import { gitPlace } from "./branch.ts";
import type { SessionChecks } from "./checks.ts";
import { openSession, sessionRoles } from "./open.ts";
import type { createBranchPrs } from "./pr.ts";

/** cmux is not running; the hub never starts it for a read. */
export const CMUX_NOT_RUNNING_TEXT = "cmux is not running.";
/** One read is shared by every reader for this long. */
const VIEW_CACHE_MS = 2000;
/** Workspaces read at once (status, screen, transcript). */
const READS_AT_ONCE = 4;
/** An app's answer is kept this long. */
const PROBE_CACHE_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;
/** A workspace's status or screen read still out this long after a view starts is dropped, so one stalled cmux call never holds the list past the 5 s first view. */
const FIELD_DEADLINE_MS = 3000;
/** App probes still out this long after a view starts read as not checked, inside the view deadline. */
const PROBE_DEADLINE_MS = 4000;
/** The whole view settles within this, so the first view holds the ticket's 5 s even when cmux stalls. */
const VIEW_DEADLINE_MS = 4500;
export const CMUX_SLOW_TEXT = "cmux did not answer in time. Mission Control tries again shortly.";
/** The tail of a transcript searched for the agent's last words. */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
/** The screen lines a shell's last line is looked for in. */
const SCREEN_TAIL_LINES = 30;
/** How old the operator's asking message may be for FLIGHT to write for him. */
export const SESSION_ASK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How often the hub reads the sessions by itself, to tell a session when its app stops. */
export const SESSIONS_APP_WATCH_MS = 30_000;
/** Who the hub's own messages to a session are from. */
export const SESSION_NOTICE_FROM = "Mission Control";
/** The hosts an app's address is checked on: this Mac only. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BOX_DRAWING = /[─-╿]/g;

/** A refusal with the HTTP status the API gives it. */
export class SessionError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) {
    super(message);
    this.name = "SessionError";
    this.status = status;
  }
}

export interface SessionsService {
  view(): Promise<CmuxSessionsView>;
  /** Drops the short-lived cmux read cache after a workspace lifecycle event. */
  invalidate(): void;
  /** Refreshes workspace membership without waiting for each workspace's status or screen. */
  refreshMembership(): Promise<void>;
  /** The workspace's screen, at most `lines` of its last lines. */
  read(id: string, lines: number): Promise<string>;
  focus(id: string): Promise<void>;
  /** Pastes `text` then Enter; "busy" when the session has a question open. `askedBy` is logged. */
  send(id: string, text: string, askedBy: string): Promise<"sent" | "busy">;
  /** Opens the session's app in a browser pane of its own workspace. */
  openApp(id: string, askedBy: string): Promise<void>;
  /** The roles a new session may take, and the folders the open sessions are in. */
  roles(): Promise<{ roles: string[]; folders: string[] }>;
  /** Opens a new session for the operator (see open.ts); throws a SessionOpenError. */
  open(input: OpenSessionInput, askedBy: string): Promise<{ id: string; name: string }>;
}

export interface SessionsDeps {
  cmux: Cmux;
  store: Store;
  /** The configured seat ids: a workspace named `<seat> · …` is the crew's. */
  seatIds: () => string[];
  /** Each session's repo checks and each repo's switch; absent: rows carry no check, no repos. */
  checks?: SessionChecks;
  /** Whether a local address answers; default an HTTP GET. */
  probe?: (url: string) => Promise<boolean>;
  /** Where Claude keeps transcripts; only `.jsonl` files under it are read. */
  projectsDir?: string;
  /** Whether a process is alive; default `kill(pid, 0)`. */
  alive?: (pid: number) => boolean;
  /** The `roles/` folder a new session's role prompt comes from; absent: no role is offered. */
  rolesDir?: string;
  /** Whether a session is told when its app stops answering (default true; off in a preview hub). */
  tellApps?: boolean;
  /** How long a view waits for each workspace's status and screen reads; default 3 s. */
  fieldDeadlineMs?: number;
  /** How long after a view starts its app probes may run; default 4 s. */
  probeDeadlineMs?: number;
  /** How long a whole view waits, cmux's ping and lists included; default 4.5 s. */
  viewDeadlineMs?: number;
  /** The operator's time zone, for each session's spend today; default the hub's own. */
  timeZone?: () => string;
  now?: () => number;
  log?: (m: string) => void;
  repos?: () => { id: string; github: string }[];
  prs?: Pick<ReturnType<typeof createBranchPrs>, "prOf">;
}

/** Any HTTP answer is an answer; refused or timed out is not. Redirects are not followed. */
export async function probeLocal(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await r.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** The address when it is an http(s) URL on this Mac; null for any other. */
export function localAddress(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return LOCAL_HOSTS.has(u.hostname) ? u : null;
}

const isHttp = (url: string): boolean => {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const STATE_OF: Record<CmuxAgent["lifecycle"], CmuxSessionState> = {
  running: "working",
  idle: "idle",
  needsInput: "waiting",
};
const LIFECYCLE_RANK: CmuxAgent["lifecycle"][] = ["needsInput", "running", "idle"];

/** The line as inert text on one line, at most SESSION_LINE_MAX characters. */
const oneLine = (s: string): string => cleanText(s.replace(/\s+/g, " ").trim(), SESSION_LINE_MAX);

/** The last non-blank line of a screen, box-drawing removed. */
export function lastScreenLine(screen: string): string | null {
  const lines = screen
    .split("\n")
    .map((l) => l.replace(BOX_DRAWING, "").trim())
    .filter((l) => l !== "");
  const last = lines.at(-1);
  return last === undefined ? null : oneLine(last);
}

/** The last assistant text in a Claude transcript's tail; null when it has none. */
export function lastAssistantText(tail: string, partialFirst: boolean): string | null {
  const lines = tail.split("\n");
  if (partialFirst) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o !== "object" || o === null || (o as { type?: unknown }).type !== "assistant")
      continue;
    const content = (o as { message?: { content?: unknown } }).message?.content;
    const texts =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.flatMap((c) =>
              typeof c === "object" &&
              c !== null &&
              (c as { type?: unknown }).type === "text" &&
              typeof (c as { text?: unknown }).text === "string"
                ? [(c as { text: string }).text]
                : [],
            )
          : [];
    const text = texts.filter((t) => t.trim() !== "").at(-1);
    if (text !== undefined) return oneLine(text);
  }
  return null;
}

/**
 * The checkout a folder is in (`top`) and its main checkout (`main`), by the nearest `.git` above
 * it, with no git run: a `.git` file of a worktree names the main checkout in its `gitdir:` line.
 */
export async function checkoutOf(folder: string): Promise<{ top: string; main: string } | null> {
  let dir = resolve(folder);
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = join(dir, ".git");
    const s = await lstat(dotGit).catch(() => null);
    if (s?.isDirectory()) return { top: dir, main: dir };
    if (s?.isFile()) {
      const text = await readFile(dotGit, "utf8").catch(() => "");
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
      if (gitdir !== undefined) {
        const abs = isAbsolute(gitdir) ? gitdir : resolve(dir, gitdir);
        if (/[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(abs))
          return { top: dir, main: resolve(abs, "../../..") };
      }
      return { top: dir, main: dir };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** The repo a folder is in: its main checkout's folder name. */
export async function repoOf(folder: string): Promise<string | null> {
  const co = await checkoutOf(folder);
  return co === null ? null : basename(co.main) || null;
}

/** The workspace's live agent: the most pressing record whose process is not known dead. */
export function liveAgentOf<A extends CmuxAgent>(
  agents: readonly A[],
  ws: string,
  alive: (pid: number) => boolean = pidAlive,
): A | null {
  return (
    agents
      .filter((a) => a.workspaceId === ws && (a.pid === null || alive(a.pid)))
      .sort(
        (a, b) => LIFECYCLE_RANK.indexOf(a.lifecycle) - LIFECYCLE_RANK.indexOf(b.lifecycle),
      )[0] ?? null
  );
}

/** At most `n` of `fn` at once, in order. */
async function inTurns<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Whether `ref` is a Comms message the operator sent FLIGHT (`flightId`) in the last 24 hours. */
export function operatorAsked(store: Store, flightId: string, ref: string, now: number): boolean {
  const m = store.commsMessage(ref);
  return (
    m !== null &&
    m.from === COMMS_CAPCOM &&
    m.senderKind === "operator" &&
    m.to === flightId &&
    m.at <= now &&
    now - m.at <= SESSION_ASK_MAX_AGE_MS
  );
}

export function createSessions(deps: SessionsDeps): SessionsService {
  const { cmux, store } = deps;
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? probeLocal;
  const alive = deps.alive ?? pidAlive;
  const log = deps.log ?? (() => {});
  const projects = resolve(deps.projectsDir ?? join(homedir(), ".claude", "projects"));
  /** Each workspace's state and when this hub first saw it in that state. */
  const seen = new Map<string, { state: CmuxSessionState; since: number }>();
  /**
   * Each workspace's app as last read, whether the session was told it stopped, and whether a stop
   * seen is still owed a notice (the message failed): it is tried again on each read until it goes.
   */
  const apps = new Map<
    string,
    { url: string; answers: boolean | null; told: boolean; owed: boolean }
  >();
  /** Reads take turns at telling apps, and a read older than one already handled is skipped. */
  let appsTurn: Promise<void> = Promise.resolve();
  let appsAt = Number.NEGATIVE_INFINITY;
  const probes = new Map<string, { at: number; answers: Promise<boolean> }>();
  let cached: { at: number; view: Promise<CmuxSessionsView> } | null = null;
  let lastRows = new Map<string, CmuxSessionRow>();
  let lastRepos: Extract<CmuxSessionsView, { ok: true }>["repos"] = [];

  const agentOf = (agents: readonly CmuxAgent[], ws: string): CmuxAgent | null =>
    liveAgentOf(agents, ws, alive);

  const transcriptOk = (path: string | null): path is string =>
    typeof path === "string" && path.endsWith(".jsonl") && resolve(path).startsWith(projects + sep);

  async function transcriptLine(path: string): Promise<string | null> {
    const file = await open(path, "r").catch(() => null);
    if (file === null) return null;
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await file.read(buf, 0, buf.length, start);
      return lastAssistantText(buf.toString("utf8"), start > 0);
    } catch {
      return null;
    } finally {
      await file.close();
    }
  }

  function answers(url: string): Promise<boolean> {
    const hit = probes.get(url);
    if (hit !== undefined && now() - hit.at < PROBE_CACHE_MS) return hit.answers;
    const call = probe(url).catch(() => false);
    probes.set(url, { at: now(), answers: call });
    return call;
  }

  async function sinceOf(id: string, state: CmuxSessionState, agent: CmuxAgent | null) {
    const prev = seen.get(id);
    if (prev?.state === state) return prev.since;
    let since = now();
    if (prev === undefined && transcriptOk(agent?.transcriptPath ?? null)) {
      const s = await stat(agent?.transcriptPath as string).catch(() => null);
      if (s !== null) since = Math.min(since, s.mtimeMs);
    }
    seen.set(id, { state, since });
    return since;
  }

  /** A row for a lifecycle refresh: existing details win while the full read enriches it later. */
  function membershipRow(ws: CmuxWorkspace, agent: CmuxAgent | null | undefined): CmuxSessionRow {
    const previous = lastRows.get(ws.id);
    const state: CmuxSessionState =
      agent === undefined
        ? (previous?.state ?? "no-agent")
        : agent === null
          ? "no-agent"
          : STATE_OF[agent.lifecycle];
    const since = previous?.state === state ? previous.since : now();
    seen.set(ws.id, { state, since });
    const folder = agent === undefined ? (previous?.folder ?? ws.cwd) : (agent?.cwd ?? ws.cwd);
    if (previous !== undefined)
      return {
        ...previous,
        id: ws.id,
        name: ws.name,
        owner: deps.seatIds().some((seat) => ws.name.startsWith(`${seat} · `))
          ? "crew"
          : "operator",
        folder,
        state,
        since,
      };
    return {
      id: ws.id,
      name: ws.name,
      owner: deps.seatIds().some((seat) => ws.name.startsWith(`${seat} · `)) ? "crew" : "operator",
      folder,
      repo: null,
      repoKey: null,
      state,
      since,
      lastLine: null,
      status: null,
      app: null,
      inbox: { unread: 0, newest: null },
      check: deps.checks?.checkOf(ws.id) ?? null,
    };
  }

  async function rowOf(
    ws: CmuxWorkspace,
    agent: CmuxAgent | null,
    inbox: readonly CmuxInboxMessage[],
    seats: readonly string[],
    late: Promise<void>,
  ): Promise<CmuxSessionRow> {
    const state: CmuxSessionState = agent === null ? "no-agent" : STATE_OF[agent.lifecycle];
    const folder = agent?.cwd ?? ws.cwd;
    const byDeadline = <T>(read: Promise<T>, fallback: T) =>
      Promise.race([read.catch(() => fallback), late.then(() => fallback)]);
    const [since, checkout, statuses] = await Promise.all([
      sinceOf(ws.id, state, agent),
      folder === null ? null : checkoutOf(folder),
      byDeadline(cmux.statuses(ws.id), {} as Record<string, string>),
    ]);
    let lastLine: string | null = null;
    if (agent !== null && transcriptOk(agent.transcriptPath))
      lastLine = await transcriptLine(agent.transcriptPath);
    if (lastLine === null)
      lastLine = lastScreenLine(await byDeadline(cmux.readScreen(ws.id, SCREEN_TAIL_LINES), ""));
    const statusKey = Object.keys(statuses).find(
      (k) => k !== SESSION_APP_STATUS_KEY && !k.startsWith(SIDEBAR_KEY_PREFIX),
    );
    const url = statuses[SESSION_APP_STATUS_KEY]?.trim();
    // a local app's probe starts here but is waited for in `withAnswers`, never inside a row's turn
    const app = url === undefined || url === "" || !isHttp(url) ? null : { url, answers: null };
    if (app !== null && localAddress(app.url) !== null) void answers(app.url);
    const mine = inbox.filter((m) => m.workspaceId === ws.id);
    const newest = mine[0];
    return {
      id: ws.id,
      name: ws.name,
      owner: seats.some((s) => ws.name.startsWith(`${s} · `)) ? "crew" : "operator",
      folder,
      repo: checkout === null ? null : basename(checkout.main) || null,
      repoKey: checkout?.main ?? null,
      state,
      since,
      lastLine,
      status: statusKey === undefined ? null : oneLine(statuses[statusKey] as string),
      app,
      inbox: {
        unread: mine.filter((m) => !m.read).length,
        newest: newest === undefined ? null : oneLine(newest.text),
      },
      check: deps.checks?.checkOf(ws.id) ?? null,
    };
  }

  /** Tells a session that asked (by naming an app) when its app stops answering, and when it is back. */
  async function tellApps(rows: readonly CmuxSessionRow[]) {
    for (const row of rows) {
      const prev = apps.get(row.id);
      const answers = row.app?.answers ?? null;
      const url = row.app?.url ?? null;
      if (url === null) {
        apps.delete(row.id);
        continue;
      }
      // a probe cut off by the deadline tells nothing: what was known stays
      if (answers === null && prev?.url === url) continue;
      const same = prev?.url === url;
      let told = same ? prev.told : false;
      let owed = same ? prev.owed : false;
      const say = async (text: string, event: string) => {
        // a plain shell has no agent to read it: nothing is ever written there
        if (row.state === "no-agent") return false;
        try {
          await cmux.agentMessage(row.id, text, SESSION_NOTICE_FROM);
          store.addHubEvent(`Told cmux session "${row.name}" ${event}`, now());
          return true;
        } catch (e) {
          log(`sessions: could not tell "${row.name}" about its app: ${String(e)}`);
          return false;
        }
      };
      if (same && answers === false && !told && (prev.answers === true || owed)) {
        told = await say(
          `Your app at ${url} has stopped answering.`,
          `its app at ${url} stopped answering`,
        );
        owed = !told;
      } else if (answers === true) {
        owed = false;
        if (told)
          told = !(await say(
            `Your app at ${url} answers again.`,
            `its app at ${url} answers again`,
          ));
      }
      apps.set(row.id, { url, answers, told, owed });
    }
    for (const id of apps.keys()) if (!rows.some((r) => r.id === id)) apps.delete(id);
  }

  /** `tellApps` one read at a time, so overlapping reads never send the same notice twice. */
  function tellAppsInTurn(rows: readonly CmuxSessionRow[], at: number): Promise<void> {
    const turn = appsTurn.then(async () => {
      if (at < appsAt) return;
      appsAt = at;
      await tellApps(rows);
    });
    appsTurn = turn.catch(() => {});
    return turn;
  }

  /**
   * Each row with whether its local app answers, all probes at once; a probe still out by `late`
   * leaves the app's address with `answers: null` (not checked).
   */
  async function withAnswers(
    rows: readonly CmuxSessionRow[],
    late: Promise<void>,
  ): Promise<CmuxSessionRow[]> {
    return Promise.all(
      rows.map(async (row) => {
        if (row.app === null || localAddress(row.app.url) === null) return row;
        const answered = await Promise.race([answers(row.app.url), late.then(() => null)]);
        return { ...row, app: { url: row.app.url, answers: answered } };
      }),
    );
  }

  /** The view, or a cmux-is-slow error once the view deadline passes; a late answer is dropped. */
  async function read(): Promise<CmuxSessionsView> {
    const at = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<CmuxSessionsView>((done) => {
      timer = setTimeout(
        () => done({ ok: false, at, error: CMUX_SLOW_TEXT }),
        deps.viewDeadlineMs ?? VIEW_DEADLINE_MS,
      );
    });
    const view = readAll(at);
    view.catch(() => {});
    try {
      return await Promise.race([view, slow]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readAll(at: number): Promise<CmuxSessionsView> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((done) => {
      timer = setTimeout(done, deps.fieldDeadlineMs ?? FIELD_DEADLINE_MS);
    });
    const probesLate = new Promise<void>((done) => {
      probeTimer = setTimeout(done, deps.probeDeadlineMs ?? PROBE_DEADLINE_MS);
    });
    try {
      const up = await cmux.ping();
      if (up === "denied") return { ok: false, at, error: CMUX_REFUSED_TEXT };
      if (up === "down") return { ok: false, at, error: CMUX_NOT_RUNNING_TEXT };
      const [workspaces, agents, inbox] = await Promise.all([
        cmux.workspaces(),
        cmux.agents(),
        Promise.race([
          cmux.inbox().catch(() => [] as CmuxInboxMessage[]),
          late.then(() => [] as CmuxInboxMessage[]),
        ]),
      ]);
      const seats = deps.seatIds();
      const rows = await withAnswers(
        await inTurns(workspaces, READS_AT_ONCE, (ws) =>
          rowOf(ws, agentOf(agents, ws.id), inbox, seats, late),
        ),
        probesLate,
      );
      for (const id of seen.keys()) if (!rows.some((r) => r.id === id)) seen.delete(id);
      withSpend(rows, agents, at);
      if (deps.tellApps !== false) await tellAppsInTurn(rows, at);
      const enriched = await Promise.all(
        rows.map(async (row) => {
          if (row.folder === null) return row;
          const place = await gitPlace(row.folder);
          const branch = place?.branch ?? null;
          const found =
            branch === null || place?.github === null || place?.github === undefined || !deps.prs
              ? null
              : await deps.prs.prOf(place.github, branch);
          const issue = branch === null ? null : branchIssue(branch);
          return {
            ...row,
            branch,
            ticket: issue === null ? null : { number: issue, repoId: found?.repoId ?? null },
            pr: found?.pr ?? null,
            check: deps.checks?.checkOf(row.id) ?? null,
          };
        }),
      );
      // the crew's checkouts have no Repo checks line: their push gate runs checks
      const repos =
        deps.checks === undefined
          ? []
          : await deps.checks.repos(enriched.filter((r) => r.owner === "operator"));
      const result = { ok: true as const, at, sessions: sortSessions(enriched), repos };
      lastRows = new Map(result.sessions.map((row) => [row.id, row]));
      lastRepos = repos;
      return result;
    } catch (e) {
      return { ok: false, at, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
      clearTimeout(probeTimer);
    }
  }

  /**
   * Each row's Claude session spend, from the numbers the sessionSpend job stored. The join key is
   * the transcript's file name (the session id), else the session id cmux reports.
   */
  function withSpend(rows: CmuxSessionRow[], agents: readonly CmuxAgent[], at: number): void {
    const keyOf = new Map<string, string>();
    for (const r of rows) {
      const agent = agentOf(agents, r.id);
      if (agent === null) continue;
      keyOf.set(
        r.id,
        agent.transcriptPath ? basename(agent.transcriptPath, ".jsonl") : agent.sessionId,
      );
    }
    const tz = deps.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const spend = sessionSpendFor(store, [...new Set(keyOf.values())], at, tz);
    for (const r of rows) {
      const key = keyOf.get(r.id);
      r.spend = key === undefined ? null : (spend.get(key) ?? null);
    }
  }

  /** Refreshes the membership cache from cmux without waiting for slow per-workspace enrichment. */
  async function refreshMembership(): Promise<void> {
    cached = null;
    try {
      const at = now();
      const workspaces = await cmux.workspaces();
      const rows = workspaces.map((ws) => membershipRow(ws, undefined));
      const ids = new Set(rows.map((row) => row.id));
      for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
      for (const id of lastRows.keys()) if (!ids.has(id)) lastRows.delete(id);
      const view = { ok: true as const, at, sessions: sortSessions(rows), repos: lastRepos };
      cached = { at, view: Promise.resolve(view) };
    } catch {
      // The regular poll remains the backstop when cmux cannot list workspaces here.
    }
  }

  /** The open workspace with this id; a malformed or unknown id is refused before it reaches cmux. */
  async function workspace(id: string): Promise<CmuxWorkspace> {
    if (!CMUX_WORKSPACE_ID.test(id)) throw new SessionError(404, SESSION_UNKNOWN_TEXT);
    const ws = (await cmux.workspaces()).find((w) => w.id.toLowerCase() === id.toLowerCase());
    if (ws === undefined) throw new SessionError(404, SESSION_UNKNOWN_TEXT);
    return ws;
  }

  return {
    invalidate() {
      cached = null;
    },
    refreshMembership,
    view() {
      if (cached !== null && now() - cached.at < VIEW_CACHE_MS) return cached.view;
      const view = read();
      cached = { at: now(), view };
      return view;
    },
    async read(id, lines) {
      const ws = await workspace(id);
      return cleanText(await cmux.readScreen(ws.id, lines), 64 * 1024);
    },
    async focus(id) {
      const ws = await workspace(id);
      await cmux.focus(ws.id);
    },
    async send(id, text, askedBy) {
      if (text.trim() === "" || text.length > SESSION_TEXT_MAX)
        throw new SessionError(400, `Write 1 to ${SESSION_TEXT_MAX} characters.`);
      const ws = await workspace(id);
      if (agentOf(await cmux.agents(), ws.id)?.lifecycle === "needsInput") return "busy";
      if ((await cmux.send(ws.id, text)) === "busy") return "busy";
      // the text itself is never logged
      store.addHubEvent(
        `Wrote to cmux session "${ws.name}" (${text.length} characters), asked by ${askedBy}`,
        now(),
      );
      cached = null;
      return "sent";
    },
    async openApp(id, askedBy) {
      const ws = await workspace(id);
      const url = (await cmux.statuses(ws.id))[SESSION_APP_STATUS_KEY]?.trim();
      if (url === undefined || !isHttp(url)) throw new SessionError(400, SESSION_NO_APP_TEXT);
      await cmux.openBrowser(ws.id, url);
      store.addHubEvent(
        `Opened the app of cmux session "${ws.name}" in its browser, asked by ${askedBy}`,
        now(),
      );
    },
    async roles() {
      const view = await this.view();
      const folders = view.ok ? view.sessions.flatMap((r) => (r.folder ? [r.folder] : [])) : [];
      return {
        roles: deps.rolesDir === undefined ? [] : sessionRoles(deps.rolesDir),
        folders: [...new Set(folders)].sort(),
      };
    },
    async open(input, askedBy) {
      const opened = await openSession(
        { cmux, store, rolesDir: deps.rolesDir ?? "", now },
        input,
        askedBy,
      );
      cached = null;
      return { id: opened.id, name: opened.name };
    },
  };
}
