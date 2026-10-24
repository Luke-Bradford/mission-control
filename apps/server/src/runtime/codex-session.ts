/** A Codex app-server thread over the same keeper transport as the Claude driver. */
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
import { type CrewSession, SessionControlError, startKeeperSession } from "./session.ts";

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
  approve: (
    req: { id: number | string; method: string; params: unknown },
    paths: readonly string[] | undefined,
    signal: AbortSignal,
  ) => Promise<"accept" | "decline">;
  command?: string;
  prepare?: (dir: string) => void;
  log?: (line: string) => void;
  controlTimeoutMs?: number;
  stopGraceMs?: number;
}

type RpcId = number | string;
type ApprovalRequest = Parameters<CodexSessionInput["approve"]>[0];
interface OpenApproval {
  controller: AbortController;
  itemId: string | null;
  req: ApprovalRequest;
  files: readonly string[] | undefined;
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
  const transport = startKeeperSession({
    ...i,
    command: i.command ?? CODEX_COMMAND,
    cliSessionId: i.marker,
    turnEnd: "codex",
  });
  const listeners = new Set<(e: SessionEvent) => void>();
  const pending = new Map<RpcId, Pending>();
  const seenRequests = new Set<RpcId>();
  const approvals = new Map<RpcId, OpenApproval>();
  const paths = new Map<string, readonly string[] | undefined>();
  const itemKeys = new Map<string, Set<string>>();
  const queued: string[] = [];
  let nextId = 0;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let closing = false;
  let uncertain = false;
  let starts = 0;
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
  const request = (method: string, params: unknown, onSuccess?: () => void): Promise<unknown> => {
    if (closing || !transport.alive) return Promise.reject(ended());
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new SessionControlError("timeout", `${method} timeout`));
      }, i.controlTimeoutMs ?? CONTROL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, onSuccess });
      try {
        transport.write({ id, method, params }, method === "turn/start");
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  };
  const answer = (id: RpcId, decision: "accept" | "decline") => {
    try {
      transport.write({ id, result: { decision } });
    } catch {
      // The process may already be gone.
    }
  };
  const auditDecline = (req: ApprovalRequest, files: readonly string[] | undefined) => {
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
      answer(id, "decline");
    }
  };
  const finish = () => {
    cancelApprovals();
    closing = true;
    queued.length = 0;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(ended());
    }
    pending.clear();
    resolveReady();
  };
  const startTurn = (text: string) => {
    starts++;
    void request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      effort: i.effort,
    }).then(
      () => {
        starts--;
      },
      (e: unknown) => {
        starts--;
        if (closing) return;
        emit({ kind: "stderr", text: e instanceof Error ? e.message : "turn/start failed" });
        if (e instanceof SessionControlError && e.kind === "refused") {
          emit({ kind: "turn-refused", active: turnId !== null || starts > 0 });
        } else {
          // A lost acknowledgement says nothing about execution. Keep every hold until exit,
          // even if completion notifications arrive while the keeper is terminating the process.
          uncertain = true;
          finish();
          void transport.close();
        }
      },
    );
  };
  const init = (id: string) => {
    if (threadId !== null) return;
    threadId = id;
    emit({ kind: "init", sessionId: id, model: i.model });
  };

  transport.on((e) => {
    if (e.kind === "exit") {
      if (!closing && threadId === null) failed = true;
      finish();
      emit(failed ? { ...e, reason: CANNOT_START } : e);
    } else emit(e);
  });
  transport.onLine((line) => {
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(m)) return;
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
      const req = { id: m.id, method: m.method, params: m.params };
      const duplicate = seenRequests.has(req.id);
      seenRequests.add(req.id);
      if (closing || threadId === null || duplicate) {
        const prior = approvals.get(req.id);
        approvals.delete(req.id);
        prior?.controller.abort();
        const itemId = str(params.itemId);
        auditDecline(req, itemId === null ? undefined : paths.get(itemId));
        answer(req.id, "decline");
        return;
      }
      const controller = new AbortController();
      const itemId = str(params.itemId);
      const files = itemId === null ? undefined : paths.get(itemId);
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
            req.method === "item/fileChange/requestApproval";
          if (!supported && decision !== "decline") auditDecline(req, files);
          answer(
            req.id,
            supported && !controller.signal.aborted && decision === "accept" ? "accept" : "decline",
          );
        });
      return;
    }
    if (m.method === "turn/started" && isObj(params.turn)) {
      turnId = str(params.turn.id);
      emit({ kind: "turn-start" });
    } else if (m.method === "turn/completed" && isObj(params.turn)) {
      if (uncertain) return;
      cancelApprovals();
      paths.clear();
      itemKeys.clear();
      turnId = null;
      emit({
        kind: "result",
        isError: params.turn.status === "failed",
        stopReason: str(params.turn.status),
      });
    } else if (m.method === "item/started" && isObj(params.item)) {
      const item = params.item;
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
        cancelApprovals(item.id);
        if (item.type === "commandExecution" && !uncertain) {
          for (const key of new Set([item.id, ...(itemKeys.get(item.id) ?? [])])) {
            emit({ kind: "tool-result", toolUseId: key });
          }
        }
        paths.delete(item.id);
        itemKeys.delete(item.id);
      }
    } else if (m.method === "thread/tokenUsage/updated" && isObj(params.tokenUsage)) {
      const usage = params.tokenUsage;
      totalTokens = isObj(usage.last) ? tokens(usage.last.totalTokens) : null;
      maxTokens = tokens(usage.modelContextWindow);
    } else if (m.method === "account/rateLimits/updated" && isObj(params.rateLimits)) {
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
      const approval = approvals.get(params.requestId);
      approvals.delete(params.requestId);
      approval?.controller.abort();
    }
  });

  void (async () => {
    try {
      await transport.ready;
      if (closing || !transport.alive) return;
      await request("initialize", { clientInfo: { name: "mission_control", version: "1" } });
      transport.write({ method: "initialized" });
      const result = await request(i.resumeThreadId === null ? "thread/start" : "thread/resume", {
        ...(i.resumeThreadId === null ? {} : { threadId: i.resumeThreadId }),
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
        result.thread.id === ""
      ) {
        throw new Error("Codex thread did not confirm the seat floor");
      }
      init(result.thread.id);
      resolveReady();
      for (const text of queued.splice(0)) startTurn(text);
    } catch (e) {
      if (!closing) {
        failed = true;
        const why = `${CANNOT_START}: ${e instanceof Error ? e.message : "Codex handshake failed"}`;
        i.log?.(why);
        emit({ kind: "stderr", text: why });
        finish();
        void transport.close();
      }
    } finally {
      resolveReady();
    }
  })();

  return {
    send(text) {
      if (closing || !transport.alive) throw ended();
      if (threadId === null) queued.push(text);
      else startTurn(text);
    },
    async control(subtype, opts) {
      await ready;
      if (closing || !transport.alive) throw ended();
      if (subtype === "get_context_usage") return { categories: [], totalTokens, maxTokens };
      if (subtype !== "interrupt")
        throw new SessionControlError("refused", "unsupported Codex control");
      cancelApprovals();
      if (turnId === null) {
        opts?.onSuccess?.();
        return {};
      }
      return request("turn/interrupt", { threadId, turnId }, opts?.onSuccess);
    },
    close() {
      finish();
      return transport.close();
    },
    detach() {
      finish();
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
