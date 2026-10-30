/**
 * The trim hook's logic (#1045): a seat's CLI runs `trim-cli.ts` after every tool call. A result
 * over `TOOL_TRIM_OVER` is kept whole in the run's folder and answered as a cut form, which the CLI
 * shows the model in place of the result (`updatedToolOutput`). Anything it cannot do leaves the
 * result whole: unlike the guard hook it never blocks, as the tool has already run.
 */

import { closeSync, constants, lstatSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { trimToolResponse } from "@mc/core";

/** The trim hook's entry file, from the hub root. */
export const TRIM_ENTRY = "apps/server/src/guard/trim-cli.ts";

/** A `tool_use_id` is a file name here: only what the CLI mints. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Keeps `text` in a new file in `dir`. The hook runs outside the seat's sandbox, so the seat must
 * not steer the write: `dir` is made by the hub before launch and is denyWrite to the seat, and
 * here it must still be a real directory we own (not a link), and the file is created exclusively
 * without following a link.
 */
function keepFull(dir: string, file: string, text: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new Error("not our folder");
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const buf = Buffer.from(text);
    for (let at = 0; at < buf.length; ) at += writeSync(fd, buf, at);
  } finally {
    closeSync(fd);
  }
}

/** The hook's stdout for one call: `""` when the result is left as it is. */
export function trimMain(stdin: string, dir: string): string {
  if (!dir.startsWith("/")) return "";
  try {
    const e: unknown = JSON.parse(stdin);
    if (typeof e !== "object" || e === null) return "";
    const {
      hook_event_name: event,
      tool_name: tool,
      tool_use_id: id,
      tool_response: res,
    } = e as {
      [k: string]: unknown;
    };
    if (event !== "PostToolUse" || typeof tool !== "string" || res === undefined) return "";
    if (typeof id !== "string" || !SAFE_ID.test(id)) return "";
    const file = join(dir, `${id}.txt`);
    const cut = trimToolResponse(tool, res, file);
    if (cut === null) return "";
    // the cut form is only safe to show once the full text is kept
    keepFull(dir, file, cut.full);
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: cut.output },
    });
  } catch {
    return "";
  }
}
