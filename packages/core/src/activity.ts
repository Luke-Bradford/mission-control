/** `/api/activity` covers this window, newest first, and returns at most ACTIVITY_LIMIT events. */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_LIMIT = 1000;

/** `who` or `to` of a comms row: the operator. Upper case, so never a seat id. */
export const COMMS_CAPCOM = "CAPCOM";
/** `who` of a comms row Mission Control's engine sent. */
export const COMMS_MC = "MC";
/** A stored comms text is cut to this many characters. */
export const COMMS_TEXT_MAX = 500;
