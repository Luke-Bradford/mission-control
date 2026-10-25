// Register the shared mocks before importing the modules under test.
import "./supervisor-harness.ts";

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clockHm, NEW_LOOP, type Run, type RunLoop } from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { assignIssue, claimAs } from "../src/claim.ts";
import type { GhRunner } from "../src/mcp/gh.ts";
import { CLI_PID_FILE, KEEPER_PID_FILE, pidAlive, readPidFile } from "../src/runtime/keeper.ts";
import * as sessionDriver from "../src/runtime/session.ts";
import type { Supervisor, SupervisorEvent } from "../src/runtime/supervisor.ts";
import { crewCodexDir, crewKeeperDir, type Store } from "../src/store.ts";
import { codexSupervisor } from "./codex-supervisor-harness.ts";
import {
  BRANCH,
  bus,
  clone,
  dbPath,
  dir,
  git,
  make,
  noKeepers,
  prep,
  recorded,
  refusal,
  root,
  seatState,
  store,
  TZ,
  until,
  userLines,
} from "./supervisor-harness.ts";

describe("startRun claims the ticket", () => {
  /** A fake gh that records every call and answers with `code`. */
  const fakeGh = (code = 0) => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return { code, stdout: "", stderr: "" };
    };
    return { calls, gh };
  };

  it.each(["merge", "draft"] as const)("assigns the hub's login in a %s repo", async (autonomy) => {
    const { calls, gh } = fakeGh();
    const { sup } = make({
      autonomy,
      claim: (repo, n) => assignIssue(gh, dir, "me", repo, n),
    });
    sup.start();
    await sup.startRun("guido-1", 42);
    expect(calls).toEqual([["issue", "edit", "42", "--repo", "o/mc", "--add-assignee", "me"]]);
  });

  it("claims once for a writer and never for a planner or a reviewer", async () => {
    const rolesDir = join(dir, "roles");
    mkdirSync(rolesDir);
    for (const r of ["FAO", "GUIDO", "RETRO"]) writeFileSync(join(rolesDir, `${r}.md`), `# ${r}\n`);
    const claim = vi.fn(async () => {});
    const { sup } = make({ rolesDir, claim });
    sup.start();
    await sup.startRun("guido-1", 42);
    expect(claim).toHaveBeenCalledTimes(1);
    await sup.startRun("fao-1", 43);
    await sup.startRun("retro", 44);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when the hub's login is unknown", async () => {
    const { calls, gh } = fakeGh();
    const { sup } = make({ claim: claimAs(gh, dir, () => null) });
    sup.start();
    const e = await refusal(sup.startRun("guido-1", 42));
    expect(e.status).toBe(502);
    expect(calls).toEqual([]);
    expect(store.runs("guido-1", 1)).toEqual([]);
  });

  it("starts nothing when GitHub refuses the claim", async () => {
    const { calls, gh } = fakeGh(1);
    const { sup } = make({ claim: (repo, n) => assignIssue(gh, dir, "me", repo, n) });
    sup.start();
    const e = await refusal(sup.startRun("guido-1", 42));
    expect(e.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(store.runs("guido-1", 1)).toEqual([]);
  });
});

describe("seat states", () => {
  it("goes starting → running → idle on the brief's turn", async () => {
    const { sup } = make();
    sup.start();
    const seen: string[] = [];
    bus.subscribe(() => {
      const s = seatState("guido-1");
      if (s && seen.at(-1) !== s) seen.push(s);
    });
    await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(seen).toEqual(["starting", "running", "idle"]);
    expect(store.seatSession("guido-1")?.reason).toBeNull();
  });

  it("parks the seat on a rejected rate limit, with the reset time", async () => {
    const { sup } = make();
    sup.start();
    await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await sup.message("guido-1", "RATELIMIT", { interrupt: false });
    await until(() => expect(userLines().length).toBe(2));
    // the turn's result has come and gone; parked stays
    await until(() => expect(recorded().length).toBeGreaterThan(2));
    await new Promise((r) => setTimeout(r, 100));
    expect(store.seatSession("guido-1")).toMatchObject({
      state: "parked",
      reason: `rate limited until ${clockHm(1792310400 * 1000, TZ)}`,
    });
    // the process is kept: the next Send resumes
    await sup.message("guido-1", "hello", { interrupt: false });
    await until(() => expect(seatState("guido-1")).toBe("idle"));
  });

  it("puts the seat in error and the run in failed when the process dies", async () => {
    const { sup } = make();
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await sup.message("guido-1", "DIE", { interrupt: false });
    await until(() => expect(seatState("guido-1")).toBe("error"));
    expect(store.seatSession("guido-1")?.reason).toBe("process exited 3");
    const run = store.run(runId);
    expect(run?.status).toBe("failed");
    expect(run?.noReport).toMatchObject({
      code: 3,
      signal: null,
      stopReason: "half",
      isError: true,
    });
    expect(store.notes()).toContainEqual(
      expect.objectContaining({
        runId,
        text: expect.stringContaining("stop reason half"),
      }),
    );
    expect(run?.endedAt).not.toBeNull();
    const lines = readFileSync(run?.transcriptPath ?? "", "utf8").split("\n");
    expect(lines).toContain('{"type":"result","is_error":true,"stop_reason":"half"}');
    const e = await refusal(sup.message("guido-1", "again", { interrupt: false }));
    expect(e.message).toBe("GUIDO-1 has no live session; start it on a ticket");
  });

  it("does not record missing-report diagnostics when evidence was reported before exit", async () => {
    const { sup } = make();
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    store.addEvidence(runId, "done", Date.now());
    await sup.message("guido-1", "DIE", { interrupt: false });
    await until(() => expect(seatState("guido-1")).toBe("error"));
    expect(store.run(runId)?.noReport).toBeUndefined();
    expect(store.notes().filter((n) => n.runId === runId)).toEqual([]);
  });

  it("logs each stderr line, and a crash keeps the last one in the seat's reason", async () => {
    const { sup, log } = make();
    sup.start();
    await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await sup.message("guido-1", "STDERR then DIE", { interrupt: false });
    await until(() => expect(seatState("guido-1")).toBe("error"));
    const logged = log.mock.calls.map((c) => c[0]).filter((m) => m.includes("fake stderr"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^guido-1: fake stderr x+…$/); // cleaned and cut: no escape
    const reason = store.seatSession("guido-1")?.reason ?? "";
    expect(reason).toMatch(/^process exited 3: fake stderr x+…$/);
    expect(reason).not.toContain("\x1b");
  });

  it.each([
    [10_000, /^process exited 3: fake stderr/, /^fake stderr/],
    [10_001, /^process exited 3$/, /^$/],
  ] as const)(
    "keeps stderr only within 10 s of exit (%i ms)",
    async (age, expected, stderrExpected) => {
      let at = Date.now();
      const { sup, log } = make({ now: () => at });
      sup.start();
      await sup.startRun("guido-1", 42);
      await until(() => expect(seatState("guido-1")).toBe("idle"));
      await sup.message("guido-1", "STDERR", { interrupt: false });
      await until(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("fake stderr")));
      await until(() => expect(seatState("guido-1")).toBe("idle"));
      at += age;
      await sup.message("guido-1", "DIE", { interrupt: false });
      await until(() => expect(seatState("guido-1")).toBe("error"));
      const reason = store.seatSession("guido-1")?.reason;
      expect(reason).toMatch(expected);
      const diagnostic = store.run(store.seatSession("guido-1")?.runId ?? "")?.noReport?.lastStderr;
      expect(diagnostic ?? "").toMatch(stderrExpected);
    },
  );

  it.each([
    ["REFUSEINT", 409, "refused the interrupt: not now"],
    ["NOCONTROL", 504, "did not answer the interrupt"],
  ] as const)(
    "a %s interrupt leaves the next error result visible",
    async (mode, status, reason) => {
      const { sup } = make();
      sup.start();
      await sup.startRun("guido-1", 42);
      await until(() => expect(seatState("guido-1")).toBe("idle"));
      await sup.message("guido-1", `${mode} TOOLGAP TURNERROR`, { interrupt: false });
      await until(() => expect(userLines().length).toBe(2));
      const e = await refusal(sup.interrupt("guido-1"));
      expect(e.status).toBe(status);
      expect(e.message).toBe(`GUIDO-1 ${reason}`);
      await sup.message("guido-1", "cue", { interrupt: false });
      await sup.message("guido-1", "cue", { interrupt: false });
      await until(() =>
        expect(store.seatSession("guido-1")).toMatchObject({
          state: "idle",
          reason: "last turn ended in an error",
        }),
      );
    },
  );

  it("accepts an interrupt before a result in the same stdout write", async () => {
    const { sup } = make();
    sup.start();
    await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await sup.message("guido-1", "BATCHINT SLOW", { interrupt: false });
    await until(() => expect(seatState("guido-1")).toBe("running"));
    await sup.interrupt("guido-1");
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(store.seatSession("guido-1")?.reason).toBeNull();
  });

  it.each(["REFUSEINT", "NOCONTROL"])("delivers interrupt-and-send after %s", async (mode) => {
    const { sup } = make();
    sup.start();
    await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await sup.message("guido-1", `${mode} SLOW`, { interrupt: false });
    await until(() => expect(seatState("guido-1")).toBe("running"));
    await sup.message("guido-1", "operator line", { interrupt: true });
    await until(() => expect(userLines()).toContain("operator line"));
  });

  it("marks a turn that really failed with a reason, and an interrupted one without", async () => {
    const { sup } = make();
    sup.start();
    await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await sup.message("guido-1", "SLOW", { interrupt: false });
    await until(() => expect(seatState("guido-1")).toBe("running"));
    await sup.interrupt("guido-1");
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(store.seatSession("guido-1")?.reason).toBeNull();
    await sup.message("guido-1", "TURNERROR", { interrupt: false });
    await until(() =>
      expect(store.seatSession("guido-1")).toMatchObject({
        state: "idle",
        reason: "last turn ended in an error",
      }),
    );
  });
});

describe("supervisor events (Plan 7a)", () => {
  const LOOP: RunLoop = {
    phase: "working",
    reportedEvidenceId: 0,
    prNumber: null,
    pushStartedAt: null,
    pushFor: null,
    unparkedAt: null,
    ciFails: 0,
    ciFailedSha: null,
    relayedSha: null,
    transient: 0,
    lastRefusal: null,
    epoch: 0,
    budgetExtra: 0,
    parked: null,
    touches: null,
    cardFor: null,
  };
  /** Holds the next resume in its checkout check, so the run has no process; returns the release. */
  const holdResume = () => {
    let release = () => {};
    prep.resumeGate = new Promise<void>((r) => {
      release = r;
    });
    return release;
  };
  const watch = (sup: Supervisor) => {
    const seen: SupervisorEvent[] = [];
    sup.on((e) => seen.push(e));
    return seen;
  };
  const ended = (seen: SupervisorEvent[]) => seen.filter((e) => e.kind === "run-ended");

  async function idleRun(opts?: { loop: RunLoop }) {
    const m = make();
    m.sup.start();
    const seen = watch(m.sup);
    const { runId } = await m.sup.startRun("guido-1", 42, opts);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    return { ...m, runId, seen };
  }

  /** A run left active by a stopped hub, and a supervisor that has resumed nothing for it. */
  async function leftActive() {
    const first = make();
    first.sup.start();
    const { runId } = await first.sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await first.sup.stopAll();
    await noKeepers(); // no keeper to attach to: the next supervisor resumes
    return runId;
  }

  describe("idle", () => {
    it("fires after each turn, with last_turn_ended_at written", async () => {
      const m = make();
      m.sup.start();
      const seen = watch(m.sup);
      const { runId } = await m.sup.startRun("guido-1", 42);
      await until(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toEqual({ kind: "idle", seatId: "guido-1", runId, resumed: false });
      const first = store.seatSession("guido-1")?.lastTurnEndedAt;
      expect(first).toEqual(expect.any(Number));
      await new Promise((r) => setTimeout(r, 5));
      await m.sup.message("guido-1", "again", { interrupt: false });
      await until(() => expect(seen).toHaveLength(2));
      expect(store.seatSession("guido-1")?.lastTurnEndedAt).toBeGreaterThan(first ?? 0);
    });

    it("does not fire for a turn that left the seat parked", async () => {
      const { sup, seen } = await idleRun();
      await sup.message("guido-1", "RATELIMIT", { interrupt: false });
      await until(() => expect(seatState("guido-1")).toBe("parked"));
      await new Promise((r) => setTimeout(r, 100));
      expect(seen.filter((e) => e.kind === "idle")).toHaveLength(1);
    });

    it("fires after a resume with resumed: true, leaving last_turn_ended_at alone", async () => {
      const runId = await leftActive();
      const before = store.seatSession("guido-1")?.lastTurnEndedAt;
      expect(before).toEqual(expect.any(Number));
      const { sup } = make();
      const seen = watch(sup);
      sup.start();
      await until(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toEqual({ kind: "idle", seatId: "guido-1", runId, resumed: true });
      expect(store.seatSession("guido-1")?.lastTurnEndedAt).toBe(before);
      expect(sup.seatFacts("guido-1")?.resumedAt).toEqual(expect.any(Number));
    });

    it("delivers an evidence event to listeners", async () => {
      const { sup, seen, runId } = await idleRun();
      sup.emitEvidence("guido-1", runId);
      expect(seen.filter((e) => e.kind === "evidence")).toEqual([
        { kind: "evidence", seatId: "guido-1", runId },
      ]);
    });

    it("delivers a findings event to listeners", async () => {
      const { sup, seen, runId } = await idleRun();
      sup.emitFindings("guido-1", runId);
      expect(seen.filter((e) => e.kind === "findings")).toEqual([
        { kind: "findings", seatId: "guido-1", runId },
      ]);
    });

    it("stops delivering to a listener that unsubscribed", async () => {
      const m = make();
      m.sup.start();
      const seen: SupervisorEvent[] = [];
      const off = m.sup.on((e) => seen.push(e));
      off();
      await m.sup.startRun("guido-1", 42);
      await until(() => expect(seatState("guido-1")).toBe("idle"));
      expect(seen).toEqual([]);
    });

    it("keeps delivering when a listener throws, and logs it", async () => {
      const m = make();
      m.sup.start();
      m.sup.on(() => {
        throw new Error("boom");
      });
      const seen = watch(m.sup);
      await m.sup.startRun("guido-1", 42);
      await until(() => expect(seen).toHaveLength(1));
      expect(m.log.mock.calls.some((c) => c[0].includes("boom"))).toBe(true);
    });
  });

  describe("run-ended", () => {
    it("is operator after Stop, once the store has the end", async () => {
      const { sup, seen, runId } = await idleRun();
      let atEvent: ReturnType<Store["run"]> = null;
      sup.on((e) => {
        if (e.kind === "run-ended") atEvent = store.run(runId);
      });
      await sup.endRun("guido-1");
      expect(ended(seen)).toEqual([
        { kind: "run-ended", seatId: "guido-1", runId, endedBy: "operator" },
      ]);
      expect(atEvent).toMatchObject({ status: "ok", endedBy: "operator" });
      expect(store.run(runId)?.noReport).toBeUndefined();
      expect(store.notes()).toEqual([]);
      expect(seatState("guido-1")).toBe("idle");
    });

    it("is exit after a crash", async () => {
      const { sup, seen, runId } = await idleRun();
      await sup.message("guido-1", "DIE", { interrupt: false });
      await until(() => expect(ended(seen)).toHaveLength(1));
      expect(ended(seen)[0]).toEqual({
        kind: "run-ended",
        seatId: "guido-1",
        runId,
        endedBy: "exit",
      });
      expect(store.run(runId)).toMatchObject({ status: "failed", endedBy: "exit" });
      expect(seatState("guido-1")).toBe("error");
    });

    it("is exit when a resume fails", async () => {
      const runId = await leftActive();
      rmSync(join(root, "mc-crew", "guido-1-42"), { recursive: true, force: true });
      const { sup } = make();
      const seen = watch(sup);
      sup.start();
      await until(() => expect(ended(seen)).toHaveLength(1));
      expect(ended(seen)[0]).toEqual({
        kind: "run-ended",
        seatId: "guido-1",
        runId,
        endedBy: "exit",
      });
      expect(store.run(runId)).toMatchObject({ status: "failed", endedBy: "exit" });
      expect(seatState("guido-1")).toBe("error");
      expect(store.run(runId)?.noReport).toMatchObject({
        code: null,
        signal: null,
        lastStderr: null,
        error: "could not resume: checkout missing",
      });
    });

    it("is operator for a Stop with no live process", async () => {
      const runId = await leftActive();
      const { sup } = make();
      const seen = watch(sup);
      const release = holdResume();
      sup.start(); // the lock is held, the resume waits: the seat has no process
      await sup.endRun("guido-1");
      expect(ended(seen)).toEqual([
        { kind: "run-ended", seatId: "guido-1", runId, endedBy: "operator" },
      ]);
      await sup.stopAll();
      release();
    });

    it("does not fire when the hub shuts down (the run stays active)", async () => {
      const { sup, seen, runId } = await idleRun();
      await sup.stopAll();
      expect(ended(seen)).toEqual([]);
      expect(store.run(runId)?.noReport).toBeUndefined();
      expect(store.notes()).toEqual([]);
    });
  });

  describe("endRunByEngine", () => {
    it("emits seat-free after an engine-ended process releases the seat", async () => {
      const { sup, seen, runId } = await idleRun();
      const free: boolean[] = [];
      sup.on((e) => {
        if (e.kind === "seat-free") free.push(sup.seatBusy(e.seatId));
      });
      await sup.endRunByEngine(runId);
      expect(seen).toContainEqual({ kind: "seat-free", seatId: "guido-1", runId });
      expect(free).toEqual([false]);
    });

    it("does not record a missing report when a PR was merged by hand", async () => {
      const { sup, runId } = await idleRun();
      store.setRunLoop(runId, { ...NEW_LOOP, phase: "done", prNumber: 7 });
      await sup.endRunByEngine(runId);
      expect(store.run(runId)?.noReport).toBeUndefined();
      expect(store.notes()).toEqual([]);
    });

    it("does not record a missing report when a silent parked run's PR was merged", async () => {
      const { sup, runId } = await idleRun();
      store.setRunLoop(runId, {
        ...NEW_LOOP,
        phase: "done",
        prNumber: 7,
        parked: { kind: "silent", reason: "no report", ended: true },
      });
      await sup.endRunByEngine(runId);
      expect(store.run(runId)?.noReport).toBeUndefined();
      expect(store.notes()).toEqual([]);
    });

    it.each(["silent", "budget"])("records an engine end after a %s failure", async (kind) => {
      const { sup, runId } = await idleRun();
      store.setRunLoop(runId, {
        ...NEW_LOOP,
        phase: "parked",
        parked: { kind, reason: "no report", ended: true },
      });
      await sup.endRunByEngine(runId);
      expect(store.run(runId)?.noReport).toBeDefined();
    });

    it("ends the run ok, endedBy engine, leaves the seat idle and removes the worktree", async () => {
      const { sup, seen, runId } = await idleRun();
      const wt = join(root, "mc-crew", "guido-1-42");
      writeFileSync(join(wt, "wip.txt"), "wip\n");
      await sup.endRunByEngine(runId);
      expect(ended(seen)).toEqual([
        { kind: "run-ended", seatId: "guido-1", runId, endedBy: "engine" },
      ]);
      expect(store.run(runId)).toMatchObject({ status: "ok", endedBy: "engine" });
      expect(store.run(runId)?.endedAt).not.toBeNull();
      expect(store.seatSession("guido-1")).toMatchObject({
        state: "idle",
        reason: null,
        runId: null,
      });
      expect(existsSync(wt)).toBe(false);
      // the branch keeps the run's commits
      expect(git(clone, "branch", "--list", BRANCH)).toContain(BRANCH);
      // the seat can start again
      await sup.startRun("guido-1", 42);
    });

    it("is a no-op, with no event, for a run that has ended or does not exist", async () => {
      const { sup, seen, runId } = await idleRun();
      await sup.endRunByEngine(runId);
      await sup.endRunByEngine(runId);
      expect(ended(seen)).toHaveLength(1);
      await sup.endRunByEngine("guido-1:nonesuch");
      expect(ended(seen)).toHaveLength(1);
    });

    it("touches only the named run: another seat's run, and a run its seat has moved on from", async () => {
      const { sup, seen, runId } = await idleRun();
      const other = await sup.startRun("retro", 7);
      await until(() => expect(seatState("retro")).toBe("idle"));
      await sup.endRunByEngine(runId);
      expect(store.run(other.runId)).toMatchObject({ status: "running", endedAt: null });
      expect(store.seatSession("retro")).toMatchObject({ state: "idle", runId: other.runId });
      expect(ended(seen)).toHaveLength(1);
      expect(sup.seatFacts("retro")).not.toBeNull();
    });

    it("leaves a run that is not its seat's current one as it is", async () => {
      const { sup, seen, runId } = await idleRun();
      await sup.endRun("guido-1");
      const next = await sup.startRun("guido-1", 43);
      await until(() => expect(seatState("guido-1")).toBe("idle"));
      // the first run, reopened by hand: it is no longer the seat's run
      store.upsertRun({ ...(store.run(runId) as Run), endedAt: null, status: "running" });
      await sup.endRunByEngine(runId);
      expect(store.run(runId)).toMatchObject({ endedAt: null, status: "running" });
      expect(store.run(next.runId)).toMatchObject({ endedAt: null, status: "running" });
      expect(store.seatSession("guido-1")).toMatchObject({ runId: next.runId, state: "idle" });
      expect(sup.seatFacts("guido-1")).not.toBeNull();
      expect(ended(seen).map((e) => e.endedBy)).toEqual(["operator"]);
    });

    it("leaves a blocked note when the worktree cannot be removed, and still ends the run", async () => {
      const { sup, seen, runId, log } = await idleRun();
      prep.failRemove = true;
      await sup.endRunByEngine(runId);
      expect(ended(seen)).toHaveLength(1);
      expect(store.run(runId)).toMatchObject({ status: "ok", endedBy: "engine" });
      expect(store.notes()).toEqual([
        expect.objectContaining({
          key: `cleanup:${runId}`,
          kind: "blocked",
          runId,
          seatId: "guido-1",
          repoId: "mc",
        }),
      ]);
      expect(log.mock.calls.some((c) => c[0].includes("could not remove"))).toBe(true);
      expect(existsSync(join(root, "mc-crew", "guido-1-42"))).toBe(true);
    });

    it("ends a run with no live process", async () => {
      const runId = await leftActive();
      const { sup } = make();
      const seen = watch(sup);
      const release = holdResume();
      sup.start(); // the resume waits: the seat has no process
      await sup.endRunByEngine(runId);
      expect(ended(seen)).toEqual([
        { kind: "run-ended", seatId: "guido-1", runId, endedBy: "engine" },
      ]);
      expect(seatState("guido-1")).toBe("idle");
      expect(store.seatSession("guido-1")?.runId).toBeNull();
      expect(existsSync(join(root, "mc-crew", "guido-1-42"))).toBe(false);
      await sup.stopAll();
      release();
    });
  });

  describe("startRun with a loop", () => {
    it("creates the run row with the loop and sends the ticket brief as before", async () => {
      const { runId } = await idleRun({ loop: LOOP });
      expect(store.run(runId)?.loop).toEqual(LOOP);
      expect(userLines()[0]).toMatch(/^You are GUIDO-1, /);
    });

    it("leaves the loop off a run started without one", async () => {
      const { runId } = await idleRun();
      expect(store.run(runId)?.loop).toBeUndefined();
    });
  });

  describe("send", () => {
    it("sends a keyed line between turns and claims its key", async () => {
      const { sup, runId } = await idleRun();
      expect(await sup.send(runId, "k1", "CI failed")).toBe("sent");
      await until(() => expect(userLines()).toContain("CI failed"));
      expect(Object.keys(store.claimedKeys(runId))).toEqual(["k1"]);
      expect(store.lastEngineLineAt(runId)).not.toBeNull();
    });

    it("answers busy while the seat is in a turn, even before the CLI's turn-start", async () => {
      const { sup, runId } = await idleRun();
      await sup.message("guido-1", "SLOW", { interrupt: false });
      // message() wrote the line; the CLI has not said turn-start yet
      expect(await sup.send(runId, "k1", "late")).toBe("busy");
      await until(() => expect(seatState("guido-1")).toBe("running"));
      expect(await sup.send(runId, "k1", "late")).toBe("busy");
      expect(store.claimedKeys(runId)).toEqual({});
      await sup.interrupt("guido-1");
      await until(() => expect(seatState("guido-1")).toBe("idle"));
      expect(await sup.send(runId, "k1", "late")).toBe("sent");
    });

    it("answers dup for a key already used, and writes nothing", async () => {
      const { sup, runId, seen } = await idleRun();
      expect(await sup.send(runId, "k1", "one")).toBe("sent");
      // the turn it started has ended: a second idle
      await until(() => expect(seen.filter((e) => e.kind === "idle")).toHaveLength(2));
      const lines = userLines().length;
      expect(await sup.send(runId, "k1", "two")).toBe("dup");
      await new Promise((r) => setTimeout(r, 100));
      expect(userLines()).toHaveLength(lines);
      expect(userLines()).not.toContain("two");
    });

    it("answers gone for an ended run, an unknown run and a run its seat has moved on from", async () => {
      const { sup, runId } = await idleRun();
      expect(await sup.send("guido-1:nonesuch", "k", "x")).toBe("gone");
      await sup.endRun("guido-1");
      expect(await sup.send(runId, "k", "x")).toBe("gone");
      const second = await sup.startRun("guido-1", 43);
      await until(() => expect(seatState("guido-1")).toBe("idle"));
      // the first run, reopened by hand: not ended, but not its seat's current run
      store.upsertRun({ ...(store.run(runId) as Run), endedAt: null, status: "running" });
      expect(await sup.send(runId, "k", "x")).toBe("gone");
      expect(await sup.send(second.runId, "k", "x")).toBe("sent");
    });

    it("answers busy while crew is not started", async () => {
      const runId = await leftActive();
      const { sup } = make(); // not started: the run is not resumed
      expect(await sup.send(runId, "k", "x")).toBe("busy");
      expect(store.claimedKeys(runId)).toEqual({});
    });

    it("answers no-session when the CLI is gone, without claiming the line", async () => {
      const { sup, runId } = await idleRun();
      prep.sessions[0]?.detach();
      await noKeepers();
      expect(await sup.send(runId, "k", "fix it")).toBe("no-session");
      expect(store.claimedKeys(runId)).toEqual({});
      expect(store.run(runId)?.endedAt).toBeNull();
    });

    it("answers no-session on a started hub with no process for the held run", async () => {
      const runId = await leftActive();
      const row = store.seatSession("guido-1");
      if (row === null) throw new Error("missing seat");
      store.setSeatSession({ ...row, runId: null, state: "stopped" });
      const { sup } = make();
      sup.start();
      await Promise.resolve();
      store.setSeatSession(row);
      expect(await sup.send(runId, "k", "x")).toBe("no-session");
      expect(store.claimedKeys(runId)).toEqual({});
    });

    it("resumes a missing CLI through the API message route and asks CAPCOM to retry", async () => {
      const { sup, cfg, runId } = await idleRun();
      prep.sessions[0]?.detach();
      await noKeepers();
      const release = holdResume();
      const app = buildApp({ config: cfg, store, bus, supervisor: sup });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/seats/guido-1/message",
          headers: { "content-type": "application/json" },
          payload: { text: "fix it" },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          error: "GUIDO-1 is being resumed; try again in a moment",
        });
        release();
        await until(() => expect(sup.seatFacts("guido-1")).not.toBeNull());
        expect(store.seatSession("guido-1")?.runId).toBe(runId);
        expect(prep.sessions).toHaveLength(2);
        expect(userLines()).not.toContain("fix it");
      } finally {
        release();
        await app.close();
      }
    });

    it("keeps the previous error in Activity when resuming a held run", async () => {
      const { sup, runId } = await idleRun();
      prep.sessions[0]?.detach();
      await noKeepers();
      const row = store.seatSession("guido-1");
      if (row === null) throw new Error("missing seat");
      store.setSeatSession({ ...row, state: "error", reason: "CLI disappeared" });
      await sup.resumeRun(runId);
      expect(store.agentEvents(0)).toContainEqual(
        expect.objectContaining({
          agentId: "guido-1",
          from: "error",
          to: "idle",
          text: expect.stringContaining("CLI disappeared"),
        }),
      );
    });

    it("resumes a missing CLI once on its run, then sends the pending line", async () => {
      const { sup, runId } = await idleRun();
      const sessionId = store.seatSession("guido-1")?.cliSessionId;
      prep.sessions[0]?.detach();
      await noKeepers();
      const release = holdResume();
      try {
        const resume = sup.resumeRun(runId);
        await sup.resumeRun(runId);
        expect(await sup.send(runId, "k", "fix it")).toBe("busy");
        release();
        await resume;
      } finally {
        release();
      }
      expect(prep.sessions).toHaveLength(2);
      expect(store.seatSession("guido-1")).toMatchObject({ runId, cliSessionId: sessionId });
      expect(await sup.send(runId, "k", "fix it")).toBe("sent");
      await until(() => expect(userLines()).toContain("fix it"));
      expect(userLines().filter((line) => line === "fix it")).toHaveLength(1);
    });

    it("fails a missing session whose checkout is gone, and does not retry it", async () => {
      const { sup, runId, seen } = await idleRun();
      prep.sessions[0]?.detach();
      await noKeepers();
      rmSync(join(root, "mc-crew", "guido-1-42"), { recursive: true, force: true });
      await sup.resumeRun(runId);
      await sup.resumeRun(runId);
      expect(store.run(runId)).toMatchObject({ status: "failed", endedBy: "exit" });
      expect(store.seatSession("guido-1")?.reason).toBe("could not resume: checkout missing");
      expect(ended(seen)).toHaveLength(1);
      expect(await sup.send(runId, "k", "fix it")).toBe("gone");
    });

    it("sends to a seat parked by a rate limit", async () => {
      const { sup, runId } = await idleRun();
      await sup.message("guido-1", "RATELIMIT", { interrupt: false });
      await until(() => expect(seatState("guido-1")).toBe("parked"));
      await new Promise((r) => setTimeout(r, 100));
      expect(sup.seatFacts("guido-1")).toMatchObject({
        inTurn: false,
        rateLimitedUntil: 1792310400 * 1000,
      });
      expect(await sup.send(runId, "k", "go on")).toBe("sent");
      await until(() => expect(userLines()).toContain("go on"));
      expect(sup.seatFacts("guido-1")?.rateLimitedUntil).toBeNull();
    });

    it("does not answer the seat's open questions", async () => {
      const { sup, runId } = await idleRun();
      store.addQuestion({ agentId: "guido-1", runId, text: "which?", at: 1 });
      await sup.send(runId, "k", "x");
      expect(store.openQuestions()).toHaveLength(1);
    });
  });

  describe("seatFacts", () => {
    it("is null for a seat with no process, and tracks the turn", async () => {
      const m = make();
      m.sup.start();
      expect(m.sup.seatFacts("guido-1")).toBeNull();
      await m.sup.startRun("guido-1", 42);
      await until(() => expect(seatState("guido-1")).toBe("idle"));
      expect(m.sup.seatFacts("guido-1")).toEqual({
        inTurn: false,
        resumedAt: null,
        rateLimitedUntil: null,
      });
      await m.sup.message("guido-1", "SLOW", { interrupt: false });
      expect(m.sup.seatFacts("guido-1")?.inTurn).toBe(true);
      expect(m.sup.seatFacts("nobody")).toBeNull();
    });
  });

  /** Each run-ended event with the run's row as the store held it at that moment. */
  const watchStored = (sup: Supervisor) => {
    const snaps: { event: SupervisorEvent; run: Run | null }[] = [];
    sup.on((event) => {
      if (event.kind === "run-ended") snaps.push({ event, run: store.run(event.runId) });
    });
    return snaps;
  };
  const settle = () => new Promise((r) => setTimeout(r, 400));

  describe("run-ended: after the store write, exactly once", () => {
    it("publishes a removed aside ending only while holding the crew lock", () => {
      const { sup } = make();
      const run: Run = {
        id: "removed:1",
        agentId: "removed",
        repoId: "mc",
        seq: 1,
        startedAt: 1000,
        endedAt: null,
        status: "running",
        sessionId: "s",
        model: "sonnet",
        branch: null,
        ticket: null,
        costUsd: null,
        tokens: null,
        transcriptPath: "",
        prs: [],
        summary: null,
        loop: { ...NEW_LOOP, aside: { worktree: "/w/x", wake: false } },
      };
      store.upsertRun(run);
      const seen = watchStored(sup);
      expect(sup.endRemovedAside?.(run.id)).toBe(false);
      expect(store.run(run.id)?.endedAt).toBeNull();
      expect(seen).toEqual([]);
      sup.start();
      expect(sup.endRemovedAside?.(run.id)).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.event).toEqual({
        kind: "run-ended",
        seatId: "removed",
        runId: run.id,
        endedBy: "operator",
      });
      expect(seen[0]?.run).toMatchObject({ status: "ok", endedBy: "operator" });
      expect(seen[0]?.run?.endedAt).not.toBeNull();
      expect(sup.endRemovedAside?.(run.id)).toBe(false);
      expect(seen).toHaveLength(1);
    });

    it.each(["engine", "operator", "exit"])(
      "frees the seat before %s ending and signals once",
      async (ending) => {
        const listeners = new Set<(event: sessionDriver.SessionEvent) => void>();
        let alive = true;
        const exit = () => {
          alive = false;
          for (const listener of [...listeners]) listener({ kind: "exit", code: 0, signal: null });
        };
        const session: sessionDriver.CrewSession = {
          send: () => {},
          control: async () => ({}),
          close: async () => {
            exit();
            return 0;
          },
          detach: () => {},
          on: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          pid: undefined,
          get alive() {
            return alive;
          },
          ready: Promise.resolve(),
          lines: 0,
          closeSent: Promise.resolve(),
        };
        const launch = vi.spyOn(sessionDriver, "startSession").mockReturnValue(session);
        const { sup } = make();
        sup.start();
        try {
          const { runId } = await sup.startRun("guido-1", 42);
          const occupied: boolean[] = [];
          const signals: string[] = [];
          sup.on((event) => {
            if (event.runId !== runId) return;
            if (event.kind === "run-ended" || event.kind === "seat-free") {
              signals.push(event.kind);
              occupied.push(sup.seatBusy("guido-1"));
            }
          });
          if (ending === "engine") await sup.endRunByEngine(runId);
          else if (ending === "operator") await sup.endRun("guido-1");
          else exit();
          await until(() => expect(signals).toContain("run-ended"));
          await settle();
          expect(occupied).toEqual(ending === "engine" ? [false, false] : [false]);
          expect(signals).toEqual(ending === "engine" ? ["seat-free", "run-ended"] : ["run-ended"]);
        } finally {
          await sup.stopAll();
          launch.mockRestore();
        }
      },
    );

    it("failResume", async () => {
      const runId = await leftActive();
      rmSync(join(root, "mc-crew", "guido-1-42"), { recursive: true, force: true });
      const { sup } = make();
      const snaps = watchStored(sup);
      sup.start();
      await until(() => expect(snaps).toHaveLength(1));
      await settle();
      expect(snaps).toHaveLength(1);
      expect(snaps[0]?.event).toEqual({
        kind: "run-ended",
        seatId: "guido-1",
        runId,
        endedBy: "exit",
      });
      expect(snaps[0]?.run).toMatchObject({ status: "failed", endedBy: "exit" });
      expect(snaps[0]?.run?.endedAt).not.toBeNull();
    });

    it("endRun with no process", async () => {
      const runId = await leftActive();
      const { sup } = make();
      const snaps = watchStored(sup);
      const release = holdResume();
      sup.start();
      await sup.endRun("guido-1");
      await settle();
      expect(snaps).toHaveLength(1);
      expect(snaps[0]?.event).toEqual({
        kind: "run-ended",
        seatId: "guido-1",
        runId,
        endedBy: "operator",
      });
      expect(snaps[0]?.run).toMatchObject({ status: "ok", endedBy: "operator" });
      expect(store.run(runId)?.endedBy).toBe("operator");
      await sup.stopAll();
      release();
    });

    it("endRunByEngine, including after the process has exited", async () => {
      const { sup, runId } = await idleRun();
      const snaps = watchStored(sup);
      await sup.endRunByEngine(runId);
      await settle();
      expect(snaps).toHaveLength(1);
      expect(snaps[0]?.event).toEqual({
        kind: "run-ended",
        seatId: "guido-1",
        runId,
        endedBy: "engine",
      });
      expect(snaps[0]?.run).toMatchObject({ status: "ok", endedBy: "engine" });
      expect(snaps[0]?.run?.endedAt).not.toBeNull();
      expect(store.run(runId)?.endedBy).toBe("engine");
    });

    it("a start whose launch throws, as exit", async () => {
      const { sup } = make({ hubRoot: join(dir, "hub'root"), extraArgs: [] });
      const snaps = watchStored(sup);
      sup.start();
      await refusal(sup.startRun("guido-1", 42));
      await settle();
      expect(snaps).toHaveLength(1);
      const runId = snaps[0]?.event.runId ?? "";
      expect(snaps[0]?.event).toEqual({
        kind: "run-ended",
        seatId: "guido-1",
        runId,
        endedBy: "exit",
      });
      expect(snaps[0]?.run).toMatchObject({ status: "failed", endedBy: "exit" });
      expect(snaps[0]?.run?.endedAt).not.toBeNull();
    });

    it("a crash, once, after the store write", async () => {
      const { sup, runId } = await idleRun();
      const snaps = watchStored(sup);
      await sup.message("guido-1", "DIE", { interrupt: false });
      await until(() => expect(snaps).toHaveLength(1));
      await settle();
      expect(snaps).toHaveLength(1);
      expect(snaps[0]?.run).toMatchObject({ status: "failed", endedBy: "exit", id: runId });
    });
  });

  describe("an end during a resume", () => {
    const launches = () => recorded().filter((l) => Array.isArray(l.argv)).length;

    it("the engine's end stops the resume: no process, one event, endedBy engine", async () => {
      const runId = await leftActive();
      const { sup } = make();
      const snaps = watchStored(sup);
      const release = holdResume();
      prep.failRemove = true; // the worktree stays, so the resume's checkout check would pass
      sup.start();
      await sup.endRunByEngine(runId);
      release();
      await settle();
      expect(existsSync(join(root, "mc-crew", "guido-1-42"))).toBe(true);
      expect(launches()).toBe(1); // the first supervisor's only
      expect(sup.seatFacts("guido-1")).toBeNull();
      expect(snaps).toHaveLength(1);
      expect(store.run(runId)?.endedBy).toBe("engine");
      expect(store.seatSession("guido-1")).toMatchObject({ state: "idle", runId: null });
      // a later Stop has no run to end and emits nothing
      await refusal(sup.endRun("guido-1"));
      expect(snaps).toHaveLength(1);
    });

    it("stopAll stops a resume waiting in its checkout check: no CLI, the run stays active", async () => {
      const runId = await leftActive();
      const { sup } = make();
      const release = holdResume();
      sup.start();
      await sup.stopAll();
      release();
      await settle();
      expect(launches()).toBe(1); // the first supervisor's only
      expect(store.run(runId)).toMatchObject({ status: "running", endedAt: null });
      expect(store.activeSeatSessions().map((r) => r.seatId)).toContain("guido-1");
    });

    it("Stop's end stops the resume too", async () => {
      const runId = await leftActive();
      const { sup } = make();
      const snaps = watchStored(sup);
      const release = holdResume();
      sup.start();
      await sup.endRun("guido-1");
      release();
      await settle();
      expect(launches()).toBe(1);
      expect(sup.seatFacts("guido-1")).toBeNull();
      expect(snaps).toHaveLength(1);
      expect(store.run(runId)?.endedBy).toBe("operator");
      expect(seatState("guido-1")).toBe("idle");
    });

    it("an ended run whose worktree check fails does not overwrite the seat", async () => {
      const runId = await leftActive();
      rmSync(join(root, "mc-crew", "guido-1-42"), { recursive: true, force: true });
      const { sup } = make();
      const snaps = watchStored(sup);
      const release = holdResume();
      sup.start();
      await sup.endRunByEngine(runId);
      release();
      await settle();
      expect(snaps).toHaveLength(1);
      expect(store.seatSession("guido-1")).toMatchObject({ state: "idle", runId: null });
    });
  });

  describe("a server that does not run crew", () => {
    it.each([
      ["never started", {}],
      ["disabled", { enabled: false }],
    ])("%s: endRunByEngine and send touch nothing", async (_name, over) => {
      const runId = await leftActive();
      const { sup } = make(over);
      const snaps = watchStored(sup);
      await sup.endRunByEngine(runId);
      expect(await sup.send(runId, "k", "x")).toBe("busy");
      expect(existsSync(join(root, "mc-crew", "guido-1-42"))).toBe(true);
      expect(store.run(runId)?.endedAt).toBeNull();
      expect(store.seatSession("guido-1")).toMatchObject({ runId });
      expect(snaps).toEqual([]);
      expect(store.claimedKeys(runId)).toEqual({});
    });
  });

  describe("send and the engine's end, racing", () => {
    it("answers gone when the run ended while the line waited in the chain", async () => {
      const { sup, runId } = await idleRun();
      const lines = userLines().length;
      const p = sup.send(runId, "k", "late");
      store.setRunEnded(runId, Date.now(), "ok", "engine"); // before the chain runs it
      expect(await p).toBe("gone");
      expect(store.claimedKeys(runId)).toEqual({});
      await settle();
      expect(userLines()).toHaveLength(lines);
    });

    it("answers busy when the run began ending while the line waited", async () => {
      const { sup, runId } = await idleRun();
      const lines = userLines().length;
      const p = sup.send(runId, "k", "late");
      const stop = sup.endRun("guido-1"); // sets ending before the send's turn in the chain
      expect(await p).toBe("busy");
      await stop;
      expect(store.claimedKeys(runId)).toEqual({});
      expect(userLines()).toHaveLength(lines);
    });

    it("drops the key when the write fails, so the line can be sent again", async () => {
      const { sup, runId } = await idleRun();
      prep.failWrite = true;
      expect(await sup.send(runId, "k", "again")).toBe("busy");
      expect(store.claimedKeys(runId)).toEqual({});
      prep.failWrite = false;
      expect(await sup.send(runId, "k", "again")).toBe("sent");
      expect(Object.keys(store.claimedKeys(runId))).toEqual(["k"]);
    });

    it("Stop then the engine's end: operator stands, the seat ends stopped", async () => {
      const { sup, seen, runId } = await idleRun();
      const stop = sup.endRun("guido-1");
      const byEngine = sup.endRunByEngine(runId);
      await Promise.all([stop, byEngine]);
      await settle();
      expect(ended(seen)).toEqual([
        { kind: "run-ended", seatId: "guido-1", runId, endedBy: "operator" },
      ]);
      expect(store.run(runId)?.endedBy).toBe("operator");
      expect(seatState("guido-1")).toBe("idle");
      expect(existsSync(join(root, "mc-crew", "guido-1-42"))).toBe(true);
    });
  });
});

describe("Codex lifecycle events", () => {
  it("steers mid-turn and interrupts before starting the replacement turn", async () => {
    const { sup } = codexSupervisor({ holdTurn: true });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("running"));
    await sup.message("guido-1", "follow this lead", { interrupt: false });
    await until(() => expect(recorded().some((m) => m.method === "turn/steer")).toBe(true));
    await sup.message("guido-1", "replace the turn", { interrupt: true });
    await until(() =>
      expect(
        recorded()
          .filter((m) => m.method?.startsWith("turn/"))
          .map((m) => m.method),
      ).toEqual(["turn/start", "turn/steer", "turn/interrupt", "turn/start"]),
    );
    await sup.endRunByEngine(runId);
  });

  it("keeps the thread and its private storage through set aside, hub restart and wake", async () => {
    const first = codexSupervisor();
    first.sup.start();
    const { runId } = await first.sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    const aside = await first.sup.setAside(runId);
    expect(aside).not.toBeNull();
    store.setRunLoop(runId, {
      ...NEW_LOOP,
      aside: { worktree: aside?.worktree ?? "", wake: true },
    });
    expect(store.run(runId)?.sessionId).toBe("codex-thread-1");
    await first.sup.stopAll();
    const next = codexSupervisor();
    next.sup.start();
    await next.sup.wakeRun(runId);
    await until(() =>
      expect(recorded().find((m) => m.method === "thread/resume")?.params.threadId).toBe(
        "codex-thread-1",
      ),
    );
    expect(store.seatSession("guido-1")?.cliSessionId).toBe("codex-thread-1");
    await next.sup.endRunByEngine(runId);
    expect(existsSync(crewCodexDir(dbPath, runId))).toBe(false);
  });

  it("folds cumulative tokens, unknown cost and the latest plan into the stored run", async () => {
    const { sup } = codexSupervisor({
      usage: {
        total: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, totalTokens: 110 },
        last: { totalTokens: 110 },
        modelContextWindow: 10000,
      },
      plan: { explanation: "Next", plan: [{ step: "Check the fix", status: "in_progress" }] },
    });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(store.run(runId)).toMatchObject({
      costUsd: null,
      tokens: { input: 80, cacheRead: 20, output: 10, cacheCreate: 0 },
      latestPlan: "Next\n[in_progress] Check the fix",
    });
    expect(store.digest(runId)?.minuteTokens.reduce((sum, [, n]) => sum + n, 0)).toBe(90);
    await sup.endRunByEngine(runId);
  });
});

describe("Codex interrupt failures", () => {
  it.each([
    { scenario: { interruptRefused: true }, status: 409 },
    { scenario: { noInterruptAck: true }, status: 504 },
    { scenario: { noInterruptCompletion: true }, status: 504 },
  ])(
    "returns $status without steering or starting a replacement for $scenario",
    async ({ scenario, status }) => {
      const { sup } = codexSupervisor({ ...scenario, holdTurn: true });
      sup.start();
      const { runId } = await sup.startRun("guido-1", 42);
      await until(() => expect(seatState("guido-1")).toBe("running"));
      const error = await refusal(sup.message("guido-1", "replacement", { interrupt: true }));
      expect(error.status).toBe(status);
      expect(
        recorded()
          .filter((m) => m.method?.startsWith("turn/"))
          .map((m) => m.method),
      ).toEqual(["turn/start", "turn/interrupt"]);
      expect(sup.seatFacts("guido-1")?.inTurn).toBe(true);
      await sup.endRunByEngine(runId);
    },
  );

  it("keeps the seat running until delayed interruption completes, then runs the replacement", async () => {
    const signal = join(dir, "interrupt-complete");
    const { sup } = codexSupervisor({ holdTurn: true, interruptCompleteSignal: signal });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("running"));
    let sent = false;
    const replacement = sup.message("guido-1", "replacement", { interrupt: true }).then(() => {
      sent = true;
    });
    await until(() => expect(recorded().some((m) => m.method === "turn/interrupt")).toBe(true));
    expect(sent).toBe(false);
    expect(seatState("guido-1")).toBe("running");
    expect(recorded().filter((m) => m.method === "turn/start")).toHaveLength(1);
    writeFileSync(signal, "complete");
    await replacement;
    await until(() => expect(recorded().filter((m) => m.method === "turn/start")).toHaveLength(2));
    await until(() => expect(seatState("guido-1")).toBe("running"));
    expect(sup.seatFacts("guido-1")?.inTurn).toBe(true);
    await sup.endRunByEngine(runId);
  });

  it("Stop terminates a Codex process after interrupt timeout without touching an unrelated process", async () => {
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const exited = once(unrelated, "exit");
    await once(unrelated, "spawn");
    try {
      const { sup } = codexSupervisor({
        holdTurn: true,
        noInterruptCompletion: true,
        closeDelayMs: 10000,
        ignoreTerm: true,
      });
      sup.start();
      const { runId } = await sup.startRun("guido-1", 42);
      await until(() => expect(seatState("guido-1")).toBe("running"));
      const keeperDir = crewKeeperDir(dbPath, runId);
      const cliPid = readPidFile(keeperDir, CLI_PID_FILE);
      const keeperPid = readPidFile(keeperDir, KEEPER_PID_FILE);
      expect(cliPid).not.toBeNull();
      expect(keeperPid).not.toBeNull();
      const began = Date.now();
      await sup.endRun("guido-1");
      await until(() => {
        expect(pidAlive(cliPid as number)).toBe(false);
        expect(pidAlive(keeperPid as number)).toBe(false);
      });
      expect(Date.now() - began).toBeLessThan(5000);
      expect(recorded().filter((m) => m.method === "turn/interrupt")).toHaveLength(1);
      expect(store.run(runId)).toMatchObject({ endedBy: "operator", status: "ok" });
      expect(existsSync(crewCodexDir(dbPath, runId))).toBe(false);
      expect(pidAlive(unrelated.pid as number)).toBe(true);
    } finally {
      unrelated.kill("SIGTERM");
      await exited;
    }
  });
});
