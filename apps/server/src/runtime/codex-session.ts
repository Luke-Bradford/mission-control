/** A Codex app-server thread over the same keeper transport as the Claude driver. */

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  CANNOT_START,
  CODEX_COMMAND,
  CODEX_PROJECT_DOC_CONFIG,
  CODEX_SEAT_PROFILE,
  CONTROL_TIMEOUT_MS,
  isObj,
  type SessionEvent,
} from "@mc/core";
import { str } from "../util.ts";
import { CODEX_MCP_ELICITATION } from "./codex-wire.ts";
import { CODEX_DELIVERY } from "./keeper.ts";
import {
  type CrewSession,
  type KeeperSession,
  SessionControlError,
  startKeeperSession,
} from "./session.ts";

export { CODEX_MCP_ELICITATION } from "./codex-wire.ts";

/** Taken from an active mcpToolCall item, never from the elicitation's display text. */
export interface CodexMcpCall {
  itemId: string;
  server: string;
  tool: string;
}

export interface CodexSessionInput {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  transcriptPath: string;
  node: string;
  entry: string;
  dir: string;
  spawn: string;
  marker: string;
  model: string;
  effort: string | null;
  developerInstructions: string;
  resumeThreadId: string | null;
  outboxPath: string;
  approve: (
    req: { id: number | string; method: string; params: unknown; mcpCall?: CodexMcpCall },
    paths: readonly string[] | undefined,
    signal: AbortSignal,
  ) => Promise<"accept" | "decline">;
  command?: string;
  prepare?: (dir: string) => void;
  log?: (line: string) => void;
  controlTimeoutMs?: number;
  stopGraceMs?: number;
}

export const CODEX_OUTBOX_FILE = "outbox.json";

function saveOutbox(path: string, entries: Map<string, string>): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify([...entries]), { mode: 0o600, flush: true });
  renameSync(tmp, path);
}

function readOutbox(path: string, transcriptPath?: string): Map<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw e;
  }
  const entries: unknown = JSON.parse(text);
  if (
    !Array.isArray(entries) ||
    !entries.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  )
    throw new Error("invalid Codex outbox");
  const outbox = new Map<string, string>(entries);
  // A cold resume has no keeper to replay receipts written while the hub was away.
  if (outbox.size > 0 && transcriptPath !== undefined) {
    for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (isObj(message) && message.type === CODEX_DELIVERY && typeof message.id === "string")
        outbox.delete(message.id);
    }
    saveOutbox(path, outbox);
  }
  return outbox;
}

type RpcId = number | string;
type ApprovalRequest = Parameters<CodexSessionInput["approve"]>[0];
interface OpenApproval {
  controller: AbortController;
  itemId: string | null;
  req: ApprovalRequest;
  files: readonly string[] | undefined;
}
interface ReplayApproval {
  req: ApprovalRequest;
  files: readonly string[] | undefined;
  completed: boolean;
}
interface Pending {
  onSuccess?: () => void;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const rpcId = (value: unknown): value is RpcId =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
const tokens = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function startCodexSession(i: CodexSessionInput): CrewSession {
  const outbox = readOutbox(i.outboxPath, i.resumeThreadId === null ? undefined : i.transcriptPath);
  const transport = startKeeperSession({
    ...i,
    command: i.command ?? CODEX_COMMAND,
    cliSessionId: i.marker,
    turnEnd: "codex",
  });
  return codexSession(i, transport, outbox);
}

export interface CodexAttachInput {
  /** Earlier lines rebuild protocol state without repeating supervisor events. */
  from: number;
  threadId: string;
  model: string;
  effort: string | null;
  cwd: string;
  developerInstructions: string;
  outboxPath: string;
  approve: CodexSessionInput["approve"];
  controlTimeoutMs?: number;
  log?: (line: string) => void;
}

export function attachCodexSession(i: CodexAttachInput, transport: KeeperSession): CrewSession {
  return codexSession(i, transport);
}

function codexSession(
  i: CodexSessionInput | CodexAttachInput,
  transport: KeeperSession,
  outbox = readOutbox(i.outboxPath),
): CrewSession {
  let replaying = "threadId" in i;
  const replayRequests = new Map<RpcId, ReplayApproval>();
  let checked = false;
  const report = () => !replaying || ("from" in i && transport.lines > i.from);
  const listeners = new Set<(e: SessionEvent) => void>();
  const pending = new Map<RpcId, Pending>();
  const seenRequests = new Set<RpcId>();
  const approvals = new Map<RpcId, OpenApproval>();
  const paths = new Map<string, readonly string[] | undefined>();
  const mcpCalls = new Map<string, CodexMcpCall & { threadId: string; turnId: string }>();
  const itemKeys = new Map<string, Set<string>>();
  const dispatched = new Set<string>();
  let threadId: string | null = "threadId" in i ? i.threadId : null;
  let turnId: string | null = null;
  let closing = false;
  let uncertain = false;
  let startDone: Promise<void> | null = null;
  let started: ReturnType<typeof waitForEvent> | null = null;
  const completions = new Map<string, Set<ReturnType<typeof waitForEvent>>>();
  let failed = false;
  let totalTokens: number | null = null;
  let maxTokens: number | null = null;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const emit = (e: SessionEvent) => {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch {
        // A listener must not stop the protocol or the other listeners.
      }
    }
  };
  const ended = () => new SessionControlError("ended", "session ended");
  const request = (
    method: string,
    params: unknown,
    onSuccess?: () => void,
    deliveryId?: string,
  ): Promise<unknown> => {
    if (closing || !transport.alive) return Promise.reject(ended());
    const id = deliveryId ?? randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new SessionControlError("timeout", `${method} timeout`));
      }, i.controlTimeoutMs ?? CONTROL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, onSuccess });
      try {
        transport.write({ id, method, params }, method === "turn/start", deliveryId);
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  };
  const waitForEvent = (method: string) => {
    let resolve: () => void = () => {};
    let reject: (error: Error) => void = () => {};
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(() => {
      reject(new SessionControlError("timeout", `${method} timeout`));
    }, i.controlTimeoutMs ?? CONTROL_TIMEOUT_MS);
    return {
      promise,
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
  };
  const answer = (req: ApprovalRequest, decision: "accept" | "decline") => {
    try {
      transport.write({
        id: req.id,
        result:
          req.method === CODEX_MCP_ELICITATION
            ? { action: decision, content: decision === "accept" ? {} : null }
            : { decision },
      });
    } catch {
      // The process may already be gone.
    }
  };
  const auditDecline = (req: ApprovalRequest, files: readonly string[] | undefined) => {
    // Reattachment must confirm the live floor before invoking the guard at all.
    if ("threadId" in i && !checked) return;
    void Promise.resolve()
      .then(() => i.approve(req, files, AbortSignal.abort()))
      .catch(() => emit({ kind: "stderr", text: "Codex refusal audit failed" }));
  };
  const cancelApprovals = (itemId?: string) => {
    for (const [id, approval] of approvals) {
      if (itemId !== undefined && approval.itemId !== itemId) continue;
      approvals.delete(id);
      approval.controller.abort();
      auditDecline(approval.req, approval.files);
      answer(approval.req, "decline");
    }
  };
  const finish = (detach = false) => {
    if (detach) {
      for (const approval of approvals.values()) approval.controller.abort();
      approvals.clear();
    } else {
      cancelApprovals();
      for (const { req, files } of replayRequests.values()) {
        auditDecline(req, files);
        answer(req, "decline");
      }
    }
    replayRequests.clear();
    started?.reject(ended());
    for (const waits of completions.values()) for (const wait of waits) wait.reject(ended());
    completions.clear();
    closing = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(ended());
    }
    pending.clear();
    resolveReady();
  };
  const flush = () => {
    if (closing || !checked || startDone !== null) return;
    for (const [id, text] of outbox) {
      if (dispatched.has(id)) continue;
      dispatched.add(id);
      if (turnId === null) {
        startTurn(text, id);
        return;
      }
      void request(
        "turn/steer",
        { threadId, expectedTurnId: turnId, input: [{ type: "text", text }] },
        undefined,
        id,
      ).catch((e: unknown) => {
        if (!closing)
          emit({ kind: "stderr", text: e instanceof Error ? e.message : "turn/steer failed" });
      });
    }
  };
  const waitForStart = (response?: Promise<unknown>) => {
    const notification = waitForEvent("turn/started");
    started = notification;
    startDone = Promise.all([response, notification.promise]).then(
      () => {
        started = null;
        startDone = null;
        if (!closing) flush();
      },
      (e: unknown) => {
        notification.reject(ended());
        started = null;
        startDone = null;
        if (closing) return;
        emit({ kind: "stderr", text: e instanceof Error ? e.message : "turn/start failed" });
        if (e instanceof SessionControlError && e.kind === "refused") {
          emit({ kind: "turn-refused", active: turnId !== null });
          flush();
        } else {
          // A lost acknowledgement or start notification cannot prove that execution stopped.
          uncertain = true;
          finish();
          void transport.close();
        }
      },
    );
  };
  const startTurn = (text: string, id: string) => {
    waitForStart(
      request(
        "turn/start",
        { threadId, input: [{ type: "text", text }], effort: i.effort },
        undefined,
        id,
      ),
    );
  };
  const init = (id: string) => {
    if (threadId !== null) return;
    threadId = id;
    emit({ kind: "init", sessionId: id, model: i.model });
  };

  const approve = (req: ApprovalRequest, replay?: ReplayApproval) => {
    seenRequests.add(req.id);
    const params = isObj(req.params) ? req.params : {};
    const controller = new AbortController();
    const itemId = req.mcpCall?.itemId ?? str(params.itemId);
    const files = replay ? replay.files : itemId === null ? undefined : paths.get(itemId);
    if (replay?.completed) controller.abort();
    approvals.set(req.id, { controller, itemId, req, files });
    const key = params.approvalId ?? params.itemId;
    if (itemId !== null && rpcId(key)) {
      const keys = itemKeys.get(itemId) ?? new Set<string>();
      keys.add(String(key));
      itemKeys.set(itemId, keys);
    }
    void Promise.resolve()
      .then(() => i.approve(req, files, controller.signal))
      .catch(() => {
        controller.abort();
        auditDecline(req, files);
        emit({ kind: "stderr", text: "Codex approval callback failed; request declined" });
        return "decline" as const;
      })
      .then((decision) => {
        if (approvals.get(req.id)?.controller !== controller) return;
        approvals.delete(req.id);
        const supported =
          req.method === "item/commandExecution/requestApproval" ||
          req.method === "item/fileChange/requestApproval" ||
          (req.method === CODEX_MCP_ELICITATION && req.mcpCall !== undefined);
        if (!supported && decision !== "decline") auditDecline(req, files);
        answer(
          req,
          supported && !controller.signal.aborted && decision === "accept" ? "accept" : "decline",
        );
      });
  };

  transport.on((e) => {
    if (e.kind === "exit") {
      if (!closing && !checked) failed = true;
      finish();
      emit(failed ? { ...e, reason: CANNOT_START } : e);
    } else if (e.kind === "attached") {
      if (closing) return;
      replaying = false;
      if (e.awaiting && turnId === null) waitForStart();
      void checkThread()
        .then(() => {
          if (closing) return;
          checked = true;
          resolveReady();
          emit({
            kind: "attached",
            awaiting: turnId !== null || startDone !== null || outbox.size > 0,
          });
          for (const replay of replayRequests.values()) approve(replay.req, replay);
          replayRequests.clear();
          flush();
        })
        .catch(cannotStart);
    } else if (report()) emit(e);
  });
  transport.onLine((line) => {
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(m)) return;
    if (m.type === CODEX_DELIVERY && typeof m.id === "string") {
      if (outbox.has(m.id)) {
        const remaining = new Map(outbox);
        remaining.delete(m.id);
        try {
          saveOutbox(i.outboxPath, remaining);
        } catch (e) {
          cannotStart(e);
          return;
        }
        outbox.delete(m.id);
      }
      return;
    }
    if (rpcId(m.id) && typeof m.method !== "string") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error != null) p.reject(new SessionControlError("refused", "Codex request refused"));
      else {
        p.onSuccess?.();
        p.resolve(m.result);
      }
      return;
    }
    if (typeof m.method !== "string") return;
    const params = isObj(m.params) ? m.params : {};
    if (rpcId(m.id)) {
      const req: ApprovalRequest = { id: m.id, method: m.method, params: m.params };
      if (req.method === CODEX_MCP_ELICITATION) {
        const calls = [...mcpCalls.values()].filter(
          (call) =>
            call.server === params.serverName &&
            call.threadId === threadId &&
            call.turnId === turnId &&
            call.threadId === params.threadId &&
            call.turnId === params.turnId &&
            (params.itemId == null || call.itemId === params.itemId),
        );
        if (calls.length === 1) req.mcpCall = calls[0];
      }
      if ("threadId" in i && !checked && !closing) {
        const itemId = str(params.itemId);
        const key = params.approvalId ?? params.itemId;
        if (itemId !== null && rpcId(key)) {
          const keys = itemKeys.get(itemId) ?? new Set<string>();
          keys.add(String(key));
          itemKeys.set(itemId, keys);
        }
        replayRequests.set(req.id, {
          req,
          files: itemId === null ? undefined : paths.get(itemId),
          completed: false,
        });
        return;
      }
      const duplicate = seenRequests.has(req.id);
      seenRequests.add(req.id);
      if (closing || threadId === null || duplicate) {
        const prior = approvals.get(req.id);
        approvals.delete(req.id);
        prior?.controller.abort();
        const itemId = str(params.itemId);
        auditDecline(req, itemId === null ? undefined : paths.get(itemId));
        answer(req, "decline");
        return;
      }
      approve(req);
      return;
    }
    if (m.method === "turn/started" && isObj(params.turn)) {
      turnId = str(params.turn.id);
      if (turnId !== null) started?.resolve();
      if (report()) emit({ kind: "turn-start" });
    } else if (m.method === "turn/completed" && isObj(params.turn)) {
      if (uncertain || turnId === null || params.turn.id !== turnId) return;
      for (const replay of replayRequests.values()) replay.completed = true;
      cancelApprovals();
      paths.clear();
      mcpCalls.clear();
      itemKeys.clear();
      const completedId = str(params.turn.id);
      turnId = null;
      if (completedId !== null) {
        for (const wait of completions.get(completedId) ?? []) wait.resolve();
        completions.delete(completedId);
      }
      if (report())
        emit({
          kind: "result",
          isError: params.turn.status === "failed",
          stopReason: str(params.turn.status),
        });
    } else if (m.method === "item/started" && isObj(params.item)) {
      const item = params.item;
      if (
        item.type === "mcpToolCall" &&
        typeof item.id === "string" &&
        typeof item.server === "string" &&
        typeof item.tool === "string" &&
        typeof params.threadId === "string" &&
        typeof params.turnId === "string"
      ) {
        mcpCalls.set(item.id, {
          itemId: item.id,
          server: item.server,
          tool: item.tool,
          threadId: params.threadId,
          turnId: params.turnId,
        });
      }
      if (item.type === "fileChange" && typeof item.id === "string") {
        const files: string[] = [];
        let valid = Array.isArray(item.changes) && item.changes.length > 0;
        for (const change of Array.isArray(item.changes) ? item.changes : []) {
          if (!isObj(change) || typeof change.path !== "string") {
            valid = false;
            continue;
          }
          files.push(change.path);
          // PatchChangeKind.update carries move_path; also check a target at the change root.
          for (const move of [
            change.move_path,
            isObj(change.kind) ? change.kind.move_path : null,
          ]) {
            if (move == null) continue;
            if (typeof move === "string") files.push(move);
            else valid = false;
          }
        }
        paths.set(item.id, valid ? files : undefined);
      }
    } else if (m.method === "item/completed" && isObj(params.item)) {
      const item = params.item;
      if (typeof item.id === "string") {
        for (const replay of replayRequests.values()) {
          if (
            replay.req.mcpCall?.itemId === item.id ||
            (isObj(replay.req.params) && replay.req.params.itemId === item.id)
          )
            replay.completed = true;
        }
        cancelApprovals(item.id);
        if (item.type === "commandExecution" && !uncertain && report()) {
          for (const key of new Set([item.id, ...(itemKeys.get(item.id) ?? [])])) {
            emit({
              kind: "tool-result",
              toolUseId: key,
              ok: item.status === "completed" && item.exitCode === 0,
              exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
            });
          }
        }
        paths.delete(item.id);
        mcpCalls.delete(item.id);
        itemKeys.delete(item.id);
      }
    } else if (m.method === "thread/tokenUsage/updated" && isObj(params.tokenUsage)) {
      const usage = params.tokenUsage;
      totalTokens = isObj(usage.last) ? tokens(usage.last.totalTokens) : null;
      maxTokens = tokens(usage.modelContextWindow);
    } else if (m.method === "account/rateLimits/updated" && isObj(params.rateLimits)) {
      if (!report()) return;
      for (const window of [params.rateLimits.primary, params.rateLimits.secondary]) {
        if (isObj(window) && typeof window.usedPercent === "number" && window.usedPercent >= 100) {
          const reset = tokens(window.resetsAt);
          emit({
            kind: "rate-limit",
            status: "rejected",
            resetsAt: reset === null ? null : reset * 1000,
          });
        }
      }
    } else if (m.method === "serverRequest/resolved" && rpcId(params.requestId)) {
      replayRequests.delete(params.requestId);
      const approval = approvals.get(params.requestId);
      approvals.delete(params.requestId);
      approval?.controller.abort();
    }
  });

  const cannotStart = (e: unknown) => {
    if (closing) return;
    failed = true;
    const why = `${CANNOT_START}: ${e instanceof Error ? e.message : "Codex handshake failed"}`;
    i.log?.(why);
    emit({ kind: "stderr", text: why });
    finish();
    void transport.close();
  };
  const checkThread = async () => {
    const resumeId = "threadId" in i ? i.threadId : i.resumeThreadId;
    const result = await request(resumeId === null ? "thread/start" : "thread/resume", {
      ...(resumeId === null ? {} : { threadId: resumeId }),
      cwd: i.cwd,
      model: i.model,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      developerInstructions: i.developerInstructions,
      config: CODEX_PROJECT_DOC_CONFIG,
      ephemeral: false,
    });
    if (closing) return;
    if (
      !isObj(result) ||
      result.approvalPolicy !== "untrusted" ||
      result.approvalsReviewer !== "user" ||
      !isObj(result.activePermissionProfile) ||
      result.activePermissionProfile.id !== CODEX_SEAT_PROFILE ||
      !isObj(result.sandbox) ||
      result.sandbox.networkAccess !== false ||
      !Array.isArray(result.instructionSources) ||
      result.instructionSources.length !== 0 ||
      !isObj(result.thread) ||
      typeof result.thread.id !== "string" ||
      result.thread.id === "" ||
      (resumeId !== null && result.thread.id !== resumeId)
    )
      throw new Error("Codex thread did not confirm the seat floor");
    init(result.thread.id);
  };

  void (async () => {
    if ("threadId" in i) return;
    try {
      await transport.ready;
      if (closing || !transport.alive) return;
      await request("initialize", { clientInfo: { name: "mission_control", version: "1" } });
      transport.write({ method: "initialized" });
      await checkThread();
      if (closing) return;
      checked = true;
      resolveReady();
      flush();
    } catch (e) {
      cannotStart(e);
    } finally {
      resolveReady();
    }
  })();

  const send = (text: string) => {
    if (closing || !transport.alive) throw ended();
    const id = randomUUID();
    const saved = new Map(outbox).set(id, text);
    saveOutbox(i.outboxPath, saved);
    outbox.set(id, text);
    flush();
  };

  return {
    send,
    async control(subtype, opts) {
      await ready;
      if (closing || !transport.alive) throw ended();
      if (subtype === "get_context_usage") return { categories: [], totalTokens, maxTokens };
      if (subtype !== "interrupt")
        throw new SessionControlError("refused", "unsupported Codex control");
      while (startDone !== null) await startDone;
      if (closing || !transport.alive) throw ended();
      cancelApprovals();
      if (turnId === null) {
        opts?.onSuccess?.();
        return {};
      }
      const interruptedId = turnId;
      const completion = waitForEvent("turn/completed after interrupt");
      const waits = completions.get(interruptedId) ?? new Set();
      waits.add(completion);
      completions.set(interruptedId, waits);
      try {
        const [result] = await Promise.all([
          request("turn/interrupt", { threadId, turnId: interruptedId }, opts?.onSuccess),
          completion.promise,
        ]);
        return result;
      } finally {
        completion.reject(ended());
        waits.delete(completion);
        if (waits.size === 0) completions.delete(interruptedId);
      }
    },
    close() {
      finish();
      return transport.close();
    },
    detach() {
      finish(true);
      listeners.clear();
      transport.detach();
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get pid() {
      return transport.pid;
    },
    get alive() {
      return !closing && transport.alive;
    },
    ready,
    get lines() {
      return transport.lines;
    },
    get closeSent() {
      return transport.closeSent;
    },
  };
}
