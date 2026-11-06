/**
 * The live check of a CLI update, as a seat runs it: the supervisor starts one idle seat of the
 * tool's vendor through its own start path (account binding, seat config, sandbox, guard hook,
 * and for Codex the app-server) in a throwaway worktree, with one harmless task. This file holds
 * what is not the start path: the task, and the judge of what the seat's transcript shows.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** How long a check may take, from the seat's start to its answer. */
export const CLI_CHECK_TIMEOUT_MS = 3 * 60_000;

/** The name of the throwaway worktree a seat's check runs in (a seat holds one check at a time). */
export const cliCheckCheckoutName = (seatId: string): string => `${seatId}-cli-check`;

/**
 * What the supervisor made of a check. `ran`: a seat started on the new version and the task did
 * (`ok`) or did not pass. `no-seat`: no seat of that vendor is configured, so no run can break on
 * this tool. `busy`: seats of that vendor exist but all hold a run, so nothing was proven either
 * way. `unproven`: the start failed before the new CLI was invoked (git, checkout, pnpm store),
 * which says nothing of the CLI.
 */
export type CliCheckResult =
  | { kind: "ran"; ok: boolean; detail: string }
  | { kind: "no-seat" }
  | { kind: "busy" }
  | { kind: "unproven"; detail: string };

export interface CliCheckTask {
  /** The one line the seat is sent. */
  prompt: string;
  /** What only a read of the file can know. */
  nonce: string;
}

/**
 * Writes a file holding a random nonce into `dir` (the throwaway worktree) and returns the task
 * that asks for it. A model that merely answers cannot know the nonce.
 */
export function writeCliCheckTask(dir: string): CliCheckTask {
  const nonce = randomBytes(8).toString("hex");
  const file = `check-${randomBytes(4).toString("hex")}.txt`;
  writeFileSync(join(dir, file), nonce);
  return {
    nonce,
    prompt: `This is a check that the CLI starts and can use a tool. Read the file ${file} in the current directory and reply with its exact contents and nothing else.`,
  };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_LINE = 200;

/** Every string in `v`, at any depth. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (isObj(v)) for (const x of Object.values(v)) strings(x, out);
  return out;
}

const mentions = (v: unknown, nonce: string): boolean => strings(v).some((s) => s.includes(nonce));

/**
 * Judges a seat's transcript (the CLI's stdout lines, Claude's stream or Codex's app-server
 * notifications) against the task: the turn must not have failed, a tool result must carry the
 * nonce (the tool read the file) and the answer must carry it too.
 */
export function judgeCliCheck(transcript: string, nonce: string): { ok: boolean; detail: string } {
  let failed: string | null = null;
  let finished = false;
  let toolSaw = false;
  let answered = false;
  for (const line of transcript.split("\n")) {
    if (!line.startsWith("{")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(ev)) continue;
    // Claude stream-json
    if (ev.type === "user" && isObj(ev.message) && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (isObj(c) && c.type === "tool_result" && mentions(c.content, nonce)) toolSaw = true;
      }
    } else if (ev.type === "assistant" && isObj(ev.message) && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (isObj(c) && c.type === "text" && mentions(c.text, nonce)) answered = true;
      }
    } else if (ev.type === "result") {
      finished = true;
      if (ev.is_error === true) failed = String(ev.subtype ?? ev.stop_reason ?? "the turn failed");
      if (typeof ev.result === "string" && ev.result.includes(nonce)) answered = true;
    }
    // Codex app-server
    const params = isObj(ev.params) ? ev.params : null;
    if (ev.method === "item/completed" && params !== null && isObj(params.item)) {
      const item = params.item;
      if (item.type === "agentMessage" && mentions(item.text, nonce)) answered = true;
      if (item.type === "commandExecution" && mentions(item.aggregatedOutput, nonce)) {
        toolSaw = true;
      }
    } else if (ev.method === "turn/completed" && params !== null && isObj(params.turn)) {
      finished = true;
      if (params.turn.status === "failed") failed = "the turn failed";
    }
  }
  const say = (text: string) => ({ ok: false, detail: text.slice(0, MAX_LINE) });
  if (failed !== null) return say(`the seat's turn failed (${failed})`);
  if (!finished) return say("the seat's turn did not finish");
  if (!toolSaw) return say("no tool call read the file");
  if (!answered) return say("the answer did not carry the file's contents");
  return { ok: true, detail: "a seat started on it, read a file with a tool and answered" };
}

/** The setting that names the check run a seat holds, so a restart can end it (it is no seat run). */
export const cliCheckRunKey = (seatId: string): string => `cli-check-run:${seatId}`;
