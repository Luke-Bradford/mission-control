/** Claude's interactive cmux workspace driver. */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type ControlSubtype, isObj, type SessionEvent } from "@mc/core";
import { toolResultBytes } from "../telemetry/prompt-cost.ts";
import { sleep } from "../util.ts";
import type { Cmux } from "./cmux.ts";
import { type CrewSession, SessionControlError } from "./session.ts";

export const cmuxWorkspaceKey = (runId: string) => `cmux.workspace:${runId}`;

export interface CmuxSessionInput {
  cmux: Cmux;
  name: string;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  privateEnv?: Record<string, string>;
  dir: string;
  /** Claude's Stop hook adds a line here at the end of each turn (`stopHookCommand`). */
  stopFile?: string;
  transcriptPath: string;
  cliSessionId: string;
  messageDir: string;
  log?: (message: string) => void;
  pollMs?: number;
  startWaitMs?: number;
  /** The hub had a turn open when it detached and needs the first cmux state reconciled. */
  awaiting?: boolean;
  /** The seat's saved state at restart, so the first cmux state is reconciled against it. */
  savedState?: string;
  onWorkspace?: (workspace: string, pid: number | null) => void;
}

const LIMIT_TEXT = /usage limit|hit your limit|limit reached|rate.?limit/i;
/** The text of an API-error assistant line. */
function apiErrorText(data: Record<string, unknown>): string {
  const content = isObj(data.message) ? data.message.content : null;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObj(part) && typeof part.text === "string" ? part.text : ""))
    .join(" ");
}
/** The reset time of a limit line (`...limit reached|<epoch seconds>`), in ms; null when it has none. */
function limitResetsAt(text: string): number | null {
  const seconds = /\|(\d{9,11})\b/.exec(text)?.[1];
  return seconds === undefined ? null : Number(seconds) * 1000;
}

/** Polls in a row that may fail before a registered seat is given up on. */
export const POLL_FAILURE_LIMIT = 5;
/** Failed tries between two log lines while a message keeps being retried. */
export const SEND_TRIES = 3;

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * The short script keeps the cmux shim at the beginning of PATH and never exposes private env in
 * argv. The CLI starts from a clean environment (`env -i`): only the crew's own variables, the
 * private ones the env file defines, and the terminal's CMUX_*, TERM, COLORTERM and TERM_PROGRAM,
 * which cmux's hooks need. The operator's login shell may hold tokens (GH_TOKEN, ANTHROPIC_API_KEY)
 * that a seat must never see.
 */
export function launcherScript(i: {
  command: string;
  args: string[];
  env: Record<string, string>;
  privateKeys?: string[];
  nodeDir: string;
  envFile: string | null;
}): string {
  const lines = ["#!/bin/zsh", "set -eu"];
  // Quote the fixed directory only: quoting `$PATH` would turn it into literal text and hide
  // cmux's shim, which is what supplies lifecycle hooks and notifications.
  lines.push(`mc_path=${shellQuote(i.nodeDir)}:$PATH`);
  lines.push(
    "mc_pass=()",
    `for mc_name in \${(k)parameters[(I)CMUX_*]} TERM COLORTERM TERM_PROGRAM; do`,
    `  [[ -n "\${(P)mc_name+x}" ]] && mc_pass+=("$mc_name=\${(P)mc_name}")`,
    "done",
  );
  if (i.envFile) lines.push(`source ${shellQuote(i.envFile)}`, `rm -f ${shellQuote(i.envFile)}`);
  const env = Object.entries(i.env)
    .filter(([key]) => key !== "PATH")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const priv = (i.privateKeys ?? []).map((key) => `${key}="$${key}"`);
  const assigns = [...env, ...priv, 'PATH="$mc_path"'].join(" ");
  lines.push(
    `exec /usr/bin/env -i "\${mc_pass[@]}" ${assigns} ${[i.command, ...i.args].map(shellQuote).join(" ")}`,
  );
  return `${lines.join("\n")}\n`;
}

export function startCmuxSession(i: CmuxSessionInput): CrewSession {
  return cmuxSession(i);
}

export function attachCmuxSession(
  i: CmuxSessionInput & {
    workspace: string;
    pid: number;
    from: number;
    awaiting: boolean;
    savedState: string;
  },
): CrewSession {
  return cmuxSession(i, i.workspace, i.pid, i.from);
}

function cmuxSession(
  i: CmuxSessionInput,
  attachedWorkspace?: string,
  attachedPid?: number,
  from = 0,
): CrewSession {
  let workspace = attachedWorkspace ?? null;
  let pid = attachedPid;
  let alive = true;
  let failure: string | null = null;
  let detached = false;
  let closing = false;
  let lines = from;
  let source = "";
  let sessionId = i.cliSessionId;
  let lifecycle: "idle" | "running" | "needsInput" | null = null;
  let trustSent = false;
  let pollFailures = 0;
  // A hub message was sent and its turn is not finished yet. cmux can go idle, running, idle between
  // two polls, so a turn is also finished when Claude's answer is in the transcript and cmux is idle.
  let expectTurn = false;
  let answered = false;
  let turnStarted = false;
  // Stop-hook markers when the hub's message went in; a later one ends the hub's turn
  let stopsAtSend = 0;
  const countStops = () => {
    if (!i.stopFile || !existsSync(i.stopFile)) return 0;
    return readFileSync(i.stopFile, "utf8").split("\n").filter(Boolean).length;
  };
  // The turn ended in an API error (a usage limit, say): its result is an error.
  let turnError = false;
  const undelivered: string[] = [];
  let sendChain = Promise.resolve();
  let attached = attachedWorkspace !== undefined;
  let timer: NodeJS.Timeout | null = null;
  const listeners = new Set<(event: SessionEvent) => void>();
  const emit = (event: SessionEvent) => {
    for (const listener of [...listeners])
      try {
        listener(event);
      } catch {}
  };
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let resolveCloseSent: () => void = () => {};
  const closeSent = new Promise<void>((resolve) => {
    resolveCloseSent = resolve;
  });
  const ended = (reason?: string, retake?: true) => {
    if (!alive) return;
    alive = false;
    failure = reason ?? null;
    if (timer) clearTimeout(timer);
    resolveReady();
    resolveCloseSent();
    if (!detached)
      emit({ kind: "exit", code: null, signal: null, reason, ...(retake ? { retake } : {}) });
  };
  const copy = () => {
    if (!source || !existsSync(source)) return;
    const all = readFileSync(source, "utf8").split("\n");
    const complete = all.length > 0 && all.at(-1) === "" ? all.slice(0, -1) : all.slice(0, -1);
    if (lines >= complete.length) return;
    const fresh = complete.slice(lines);
    appendFileSync(i.transcriptPath, `${fresh.join("\n")}\n`, { mode: 0o600 });
    lines += fresh.length;
    for (const line of fresh) {
      emit({ kind: "output", at: Date.now() });
      try {
        const data: unknown = JSON.parse(line);
        if (
          isObj(data) &&
          data.type === "system" &&
          data.subtype === "init" &&
          typeof data.session_id === "string"
        ) {
          sessionId = data.session_id;
          emit({
            kind: "init",
            sessionId,
            model: typeof data.model === "string" ? data.model : null,
          });
        }
        if (isObj(data) && data.type === "assistant") {
          if (data.isApiErrorMessage === true) {
            // an API error ends the turn without a Stop hook
            if (expectTurn) answered = true;
            turnError = true;
            const text = apiErrorText(data);
            if (data.error === "rate_limit" || LIMIT_TEXT.test(text))
              emit({ kind: "rate-limit", status: "rejected", resetsAt: limitResetsAt(text) });
          }
        }
        if (
          isObj(data) &&
          data.type === "user" &&
          isObj(data.message) &&
          Array.isArray(data.message.content)
        ) {
          for (const content of data.message.content)
            if (
              isObj(content) &&
              content.type === "tool_result" &&
              typeof content.tool_use_id === "string"
            )
              emit({
                kind: "tool-result",
                toolUseId: content.tool_use_id,
                bytes: toolResultBytes(content),
              });
        }
      } catch {
        /* transcript diagnostics are still copied */
      }
    }
  };
  const finishTurn = () => {
    appendFileSync(
      i.transcriptPath,
      `{"type":"result","subtype":"${turnError ? "error_during_execution" : "success"}","is_error":${turnError},"stop_reason":"end_turn","mc_cmux":true}\n`,
      { mode: 0o600 },
    );
    const isError = turnError;
    expectTurn = false;
    answered = false;
    turnStarted = false;
    turnError = false;
    emit({ kind: "result", isError, stopReason: "end_turn" });
  };
  const pollOnce = async () => {
    if (!alive || detached || workspace === null) return;
    try {
      const record = (await i.cmux.agents()).find((a) => a.workspaceId === workspace);
      if (!record || record.pid === null) {
        // cmux registers Claude only after its shell and hooks have started. A brand-new
        // workspace has no pid yet, so absence here is startup, not an exited process.
        if (pid === undefined && attachedWorkspace === undefined) {
          if (!trustSent) {
            const screen = await i.cmux.readScreen(workspace);
            if (/trust.*folder|folder.*trust/i.test(screen)) {
              await i.cmux.sendKey(workspace, "enter");
              trustSent = true;
            }
          }
          return;
        }
        return ended("the Claude process in cmux ended");
      }
      if (pid !== undefined && record.pid !== pid)
        return ended("the Claude process in cmux was restored", true);
      pid = record.pid;
      i.onWorkspace?.(workspace, pid);
      if (record.sessionId !== sessionId) {
        sessionId = record.sessionId;
        lines = 0;
        source = record.transcriptPath ?? source;
        emit({ kind: "init", sessionId, model: null });
      }
      if (record.transcriptPath) source = record.transcriptPath;
      const linesBefore = lines;
      copy();
      if (lifecycle === null) {
        lifecycle = record.lifecycle;
        if (attached) {
          if (lifecycle === "idle" && i.awaiting) finishTurn();
          if (lifecycle === "needsInput") emit({ kind: "needs-input" });
          if (lifecycle === "running" && i.savedState !== "running") emit({ kind: "turn-start" });
          attached = false;
          emit({ kind: "attached", awaiting: lifecycle !== "idle" });
        }
      } else if (lifecycle !== record.lifecycle) {
        lifecycle = record.lifecycle;
        if (lifecycle === "running") {
          turnStarted = true;
          emit({ kind: "turn-start" });
        }
        if (lifecycle === "needsInput") emit({ kind: "needs-input" });
        if (lifecycle === "idle") finishTurn();
      } else if (
        lifecycle === "idle" &&
        expectTurn &&
        (answered || countStops() > stopsAtSend) &&
        lines === linesBefore
      ) {
        // The whole turn fell between two polls: Claude's own Stop hook marked the end of the turn
        // the hub started (or an API error ended it), cmux is idle and the transcript has settled.
        if (!turnStarted) emit({ kind: "turn-start" });
        finishTurn();
      }
      pollFailures = 0;
      resolveReady();
    } catch (error) {
      i.log?.(`cmux poll: ${error instanceof Error ? error.message : String(error)}`);
      // A registered seat whose cmux stopped answering would keep its last state forever: after
      // a bounded run of failures the session ends so the supervisor recovers or shows the error.
      if (pid !== undefined && ++pollFailures >= POLL_FAILURE_LIMIT)
        ended("cmux stopped answering", true);
    }
  };
  const schedulePoll = () => {
    if (!alive || detached || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      await pollOnce();
      schedulePoll();
    }, i.pollMs ?? 1000);
  };
  const launch = async () => {
    try {
      if (workspace === null) {
        mkdirSync(i.dir, { recursive: true, mode: 0o700 });
        const envFile = i.privateEnv ? join(i.dir, "env") : null;
        if (envFile) {
          writeFileSync(
            envFile,
            Object.entries(i.privateEnv ?? {})
              .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
              .join("\n"),
            { mode: 0o600 },
          );
          chmodSync(envFile, 0o600);
        }
        const script = join(i.dir, "launch.zsh");
        writeFileSync(
          script,
          launcherScript({
            command: i.command,
            args: i.args,
            env: i.env,
            privateKeys: Object.keys(i.privateEnv ?? {}),
            nodeDir: dirname(process.execPath),
            envFile,
          }),
          { mode: 0o700 },
        );
        chmodSync(script, 0o700);
        await i.cmux.ensure();
        workspace = await i.cmux.newWorkspace({ name: i.name, cwd: i.cwd, command: script });
        i.onWorkspace?.(workspace, null);
      }
      const deadline = Date.now() + (i.startWaitMs ?? 60_000);
      while (Date.now() < deadline && alive && !detached) {
        await pollOnce();
        if (pid !== undefined) {
          schedulePoll();
          return;
        }
        await sleep(100);
      }
      // A detached session belongs to a stopping hub: leave the workspace for the next one.
      if (detached) return;
      if (workspace) await i.cmux.close(workspace);
      ended("cmux did not start Claude");
    } catch (error) {
      ended(error instanceof Error ? error.message : String(error));
    }
  };
  void launch();
  return {
    send(text) {
      if (!alive) throw new SessionControlError("ended", "session ended");
      undelivered.push(text);
      const deliver = async () => {
        let failedTries = 0;
        let textIn = false;
        let body = text;
        if (text.includes("\n")) {
          mkdirSync(i.messageDir, { recursive: true, mode: 0o700 });
          const file = join(i.messageDir, `${Date.now()}-${randomUUID()}.md`);
          writeFileSync(file, text, { mode: 0o600 });
          chmodSync(file, 0o600);
          body = `Mission Control sent you a message. Read ${file} and act on it.`;
        }
        // Armed before the first Enter: Claude can answer and fire its Stop hook before `send-key`
        // returns, and that marker must count as this turn's. The baseline is kept across retries.
        const wasExpecting = expectTurn;
        expectTurn = true;
        answered = false;
        turnStarted = false;
        stopsAtSend = countStops();
        let delivered = false;
        try {
          while (alive && !detached) {
            if (workspace === null) throw new SessionControlError("ended", "session ended");
            let sent: "sent" | "busy";
            try {
              // after the text went in, a retry sends only the Enter, never the text twice
              sent = textIn ? "sent" : await i.cmux.send(workspace, body);
              if (sent === "sent") {
                textIn = true;
                await i.cmux.sendKey(workspace, "enter");
              }
            } catch (error) {
              // The supervisor has already recorded this prompt as delivered, so it is never
              // dropped: it stays queued and is retried until it arrives or the session ends
              // (a seat that cmux stops answering for ends through the poll check).
              if (failedTries++ % SEND_TRIES === 0)
                i.log?.(`cmux send: ${error instanceof Error ? error.message : String(error)}`);
              await sleep(i.pollMs ?? 1000);
              continue;
            }
            if (sent === "sent") {
              undelivered.splice(undelivered.indexOf(text), 1);
              delivered = true;
              return;
            }
            await sleep(2000);
          }
        } finally {
          // delivery ended without the prompt going in: no turn is expected for it
          if (!delivered) expectTurn = wasExpecting;
        }
      };
      const next = sendChain
        .catch(() => {})
        .then(async () => {
          await ready;
          if (!alive) throw new SessionControlError("ended", "session ended");
          await deliver();
        });
      sendChain = next;
      void next.catch((error) =>
        i.log?.(`cmux send: ${error instanceof Error ? error.message : String(error)}`),
      );
    },
    control(subtype: ControlSubtype) {
      if (!alive || workspace === null)
        return Promise.reject(new SessionControlError("ended", "session ended"));
      if (subtype !== "interrupt")
        return Promise.reject(new SessionControlError("refused", "not available in cmux"));
      return i.cmux.sendKey(workspace, "escape", true);
    },
    async close() {
      closing = true;
      if (workspace) await i.cmux.close(workspace);
      ended();
      return null;
    },
    detach() {
      detached = true;
      if (timer) clearTimeout(timer);
      resolveCloseSent();
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get pid() {
      return pid;
    },
    get alive() {
      return alive && !closing;
    },
    ready,
    get lines() {
      return lines;
    },
    closeSent,
    get undelivered() {
      return undelivered;
    },
    get failure() {
      return failure;
    },
  };
}
