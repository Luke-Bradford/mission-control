import "./temp-home.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { TestLock } from "../src/guard/lock.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { restoreRuns } from "../src/runtime/restore.ts";
import { crewTokenPath, Store } from "../src/store.ts";

let dir: string;
let dbPath: string;
let store: Store;
let tokens: RunTokens;
let lock: TestLock;

const seat = (seatId: string, runId: string) =>
  store.setSeatSession({
    seatId,
    runId,
    cliSessionId: "c",
    state: "idle",
    reason: null,
    worktree: null,
    updatedAt: 1,
  });
const deps = () => ({ store, dbPath, tokens, lock, log: () => {} });
const writeToken = (runId: string, text: string) => {
  mkdirSync(dirname(crewTokenPath(dbPath, runId)), { recursive: true });
  writeFileSync(crewTokenPath(dbPath, runId), text, { mode: 0o600 });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-restore-"));
  dbPath = join(dir, "mc.sqlite");
  store = new Store(dbPath);
  tokens = new RunTokens();
  lock = new TestLock({ holds: store });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("restoreRuns", () => {
  it("a hold restored at start blocks a second full suite", async () => {
    seat("guido-1", "run-a");
    store.addLockHold({
      runId: "run-a",
      toolUseId: "t1",
      seatId: "guido-1",
      command: "pnpm -s test",
      since: 1000,
    });
    expect(restoreRuns(deps()).holds).toBe(1);
    const got = await lock.acquire(
      { runId: "run-b", toolUseId: "b1" },
      "guido-2",
      "pnpm -s test",
      20,
      new AbortController().signal,
    );
    expect(got).toBe(false);
    expect(lock.state().holder).toMatchObject({ runId: "run-a", since: 1000 });
  });

  it("an adopted token resolves before the server listens, and a revoked run's token does not", async () => {
    seat("guido-1", "run-a");
    writeToken("run-a", "b".repeat(64));
    expect(restoreRuns(deps())).toEqual({ tokens: 1, holds: 0 });
    const config: CcConfig = {
      operator: { id: "operator", timezone: "Europe/London" },
      accounts: [],
      repos: [],
      loops: [],
      poll: { usageMinutes: 30, githubSeconds: 60 },
    };
    const app = buildApp({
      config,
      store,
      bus: new ChangeBus(),
      tokens,
      mcpTools: () => [],
      seatMode: () => "writer",
    });
    await app.ready();
    const list = () =>
      app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${"b".repeat(64)}`,
        },
        payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await list()).statusCode).toBe(200);
    tokens.revoke("run-a");
    const r = await list();
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: "unknown run" });
    await app.close();
  });

  it("adopts nothing from a missing or malformed token file, and drops holds of runs that are not active", () => {
    seat("guido-1", "run-a");
    seat("guido-2", "run-b");
    writeToken("run-b", "short");
    store.addLockHold({
      runId: "run-z",
      toolUseId: "z1",
      seatId: "guido-3",
      command: "pnpm -s test",
      since: 1,
    });
    expect(restoreRuns(deps())).toEqual({ tokens: 0, holds: 0 });
    expect(store.lockHolds()).toEqual([]);
    expect(lock.state().holder).toBeNull();
  });
});
