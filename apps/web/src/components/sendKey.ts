import type { KeyboardEvent } from "react";

/** The one send rule for every message box in the app, printed under each box. */
export const SEND_HINT = "Enter to send · Shift+Enter for a new line";

/**
 * Whether this key press sends the message: Enter, or Ctrl/Cmd with Enter. Shift+Enter is a new
 * line, and Enter while an input method is composing text (a candidate being picked) is not a send.
 */
export function isSendKey(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey"> & {
    nativeEvent?: { isComposing?: boolean };
  },
): boolean {
  if (e.key !== "Enter" || e.nativeEvent?.isComposing === true) return false;
  return e.ctrlKey || e.metaKey || !e.shiftKey;
}
