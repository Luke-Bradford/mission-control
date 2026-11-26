/**
 * A cmux session's repo checks: run by the hub when an operator session finishes a piece of work
 * in a repo he turned on, or when he asks from the Sessions page. No agent runs them.
 */

export type SessionCheckState =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "timed-out"
  | "stopped";

/** A workspace's latest check. `at`: when it reached `state` (ms). */
export interface SessionCheck {
  state: SessionCheckState;
  at: number;
  /** The command running, or the last one run (the one that failed or timed out); null while queued. */
  command: string | null;
  why: "idle" | "operator";
}

/** A workspace's last finished check (passed, failed or timed out), for cmux's sidebar. */
export interface SessionCheckResult {
  ok: boolean;
  command: string | null;
  at: number;
}

/** One repo the Sessions page shows, keyed by its main checkout's path. */
export interface SessionRepoChecks {
  /** The main checkout's path. */
  repo: string;
  /** Its folder name. */
  name: string;
  /** Whether a session finishing a piece of work here runs its checks. */
  on: boolean;
  /** Where `commands` came from; null: none named anywhere. */
  source: "repo" | "config" | "page" | null;
  commands: string[];
  /** The list the operator set on the page (used only when the repo and config name none). */
  pageCommands: string[];
}

/** A check is stopped after this long. */
export const SESSION_CHECK_TIMEOUT_MS = 15 * 60_000;
/** The lines of a failing check's output a session is sent. */
export const SESSION_CHECK_TAIL_LINES = 40;
/** The hub setting holding each repo's switch and page commands. */
export const SESSION_CHECKS_SETTING = "sessions.checks";
/** Commands the page may set for one repo, and the longest one. */
export const SESSION_CHECK_COMMANDS_MAX = 10;
export const SESSION_CHECK_COMMAND_MAX = 200;

export const SESSION_CHECK_STATE_LABEL: Record<SessionCheckState, string> = {
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  "timed-out": "Timed out",
  stopped: "Stopped",
};

export const SESSION_CHECK_SOURCE_LABEL: Record<
  NonNullable<SessionRepoChecks["source"]> | "none",
  string
> = {
  repo: "From the repo's Mission Control block",
  config: "From the hub's config",
  page: "Set here",
  none: "No checks named",
};

export const SESSION_NO_CHECKS_TEXT = "This repo names no checks. Add them under Repo checks.";
export const SESSION_CREW_CHECKS_TEXT = "A crew seat runs its checks before each push.";
export const SESSION_UNKNOWN_REPO_TEXT = "No open session is in that repo.";
