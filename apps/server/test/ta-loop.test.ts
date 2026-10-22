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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoldState } from "../src/collectors/common.ts";
import {
  collectTaLoop,
  isPaused,
  newTaState,
  parseLoopLog,
  parseStatusMd,
} from "../src/collectors/ta-loop.ts";
import type { AdoptedLoop } from "../src/config.ts";
import { Store } from "../src/store.ts";

const FIX = join(import.meta.dirname, "fixtures");
const NOW = Date.parse("2026-10-17T09:30:00Z");
const T11 = "iteration-20261017T090512Z-7522.11.log";

let dir: string;
let stateDir: string;
let store: Store;
let loop: AdoptedLoop;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-ta-"));
  stateDir = join(dir, "state");
  mkdirSync(stateDir);
  copyFileSync(join(FIX, "ta/loop.log"), join(stateDir, "loop.log"));
  copyFileSync(join(FIX, "ta/status.md"), join(stateDir, "status.md"));
  copyFileSync(join(FIX, "iteration.sample.log"), join(stateDir, T11));
  store = new Store(join(dir, "mc.sqlite"));
  loop = {
    id: "shop-app-ta",
    repoId: "shop-app",
    kind: "ta-loop",
    accountId: "acct",
    stateDir,
    worktree: join(dir, "wt"),
    launchdLabel: "x",
  };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const byId = () => new Map(store.runs("shop-app-ta", 100).map((r) => [r.id, r]));
/** Every pid is a live process (the loop is running), unless a test says otherwise. */
const alive = () => true;

describe("parseLoopLog", () => {
  it("parses every line variant", () => {
    const items = parseLoopLog([
      "2026-10-12T19:22:17Z === ta_loop start (worktree=/w, max=0, cooldown=120s, pid=10866) ===",
      "2026-10-17T09:05:12Z --- iteration 11 start",
      "2026-10-17T09:05:13Z prompt in sync with origin/main:.autonomy/loop_prompt.md (cf8ea1f0e98b)",
      "2026-10-17T06:10:49Z --- iteration 9 OK (transcript: iteration-20261017T032442Z-7522.9.log)",
      "2026-08-14T03:47:04Z --- iteration 81 FAILED rc=1 result_ok=0 (failures in a row: 2)",
      "2026-09-22T12:48:44Z blocked pass -- sleeping 1800s instead of 120s (nothing is eligible)",
      "2026-08-14T03:49:08Z STOPPING: 3 consecutive failures -- see /w/iteration-20260814T034904Z-75192.82.log",
      "2026-10-05T11:52:52Z === ta_loop exit after 136 iteration(s) ===",
    ]);
    expect(items).toEqual([
      {
        seq: 11,
        event: "start",
        at: Date.parse("2026-10-17T09:05:12Z"),
        transcript: null,
        rc: null,
        pid: 10866,
      },
      {
        seq: 9,
        event: "ok",
        at: Date.parse("2026-10-17T06:10:49Z"),
        transcript: "iteration-20261017T032442Z-7522.9.log",
        rc: null,
        pid: 7522,
      },
      {
        seq: 81,
        event: "failed",
        at: Date.parse("2026-08-14T03:47:04Z"),
        transcript: null,
        rc: 1,
        pid: 10866,
      },
      {
        seq: 81,
        event: "blocked",
        at: Date.parse("2026-09-22T12:48:44Z"),
        transcript: null,
        rc: null,
        pid: 10866,
      },
    ]);
  });

  it("uses initialPid and drops a blocked pass with no ended iteration", () => {
    const items = parseLoopLog(
      ["2026-10-17T09:05:12Z --- iteration 3 start", "2026-10-17T09:06:00Z blocked pass -- x"],
      42,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.pid).toBe(42);
  });
});

describe("parseStatusMd", () => {
  it("parses the in-flight iteration", () => {
    const s = parseStatusMd(
      `# TA loop status\n\n- iteration: **11** — IN FLIGHT\n- started: 2026-10-17T09:05:12Z\n- pid: 7522\n- transcript: \`/w/${T11}\`\n`,
    );
    expect(s).toEqual({
      seq: 11,
      inFlight: true,
      startedAt: Date.parse("2026-10-17T09:05:12Z"),
      pid: 7522,
      transcript: `/w/${T11}`,
    });
  });
  it("reports not in flight and rejects junk", () => {
    expect(
      parseStatusMd("- iteration: **4** — idle\n- started: 2026-10-17T09:05:12Z\n- pid: 1\n")
        ?.inFlight,
    ).toBe(false);
    expect(parseStatusMd("garbage")).toBeNull();
  });
});

describe("collectTaLoop", () => {
  it("builds pid-qualified runs across a ta_loop restart", async () => {
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    const runs = byId();
    expect(runs.get("shop-app-ta:1111.1")).toMatchObject({
      seq: 1,
      status: "blocked",
      startedAt: Date.parse("2026-10-12T19:22:18Z"),
      endedAt: Date.parse("2026-10-12T19:30:00Z"),
      transcriptPath: join(stateDir, "iteration-20261012T192218Z-1111.1.log"),
    });
    expect(runs.get("shop-app-ta:2222.1")).toMatchObject({
      seq: 1,
      status: "failed",
      transcriptPath: "",
    });
    expect(runs.get("shop-app-ta:7522.9")).toMatchObject({ status: "ok" });
    expect(runs.size).toBe(4);
  });

  it("marks the status.md in-flight run running and folds its transcript", async () => {
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    const r = byId().get("shop-app-ta:7522.11");
    expect(r).toMatchObject({
      seq: 11,
      status: "running",
      endedAt: null,
      branch: "fix/3757-fence-reacquire",
      ticket: "shop-app#3757",
      model: "claude-opus-5-5",
      transcriptPath: join(stateDir, T11),
    });
    expect(r?.sessionId).toBe("11111111-2222-4333-8444-555555555555");
    expect(r?.tokens).not.toBeNull();
    expect(store.getOffset(join(stateDir, "loop.log"))).toBeGreaterThan(0);
  });

  it("stores the in-flight run's transcript digest", async () => {
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    const d = store.digest("shop-app-ta:7522.11");
    expect(d).toMatchObject({ model: "claude-opus-5-5", turns: 2 });
    expect(d?.lastEventAt).not.toBeNull();
    // Runs do not carry it.
    expect(byId().get("shop-app-ta:7522.11")).not.toHaveProperty("digest");
  });

  it("falls back to the worktree HEAD branch for the in-flight run when the transcript has none", async () => {
    const lines = readFileSync(join(stateDir, T11), "utf8")
      .split("\n")
      .filter((l) => !l.includes("vcs_state_changed"));
    writeFileSync(join(stateDir, T11), lines.join("\n"));
    mkdirSync(join(loop.worktree, ".git"), { recursive: true });
    writeFileSync(join(loop.worktree, ".git", "HEAD"), "ref: refs/heads/docs/3714-spec\n");
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    expect(byId().get("shop-app-ta:7522.11")).toMatchObject({
      status: "running",
      branch: "docs/3714-spec",
      ticket: "shop-app#3714",
    });
  });

  // #26 A3: a re-fold from a transcript that names no branch must not null what was known.
  it("keeps a stored run's branch, ticket, session and model when its transcript names none", async () => {
    const T9 = "iteration-20261017T032442Z-7522.9.log";
    const stripped = readFileSync(join(stateDir, T11), "utf8")
      .split("\n")
      .filter((l) => !l.includes("vcs_state_changed") && !l.includes('"subtype":"init"'))
      .join("\n");
    writeFileSync(join(stateDir, T11), stripped);
    writeFileSync(join(stateDir, T9), stripped);
    const known = {
      agentId: "shop-app-ta",
      repoId: "shop-app",
      endedAt: null,
      status: "unknown" as const,
      sessionId: "s-prev",
      model: "m-prev",
      branch: "fix/12-x",
      ticket: "shop-app#12",
      costUsd: null,
      tokens: null,
      prs: [],
      summary: null,
    };
    store.upsertRun({
      ...known,
      id: "shop-app-ta:7522.9",
      seq: 9,
      startedAt: Date.parse("2026-10-17T03:24:42Z"),
      transcriptPath: join(stateDir, T9),
    });
    store.upsertRun({
      ...known,
      id: "shop-app-ta:7522.11",
      seq: 11,
      startedAt: Date.parse("2026-10-17T09:05:12Z"),
      transcriptPath: join(stateDir, T11),
    });
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    // 9 ended (folded); 11 is in flight with no worktree HEAD to read either.
    expect(byId().get("shop-app-ta:7522.9")).toMatchObject({ status: "ok" });
    expect(byId().get("shop-app-ta:7522.11")).toMatchObject({ status: "running" });
    for (const id of ["shop-app-ta:7522.9", "shop-app-ta:7522.11"]) {
      expect(byId().get(id), id).toMatchObject({
        branch: "fix/12-x",
        ticket: "shop-app#12",
        sessionId: "s-prev",
        model: "m-prev",
      });
      expect(byId().get(id)?.tokens, id).not.toBeNull(); // the fold did happen
    }
  });

  it("stores the PRs and summary of a folded run", async () => {
    appendFileSync(
      join(stateDir, T11),
      `\n${JSON.stringify({
        type: "system",
        subtype: "code_change_published",
        provider: "github",
        repo: "Owner-A/shop-app",
        identifier: "3760",
        action: "created",
      })}\n${JSON.stringify({ type: "result", result: "Opened PR #3760 for review. Waiting." })}\n`,
    );
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    expect(byId().get("shop-app-ta:7522.11")).toMatchObject({
      prs: [{ repo: "Owner-A/shop-app", number: 3760 }],
      summary: "Opened PR #3760 for review. Waiting.",
    });
  });

  it("does not fold transcripts of runs older than 24h", async () => {
    copyFileSync(
      join(FIX, "iteration.sample.log"),
      join(stateDir, "iteration-20261012T192218Z-1111.1.log"),
    );
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    const r = byId().get("shop-app-ta:1111.1");
    expect(r?.costUsd).toBeNull();
    expect(r?.tokens).toBeNull();
  });

  it("prunes fold state of runs it will not fold again after a poll", async () => {
    const state = newTaState();
    const gone = { facts: {} as FoldState["facts"], offset: 1 };
    state.transcripts.set("/t/gone", gone);
    state.digests.set("gone", "{}");
    await collectTaLoop(loop, store, NOW, state, alive);
    expect(state.transcripts.has("/t/gone")).toBe(false);
    expect(state.digests.has("gone")).toBe(false);
    expect(state.transcripts.size).toBeGreaterThan(0);
    expect(state.digests.size).toBeGreaterThan(0);
  });

  it("is idempotent and picks up the end of the in-flight run incrementally", async () => {
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    const state = newTaState();
    await collectTaLoop(loop, store, NOW, state, alive);
    expect(byId().size).toBe(4);
    appendFileSync(
      join(stateDir, "loop.log"),
      `2026-10-17T09:20:00Z --- iteration 11 OK (transcript: ${T11})\n`,
    );
    writeFileSync(
      join(stateDir, "status.md"),
      "# TA loop status\n\n- iteration: **11** — idle\n- started: 2026-10-17T09:05:12Z\n- pid: 7522\n",
    );
    await collectTaLoop(loop, store, NOW, state, alive);
    const r = byId().get("shop-app-ta:7522.11");
    expect(r).toMatchObject({
      status: "ok",
      endedAt: Date.parse("2026-10-17T09:20:00Z"),
      ticket: "shop-app#3757",
    });
  });

  it("re-folds the in-flight transcript on a fresh collector without touching ended runs", async () => {
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    const first = byId().get("shop-app-ta:7522.11");
    const fresh = newTaState();
    await collectTaLoop(loop, store, NOW, fresh, alive);
    expect(fresh.transcripts.has(join(stateDir, T11))).toBe(true);
    expect(fresh.transcripts.size).toBe(1);
    expect(byId().get("shop-app-ta:7522.11")).toEqual(first);
  });

  it("marks the in-flight run running only while its ta_loop pid is alive", async () => {
    const checked: number[] = [];
    await collectTaLoop(loop, store, NOW, newTaState(), (pid) => {
      checked.push(pid);
      return true;
    });
    expect(checked).toContain(7522);
    expect(byId().get("shop-app-ta:7522.11")?.status).toBe("running");
    expect(store.status().find((c) => c.collector === "ta-loop:shop-app-ta")).toMatchObject({
      ok: true,
      error: null,
    });
  });

  it("a reused ta_loop pid (another start time) reads as dead; the same start stays alive", async () => {
    const state = newTaState();
    let start = "Tue Oct 20 09:00:00 2026";
    await collectTaLoop(loop, store, NOW, state, undefined, undefined, () => start);
    expect(byId().get("shop-app-ta:7522.11")?.status).toBe("running");
    await collectTaLoop(loop, store, NOW, state, undefined, undefined, () => start);
    expect(byId().get("shop-app-ta:7522.11")?.status).toBe("running");
    start = "Wed Oct 21 01:00:00 2026";
    await collectTaLoop(loop, store, NOW, state, undefined, undefined, () => start);
    expect(byId().get("shop-app-ta:7522.11")?.status).toBe("unknown");
    expect(store.status().find((c) => c.collector === "ta-loop:shop-app-ta")).toMatchObject({
      ok: false,
      error: "loop process not running (pid 7522)",
    });
  });

  it("a dead ta_loop pid makes the in-flight run unknown and records the collector error", async () => {
    const state = newTaState();
    await collectTaLoop(loop, store, NOW, state, alive);
    expect(byId().get("shop-app-ta:7522.11")?.status).toBe("running");
    await collectTaLoop(loop, store, NOW, state, () => false);
    const r = byId().get("shop-app-ta:7522.11");
    expect(r).toMatchObject({ status: "unknown", endedAt: null });
    expect(store.status().find((c) => c.collector === "ta-loop:shop-app-ta")).toMatchObject({
      ok: false,
      error: "loop process not running (pid 7522)",
    });
    // On a cold start too (no stored running row).
    const cold = new Store(join(dir, "cold.sqlite"));
    await collectTaLoop(loop, cold, NOW, newTaState(), () => false);
    expect(cold.runs("shop-app-ta", 100).find((x) => x.id === "shop-app-ta:7522.11")?.status).toBe(
      "unknown",
    );
    expect(cold.status()[0]).toMatchObject({
      ok: false,
      error: "loop process not running (pid 7522)",
    });
  });

  it("folds runs across more than the window and keeps transcript facts only for runs inside it", async () => {
    const DAY = 24 * 60 * 60_000;
    const state = newTaState();
    await collectTaLoop(loop, store, NOW, state, alive);
    expect([...state.transcripts.keys()]).toEqual([join(stateDir, T11)]);
    // Three days on, the folded run is outside the window and the loop is stopped.
    await collectTaLoop(loop, store, NOW + 3 * DAY, state, () => false);
    expect(state.transcripts.size).toBe(0);
    expect(state.digests.size).toBe(0);
  });

  describe("launchd job", () => {
    const NOTE = "ta-loop:shop-app-ta:note";
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

    it("present: no note, in-flight run stays running", async () => {
      const l = runner(0);
      await collectTaLoop(loop, store, NOW, newTaState(), alive, l.run);
      expect(byId().get("shop-app-ta:7522.11")?.status).toBe("running");
      expect(noteRow()?.error ?? null).toBeNull();
      expect(l.calls).toEqual([["print", `gui/${process.getuid?.() ?? 0}/x`]]);
    });

    it("missing (exit 113): note `launchd job missing: <label>`, nothing running", async () => {
      const state = newTaState();
      await collectTaLoop(loop, store, NOW, state, alive, runner(0).run);
      expect(byId().get("shop-app-ta:7522.11")?.status).toBe("running");
      const l = runner(113);
      await collectTaLoop(loop, store, NOW, state, alive, l.run);
      expect(noteRow()).toMatchObject({ ok: true, error: "launchd job missing: x" });
      expect([...byId().values()].some((r) => r.status === "running")).toBe(false);
      expect(store.status().find((c) => c.collector === "ta-loop:shop-app-ta")).toMatchObject({
        ok: false,
        error: "launchd job missing: x",
      });
      expect(l.calls).toHaveLength(1);
    });

    it("missing then present: the in-flight run returns to running and the note clears", async () => {
      const state = newTaState();
      await collectTaLoop(loop, store, NOW, state, alive, runner(113).run);
      expect(byId().get("shop-app-ta:7522.11")?.status).toBe("unknown");
      expect(noteRow()?.error).toBe("launchd job missing: x");
      await collectTaLoop(loop, store, NOW, state, alive, runner(0).run);
      expect(byId().get("shop-app-ta:7522.11")?.status).toBe("running");
      expect(noteRow()?.error ?? null).toBeNull();
      expect(store.status().find((c) => c.collector === "ta-loop:shop-app-ta")?.ok).toBe(true);
    });

    it("missing then the source goes missing: the note no longer says missing", async () => {
      const state = newTaState();
      await collectTaLoop(loop, store, NOW, state, alive, runner(113).run);
      expect(noteRow()?.error).toBe("launchd job missing: x");
      const gone = { ...loop, stateDir: join(dir, "nope") };
      await collectTaLoop(gone, store, NOW, state, alive, runner(113).run);
      expect(noteRow()?.error ?? null).toBeNull();
    });

    it("missing then the poll throws: the note no longer says missing", async () => {
      const state = newTaState();
      await collectTaLoop(loop, store, NOW, state, alive, runner(113).run);
      expect(noteRow()?.error).toBe("launchd job missing: x");
      rmSync(join(stateDir, "loop.log"));
      mkdirSync(join(stateDir, "loop.log"));
      await collectTaLoop(loop, store, NOW, state, alive, runner(0).run);
      expect(store.status().find((c) => c.collector === "ta-loop:shop-app-ta")?.ok).toBe(false);
      expect(noteRow()?.error ?? null).toBeNull();
    });

    it("missing and the poll throws in the same call: the catch writes the missing note", async () => {
      rmSync(join(stateDir, "loop.log"));
      mkdirSync(join(stateDir, "loop.log"));
      await collectTaLoop(loop, store, NOW, newTaState(), alive, runner(113).run);
      expect(store.status().find((c) => c.collector === "ta-loop:shop-app-ta")?.ok).toBe(false);
      expect(noteRow()).toMatchObject({ ok: true, error: "launchd job missing: x" });
    });

    it("error: no note, the error is logged, the run is untouched", async () => {
      const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await collectTaLoop(loop, store, NOW, newTaState(), alive, runner(1).run);
        await collectTaLoop(loop, store, NOW, newTaState(), alive, async () => {
          throw new Error("spawn launchctl ENOENT");
        });
        expect(noteRow()?.error ?? null).toBeNull();
        expect(byId().get("shop-app-ta:7522.11")?.status).toBe("running");
        const logged = write.mock.calls.map((c) => String(c[0])).join("");
        expect(logged).toContain("launchctl print exited 1");
        expect(logged).toContain("spawn launchctl ENOENT");
      } finally {
        write.mockRestore();
      }
    });
  });

  it("marks a start that is neither ended nor in flight as unknown", async () => {
    writeFileSync(join(stateDir, "status.md"), "# TA loop status\n");
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    expect(byId().get("shop-app-ta:7522.11")?.status).toBe("unknown");
  });

  it("records source missing without throwing", async () => {
    const missing = { ...loop, stateDir: join(dir, "nope") };
    await expect(collectTaLoop(missing, store, NOW, newTaState(), alive)).resolves.toBeUndefined();
    expect(store.runs("shop-app-ta", 10)).toEqual([]);
    expect(store.status().find((c) => c.collector === "ta-loop:shop-app-ta")).toMatchObject({
      ok: false,
      error: `source missing: ${missing.stateDir}`,
    });
  });

  it("never writes to the state dir", async () => {
    const snap = () =>
      readdirSync(stateDir)
        .sort()
        .map((n) => {
          const st = statSync(join(stateDir, n));
          return [n, st.size, st.mtimeMs, readFileSync(join(stateDir, n)).toString()];
        });
    const before = snap();
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    expect(snap()).toEqual(before);
    expect(isPaused(loop)).toBe(false);
    writeFileSync(join(stateDir, "PAUSE"), "");
    expect(isPaused(loop)).toBe(true);
  });

  it("records an unreadable loop.log as a failed collector", async () => {
    rmSync(join(stateDir, "loop.log"));
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    expect(store.status().find((c) => c.collector === "ta-loop:shop-app-ta")?.ok).toBe(false);
  });
});

describe("stable ids and reconciliation", () => {
  const log = () => join(stateDir, "loop.log");
  const idle =
    "# TA loop status\n\n- iteration: **1** — idle\n- started: 2026-10-17T09:00:00Z\n- pid: 1\n";
  beforeEach(() => {
    writeFileSync(join(stateDir, "status.md"), idle);
    rmSync(join(stateDir, T11));
  });

  it("applies a pid from a start-only chunk to the next poll's iteration", async () => {
    writeFileSync(
      log(),
      "2026-10-17T08:00:00Z === ta_loop start (worktree=/w, max=0, cooldown=120s, pid=100) ===\n2026-10-17T08:00:01Z --- iteration 1 start\n",
    );
    const state = newTaState();
    await collectTaLoop(loop, store, NOW, state, alive);
    appendFileSync(
      log(),
      "2026-10-17T08:10:00Z --- iteration 1 OK (transcript: iteration-20261017T080001Z-100.1.log)\n2026-10-17T08:20:00Z === ta_loop start (worktree=/w, max=0, cooldown=120s, pid=200) ===\n",
    );
    await collectTaLoop(loop, store, NOW, state, alive);
    appendFileSync(log(), "2026-10-17T08:20:01Z --- iteration 1 start\n");
    await collectTaLoop(loop, store, NOW, state, alive);
    expect([...byId().keys()].sort()).toEqual(["shop-app-ta:100.1", "shop-app-ta:200.1"]);
  });

  it("recovers the pid by read-back on a fresh collector with a stored offset", async () => {
    writeFileSync(
      log(),
      "2026-10-17T08:00:00Z === ta_loop start (worktree=/w, max=0, cooldown=120s, pid=300) ===\n",
    );
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    appendFileSync(log(), "2026-10-17T08:00:01Z --- iteration 5 start\n");
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    expect([...byId().keys()]).toEqual(["shop-app-ta:300.5"]);
  });

  it("clears and recovers the pid context when loop.log is truncated", async () => {
    writeFileSync(
      log(),
      "2026-10-17T08:00:00Z === ta_loop start (worktree=/w, max=0, cooldown=120s, pid=400) ===\n2026-10-17T08:00:01Z --- iteration 1 start\n2026-10-17T08:00:02Z --- iteration 1 OK\n",
    );
    const state = newTaState();
    await collectTaLoop(loop, store, NOW, state, alive);
    writeFileSync(
      log(),
      "2026-10-17T09:00:00Z === ta_loop start (worktree=/w, max=0, cooldown=1s, pid=500) ===\n2026-10-17T09:00:01Z --- iteration 2 start\n",
    );
    await collectTaLoop(loop, store, NOW, state, alive);
    expect(byId().has("shop-app-ta:500.2")).toBe(true);
  });

  it("keeps one row when a pid-less start later appears in status.md with a pid", async () => {
    writeFileSync(log(), "2026-10-17T09:05:12Z --- iteration 11 start\n");
    const state = newTaState();
    await collectTaLoop(loop, store, NOW, state, alive);
    expect([...byId().keys()]).toEqual(["shop-app-ta:t1792227912.11"]);
    copyFileSync(join(FIX, "ta/status.md"), join(stateDir, "status.md"));
    await collectTaLoop(loop, store, NOW, state, alive);
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    const rows = store.runs("shop-app-ta", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "shop-app-ta:t1792227912.11", status: "running" });
  });

  it("keeps each process's runs apart when the loop restarts within a minute", async () => {
    const t2222 = "iteration-20261022T100036Z-2222.1.log";
    writeFileSync(join(stateDir, t2222), "{}\n");
    rmSync(join(stateDir, "status.md"));
    writeFileSync(
      log(),
      [
        "2026-10-22T10:00:00Z === ta_loop start (worktree=/w, max=0, cooldown=120s, pid=1111) ===",
        "2026-10-22T10:00:01Z --- iteration 1 start",
        "2026-10-22T10:00:20Z --- iteration 1 FAILED rc=1 result_ok=0 (failures in a row: 3)",
        "2026-10-22T10:00:35Z === ta_loop start (worktree=/w, max=0, cooldown=120s, pid=2222) ===",
        "2026-10-22T10:00:36Z --- iteration 1 start",
        `2026-10-22T10:09:00Z --- iteration 1 OK (transcript: ${t2222})`,
        "",
      ].join("\n"),
    );
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    const rows = byId();
    expect([...rows.keys()].sort()).toEqual(["shop-app-ta:1111.1", "shop-app-ta:2222.1"]);
    expect(rows.get("shop-app-ta:1111.1")).toMatchObject({
      status: "failed",
      endedAt: Date.parse("2026-10-22T10:00:20Z"),
    });
    expect(rows.get("shop-app-ta:1111.1")?.transcriptPath).not.toContain(t2222);
    expect(rows.get("shop-app-ta:2222.1")).toMatchObject({
      status: "ok",
      startedAt: Date.parse("2026-10-22T10:00:36Z"),
      endedAt: Date.parse("2026-10-22T10:09:00Z"),
      transcriptPath: join(stateDir, t2222),
    });
  });

  it("starts an end-only run when its transcript started", async () => {
    const name = "iteration-20261022T100036Z-2222.1.log";
    rmSync(join(stateDir, "status.md"));
    writeFileSync(log(), `2026-10-22T10:09:00Z --- iteration 1 OK (transcript: ${name})\n`);
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    const rows = store.runs("shop-app-ta", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      startedAt: Date.parse("2026-10-22T10:00:36Z"),
      endedAt: Date.parse("2026-10-22T10:09:00Z"),
    });
  });

  it("gives pid-less starts with the same seq at different times distinct ids", async () => {
    writeFileSync(
      log(),
      "2026-10-17T07:00:00Z --- iteration 1 start\n2026-10-17T08:00:00Z --- iteration 1 start\n",
    );
    await collectTaLoop(loop, store, NOW, newTaState(), alive);
    expect(byId().size).toBe(2);
  });

  it("marks an in-flight run unknown once status.md moves on without an OK line", async () => {
    const state = newTaState();
    writeFileSync(
      log(),
      "2026-10-17T09:00:00Z === ta_loop start (worktree=/w, max=0, cooldown=1s, pid=7) ===\n2026-10-17T09:00:01Z --- iteration 1 start\n",
    );
    writeFileSync(
      join(stateDir, "status.md"),
      "- iteration: **1** — IN FLIGHT\n- started: 2026-10-17T09:00:01Z\n- pid: 7\n",
    );
    await collectTaLoop(loop, store, NOW, state, alive);
    expect(byId().get("shop-app-ta:7.1")?.status).toBe("running");
    appendFileSync(log(), "2026-10-17T09:10:00Z --- iteration 2 start\n");
    writeFileSync(
      join(stateDir, "status.md"),
      "- iteration: **2** — IN FLIGHT\n- started: 2026-10-17T09:10:00Z\n- pid: 7\n",
    );
    await collectTaLoop(loop, store, NOW, state, alive);
    expect(byId().get("shop-app-ta:7.1")).toMatchObject({
      status: "unknown",
      endedAt: Date.parse("2026-10-17T09:10:00Z"),
    });
    expect(byId().get("shop-app-ta:7.2")?.status).toBe("running");
    appendFileSync(
      log(),
      "2026-10-17T09:12:00Z --- iteration 1 OK (transcript: iteration-20261017T090001Z-7.1.log)\n",
    );
    await collectTaLoop(loop, store, NOW, state, alive);
    const late = byId().get("shop-app-ta:7.1");
    expect(late).toMatchObject({
      status: "ok",
      startedAt: Date.parse("2026-10-17T09:00:01Z"),
      endedAt: Date.parse("2026-10-17T09:12:00Z"),
      transcriptPath: join(stateDir, "iteration-20261017T090001Z-7.1.log"),
    });
    expect([...byId().values()].filter((r) => r.seq === 1)).toHaveLength(1);
  });

  it("updates a reconciled pid-less run in place on a late end line", async () => {
    const state = newTaState();
    writeFileSync(log(), "2026-10-17T09:00:01Z --- iteration 1 start\n");
    await collectTaLoop(loop, store, NOW, state, alive);
    writeFileSync(
      join(stateDir, "status.md"),
      "- iteration: **1** — IN FLIGHT\n- started: 2026-10-17T09:00:01Z\n- pid: 7\n- transcript: `/w/iteration-20261017T090001Z-7.1.log`\n",
    );
    await collectTaLoop(loop, store, NOW, state, alive);
    const before = store.runs("shop-app-ta", 10);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ id: "shop-app-ta:t1792227601.1", status: "running" });
    appendFileSync(log(), "2026-10-17T09:10:00Z --- iteration 2 start\n");
    writeFileSync(
      join(stateDir, "status.md"),
      "- iteration: **2** — IN FLIGHT\n- started: 2026-10-17T09:10:00Z\n- pid: 7\n",
    );
    await collectTaLoop(loop, store, NOW, state, alive);
    expect(byId().get(before[0]?.id ?? "")?.status).toBe("unknown");
    appendFileSync(
      log(),
      "2026-10-17T09:12:00Z --- iteration 1 FAILED rc=1 result_ok=0 (failures in a row: 1)\n",
    );
    await collectTaLoop(loop, store, NOW, state, alive);
    const rows = store.runs("shop-app-ta", 10).filter((r) => r.seq === 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: before[0]?.id,
      status: "failed",
      startedAt: Date.parse("2026-10-17T09:00:01Z"),
      endedAt: Date.parse("2026-10-17T09:12:00Z"),
      transcriptPath: before[0]?.transcriptPath,
    });
  });
});
