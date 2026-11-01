/**
 * The guard hook's logic: each seat's CLI runs `hook-cli.ts` (`HOOK_ENTRY`) before every tool call
 * (PreToolUse) and after the calls that can hold the test lock (PostToolUse, PostToolUseFailure).
 * It asks the hub for a verdict, and the output is one of two fixed forms: `{}` (no objection; the
 * CLI's rules still apply) or the deny form. A Stop (the seat ends a turn) is asked too, and may be
 * answered with the block form: the seat carries on.
 *
 * It never fails open, except for a Stop (see `STOP_UNANSWERED`): anything but an HTTP 200 carrying `{}` or the deny form, and any failure of
 * its own, is the "unreachable" deny with exit 2 (spike 2026-10-21: exit 2 blocks the tool). The
 * command line holds only paths; the token is read from its 0600 file and sent only to 127.0.0.1.
 * Nothing the hub says is relayed as text: the output is rebuilt here.
 *
 * A refused or reset connection (the hub restarting) is retried every second for `HOOK_RETRY_MS`
 * from the first try; after that it is the same deny. An HTTP answer is never retried.
 *
 * A Post that fails (hub down, a bad answer) is not retried: the call's hold then lasts until the
 * supervisor's `releaseRun` (the turn's end, an interrupt or the process's exit).
 */

import { readFile } from "node:fs/promises";
import {
  GUARD_ALLOW_OUTPUT,
  GUARD_BODY_LIMIT,
  GUARD_HOOK_EVENTS,
  GUARD_TOO_LONG_TEXT,
  GUARD_UNREACHABLE_TEXT,
  type GuardHookEvent,
  guardDenyOutput,
  guardStopOutput,
  HOOK_DEADLINE_MS,
  HOOK_RETRY_EVERY_MS,
  HOOK_RETRY_MS,
  LOOPBACK_HOST,
} from "@mc/core";

export interface HookResult {
  out: string;
  exit: 0 | 2;
}

export type HookPost = (
  url: string,
  token: string,
  body: string,
) => Promise<{ status: number; body: string }>;

/** The hook's entry file, from the hub root: the one path the seat's hook command names. */
export const HOOK_ENTRY = "apps/server/src/guard/hook-cli.ts";

/** A hub reason longer than this is not one the hub writes: fail closed. */
const MAX_REASON = 2000;
const TOKEN = /^[0-9a-f]{64}$/;

export const FAILED: HookResult = { out: guardDenyOutput(GUARD_UNREACHABLE_TEXT), exit: 2 };
/**
 * A Stop with no verdict lets the stop stand: exit 2 from a Stop hook blocks the stop, which would
 * send the seat round again for as long as the hub is down. Letting a stop stand loosens no rule.
 */
export const STOP_UNANSWERED: HookResult = { out: GUARD_ALLOW_OUTPUT, exit: 0 };

/** What the hook answers when it has no verdict for `stdin`'s event (a Stop fails open). */
export function failureFor(stdin: string): HookResult {
  try {
    const e: unknown = JSON.parse(stdin);
    return isObject(e) && e.hook_event_name === "Stop" ? STOP_UNANSWERED : FAILED;
  } catch {
    return FAILED;
  }
}

class Unusable extends Error {}

/** A refused or reset connection (a socket hang-up is ECONNRESET): the hub is not answering yet. */
const CONNECTION_ERRORS: readonly unknown[] = ["ECONNREFUSED", "ECONNRESET"];
const isConnectionError = (err: unknown): boolean =>
  isObject(err) && CONNECTION_ERRORS.includes(err.code);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The check body: only what the guard reads, never the raw stdin (a Write's content, a Post's output). */
function checkBody(stdin: string): { event: GuardHookEvent; body: string } {
  const e: unknown = JSON.parse(stdin);
  if (!isObject(e)) throw new Unusable();
  const event = e.hook_event_name;
  const tool = e.tool_name;
  const id = e.tool_use_id;
  if (!(GUARD_HOOK_EVENTS as readonly unknown[]).includes(event)) throw new Unusable();
  // a Stop names no tool: the hub knows the run from the token
  if (event === "Stop") return { event, body: JSON.stringify({ hook_event_name: event }) };
  if (typeof tool !== "string" || tool === "" || typeof id !== "string" || id === "") {
    throw new Unusable();
  }
  const out: Record<string, unknown> = { hook_event_name: event, tool_name: tool, tool_use_id: id };
  if (event === "PreToolUse") {
    // a subagent's call carries its id: what it reads is in its context, not the seat's
    if (e.agent_id !== undefined) {
      if (typeof e.agent_id !== "string") throw new Unusable();
      if (e.agent_id !== "") out.agent_id = e.agent_id;
    }
    const raw = e.tool_input ?? {};
    if (!isObject(raw)) throw new Unusable();
    const input: Record<string, unknown> = {};
    // a field of the wrong type is not left out (which could read as "no command"): fail closed
    for (const [k, type] of [
      ["command", "string"],
      ["file_path", "string"],
      ["pages", "string"],
      ["run_in_background", "boolean"],
    ] as const) {
      if (raw[k] === undefined) continue;
      if (typeof raw[k] !== type) throw new Unusable();
      input[k] = raw[k];
    }
    // a Read's range: a numeric string is a number to the CLI; anything else fails closed, since
    // dropping it would make a range look like a whole-file read. A Bash `timeout` is forwarded the
    // same way: the hub uses it only to say why a check call that ran that long was not counted.
    for (const k of ["offset", "limit", "timeout"]) {
      const v = raw[k];
      if (v === undefined) continue;
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Unusable();
      input[k] = n;
    }
    out.tool_input = input;
  }
  return { event: event as GuardHookEvent, body: JSON.stringify(out) };
}

/**
 * The hub's answer, rebuilt as one of the fixed forms; null for anything else. The deny form
 * answers a PreToolUse and the block form a Stop, never the other way round.
 */
function verdict(status: number, text: string, event: GuardHookEvent): string | null {
  if (status !== 200) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length === 0) return GUARD_ALLOW_OUTPUT;
  if (event === "Stop") {
    const why = v.reason;
    if (
      keys.length !== 2 ||
      v.decision !== "block" ||
      typeof why !== "string" ||
      why === "" ||
      why.length > MAX_REASON
    ) {
      return null;
    }
    return guardStopOutput(why);
  }
  if (keys.length !== 1 || !isObject(v.hookSpecificOutput)) return null;
  const h = v.hookSpecificOutput;
  const reason = h.permissionDecisionReason;
  if (
    Object.keys(h).length !== 3 ||
    h.hookEventName !== "PreToolUse" ||
    h.permissionDecision !== "deny" ||
    typeof reason !== "string" ||
    reason === "" ||
    reason.length > MAX_REASON
  ) {
    return null;
  }
  return guardDenyOutput(reason);
}

async function decide(
  stdin: string,
  argv: readonly string[],
  post: HookPost,
  retryMs: number,
  failed: HookResult,
): Promise<HookResult> {
  const [tokenFile, url] = argv;
  if (typeof tokenFile !== "string" || typeof url !== "string") return failed;
  const target = new URL(url);
  // the token goes to the hub on loopback, nowhere else
  if (target.protocol !== "http:" || target.hostname !== LOOPBACK_HOST) return failed;
  const { event, body } = checkBody(stdin);
  if (Buffer.byteLength(body) > GUARD_BODY_LIMIT) {
    // A PreToolUse: a decision, not a failure (the route's 413 would only say "unreachable"). A
    // Post carries only the event, tool_name and tool_use_id, but those are unbounded: one this
    // large fails closed, and its hold waits for `releaseRun`.
    return event === "PreToolUse" ? { out: guardDenyOutput(GUARD_TOO_LONG_TEXT), exit: 0 } : failed;
  }
  const started = Date.now();
  for (;;) {
    // read again each try: a restarted hub may have written a new token
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (!TOKEN.test(token)) return failed;
    let res: { status: number; body: string };
    try {
      res = await post(url, token, body);
    } catch (err) {
      // only a hub that is not there is waited for; any other failure is a deny at once
      if (!isConnectionError(err) || Date.now() - started + HOOK_RETRY_EVERY_MS > retryMs) {
        return failed;
      }
      await new Promise((resolve) => setTimeout(resolve, HOOK_RETRY_EVERY_MS));
      continue;
    }
    const out = verdict(res.status, res.body, event);
    return out === null ? failed : { out, exit: 0 };
  }
}

/**
 * One hook call: `stdin` as the CLI sent it, `argv` = [token file, check URL]. Never throws, and
 * answers within `HOOK_DEADLINE_MS`, well inside the CLI's own hook timeout (which would run the
 * tool).
 */
export async function hookMain(
  stdin: string,
  argv: readonly [string, string],
  post: HookPost,
  retryMs: number = HOOK_RETRY_MS,
): Promise<HookResult> {
  const failed = failureFor(stdin);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<HookResult>((resolve) => {
    timer = setTimeout(() => resolve(failed), HOOK_DEADLINE_MS);
  });
  try {
    return await Promise.race([
      decide(stdin, argv, post, retryMs, failed).catch(() => failed),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
