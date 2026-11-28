/**
 * The Sessions page: every cmux workspace on this Mac, the operator's own and the crew's, read from
 * cmux with no agent. The hub lists, reads, focuses and writes to them; it never closes one.
 */
import type { SessionCheck, SessionRepoChecks } from "./session-checks.ts";
import type { SessionSpendCell } from "./session-spend.ts";

/** What a workspace's agent is doing; `no-agent` is a plain shell (or an agent cmux does not know). */
export const CMUX_SESSION_STATES = ["working", "idle", "waiting", "no-agent"] as const;
export type CmuxSessionState = (typeof CMUX_SESSION_STATES)[number];

export const CMUX_SESSION_STATE_LABEL: Record<CmuxSessionState, string> = {
  working: "Working",
  idle: "Idle",
  waiting: "Waiting on you",
  "no-agent": "No agent",
};

/** `crew`: a workspace the hub started for a seat (`<seat> · <ticket>`); `operator`: any other. */
export type CmuxSessionOwner = "operator" | "crew";

export interface SessionPr {
  number: number;
  url: string;
  isDraft: boolean;
  ci: "passing" | "failing" | "pending" | null;
  review: "approved" | "changes" | "requested" | null;
}

export interface CmuxSessionRow {
  /** The workspace's cmux UUID. */
  id: string;
  name: string;
  owner: CmuxSessionOwner;
  folder: string | null;
  /** The main checkout's folder name of the nearest git repo above `folder`. */
  repo: string | null;
  /** That repo's main checkout path: the key of its Repo checks line; null outside a repo. */
  repoKey: string | null;
  state: CmuxSessionState;
  /** When this hub first saw the workspace in `state` (ms). */
  since: number;
  /** The agent's last words, else the screen's last line; at most SESSION_LINE_MAX characters. */
  lastLine: string | null;
  /** The session's own one-line status (`cmux set-status <key> <text>`), any key but `app`. */
  status: string | null;
  /** `cmux set-status app <url>`: the app the session looks after. `answers` null: not checked. */
  app: { url: string; answers: boolean | null } | null;
  /** The session's `cmux agent inbox`: messages not yet read, and the newest one's text. */
  inbox: { unread: number; newest: string | null };
  branch?: string | null;
  ticket?: { number: number; repoId: string | null } | null;
  pr?: SessionPr | null;
  /** The workspace's latest repo check (queued, running or how it ended); null: none this hub run. */
  check: SessionCheck | null;
  /**
   * The Claude session's tokens and ~cost today and over the last 7 local days, read from its
   * transcript by the hub; null with no agent or no usage yet (shown as —).
   */
  spend?: SessionSpendCell | null;
}

export type CmuxSessionsView =
  | { ok: true; at: number; sessions: CmuxSessionRow[]; repos: SessionRepoChecks[] }
  | { ok: false; at: number; error: string };

/** The status key a session sets to name the app it looks after. */
export const SESSION_APP_STATUS_KEY = "app";
/**
 * The status key the hub sets on a seat's workspace with each crew app endpoint's health, for
 * cmux's sidebar; never shown as the session's own status.
 */
export const SESSION_APP_HEALTH_STATUS_KEY = "app-health";
/** The longest text one write may carry. */
export const SESSION_TEXT_MAX = 4000;
/** The longest last line, status and inbox text a row carries. */
export const SESSION_LINE_MAX = 300;
/** How often the page reads again while it is visible. */
export const SESSIONS_REFRESH_MS = 3000;
export const SESSION_BUSY_TEXT = "The session has a question open. Answer it in cmux first.";
export const SESSION_NOT_ASKED_TEXT =
  "asked_by must be a Comms message the operator sent FLIGHT in the last 24 hours.";
export const SESSION_UNKNOWN_TEXT = "No cmux workspace has that id.";
export const SESSION_NO_APP_TEXT = "That session names no app (cmux set-status app <url>).";
export const SESSIONS_OFF_TEXT = "This hub does not read cmux sessions.";
/** A cmux workspace UUID: checked before any cmux call. */
export const CMUX_WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SIDEBAR_KEY_PREFIX = "mc-";
export const SIDEBAR_KEYS = {
  ci: "mc-ci",
  review: "mc-review",
  cost: "mc-cost",
  check: "mc-check",
} as const;
export const SESSIONS_CMUX_WRITES_SETTING = "sessions.cmux_writes";
export const SIDEBAR_CI_TEXT = {
  passing: "CI passing",
  failing: "CI failing",
  pending: "CI running",
} as const;
export const SIDEBAR_REVIEW_TEXT = {
  approved: "Approved",
  changes: "Changes asked",
  requested: "Review asked",
} as const;
export const SESSION_NOTICE_TITLE = {
  waiting: "Waiting on you",
  finished: "Finished",
  appStopped: "App stopped",
  checkFailed: "Check failed",
} as const;
export type SessionNoticeKind = keyof typeof SESSION_NOTICE_TITLE;
/** The page's order: waiting, working, idle, no agent; the longest in its state first. */
const SESSION_ORDER: readonly CmuxSessionState[] = ["waiting", "working", "idle", "no-agent"];
export function sortSessions(rows: readonly CmuxSessionRow[]): CmuxSessionRow[] {
  const rank = (s: CmuxSessionState) => SESSION_ORDER.indexOf(s);
  return [...rows].sort((a, b) => rank(a.state) - rank(b.state) || a.since - b.since);
}
