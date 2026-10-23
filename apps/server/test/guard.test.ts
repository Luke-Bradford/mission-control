import "./temp-home.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GUARD_BODY_LIMIT,
  GUARD_CHECK_PATH,
  GUARD_HITS_LIMIT,
  GUARD_HOOK_TIMEOUT_S,
  GUARD_RULES,
  GUARD_TOO_LONG_TEXT,
  GUARD_UNREACHABLE_TEXT,
  type GuardHitsView,
  guardAckKey,
  guardDenyOutput,
  HOOK_DEADLINE_MS,
  HOOK_RETRY_ENV,
  HOOK_RETRY_MS,
  LOCK_WAIT_MS,
  lockBusyText,
  MC_TOOLS,
  MCP_PATH,
  TEST_LOCK_UNAVAILABLE_TEXT,
  type TestLockState,
} from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDeps, buildApp, crewGuardDeps } from "../src/api.ts";
import { ChangeBus, type Topic } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { HOOK_ENTRY, hookMain } from "../src/guard/hook.ts";
import { lockChanged, TestLock } from "../src/guard/lock.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { Store } from "../src/store.ts";

const HUB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HOOK_CLI = join(HUB_ROOT, HOOK_ENTRY);
const URL_OK = "http://127.0.0.1:7420/api/guard/check";
const DENY_UNREACHABLE = guardDenyOutput(GUARD_UNREACHABLE_TEXT);

/** Lets pending I/O and promise callbacks run until `cond` holds (a bounded number of turns). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
}

describe("constants", () => {
  it("derive from the largest hook timeout the spike saw honoured (660 s)", () => {
    expect(LOCK_WAIT_MS).toBe(600_000);
    expect(GUARD_HOOK_TIMEOUT_S).toBe(630);
    expect(HOOK_DEADLINE_MS).toBe(620_000);
    expect(GUARD_BODY_LIMIT).toBe(64 * 1024);
  });

  it("keeps the hook's retry window for a restarting hub below its deadline", () => {
    expect(HOOK_RETRY_MS).toBe(60_000);
    expect(HOOK_RETRY_MS).toBeLessThan(HOOK_DEADLINE_MS);
  });
});

describe("TestLock", () => {
  let lock: TestLock;
  let clock: number;
  const live = () => new AbortController().signal;
  beforeEach(() => {
    clock = 1000;
    lock = new TestLock({ now: () => clock });
  });

  describe("stored holds", () => {
    let dir: string;
    let store: Store;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "mc-lock-"));
      store = new Store(join(dir, "mc.sqlite"));
      lock = new TestLock({ now: () => clock, holds: store });
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("keeps queue time and closes holds using the lock clock", async () => {
      await lock.acquire({ runId: "A", toolUseId: "a" }, "guido-1", "test", 300000, live());
      const waiting = lock.acquire(
        { runId: "B", toolUseId: "b" },
        "guido-2",
        "test",
        300000,
        live(),
      );
      clock += 120000;
      lock.releaseRun("A");
      expect(await waiting).toBe(true);
      expect(store.lockRuns(0)).toEqual([
        expect.objectContaining({ runId: "B", queuedAt: 1000, startedAt: 121000, endedAt: null }),
        expect.objectContaining({ runId: "A", endedAt: 121000, outcome: "freed" }),
      ]);
      clock += 3000;
      lock.release({ runId: "B", toolUseId: "b" });
      expect(store.lockRuns(0)[0]).toMatchObject({ endedAt: 124000, outcome: "done" });
    });

    it("stores each held call and deletes it when released", async () => {
      await lock.acquire({ runId: "A", toolUseId: "a1" }, "guido-1", "pnpm -s test", 1000, live());
      await lock.acquire({ runId: "A", toolUseId: "a2" }, "guido-1", "pnpm -s test", 1000, live());
      expect(store.lockHolds()).toEqual([
        { runId: "A", toolUseId: "a1", seatId: "guido-1", command: "pnpm -s test", since: 1000 },
        { runId: "A", toolUseId: "a2", seatId: "guido-1", command: "pnpm -s test", since: 1000 },
      ]);
      lock.release({ runId: "A", toolUseId: "a1" });
      expect(store.lockHolds()).toHaveLength(1);
      const b = lock.acquire(
        { runId: "B", toolUseId: "b1" },
        "guido-2",
        "pnpm -s test",
        1000,
        live(),
      );
      lock.releaseRun("A");
      expect(await b).toBe(true);
      expect(store.lockHolds().map((r) => `${r.runId}/${r.toolUseId}`)).toEqual(["B/b1"]);
      lock.release({ runId: "B", toolUseId: "b1" });
      expect(store.lockHolds()).toEqual([]);
    });

    it("stores the waiting calls granted together with the next holder", async () => {
      await lock.acquire({ runId: "A", toolUseId: "a1" }, "guido-1", "pnpm -s test", 1000, live());
      const wait = (toolUseId: string) =>
        lock.acquire({ runId: "B", toolUseId }, "guido-2", "pnpm -s test", 1000, live());
      const b1 = wait("b1");
      const b2 = wait("b2");
      lock.releaseRun("A");
      expect(await b1).toBe(true);
      expect(await b2).toBe(true);
      expect(store.lockHolds().map((r) => `${r.runId}/${r.toolUseId}`)).toEqual(["B/b1", "B/b2"]);
    });

    it("restores stored holds: the earliest run holds, and others' rows go", async () => {
      const row = (runId: string, toolUseId: string, since: number) => ({
        runId,
        toolUseId,
        seatId: `s-${runId}`,
        command: "pnpm -s test",
        since,
      });
      store.addLockHold(row("A", "a1", 5));
      store.addLockHold(row("A", "a2", 6));
      store.addLockHold(row("C", "c1", 9));
      lock.restore(store.lockHolds());
      expect(lock.state().holder).toEqual({
        runId: "A",
        seatId: "s-A",
        command: "pnpm -s test",
        since: 5,
      });
      expect(store.lockHolds().map((r) => r.runId)).toEqual(["A", "A"]);
      lock.release({ runId: "A", toolUseId: "a1" });
      expect(lock.state().holder).not.toBeNull();
      lock.release({ runId: "A", toolUseId: "a2" });
      expect(lock.state().holder).toBeNull();
    });
  });

  it("grants a free lock and reports the holder", async () => {
    expect(lock.state()).toEqual({ holder: null, waiting: [] });
    expect(
      await lock.acquire({ runId: "A", toolUseId: "a1" }, "guido-1", "pnpm -s test", 1000, live()),
    ).toBe(true);
    expect(lock.state()).toEqual({
      holder: { runId: "A", seatId: "guido-1", command: "pnpm -s test", since: 1000 },
      waiting: [],
    });
  });

  it("tells onChange when the holder or the queue changes", async () => {
    let n = 0;
    lock = new TestLock({ now: () => clock, onChange: () => void n++ });
    await lock.acquire({ runId: "A", toolUseId: "a1" }, "s-a", "pnpm -s test", 1000, live());
    expect(n).toBe(1);
    const b = lock.acquire({ runId: "B", toolUseId: "b1" }, "s-b", "pnpm -s test", 60_000, live());
    expect(n).toBe(2);
    lock.release({ runId: "A", toolUseId: "a1" });
    expect(await b).toBe(true);
    expect(n).toBe(3);
    lock.release({ runId: "B", toolUseId: "nope" }); // not a held call: nothing changed
    expect(n).toBe(3);
    lock.releaseRun("B");
    expect(n).toBe(4);
    lock.releaseRun("B");
    expect(n).toBe(4);
    const ac = new AbortController();
    await lock.acquire({ runId: "C", toolUseId: "c1" }, "s-c", "x", 1000, live());
    n = 0;
    void lock.acquire({ runId: "D", toolUseId: "d1" }, "s-d", "x", 60_000, ac.signal);
    ac.abort();
    expect(n).toBe(2);
  });

  it("a queue change tells guard, attention and agents", async () => {
    const bus = new ChangeBus();
    const seen: Topic[] = [];
    bus.subscribe((t) => void seen.push(t));
    lock = new TestLock({ now: () => clock, onChange: lockChanged(bus) });
    await lock.acquire({ runId: "A", toolUseId: "a1" }, "s-a", "x", 1000, live());
    seen.length = 0;
    void lock.acquire({ runId: "B", toolUseId: "b1" }, "s-b", "x", 60_000, live());
    expect(seen.sort()).toEqual(["agents", "attention", "guard"]);
  });

  it("is FIFO across runs", async () => {
    await lock.acquire({ runId: "A", toolUseId: "a1" }, "s-a", "pnpm -s test", 1000, live());
    clock = 2000;
    const b = lock.acquire({ runId: "B", toolUseId: "b1" }, "s-b", "pnpm -s test", 60_000, live());
    clock = 3000;
    const c = lock.acquire({ runId: "C", toolUseId: "c1" }, "s-c", "pnpm -s test", 60_000, live());
    expect(lock.state().waiting).toEqual([
      { runId: "B", seatId: "s-b", command: "pnpm -s test", since: 2000 },
      { runId: "C", seatId: "s-c", command: "pnpm -s test", since: 3000 },
    ]);
    clock = 4000;
    lock.release({ runId: "A", toolUseId: "a1" });
    expect(await b).toBe(true);
    expect(lock.state().holder).toMatchObject({ runId: "B", since: 4000 });
    lock.release({ runId: "B", toolUseId: "b1" });
    expect(await c).toBe(true);
    expect(lock.state()).toMatchObject({ holder: { runId: "C" }, waiting: [] });
    lock.release({ runId: "C", toolUseId: "c1" });
    expect(lock.state().holder).toBeNull();
  });

  it("lets the holder's run re-enter, ahead of waiters; only the matching tool_use_id releases", async () => {
    await lock.acquire({ runId: "A", toolUseId: "a1" }, "s-a", "pnpm -s test", 1000, live());
    const b = lock.acquire({ runId: "B", toolUseId: "b1" }, "s-b", "pnpm -s test", 60_000, live());
    expect(
      await lock.acquire({ runId: "A", toolUseId: "a2" }, "s-a", "pnpm -s test", 1000, live()),
    ).toBe(true);
    lock.release({ runId: "A", toolUseId: "a-other" }); // a parallel Bash call that held nothing
    lock.release({ runId: "B", toolUseId: "a1" }); // the right id, another run
    expect(lock.state().holder).toMatchObject({ runId: "A" });
    lock.release({ runId: "A", toolUseId: "a1" });
    expect(lock.state().holder).toMatchObject({ runId: "A" }); // a2 still runs
    lock.release({ runId: "A", toolUseId: "a2" });
    expect(await b).toBe(true);
    expect(lock.state().holder).toMatchObject({ runId: "B" });
  });

  it("answers false after waitMs and drops the waiter", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await lock.acquire({ runId: "A", toolUseId: "a1" }, "s-a", "pnpm -s test", 1000, live());
      const b = lock.acquire({ runId: "B", toolUseId: "b1" }, "s-b", "pnpm -s test", 5000, live());
      vi.advanceTimersByTime(4999);
      expect(lock.state().waiting).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(await b).toBe(false);
      expect(lock.state().waiting).toEqual([]);
      lock.release({ runId: "A", toolUseId: "a1" });
      expect(lock.state().holder).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an aborted waiter, so the next grant passes it by", async () => {
    await lock.acquire({ runId: "A", toolUseId: "a1" }, "s-a", "pnpm -s test", 1000, live());
    const hungUp = new AbortController();
    const b = lock.acquire(
      { runId: "B", toolUseId: "b1" },
      "s-b",
      "pnpm -s test",
      60_000,
      hungUp.signal,
    );
    const c = lock.acquire({ runId: "C", toolUseId: "c1" }, "s-c", "pnpm -s test", 60_000, live());
    hungUp.abort();
    expect(await b).toBe(false);
    expect(lock.state().waiting.map((w) => w.runId)).toEqual(["C"]);
    lock.release({ runId: "A", toolUseId: "a1" });
    expect(await c).toBe(true);
    expect(lock.state().holder).toMatchObject({ runId: "C" });
  });

  it("never grants to a waiter whose signal is already aborted", async () => {
    const gone = new AbortController();
    gone.abort();
    expect(
      await lock.acquire({ runId: "A", toolUseId: "a1" }, "s-a", "pnpm -s test", 1000, gone.signal),
    ).toBe(false);
    expect(lock.state()).toEqual({ holder: null, waiting: [] });
  });

  it("releaseRun frees the run's hold and drops its queue", async () => {
    await lock.acquire({ runId: "A", toolUseId: "a1" }, "s-a", "pnpm -s test", 1000, live());
    const b1 = lock.acquire({ runId: "B", toolUseId: "b1" }, "s-b", "pnpm -s test", 60_000, live());
    const c = lock.acquire({ runId: "C", toolUseId: "c1" }, "s-c", "pnpm -s test", 60_000, live());
    const b2 = lock.acquire({ runId: "B", toolUseId: "b2" }, "s-b", "pnpm -s test", 60_000, live());
    lock.releaseRun("B");
    expect(await b1).toBe(false);
    expect(await b2).toBe(false);
    expect(lock.state().waiting.map((w) => w.runId)).toEqual(["C"]);
    lock.releaseRun("A");
    expect(await c).toBe(true);
    lock.releaseRun("C");
    expect(lock.state()).toEqual({ holder: null, waiting: [] });
  });

  it("grants a run's other queued calls along with it", async () => {
    await lock.acquire({ runId: "A", toolUseId: "a1" }, "s-a", "pnpm -s test", 1000, live());
    const b1 = lock.acquire({ runId: "B", toolUseId: "b1" }, "s-b", "pnpm -s test", 60_000, live());
    const c = lock.acquire({ runId: "C", toolUseId: "c1" }, "s-c", "pnpm -s test", 60_000, live());
    const b2 = lock.acquire({ runId: "B", toolUseId: "b2" }, "s-b", "pnpm -s test", 60_000, live());
    lock.release({ runId: "A", toolUseId: "a1" });
    expect(await b1).toBe(true);
    expect(await b2).toBe(true);
    expect(lock.state().waiting.map((w) => w.runId)).toEqual(["C"]);
    lock.release({ runId: "B", toolUseId: "b1" });
    lock.release({ runId: "B", toolUseId: "b2" });
    expect(await c).toBe(true);
  });
});

describe("POST /api/guard/check", () => {
  let dir: string;
  let store: Store;
  let tokens: RunTokens;
  let lock: TestLock;
  let app: FastifyInstance;
  let tokA: string;
  let tokB: string;
  let tokR: string;
  let topics: Topic[];
  let raws: Map<string, ServerResponse>;
  let reqs: Map<string, IncomingMessage>;
  const NOW = Date.parse("2026-10-20T12:00:00Z");
  const DAY = 24 * 3600e3;

  const config = (): CcConfig => ({
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [],
    repos: [
      {
        id: "dev",
        github: "o/dev",
        project: 1,
        statusMap: {},
        fullSuite: ["pnpm -s test"],
        autonomy: "draft",
      },
    ],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: join(dir, "crew"),
      maxSeats: 4,
      sessions: [
        {
          id: "s1",
          repoId: "dev",
          checkout: join(dir, "clone"),
          seats: [
            { id: "guido-1", role: "GUIDO", accountId: "a", model: "haiku", area: [] },
            { id: "guido-2", role: "GUIDO", accountId: "a", model: "haiku", area: [] },
            { id: "retro-1", role: "RETRO", accountId: "a", model: "haiku", area: [] },
          ],
        },
      ],
    },
  });

  const build = async (
    over: Partial<AppDeps> = {},
    before: (a: FastifyInstance) => void = () => {},
  ) => {
    const bus = new ChangeBus();
    bus.subscribe((t) => void topics.push(t));
    const modes: Record<string, "writer" | "read-only"> = {
      "guido-1": "writer",
      "guido-2": "writer",
      "retro-1": "read-only",
    };
    const a = buildApp({
      config: config(),
      store,
      bus,
      now: () => NOW,
      tokens,
      lock,
      seatMode: (id) => modes[id] ?? "read-only",
      ...over,
    });
    // the reply each hook request gets, by tool_use_id, so a test can hang the hook up
    a.addHook("preHandler", async (req, reply) => {
      const id = (req.body as { tool_use_id?: unknown } | undefined)?.tool_use_id;
      if (req.url === "/api/guard/check" && typeof id === "string") {
        raws.set(id, reply.raw);
        reqs.set(id, req.raw);
      }
    });
    before(a);
    await a.ready();
    return a;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mc-guard-"));
    store = new Store(join(dir, "mc.sqlite"));
    tokens = new RunTokens();
    tokA = tokens.issue("guido-1", "run-a");
    tokB = tokens.issue("guido-2", "run-b");
    tokR = tokens.issue("retro-1", "run-r");
    lock = new TestLock({ now: () => NOW });
    topics = [];
    raws = new Map();
    reqs = new Map();
    app = await build();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const check = (tok: string | null, body: unknown, a: FastifyInstance = app, raw?: string) =>
    a.inject({
      method: "POST",
      url: "/api/guard/check",
      headers: {
        "content-type": "application/json",
        ...(tok === null ? {} : { authorization: `Bearer ${tok}` }),
      },
      payload: raw ?? JSON.stringify(body),
    });
  const pre = (id: string, tool: string, input: Record<string, unknown>) => ({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_use_id: id,
    tool_input: input,
  });
  const bash = (id: string, command: string) => pre(id, "Bash", { command });
  const post = (id: string, event = "PostToolUse") => ({
    hook_event_name: event,
    tool_name: "Bash",
    tool_use_id: id,
  });
  const reason = (body: string) =>
    (JSON.parse(body) as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason;

  it("serves the guard and MCP routes at the paths a seat is given", async () => {
    const r = await app.inject({
      method: "POST",
      url: GUARD_CHECK_PATH,
      headers: { "content-type": "application/json", authorization: `Bearer ${tokA}` },
      payload: JSON.stringify(bash("t1", "ls")),
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("{}");
    const m = await app.inject({
      method: "POST",
      url: MCP_PATH,
      headers: { "content-type": "application/json", authorization: `Bearer ${tokA}` },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(m.statusCode).toBe(200);
  });

  it("refuses a superuser-only tool at the next call once the repo is lowered", async () => {
    const cfg = config();
    for (const r of cfg.repos) r.flightPowers = "superuser";
    const a = await build({ config: cfg, superuserTools: ["promote"] });
    try {
      expect((await check(tokA, pre("m1", "mcp__mc__promote", {}), a)).body).toBe("{}");
      for (const r of cfg.repos) r.flightPowers = "standard";
      const r = await check(tokA, pre("m2", "mcp__mc__promote", {}), a);
      expect(reason(r.body)).toBe(
        `${GUARD_RULES["flight-powers"]}: mcp__mc__promote (needs flight_powers: superuser)`,
      );
    } finally {
      await a.close();
    }
  });

  it("crewGuardDeps (what main.ts passes) judges a seat by its configured role", async () => {
    const deps = crewGuardDeps(config(), tokens, lock);
    expect(deps.tokens).toBe(tokens);
    expect(deps.lock).toBe(lock);
    expect(deps.seatMode("guido-1")).toBe("writer");
    expect(deps.seatMode("retro-1")).toBe("read-only");
    expect(deps.seatMode("nobody")).toBe("read-only");
    const a = await build(deps);
    try {
      const commit = (tok: string) => check(tok, pre("m1", MC_TOOLS.commit, {}), a);
      expect((await commit(tokA)).body).toBe("{}");
      expect(reason((await commit(tokR)).body)).toMatch(/^Read-only roles cannot write/);
    } finally {
      await a.close();
    }
  });

  it("allows with {} and records nothing", async () => {
    const r = await check(tokA, bash("t1", "ls -la"));
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("{}");
    expect(store.guardHits(0)).toEqual([]);
    expect(topics).toEqual([]);
  });

  it("denies in the recorded form, records the hit once, and the text holds no argv beyond the subcommand", async () => {
    const r = await check(tokA, bash("t1", "git push origin feature/secret-branch --force"));
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(guardDenyOutput(`${GUARD_RULES["git-write"]}: git push`));
    const hits = store.guardHits(0);
    expect(hits).toEqual([
      {
        id: expect.any(Number),
        agentId: "guido-1",
        runId: "run-a",
        rule: "git-write",
        text: `${GUARD_RULES["git-write"]}: git push`,
        at: NOW,
      },
    ]);
    expect(hits[0]?.text).not.toMatch(/origin|secret-branch|force/);
    expect(topics).toEqual(["guard"]);
  });

  it("denies a read-only seat's Write and records it", async () => {
    const r = await check(tokR, pre("t1", "Write", { file_path: "/w/x.ts" }));
    expect(reason(r.body)).toBe(`${GUARD_RULES["read-only"]}: Write`);
    expect(store.guardHits(0).map((h) => [h.agentId, h.rule])).toEqual([["retro-1", "read-only"]]);
  });

  it("takes the test lock for a full suite and answers {}", async () => {
    const r = await check(tokA, bash("t1", "pnpm -s test"));
    expect(r.body).toBe("{}");
    expect(lock.state().holder).toEqual({
      runId: "run-a",
      seatId: "guido-1",
      command: "pnpm -s test",
      since: NOW,
    });
    expect(store.guardHits(0)).toEqual([]);
  });

  it("answers a waiter that ran out of time with the busy text, unrecorded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await check(tokA, bash("a1", "pnpm -s test"));
    const b = check(tokB, bash("b1", "pnpm -s test"));
    await until(() => lock.state().waiting.length === 1);
    vi.advanceTimersByTime(LOCK_WAIT_MS);
    const r = await b;
    expect(r.statusCode).toBe(200);
    expect(reason(r.body)).toBe(lockBusyText("GUIDO-1", "pnpm -s test"));
    expect(reason(r.body)).toBe(
      "The test lock is busy: GUIDO-1 is running pnpm -s test. Run the same command with a test file path, or the full suite later.",
    );
    expect(lock.state()).toMatchObject({ holder: { runId: "run-a" }, waiting: [] });
    expect(store.guardHits(0)).toEqual([]);
  });

  it("grants the next run when PostToolUse releases the holder's tool_use_id, and not before", async () => {
    await check(tokA, bash("a1", "pnpm -s test"));
    const b = check(tokB, bash("b1", "pnpm -s test"));
    await until(() => lock.state().waiting.length === 1);
    expect((await check(tokA, post("a-other"))).body).toBe("{}");
    expect((await check(tokB, post("a1"))).body).toBe("{}"); // the id, but another run's token
    expect(lock.state().holder).toMatchObject({ runId: "run-a" });
    await check(tokA, post("a1"));
    expect((await b).body).toBe("{}");
    expect(lock.state().holder).toMatchObject({ runId: "run-b" });
  });

  it("parallel Bash calls in one run: each holds until its own Post", async () => {
    await check(tokA, bash("a1", "pnpm -s test"));
    expect((await check(tokA, bash("a2", "pnpm -s test"))).body).toBe("{}"); // re-entry
    await check(tokA, post("a1"));
    expect(lock.state().holder).toMatchObject({ runId: "run-a" });
    await check(tokA, post("a2", "PostToolUseFailure"));
    expect(lock.state().holder).toBeNull();
  });

  it("PostToolUseFailure releases", async () => {
    await check(tokA, bash("a1", "pnpm -s test"));
    const r = await check(tokA, post("a1", "PostToolUseFailure"));
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("{}");
    expect(lock.state().holder).toBeNull();
  });

  it("drops a waiter whose hook hung up (its reply closed before an answer)", async () => {
    await check(tokA, bash("a1", "pnpm -s test"));
    const b = check(tokB, bash("b1", "pnpm -s test"));
    await until(() => lock.state().waiting.length === 1);
    const raw = raws.get("b1");
    expect(raw?.writableEnded).toBe(false);
    raw?.emit("close");
    await expect(b).rejects.toThrow("response destroyed before completion");
    expect(lock.state().waiting).toEqual([]);
    await check(tokA, post("a1"));
    expect(lock.state().holder).toBeNull();
  });

  it("releases a grant that lands after its hook hung up", async () => {
    await check(tokA, bash("a1", "pnpm -s test"));
    const b = check(tokB, bash("b1", "pnpm -s test"));
    await until(() => lock.state().waiting.length === 1);
    // the grant and the hang-up in one turn: the route sees the closed reply after the grant
    lock.release({ runId: "run-a", toolUseId: "a1" });
    expect(lock.state().holder).toMatchObject({ runId: "run-b" });
    raws.get("b1")?.emit("close");
    await expect(b).rejects.toThrow("response destroyed before completion");
    await until(() => lock.state().holder === null);
  });

  it("releases a grant answered into a socket that closed before the answer went out", async () => {
    // the hook hangs up in the same turn as the grant: the {} is sent, but never delivered
    const a = await build({}, (x) =>
      x.addHook("onSend", async (req, reply, payload) => {
        const id = (req.body as { tool_use_id?: unknown } | undefined)?.tool_use_id;
        if (id === "d1") reply.raw.emit("close");
        return payload;
      }),
    );
    await check(tokA, bash("d1", "pnpm -s test"), a).catch(() => undefined);
    await until(() => lock.state().holder === null);
    // a grant that was delivered keeps its hold
    expect((await check(tokA, bash("d2", "pnpm -s test"), a)).body).toBe("{}");
    await new Promise((r) => setImmediate(r));
    expect(lock.state().holder).toMatchObject({ runId: "run-a" });
    await a.close();
  });

  it("does not take the request's own close (the body was read) for a hang-up", async () => {
    await check(tokA, bash("a1", "pnpm -s test"));
    const b = check(tokB, bash("b1", "pnpm -s test"));
    await until(() => lock.state().waiting.length === 1);
    reqs.get("b1")?.emit("close");
    await new Promise((r) => setImmediate(r));
    expect(lock.state().waiting).toHaveLength(1);
    await check(tokA, post("a1"));
    expect((await b).body).toBe("{}");
    expect(lock.state().holder).toMatchObject({ runId: "run-b" });
  });

  it("refuses a missing or unknown token with 401, before reading the body", async () => {
    expect((await check(null, bash("t1", "ls"))).statusCode).toBe(401);
    const r = await check("f".repeat(64), bash("t1", "ls"));
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: "unknown run" });
    // an unknown caller's oversized body is refused as unknown, not read
    expect((await check(null, {}, app, "x".repeat(GUARD_BODY_LIMIT + 10))).statusCode).toBe(401);
  });

  it("refuses a revoked token", async () => {
    tokens.revoke("run-a");
    expect((await check(tokA, bash("t1", "ls"))).statusCode).toBe(401);
  });

  it("takes a body over the global 16 KiB, and refuses one over 64 KiB with 413", async () => {
    const mid = await check(tokA, bash("t1", `echo ${"x".repeat(30 * 1024)}`));
    expect(mid.statusCode).toBe(200);
    const big = await check(tokA, bash("t2", `echo ${"x".repeat(GUARD_BODY_LIMIT)}`));
    expect(big.statusCode).toBe(413);
  });

  it.each([
    [{ ...bash("t1", "ls"), hook_event_name: "PermissionDenied" }],
    [{ ...bash("t1", "ls"), extra: 1 }],
    [{ ...bash("t1", "ls"), tool_input: { command: "ls", content: "x" } }],
    [{ hook_event_name: "PreToolUse", tool_name: "Bash" }],
    [{ ...bash("t1", "ls"), tool_input: { command: 5 } }],
  ])("answers a body it cannot read with 400 { error }", async (body) => {
    const r = await check(tokA, body);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: expect.any(String) });
  });

  it("denies a full suite when the server has no test lock", async () => {
    const a = await build({ lock: undefined });
    const r = await check(tokA, bash("t1", "pnpm -s test"), a);
    expect(r.statusCode).toBe(200);
    expect(reason(r.body)).toBe(TEST_LOCK_UNAVAILABLE_TEXT);
    await a.close();
  });

  it("refuses every token when the server has no tokens", async () => {
    const a = await build({ tokens: undefined });
    expect((await check(tokA, bash("t1", "ls"), a)).statusCode).toBe(401);
    await a.close();
  });

  it("GET /api/test-lock shows the holder and the waiting", async () => {
    await check(tokA, bash("a1", "pnpm -s test"));
    void check(tokB, bash("b1", "pnpm -s test"));
    await until(() => lock.state().waiting.length === 1);
    const r = await app.inject({ method: "GET", url: "/api/test-lock" });
    expect(r.statusCode).toBe(200);
    expect(r.json<TestLockState>()).toEqual({
      holder: { runId: "run-a", seatId: "guido-1", command: "pnpm -s test", since: NOW },
      waiting: [{ runId: "run-b", seatId: "guido-2", command: "pnpm -s test", since: NOW }],
    });
    lock.releaseRun("run-b");
  });

  it("GET /api/test-lock without a lock is empty", async () => {
    const a = await build({ lock: undefined });
    const r = await a.inject({ method: "GET", url: "/api/test-lock" });
    expect(r.json()).toEqual({ holder: null, waiting: [] });
    await a.close();
  });

  it("GET /api/guard/hits?days=7 lists the week's hits and counts them by rule", async () => {
    store.addGuardHit({
      agentId: "guido-1",
      runId: "r",
      rule: "network",
      text: "n: curl",
      at: NOW - 8 * DAY,
    });
    await check(tokA, bash("t1", "git push"));
    await check(tokA, bash("t2", "git commit -m x"));
    await check(tokA, bash("t3", "curl https://x"));
    const r = await app.inject({ method: "GET", url: "/api/guard/hits?days=7" });
    expect(r.statusCode).toBe(200);
    const view = r.json<GuardHitsView>();
    expect(view.hits.map((h) => h.text)).toEqual([
      `${GUARD_RULES.network}: curl`,
      `${GUARD_RULES["git-write"]}: git commit`,
      `${GUARD_RULES["git-write"]}: git push`,
    ]);
    expect(view.counts).toEqual({
      "git-write": 2,
      "github-write": 0,
      "merge-push": 0,
      "flight-powers": 0,
      "full-suite": 0,
      "read-only": 0,
      network: 1,
      secret: 0,
    });
    const all = await app.inject({ method: "GET", url: "/api/guard/hits?days=9" });
    expect(all.json<GuardHitsView>().counts.network).toBe(2);
    expect((await app.inject({ method: "GET", url: "/api/guard/hits" })).json()).toEqual(view);
    // each hit says whether its guard:{id} key is acknowledged; acking one tells the HUD
    expect(view.hits.map((h) => h.acked)).toEqual([false, false, false]);
    const id = (view.hits[0] as { id: number }).id;
    topics.length = 0;
    const ack = await app.inject({
      method: "POST",
      url: "/api/attention/ack",
      payload: { keys: [guardAckKey(id)] },
      headers: { origin: "http://localhost", "content-type": "application/json" },
    });
    expect(ack.statusCode).toBe(200);
    expect(topics).toContain("guard");
    const after = (
      await app.inject({ method: "GET", url: "/api/guard/hits?days=7" })
    ).json<GuardHitsView>();
    expect(after.hits.map((h) => h.acked)).toEqual([true, false, false]);
  });

  it("GET /api/guard/hits lists at most the newest GUARD_HITS_LIMIT hits; counts cover the window", async () => {
    for (let i = 0; i <= GUARD_HITS_LIMIT; i++) {
      store.addGuardHit({
        agentId: "guido-1",
        runId: "r",
        rule: "network",
        text: `n${i}`,
        at: NOW - i,
      });
    }
    const view = (
      await app.inject({ method: "GET", url: "/api/guard/hits" })
    ).json<GuardHitsView>();
    expect(GUARD_HITS_LIMIT).toBe(500);
    expect(view.hits).toHaveLength(GUARD_HITS_LIMIT);
    expect(view.hits[0]?.text).toBe("n0");
    expect(view.hits.at(-1)?.text).toBe(`n${GUARD_HITS_LIMIT - 1}`);
    expect(view.counts.network).toBe(GUARD_HITS_LIMIT + 1);
  });

  it.each(["0", "x", "1.5", "31", "-1"])("GET /api/guard/hits?days=%s is a 400", async (d) => {
    const r = await app.inject({ method: "GET", url: `/api/guard/hits?days=${d}` });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: expect.any(String) });
  });
});

describe("hookMain", () => {
  let dir: string;
  let tokenFile: string;
  const TOKEN = "a".repeat(64);
  let posts: { url: string; token: string; body: string }[];
  const answer =
    (status: number, body: string) => async (url: string, token: string, b: string) => {
      posts.push({ url, token, body: b });
      return { status, body };
    };
  const stdinFor = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "s",
      transcript_path: "/x.jsonl",
      cwd: "/w",
      prompt_id: "p",
      permission_mode: "default",
      effort: { level: "medium" },
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_input: { command: "ls", description: "list" },
      ...over,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-hook-"));
    tokenFile = join(dir, "run.token");
    writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    posts = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("posts only what the guard needs, with the token from the file, and passes {} through", async () => {
    const r = await hookMain(stdinFor(), [tokenFile, URL_OK], answer(200, "{}"));
    expect(r).toEqual({ out: "{}", exit: 0 });
    expect(posts).toEqual([
      {
        url: URL_OK,
        token: TOKEN,
        body: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "toolu_1",
          tool_input: { command: "ls" },
        }),
      },
    ]);
  });

  it("passes the recorded deny shape through, rebuilt in code", async () => {
    const deny = guardDenyOutput("git writes only: git push");
    const spaced = JSON.stringify(JSON.parse(deny), null, 2);
    expect(await hookMain(stdinFor(), [tokenFile, URL_OK], answer(200, spaced))).toEqual({
      out: deny,
      exit: 0,
    });
  });

  it("sends run_in_background and file_path when the call has them", async () => {
    await hookMain(
      stdinFor({ tool_input: { command: "pnpm -s test", run_in_background: true, timeout: 5 } }),
      [tokenFile, URL_OK],
      answer(200, "{}"),
    );
    expect(JSON.parse(posts[0]?.body ?? "")).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_input: { command: "pnpm -s test", run_in_background: true },
    });
  });

  it("turns a 1 MB Write's PreToolUse into a small request", async () => {
    const stdin = stdinFor({
      tool_name: "Write",
      tool_input: { file_path: "/w/big.txt", content: "x".repeat(1024 * 1024) },
    });
    expect(stdin.length).toBeGreaterThan(1024 * 1024);
    expect(await hookMain(stdin, [tokenFile, URL_OK], answer(200, "{}"))).toEqual({
      out: "{}",
      exit: 0,
    });
    expect(posts[0]?.body.length).toBeLessThan(200);
    expect(JSON.parse(posts[0]?.body ?? "").tool_input).toEqual({ file_path: "/w/big.txt" });
  });

  it("sends a Post event without the tool's input or response", async () => {
    const stdin = stdinFor({
      hook_event_name: "PostToolUse",
      tool_response: { stdout: "y".repeat(2 * 1024 * 1024) },
      duration_ms: 5,
    });
    expect(await hookMain(stdin, [tokenFile, URL_OK], answer(200, "{}"))).toEqual({
      out: "{}",
      exit: 0,
    });
    expect(JSON.parse(posts[0]?.body ?? "")).toEqual({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
    });
  });

  it("answers a Bash call over 64 KiB itself, without posting: a decision, exit 0", async () => {
    const stdin = stdinFor({ tool_input: { command: `echo ${"x".repeat(GUARD_BODY_LIMIT)}` } });
    expect(await hookMain(stdin, [tokenFile, URL_OK], answer(200, "{}"))).toEqual({
      out: guardDenyOutput(GUARD_TOO_LONG_TEXT),
      exit: 0,
    });
    expect(GUARD_TOO_LONG_TEXT).toBe("That command is too long for the guard to check; split it.");
    expect(posts).toEqual([]);
  });

  it.each([
    ["401", 401, JSON.stringify({ error: "unknown run" })],
    ["413", 413, JSON.stringify({ error: "Request body is too large" })],
    ["500", 500, JSON.stringify({ error: "boom" })],
    ["500 carrying {}", 500, "{}"],
    ["400", 400, JSON.stringify({ error: "tool_name: required" })],
    ["a non-JSON body", 200, "<html>ok</html>"],
    ["an empty body", 200, ""],
    [
      "an allow decision",
      200,
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      }),
    ],
    [
      "a deny with an extra key",
      200,
      JSON.stringify({ ...JSON.parse(guardDenyOutput("x")), continue: true }),
    ],
    [
      "a deny with no reason",
      200,
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      }),
    ],
    ["a deny for another event", 200, guardDenyOutput("x").replace("PreToolUse", "PostToolUse")],
    ["an array", 200, "[]"],
    ["null", 200, "null"],
    ["{} with a key", 200, JSON.stringify({ decision: "approve" })],
  ])("fails closed on %s: the unreachable deny, exit 2", async (_n, status, body) => {
    expect(await hookMain(stdinFor(), [tokenFile, URL_OK], answer(status, body))).toEqual({
      out: DENY_UNREACHABLE,
      exit: 2,
    });
  });

  it("fails closed when the post throws", async () => {
    const r = await hookMain(stdinFor(), [tokenFile, URL_OK], async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(r).toEqual({ out: DENY_UNREACHABLE, exit: 2 });
  });

  describe("while the hub is down", () => {
    const refused = () =>
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    /** Runs the clock forward a second at a time until the hook settles or `ms` have passed. */
    async function settle<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
      let done = false;
      let value: T | undefined;
      void p.then((v) => {
        done = true;
        value = v;
      });
      for (let t = 0; t <= ms && !done; t += 1000) {
        // The token file is read for real, so wait for the hook's next sleep (or its answer).
        // Bound it in real time: a spin count runs out on a loaded runner, losing a retry.
        const giveUpAt = performance.now() + 2000;
        while (!done && vi.getTimerCount() < 2) {
          if (performance.now() > giveUpAt) throw new Error("the hook did not sleep within 2 s");
          await new Promise((r) => setImmediate(r));
        }
        await vi.advanceTimersByTimeAsync(1000);
      }
      await new Promise((r) => setImmediate(r));
      return value;
    }

    it("retries a refused connection and acts on the hub's verdict once it answers", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let calls = 0;
      const r = hookMain(stdinFor(), [tokenFile, URL_OK], async () => {
        if (++calls <= 2) throw refused();
        return { status: 200, body: "{}" };
      });
      expect(await settle(r, 10_000)).toEqual({ out: "{}", exit: 0 });
      expect(calls).toBe(3);
    });

    it("reads the token file again before each try", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const tokens: string[] = [];
      const next = "b".repeat(64);
      const r = hookMain(stdinFor(), [tokenFile, URL_OK], async (_u, token) => {
        tokens.push(token);
        if (tokens.length === 1) {
          writeFileSync(tokenFile, `${next}\n`, { mode: 0o600 });
          throw refused();
        }
        return { status: 200, body: "{}" };
      });
      expect(await settle(r, 10_000)).toEqual({ out: "{}", exit: 0 });
      expect(tokens).toEqual([TOKEN, next]);
    });

    it("denies as unreachable, exit 2, once the hub is still down after the limit", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let calls = 0;
      const r = hookMain(stdinFor(), [tokenFile, URL_OK], async () => {
        calls++;
        throw refused();
      });
      expect(await settle(r, HOOK_RETRY_MS + 5000)).toEqual({ out: DENY_UNREACHABLE, exit: 2 });
      expect(calls).toBeGreaterThan(50);
      expect(calls).toBeLessThanOrEqual(HOOK_RETRY_MS / 1000 + 1);
    });

    it("denies at once on an HTTP answer, with no retry", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let calls = 0;
      const r = hookMain(stdinFor(), [tokenFile, URL_OK], async () => {
        calls++;
        return { status: 401, body: "" };
      });
      expect(await r).toEqual({ out: DENY_UNREACHABLE, exit: 2 });
      expect(calls).toBe(1);
    });
  });

  it("fails closed, without posting, on a missing or malformed token file", async () => {
    const missing = await hookMain(
      stdinFor(),
      [join(dir, "gone.token"), URL_OK],
      answer(200, "{}"),
    );
    expect(missing).toEqual({ out: DENY_UNREACHABLE, exit: 2 });
    writeFileSync(tokenFile, "not-a-token\nAuthorization: x");
    const bad = await hookMain(stdinFor(), [tokenFile, URL_OK], answer(200, "{}"));
    expect(bad).toEqual({ out: DENY_UNREACHABLE, exit: 2 });
    expect(posts).toEqual([]);
  });

  it.each([
    ["a remote host", "http://example.com/api/guard/check"],
    ["https", "https://127.0.0.1:7420/api/guard/check"],
    ["not a URL", "nope"],
  ])("never sends the token to %s", async (_n, url) => {
    const r = await hookMain(stdinFor(), [tokenFile, url], answer(200, "{}"));
    expect(r).toEqual({ out: DENY_UNREACHABLE, exit: 2 });
    expect(posts).toEqual([]);
  });

  it.each([
    ["not JSON", "{not json"],
    ["no tool_use_id", stdinFor({ tool_use_id: undefined })],
    ["a non-string command", stdinFor({ tool_input: { command: ["git", "push"] } })],
    [
      "a non-boolean run_in_background",
      stdinFor({ tool_input: { command: "x", run_in_background: "true" } }),
    ],
    ["an unknown event", stdinFor({ hook_event_name: "Stop" })],
  ])("fails closed, without posting, on stdin with %s", async (_n, stdin) => {
    expect(await hookMain(stdin, [tokenFile, URL_OK], answer(200, "{}"))).toEqual({
      out: DENY_UNREACHABLE,
      exit: 2,
    });
    expect(posts).toEqual([]);
  });

  it("fails closed on missing argv", async () => {
    expect(
      await hookMain(stdinFor(), [tokenFile] as unknown as [string, string], answer(200, "{}")),
    ).toEqual({ out: DENY_UNREACHABLE, exit: 2 });
  });

  it("fails closed when its deadline passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const r = hookMain(stdinFor(), [tokenFile, URL_OK], () => new Promise(() => {}));
    void r.then(() => {
      settled = true;
    });
    await until(() => vi.getTimerCount() > 0);
    vi.advanceTimersByTime(HOOK_DEADLINE_MS - 1);
    await new Promise((res) => setImmediate(res));
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await r).toEqual({ out: DENY_UNREACHABLE, exit: 2 });
  });
});

describe("hook-cli.ts run as the CLI runs it", () => {
  it("is the entry the hub root names", () => {
    expect(HOOK_ENTRY).toBe("apps/server/src/guard/hook-cli.ts");
    expect(HOOK_CLI).toBe(fileURLToPath(new URL("../src/guard/hook-cli.ts", import.meta.url)));
  });

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-hookrun-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[], input: string) =>
    spawnSync(process.execPath, ["--experimental-strip-types", HOOK_CLI, ...args], {
      input,
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
      env: { ...process.env, [HOOK_RETRY_ENV]: "0" },
    });

  it("prints exactly the deny form, one fixed stderr line, and exits 2 when the hub is not there", () => {
    const tokenFile = join(dir, "t");
    writeFileSync(tokenFile, "b".repeat(64), { mode: 0o600 });
    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_input: { command: "ls" },
    });
    // port 1: nothing listens there, so the connection is refused
    const r = run([tokenFile, "http://127.0.0.1:1/api/guard/check"], stdin);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe(DENY_UNREACHABLE);
    expect(r.stderr.trim().split("\n")).toEqual(["mc-guard: no verdict from Mission Control"]);
    expect(r.stdout + r.stderr).not.toContain("b".repeat(64));
  }, 30_000);

  it("runs when imported as a module, not only as the main script (no main-module gate)", () => {
    const tokenFile = join(dir, "t");
    writeFileSync(tokenFile, "c".repeat(64), { mode: 0o600 });
    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_input: { command: "git push origin main" },
    });
    // with -e, process.argv is [node, ...args]: a placeholder keeps argv[2] the token file
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(HOOK_CLI).href)})`,
        "placeholder",
        tokenFile,
        "http://127.0.0.1:1/api/guard/check",
      ],
      {
        input: stdin,
        encoding: "utf8",
        timeout: 20_000,
        killSignal: "SIGKILL",
        env: { ...process.env, [HOOK_RETRY_ENV]: "0" },
      },
    );
    expect(r.status).toBe(2);
    expect(r.stdout).toBe(DENY_UNREACHABLE);
  }, 30_000);

  it("exits 2 with the deny form on a missing token file", () => {
    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_input: { command: "ls" },
    });
    const r = run([join(dir, "none"), "http://127.0.0.1:1/api/guard/check"], stdin);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe(DENY_UNREACHABLE);
  }, 30_000);
});
