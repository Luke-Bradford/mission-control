import { cutText } from "../fmt.ts";

/** A Comms message shows this many characters in the Live log; the Comms page holds the rest. */
export const COMMS_PREVIEW_CHARS = 120;

/**
 * One Live-log row's text on one line: line breaks and runs of spaces become single spaces, and a
 * Comms message is cut to its first {@link COMMS_PREVIEW_CHARS} characters. Other events stay whole;
 * the row clamps them to a line and offers the rest on a toggle. `cut` says text was left out.
 */
export function logLine(text: string, kind: "comms" | "step"): { text: string; cut: boolean } {
  const line = text.replace(/\s+/g, " ").trim();
  if (kind !== "comms") return { text: line, cut: false };
  const out = cutText(line, COMMS_PREVIEW_CHARS);
  return { text: out, cut: out !== line };
}
