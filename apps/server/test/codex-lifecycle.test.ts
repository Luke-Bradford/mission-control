import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANNOT_START, MC_MCP_SERVER, MC_TOOL_NAMES, type SessionEvent } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachCodexSession,
  CODEX_MCP_ELICITATION,
  CODEX_OUTBOX_FILE,
  type CodexSessionInput,
} from "../src/runtime/codex-session.ts";
import { CODEX_DELIVERY } from "../src/runtime/keeper.ts";
import type { KeeperSession } from "../src/runtime/session.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-codex-lifecycle-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function attached(approve = vi.fn<CodexSessionInput["approve"]>(async () => "accept"), from = 0) {
  let count = 0;
  let alive = true;
  const listeners = new Set<(e: SessionEvent) => void>();
  const lines = new Set<(line: string) => void>();
  const write = vi.fn();
  const transport: KeeperSession = {
    write,
    send: vi.fn(),
    control: vi.fn(),
    close: vi.fn(async () => {
      alive = false;
      for (const fn of listeners) fn({ kind: "exit", code: 0, signal: null });
      return 0;
    }),
    detach: vi.fn(),
    on(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    onLine(fn) {
      lines.add(fn);
      return () => {
        lines.delete(fn);
      };
    },
    pid: 1,
    get alive() {
      return alive;
    },
    ready: Promise.resolve(),
    get lines() {
      return count;
    },
    closeSent: Promise.resolve(),
  };
  const session = attachCodexSession(
    {
      from,
      threadId: "thread",
      outboxPath: join(dir, CODEX_OUTBOX_FILE),
      model: "gpt-5.4",
      effort: "high",
      cwd: "/work",
      developerInstructions: "Hub instructions",
      approve,
      controlTimeoutMs: 100,
    },
    transport,
  );
  const events: SessionEvent[] = [];
  session.on((e) => events.push(e));
  const respondFloor = (result: unknown = floor()) => {
    const check = write.mock.calls.findLast(([m]) => m.method === "thread/resume")?.[0];
    if (!check) throw new Error("missing floor check");
    for (const fn of lines) fn(JSON.stringify({ id: check.id, result }));
  };
  return {
    respondFloor,
    session,
    approve,
    write,
    events,
    line(message: unknown) {
      count++;
      for (const fn of lines) fn(JSON.stringify(message));
    },
    caughtUp(validate = true, awaiting = false) {
      for (const fn of listeners) fn({ kind: "attached", awaiting });
      if (validate) respondFloor();
    },
  };
}
const floor = (): Record<string, unknown> => ({
  thread: { id: "thread" },
  approvalPolicy: "untrusted",
  approvalsReviewer: "user",
  activePermissionProfile: { id: "mc_seat" },
  sandbox: { networkAccess: false },
  instructionSources: [],
});
const request = (id: string | number, itemId = "item") => ({
  id,
  method: "item/commandExecution/requestApproval",
  params: { itemId, approvalId: `key-${id}` },
});
const started = { method: "turn/started", params: { turn: { id: "turn" } } };
const settled = () => vi.waitFor(() => {}, { interval: 1 });

const mcpStarted = (id = "mcp") => ({
  method: "item/started",
  params: {
    threadId: "thread",
    turnId: "turn",
    item: { id, type: "mcpToolCall", server: MC_MCP_SERVER, tool: MC_TOOL_NAMES.commit },
  },
});
const mcpRequest = () => ({
  id: "elicitation",
  method: CODEX_MCP_ELICITATION,
  params: {
    threadId: "thread",
    turnId: "turn",
    serverName: MC_MCP_SERVER,
    mode: "form",
    requestedSchema: { type: "object", properties: {} },
  },
});

describe("Codex lifecycle without a socket", () => {
  it.each([false, true])(
    "correlates MCP elicitations with their active tool, including replay (%s)",
    async (replay) => {
      const h = attached();
      if (!replay) {
        h.caughtUp();
        await h.session.ready;
      }
      h.line(started);
      h.line(mcpStarted());
      h.line(mcpRequest());
      if (replay) {
        expect(h.approve).not.toHaveBeenCalled();
        h.caughtUp();
      }
      await vi.waitFor(() =>
        expect(h.write).toHaveBeenCalledWith({
          id: "elicitation",
          result: { action: "accept", content: {} },
        }),
      );
      expect(h.approve).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpCall: expect.objectContaining({
            itemId: "mcp",
            server: MC_MCP_SERVER,
            tool: MC_TOOL_NAMES.commit,
          }),
        }),
        undefined,
        expect.any(AbortSignal),
      );
      h.session.detach();
    },
  );

  it.each(["missing", "ambiguous", "completed", "wrong turn", "wrong thread", "foreign server"])(
    "declines %s MCP correlation even if the callback accepts",
    async (kind) => {
      const h = attached();
      h.caughtUp();
      await h.session.ready;
      h.line(started);
      if (kind !== "missing") h.line(mcpStarted());
      if (kind === "ambiguous") h.line(mcpStarted("other"));
      if (kind === "completed")
        h.line({ method: "item/completed", params: { item: { id: "mcp", type: "mcpToolCall" } } });
      const req = mcpRequest();
      if (kind === "wrong turn") req.params.turnId = "other";
      if (kind === "wrong thread") req.params.threadId = "other";
      if (kind === "foreign server") req.params.serverName = "other";
      h.line(req);
      await vi.waitFor(() =>
        expect(h.write).toHaveBeenCalledWith({
          id: "elicitation",
          result: { action: "decline", content: null },
        }),
      );
      expect(h.approve.mock.calls[0]?.[0].mcpCall).toBeUndefined();
      h.session.detach();
    },
  );

  it.each([false, true])(
    "declines a completed MCP approval with the elicitation response shape (replay: %s)",
    async (replay) => {
      let resolve: (decision: "accept") => void = () => {};
      const approve = vi.fn<CodexSessionInput["approve"]>(async (_req, _paths, signal) => {
        if (signal.aborted) return "decline";
        return new Promise<"accept">((done) => {
          resolve = done;
        });
      });
      const h = attached(approve);
      if (!replay) {
        h.caughtUp();
        await h.session.ready;
      }
      h.line(started);
      h.line(mcpStarted());
      h.line(mcpRequest());
      if (!replay) await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
      h.line({ method: "item/completed", params: { item: { id: "mcp", type: "mcpToolCall" } } });
      if (replay) h.caughtUp();
      resolve("accept");
      await vi.waitFor(() =>
        expect(h.write).toHaveBeenCalledWith({
          id: "elicitation",
          result: { action: "decline", content: null },
        }),
      );
      expect(h.write).not.toHaveBeenCalledWith({
        id: "elicitation",
        result: { action: "accept", content: {} },
      });
      h.session.detach();
    },
  );

  it("waits for replay, then checks only unresolved requests and remembers rename paths", async () => {
    const h = attached();
    h.line(started);
    h.line(request(1));
    h.line({ method: "serverRequest/resolved", params: { requestId: 1 } });
    h.line({
      method: "item/started",
      params: {
        item: {
          id: "edit",
          type: "fileChange",
          changes: [{ path: "apps/a.ts", kind: { type: "update", move_path: "outside.ts" } }],
        },
      },
    });
    h.line({ id: "open", method: "item/fileChange/requestApproval", params: { itemId: "edit" } });
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    h.caughtUp();
    await h.session.ready;
    await vi.waitFor(() => expect(h.write).toHaveBeenCalledTimes(2));
    expect(h.approve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "open" }),
      ["apps/a.ts", "outside.ts"],
      expect.any(AbortSignal),
    );
    expect(h.write).toHaveBeenCalledWith({ id: "open", result: { decision: "accept" } });
    h.session.detach();
  });

  it("declines an unresolved replay when the guard declines, and rechecks a reused resolved id", async () => {
    const approve = vi.fn<CodexSessionInput["approve"]>(async () => "decline");
    const h = attached(approve);
    h.line(request("same"));
    h.line({ method: "serverRequest/resolved", params: { requestId: "same" } });
    h.line(request("same", "new-item"));
    h.caughtUp();
    await vi.waitFor(() =>
      expect(h.write).toHaveBeenCalledWith({ id: "same", result: { decision: "decline" } }),
    );
    expect(approve).toHaveBeenCalledTimes(1);
    h.session.detach();
  });

  it("releases a resolved approval's restored lock when its item completes after the cursor", async () => {
    const h = attached(undefined, 3);
    h.line(started);
    h.line(request("resolved"));
    h.line({ method: "serverRequest/resolved", params: { requestId: "resolved" } });
    expect(h.events).toEqual([]);
    h.line({
      method: "item/completed",
      params: { item: { id: "item", type: "commandExecution" } },
    });
    h.caughtUp();
    await h.session.ready;
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.events).toContainEqual({ kind: "tool-result", toolUseId: "key-resolved", ok: false });
    h.session.detach();
  });

  it("does not answer or cancel the server's request when the hub detaches", async () => {
    let decide: (decision: "accept") => void = () => {};
    const approve = vi.fn<CodexSessionInput["approve"]>(
      () =>
        new Promise((r) => {
          decide = r;
        }),
    );
    const h = attached(approve);
    h.line(request("waiting"));
    h.caughtUp();
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    h.session.detach();
    expect(approve.mock.calls[0]?.[2].aborted).toBe(true);
    decide("accept");
    await settled();
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("steers mid-turn, interrupts then starts, and starts directly between turns", async () => {
    const h = attached();
    h.line(started);
    h.caughtUp();
    await h.session.ready;
    h.session.send("steer");
    const steer = h.write.mock.calls.at(-1)?.[0];
    expect(steer).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "thread",
        expectedTurnId: "turn",
        input: [{ type: "text", text: "steer" }],
      },
    });
    h.line({ id: steer.id, result: {} });
    const interrupt = h.session.control("interrupt");
    await vi.waitFor(() => expect(h.write.mock.calls.at(-1)?.[0].method).toBe("turn/interrupt"));
    h.line({ id: h.write.mock.calls.at(-1)?.[0].id, result: {} });
    h.line({ method: "turn/completed", params: { turn: { id: "turn", status: "interrupted" } } });
    await interrupt;
    h.session.send("replacement");
    expect(h.write.mock.calls.at(-1)?.[0]).toMatchObject({
      method: "turn/start",
      params: { threadId: "thread", effort: "high" },
    });
    h.line({ id: h.write.mock.calls.at(-1)?.[0].id, result: {} });
    h.session.detach();
  });

  it("keeps approval-id lock keys through replay until item completion", async () => {
    const h = attached();
    h.line(started);
    h.line(request("open"));
    h.caughtUp();
    await vi.waitFor(() => expect(h.write).toHaveBeenCalledTimes(2));
    h.line({
      method: "item/completed",
      params: { item: { id: "item", type: "commandExecution" } },
    });
    expect(h.events).toContainEqual({ kind: "tool-result", toolUseId: "key-open", ok: false });
    h.session.detach();
  });
});

describe("Codex reattachment floor", () => {
  it("withholds readiness, sends and approvals until the live floor is checked", async () => {
    const h = attached();
    h.line(started);
    h.line(request("pending"));
    h.session.send("queued steer");
    let ready = false;
    void h.session.ready.then(() => {
      ready = true;
    });
    h.caughtUp(false);
    await settled();
    expect(ready).toBe(false);
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.write.mock.calls.map(([m]) => m.method)).toEqual(["thread/resume"]);
    expect(h.write.mock.calls[0]?.[0].params).toEqual({
      threadId: "thread",
      cwd: "/work",
      model: "gpt-5.4",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      developerInstructions: "Hub instructions",
      config: { project_doc_max_bytes: 0 },
      ephemeral: false,
    });
    h.respondFloor();
    await h.session.ready;
    await vi.waitFor(() => expect(h.approve).toHaveBeenCalledTimes(1));
    expect(h.write.mock.calls.some(([m]) => m.method === "turn/steer")).toBe(true);
    h.session.detach();
  });

  for (const field of [
    "approvalPolicy",
    "approvalsReviewer",
    "activePermissionProfile",
    "activePermissionProfile.id",
    "sandbox",
    "sandbox.networkAccess",
    "instructionSources",
    "thread",
    "thread.id",
  ]) {
    it.each(["absent", "null", "wrong"])(
      `closes before sending or approving when live ${field} is %s`,
      async (shape) => {
        const h = attached();
        h.line(request("pending"));
        h.session.send("must not run");
        h.caughtUp(false);
        const result = floor();
        const parts = field.split(".");
        const key = parts.pop() as string;
        const parent = parts.reduce((p, k) => p[k] as Record<string, unknown>, result);
        if (shape === "absent") delete parent[key];
        else parent[key] = shape === "null" ? null : 42;
        h.respondFloor(result);
        await h.session.ready;
        expect(h.session.alive).toBe(false);
        expect(h.events).toContainEqual(
          expect.objectContaining({ kind: "exit", reason: CANNOT_START }),
        );
        expect(h.events.some((e) => e.kind === "attached")).toBe(false);
        expect(h.write.mock.calls.some(([m]) => m.method?.startsWith("turn/"))).toBe(false);
        expect(h.write.mock.calls.some(([m]) => m.result?.decision === "accept")).toBe(false);
        expect(h.approve).not.toHaveBeenCalled();
      },
    );
  }

  it.each([
    { approvalPolicy: "never" },
    { approvalsReviewer: "guardian_subagent" },
    { activePermissionProfile: { id: "other" } },
    { sandbox: { networkAccess: true } },
    { instructionSources: ["AGENTS.md"] },
    { thread: { id: "other" } },
  ])("refuses mismatched floor values %j", async (bad) => {
    const h = attached();
    h.caughtUp(false);
    h.respondFloor({ ...floor(), ...bad });
    await h.session.ready;
    expect(h.session.alive).toBe(false);
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: "exit", reason: CANNOT_START }),
    );
  });

  it("closes on a missing live floor response", async () => {
    const h = attached();
    h.caughtUp(false);
    await h.session.ready;
    expect(h.session.alive).toBe(false);
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: "exit", reason: CANNOT_START }),
    );
  });

  it.each(["item", "turn"])(
    "rechecks unresolved replay approvals even after %s completion",
    async (completion) => {
      const h = attached();
      h.line(started);
      h.line({
        method: "item/started",
        params: { item: { id: "edit", type: "fileChange", changes: [{ path: "apps/a.ts" }] } },
      });
      h.line({ id: "open", method: "item/fileChange/requestApproval", params: { itemId: "edit" } });
      h.line(
        completion === "item"
          ? { method: "item/completed", params: { item: { id: "edit", type: "fileChange" } } }
          : { method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } },
      );
      h.caughtUp();
      await vi.waitFor(() => expect(h.approve).toHaveBeenCalledTimes(1));
      expect(h.approve.mock.calls[0]?.[1]).toEqual(["apps/a.ts"]);
      expect(h.approve.mock.calls[0]?.[2].aborted).toBe(true);
      await vi.waitFor(() =>
        expect(h.write).toHaveBeenCalledWith({ id: "open", result: { decision: "decline" } }),
      );
      h.session.detach();
    },
  );
});

describe("Codex turn sequencing", () => {
  it("queues a second send until the first start is acknowledged and announced", async () => {
    const h = attached();
    h.caughtUp();
    await h.session.ready;
    h.session.send("first");
    const start = h.write.mock.calls.at(-1)?.[0];
    h.line({ id: start.id, result: { turn: { id: "turn" } } });
    await settled();
    h.session.send("second");
    expect(h.write.mock.calls.filter(([m]) => m.method === "turn/start")).toHaveLength(1);
    expect(h.write.mock.calls.some(([m]) => m.method === "turn/steer")).toBe(false);
    h.line(started);
    await vi.waitFor(() =>
      expect(h.write.mock.calls.at(-1)?.[0]).toMatchObject({
        method: "turn/steer",
        params: { expectedTurnId: "turn", input: [{ type: "text", text: "second" }] },
      }),
    );
    h.session.detach();
  });

  it("waits for matching completion independently of interrupt acknowledgement", async () => {
    const h = attached();
    h.line(started);
    h.caughtUp();
    await h.session.ready;
    let done = false;
    const interrupt = h.session.control("interrupt").then(() => {
      done = true;
      h.session.send("replacement");
    });
    await vi.waitFor(() => expect(h.write.mock.calls.at(-1)?.[0].method).toBe("turn/interrupt"));
    h.line({ id: h.write.mock.calls.at(-1)?.[0].id, result: {} });
    await settled();
    expect(done).toBe(false);
    h.line({
      method: "turn/completed",
      params: { turn: { id: "unrelated", status: "completed" } },
    });
    expect(h.events.some((e) => e.kind === "result")).toBe(false);
    expect(h.write.mock.calls.some(([m]) => m.method === "turn/start")).toBe(false);
    h.line({ method: "turn/completed", params: { turn: { id: "turn", status: "interrupted" } } });
    await interrupt;
    expect(h.write.mock.calls.at(-1)?.[0].method).toBe("turn/start");
    h.line({ method: "turn/completed", params: { turn: { id: "turn", status: "interrupted" } } });
    expect(h.events.filter((e) => e.kind === "result")).toHaveLength(1);
    h.line(started);
    h.line({ id: h.write.mock.calls.at(-1)?.[0].id, result: {} });
    h.session.detach();
  });

  it.each(["refusal", "ack timeout", "completion timeout"])(
    "rejects interruption on %s without a replacement",
    async (failure) => {
      const h = attached();
      h.line(started);
      h.caughtUp();
      await h.session.ready;
      const interrupt = h.session.control("interrupt");
      const rejected = expect(interrupt).rejects.toMatchObject({
        kind: failure === "refusal" ? "refused" : "timeout",
      });
      await vi.waitFor(() => expect(h.write.mock.calls.at(-1)?.[0].method).toBe("turn/interrupt"));
      const id = h.write.mock.calls.at(-1)?.[0].id;
      if (failure === "refusal") h.line({ id, error: { message: "no" } });
      if (failure === "completion timeout") h.line({ id, result: {} });
      await rejected;
      expect(
        h.write.mock.calls.some(([m]) => m.method === "turn/start" || m.method === "turn/steer"),
      ).toBe(false);
      h.session.detach();
    },
  );
});

describe("Codex pending work across reattachment", () => {
  it("waits for a pending start before steering or interrupting", async () => {
    const h = attached();
    h.caughtUp(true, true);
    await h.session.ready;
    expect(h.events).toContainEqual({ kind: "attached", awaiting: true });
    h.session.send("steer after restart");
    const interrupted = vi.fn();
    const interrupt = h.session.control("interrupt").then(interrupted);
    await settled();
    expect(h.write.mock.calls.map(([m]) => m.method)).toEqual(["thread/resume"]);
    expect(interrupted).not.toHaveBeenCalled();
    h.line(started);
    await vi.waitFor(() =>
      expect(h.write.mock.calls.map(([m]) => m.method)).toEqual([
        "thread/resume",
        "turn/steer",
        "turn/interrupt",
      ]),
    );
    const steer = h.write.mock.calls.find(([m]) => m.method === "turn/steer")?.[0];
    expect(steer.params.expectedTurnId).toBe("turn");
    h.line({ id: steer.id, result: {} });
    h.line({ id: h.write.mock.calls.at(-1)?.[0].id, result: {} });
    h.line({ method: "turn/completed", params: { turn: { id: "turn", status: "interrupted" } } });
    await interrupt;
    h.session.detach();
  });

  it("closes within the control timeout if the pending start never identifies its turn", async () => {
    const h = attached();
    h.caughtUp(true, true);
    await h.session.ready;
    h.session.send("must not start another turn");
    await expect(h.session.control("interrupt")).rejects.toMatchObject({ kind: "ended" });
    expect(h.session.alive).toBe(false);
    expect(h.events).toContainEqual({ kind: "stderr", text: "turn/started timeout" });
    expect(h.write.mock.calls.map(([m]) => m.method)).toEqual(["thread/resume"]);
  });

  it("persists queued messages before returning, replays receipts and delivers only the unsent text", async () => {
    const first = attached();
    first.caughtUp();
    await first.session.ready;
    first.session.send("first");
    first.session.send("second");
    const start = first.write.mock.calls.at(-1)?.[0];
    const outboxPath = join(dir, CODEX_OUTBOX_FILE);
    expect(JSON.parse(readFileSync(outboxPath, "utf8")).map((entry: string[]) => entry[1])).toEqual(
      ["first", "second"],
    );
    first.session.detach();
    // The keeper accepted the first start while the hub was away; its receipt is replayed.
    const next = attached();
    next.line({ type: CODEX_DELIVERY, id: start.id });
    next.line({ id: start.id, result: {} });
    next.caughtUp(true, true);
    await next.session.ready;
    expect(next.write.mock.calls.map(([m]) => m.method)).toEqual(["thread/resume"]);
    next.line(started);
    await vi.waitFor(() => expect(next.write.mock.calls.at(-1)?.[0].method).toBe("turn/steer"));
    const steer = next.write.mock.calls.at(-1)?.[0];
    expect(steer.params).toMatchObject({
      expectedTurnId: "turn",
      input: [{ type: "text", text: "second" }],
    });
    next.line({ type: CODEX_DELIVERY, id: steer.id });
    next.line({ id: steer.id, result: {} });
    expect(JSON.parse(readFileSync(outboxPath, "utf8"))).toEqual([]);
    next.session.detach();
    const again = attached();
    again.line(started);
    again.caughtUp();
    await again.session.ready;
    expect(again.write.mock.calls.map(([m]) => m.method)).toEqual(["thread/resume"]);
    again.session.detach();
  });

  it("recovers a message detached before it reached the keeper", async () => {
    const first = attached();
    first.session.send("unsent before readiness");
    first.session.detach();
    const next = attached();
    next.caughtUp();
    await next.session.ready;
    expect(next.write.mock.calls.at(-1)?.[0]).toMatchObject({
      method: "turn/start",
      params: { input: [{ type: "text", text: "unsent before readiness" }] },
    });
    next.session.detach();
  });

  it("does not accept a message when its outbox cannot be persisted", async () => {
    const h = attached();
    h.caughtUp();
    await h.session.ready;
    rmSync(dir, { recursive: true });
    expect(() => h.session.send("must not be acknowledged")).toThrow();
    expect(h.write.mock.calls.map(([m]) => m.method)).toEqual(["thread/resume"]);
    h.session.detach();
  });

  it("refuses a corrupted outbox instead of dropping its messages", () => {
    writeFileSync(join(dir, CODEX_OUTBOX_FILE), JSON.stringify([42]));
    expect(() => attached()).toThrow("invalid Codex outbox");
  });
});
