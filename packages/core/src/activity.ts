/** `/api/activity` covers this window, newest first, and returns at most ACTIVITY_LIMIT events. */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_LIMIT = 1000;

/** Loop events that report a PR head's CI: Activity shows them as checks. */
// Kept literal: importing loop.ts here would load it into every @mc/core consumer, the guard hook too.
// It matches loop.ts's CI_PASSED/CI_FAILED/CI_RERUN_FAILED prefixes; activity.test.ts pins each.
export const CHECK_EVENT =
  /^CI (?:passed on |failed on |failed again on the re-run of |flaked on )/;

/** `who` or `to` of a comms row: the operator. Upper case, so never a seat id. */
export const COMMS_CAPCOM = "CAPCOM";
/** `who` of a comms row Mission Control's engine sent. */
export const COMMS_MC = "MC";
/** Stored Comms content in code points; longer copies append a cut marker. Delivery stays whole. */
export const COMMS_TEXT_MAX = 32_000;
/** Maximum stored Teams message text. */
export const TEAMS_TEXT_MAX = 12_000;
/** A Comms preview in Activity, including the ellipsis when cut. */
export const COMMS_PREVIEW_MAX = 500;

/** Maximum operator message length accepted at the API boundary. */
export const COMMS_MESSAGE_MAX = COMMS_TEXT_MAX;
/** Allow every character to be JSON-escaped, plus the request envelope. */
export const COMMS_MESSAGE_BODY_LIMIT = COMMS_MESSAGE_MAX * 6 + 1024;

export const commsCutMarker = (kept: number, total: number): string =>
  `\n[stored text cut at ${kept} of ${total} characters]`;
