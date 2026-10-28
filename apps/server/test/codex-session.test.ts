import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANNOT_START,
  codexCommand,
  MC_MCP_SERVER,
  MC_TOOL_NAMES,
  type SessionEvent,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestLock } from "../src/guard/lock.ts";
import { createCodexApprover } from "../src/runtime/codex-approval.ts";
import {
  attachCodexSession,
  CODEX_MCP_ELICITATION,
  CODEX_OUTBOX_FILE,
  type CodexAttachInput,
  type CodexSessionInput,
  startCodexSession,
} from "../src/runtime/codex-session.ts";
import { attachSession, type CrewSession } from "../src/runtime/session.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const KEEPER = fileURLToPath(new URL("../src/runtime/keeper-cli.ts", import.meta.url));
let dir: string;
const sessions: CrewSession[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-cx-")));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  rmSync(dir, { recursive: true, force: true });
});
const until = (fn: () => unknown) => vi.waitFor(fn, { timeout: 5000, interval: 10 });
const recorded = () =>
  existsSync(join(dir, "record"))
    ? readFileSync(join(dir, "record"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
function start(scenario: Record<string, unknown> = {}, over: Partial<CodexSessionInput> = {}) {
  const events: SessionEvent[] = [];
  const approve = vi.fn<CodexSessionInput["approve"]>(async () => "accept");
  const session = startCodexSession({
    command: process.execPath,
    args: [FAKE],
    cwd: dir,
    env: { FAKE_CODEX_RECORD: join(dir, "record"), FAKE_CODEX_SCENARIO: JSON.stringify(scenario) },
    transcriptPath: join(dir, "transcript"),
    node: process.execPath,
    entry: KEEPER,
    dir: join(dir, "k"),
    spawn: "spawn-1",
    marker: FAKE,
    model: "gpt-5.4",
    effort: "high",
    developerInstructions: "Hub instructions",
    resumeThreadId: null,
    outboxPath: join(dir, CODEX_OUTBOX_FILE),
    approve,
    stopGraceMs: 100,
    controlTimeoutMs: 1000,
    ...over,
  });
  sessions.push(session);
  session.on((e) => events.push(e));
  return { session, events, approve };
}

async function reattach(over: Partial<CodexAttachInput> = {}) {
  const found = await attachSession({
    dir: join(dir, "k"),
    from: () => 0,
    raw: true,
    stopGraceMs: 100,
  });
  if (found.kind !== "attached") throw new Error("keeper did not survive detach");
  const session = attachCodexSession(
    {
      from: 0,
      threadId: "codex-thread-1",
      cwd: dir,
      developerInstructions: "Hub instructions",
      model: "gpt-5.4",
      effort: "high",
      approve: async () => "decline",
      outboxPath: join(dir, CODEX_OUTBOX_FILE),
      controlTimeoutMs: 1000,
      ...over,
    },
    found.session,
  );
  const events: SessionEvent[] = [];
  session.on((e) => events.push(e));
  sessions.push(session);
  await session.ready;
  return { session, events };
}

describe("Codex session", () => {
  it("queues send until the checked handshake, then reports a turn and context usage", async () => {
    const { session, events } = start();
    session.send(
      JSON.stringify({
        usage: {
          total: { totalTokens: 9000 },
          last: { totalTokens: 1234 },
          modelContextWindow: 10000,
        },
        stderr: "diagnostic",
      }),
    );
    await session.ready;
    await until(() => expect(events.some((e) => e.kind === "result")).toBe(true));
    const messages = recorded().filter((m) => m.method);
    expect(messages.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(messages[2].params).toEqual({
      cwd: dir,
      model: "gpt-5.4",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      developerInstructions: "Hub instructions",
      config: { project_doc_max_bytes: 0 },
      ephemeral: false,
    });
    const usage = readFileSync(join(dir, "transcript"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((m) => m.method === "thread/tokenUsage/updated");
    expect(Number.isFinite(Date.parse(usage.timestamp))).toBe(true);
    expect(messages[3].params).toMatchObject({ threadId: "codex-thread-1", effort: "high" });
    expect(events.filter((e) => ["init", "turn-start", "result"].includes(e.kind))).toEqual([
      { kind: "init", sessionId: "codex-thread-1", model: "gpt-5.4" },
      { kind: "turn-start" },
      { kind: "result", isError: false, stopReason: "completed" },
    ]);
    expect(events).toContainEqual({ kind: "stderr", text: "diagnostic" });
    expect(events.filter((e) => e.kind === "output").length).toBeGreaterThan(3);
    expect(await session.control("get_context_usage")).toEqual({
      categories: [],
      totalTokens: 1234,
      maxTokens: 10000,
    });
  });

  it.each([
    "approvalPolicy",
    "approvalsReviewer",
    "activePermissionProfile",
    "sandboxType",
    "networkAccess",
    "instructionSources",
  ])("closes before the first turn when %s does not confirm the floor", async (bad) => {
    const { session, events } = start({ bad });
    session.send("must never run");
    await session.ready;
    await until(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "exit", reason: CANNOT_START }),
      ),
    );
    expect(session.alive).toBe(false);
    expect(events.some((e) => e.kind === "init")).toBe(false);
    expect(recorded().some((m) => m.method === "turn/start")).toBe(false);
  });

  it("does not treat the old fixture's permissionProfile as confirmation", async () => {
    const { session, events } = start({ legacyPermissionProfile: true });
    session.send("must never run");
    await session.ready;
    await session.close();
    expect(events).toContainEqual(expect.objectContaining({ kind: "exit", reason: CANNOT_START }));
    expect(recorded().some((m) => m.method === "turn/start")).toBe(false);
  });

  it("ends a timed-out handshake without sending the queued turn", async () => {
    const { session, events } = start({ noInitialize: true }, { controlTimeoutMs: 100 });
    session.send("wait");
    await session.ready;
    await until(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "exit", reason: CANNOT_START }),
      ),
    );
    expect(recorded().some((m) => m.method === "turn/start")).toBe(false);
  });

  it("reports failed turns and turn/start errors", async () => {
    const { session, events } = start();
    session.send(JSON.stringify({ failed: true }));
    await until(() =>
      expect(events).toContainEqual({ kind: "result", isError: true, stopReason: "failed" }),
    );
    session.send(JSON.stringify({ turnError: true }));
    await until(() => expect(events).toContainEqual({ kind: "turn-refused", active: false }));
    expect(events.filter((e) => e.kind === "result")).toHaveLength(1);
  });

  it("uses unknown context values until Codex supplies them and reports only exhausted rate windows", async () => {
    const { session, events } = start();
    await session.ready;
    expect(await session.control("get_context_usage")).toEqual({
      categories: [],
      totalTokens: null,
      maxTokens: null,
    });
    session.send(
      JSON.stringify({
        rateLimits: {
          primary: { usedPercent: 99 },
          secondary: { usedPercent: 100, resetsAt: 123 },
        },
      }),
    );
    await until(() => expect(events.some((e) => e.kind === "result")).toBe(true));
    expect(events.filter((e) => e.kind === "rate-limit")).toEqual([
      { kind: "rate-limit", status: "rejected", resetsAt: 123000 },
    ]);
  });

  it("remembers every file and rename target, failing closed on unknown paths", async () => {
    const { session, events, approve } = start();
    session.send(
      JSON.stringify({
        changes: [{ path: "apps/a.ts", kind: { type: "update", move_path: "outside.ts" } }],
      }),
    );
    await until(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve.mock.calls[0]?.[1]).toEqual(["apps/a.ts", "outside.ts"]);
    // A send during the current turn steers it; each path case needs a fresh turn.
    await until(() => expect(events.filter((e) => e.kind === "result")).toHaveLength(1));
    session.send(JSON.stringify({ changes: [{ path: "apps/b.ts" }], missingPaths: true }));
    await until(() => expect(approve).toHaveBeenCalledTimes(2));
    expect(approve.mock.calls[1]?.[1]).toBeUndefined();
    await until(() => expect(events.filter((e) => e.kind === "result")).toHaveLength(2));
    session.send(JSON.stringify({ changes: [{ path: "apps/a.ts" }, { kind: "add" }] }));
    await until(() => expect(approve).toHaveBeenCalledTimes(3));
    expect(approve.mock.calls[2]?.[1]).toBeUndefined();
    await until(() => expect(events.filter((e) => e.kind === "result")).toHaveLength(3));
  });

  it("reports command completion for both the item and its approval key", async () => {
    const { session, events } = start();
    session.send(
      JSON.stringify({ command: "pnpm -s test", params: { approvalId: "command-approval" } }),
    );
    await until(() =>
      expect(events).toContainEqual({ kind: "tool-result", toolUseId: "command-approval" }),
    );
    expect(events).toContainEqual({ kind: "tool-result", toolUseId: "item-1" });
    expect(recorded()).toContainEqual({ id: "approval-1", result: { decision: "accept" } });
  });

  it.each(["interrupt", "close", "exit"])("aborts pending approval on %s", async (how) => {
    let signal: AbortSignal | undefined;
    let resolve: (decision: "accept" | "decline") => void = () => {};
    const { session } = start(
      {},
      {
        approve: async (_req, _paths, s) => {
          if (s.aborted) return "decline";
          signal = s;
          return new Promise((r) => {
            resolve = r;
          });
        },
      },
    );
    session.send(
      JSON.stringify({ command: "pnpm -s test", holdItem: true, exitPending: how === "exit" }),
    );
    await until(() => expect(signal).toBeDefined());
    if (how === "interrupt") await session.control("interrupt");
    else if (how === "close") await session.close();
    await until(() => expect(signal?.aborted).toBe(true));
    resolve("accept");
    if (how !== "exit")
      await until(() =>
        expect(recorded()).toContainEqual({ id: "approval-1", result: { decision: "decline" } }),
      );
    expect(recorded()).not.toContainEqual({ id: "approval-1", result: { decision: "accept" } });
  });

  it("declines a pending approval if its item completes before the decision", async () => {
    let signal: AbortSignal | undefined;
    const { session } = start(
      {},
      {
        approve: async (_req, _paths, s) => {
          signal = s;
          if (s.aborted) return "decline";
          await new Promise<void>((resolve) =>
            s.addEventListener("abort", () => resolve(), { once: true }),
          );
          return "accept";
        },
      },
    );
    session.send(JSON.stringify({ command: "ls", holdTurn: true, holdItem: true }));
    await until(() => expect(signal).toBeDefined());
    session.send(JSON.stringify({ completeItem: true }));
    await until(() => expect(signal?.aborted).toBe(true));
    await until(() =>
      expect(recorded()).toContainEqual({ id: "approval-1", result: { decision: "decline" } }),
    );
    expect(recorded()).not.toContainEqual({ id: "approval-1", result: { decision: "accept" } });
  });

  it("runs interrupt success before the following turn-completed event", async () => {
    const { session, events } = start();
    const order: string[] = [];
    session.on((e) => {
      if (e.kind === "result") order.push("result");
    });
    session.send(JSON.stringify({ holdTurn: true }));
    await until(() => expect(events).toContainEqual({ kind: "turn-start" }));
    await session.control("interrupt", {
      onSuccess: () => {
        order.push("interrupted");
      },
    });
    await until(() => expect(order).toEqual(["interrupted", "result"]));
  });

  it("routes unknown requests through approve but never accepts them", async () => {
    const { session, approve } = start();
    session.send(JSON.stringify({ method: "item/permissions/requestApproval" }));
    await until(() =>
      expect(recorded()).toContainEqual({ id: "approval-1", result: { decision: "decline" } }),
    );
    expect(approve.mock.calls[0]?.[2].aborted).toBe(false);
    await until(() => expect(approve.mock.calls.some((call) => call[2].aborted)).toBe(true));
  });

  it.each([
    [MC_MCP_SERVER, MC_TOOL_NAMES.commit, "accept"],
    ["other", MC_TOOL_NAMES.commit, "decline"],
    [MC_MCP_SERVER, MC_TOOL_NAMES.mergePr, "decline"],
  ])("answers the %s %s MCP approval with %s", async (server, tool, action) => {
    const approve = createCodexApprover({
      config: {
        operator: { id: "op", timezone: "UTC" },
        accounts: [],
        repos: [{ id: "repo", github: "o/r", project: 1, statusMap: {}, autonomy: "draft" }],
        loops: [],
        poll: { usageMinutes: 30, githubSeconds: 60 },
      },
      repoId: "repo",
      seatId: "seat",
      runId: "run",
      mode: "writer",
      area: [],
      cwd: dir,
      lock: new TestLock(),
      record: vi.fn(),
      seatGrants: () => [],
    });
    const { session } = start({}, { approve });
    session.send(
      JSON.stringify({
        method: CODEX_MCP_ELICITATION,
        mcp: { server, tool },
        params: {
          itemId: null,
          serverName: server,
          mode: "form",
          _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] },
          message: `Allow the ${server} MCP server to run tool "${tool}"?`,
          requestedSchema: { type: "object", properties: {} },
        },
      }),
    );
    await until(() =>
      expect(recorded()).toContainEqual({
        id: "approval-1",
        result: { action, content: action === "accept" ? {} : null },
      }),
    );
  });

  it("cancels a request resolved by the server without answering it again", async () => {
    let signal: AbortSignal | undefined;
    const { session } = start(
      {},
      {
        approve: async (_req, _paths, s) => {
          signal = s;
          if (s.aborted) return "decline";
          await new Promise<void>((resolve) =>
            s.addEventListener("abort", () => resolve(), { once: true }),
          );
          return "decline";
        },
      },
    );
    session.send(JSON.stringify({ command: "ls", resolveEarly: true, holdItem: true }));
    await until(() => expect(signal?.aborted).toBe(true));
    expect(recorded().some((m) => m.id === "approval-1")).toBe(false);
  });
  it.each([null, "saved-thread"])(
    "checks every missing, null or malformed field on start/resume %s",
    async (resumeThreadId) => {
      for (const badField of [
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
        for (const badShape of ["absent", "null", "malformed"]) {
          const n = sessions.length;
          const { session, events } = start(
            { badField, badShape },
            {
              resumeThreadId,
              dir: join(dir, `k${n}`),
              transcriptPath: join(dir, `transcript${n}`),
              outboxPath: join(dir, `${n}-${CODEX_OUTBOX_FILE}`),
              env: {
                FAKE_CODEX_RECORD: join(dir, `record${n}`),
                FAKE_CODEX_SCENARIO: JSON.stringify({ badField, badShape }),
              },
            },
          );
          session.send("must not run");
          await session.ready;
          await session.close();
          expect(events).toContainEqual(
            expect.objectContaining({ kind: "exit", reason: CANNOT_START }),
          );
          expect(session.alive).toBe(false);
          const messages = readFileSync(join(dir, `record${n}`), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(messages.some((m) => m.method === "turn/start")).toBe(false);
          expect(
            messages.find(
              (m) => m.method === (resumeThreadId === null ? "thread/start" : "thread/resume"),
            )?.params,
          ).toMatchObject({
            approvalPolicy: "untrusted",
            approvalsReviewer: "user",
            ...(resumeThreadId === null ? {} : { threadId: resumeThreadId }),
          });
        }
      }
    },
    60_000,
  );

  it("resumes a checked thread before sending a turn", async () => {
    const { session, events } = start({}, { resumeThreadId: "saved-thread" });
    session.send("hello");
    await session.ready;
    await until(() => expect(events.some((e) => e.kind === "result")).toBe(true));
    expect(recorded().find((m) => m.method === "thread/resume")?.params.threadId).toBe(
      "saved-thread",
    );
    expect(recorded().find((m) => m.method === "thread/resume")?.params.config).toEqual({
      project_doc_max_bytes: 0,
    });
    expect(recorded().find((m) => m.method === "turn/start")?.params.threadId).toBe("saved-thread");
  });

  it.each(["early", "closing", "exception"])(
    "audits forced %s refusals with an aborted signal",
    async (when) => {
      const approve = vi.fn<CodexSessionInput["approve"]>(async (_req, _paths, signal) => {
        if (when === "exception" && !signal.aborted) throw new Error("broken callback");
        return "accept";
      });
      const { session } = start(
        { earlyApproval: when === "early", closingApproval: when === "closing" },
        { approve },
      );
      await session.ready;
      if (when === "closing") await session.close();
      else if (when !== "early") session.send(JSON.stringify({ command: "ls", holdItem: true }));
      await until(() => expect(approve.mock.calls.some((call) => call[2].aborted)).toBe(true));
      if (when !== "closing") {
        const id = when === "early" ? "early" : "approval-1";
        await until(() =>
          expect(recorded()).toContainEqual({ id, result: { decision: "decline" } }),
        );
        expect(recorded()).not.toContainEqual({ id, result: { decision: "accept" } });
      }
    },
  );

  it("audits a pending duplicate and never accepts the original after the duplicate arrives", async () => {
    let accept: (decision: "accept") => void = () => {};
    const decision = new Promise<"accept">((resolve) => {
      accept = resolve;
    });
    const approve = vi.fn<CodexSessionInput["approve"]>(async (_req, _paths, signal) =>
      signal.aborted ? "accept" : decision,
    );
    const { session } = start({}, { approve });
    session.send(JSON.stringify({ command: "ls", holdItem: true }));
    await until(() => expect(approve).toHaveBeenCalledTimes(1));
    const firstSignal = approve.mock.calls[0]?.[2];
    expect(firstSignal?.aborted).toBe(false);
    expect(recorded().filter((m) => m.id === "approval-1")).toEqual([]);

    // A stdout write is not atomic across the keeper. Hold the first decision until the
    // driver has seen the duplicate, then let that stale callback attempt to accept.
    session.send(JSON.stringify({ repeatRequest: true }));
    await until(() => expect(approve).toHaveBeenCalledTimes(2));
    expect(approve.mock.calls[1]?.[2].aborted).toBe(true);
    expect(firstSignal?.aborted).toBe(true);
    await until(() =>
      expect(recorded()).toContainEqual({ id: "approval-1", result: { decision: "decline" } }),
    );
    accept("accept");
    // Drain the callback's promise chain before close can cancel any pending approvals.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await session.close();
    expect(recorded().filter((m) => m.id === "approval-1")).toEqual([
      { id: "approval-1", result: { decision: "decline" } },
    ]);
  });

  it("declines and audits reuse of an already-answered id without accepting it again", async () => {
    const { session, approve } = start();
    session.send(JSON.stringify({ command: "ls", holdItem: true }));
    await until(() =>
      expect(recorded()).toContainEqual({ id: "approval-1", result: { decision: "accept" } }),
    );
    expect(approve.mock.calls[0]?.[2].aborted).toBe(false);

    // Only send the duplicate after the server has received the original acceptance.
    session.send(JSON.stringify({ repeatRequest: true }));
    await until(() => expect(approve).toHaveBeenCalledTimes(2));
    expect(approve.mock.calls[1]?.[2].aborted).toBe(true);
    await until(() =>
      expect(recorded()).toContainEqual({ id: "approval-1", result: { decision: "decline" } }),
    );
    await session.close();
    expect(recorded().filter((m) => m.id === "approval-1")).toEqual([
      { id: "approval-1", result: { decision: "accept" } },
      { id: "approval-1", result: { decision: "decline" } },
    ]);
  });

  it.each(["echo '$HOME'", "echo `id`", "cat <<'E'\n$x\nE"])(
    "preserves the exact shell script %j in approvals",
    async (command) => {
      const { session, approve } = start();
      session.send(JSON.stringify({ command }));
      await until(() => expect(approve).toHaveBeenCalledTimes(1));
      const req = approve.mock.calls[0]?.[0];
      const params = req?.params as { command: string; proposedExecpolicyAmendment: string[] };
      expect(codexCommand(params.command, params.proposedExecpolicyAmendment)).toBe(command);
    },
  );
});

it("reattaches to the running Codex turn and steers without a second handshake", async () => {
  const { session, events } = start({ holdTurn: true });
  session.send("hello");
  await until(() => expect(events.some((e) => e.kind === "turn-start")).toBe(true));
  session.detach();
  const found = await attachSession({
    dir: join(dir, "k"),
    from: () => 0,
    raw: true,
    stopGraceMs: 100,
  });
  if (found.kind !== "attached") throw new Error("keeper did not survive detach");
  const attached = attachCodexSession(
    {
      from: 0,
      threadId: "codex-thread-1",
      outboxPath: join(dir, CODEX_OUTBOX_FILE),
      cwd: dir,
      developerInstructions: "Hub instructions",
      model: "gpt-5.4",
      effort: "high",
      approve: async () => "decline",
    },
    found.session,
  );
  sessions.push(attached);
  await attached.ready;
  attached.send("steer");
  await until(() => expect(recorded().some((m) => m.method === "turn/steer")).toBe(true));
  expect(recorded().filter((m) => m.method === "initialize")).toHaveLength(1);
  await attached.close();
});

it.each([
  { badReattach: "approvalPolicy" },
  { badReattach: "approvalsReviewer" },
  { badReattach: "activePermissionProfile" },
  { badReattach: "networkAccess" },
  { badReattach: "instructionSources" },
  { badReattachField: "activePermissionProfile", badReattachShape: "absent" },
  { badReattachField: "instructionSources", badReattachShape: "null" },
])("refuses reattachment when the live floor is invalid: %j", async (scenario) => {
  const { session, events } = start({ ...scenario, holdTurn: true });
  session.send("first turn");
  await until(() => expect(events).toContainEqual({ kind: "turn-start" }));
  session.detach();
  const found = await attachSession({
    dir: join(dir, "k"),
    from: () => 0,
    raw: true,
    stopGraceMs: 100,
  });
  if (found.kind !== "attached") throw new Error("keeper did not survive detach");
  const attached = attachCodexSession(
    {
      from: 0,
      threadId: "codex-thread-1",
      outboxPath: join(dir, CODEX_OUTBOX_FILE),
      cwd: dir,
      developerInstructions: "Hub instructions",
      model: "gpt-5.4",
      effort: "high",
      approve: async () => "decline",
      controlTimeoutMs: 1000,
    },
    found.session,
  );
  sessions.push(attached);
  const attachedEvents: SessionEvent[] = [];
  attached.on((e) => attachedEvents.push(e));
  attached.send("must not run");
  await attached.ready;
  await until(() =>
    expect(attachedEvents).toContainEqual(
      expect.objectContaining({ kind: "exit", reason: CANNOT_START }),
    ),
  );
  expect(recorded().filter((m) => m.method === "turn/start")).toHaveLength(1);
  expect(recorded().some((m) => m.method === "turn/steer")).toBe(false);
  expect(attachedEvents.some((e) => e.kind === "attached")).toBe(false);
});

it("queues rapid sends until a delayed start notification establishes the turn", async () => {
  const { session } = start({ holdTurn: true, startDelayMs: 150 });
  session.send("first");
  session.send("second");
  await until(() => expect(recorded().some((m) => m.method === "turn/steer")).toBe(true));
  expect(recorded().filter((m) => m.method === "turn/start")).toHaveLength(1);
  expect(recorded().find((m) => m.method === "turn/steer")?.params).toMatchObject({
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "second" }],
  });
});

it("does not start a replacement when interruption is acknowledged but not completed", async () => {
  const signal = join(dir, "complete-interrupt");
  const { session, events } = start({ holdTurn: true, interruptCompleteSignal: signal });
  session.send("first");
  await until(() => expect(events).toContainEqual({ kind: "turn-start" }));
  const acknowledged = vi.fn();
  const replacement = session
    .control("interrupt", { onSuccess: acknowledged })
    .then(() => session.send("replacement"));
  await until(() => expect(acknowledged).toHaveBeenCalledTimes(1));
  expect(recorded().filter((m) => m.method === "turn/start")).toHaveLength(1);
  expect(events.some((e) => e.kind === "result")).toBe(false);
  writeFileSync(signal, "complete");
  await replacement;
  await until(() => expect(events.filter((e) => e.kind === "turn-start")).toHaveLength(2));
  expect(
    recorded()
      .filter((m) => m.method?.startsWith("turn/"))
      .map((m) => m.method),
  ).toEqual(["turn/start", "turn/interrupt", "turn/start"]);
  expect(events.filter((e) => e.kind === "result")).toHaveLength(1);
});

it("recovers a rapid send detached before the first turn's start notification", async () => {
  const signal = join(dir, "start-turn");
  const first = start({ holdTurn: true, startSignal: signal });
  first.session.send("first");
  first.session.send("second");
  await until(() => expect(recorded().filter((m) => m.method === "turn/start")).toHaveLength(1));
  first.session.detach();
  const next = await reattach();
  expect(next.events).toContainEqual({ kind: "attached", awaiting: true });
  expect(next.events).not.toContainEqual({ kind: "turn-start" });
  next.session.send("third");
  writeFileSync(signal, "go");
  await until(() => expect(recorded().filter((m) => m.method === "turn/steer")).toHaveLength(2));
  expect(recorded().filter((m) => m.method === "turn/start")).toHaveLength(1);
  expect(
    recorded()
      .filter((m) => m.method === "turn/steer")
      .map((m) => m.params),
  ).toEqual([
    {
      threadId: "codex-thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "second" }],
    },
    {
      threadId: "codex-thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "third" }],
    },
  ]);
  next.session.detach();
  const again = await reattach();
  expect(recorded().filter((m) => m.method === "turn/start")).toHaveLength(1);
  expect(recorded().filter((m) => m.method === "turn/steer")).toHaveLength(2);
  await again.session.close();
});

it("waits for the pending turn's identity on reattach before interrupting and replacing it", async () => {
  const signal = join(dir, "start-turn");
  const first = start({ holdTurn: true, startSignal: signal });
  first.session.send("first");
  await until(() => expect(recorded().filter((m) => m.method === "turn/start")).toHaveLength(1));
  first.session.detach();
  const next = await reattach();
  const acknowledged = vi.fn();
  const replacement = next.session.control("interrupt", { onSuccess: acknowledged }).then(() => {
    next.session.send("replacement");
  });
  expect(acknowledged).not.toHaveBeenCalled();
  writeFileSync(signal, "go");
  await replacement;
  await until(() => expect(recorded().filter((m) => m.method === "turn/start")).toHaveLength(2));
  expect(
    recorded()
      .filter((m) => m.method?.startsWith("turn/"))
      .map((m) => m.method),
  ).toEqual(["turn/start", "turn/interrupt", "turn/start"]);
  expect(recorded().find((m) => m.method === "turn/interrupt")?.params.turnId).toBe("turn-1");
  expect(acknowledged).toHaveBeenCalledOnce();
});
