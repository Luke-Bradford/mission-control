import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, TestLockState } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { attentionItems, crew, NO_CLI_VERSION } from "../src/hud.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");

let dir: string;
let store: Store;
let config: CcConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-hud-memo-"));
  store = new Store(join(dir, "mc.sqlite"));
  config = {
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 }],
    repos: [{ id: "shop-app", github: "o/shop-app", project: 2, statusMap: {}, autonomy: "draft" }],
    loops: [
      {
        id: "shop-app-ta",
        repoId: "shop-app",
        kind: "ta-loop",
        accountId: "claude-main",
        stateDir: join(dir, "ta"),
        worktree: join(dir, "wt"),
        launchdLabel: "x",
      },
    ],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const noVersion = () => null;

const storedRun = (over: Partial<Run>): Run => ({
  id: "run",
  agentId: "seat",
  repoId: "shop-app",
  seq: 1,
  startedAt: NOW - 1_000,
  endedAt: NOW - 500,
  status: "ok",
  sessionId: null,
  model: null,
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

describe("the crew and Needs-you memo", () => {
  it("reads ten seats with fifty runs each through the batched HUD tables", () => {
    config.crew = {
      worktrees: join(dir, "crew"),
      maxSeats: 10,
      sessions: [
        {
          id: "s1",
          repoId: "shop-app",
          checkout: join(dir, "checkout"),
          seats: Array.from({ length: 10 }, (_, seat) => ({
            id: `seat-${seat}`,
            role: "GUIDO",
            accountId: "claude-main",
            model: "sonnet",
            area: [],
          })),
        },
      ],
    };
    for (let seat = 0; seat < 10; seat++)
      for (let n = 0; n < 50; n++)
        store.upsertRun(storedRun({ id: `run-${seat}-${n}`, agentId: `seat-${seat}`, seq: n }));
    const runs = vi.spyOn(store, "runs");
    const batchedRuns = vi.spyOn(store, "runsForAgents");
    const started = performance.now();
    crew(config, store, NOW, undefined, noVersion);
    expect(performance.now() - started).toBeLessThan(100);
    expect(batchedRuns).toHaveBeenCalledTimes(1);
    expect(runs).not.toHaveBeenCalled();
    const warm = performance.now();
    crew(config, store, NOW + 1, undefined, noVersion);
    expect(performance.now() - warm).toBeLessThan(20);
    expect(batchedRuns).toHaveBeenCalledTimes(1);
  });
  it("builds the crew once for callers asking in the same second at the same version", () => {
    const reads = vi.spyOn(store, "status");
    crew(config, store, NOW, undefined, noVersion);
    const afterFirst = reads.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    crew(config, store, NOW + 400, undefined, noVersion);
    crew(config, store, NOW + 999, undefined, noVersion);
    expect(reads.mock.calls.length).toBe(afterFirst);
  });

  it("builds Needs-you once, also when the caller hands it the crew rows it was given", () => {
    const reads = vi.spyOn(store, "acks");
    const { rows } = crew(config, store, NOW, undefined, noVersion);
    attentionItems(config, store, NOW, undefined, rows);
    attentionItems(
      config,
      store,
      NOW + 10,
      undefined,
      crew(config, store, NOW, undefined, noVersion).rows,
    );
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("is rebuilt after a write", () => {
    const first = crew(config, store, NOW, undefined, noVersion);
    expect(first.rows[0]?.note).not.toBe("collector failed");
    store.setStatus("ta-loop:shop-app-ta", false, "collector failed");
    const second = crew(config, store, NOW, undefined, noVersion);
    expect(second.rows[0]?.hudState).toBe("error");
    expect(first.rows[0]?.hudState).not.toBe("error");
  });

  it("is rebuilt after a write by another connection", () => {
    const reads = vi.spyOn(store, "status");
    crew(config, store, NOW, undefined, noVersion);
    const n = reads.mock.calls.length;
    const other = new Store(join(dir, "mc.sqlite"));
    other.setStatus("ta-loop:shop-app-ta", false, "boom");
    other.close();
    crew(config, store, NOW, undefined, noVersion);
    expect(reads.mock.calls.length).toBeGreaterThan(n);
  });

  it("is rebuilt when the second changes", () => {
    const reads = vi.spyOn(store, "status");
    crew(config, store, NOW, undefined, noVersion);
    const n = reads.mock.calls.length;
    crew(config, store, NOW + 1_000, undefined, noVersion);
    expect(reads.mock.calls.length).toBeGreaterThan(n);
  });

  it("is rebuilt when the config, the lock or the login differ", () => {
    const reads = vi.spyOn(store, "status");
    crew(config, store, NOW, undefined, noVersion);
    const n = reads.mock.calls.length;
    const lock: TestLockState = { holder: null, waiting: [{ runId: "r9", since: NOW }] } as never;
    crew(config, store, NOW, lock, noVersion);
    expect(reads.mock.calls.length).toBeGreaterThan(n);
    const m = reads.mock.calls.length;
    config.operator.timezone = "UTC"; // config is edited in place by live crew changes
    crew(config, store, NOW, lock, noVersion);
    expect(reads.mock.calls.length).toBeGreaterThan(m);

    const acks = vi.spyOn(store, "acks");
    attentionItems(config, store, NOW, undefined, undefined, null);
    const a = acks.mock.calls.length;
    attentionItems(config, store, NOW, undefined, undefined, "someone");
    expect(acks.mock.calls.length).toBeGreaterThan(a);
  });

  it("hands each caller its own copy", () => {
    const first = crew(config, store, NOW, undefined, noVersion);
    first.rows.length = 0;
    first.rows.push({ id: "forged" } as never);
    const second = crew(config, store, NOW, undefined, noVersion);
    expect(second.rows.map((r) => r.id)).toEqual(["shop-app-ta"]);
    const third = crew(config, store, NOW, undefined, noVersion);
    expect(third).toEqual(second);
    expect(third.rows).not.toBe(second.rows);

    store.setStatus("ta-loop:shop-app-ta", false, "boom");
    const items = attentionItems(config, store, NOW);
    items.length = 0;
    expect(attentionItems(config, store, NOW).length).toBeGreaterThan(0);
  });

  it("is rebuilt when a file it read changed, though neither the store nor the second did", () => {
    mkdirSync(join(dir, "ta"));
    expect(crew(config, store, NOW, undefined, noVersion).rows[0]?.paused).toBe(false);
    writeFileSync(join(dir, "ta", "PAUSE"), "");
    expect(crew(config, store, NOW, undefined, noVersion).rows[0]?.paused).toBe(true);
  });

  it("shares one entry between callers that pass NO_CLI_VERSION, past the entry cap", () => {
    const reads = vi.spyOn(store, "status");
    crew(config, store, NOW, undefined, NO_CLI_VERSION);
    const n = reads.mock.calls.length;
    crew(config, store, NOW, undefined, NO_CLI_VERSION);
    expect(reads.mock.calls.length).toBe(n);
    for (let i = 0; i < 4; i++) crew(config, store, NOW, undefined, () => null);
    crew(config, store, NOW, undefined, NO_CLI_VERSION);
    expect(reads.mock.calls.length).toBe(n + 4);
  });

  it("is rebuilt by any write, to any table", () => {
    const reads = vi.spyOn(store, "status");
    crew(config, store, NOW, undefined, noVersion);
    const n = reads.mock.calls.length;
    store.setOffset("/somewhere/else.jsonl", 42);
    crew(config, store, NOW, undefined, noVersion);
    expect(reads.mock.calls.length).toBeGreaterThan(n);
  });
});
