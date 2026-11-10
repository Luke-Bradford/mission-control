/**
 * Every localStorage key the web app uses, and the only code that touches storage. Each access is
 * best effort: private mode or blocked site data throws, and the page carries on without it.
 */

/** public/theme-init.js hard-codes this value (a test keeps the two equal). */
export const THEME_KEY = "mc-theme";
/** FLIGHT's explicit shown/hidden choice on wide screens, for this browser session. */
export const DOCK_KEY = "mc-dock";
/** FLIGHT's explicit rail choice, kept only for this browser session. */
export const DOCK_COLLAPSED_KEY = "mc-dock-collapsed";
/** The Crew Activity Map's last manually picked repo. */
export const MAP_REPO_KEY = "mc-map-repo";

/** The Overview live log's filter. */
export const ACTIVITY_FILTER_KEY = "overview.live-log.filter";
/** The Board's selected lane. */
export const LANE_KEY = "mc-lane";
/** The Board's All-repos layout: `together` or `apart`. */
export const BOARD_LAYOUT_KEY = "mc-board-layout";
/** The Board view: a display filter (labels, priority, assignee, milestone), JSON, one per browser. */
export const BOARD_VIEW_KEY = "mc-board-view";
/** The away period whose digest this viewer acknowledged. */
export const AWAY_DIGEST_KEY = "mc-away-digest";
/** Unsent operator message in the Agent activity composer. It is deliberately not seat-scoped. */
export const AGENT_DRAFT_KEY = "mc-agent-draft";

/** The command palette's last picks, newest first (a JSON list of entry ids). */
export const PALETTE_RECENT_KEY = "mc-palette-recent";

/** The footer's build-status toggle. */
export const BUILD_STATUS_KEY = "mc-build-status";
/** PR heads the operator checked locally in this browser. */
export const QA_CHECKED_HEADS_KEY = "mc-qa-checked-heads";

/** The tab's Demo choice, in sessionStorage: per tab, kept over a reload, copied to a popout. */
export const DEMO_KEY = "mc-demo";

let keyScope = "";
/** In Demo every key but the theme moves under this prefix, so Demo cannot change Live's choices. */
export function setKeyScope(prefix: string): void {
  keyScope = prefix;
}
const scoped = (key: string): string => (key === THEME_KEY ? key : keyScope + key);

export function readKey(key: string): string | null {
  try {
    return localStorage.getItem(scoped(key));
  } catch {
    return null;
  }
}

/** Like `writeKey`, but says whether storage took the value (false when it threw). */
export function tryWriteKey(key: string, value: string): boolean {
  try {
    localStorage.setItem(scoped(key), value);
    return true;
  } catch {
    return false;
  }
}

export function writeKey(key: string, value: string): void {
  // blocked storage: the value still applies for this page
  tryWriteKey(key, value);
}

/** A stored `true`/`false`; `fallback` when absent, unreadable or anything else. */
export function readBool(key: string, fallback: boolean): boolean {
  const v = readKey(key);
  return v === "true" ? true : v === "false" ? false : fallback;
}

export const writeBool = (key: string, value: boolean): void => writeKey(key, String(value));

/** Null means no explicit session choice; blocked storage keeps the in-memory choice usable. */
export function readSessionBool(key: string): boolean | null {
  try {
    const value = sessionStorage.getItem(key);
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
}

export function writeSessionBool(key: string, value: boolean): void {
  try {
    sessionStorage.setItem(key, String(value));
  } catch {
    // The session still has an in-memory choice when storage is unavailable.
  }
}
