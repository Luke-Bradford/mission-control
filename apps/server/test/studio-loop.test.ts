import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { driverStopKey } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoldState } from "../src/collectors/common.ts";
import type { LiveSession } from "../src/collectors/sessions.ts";
import {
  collectStudioLoop,
  fireLogStartedAt,
  newStudioState,
  parseDriverLog,
} from "../src/collectors/studio-loop.ts";
import type { AdoptedLoop } from "../src/config.ts";
import { Store } from "../src/store.ts";

const FIX = join(import.meta.dirname, "fixtures/studio");
const TZ = "Europe/London";
const NOW = Date.parse("2026-10-17T11:50:00Z");
const F42 = "fire.20261017-112003.log";
const F43 = "fire.20261017-124500.log";

let dir: string;
let logsDir: string;
let store: Store;
let loop: AdoptedLoop;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-studio-"));
  logsDir = join(dir, "logs");
  mkdirSync(logsDir);
  for (const f of ["driver.log", F42, F43]) copyFileSync(join(FIX, f), join(logsDir, f));
  store = new Store(join(dir, "mc.sqlite"));
  loop = {
    id: "studio-builder",
    repoId: "site-builder",
    kind: "studio-loop",
    accountId: "acct",
    logsDir,
    stateDir: join(dir, "state"),
    worktree: join(dir, "wt"),
    launchdLabel: "x",
  } as AdoptedLoop;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The live Claude sessions the scheduler would pass: by default, one in the loop's worktree. */
const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  pid: 4242,
  sessionId: "s",
  cwd: loop.worktree,
  startedAt: NOW - 5 * 60e3,
  status: "busy",
  name: "",
  alive: true,
  ...over,
});
const live = (): LiveSession[] => [session()];
const run = () => collectStudioLoop(loop, store, TZ, NOW, newStudioState(), live());
const byId = () => new Map(store.runs("studio-builder", 100).map((r) => [r.id, r]));
const U = (s: string) => Date.parse(s);

describe("parseDriverLog", () => {
  it("parses every line variant and ignores the rest", () => {
    expect(
      parseDriverLog([
        "[2026-10-17T08:17:46Z] quota ok: 7-day utilization 43% (< 80%)",
        "[2026-10-17T08:17:53Z] === FIRE 42 (main=6468d94 openPR=0) ===",
        "[2026-10-17T10:19:46Z] fire 42 exited 0",
        "[2026-10-17T10:19:48Z] fire 43 exited 137",
        "[2026-10-17T10:19:55Z] quota source: dashboard (7-day utilization 45%)",
        "[2026-07-15T02:05:18Z] STOP: stalled 3 fires with no progress",
        "[2026-07-15T17:43:44Z] STOP: signal issue open (operator-decision=1 loop-blocked=0 mvp-ready=0)",
        "[2026-07-15T17:43:45Z] plane drift: prompt.md differs",
        "[2026-07-15T17:43:46Z] quota shadow: studio UNREADABLE (rate_limited)",
        "[2026-07-15T17:43:47Z] === DRIVER START (repo=/x) ===",
        "no timestamp here",
      ]),
    ).toEqual([
      { kind: "quota", at: U("2026-10-17T08:17:46Z"), pct: 43 },
      { kind: "fire-start", at: U("2026-10-17T08:17:53Z"), fire: 42 },
      { kind: "fire-exit", at: U("2026-10-17T10:19:46Z"), fire: 42, rc: 0 },
      { kind: "fire-exit", at: U("2026-10-17T10:19:48Z"), fire: 43, rc: 137 },
      { kind: "quota", at: U("2026-10-17T10:19:55Z"), pct: 45 },
      { kind: "stop", at: U("2026-07-15T02:05:18Z"), reason: "stalled 3 fires with no progress" },
      {
        kind: "stop",
        at: U("2026-07-15T17:43:44Z"),
        reason: "signal issue open (operator-decision=1 loop-blocked=0 mvp-ready=0)",
      },
    ]);
  });

  it("reads the quota window's reset time", () => {
    expect(
      parseDriverLog([
        "[2026-10-19T09:33:18Z] quota window: resets 2026-10-21T02:00:00Z (in 40h26m)",
      ]),
    ).toEqual([
      {
        kind: "quota-reset",
        at: U("2026-10-19T09:33:18Z"),
        resetsAt: U("2026-10-21T02:00:00Z"),
      },
    ]);
  });
});

const QUOTA_WINDOW = "[2026-10-19T09:33:18Z] quota window: resets 2026-10-21T02:00:00Z (in 40h26m)";
const QUOTA_STOP_BODY =
  "7-day quota utilization 88% >= QUOTA_STOP_PCT=80% -- refusing to fire (window resets weekly; protecting the operator's own headroom)";
const QUOTA_STOP = `[2026-10-19T09:33:18Z] STOP: ${QUOTA_STOP_BODY}`;
const DRIVER_START =
  "[2026-10-19T10:33:18Z] === DRIVER START (repo=/x -- MAX_FIRES=0, QUOTA_STOP_PCT=80%; stop on operator/nothing-to-do/quota; backoff on limits) ===";

describe("a driver's own stop", () => {
  const KEY = driverStopKey("studio-builder");
  const append = (...lines: string[]) =>
    appendFileSync(join(logsDir, "driver.log"), `${lines.join("\n")}\n`);
  const stop = () => {
    const raw = store.getSetting(KEY);
    return raw === null ? null : JSON.parse(raw);
  };

  it("a quota STOP with its window line keeps the usage, the limit and the reset time", async () => {
    append(QUOTA_WINDOW, QUOTA_STOP);
    await run();
    expect(stop()).toEqual({
      reason: QUOTA_STOP_BODY,
      at: U("2026-10-19T09:33:18Z"),
      quota: { usedPct: 88, stopPct: 80 },
      resumesAt: U("2026-10-21T02:00:00Z"),
    });
    // The note row stays for other readers.
    const note = store.status().find((c) => c.collector === "studio-loop:studio-builder:note");
    expect(note?.error).toContain("quota utilization 88%");
  });

  it("the UNREADABLE wording takes the last known reading", async () => {
    append(
      QUOTA_WINDOW,
      "[2026-10-19T09:33:19Z] STOP: 7-day quota UNREADABLE and the last known reading was 87% >= QUOTA_STOP_PCT=80% -- refusing to fire",
    );
    await run();
    expect(stop()).toMatchObject({ quota: { usedPct: 87, stopPct: 80 } });
  });

  it("a quota STOP with no window line has no resume time", async () => {
    append(QUOTA_STOP);
    await run();
    expect(stop()).toMatchObject({ quota: { usedPct: 88, stopPct: 80 }, resumesAt: null });
  });

  it("a window line from before the last fire is not this stop's reset", async () => {
    append(QUOTA_WINDOW, "[2026-10-19T09:40:00Z] === FIRE 44 (main=abc openPR=0) ===", QUOTA_STOP);
    await run();
    expect(stop()).toMatchObject({ resumesAt: null });
  });

  it("MAX_FIRES and no-progress stops are not quota stops and keep their whole reason", async () => {
    append("[2026-10-19T09:33:18Z] STOP: MAX_FIRES=6 reached -- not firing again");
    await run();
    expect(stop()).toEqual({
      reason: "MAX_FIRES=6 reached -- not firing again",
      at: U("2026-10-19T09:33:18Z"),
      quota: null,
      resumesAt: null,
    });
    append("[2026-10-19T09:34:00Z] STOP: stalled 3 fires with no progress");
    await run();
    expect(stop()).toMatchObject({ reason: "stalled 3 fires with no progress", quota: null });
  });

  it("a signal STOP is not a driver stop", async () => {
    append("[2026-10-19T09:33:18Z] STOP: operator signal open (operator-decision=1)");
    await run();
    expect(store.getSetting(KEY)).toBeNull();
  });

  it("a STOP repeated after the hourly DRIVER START keeps the stop and moves it forward", async () => {
    append(
      QUOTA_WINDOW,
      QUOTA_STOP,
      DRIVER_START,
      "[2026-10-19T10:33:28Z] quota window: resets 2026-10-21T02:00:00Z (in 39h26m)",
      "[2026-10-19T10:33:28Z] STOP: 7-day quota utilization 90% >= QUOTA_STOP_PCT=80% -- refusing to fire",
    );
    await run();
    expect(stop()).toMatchObject({
      at: U("2026-10-19T10:33:28Z"),
      quota: { usedPct: 90, stopPct: 80 },
      resumesAt: U("2026-10-21T02:00:00Z"),
    });
  });

  it("a DRIVER START alone keeps the stop; a new FIRE clears it on the next tick", async () => {
    const state = newStudioState();
    append(QUOTA_WINDOW, QUOTA_STOP, DRIVER_START);
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(stop()).not.toBeNull();
    append("[2026-10-21T02:05:00Z] === FIRE 44 (main=abc openPR=0) ===");
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(store.getSetting(KEY)).toBeNull();
  });

  it("a stop stored by an earlier process is replaced by what the log now says", async () => {
    store.setSetting(KEY, JSON.stringify({ reason: "old", at: 1, quota: null, resumesAt: null }));
    await run();
    expect(store.getSetting(KEY)).toBeNull();
  });
});

describe("fireLogStartedAt", () => {
  it("converts Europe/London local names to UTC across DST", () => {
    expect(fireLogStartedAt(F42, TZ)).toBe(Date.UTC(2026, 9, 17, 10, 20, 3));
    expect(fireLogStartedAt("fire.20261024-120000.log", TZ)).toBe(Date.UTC(2026, 9, 24, 11, 0, 0));
    expect(fireLogStartedAt("fire.20261025-030000.log", TZ)).toBe(Date.UTC(2026, 9, 25, 3, 0, 0));
    expect(fireLogStartedAt("fire.20260115-120000.log", TZ)).toBe(Date.UTC(2026, 0, 15, 12, 0, 0));
  });
  it("returns NaN for a non-fire name", () => {
    expect(fireLogStartedAt("driver.log", TZ)).toBeNaN();
  });
});

describe("collectStudioLoop", () => {
  it("builds runs with distinct ids for repeated fire numbers", async () => {
    await run();
    const runs = store.runs("studio-builder", 100);
    expect(runs).toHaveLength(5);
    expect(new Set(runs.map((r) => r.id)).size).toBe(5);
    expect(runs.filter((r) => r.seq === 1)).toHaveLength(2);
    const ids = runs.map((r) => r.id).sort();
    expect(ids).toContain("studio-builder:20261017-112003");
    expect(ids).toContain("studio-builder:20261017-124500");
    expect(ids).toContain(`studio-builder:t${U("2026-10-15T09:00:00Z") / 1000}`);
  });

  it("pairs FIRE lines with fire logs across BST and sets status", async () => {
    await run();
    const r = byId();
    const f42 = r.get("studio-builder:20261017-112003");
    expect(f42).toMatchObject({
      seq: 42,
      startedAt: U("2026-10-17T10:20:03Z"),
      endedAt: U("2026-10-17T11:19:46Z"),
      status: "ok",
      transcriptPath: join(logsDir, F42),
      repoId: "site-builder",
      agentId: "studio-builder",
    });
    expect(f42?.sessionId).not.toBeNull();
    expect(f42?.costUsd).not.toBeNull();
    expect(f42?.branch).not.toBeNull();
  });

  it("tolerates a few seconds between the FIRE line and the log name", async () => {
    copyFileSync(join(logsDir, F42), join(logsDir, "fire.20261017-112006.log"));
    rmSync(join(logsDir, F42));
    await run();
    expect(byId().get("studio-builder:20261017-112006")?.seq).toBe(42);
  });

  it("marks the latest unexited fire running and folds its transcript", async () => {
    await run();
    const f43 = byId().get("studio-builder:20261017-124500");
    expect(f43).toMatchObject({ seq: 43, status: "running", endedAt: null });
    expect(f43?.transcriptPath).toBe(join(logsDir, F43));
    expect(f43?.sessionId).not.toBeNull();
  });

  it("infers the running fire's ticket from a published branch, else the worktree HEAD", async () => {
    const strip = readFileSync(join(logsDir, F43), "utf8")
      .split("\n")
      .filter((l) => !l.includes("vcs_state_changed"));
    const pub = JSON.stringify({
      type: "system",
      subtype: "code_change_published",
      action: "created",
      branch: "feat/studio-1600-c8d2-wait",
    });
    writeFileSync(join(logsDir, F43), `${[...strip, pub].join("\n")}\n`);
    await run();
    expect(byId().get("studio-builder:20261017-124500")).toMatchObject({
      branch: "feat/studio-1600-c8d2-wait",
      ticket: "site-builder#1600",
    });

    // No branch in the transcript at all: the worktree HEAD (linked-worktree layout) is used.
    writeFileSync(join(logsDir, F43), `${strip.join("\n")}\n`);
    const gitdir = join(dir, "main-git");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/fix/42-from-head\n");
    mkdirSync(loop.worktree, { recursive: true });
    writeFileSync(join(loop.worktree, ".git"), `gitdir: ${gitdir}\n`);
    await collectStudioLoop(loop, store, TZ, NOW, newStudioState(), live());
    expect(byId().get("studio-builder:20261017-124500")).toMatchObject({
      branch: "fix/42-from-head",
      ticket: "site-builder#42",
    });
  });

  // #26 A3: a re-fold from a transcript that names no branch must not null what was known.
  it("keeps a stored run's branch, ticket, session and model when its transcript names none", async () => {
    const stripped = (f: string) =>
      readFileSync(join(logsDir, f), "utf8")
        .split("\n")
        .filter((l) => !l.includes("vcs_state_changed") && !l.includes('"subtype":"init"'));
    writeFileSync(join(logsDir, F42), `${stripped(F42).join("\n")}\n`);
    writeFileSync(join(logsDir, F43), `${stripped(F43).join("\n")}\n`);
    const known = {
      agentId: "studio-builder",
      repoId: "site-builder",
      endedAt: null,
      status: "unknown" as const,
      sessionId: "s-prev",
      model: "m-prev",
      branch: "fix/studio-12-x",
      ticket: "site-builder#12",
      costUsd: null,
      tokens: null,
      prs: [],
      summary: null,
    };
    store.upsertRun({
      ...known,
      id: "studio-builder:20261017-112003",
      seq: 42,
      startedAt: U("2026-10-17T10:20:03Z"),
      transcriptPath: join(logsDir, F42),
    });
    store.upsertRun({
      ...known,
      id: "studio-builder:20261017-124500",
      seq: 43,
      startedAt: U("2026-10-17T11:45:00Z"),
      transcriptPath: join(logsDir, F43),
    });
    await run();
    // F42 has ended; F43 is running with no worktree HEAD to read either.
    for (const id of ["studio-builder:20261017-112003", "studio-builder:20261017-124500"]) {
      expect(byId().get(id), id).toMatchObject({
        branch: "fix/studio-12-x",
        ticket: "site-builder#12",
        sessionId: "s-prev",
        model: "m-prev",
      });
    }
    // Only a fold writes the cost: the stored row had none.
    expect(byId().get("studio-builder:20261017-112003")?.costUsd).toBe(2.4711);
  });

  it("stores the PRs and summary of a folded fire, and marks an ended folded fire folded", async () => {
    const extra = [
      JSON.stringify({
        type: "system",
        subtype: "code_change_published",
        provider: "github",
        url: "https://github.com/Owner-A/repo-b/pull/1767",
        repo: "Owner-A/repo-b",
        identifier: "1767",
        action: "created",
        branch: "fix/studio-1761-x",
      }),
      JSON.stringify({ type: "result", is_error: false, result: "Merged PR #1767. Done." }),
    ];
    appendFileSync(join(logsDir, F42), `${extra.join("\n")}\n`);
    await run();
    expect(byId().get("studio-builder:20261017-112003")).toMatchObject({
      prs: [{ repo: "Owner-A/repo-b", number: 1767 }],
      summary: "Merged PR #1767. Done.",
    });
    const folded = (id: string) =>
      (
        new DatabaseSync(join(dir, "mc.sqlite"))
          .prepare("SELECT folded FROM runs WHERE id = ?")
          .get(id) as { folded: number }
      ).folded;
    expect(folded("studio-builder:20261017-112003")).toBe(1);
    expect(folded("studio-builder:20261017-124500")).toBe(0); // running
  });

  it("marks older unexited fires unknown, failed rc as failed, and signal STOP as blocked", async () => {
    await run();
    const runs = [...byId().values()];
    const f2 = runs.find((r) => r.seq === 2);
    expect(f2?.status).toBe("unknown");
    const old1 = runs.find((r) => r.seq === 1 && r.startedAt === U("2026-10-15T09:00:00Z"));
    expect(old1).toMatchObject({ status: "ok", transcriptPath: "" });
    const rep1 = runs.find((r) => r.seq === 1 && r.startedAt === U("2026-10-16T09:00:00Z"));
    // exit rc 1 followed by `STOP: signal issue open` -> blocked
    expect(rep1?.status).toBe("blocked");
  });

  it("keeps a failed run failed when the STOP is not a signal STOP", async () => {
    const p = join(logsDir, "driver.log");
    writeFileSync(p, readFileSync(p, "utf8").replace("signal issue open", "something else"));
    await run();
    const rep1 = [...byId().values()].find((r) => r.startedAt === U("2026-10-16T09:00:00Z"));
    expect(rep1?.status).toBe("failed");
  });

  it("marks the latest open fire unknown, with a collector error, when no live session is in the worktree", async () => {
    const state = newStudioState();
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    const id = "studio-builder:20261017-124500";
    expect(byId().get(id)?.status).toBe("running");
    for (const sessions of [
      [],
      [session({ alive: false })],
      [session({ cwd: join(dir, "elsewhere") })],
    ]) {
      await collectStudioLoop(loop, store, TZ, NOW, state, sessions);
      expect(byId().get(id)).toMatchObject({ status: "unknown", endedAt: null });
      expect(
        store.status().find((c) => c.collector === "studio-loop:studio-builder"),
      ).toMatchObject({
        ok: false,
        error: "loop process not running (no live Claude session in its worktree)",
      });
    }
    // The session comes back (or was only missed): running again, collector ok.
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(byId().get(id)?.status).toBe("running");
    expect(store.status().find((c) => c.collector === "studio-loop:studio-builder")?.ok).toBe(true);
  });

  it("gives a just-started fire a grace period before its session must exist", async () => {
    // F43 started 11:45:00; 30 s later the CLI may not have registered its session yet.
    const soon = U("2026-10-17T11:45:30Z");
    await collectStudioLoop(loop, store, TZ, soon, newStudioState(), []);
    expect(byId().get("studio-builder:20261017-124500")?.status).toBe("running");
    expect(store.status().find((c) => c.collector === "studio-loop:studio-builder")?.ok).toBe(true);
  });

  it("does not check liveness when the sessions are unknown (null)", async () => {
    await collectStudioLoop(loop, store, TZ, NOW, newStudioState(), null);
    expect(byId().get("studio-builder:20261017-124500")?.status).toBe("running");
  });

  it("pairs a fire log named in the repeated hour when DST ends (BST occurrence)", async () => {
    // 25 Oct 2026, Europe/London: 01:30 local happens at 00:30Z (BST) and again at 01:30Z (GMT).
    // The name alone resolves to the GMT instant; the FIRE line says it was the BST one.
    for (const f of readdirSync(logsDir)) rmSync(join(logsDir, f));
    writeFileSync(
      join(logsDir, "driver.log"),
      "[2026-10-25T00:30:00Z] === FIRE 7 (main=abc openPR=0) ===\n[2026-10-25T00:55:00Z] fire 7 exited 0\n",
    );
    copyFileSync(join(FIX, F42), join(logsDir, "fire.20261025-013000.log"));
    await collectStudioLoop(loop, store, TZ, U("2026-10-25T01:00:00Z"), newStudioState(), live());
    const r = byId().get("studio-builder:20261025-013000");
    expect(r).toMatchObject({ seq: 7, status: "ok", startedAt: U("2026-10-25T00:30:00Z") });
    expect(r?.transcriptPath).toBe(join(logsDir, "fire.20261025-013000.log"));
  });

  it("does not pair a log an hour off outside a DST change", async () => {
    for (const f of readdirSync(logsDir)) rmSync(join(logsDir, f));
    writeFileSync(
      join(logsDir, "driver.log"),
      "[2026-10-17T10:00:00Z] === FIRE 8 (main=abc openPR=0) ===\n[2026-10-17T10:30:00Z] fire 8 exited 0\n",
    );
    // 12:00 BST is 11:00Z: an hour after the FIRE line, not the same fire.
    copyFileSync(join(FIX, F42), join(logsDir, "fire.20261017-120000.log"));
    await run();
    expect([...byId().keys()]).toEqual([`studio-builder:t${U("2026-10-17T10:00:00Z") / 1000}`]);
  });

  it("does not block a running fire on a signal STOP", async () => {
    appendFileSync(
      join(logsDir, "driver.log"),
      "[2026-10-17T11:46:00Z] STOP: signal issue open (operator-decision=1)\n",
    );
    await run();
    expect(byId().get("studio-builder:20261017-124500")?.status).toBe("running");
  });

  it("records non-signal STOP reasons as a note without changing runs", async () => {
    appendFileSync(
      join(logsDir, "driver.log"),
      "[2026-10-17T11:49:00Z] fire 43 exited 0\n[2026-10-17T11:49:30Z] STOP: 7-day quota utilization 99% >= 80%\n",
    );
    await run();
    expect(byId().get("studio-builder:20261017-124500")?.status).toBe("ok");
    const st = store.status();
    expect(st.find((c) => c.collector === "studio-loop:studio-builder")?.ok).toBe(true);
    expect(st.find((c) => c.collector === "studio-loop:studio-builder:note")).toMatchObject({
      ok: true,
      error: expect.stringContaining("quota utilization 99%"),
    });
  });

  it("does not fold transcripts of fires older than 24h", async () => {
    // 2026-10-16T09:00:00Z == 10:00:00 BST
    copyFileSync(join(FIX, F42), join(logsDir, "fire.20261016-100000.log"));
    await run();
    const old = byId().get("studio-builder:20261016-100000");
    expect(old).toMatchObject({
      seq: 1,
      transcriptPath: join(logsDir, "fire.20261016-100000.log"),
    });
    expect(old?.costUsd).toBeNull();
    expect(old?.sessionId).toBeNull();
  });

  it("is idempotent and picks up the end of the in-flight fire in place", async () => {
    const state = newStudioState();
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    const before = store.runs("studio-builder", 100);
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(store.runs("studio-builder", 100)).toEqual(before);
    appendFileSync(join(logsDir, "driver.log"), "[2026-10-17T11:49:00Z] fire 43 exited 0\n");
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    const after = store.runs("studio-builder", 100);
    expect(after).toHaveLength(before.length);
    expect(after.find((r) => r.seq === 43)).toMatchObject({
      status: "ok",
      endedAt: U("2026-10-17T11:49:00Z"),
    });
  });

  it("re-folds the in-flight transcript on a fresh collector", async () => {
    await run();
    const first = byId().get("studio-builder:20261017-124500");
    await run(); // fresh state
    const second = byId().get("studio-builder:20261017-124500");
    expect(second?.costUsd).toBe(first?.costUsd);
    expect(second?.tokens).toEqual(first?.tokens);
    expect(second?.tokens?.input).toBeGreaterThan(0);
  });

  it("updates a reconciled unknown run in place on a late end line", async () => {
    await run();
    const f2 = [...byId().values()].find((r) => r.seq === 2);
    expect(f2?.status).toBe("unknown");
    appendFileSync(join(logsDir, "driver.log"), "[2026-10-17T11:49:00Z] fire 2 exited 0\n");
    await run();
    const runs = store.runs("studio-builder", 100);
    expect(runs).toHaveLength(5);
    expect(runs.find((r) => r.id === f2?.id)).toMatchObject({ status: "ok" });
  });

  it("records source missing without throwing", async () => {
    rmSync(logsDir, { recursive: true });
    await expect(run()).resolves.toBeUndefined();
    expect(store.runs("studio-builder", 10)).toEqual([]);
    expect(store.status().find((c) => c.collector === "studio-loop:studio-builder")).toMatchObject({
      ok: false,
      error: `source missing: ${logsDir}`,
    });
  });

  it("records a missing driver.log as a failed collector", async () => {
    rmSync(join(logsDir, "driver.log"));
    await run();
    expect(store.status().find((c) => c.collector === "studio-loop:studio-builder")?.ok).toBe(
      false,
    );
  });

  it("reads only appended bytes on later polls and matches a one-shot parse", async () => {
    const p = join(logsDir, "driver.log");
    const original = readFileSync(p, "utf8");
    const state = newStudioState();
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(state.drivers.get("studio-builder")?.offset).toBe(Buffer.byteLength(original));
    // Clobber the already-consumed prefix in place (same length): a full re-read would lose the fires.
    writeFileSync(p, `${"#".repeat(Buffer.byteLength(original) - 1)}\n`);
    const tail = "[2026-10-17T11:49:00Z] fire 43 exited 0\n";
    appendFileSync(p, tail);
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(state.drivers.get("studio-builder")?.offset).toBe(
      Buffer.byteLength(original) + Buffer.byteLength(tail),
    );
    const incremental = store.runs("studio-builder", 100);
    expect(incremental).toHaveLength(5);

    // One-shot parse of the same final content on a fresh store and collector.
    writeFileSync(p, original + tail);
    const store2 = new Store(join(dir, "cc2.sqlite"));
    await collectStudioLoop(loop, store2, TZ, NOW, newStudioState(), live());
    expect(incremental).toEqual(store2.runs("studio-builder", 100));
  });

  it("prunes fold state of runs it will not fold again after a poll", async () => {
    const state = newStudioState();
    state.transcripts.set("/t/gone", { facts: {} as FoldState["facts"], offset: 1 });
    state.digests.set("gone", "{}");
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(state.transcripts.has("/t/gone")).toBe(false);
    expect(state.digests.has("gone")).toBe(false);
    expect(state.transcripts.size).toBeGreaterThan(0);
    expect(state.digests.size).toBeGreaterThan(0);
  });

  it("folds fires across more than the window and keeps transcript facts only for fires inside it", async () => {
    const DAY = 24 * 60 * 60_000;
    const state = newStudioState();
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect([...state.transcripts.keys()].sort()).toEqual([join(logsDir, F42), join(logsDir, F43)]);
    // Three days on both fires are outside the window (the running one is no longer live).
    await collectStudioLoop(loop, store, TZ, NOW + 3 * DAY, state, []);
    expect(state.transcripts.size).toBe(0);
    expect(state.digests.size).toBe(0);
  });

  describe("launchd job", () => {
    const NOTE = "studio-loop:studio-builder:note";
    const noteRow = () => store.status().find((c) => c.collector === NOTE);
    const runner = (code: number) => {
      const calls: string[][] = [];
      return {
        calls,
        run: async (args: string[]) => {
          calls.push(args);
          return { code };
        },
      };
    };
    const noneRunning = () => [...byId().values()].every((r) => r.status !== "running");

    it("present: no launchd note, latest fire running", async () => {
      const l = runner(0);
      await collectStudioLoop(loop, store, TZ, NOW, newStudioState(), live(), l.run);
      expect(byId().get("studio-builder:20261017-124500")?.status).toBe("running");
      expect(noteRow()?.error ?? "").not.toContain("launchd");
      expect(l.calls).toEqual([["print", `gui/${process.getuid?.() ?? 0}/x`]]);
    });

    it("missing (exit 113): note `launchd job missing: <label>`, nothing running", async () => {
      const l = runner(113);
      await collectStudioLoop(loop, store, TZ, NOW, newStudioState(), live(), l.run);
      expect(noteRow()).toMatchObject({ ok: true, error: "launchd job missing: x" });
      expect(noneRunning()).toBe(true);
      expect(
        store.status().find((c) => c.collector === "studio-loop:studio-builder"),
      ).toMatchObject({ ok: false, error: "launchd job missing: x" });
      expect(l.calls).toHaveLength(1);
    });

    it("missing with a driver note: shows both, launchd first", async () => {
      appendFileSync(
        join(logsDir, "driver.log"),
        "[2026-10-17T11:49:30Z] STOP: 7-day quota utilization 99% >= 80%\n",
      );
      await collectStudioLoop(loop, store, TZ, NOW, newStudioState(), live(), runner(0).run);
      const driverNote = noteRow()?.error;
      expect(driverNote).toContain("quota utilization 99%");
      await collectStudioLoop(loop, store, TZ, NOW, newStudioState(), live(), runner(113).run);
      expect(noteRow()?.error).toBe(`launchd job missing: x · ${driverNote}`);
    });

    it("missing then present: the fire returns to running and the note clears", async () => {
      const state = newStudioState();
      await collectStudioLoop(loop, store, TZ, NOW, state, live(), runner(113).run);
      expect(noneRunning()).toBe(true);
      expect(noteRow()?.error).toBe("launchd job missing: x");
      await collectStudioLoop(loop, store, TZ, NOW, state, live(), runner(0).run);
      expect(byId().get("studio-builder:20261017-124500")?.status).toBe("running");
      expect(noteRow()?.error ?? "").not.toContain("launchd");
    });

    it("missing then the source goes missing: the note no longer says missing", async () => {
      const state = newStudioState();
      await collectStudioLoop(loop, store, TZ, NOW, state, live(), runner(113).run);
      expect(noteRow()?.error).toBe("launchd job missing: x");
      const gone = { ...loop, logsDir: join(dir, "nope") };
      await collectStudioLoop(gone, store, TZ, NOW, state, live(), runner(113).run);
      expect(noteRow()?.error ?? "").not.toContain("missing");
    });

    it("missing then the poll throws: the note no longer says missing", async () => {
      const state = newStudioState();
      await collectStudioLoop(loop, store, TZ, NOW, state, live(), runner(113).run);
      expect(noteRow()?.error).toBe("launchd job missing: x");
      rmSync(join(logsDir, "driver.log"));
      await collectStudioLoop(loop, store, TZ, NOW, state, live(), runner(0).run);
      expect(store.status().find((c) => c.collector === "studio-loop:studio-builder")?.ok).toBe(
        false,
      );
      expect(noteRow()?.error ?? "").not.toContain("missing");
    });

    it("missing and the poll throws in the same call: the catch writes the missing note", async () => {
      rmSync(join(logsDir, "driver.log"));
      await collectStudioLoop(loop, store, TZ, NOW, newStudioState(), live(), runner(113).run);
      expect(store.status().find((c) => c.collector === "studio-loop:studio-builder")?.ok).toBe(
        false,
      );
      expect(noteRow()).toMatchObject({ ok: true, error: "launchd job missing: x" });
    });

    it("error: no launchd note, the error is logged, the fire stays running", async () => {
      const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await collectStudioLoop(loop, store, TZ, NOW, newStudioState(), live(), runner(1).run);
        await collectStudioLoop(loop, store, TZ, NOW, newStudioState(), live(), async () => {
          throw new Error("spawn launchctl ENOENT");
        });
        expect(noteRow()?.error ?? "").not.toContain("launchd");
        expect(byId().get("studio-builder:20261017-124500")?.status).toBe("running");
        const logged = write.mock.calls.map((c) => String(c[0])).join("");
        expect(logged).toContain("launchctl print exited 1");
        expect(logged).toContain("spawn launchctl ENOENT");
      } finally {
        write.mockRestore();
      }
    });
  });

  it("re-parses driver.log from 0 after truncation", async () => {
    const p = join(logsDir, "driver.log");
    const state = newStudioState();
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    writeFileSync(
      p,
      "[2026-10-17T10:20:03Z] === FIRE 42 (main=x openPR=0) ===\n[2026-10-17T11:19:46Z] fire 42 exited 0\n",
    );
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(state.drivers.get("studio-builder")?.model.fires).toHaveLength(1);
    expect(state.drivers.get("studio-builder")?.offset).toBe(statSync(p).size);
  });

  it("stores no row for a fresh fire without log or exit, then the stamped id once the log appears", async () => {
    const p = join(logsDir, "driver.log");
    rmSync(join(logsDir, F43));
    const state = newStudioState();
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(store.runs("studio-builder", 100)).toHaveLength(4);
    expect([...byId().keys()].some((k) => k.includes(`t${U("2026-10-17T11:45:00Z") / 1000}`))).toBe(
      false,
    );
    copyFileSync(join(FIX, F43), join(logsDir, F43));
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(byId().get("studio-builder:20261017-124500")?.status).toBe("running");
    expect(store.runs("studio-builder", 100)).toHaveLength(5);
    expect(readFileSync(p, "utf8")).toContain("FIRE 43");
  });

  it("stores a t<sec> row when the log-less fire exits", async () => {
    rmSync(join(logsDir, F43));
    appendFileSync(join(logsDir, "driver.log"), "[2026-10-17T11:49:00Z] fire 43 exited 0\n");
    await run();
    expect(byId().get(`studio-builder:t${U("2026-10-17T11:45:00Z") / 1000}`)).toMatchObject({
      status: "ok",
      transcriptPath: "",
    });
  });

  it("stores the running fire's digest, and rewrites it when only the digest changes", async () => {
    const state = newStudioState();
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    const id = "studio-builder:20261017-124500";
    // The fixture's Bash call has no result before the result line, which ends the live tool.
    expect(store.digest(id)).toMatchObject({
      model: "claude-opus-5-5",
      liveTool: null,
      toolCalls: 1,
    });
    const rows = store.runs("studio-builder", 100);
    const upserts = vi.spyOn(store, "upsertRun");
    const setDigest = vi.spyOn(store, "setDigest");
    // Unchanged transcript: neither the run nor the digest is written again.
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(setDigest).not.toHaveBeenCalled();
    // The Bash call returns late: the digest changes, the run row (tokens, cost, branch) does not.
    appendFileSync(
      join(logsDir, F43),
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ tool_use_id: "toolu_fixture_1", type: "tool_result", content: "ok" }],
        },
        parent_tool_use_id: null,
        timestamp: "2026-10-17T09:06:00.000Z",
      })}\n`,
    );
    await collectStudioLoop(loop, store, TZ, NOW, state, live());
    expect(store.runs("studio-builder", 100)).toEqual(rows);
    expect(upserts).not.toHaveBeenCalled();
    expect(setDigest).toHaveBeenCalledTimes(1);
    expect(store.digest(id)?.liveTool).toBeNull();
    expect(store.digest(id)?.tools.Bash?.durationsMs).toHaveLength(1);
  });

  it("stores no digest for fires whose transcript is not folded", async () => {
    await run();
    const old = [...byId().values()].find((r) => r.transcriptPath === "");
    expect(old).toBeDefined();
    expect(store.digest(old?.id ?? "")).toBeNull();
  });

  it("never writes to the logs dir", async () => {
    const snap = () =>
      readdirSync(logsDir)
        .sort()
        .map((n) => {
          const st = statSync(join(logsDir, n));
          return [n, st.size, st.mtimeMs, readFileSync(join(logsDir, n)).toString()];
        });
    const before = snap();
    await run();
    expect(snap()).toEqual(before);
  });
});
