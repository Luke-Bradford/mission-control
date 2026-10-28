import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CrewMode,
  codexSeatEffectiveConfig,
  MC_TOOL_NAMES,
  MCP_PATH,
  seatDef,
} from "@mc/core";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CcConfig, crewSeatGrants, crewSeatMode } from "../src/config.ts";
import { TestLock } from "../src/guard/lock.ts";
import { registerMcp } from "../src/mcp/server.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { createCodexApprover } from "../src/runtime/codex-approval.ts";
import { CODEX_OUTBOX_FILE, startCodexSession } from "../src/runtime/codex-session.ts";
import type { CrewSession } from "../src/runtime/session.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const KEEPER = fileURLToPath(new URL("../src/runtime/keeper-cli.ts", import.meta.url));
let dir: string;
let config: CcConfig;
const sessions: CrewSession[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-cs-")));
  config = {
    operator: { id: "op", timezone: "UTC" },
    accounts: [{ id: "cx", vendor: "codex", alertAt: 80, stopAt: 95 }],
    repos: [
      {
        id: "repo",
        github: "o/r",
        project: 1,
        statusMap: {},
        autonomy: "draft",
        fullSuite: ["pnpm -s test"],
      },
    ],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: dir,
      maxSeats: 2,
      sessions: [
        {
          id: "crew",
          repoId: "repo",
          checkout: dir,
          seats: ["a", "b"].map((id) => ({
            id,
            role: "FAO",
            accountId: "cx",
            model: "gpt-5.4",
            area: ["apps/**"],
          })),
        },
      ],
    },
  };
  for (const id of ["a", "b"]) {
    mkdirSync(join(dir, id, "apps"), { recursive: true });
    writeFileSync(join(dir, id, "apps", "a.txt"), id);
  }
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  rmSync(dir, { recursive: true, force: true });
});
const until = (fn: () => unknown) => vi.waitFor(fn, { timeout: 5000, interval: 10 });

function seat(id: string, mode: CrewMode, lock: TestLock) {
  const cwd = join(dir, id);
  const configured = config.crew?.sessions[0]?.seats.find((s) => s.id === id);
  if (configured) configured.def = { ...seatDef(configured), mode };
  const hits: { rule: string; text: string }[] = [];
  const approve = createCodexApprover({
    config,
    repoId: "repo",
    seatId: id,
    runId: id,
    cwd,
    mode,
    area: ["apps/**"],
    lock,
    record: (rule, text) => {
      hits.push({ rule, text });
    },
    seatGrants: (seatId) => crewSeatGrants(config, seatId),
  });
  const session = startCodexSession({
    command: process.execPath,
    args: [FAKE],
    cwd,
    env: { FAKE_CODEX_RECORD: join(dir, `${id}.record`) },
    transcriptPath: join(dir, `${id}.transcript`),
    node: process.execPath,
    entry: KEEPER,
    dir: join(dir, `k-${id}`),
    spawn: id,
    marker: FAKE,
    model: "gpt-5.4",
    effort: "low",
    developerInstructions: "test",
    resumeThreadId: null,
    outboxPath: join(dir, `k-${id}`, CODEX_OUTBOX_FILE),
    approve,
    stopGraceMs: 100,
    effectiveConfig: codexSeatEffectiveConfig("http://hub/mcp"),
  });
  sessions.push(session);
  session.on((e) => {
    if (e.kind === "tool-result") lock.release({ runId: id, toolUseId: e.toolUseId });
    if (e.kind === "result" || e.kind === "exit") lock.releaseRun(id);
  });
  let n = 0;
  const ask = async (scenario: object) => {
    if (n > 0) await session.control("interrupt");
    const requestId = `approval-${++n}`;
    session.send(JSON.stringify(scenario));
    let decision: string | undefined;
    await until(() => {
      const records = readFileSync(join(dir, `${id}.record`), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      decision = records.find((m) => m.id === requestId && m.result?.decision)?.result.decision;
      expect(decision).toBeDefined();
    });
    return decision;
  };
  return { session, ask, hits };
}

describe("Codex mode and seat boundaries", () => {
  it.each(["writer", "read-only", "scratch"] as const)(
    "leaves %s command reads to the OS sandbox while enforcing writes and modes",
    async (mode) => {
      const lock = new TestLock();
      const a = seat("a", mode, lock);
      const b = seat("b", mode, lock);
      await Promise.all([a.session.ready, b.session.ready]);
      for (const [own, other, driver] of [
        ["a", "b", a],
        ["b", "a", b],
      ] as const) {
        // Each case holds its approval open; the next ask interrupts before starting a new turn.
        expect(await driver.ask({ command: "cat apps/a.txt", holdItem: true })).toBe("accept");
        expect(await driver.ask({ changes: [{ path: "apps/new.txt" }], holdItem: true })).toBe(
          mode === "read-only" ? "decline" : "accept",
        );
        expect(
          await driver.ask({ command: `cat ${join(dir, other, "apps/a.txt")}`, holdItem: true }),
        ).toBe("accept");
        expect(
          await driver.ask({
            changes: [{ path: join(dir, other, "apps/new.txt") }],
            holdItem: true,
          }),
        ).toBe("decline");
        symlinkSync(join(dir, other, "apps"), join(dir, own, "apps", "peer"));
        expect(await driver.ask({ changes: [{ path: "apps/peer/new.txt" }], holdItem: true })).toBe(
          "decline",
        );
        expect(await driver.ask({ command: "pnpm -s test", holdItem: true })).toBe("accept");
        expect(lock.state().holder?.runId).toBe(own);
        await driver.session.close();
        expect(lock.state().holder).toBeNull();
      }
      expect(a.hits.length).toBeGreaterThanOrEqual(2);
      expect(b.hits.length).toBeGreaterThanOrEqual(2);
    },
  );

  it.each(["close", "exit"])("cancels the second seat's actual lock queue on %s", async (how) => {
    const lock = new TestLock();
    const a = seat("a", "writer", lock);
    const b = seat("b", "writer", lock);
    await Promise.all([a.session.ready, b.session.ready]);
    expect(await a.ask({ command: "pnpm -s test", holdItem: true })).toBe("accept");
    b.session.send(JSON.stringify({ command: "pnpm -s test", holdItem: true }));
    await until(() =>
      expect(lock.state().waiting).toEqual([expect.objectContaining({ runId: "b" })]),
    );
    if (how === "close") await b.session.close();
    else b.session.send(JSON.stringify({ exit: true }));
    await until(() => expect(lock.state().waiting).toEqual([]));
    expect(lock.state().holder?.runId).toBe("a");
    await until(() =>
      expect(b.hits).toContainEqual(expect.objectContaining({ rule: "full-suite" })),
    );
    await a.session.close();
    expect(lock.state()).toEqual({ holder: null, waiting: [] });
    const messages = readFileSync(join(dir, "b.record"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages).not.toContainEqual({ id: "approval-1", result: { decision: "accept" } });
  });

  it("records a callback exception through the hub's refusal path", async () => {
    const lock = new TestLock();
    vi.spyOn(lock, "acquire").mockRejectedValueOnce(new Error("lock failed"));
    const driver = seat("a", "writer", lock);
    await driver.session.ready;
    expect(await driver.ask({ command: "pnpm -s test", holdItem: true })).toBe("decline");
    await until(() =>
      expect(driver.hits).toContainEqual(expect.objectContaining({ rule: "codex-allowlist" })),
    );
    expect(lock.state()).toEqual({ holder: null, waiting: [] });
  });

  it.each(["read-only", "scratch"] as const)(
    "uses each %s token's real hub grants, ignoring a different seat named in tool arguments",
    async (mode) => {
      const seats = config.crew?.sessions[0]?.seats ?? [];
      for (const s of seats)
        s.def = { ...seatDef(s), mode, mcTools: s.id === "a" ? [MC_TOOL_NAMES.syncMain] : [] };
      const tokens = new RunTokens();
      const tokenA = tokens.issue("a", "run-a");
      const tokenB = tokens.issue("b", "run-b");
      const call = vi.fn(async () => ({ text: "synced" }));
      const app = Fastify();
      registerMcp(app, {
        tokens,
        seatMode: (id) => crewSeatMode(config, id),
        seatGrants: (id) => crewSeatGrants(config, id),
        mcpTools: () => [
          {
            name: MC_TOOL_NAMES.syncMain,
            description: "sync",
            inputSchema: { type: "object" },
            modes: ["writer"],
            grantable: ["read-only", "scratch"],
            call,
          },
        ],
      });
      const rpc = async (token: string, method: string) =>
        (
          await app.inject({
            method: "POST",
            url: MCP_PATH,
            headers: { authorization: `Bearer ${token}` },
            payload: {
              jsonrpc: "2.0",
              id: 1,
              method,
              params: { name: MC_TOOL_NAMES.syncMain, arguments: { seatId: "a", runId: "run-a" } },
            },
          })
        ).json();
      try {
        expect((await rpc(tokenB, "tools/list")).result.tools).toEqual([]);
        expect((await rpc(tokenB, "tools/call")).error.message).toBe("unknown tool");
        expect(call).not.toHaveBeenCalled();
        expect((await rpc(tokenA, "tools/call")).result.isError).toBeUndefined();
        expect(call).toHaveBeenCalledWith({ seatId: "a", runId: "run-a" }, expect.anything());
      } finally {
        await app.close();
      }
    },
  );
});
