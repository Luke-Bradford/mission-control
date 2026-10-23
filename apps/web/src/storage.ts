/**
 * Every localStorage key the web app uses, and the only code that touches storage. Each access is
 * best effort: private mode or blocked site data throws, and the page carries on without it.
 */

/** public/theme-init.js hard-codes this value (a test keeps the two equal). */
export const THEME_KEY = "mc-theme";
/** FLIGHT's dock shown or hidden on wide screens. */
export const DOCK_KEY = "mc-dock";
/** The Board's selected lane. */
export const LANE_KEY = "mc-lane";
/** The Board's All-repos layout: `together` or `apart`. */
export const BOARD_LAYOUT_KEY = "mc-board-layout";
/** The footer's build-status toggle. */
export const BUILD_STATUS_KEY = "mc-build-status";

export function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // blocked storage: the value still applies for this page
  }
}

/** A stored `true`/`false`; `fallback` when absent, unreadable or anything else. */
export function readBool(key: string, fallback: boolean): boolean {
  const v = readKey(key);
  return v === "true" ? true : v === "false" ? false : fallback;
}

export const writeBool = (key: string, value: boolean): void => writeKey(key, String(value));
