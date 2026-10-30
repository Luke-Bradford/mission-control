import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKFILL_COLLECTOR,
  type CrewRow,
  ENGINE_TICK_MS,
  FLIGHT_LOOPS_SETTING,
  GITHUB_SLOWED_PREFIX,
  type HudState,
  MACHINE_COLLECTOR,
  type MachineSample,
  type PullRequestView,
  type Run,
  type TestLockState,
  type UsageSample,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdItem, holds } from "../src/attention-holds.ts";
import { ChangeBus, type Topic } from "../src/bus.ts";
import { FOLD_WINDOW_MS } from "../src/collectors/common.ts";
import { MISSING_SCOPE_PREFIX } from "../src/collectors/github.ts";
import type { RateLimits } from "../src/collectors/rate-limit.ts";
import {
  OAUTH_USAGE_SOURCE,
  sampleClaude,
  USAGE_BACKOFF_CAP_MS,
  USAGE_BACKOFF_SETTING,
  USAGE_RATE_LIMIT_MAX_AGE_MS,
} from "../src/collectors/usage-claude.ts";
import { fetchUsage } from "../src/collectors/usage-sources.ts";
import type { CcConfig } from "../src/config.ts";
import { TRANSCRIPT_RETENTION_DEFAULTS } from "../src/config.ts";
import * as hud from "../src/hud.ts";
import type { SupervisorEvent } from "../src/runtime/supervisor.ts";
import {
  BACKFILL_BUDGET_MS,
  BACKFILL_FIRST_DELAY_MS,
  BACKFILL_INTERVAL_MS,
  type Collectors,
  createScheduler,
  DIGEST_RETENTION_MS,
  EMIT_COALESCE_MS,
  ENGINE_FIRST_DELAY_MS,
  FLOW_FIRST_DELAY_MS,
  FLOW_INTERVAL_MS,
  JOBS,
  MACHINE_INTERVAL_MS,
  MACHINE_STATUS_MS,
  MAINTENANCE_INTERVAL_MS,
  PR_SWEEP_FIRST_DELAY_MS,
  PR_SWEEP_MS,
  refreshOnSeatFree,
  waitedPrNumbers,
} from "../src/scheduler.ts";
import { ACK_ABSENT_MS, Store } from "../src/store.ts";
import { VERSION_CHECK_MS } from "../src/update.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");

let dir: string;
let store: Store;
let bus: ChangeBus;
let topics: Topic[];
let config: CcConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-sched-"));
  store = new Store(join(dir, "mc.sqlite"));
  bus = new ChangeBus();
  // Each test's own array: a scheduler a test never stopped cannot write into a later test's.
  const seen: Topic[] = [];
  topics = seen;
  bus.subscribe((t) => seen.push(t));
  config = {
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [
      { id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 },
      { id: "codex-main", vendor: "codex", alertAt: 70, stopAt: 80 },
    ],
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
      {
        id: "studio-builder",
        repoId: "shop-app",
        kind: "studio-loop",
        accountId: "claude-main",
        stateDir: join(dir, "st"),
        logsDir: join(dir, "st-logs"),
        worktree: join(dir, "wt2"),
        launchdLabel: "y",
      },
    ],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks(); // the prune test's hud stubs must not carry into later tests
  rmSync(dir, { recursive: true, force: true });
});

const sample = (over: Partial<UsageSample>): UsageSample => ({
  accountId: "claude-main",
  window: "5h",
  at: NOW,
  pct: 10,
  resetAt: NOW + 3600e3,
  source: "oauth-usage",
  ...over,
});

const machineSample = (over: Partial<MachineSample> = {}): MachineSample => ({
  at: NOW,
  cpuPct: null,
  cores: 8,
  memUsedBytes: 1,
  memTotalBytes: 2,
  diskFreeBytes: 20 * 1024 ** 3,
  diskTotalBytes: 100 * 1024 ** 3,
  agents: null,
  ...over,
});

function stubs(over: Partial<Collectors> = {}): Collectors {
  return {
    ta: vi.fn(async () => undefined),
    studio: vi.fn(async () => undefined),
    launchctl: vi.fn(async () => ({ code: 0, stdout: "" })),
    sessions: vi.fn(() => []),
    githubToken: vi.fn(async () => "tok"),
    makeGql: vi.fn(() => async () => ({})),
    makeRest: vi.fn(() => async () => ({ status: 200, headers: new Headers(), body: [] })),
    notifications: vi.fn(async () => ({ changed: true })),
    github: vi.fn(async () => ({ boards: true, escalations: true })),
    githubPrs: vi.fn(async () => ({ boards: false, escalations: false })),
    followPrs: vi.fn(async () => false),
    prSweep: vi.fn(async () => ({ boards: true, escalations: false })),
    flow: vi.fn(async () => undefined),
    backfill: vi.fn(() => ({ folded: 0, left: 0, failed: 0 })),
    rewriteSummaries: vi.fn(() => ({ rewritten: 0, done: true })),
    fillTitles: vi.fn(async () => ({ filled: 0, done: true })),
    cli: vi.fn(async () => ({ cask: false as const, found: true })),
    claude: vi.fn(async () => []),
    codex: vi.fn(async () => []),
    machine: vi.fn(async (_prevCpus, prev, now) => ({
      sample: machineSample({ at: now, cpuPct: prev ? 5 : null }),
      cpus: [],
      errors: [],
    })),
    ...over,
  };
}

const row = (collector: string) => store.status().find((s) => s.collector === collector);

/** Sends the topics queued in the current coalescing window (needs fake timers). */
const flushEmits = () => vi.advanceTimersByTime(EMIT_COALESCE_MS);

describe("scheduler", () => {
  it("runs transcript maintenance with default retention", async () => {
    const transcripts = vi.fn(async () => ({ gzipped: 1, deleted: 0, skippedLive: 0, failed: [] }));
    const log = vi.fn();
    const s = createScheduler({
      config,
      store,
      bus,
      now: () => NOW,
      collectors: stubs({ transcripts }),
      log,
    });
    await s.tick("transcripts");
    expect(transcripts).toHaveBeenCalledWith({
      store,
      now: NOW,
      retention: TRANSCRIPT_RETENTION_DEFAULTS,
    });
    expect(log).toHaveBeenCalledWith("transcripts: 1 gzipped, 0 deleted, 0 failed");
  });

  it("starts transcript maintenance after one minute, then every six hours", async () => {
    vi.useFakeTimers();
    config.crew = {
      worktrees: join(dir, "worktrees"),
      maxSeats: 1,
      transcripts: { gzipAfterHours: 2, deleteAfterDays: 3 },
      sessions: [],
    };
    const transcripts = vi.fn(async () => ({ gzipped: 0, deleted: 0, skippedLive: 0, failed: [] }));
    const log = vi.fn();
    const s = createScheduler({
      config,
      store,
      bus,
      now: () => NOW,
      collectors: stubs({ transcripts }),
      log,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(transcripts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transcripts).toHaveBeenCalledTimes(1);
    expect(transcripts).toHaveBeenLastCalledWith({
      store,
      now: NOW,
      retention: { gzipAfterHours: 2, deleteAfterDays: 3 },
    });
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(transcripts).toHaveBeenCalledTimes(2);
    await s.stop();
  });

  it("skips a job tick while the previous run of that job is still in flight", async () => {
    let release: () => void = () => undefined;
    const ta = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs({ ta }) });
    const first = s.tick("ta");
    expect(await s.tick("ta")).toBe("skipped");
    expect(ta).toHaveBeenCalledTimes(1);
    expect(await s.tick("studio")).toBe("ran"); // other jobs are not blocked
    release();
    expect(await first).toBe("ran");
    const again = s.tick("ta");
    release();
    expect(await again).toBe("ran");
    expect(ta).toHaveBeenCalledTimes(2);
  });

  it("records a throwing collector in collector status and never throws", async () => {
    vi.useFakeTimers();
    const ta = vi.fn(async () => {
      throw new Error("disk on fire");
    });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs({ ta }) });
    await expect(s.tick("ta")).resolves.toBe("ran");
    expect(row("ta-loop:shop-app-ta")).toMatchObject({ ok: false, error: "disk on fire" });
    flushEmits();
    expect(topics).toEqual(expect.arrayContaining(["agents", "health"]));
  });

  it("survives a store that cannot record status (e.g. database is locked): tick never rejects", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      store.setStatus = () => {
        throw new Error("database is locked");
      };
      const c = stubs({
        ta: vi.fn(async () => {
          throw new Error("collector broke");
        }),
        githubToken: vi.fn(async () => {
          throw new Error("gh: could not read a GitHub token (run `gh auth login`)");
        }),
        makeGql: vi.fn(() => {
          throw new Error("unreachable");
        }),
        sessions: vi.fn(() => []),
      });
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
      for (const job of ["ta", "studio", "sessions", "github", "usage"] as const) {
        await expect(s.tick(job)).resolves.toBe("ran");
      }
      // A job that rejects outright (here: the gql factory throws) is also contained.
      const c2 = stubs({
        makeGql: vi.fn(() => {
          throw new Error("factory broke");
        }),
      });
      const s2 = createScheduler({ config, store, bus, now: () => NOW, collectors: c2 });
      await expect(s2.tick("github")).resolves.toBe("ran");
      // The timer path (`void tick`) must not produce an unhandled rejection either.
      vi.useFakeTimers();
      const s3 = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
      s3.start();
      await vi.advanceTimersByTimeAsync(15_000);
      await s3.stop();
      const written = stderr.mock.calls.map((a) => String(a[0])).join("");
      expect(written).toContain(
        "could not record status for ta-loop:shop-app-ta: database is locked",
      );
      expect(written).not.toContain("collector broke"); // only the name and the DB error
    } finally {
      stderr.mockRestore();
    }
  });

  it("passes each loop of the right kind to its collector, with the operator timezone for studio", async () => {
    const c = stubs();
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("ta");
    await s.tick("studio");
    expect(c.ta).toHaveBeenCalledTimes(1);
    expect(vi.mocked(c.ta).mock.calls[0]?.slice(0, 3)).toEqual([config.loops[0], store, NOW]);
    expect(vi.mocked(c.studio).mock.calls[0]?.slice(0, 4)).toEqual([
      config.loops[1],
      store,
      "Europe/London",
      NOW,
    ]);
  });

  it("hands both loop collectors the launchctl runner", async () => {
    const c = stubs();
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("ta");
    await s.tick("studio");
    expect(vi.mocked(c.ta).mock.calls[0]?.[5]).toBe(c.launchctl);
    expect(vi.mocked(c.studio).mock.calls[0]?.[6]).toBe(c.launchctl);
  });

  it("keeps the latest live sessions in memory", async () => {
    const live = [
      { pid: 1, sessionId: "s", cwd: "/x", startedAt: 1, status: null, name: "", alive: true },
    ];
    const s = createScheduler({
      config,
      store,
      bus,
      now: () => NOW,
      collectors: stubs({ sessions: () => live }),
    });
    expect(s.sessions()).toEqual([]);
    await s.tick("sessions");
    expect(s.sessions()).toEqual(live);
  });

  it("hands the studio collector the sessions tick's live sessions, without re-reading them", async () => {
    const live = [
      { pid: 1, sessionId: "s", cwd: "/x", startedAt: 1, status: null, name: "", alive: true },
    ];
    const sessions = vi.fn(() => live);
    const c = stubs({ sessions });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("sessions");
    await s.tick("studio");
    await s.tick("studio");
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(vi.mocked(c.studio).mock.calls.map((call) => call[5])).toEqual([live, live]);
  });

  it("reads sessions once before the first studio tick if no sessions tick has run yet", async () => {
    const live = [
      { pid: 1, sessionId: "s", cwd: "/x", startedAt: 1, status: null, name: "", alive: true },
    ];
    const sessions = vi.fn(() => live);
    const c = stubs({ sessions });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("studio");
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(vi.mocked(c.studio).mock.calls[0]?.[5]).toEqual(live);
  });

  it("passes null sessions (no liveness check) when the registry cannot be read", async () => {
    const c = stubs({
      sessions: () => {
        throw new Error("EACCES");
      },
    });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("studio");
    expect(vi.mocked(c.studio).mock.calls[0]?.[5]).toBeNull();
    expect(row("sessions")).toMatchObject({ ok: false, error: "EACCES" });
  });

  it("reads the GitHub token once when it succeeds and reuses one gql client", async () => {
    vi.useFakeTimers();
    const c = stubs();
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    s.start();
    await s.stop(); // waits for the immediate start-up ticks
    expect(await s.tick("github")).toBe("ran");
    expect(c.githubToken).toHaveBeenCalledTimes(1);
    expect(c.makeGql).toHaveBeenCalledTimes(1);
    expect(c.makeGql).toHaveBeenCalledWith("tok", expect.any(Object));
    expect(c.github).toHaveBeenCalledTimes(2);
    expect(vi.mocked(c.github).mock.calls[0]?.[0]).toBe(config.repos[0]);
    flushEmits();
    expect(topics).toEqual(expect.arrayContaining(["boards", "escalations", "agents"]));
  });

  it("the github tick reads notifications once, for the configured repos, with the REST client", async () => {
    vi.useFakeTimers();
    const rest = vi.fn(async () => ({ status: 200, headers: new Headers(), body: [] }));
    const c = stubs({ makeRest: vi.fn(() => rest) });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("github");
    expect(c.makeRest).toHaveBeenCalledWith("tok");
    expect(c.notifications).toHaveBeenCalledTimes(1);
    expect(c.notifications).toHaveBeenCalledWith(config.repos, store, rest, NOW);
    flushEmits();
    expect(topics).toContain("attention");
  });

  it("a GitHub poll emits limits so the GitHub budget row refreshes", async () => {
    vi.useFakeTimers();
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
    await s.tick("github");
    flushEmits();
    expect(topics).toContain("limits");
  });

  it("retries a failed githubToken on each GitHub tick until it succeeds", async () => {
    const githubToken = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("gh: could not read a GitHub token (run `gh auth login`)"))
      .mockRejectedValueOnce(new Error("gh: could not read a GitHub token (run `gh auth login`)"))
      .mockResolvedValue("tok");
    const c = stubs({ githubToken });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("github");
    expect(row("github:shop-app")).toMatchObject({ ok: false });
    await s.tick("github");
    expect(c.github).not.toHaveBeenCalled();
    await s.tick("github");
    await s.tick("github");
    expect(githubToken).toHaveBeenCalledTimes(3);
    expect(c.makeGql).toHaveBeenCalledTimes(1);
    expect(c.github).toHaveBeenCalledTimes(2);
  });

  it("a missing-scope poll drops the cached client so a refreshed token is read on the next tick", async () => {
    const githubToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockResolvedValueOnce("new");
    const github = vi
      .fn<Collectors["github"]>()
      .mockRejectedValueOnce(
        new Error(`${MISSING_SCOPE_PREFIX}read:project scope: run gh auth refresh -s project`),
      )
      .mockImplementation(async (repo) => {
        store.setStatus(`github:${repo.id}`, true, null); // the real collector records its own success
        return { boards: false, escalations: false };
      });
    const c = stubs({ githubToken, github });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("github");
    expect(row("github:shop-app")).toMatchObject({ ok: false });
    await s.tick("github");
    expect(githubToken).toHaveBeenCalledTimes(2);
    expect(c.makeGql).toHaveBeenLastCalledWith("new", expect.any(Object));
    expect(row("github:shop-app")).toMatchObject({ ok: true });
  });

  it("a failing githubToken is a GitHub collector error; the other jobs keep running", async () => {
    const c = stubs({
      githubToken: vi.fn(async () => {
        throw new Error("gh: could not read a GitHub token (run `gh auth login`)");
      }),
    });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    s.start();
    await s.stop();
    await s.tick("github");
    await s.tick("ta");
    expect(row("github:shop-app")).toMatchObject({ ok: false });
    expect(row("github:shop-app")?.error).toContain("gh: could not read a GitHub token");
    expect(c.github).not.toHaveBeenCalled();
    expect(c.makeGql).not.toHaveBeenCalled();
    expect(c.ta).toHaveBeenCalledTimes(2);
    expect(c.claude).toHaveBeenCalledTimes(1);
  });

  it("does not read a GitHub token when no repos are configured", async () => {
    config.repos = [];
    config.loops = [];
    const c = stubs();
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    s.start();
    await s.stop();
    expect(c.githubToken).not.toHaveBeenCalled();
  });

  it("stores usage samples per account with status, skipping an already-stored sample", async () => {
    const samples = [sample({}), sample({ window: "7d", pct: 40, resetAt: NOW + 86400e3 })];
    const c = stubs({
      claude: vi.fn(async () => samples),
      codex: vi.fn(async (_acct, onError) => {
        onError("app-server", new Error("codex app-server timed out"));
        onError("rollout", new Error("no rollout"));
        return [];
      }),
    });
    vi.useFakeTimers();
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("usage");
    await s.tick("usage");
    flushEmits();
    expect(store.usage("claude-main", "5h", 0)).toEqual([samples[0]]);
    expect(store.usage("claude-main", "7d", 0)).toEqual([samples[1]]);
    expect(row("usage:claude-main")).toMatchObject({ ok: true, error: null });
    expect(row("usage:codex-main")).toMatchObject({ ok: false });
    expect(row("usage:codex-main")?.error).toContain("app-server: codex app-server timed out");
    expect(topics).toContain("limits");
  });

  it("notes an earlier source failure when a later source succeeds", async () => {
    const c = stubs({
      claude: vi.fn(async (_acct, onError) => {
        onError("oauth-usage", new Error("usage endpoint returned HTTP 429"));
        return [sample({}), sample({ window: "7d", pct: 40, resetAt: NOW + 86400e3 })];
      }),
    });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("usage");
    expect(row("usage:claude-main")).toMatchObject({
      ok: true,
      error: "oauth-usage: usage endpoint returned HTTP 429",
    });
  });

  it("joins source failures with a missing-window note", async () => {
    const c = stubs({
      claude: vi.fn(async (_acct, onError) => {
        onError("oauth-usage", new Error("boom"));
        return [sample({})];
      }),
    });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("usage");
    expect(row("usage:claude-main")).toMatchObject({
      ok: true,
      error: "oauth-usage: boom; no usable 7d reading",
    });
  });

  it("notes a missing window without failing the account", async () => {
    const c = stubs({ claude: vi.fn(async () => [sample({})]) });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    await s.tick("usage");
    expect(row("usage:claude-main")).toMatchObject({ ok: true, error: "no usable 7d reading" });
  });

  it("runs every job at start, then on its own interval, until stop()", async () => {
    vi.useFakeTimers();
    const c = stubs();
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.ta).toHaveBeenCalledTimes(1);
    expect(c.sessions).toHaveBeenCalledTimes(1);
    expect(c.github).toHaveBeenCalledTimes(1);
    expect(c.claude).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(c.ta).toHaveBeenCalledTimes(2);
    expect(c.studio).toHaveBeenCalledTimes(2);
    expect(c.sessions).toHaveBeenCalledTimes(2);
    expect(c.github).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(c.github).toHaveBeenCalledTimes(2);
    expect(c.claude).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(c.claude).toHaveBeenCalledTimes(2);
    await s.stop();
    const calls = vi.mocked(c.ta).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.ta).toHaveBeenCalledTimes(calls);
  });
  it("maintenance prunes run digests older than 30 days, hourly", async () => {
    expect(JOBS).toContain("maintenance");
    expect(MAINTENANCE_INTERVAL_MS).toBe(60 * 60_000);
    expect(DIGEST_RETENTION_MS).toBe(30 * 24 * 60 * 60_000);
    const prune = vi.spyOn(store, "pruneDigests");
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
    expect(await s.tick("maintenance")).toBe("ran");
    expect(prune).toHaveBeenCalledWith(NOW - 30 * 24 * 60 * 60_000);

    // An hour of fake time runs the 15 s loop ticks 240 times each; with the real crew read and
    // ack sweep behind them that took seconds, and under CI load past the test's timeout.
    vi.spyOn(hud, "crew").mockReturnValue({ rows: [], firstRunToday: null });
    vi.spyOn(hud, "attentionItems").mockReturnValue([]);
    vi.useFakeTimers();
    prune.mockClear();
    const t = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(prune).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MAINTENANCE_INTERVAL_MS - 1);
    expect(prune).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(prune).toHaveBeenCalledTimes(2);
    await t.stop();
  });

  it("maintenance prunes recorded state changes older than 30 days", async () => {
    const prune = vi.spyOn(store, "pruneAgentEvents");
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
    await s.tick("maintenance");
    expect(prune).toHaveBeenCalledWith(NOW - 30 * 24 * 60 * 60_000);
  });

  describe("state changes", () => {
    let states: Record<string, HudState>;
    let at: number;
    const fake = (id: string): CrewRow =>
      ({
        id,
        repoId: "shop-app",
        hudState: states[id],
        stop: null,
        sourceError: null,
        run: null,
        lastOutputAt: null,
      }) as unknown as CrewRow;
    beforeEach(() => {
      states = { "shop-app-ta": "running", "studio-builder": "idle" };
      at = NOW;
      vi.spyOn(hud, "crew").mockImplementation(() => ({
        rows: Object.keys(states).map(fake),
        firstRunToday: null,
      }));
    });
    const sched = () => createScheduler({ config, store, bus, now: () => at, collectors: stubs() });

    it("records running → stalled → running, and nothing for idle → running", async () => {
      const s = sched();
      await s.tick("ta");
      states["shop-app-ta"] = "stalled";
      at = NOW + 15_000;
      await s.tick("ta");
      states["shop-app-ta"] = "running";
      states["studio-builder"] = "running";
      at = NOW + 30_000;
      await s.tick("studio");
      expect(store.agentEvents(0).map((e) => [e.agentId, e.at, e.text])).toEqual([
        ["shop-app-ta", NOW + 15_000, "Running → Stalled: no output for 10 min"],
        ["shop-app-ta", NOW + 30_000, "Stalled → Running"],
      ]);
    });

    it("builds the crew rows and the attention items with the test lock's state", async () => {
      const lock = {
        holder: { runId: "r", seatId: "guido-1", command: "pnpm -s test", since: 1 },
        waiting: [],
      };
      const items = vi.spyOn(hud, "attentionItems");
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => at,
        collectors: stubs(),
        lockState: () => lock,
      });
      await s.tick("ta");
      expect(hud.crew).toHaveBeenCalledWith(config, store, NOW, lock);
      expect(items.mock.calls[0]?.[3]).toBe(lock);
    });

    describe("crew seats", () => {
      const seat = (id: string): CrewRow =>
        ({ ...fake(id), kind: "crew", loopKind: "crew" }) as unknown as CrewRow;
      const loop = (id: string): CrewRow =>
        ({ ...fake(id), kind: "loop", loopKind: "ta-loop" }) as unknown as CrewRow;
      beforeEach(() => {
        states = { "seat-guido": "idle", "shop-app-ta": "idle" };
        vi.spyOn(hud, "crew").mockImplementation(() => ({
          rows: [seat("seat-guido"), loop("shop-app-ta")],
          firstRunToday: null,
        }));
      });

      it("records a seat's idle → running → idle, and a loop's none", async () => {
        const s = sched();
        await s.tick("ta");
        states["seat-guido"] = "running";
        states["shop-app-ta"] = "running";
        at = NOW + 15_000;
        await s.tick("ta");
        states["seat-guido"] = "idle";
        states["shop-app-ta"] = "idle";
        at = NOW + 30_000;
        await s.tick("ta");
        expect(store.agentEvents(0).map((e) => [e.agentId, e.at, e.text])).toEqual([
          ["seat-guido", NOW + 15_000, "Idle → Running (your message)"],
          ["seat-guido", NOW + 30_000, "Running → Idle (turn ended)"],
        ]);
      });

      describe("between loop ticks", () => {
        // Only reads against this test's own store: a scheduler an earlier, timed-out test left
        // ticking calls the same spy with its own store.
        const crewCalls = () => vi.mocked(hud.crew).mock.calls.filter((c) => c[1] === store).length;
        /** Starts the scheduler and lets the start-up ticks' emits and their re-reads settle. */
        const started = async () => {
          vi.useFakeTimers();
          const s = sched();
          s.start();
          await vi.advanceTimersByTimeAsync(3000);
          topics.length = 0;
          return s;
        };

        it("records a seat change on the agents event, one read for a burst of events", async () => {
          const s = await started();
          const before = crewCalls();
          states["seat-guido"] = "running";
          at = NOW + 1;
          bus.emit("agents");
          bus.emit("agents");
          expect(store.agentEvents(0)).toEqual([]);
          await vi.advanceTimersByTimeAsync(1000);
          expect(crewCalls()).toBe(before + 1);
          expect(store.agentEvents(0).map((e) => e.text)).toEqual([
            "Idle → Running (your message)",
          ]);
          await s.stop();
        });

        it("announces a recorded event with one more agents emit, which finds no change and stops", async () => {
          const s = await started();
          states["seat-guido"] = "running";
          at = NOW + 1;
          bus.emit("agents");
          topics.length = 0;
          await vi.advanceTimersByTimeAsync(1000);
          expect(store.agentEvents(0)).toHaveLength(1);
          expect(topics).not.toContain("agents");
          await vi.advanceTimersByTimeAsync(EMIT_COALESCE_MS);
          expect(topics).toContain("agents");
          expect(topics).toContain("attention");
          const settled = crewCalls();
          await vi.advanceTimersByTimeAsync(1000);
          expect(crewCalls()).toBe(settled + 1);
          topics.length = 0;
          await vi.advanceTimersByTimeAsync(5000);
          expect(crewCalls()).toBe(settled + 1);
          expect(topics).not.toContain("agents");
          expect(store.agentEvents(0)).toHaveLength(1);
          await s.stop();
        });

        it("records nothing and reads nothing after stop()", async () => {
          const s = await started();
          states["seat-guido"] = "running";
          at = NOW + 1;
          bus.emit("agents");
          await vi.advanceTimersByTimeAsync(1000);
          expect(store.agentEvents(0)).toHaveLength(1);
          await s.stop();
          const after = crewCalls();
          states["seat-guido"] = "idle";
          at = NOW + 5000;
          bus.emit("agents");
          await vi.advanceTimersByTimeAsync(3000);
          expect(crewCalls()).toBe(after);
          expect(store.agentEvents(0)).toHaveLength(1);
        });

        it("stop() with the read still pending cancels it", async () => {
          const s = await started();
          const before = crewCalls();
          states["seat-guido"] = "running";
          at = NOW + 1;
          bus.emit("agents");
          await s.stop();
          await vi.advanceTimersByTimeAsync(3000);
          expect(crewCalls()).toBe(before);
          expect(store.agentEvents(0)).toEqual([]);
        });

        it("ignores topics other than agents", async () => {
          const s = await started();
          const before = crewCalls();
          states["seat-guido"] = "running";
          at = NOW + 1;
          bus.emit("health");
          bus.emit("attention");
          await vi.advanceTimersByTimeAsync(3000);
          expect(crewCalls()).toBe(before);
          expect(store.agentEvents(0)).toEqual([]);
          await s.stop();
        });

        it("records a failing crew read as scheduler:crew, and the next event still works", async () => {
          const s = await started();
          vi.mocked(hud.crew).mockImplementationOnce(() => {
            throw new Error("database is locked");
          });
          states["seat-guido"] = "running";
          at = NOW + 1;
          bus.emit("agents");
          await vi.advanceTimersByTimeAsync(1000);
          expect(row("scheduler:crew")).toMatchObject({ ok: false, error: "database is locked" });
          expect(store.agentEvents(0)).toEqual([]);
          bus.emit("agents");
          await vi.advanceTimersByTimeAsync(1000);
          expect(store.agentEvents(0).map((e) => e.text)).toEqual([
            "Idle → Running (your message)",
          ]);
          expect(row("scheduler:crew")).toMatchObject({ ok: true, error: null });
          await s.stop();
        });
      });
    });

    it("builds the crew once per tick", async () => {
      const s = sched();
      await s.tick("ta");
      expect(hud.crew).toHaveBeenCalledTimes(1);
    });

    it("a restart seeds from the table and does not record the same change twice", async () => {
      const first = sched();
      await first.tick("ta");
      states["shop-app-ta"] = "stalled";
      at = NOW + 15_000;
      await first.tick("ta");
      const second = sched();
      at = NOW + 30_000;
      await second.tick("ta");
      expect(store.agentEvents(0)).toHaveLength(1);
      states["shop-app-ta"] = "running";
      at = NOW + 45_000;
      await second.tick("ta");
      expect(store.agentEvents(0).map((e) => e.text)).toEqual([
        "Running → Stalled: no output for 10 min",
        "Stalled → Running",
      ]);
    });
  });

  it("records a failing maintenance run without throwing", async () => {
    vi.spyOn(store, "pruneDigests").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
    await expect(s.tick("maintenance")).resolves.toBe("ran");
    expect(row("scheduler:maintenance")).toMatchObject({ ok: false, error: "database is locked" });
  });

  it("emits attention whenever it emits agents or escalations, and not otherwise", async () => {
    vi.useFakeTimers();
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
    for (const job of ["ta", "studio", "github"] as const) {
      topics.length = 0;
      await s.tick(job);
      flushEmits();
      expect(topics, job).toContain("agents");
      expect(topics, job).toContain("attention");
    }
    expect(topics).toContain("escalations");
    topics.length = 0;
    await s.tick("usage");
    flushEmits();
    expect(topics).not.toContain("attention");
  });

  // #26 A1: the ta and studio ticks fire together every 15 s; the Board refetched twice for them.
  describe("emit coalescing", () => {
    it("the ta and studio ticks back to back send agents and attention once, after the window", async () => {
      vi.useFakeTimers();
      expect(EMIT_COALESCE_MS).toBe(1000);
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
      await s.tick("ta");
      await s.tick("studio");
      expect(topics).toEqual([]);
      vi.advanceTimersByTime(EMIT_COALESCE_MS - 1);
      expect(topics).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(topics.filter((t) => t === "agents")).toHaveLength(1);
      expect(topics.filter((t) => t === "attention")).toHaveLength(1);
      expect(topics.filter((t) => t === "health")).toHaveLength(1);
      // the next window starts afresh
      await s.tick("ta");
      flushEmits();
      expect(topics.filter((t) => t === "agents")).toHaveLength(2);
    });

    it("a GitHub poll that changed no row emits no boards or escalations; one that did, does", async () => {
      vi.useFakeTimers();
      const github = vi
        .fn<Collectors["github"]>()
        .mockResolvedValueOnce({ boards: false, escalations: false })
        .mockResolvedValueOnce({ boards: true, escalations: false })
        .mockResolvedValueOnce({ boards: false, escalations: true });
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({ github }),
      });
      await s.tick("github");
      flushEmits();
      expect(topics).not.toContain("boards");
      expect(topics).not.toContain("escalations");
      expect(topics).toEqual(expect.arrayContaining(["agents", "health"]));
      topics.length = 0;
      await s.tick("github");
      flushEmits();
      expect(topics).toContain("boards");
      expect(topics).not.toContain("escalations");
      topics.length = 0;
      await s.tick("github");
      flushEmits();
      expect(topics).not.toContain("boards");
      expect(topics).toEqual(expect.arrayContaining(["escalations", "attention"]));
    });

    it("a PR sweep that changed no row emits no boards", async () => {
      vi.useFakeTimers();
      const prSweep = vi
        .fn<Collectors["prSweep"]>()
        .mockResolvedValue({ boards: false, escalations: false });
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({ prSweep }),
      });
      await s.tick("prs");
      flushEmits();
      expect(topics).not.toContain("boards");
    });

    it("stop() sends what is queued and leaves no timer behind", async () => {
      vi.useFakeTimers();
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
      await s.tick("ta");
      expect(topics).toEqual([]);
      await s.stop();
      expect(topics).toEqual(expect.arrayContaining(["agents", "health", "attention"]));
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // Review Focus 5
  it("after loop ticks and GitHub polls, drops acks whose key has been absent over 7 days", async () => {
    store.replaceEscalations("shop-app", [
      {
        id: "shop-app#9",
        repoId: "shop-app",
        issueNumber: 9,
        title: "[operator-decision] pick",
        kind: "operator-decision",
        source: "title",
        openedAt: NOW - 3600e3,
        url: "https://github.com/o/shop-app/issues/9",
        question: null,
      },
    ]);
    store.ack(["esc:shop-app#9", "esc:gone"], NOW - 30 * 86_400_000);
    let t = NOW;
    const s = createScheduler({ config, store, bus, now: () => t, collectors: stubs() });
    await s.tick("ta");
    t = NOW + ACK_ABSENT_MS;
    await s.tick("studio");
    expect([...store.acks().keys()].sort()).toEqual(["esc:gone", "esc:shop-app#9"]);
    t = NOW + ACK_ABSENT_MS + 1;
    await s.tick("github");
    expect([...store.acks().keys()]).toEqual(["esc:shop-app#9"]);
  });

  it("the studio tick alone drops an ack absent over 7 days", async () => {
    store.ack(["esc:gone"], NOW);
    let t = NOW;
    const s = createScheduler({ config, store, bus, now: () => t, collectors: stubs() });
    await s.tick("studio");
    t = NOW + ACK_ABSENT_MS + 1;
    await s.tick("studio");
    expect(store.acks().has("esc:gone")).toBe(false);
  });

  it("does not sweep acks from the usage or machine jobs", async () => {
    store.ack(["esc:gone"], NOW);
    const sweep = vi.spyOn(store, "sweepAcks");
    const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
    await s.tick("usage");
    await s.tick("machine");
    await s.tick("maintenance");
    expect(sweep).not.toHaveBeenCalled();
    await s.tick("ta");
    expect(sweep).toHaveBeenCalledWith(new Set(), NOW);
  });

  describe("machine job", () => {
    it("passes the current test-lock command to the collector, or null when free", async () => {
      let lock: TestLockState = {
        holder: { runId: "r", seatId: "guido-1", command: "pnpm -s test", since: 0 },
        waiting: [],
      };
      const c = stubs();
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: c,
        lockState: () => lock,
      });
      await s.tick("machine");
      expect(c.machine).toHaveBeenLastCalledWith(null, null, NOW, "pnpm -s test");

      lock = hud.NO_LOCK;
      const prev = s.machine();
      await s.tick("machine");
      expect(c.machine).toHaveBeenLastCalledWith([], prev, NOW, null);
    });

    it("runs every 2 s, keeps the latest sample in memory and emits machine", async () => {
      vi.useFakeTimers();
      expect(JOBS).toContain("machine");
      expect(MACHINE_INTERVAL_MS).toBe(2000);
      let t = NOW;
      const c = stubs();
      const s = createScheduler({ config, store, bus, now: () => t, collectors: c });
      expect(s.machine()).toBeNull();
      await s.tick("machine");
      expect(s.machine()).toMatchObject({ at: NOW, cpuPct: null });
      flushEmits();
      expect(topics).toContain("machine");
      t += 2000;
      await s.tick("machine");
      expect(s.machine()).toMatchObject({ at: NOW + 2000, cpuPct: 5 });
      // The previous sample is handed back to the collector.
      expect(vi.mocked(c.machine).mock.calls[1]?.[1]).toMatchObject({ at: NOW });

      const calls = vi.mocked(c.machine).mock.calls.length;
      const u = createScheduler({ config, store, bus, now: () => t, collectors: c });
      u.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(c.machine).toHaveBeenCalledTimes(calls + 1);
      await vi.advanceTimersByTimeAsync(MACHINE_INTERVAL_MS - 1);
      expect(c.machine).toHaveBeenCalledTimes(calls + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(c.machine).toHaveBeenCalledTimes(calls + 2);
      await u.stop();
    });

    it("writes the first sample of each minute to the store, not every tick", async () => {
      const minute = Math.floor(NOW / 60_000) * 60_000;
      let t = minute + 1000;
      const add = vi.spyOn(store, "addMachineSample");
      const s = createScheduler({ config, store, bus, now: () => t, collectors: stubs() });
      for (let i = 0; i < 29; i++) {
        await s.tick("machine");
        t += 2000;
      }
      // 29 ticks from +1 s to +57 s: all in one minute.
      expect(add).toHaveBeenCalledTimes(1);
      await s.tick("machine"); // +59 s
      t += 2000;
      await s.tick("machine"); // +61 s: next minute
      expect(add).toHaveBeenCalledTimes(2);
      expect(store.machineSamples(0).map((m) => m.at)).toEqual([minute + 1000, minute + 61_000]);
    });

    it("raises one machine-capacity item and closes it after five minutes of headroom", async () => {
      const minute = Math.floor(NOW / 60_000) * 60_000;
      let t = minute + 1000;
      let tight = true;
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => t,
        collectors: stubs({
          machine: vi.fn(async (_p, _prev, at) => ({
            sample: machineSample({
              at,
              diskFreeBytes: tight ? 14 * 1024 ** 3 : 20 * 1024 ** 3,
              diskTotalBytes: 100 * 1024 ** 3,
              swapUsedBytes: (tight ? 18 : 1) * 1024 ** 3,
              swapTotalBytes: 20 * 1024 ** 3,
              memoryPressureFreePct: tight ? 8 : 20,
              load1: tight ? 15 : 1,
              topConsumers: [{ pid: 42, command: "Docker", rssBytes: 4 * 1024 ** 3, cpuPct: 90 }],
              agents: { count: 2, rssBytes: 3 * 1024 ** 3, cpuPct: 10 },
            }),
            cpus: [],
            errors: [],
          })),
        }),
      });
      await s.tick("machine");
      expect(store.notes().find((n) => n.key === "machine-capacity")?.text).toContain(
        "Disk: 14.0 GB free (14.0%). Swap: 18.0 GB / 20.0 GB used (90.0%). Memory pressure free: 8.0%. Load: 15.0 on 8 cores. Top consumers: Docker (pid 42, 4.0 GB, 90.0% CPU)",
      );
      tight = false;
      t += 5 * 60_000 + 1;
      await s.tick("machine");
      expect(store.notes().find((n) => n.key === "machine-capacity")).toBeUndefined();
    });

    it.each([
      ["absolute disk", { diskFreeBytes: 14 * 1024 ** 3 }, "disk free is 14.0 GB"],
      [
        "percentage disk",
        { diskFreeBytes: 20 * 1024 ** 3, diskTotalBytes: 500 * 1024 ** 3 },
        "disk free is 4.0%",
      ],
      ["swap", { swapUsedBytes: 86, swapTotalBytes: 100 }, "swap is 86.0% used"],
      ["memory", { memoryPressureFreePct: 9 }, "memory free is 9.0%"],
    ])("raises exactly one capacity item for %s", async (_name, over, reason) => {
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({
          machine: vi.fn(async (_p, _prev, at) => ({
            sample: machineSample({
              at,
              diskFreeBytes: 20 * 1024 ** 3,
              diskTotalBytes: 100 * 1024 ** 3,
              swapUsedBytes: 1,
              swapTotalBytes: 100,
              memoryPressureFreePct: 20,
              load1: 1,
              ...over,
            }),
            cpus: [],
            errors: [],
          })),
        }),
      });
      await s.tick("machine");
      const notes = store.notes().filter((n) => n.key === "machine-capacity");
      expect(notes).toHaveLength(1);
      expect(notes[0]?.text).toContain(reason);
    });

    it("refreshes one capacity item when the active threshold and consumers change", async () => {
      let t = NOW;
      let disk = true;
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => t,
        collectors: stubs({
          machine: vi.fn(async (_p, _prev, at) => ({
            sample: machineSample({
              at,
              diskFreeBytes: disk ? 14 * 1024 ** 3 : 20 * 1024 ** 3,
              diskTotalBytes: 100 * 1024 ** 3,
              swapUsedBytes: disk ? 1 : 18,
              swapTotalBytes: 20,
              memoryPressureFreePct: 20,
              load1: 1,
              topConsumers: [
                {
                  pid: disk ? 1 : 2,
                  command: disk ? "Docker" : "node",
                  rssBytes: 4 * 1024 ** 3,
                  cpuPct: 90,
                },
              ],
            }),
            cpus: [],
            errors: [],
          })),
        }),
      });
      await s.tick("machine");
      disk = false;
      t += 60_000;
      await s.tick("machine");
      const notes = store.notes().filter((n) => n.key === "machine-capacity");
      expect(notes).toHaveLength(1);
      expect(notes[0]?.text).toContain("swap is 90.0% used");
      expect(notes[0]?.text).toContain("node (pid 2");
    });

    it("writes collector status when ok/error changes and otherwise once a minute", async () => {
      let t = NOW;
      let errors: string[] = [];
      const c = stubs({
        machine: vi.fn(async (_p, _prev, now) => ({
          sample: machineSample({ at: now }),
          cpus: [],
          errors,
        })),
      });
      const set = vi.spyOn(store, "setStatus");
      const s = createScheduler({ config, store, bus, now: () => t, collectors: c });
      await s.tick("machine");
      expect(set).toHaveBeenCalledTimes(1);
      expect(row(MACHINE_COLLECTOR)).toMatchObject({ ok: true, error: null });
      for (let i = 0; i < 5; i++) {
        t += 2000;
        await s.tick("machine");
      }
      expect(set).toHaveBeenCalledTimes(1); // unchanged: not every tick
      errors = ["ps: boom"];
      t += 2000;
      await s.tick("machine");
      expect(set).toHaveBeenCalledTimes(2);
      expect(row(MACHINE_COLLECTOR)).toMatchObject({ ok: false, error: "ps: boom" });
      errors = ["ps: boom", "disk: EIO"]; // a different error text is a change
      t += 2000;
      await s.tick("machine");
      expect(set).toHaveBeenCalledTimes(3);
      t += MACHINE_STATUS_MS - 2000;
      await s.tick("machine"); // 58 s after the last write: not yet
      expect(set).toHaveBeenCalledTimes(3);
      t += 2000;
      await s.tick("machine"); // a minute: refreshed
      expect(set).toHaveBeenCalledTimes(4);
    });

    it("records a throwing collector as scheduler:machine without throwing", async () => {
      const c = stubs({
        machine: vi.fn(async () => {
          throw new Error("spawn failed");
        }),
      });
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
      await expect(s.tick("machine")).resolves.toBe("ran");
      expect(row("scheduler:machine")).toMatchObject({ ok: false, error: "spawn failed" });
      expect(s.machine()).toBeNull();
    });
  });

  describe("prs job", () => {
    it("sweeps every repo, emits boards, and records a token failure as the sweep status", async () => {
      vi.useFakeTimers();
      const c = stubs();
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
      expect(JOBS).toContain("prs");
      await s.tick("prs");
      flushEmits();
      expect(c.prSweep).toHaveBeenCalledTimes(1);
      expect(vi.mocked(c.prSweep).mock.calls[0]?.[0]).toBe(config.repos[0]);
      expect(topics).toContain("boards");

      const bad = stubs({
        githubToken: vi.fn(async () => {
          throw new Error("gh: no token");
        }),
      });
      const s2 = createScheduler({ config, store, bus, now: () => NOW, collectors: bad });
      await s2.tick("prs");
      expect(bad.prSweep).not.toHaveBeenCalled();
      expect(row("github:shop-app:prs")).toMatchObject({ ok: false, error: "gh: no token" });
    });

    it("first runs 5 minutes after start(), then hourly; the other jobs run at once", async () => {
      vi.useFakeTimers();
      const c = stubs();
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
      s.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(c.github).toHaveBeenCalledTimes(1);
      expect(c.prSweep).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(PR_SWEEP_FIRST_DELAY_MS - 1);
      expect(c.prSweep).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(c.prSweep).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PR_SWEEP_MS - PR_SWEEP_FIRST_DELAY_MS);
      expect(c.prSweep).toHaveBeenCalledTimes(2);
      await s.stop();
      await vi.advanceTimersByTimeAsync(PR_SWEEP_MS);
      expect(c.prSweep).toHaveBeenCalledTimes(2);
    });
  });

  describe("engine job", () => {
    it("leaves a hung loop's heartbeat unchanged, then refreshes it on completion", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const s = createScheduler({ config, store, bus, now: Date.now, collectors: stubs() });
      const e = hooks();
      let release = () => {};
      e.tick.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            release = () => resolve(undefined);
          }),
      );
      s.setEngine(e);
      s.start();
      await vi.advanceTimersByTimeAsync(ENGINE_FIRST_DELAY_MS);
      const heartbeat = () => JSON.parse(store.getSetting(FLIGHT_LOOPS_SETTING) ?? "{}").engine;
      const first = heartbeat();
      await vi.advanceTimersByTimeAsync(2 * ENGINE_TICK_MS);
      expect(heartbeat()).toEqual(first);
      expect(Date.now() - first.at).toBeGreaterThanOrEqual(2 * first.interval);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeat().at).toBe(Date.now());
      await s.stop();
      expect(store.getSetting(FLIGHT_LOOPS_SETTING)).toBe("{}");
    });

    const hooks = () => ({
      tick: vi.fn(async () => undefined),
      reconcileRepo: vi.fn(async () => undefined),
    });

    it("does nothing until the engine is set, then ticks it", async () => {
      const c = stubs();
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
      expect(JOBS).toContain("engine");
      await expect(s.tick("engine")).resolves.toBe("ran");
      await s.tick("github");
      const e = hooks();
      s.setEngine(e);
      await s.tick("engine");
      expect(e.tick).toHaveBeenCalledTimes(1);
    });

    it("reconciles each repo's looped runs after a GitHub poll", async () => {
      const c = stubs();
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
      const e = hooks();
      s.setEngine(e);
      await s.tick("github");
      expect(e.reconcileRepo.mock.calls).toEqual([["shop-app"]]);
    });

    it("first ticks 30 seconds after start(), then every minute", async () => {
      vi.useFakeTimers();
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
      const e = hooks();
      s.setEngine(e);
      s.start();
      await vi.advanceTimersByTimeAsync(ENGINE_FIRST_DELAY_MS - 1);
      expect(e.tick).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(e.tick).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(ENGINE_TICK_MS - ENGINE_FIRST_DELAY_MS);
      expect(e.tick).toHaveBeenCalledTimes(2);
      await s.stop();
    });
  });

  describe("update job", () => {
    it("has no timer without an auto-update check, and runs it every 10 minutes with one", async () => {
      vi.useFakeTimers();
      const none = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
      expect(JOBS).toContain("update");
      none.start();
      await vi.advanceTimersByTimeAsync(VERSION_CHECK_MS);
      await none.stop();
      const autoUpdate = vi.fn(async () => "waiting");
      const s = createScheduler({
        config: { ...config, updates: { hub: "auto", cli: "off" } },
        store,
        bus,
        now: () => NOW,
        collectors: stubs(),
        autoUpdate,
      });
      s.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(autoUpdate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(VERSION_CHECK_MS);
      expect(autoUpdate).toHaveBeenCalledTimes(2);
      await s.stop();
    });

    it("never runs the check with updates.hub off, timer or direct tick", async () => {
      vi.useFakeTimers();
      const autoUpdate = vi.fn(async () => "waiting");
      const s = createScheduler({
        config: { ...config, updates: { hub: "off", cli: "off" } },
        store,
        bus,
        now: () => NOW,
        collectors: stubs(),
        autoUpdate,
      });
      s.start();
      await vi.advanceTimersByTimeAsync(VERSION_CHECK_MS);
      await s.tick("update");
      expect(autoUpdate).not.toHaveBeenCalled();
      await s.stop();
    });
  });

  describe("flow job", () => {
    it("runs the flow collector per repo and records a token failure as flow:<repo>", async () => {
      const c = stubs();
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
      expect(JOBS).toContain("flow");
      await s.tick("flow");
      expect(c.flow).toHaveBeenCalledTimes(1);
      expect(vi.mocked(c.flow).mock.calls[0]?.[0]).toBe(config.repos[0]);

      const bad = stubs({
        githubToken: vi.fn(async () => {
          throw new Error("gh: no token");
        }),
      });
      const s2 = createScheduler({ config, store, bus, now: () => NOW, collectors: bad });
      await s2.tick("flow");
      expect(bad.flow).not.toHaveBeenCalled();
      expect(row("flow:shop-app")).toMatchObject({ ok: false, error: "gh: no token" });
    });

    it("first runs 7 minutes after start(), after the first PR sweep, then hourly", async () => {
      expect(FLOW_FIRST_DELAY_MS).toBe(7 * 60_000);
      expect(FLOW_FIRST_DELAY_MS).toBeGreaterThan(PR_SWEEP_FIRST_DELAY_MS);
      vi.useFakeTimers();
      const c = stubs();
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
      s.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(c.flow).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(FLOW_FIRST_DELAY_MS - 1);
      expect(c.flow).not.toHaveBeenCalled();
      expect(c.prSweep).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(c.flow).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(FLOW_INTERVAL_MS - FLOW_FIRST_DELAY_MS);
      expect(c.flow).toHaveBeenCalledTimes(2);
      await s.stop();
    });
  });

  describe("backfill job", () => {
    it("runs one budgeted job per tick: summaries, then titles, then the fold backfill", async () => {
      vi.useFakeTimers();
      const rewriteSummaries = vi
        .fn<Collectors["rewriteSummaries"]>()
        .mockReturnValueOnce({ rewritten: 4, done: false })
        .mockReturnValueOnce({ rewritten: 2, done: true });
      const fillTitles = vi
        .fn<Collectors["fillTitles"]>()
        .mockResolvedValueOnce({ filled: 3, done: false })
        .mockResolvedValueOnce({ filled: 1, done: true });
      const backfill = vi.fn<Collectors["backfill"]>(() => ({ folded: 0, left: 0, failed: 0 }));
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({ rewriteSummaries, fillTitles, backfill }),
      });
      await s.tick("backfill");
      await s.tick("backfill"); // the tick that finishes the rewrite does not also fold
      expect(rewriteSummaries).toHaveBeenCalledTimes(2);
      expect(fillTitles).not.toHaveBeenCalled();
      expect(backfill).not.toHaveBeenCalled();
      await s.tick("backfill");
      await s.tick("backfill"); // the tick that finishes the titles does not also fold
      expect(fillTitles).toHaveBeenCalledTimes(2);
      expect(backfill).not.toHaveBeenCalled();
      await s.tick("backfill");
      expect(backfill).toHaveBeenCalledTimes(1);
      await s.tick("backfill");
      expect(rewriteSummaries).toHaveBeenCalledTimes(2); // done: not asked again
      expect(fillTitles).toHaveBeenCalledTimes(2);
    });

    it("rewrites past crew summaries first, one budgeted slice per tick, until done", async () => {
      vi.useFakeTimers();
      const rewriteSummaries = vi
        .fn<Collectors["rewriteSummaries"]>()
        .mockReturnValueOnce({ rewritten: 4, done: false })
        .mockReturnValueOnce({ rewritten: 2, done: true });
      const backfill = vi.fn<Collectors["backfill"]>(() => ({ folded: 0, left: 0, failed: 0 }));
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({ rewriteSummaries, backfill }),
      });
      await s.tick("backfill");
      expect(rewriteSummaries).toHaveBeenCalledWith({
        config,
        store,
        budgetMs: BACKFILL_BUDGET_MS,
      });
      expect(backfill).not.toHaveBeenCalled();
      await s.tick("backfill");
      expect(backfill).not.toHaveBeenCalled(); // finishing the rewrite spent the tick
      await s.tick("backfill");
      expect(backfill).toHaveBeenCalledTimes(1);
      await s.tick("backfill");
      expect(rewriteSummaries).toHaveBeenCalledTimes(2); // done: not asked again
    });

    it("reads older runs with its budget, before the fold window, and notes how many are left", async () => {
      expect(JOBS).toContain("backfill");
      expect(BACKFILL_BUDGET_MS).toBe(1500);
      vi.useFakeTimers();
      const backfill = vi
        .fn<Collectors["backfill"]>()
        .mockReturnValueOnce({ folded: 3, left: 7, failed: 0 })
        .mockReturnValueOnce({ folded: 0, left: 7, failed: 0 })
        .mockReturnValueOnce({ folded: 7, left: 0, failed: 0 });
      const debug = vi.fn<(line: string) => void>();
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({ backfill }),
        debug,
      });
      await s.tick("backfill");
      flushEmits();
      expect(debug).toHaveBeenCalledWith(
        expect.stringMatching(/^backfill: 3 runs in \d+ ms, 7 left$/),
      );
      expect(backfill).toHaveBeenCalledWith({
        config,
        store,
        now: NOW,
        budgetMs: BACKFILL_BUDGET_MS,
      });
      expect(row(BACKFILL_COLLECTOR)).toMatchObject({
        ok: true,
        error: "7 older runs left to read",
      });
      expect(topics).toContain("agents");

      topics.length = 0;
      await s.tick("backfill");
      flushEmits();
      expect(topics).toEqual([]);
      expect(row(BACKFILL_COLLECTOR)).toMatchObject({ error: "7 older runs left to read" });

      await s.tick("backfill");
      flushEmits();
      expect(row(BACKFILL_COLLECTOR)).toMatchObject({ ok: true, error: null });
      expect(topics).toContain("agents");
    });

    it("notes how many runs failed to read this tick", async () => {
      const backfill = vi
        .fn<Collectors["backfill"]>()
        .mockReturnValueOnce({ folded: 3, left: 5, failed: 1 })
        .mockReturnValueOnce({ folded: 2, left: 3, failed: 0 })
        .mockReturnValueOnce({ folded: 3, left: 0, failed: 2 });
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({ backfill }),
      });
      await s.tick("backfill");
      expect(row(BACKFILL_COLLECTOR)).toMatchObject({
        ok: true,
        error: "5 older runs left to read · 1 failed",
      });
      await s.tick("backfill");
      expect(row(BACKFILL_COLLECTOR)).toMatchObject({ error: "3 older runs left to read" });
      await s.tick("backfill");
      expect(row(BACKFILL_COLLECTOR)).toMatchObject({
        error: "0 older runs left to read · 2 failed",
      });
    });

    it("once done, returns after one countToFold query until older runs appear again", async () => {
      const backfill = vi.fn<Collectors["backfill"]>(() => ({ folded: 0, left: 0, failed: 0 }));
      const count = vi.spyOn(store, "countToFold");
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({ backfill }),
      });
      await s.tick("backfill");
      expect(backfill).toHaveBeenCalledTimes(1);
      await s.tick("backfill");
      await s.tick("backfill");
      expect(backfill).toHaveBeenCalledTimes(1);
      expect(count).toHaveBeenCalledTimes(2);
      expect(count).toHaveBeenLastCalledWith(NOW - FOLD_WINDOW_MS);
      count.mockReturnValueOnce(4);
      await s.tick("backfill");
      expect(backfill).toHaveBeenCalledTimes(2);
    });

    it("records a throwing backfill as its status without throwing", async () => {
      const backfill = vi.fn<Collectors["backfill"]>(() => {
        throw new Error("database is locked");
      });
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({ backfill }),
      });
      await expect(s.tick("backfill")).resolves.toBe("ran");
      expect(row(BACKFILL_COLLECTOR)).toMatchObject({ ok: false, error: "database is locked" });
    });

    it("first runs a minute after start(), then every 30 s", async () => {
      expect(BACKFILL_FIRST_DELAY_MS).toBe(60_000);
      expect(BACKFILL_INTERVAL_MS).toBe(30_000);
      vi.useFakeTimers();
      const backfill = vi.fn<Collectors["backfill"]>(() => ({ folded: 1, left: 1, failed: 0 }));
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({ backfill }),
      });
      s.start();
      await vi.advanceTimersByTimeAsync(BACKFILL_FIRST_DELAY_MS - 1);
      expect(backfill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(backfill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(BACKFILL_INTERVAL_MS);
      expect(backfill).toHaveBeenCalledTimes(2);
      await s.stop();
    });
  });

  describe("GitHub back-off near the rate limit", () => {
    const RESET = NOW + 600_000;
    const SECOND = 1000;

    /** A github collector that reads `remaining()` into the scheduler's rate sink on each run. */
    function withRemaining(remaining: () => number) {
      let rates: RateLimits | undefined;
      const makeGql = vi.fn((_token: string, r: RateLimits) => {
        rates = r;
        return async () => ({});
      });
      const github = vi.fn<Collectors["github"]>(async (repo, st) => {
        rates?.record("Board", {
          cost: 1,
          limit: 5000,
          remaining: remaining(),
          resetAt: RESET,
          at: Date.now(),
        });
        st.setStatus(`github:${repo.id}`, true, null);
        return { boards: false, escalations: false };
      });
      return { collectors: stubs({ makeGql, github }), github };
    }

    it("doubles the interval up to 8x while below 10% of the budget, and ends at the reset", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      let remaining = 400;
      const { collectors, github } = withRemaining(() => remaining);
      const s = createScheduler({ config, store, bus, now: () => Date.now(), collectors });
      const runs = async (afterMs: number) => {
        await vi.advanceTimersByTimeAsync(afterMs);
        return github.mock.calls.length;
      };
      s.start();
      expect(await runs(0)).toBe(1); // first run at start(); the reading is low -> next in 2x
      expect(await runs(60 * SECOND)).toBe(1);
      expect(await runs(60 * SECOND)).toBe(2); // 120 s; still low -> next in 4x
      expect(await runs(239 * SECOND)).toBe(2);
      expect(await runs(1 * SECOND)).toBe(3); // 360 s; still low -> next in 8x
      expect(await runs(239 * SECOND)).toBe(3); // 599 s: 8x would wait until 840 s
      remaining = 5000;
      expect(await runs(1 * SECOND)).toBe(4); // 600 s: the reset ends the back-off early
      expect(await runs(60 * SECOND)).toBe(5); // and the next run is at the configured interval
      await s.stop();
    });

    it("ends at the reset of the reading that caused it, not a later reading from another job", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      let rates: RateLimits | undefined;
      const github = vi.fn<Collectors["github"]>(async () => {
        rates?.record("Board", {
          cost: 1,
          limit: 5000,
          remaining: 400,
          resetAt: RESET,
          at: Date.now(),
        });
        return { boards: false, escalations: false };
      });
      const makeGql = vi.fn((_t: string, r: RateLimits) => {
        rates = r;
        return async () => ({});
      });
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => Date.now(),
        collectors: stubs({ makeGql, github }),
      });
      const runs = async (afterMs: number) => {
        await vi.advanceTimersByTimeAsync(afterMs);
        return github.mock.calls.length;
      };
      s.start();
      expect(await runs(0)).toBe(1);
      expect(await runs(120 * SECOND)).toBe(2);
      expect(await runs(240 * SECOND)).toBe(3); // 360 s: next in 8x, at 840 s
      expect(await runs(239 * SECOND)).toBe(3); // 599 s
      // the hourly PR sweep sees a fresh window, whose reset is an hour on
      rates?.record("PullRequests", {
        cost: 1,
        limit: 5000,
        remaining: 5000,
        resetAt: RESET + 3_600_000,
        at: Date.now(),
      });
      expect(await runs(1 * SECOND)).toBe(4); // 600 s: the first reset still ends the back-off
      await s.stop();
    });

    describe("a PR sweep reading that lands in the middle of a poll", () => {
      /** A github run that reads low (reset RESET), then the sweep's reading `mid` lands before it ends. */
      function pollWithSweepReading(mid: { remaining: number; resetAt: number }) {
        let rates: RateLimits | undefined;
        const github = vi.fn<Collectors["github"]>(async () => {
          rates?.record("Board", {
            cost: 1,
            limit: 5000,
            remaining: 400,
            resetAt: RESET,
            at: Date.now(),
          });
          rates?.record("PullRequests", { cost: 1, limit: 5000, ...mid, at: Date.now() });
          return { boards: false, escalations: false };
        });
        const makeGql = vi.fn((_t: string, r: RateLimits) => {
          rates = r;
          return async () => ({});
        });
        const s = createScheduler({
          config,
          store,
          bus,
          now: () => Date.now(),
          collectors: stubs({ makeGql, github }),
        });
        return { s, github };
      }

      it("does not move the reset the back-off ends at", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        const { s, github } = pollWithSweepReading({
          remaining: 300,
          resetAt: RESET + 3_600_000,
        });
        s.start();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(120 * SECOND); // run 2 (2x); then 4x until 360 s
        await vi.advanceTimersByTimeAsync(240 * SECOND); // run 3; then 8x until 840 s
        expect(github).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(239 * SECOND); // 599 s
        expect(github).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1 * SECOND); // 600 s: the poll's own reset
        expect(github).toHaveBeenCalledTimes(4);
        await s.stop();
      });

      it("does not hide the low reading that caused the back-off", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        const { s, github } = pollWithSweepReading({
          remaining: 5000,
          resetAt: RESET + 3_600_000,
        });
        s.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(github).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60 * SECOND);
        expect(github).toHaveBeenCalledTimes(1); // still backed off: next run at 120 s
        await vi.advanceTimersByTimeAsync(60 * SECOND);
        expect(github).toHaveBeenCalledTimes(2);
        await s.stop();
      });
    });

    it("backs off one 8x interval when a low reading carries no reset time", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      let rates: RateLimits | undefined;
      const github = vi.fn<Collectors["github"]>(async () => {
        rates?.record("Board", {
          cost: 1,
          limit: 5000,
          remaining: 10,
          resetAt: 0,
          at: Date.now(),
        });
        return { boards: false, escalations: false };
      });
      const makeGql = vi.fn((_t: string, r: RateLimits) => {
        rates = r;
        return async () => ({});
      });
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => Date.now(),
        collectors: stubs({ makeGql, github }),
      });
      s.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(github).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(479 * SECOND);
      expect(github).toHaveBeenCalledTimes(1); // 8x of 60 s is 480 s: the ticks before it skip
      await vi.advanceTimersByTimeAsync(1 * SECOND);
      expect(github).toHaveBeenCalledTimes(2);
      await s.stop();
    });

    it("keeps the collector's other notes and never adds the slowed note twice", async () => {
      let rates: RateLimits | undefined;
      let runs = 0;
      const github = vi.fn<Collectors["github"]>(async (repo, st) => {
        rates?.record("Board", {
          cost: 1,
          limit: 5000,
          remaining: 400,
          resetAt: RESET,
          at: NOW,
        });
        // only the first run writes the collector's status; later runs leave the slowed note in place
        if (runs++ === 0) {
          st.setStatus(`github:${repo.id}`, true, "truncated: search hit the page bound");
        }
        return { boards: false, escalations: false };
      });
      const makeGql = vi.fn((_t: string, r: RateLimits) => {
        rates = r;
        return async () => ({});
      });
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({ makeGql, github }),
      });
      const expected =
        "truncated: search hit the page bound; slowed: rate limit low (400 left, resets 13:10)";
      await s.tick("github");
      expect(row("github:shop-app")?.error).toBe(expected);
      await s.tick("github");
      expect(row("github:shop-app")?.error).toBe(expected);
    });

    it("never goes past 8x the configured interval", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const far = NOW + 100 * 60_000;
      let rates: RateLimits | undefined;
      const github = vi.fn<Collectors["github"]>(async () => {
        rates?.record("Board", {
          cost: 1,
          limit: 5000,
          remaining: 10,
          resetAt: far,
          at: Date.now(),
        });
        return { boards: false, escalations: false };
      });
      const makeGql = vi.fn((_t: string, r: RateLimits) => {
        rates = r;
        return async () => ({});
      });
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => Date.now(),
        collectors: stubs({ makeGql, github }),
      });
      s.start();
      // runs at 0, 2, 6, 14 min (gaps 2x, 4x, 8x), then every 8 min
      await vi.advanceTimersByTimeAsync(14 * 60 * SECOND);
      expect(github).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(7 * 60 * SECOND);
      expect(github).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(60 * SECOND);
      expect(github).toHaveBeenCalledTimes(5);
      await s.stop();
    });

    it("says so on the GitHub collector while slowed, with what is left and when it resets", async () => {
      const { collectors } = withRemaining(() => 400);
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors });
      await s.tick("github");
      expect(row("github:shop-app")).toMatchObject({
        ok: true,
        error: "slowed: rate limit low (400 left, resets 13:10)", // 12:10 UTC is 13:10 in London
      });
    });

    it("builds the slowed note from the core prefix", async () => {
      const { collectors } = withRemaining(() => 400);
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors });
      await s.tick("github");
      expect(row("github:shop-app")?.error?.startsWith(GITHUB_SLOWED_PREFIX)).toBe(true);
    });

    it("leaves the collector note alone when the limit is not low", async () => {
      const { collectors } = withRemaining(() => 500);
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors });
      await s.tick("github");
      expect(row("github:shop-app")?.error).toBeNull();
    });

    it("keeps a failure the collector recorded and does not add the note to it", async () => {
      let rates: RateLimits | undefined;
      const github = vi.fn<Collectors["github"]>(async (repo, st) => {
        rates?.record("Board", { cost: 1, limit: 5000, remaining: 1, resetAt: RESET, at: NOW });
        st.setStatus(`github:${repo.id}`, false, "board: boom");
        return { boards: false, escalations: false };
      });
      const makeGql = vi.fn((_t: string, r: RateLimits) => {
        rates = r;
        return async () => ({});
      });
      const s = createScheduler({
        config,
        store,
        bus,
        now: () => NOW,
        collectors: stubs({ makeGql, github }),
      });
      await s.tick("github");
      expect(row("github:shop-app")).toMatchObject({ ok: false, error: "board: boom" });
    });
  });
});

describe("board and PR cadence", () => {
  const MIN = 60_000;
  const githubPrs = () =>
    vi.fn<Collectors["githubPrs"]>(async () => ({ boards: false, escalations: false }));

  it.each(["github", "prs"] as const)(
    "follows PRs for every repo after a changed %s poll",
    async (job) => {
      config.repos.push({ ...config.repos[0], id: "other", github: "o/other" });
      const c = stubs();
      const s = createScheduler({ config, store, bus, now: () => NOW, collectors: c });
      await s.tick(job);
      expect(vi.mocked(c.followPrs).mock.calls.map((call) => call[1])).toEqual([
        "shop-app",
        "other",
      ]);
      const poll = job === "github" ? c.github : c.prSweep;
      expect(vi.mocked(poll).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(c.followPrs).mock.invocationCallOrder[0],
      );
      await s.stop();
    },
  );

  it("follows PRs after a waited PR poll and emits a board move", async () => {
    vi.useFakeTimers({ now: NOW });
    config.poll = { usageMinutes: 30, githubSeconds: 60, boardMinutes: 15 };
    const c = stubs({ followPrs: vi.fn(async () => true) });
    const s = createScheduler({
      config,
      store,
      bus,
      now: Date.now,
      collectors: c,
      waitedPrs: () => [7],
    });
    await s.tick("github");
    flushEmits();
    topics.length = 0;
    vi.mocked(c.followPrs).mockClear();
    await s.tick("github");
    expect(c.githubPrs).toHaveBeenCalledTimes(1);
    expect(c.followPrs).toHaveBeenCalledTimes(1);
    flushEmits();
    expect(topics).toContain("boards");
    await s.stop();
  });

  function cadence(over: { waited?: (repoId: string) => number[] } = {}) {
    vi.useFakeTimers({ now: NOW });
    config.poll = { usageMinutes: 30, githubSeconds: 60, boardMinutes: 15 };
    const prs = githubPrs();
    const collectors = stubs({ githubPrs: prs });
    const s = createScheduler({
      config,
      store,
      bus,
      now: Date.now,
      collectors,
      waitedPrs: over.waited ?? (() => []),
    });
    return { s, prs, github: collectors.github as ReturnType<typeof vi.fn> };
  }

  it("with board_minutes 15 reads the boards once at start, then not for 15 min", async () => {
    const { s, prs, github } = cadence();
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(github).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * MIN - 1000);
    expect(github).toHaveBeenCalledTimes(1);
    expect(prs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(github).toHaveBeenCalledTimes(2);
    await s.stop();
  });

  it("a trigger reads the boards within 5 s; triggers within 30 s make one read", async () => {
    const { s, github } = cadence();
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(github).toHaveBeenCalledTimes(1);
    s.refreshBoards();
    await vi.advanceTimersByTimeAsync(1000);
    s.refreshBoards();
    await vi.advanceTimersByTimeAsync(4000);
    expect(github).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    s.refreshBoards(); // 10 s after the first trigger, inside the 30 s window
    await vi.advanceTimersByTimeAsync(19_000);
    expect(github).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6000);
    expect(github).toHaveBeenCalledTimes(3);
    await s.stop();
  });

  it("a trigger does not read the boards while the rate-limit back-off holds", async () => {
    vi.useFakeTimers({ now: NOW });
    config.poll = { usageMinutes: 30, githubSeconds: 60, boardMinutes: 15 };
    let rates: RateLimits | undefined;
    const makeGql = vi.fn((_t: string, r: RateLimits) => {
      rates = r;
      return async () => ({});
    });
    const github = vi.fn<Collectors["github"]>(async () => {
      rates?.record("Board", {
        cost: 1,
        limit: 5000,
        remaining: 400,
        resetAt: NOW + 10 * MIN,
        at: Date.now(),
      });
      return { boards: false, escalations: false };
    });
    const s = createScheduler({
      config,
      store,
      bus,
      now: Date.now,
      collectors: stubs({ makeGql, github }),
      waitedPrs: () => [],
    });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(github).toHaveBeenCalledTimes(1); // low reading: backed off
    await vi.advanceTimersByTimeAsync(10_000);
    s.refreshBoards(); // its timer waits out the 30 s debounce, so run past it
    await vi.advanceTimersByTimeAsync(25_000);
    expect(github).toHaveBeenCalledTimes(1);
    await s.stop();
  });

  it("waited PRs are read every github_seconds, others only with the board", async () => {
    const { s, prs, github } = cadence({ waited: (r) => (r === "shop-app" ? [7] : []) });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(github).toHaveBeenCalledTimes(1);
    expect(prs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prs).toHaveBeenCalledTimes(1);
    expect(prs.mock.calls[0]?.[3]).toEqual([7]);
    expect(github).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(13 * MIN);
    expect(prs).toHaveBeenCalledTimes(14);
    expect(github).toHaveBeenCalledTimes(1);
    await s.stop();
  });

  it("reads no PR on the off ticks when the engine waits on none", async () => {
    const { s, prs } = cadence();
    s.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(prs).not.toHaveBeenCalled();
    await s.stop();
  });
});

describe("refreshOnSeatFree", () => {
  it("asks for a read on run-ended only; the returned function unsubscribes", () => {
    let listener: (e: SupervisorEvent) => void = () => undefined;
    const off = vi.fn();
    const on = (fn: (e: SupervisorEvent) => void) => {
      listener = fn;
      return off;
    };
    const refresh = vi.fn();
    const unsubscribe = refreshOnSeatFree(on, refresh);
    listener({ kind: "run-ended", seatId: "s", runId: "r", endedBy: "exit" });
    expect(refresh).toHaveBeenCalledTimes(1);
    listener({ kind: "idle", seatId: "s" } as SupervisorEvent);
    listener({ kind: "evidence", seatId: "s", runId: "r" } as SupervisorEvent);
    listener({ kind: "findings", seatId: "s", runId: "r" } as SupervisorEvent);
    expect(refresh).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe("waitedPrNumbers", () => {
  it("picks ci, review and pre-merge runs of the repo", () => {
    const run = (repoId: string, loop: Record<string, unknown>) =>
      ({ repoId, loop: { prNumber: null, ...loop } }) as unknown as Run;
    const runs = [
      run("shop-app", { phase: "ci", prNumber: 3 }),
      run("shop-app", { phase: "review", prNumber: 5 }),
      run("shop-app", { phase: "done", prNumber: 9, merging: { done: ["ready"] } }),
      run("shop-app", { phase: "done", prNumber: 11, merging: { done: ["ready", "merge"] } }),
      run("shop-app", { phase: "parked", prNumber: 12 }),
      run("shop-app", { phase: "ci", prNumber: null }),
      run("other", { phase: "ci", prNumber: 4 }),
      run("shop-app", { phase: "ci", prNumber: 3 }),
      { repoId: "shop-app", loop: null } as unknown as Run,
    ];
    expect(waitedPrNumbers(runs, "shop-app")).toEqual([3, 5, 9]);
  });
});

describe("scheduler scope log", () => {
  it("logs a missing gh scope once per repo, after the first poll", async () => {
    const lines: string[] = [];
    const github = vi.fn(async (r: { id: string }, st: Store) => {
      st.setStatus(
        `github:${r.id}`,
        false,
        "board: gh token lacks the read:project scope: run gh auth refresh -s project; prs: boom at 2026-01-01T00:00:00.000Z",
      );
      return { boards: false, escalations: false };
    });
    const s = createScheduler({
      config,
      store,
      bus,
      now: () => NOW,
      log: (l) => lines.push(l),
      collectors: stubs({ github: github as never }),
    });
    await s.tick("github");
    await s.tick("github");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      `github ${config.repos[0]?.id}: gh token lacks the read:project scope: run gh auth refresh -s project`,
    );
  });
});

it("maintenance prunes hub history on the existing sweep", async () => {
  const prune = vi.spyOn(store, "pruneHistory");
  const s = createScheduler({ config, store, bus, now: () => NOW, collectors: stubs() });
  await s.tick("maintenance");
  expect(prune).toHaveBeenCalledWith(NOW);
});

describe("Claude usage back-off", () => {
  const MINUTE_MS = 60_000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const TOKEN = "test-secret-token";
  const usageMs = () => config.poll.usageMinutes * MINUTE_MS;
  const slackMs = () => usageMs() / 2;
  const savedBackoff = (): { waitMs: number; notBefore: number } | null =>
    JSON.parse(store.getSetting(USAGE_BACKOFF_SETTING) ?? "null");

  function setup(retryAfter: string | null = null) {
    vi.useFakeTimers({ now: NOW });
    let status = 429;
    const fetch = vi.fn(async () => {
      if (status === 0) throw new Error(`network failed: ${TOKEN}`);
      return new Response(
        status === 200
          ? JSON.stringify({
              five_hour: {
                utilization: 10,
                resets_at: new Date(Date.now() + HOUR_MS).toISOString(),
              },
              seven_day: {
                utilization: 86,
                resets_at: new Date(Date.now() + DAY_MS).toISOString(),
              },
            })
          : TOKEN,
        { status, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } },
      );
    });
    const c = stubs({
      claude: (acct, onError, now) =>
        sampleClaude(
          acct,
          {
            fetchUsage: () =>
              fetchUsage({
                exec: async () => ({
                  stdout: JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }),
                }),
                fetch,
              }),
            latestTranscriptLimits: () => [],
            onError,
          },
          now,
        ),
    });
    const s = createScheduler({ config, store, bus, now: Date.now, collectors: c });
    return {
      s,
      c,
      fetch,
      setStatus: (next: number) => {
        status = next;
      },
    };
  }

  it.each([
    ["120", 2 * MINUTE_MS],
    ["600", 10 * MINUTE_MS],
    [new Date(NOW + 17 * MINUTE_MS).toUTCString(), 17 * MINUTE_MS],
    [new Date(NOW - MINUTE_MS).toUTCString(), MINUTE_MS],
    [String(USAGE_BACKOFF_CAP_MS / 1000), USAGE_BACKOFF_CAP_MS],
  ])("honours Retry-After %s without retrying early", async (header, delay) => {
    config.poll.usageMinutes = 5;
    const { s, fetch } = setup(header);
    await s.tick("usage");
    expect(savedBackoff()?.notBefore).toBe(NOW + delay);
    vi.setSystemTime(NOW + delay - 1);
    await s.tick("usage");
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + delay);
    await s.tick("usage");
    expect(fetch).toHaveBeenCalledTimes(2);
    await s.stop();
  });

  it("holds every Claude account until Retry-After is due", async () => {
    config.poll.usageMinutes = 5;
    config.accounts.push({ id: "claude-other", vendor: "claude", alertAt: 85, stopAt: 95 });
    const { s, fetch } = setup("120");
    await s.tick("usage");
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 2 * MINUTE_MS - 1);
    await s.tick("usage");
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 2 * MINUTE_MS);
    await s.tick("usage");
    expect(fetch).toHaveBeenCalledTimes(2);
    await s.stop();
  });

  it("retries a capped back-off at 30 minutes when the usage poll is four hours", async () => {
    config.poll.usageMinutes = 240;
    const { s, fetch } = setup(String(USAGE_BACKOFF_CAP_MS / 1000));
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(USAGE_BACKOFF_CAP_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await s.stop();
  });

  it.each([String(1e20), "Fri, 31 Dec 9999 23:59:59 GMT"])(
    "caps Retry-After %s at 30 minutes and keeps a healthy reading as a note",
    async (header) => {
      store.addUsage(sample({ window: "7d", pct: 86 }));
      const { s } = setup(header);
      await s.tick("usage");
      expect(savedBackoff()?.notBefore).toBe(NOW + USAGE_BACKOFF_CAP_MS);
      expect(row("usage:claude-main")).toMatchObject({
        ok: true,
        error: "rate limited by Anthropic; last reading 13:00 (86% 7d); next try 13:30",
      });
      expect(row("usage:claude-main")?.error).not.toContain(TOKEN);
      await s.stop();
    },
  );

  it.each(["1e20", "-1", "1.5", "2026-10-18", "tomorrow"])(
    "falls back to doubling for invalid Retry-After %s",
    async (header) => {
      const { s } = setup(header);
      await s.tick("usage");
      expect(savedBackoff()).toEqual({ waitMs: usageMs(), notBefore: NOW + usageMs() });
      vi.setSystemTime(NOW + usageMs());
      await s.tick("usage");
      expect(savedBackoff()?.waitMs).toBe(USAGE_BACKOFF_CAP_MS);
      await s.stop();
    },
  );

  it("doubles consecutive waits up to the cap and resets after success", async () => {
    const { s, fetch, setStatus } = setup();
    await s.tick("usage");
    let calls = 1;
    let at = NOW;
    for (const wait of [
      usageMs(),
      USAGE_BACKOFF_CAP_MS,
      USAGE_BACKOFF_CAP_MS,
      USAGE_BACKOFF_CAP_MS,
      USAGE_BACKOFF_CAP_MS,
    ]) {
      at += wait;
      vi.setSystemTime(at - slackMs() - 1);
      await s.tick("usage");
      expect(fetch).toHaveBeenCalledTimes(calls);
      vi.setSystemTime(at);
      await s.tick("usage");
      expect(fetch).toHaveBeenCalledTimes(++calls);
    }
    setStatus(200);
    at += USAGE_BACKOFF_CAP_MS;
    vi.setSystemTime(at);
    await s.tick("usage");
    expect(row("usage:claude-main")).toMatchObject({ ok: true, error: null });
    expect(savedBackoff()).toBeNull();
    setStatus(429);
    at += usageMs();
    vi.setSystemTime(at);
    await s.tick("usage");
    expect(savedBackoff()).toEqual({ waitMs: usageMs(), notBefore: at + usageMs() });
    await s.stop();
  });

  it("loads shared back-off on restart even with an old reading", async () => {
    store.addUsage(sample({ at: NOW - DAY_MS }));
    const { s, fetch, c, setStatus } = setup(String(USAGE_BACKOFF_CAP_MS / 1000));
    await s.tick("usage");
    await s.stop();
    const second = createScheduler({ config, store, bus, now: Date.now, collectors: c });
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(savedBackoff()?.notBefore).toBe(NOW + USAGE_BACKOFF_CAP_MS);
    vi.setSystemTime(NOW + USAGE_BACKOFF_CAP_MS - 1);
    await second.tick("usage");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(savedBackoff()?.waitMs).toBe(USAGE_BACKOFF_CAP_MS);
    setStatus(200);
    vi.setSystemTime(savedBackoff()?.notBefore ?? 0);
    await second.tick("usage");
    expect(savedBackoff()).toBeNull();
    await second.stop();
  });

  it.each([
    [10, OAUTH_USAGE_SOURCE, 0],
    [30, OAUTH_USAGE_SOURCE, 1],
    [10, "transcript", 1],
  ])("at start, a %i-minute-old %s sample makes %i requests", async (minutes, source, calls) => {
    store.addUsage(sample({ at: NOW - minutes * MINUTE_MS, source }));
    const { s, fetch, c } = setup();
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(c.codex).toHaveBeenCalledTimes(1);
    if (calls === 0) {
      const notBefore = NOW - minutes * MINUTE_MS + usageMs();
      vi.setSystemTime(notBefore - slackMs() - 1);
      await s.tick("usage");
      expect(fetch).not.toHaveBeenCalled();
      vi.setSystemTime(notBefore - 1);
      await s.tick("usage");
      expect(fetch).not.toHaveBeenCalled();
      vi.setSystemTime(notBefore);
      await s.tick("usage");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    await s.stop();
  });

  it("finds a recent OAuth sample even behind a newer transcript", async () => {
    store.addUsage(sample({ at: NOW - 10 * MINUTE_MS }));
    store.addUsage(sample({ at: NOW - 5 * MINUTE_MS, source: "transcript" }));
    const { s, fetch } = setup();
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    await s.stop();
  });

  it("prefers the weekly reading even when the five-hour reading is newer", async () => {
    const last = sample({ window: "7d", at: NOW - 10 * MINUTE_MS, pct: 86 });
    store.addUsage(sample({ at: NOW }));
    store.addUsage(last);
    const { s } = setup();
    await s.tick("usage");
    expect(row("usage:claude-main")).toMatchObject({
      ok: true,
      error: "rate limited by Anthropic; last reading 12:50 (86% 7d); next try 13:30",
    });
    expect(store.latestUsage("claude-main", "7d")).toEqual(last);
    expect(row("usage:claude-main")?.error).not.toContain(TOKEN);
    await s.stop();
  });

  it("dates older readings and turns the note into a failure at the age limit", async () => {
    store.addUsage(sample({ at: NOW - USAGE_RATE_LIMIT_MAX_AGE_MS + 1 }));
    const { s, fetch } = setup(String(USAGE_BACKOFF_CAP_MS / 1000));
    await s.tick("usage");
    expect(row("usage:claude-main")).toMatchObject({
      ok: true,
      error: "rate limited by Anthropic; last reading 16 Oct 2026 13:00 (10% 5h); next try 13:30",
    });
    vi.setSystemTime(NOW + 1);
    await s.tick("usage");
    expect(row("usage:claude-main")?.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    await s.stop();
  });

  it("backs off every Claude account sharing the token", async () => {
    config.accounts.push({ id: "claude-other", vendor: "claude", alertAt: 85, stopAt: 95 });
    store.addUsage(sample({ accountId: "claude-other", at: NOW - usageMs() }));
    const { s, fetch, c } = setup();
    await s.tick("usage");
    expect(row("usage:claude-main")).toMatchObject({
      ok: false,
      error: "rate limited by Anthropic; no previous reading; next try 13:30",
    });
    expect(row("usage:claude-other")).toMatchObject({
      ok: true,
      error: "rate limited by Anthropic; last reading 12:30 (10% 5h); next try 13:30",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + usageMs() - slackMs() - 1);
    await s.tick("usage");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(c.codex).toHaveBeenCalledTimes(2);
    vi.setSystemTime(NOW + usageMs());
    await s.tick("usage");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(savedBackoff()?.waitMs).toBe(USAGE_BACKOFF_CAP_MS);
    await s.stop();
  });

  it.each([
    [503, "HTTP 503"],
    [0, "Error"],
  ])(
    "keeps an expired back-off through a plain failure until the first success on %s",
    async (status, error) => {
      const { s, fetch, setStatus } = setup();
      await s.tick("usage");
      vi.setSystemTime(NOW + usageMs());
      await s.tick("usage");
      const due = savedBackoff()?.notBefore ?? 0;
      setStatus(status);
      for (let poll = 0; poll < 2; poll++) {
        vi.setSystemTime(due + poll * usageMs());
        await s.tick("usage");
        expect(fetch).toHaveBeenCalledTimes(3 + poll);
        expect(savedBackoff()?.notBefore).toBe(due);
        expect(row("usage:claude-main")).toMatchObject({
          ok: false,
          error: `oauth-usage: oauth usage request failed: ${error}`,
        });
        expect(row("usage:claude-main")?.error).not.toContain(TOKEN);
      }
      setStatus(429);
      vi.setSystemTime(due + 2 * usageMs());
      await s.tick("usage");
      expect(savedBackoff()?.waitMs).toBe(USAGE_BACKOFF_CAP_MS);
      await s.stop();
    },
  );
});

it("releases crew holds from a durable idle seat session after the hold", async () => {
  vi.spyOn(hud, "crew").mockReturnValue({
    rows: [
      {
        id: "crew-1",
        kind: "crew",
        role: "GUIDO",
        hudState: "idle",
        stateSince: NOW + 1,
      } as CrewRow,
    ],
    firstRunToday: null,
  });
  holdItem(store, "ask:1", "Waiting", { kind: "crew" }, "operator", NOW);
  store.setSeatSession({
    seatId: "crew-1",
    runId: null,
    cliSessionId: "session",
    state: "idle",
    reason: null,
    worktree: null,
    updatedAt: NOW - 1,
    vendor: "claude",
  });
  const s = createScheduler({ config, store, bus, now: () => NOW + 10, collectors: stubs() });
  await s.tick("ta");
  expect(holds(store)["ask:1"]?.releasedAt).toBeUndefined();
  const seat = store.seatSession("crew-1");
  if (!seat) throw new Error("missing seat session");
  store.setSeatSession({ ...seat, updatedAt: NOW + 1 });
  await s.tick("ta");
  expect(holds(store)["ask:1"]?.releasedAt).toBe(NOW + 10);
});

it("releases a ci hold when the stored PR reaches the state, and an item hold when the item is gone", async () => {
  vi.spyOn(hud, "crew").mockReturnValue({ rows: [], firstRunToday: null });
  const waiting = new Set(["note:other"]);
  vi.spyOn(hud, "attentionItems").mockImplementation(
    () => [...waiting].map((key) => ({ key })) as ReturnType<typeof hud.attentionItems>,
  );
  holdItem(store, "ask:1", "Waiting", { kind: "ci", pr: "r1#5", state: "passing" }, "FLIGHT", NOW);
  holdItem(store, "ask:2", "Waiting", { kind: "item", key: "note:other" }, "FLIGHT", NOW);
  const pr = (ci: "pending" | "passing"): PullRequestView =>
    ({
      repoId: "r1",
      number: 5,
      title: "t",
      url: "u",
      branch: "b",
      ticket: null,
      state: "open",
      isDraft: false,
      review: null,
      ci,
      createdAt: NOW,
      updatedAt: NOW,
      mergedAt: null,
      headSha: null,
      mergeable: null,
    }) as PullRequestView;
  store.replacePullRequests("r1", [pr("pending")], NOW);
  const s = createScheduler({ config, store, bus, now: () => NOW + 10, collectors: stubs() });
  await s.tick("ta");
  expect(holds(store)["ask:1"]?.releasedAt).toBeUndefined();
  expect(holds(store)["ask:2"]?.releasedAt).toBeUndefined();
  store.replacePullRequests("r1", [pr("passing")], NOW + 5);
  waiting.clear();
  await s.tick("ta");
  expect(holds(store)["ask:1"]?.releasedAt).toBe(NOW + 10);
  expect(holds(store)["ask:2"]?.releasedAt).toBe(NOW + 10);
});

it("emits attention at the earliest triage deadline and cancels the timer on stop", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(hud, "crew").mockReturnValue({ rows: [], firstRunToday: null });
  vi.spyOn(hud, "attentionItems").mockImplementation(
    (_config, _store, at) =>
      [
        {
          key: "deadline",
          triageDueAt: NOW + 2000,
          flightTriage: at < NOW + 2000 ? "waiting" : "missed",
        },
      ] as ReturnType<typeof hud.attentionItems>,
  );
  const s = createScheduler({ config, store, bus, now: () => Date.now(), collectors: stubs() });
  s.start();
  await vi.advanceTimersByTimeAsync(EMIT_COALESCE_MS);
  topics.length = 0;
  await vi.advanceTimersByTimeAsync(2000 - EMIT_COALESCE_MS);
  expect(topics).toContain("attention");
  await s.stop();
  topics.length = 0;
  await vi.advanceTimersByTimeAsync(1000);
  expect(topics).toEqual([]);
});
