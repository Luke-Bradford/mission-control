/**
 * The trim hook's logic (#1045): a seat's CLI runs `trim-cli.ts` after every tool call. A result
 * over `TOOL_TRIM_OVER` is kept whole in the run's folder and answered as a cut form, which the CLI
 * shows the model in place of the result (`updatedToolOutput`). Anything it cannot do leaves the
 * result whole: unlike the guard hook it never blocks, as the tool has already run.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trimToolResponse } from "@mc/core";

/** The trim hook's entry file, from the hub root. */
export const TRIM_ENTRY = "apps/server/src/guard/trim-cli.ts";

/** A `tool_use_id` is a file name here: only what the CLI mints. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, cut.full, { mode: 0o600 });
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: cut.output },
    });
  } catch {
    return "";
  }
}
