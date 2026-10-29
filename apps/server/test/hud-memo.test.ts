import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestLockState } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { attentionItems, crew } from "../src/hud.ts";
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

describe("the crew and Needs-you memo", () => {
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

  it("is not rebuilt by a write to a table it did not read, or by a rewrite that changed nothing", () => {
    const reads = vi.spyOn(store, "status");
    crew(config, store, NOW, undefined, noVersion);
    const n = reads.mock.calls.length;
    store.setOffset("/somewhere/else.jsonl", 42);
    crew(config, store, NOW, undefined, noVersion);
    expect(reads.mock.calls.length).toBe(n);

    const board = [
      {
        repoId: "shop-app",
        issueNumber: 1,
        title: "t",
        status: "Ready",
        state: "planned" as const,
        labels: [],
        assignees: [],
        priority: null,
        updatedAt: NOW,
        url: "https://github.com/o/shop-app/issues/1",
        stage: null,
        owner: null,
        parent: null,
        subIssues: null,
        blockedBy: [],
        milestone: null,
        size: null,
        closed: false,
        prioritySource: null,
        createdAt: 1,
        itemId: null,
        projectId: null,
      },
    ];
    expect(store.replaceBoard("shop-app", board)).toBe(true);
    crew(config, store, NOW, undefined, noVersion);
    const m = reads.mock.calls.length;
    expect(store.replaceBoard("shop-app", board)).toBe(false);
    crew(config, store, NOW, undefined, noVersion);
    expect(reads.mock.calls.length).toBe(m);
  });

  it("whole-table reads are reused until their table is written, and handed out as copies", () => {
    const prs = store.pullRequests("shop-app");
    prs.push({ number: 99 } as never);
    expect(store.pullRequests("shop-app")).toEqual([]);
    store.setStatus("x", true, null);
    expect(store.pullRequests("shop-app")).toEqual([]);
  });
});
