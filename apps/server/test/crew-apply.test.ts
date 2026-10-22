import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEW_LOOP, type Run, type Topic } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import { type CcConfig, ConfigError, type CrewSeatConfig } from "../src/config.ts";
import {
  accountNewText,
  areaWaitText,
  CONFIG_POLL_MS,
  createCrewReloader,
  EDIT_WAIT,
  maxSeatsText,
  planCrew,
  RETIRE_WAIT,
  restartNeeded,
  seatMovingText,
  watchWaitText,
} from "../src/crew-apply.ts";
import type { SupervisorEvent } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";

const seat = (id: string, over: Partial<CrewSeatConfig> = {}): CrewSeatConfig => ({
  id,
  role: "GUIDO",
  accountId: "claude-main",
  model: "sonnet",
  area: [],
  ...over,
});

const config = (
  sessions: { id: string; seats: CrewSeatConfig[]; checkout?: string }[],
  over: { maxSeats?: number; accounts?: string[] } = {},
): CcConfig => ({
  operator: { id: "op", timezone: "UTC" },
  accounts: (over.accounts ?? ["claude-main"]).map((id) => ({
    id,
    vendor: "claude",
    alertAt: 80,
    stopAt: 95,
  })),
  repos: [],
  loops: [],
  poll: { usageMinutes: 5, githubSeconds: 60 },
  crew: {
    worktrees: "/w",
    maxSeats: over.maxSeats ?? 8,
    sessions: sessions.map((s) => ({
      id: s.id,
      repoId: "shop-app",
      checkout: s.checkout ?? `/clone/${s.id}`,
      seats: s.seats,
    })),
  },
});

const none = () => false;

describe("planCrew", () => {
  it("same target: nothing", () => {
    const a = config([{ id: "s1", seats: [seat("guido-1"), seat("guido-2")] }]);
    const plan = planCrew(a, structuredClone(a), none);
    expect(plan.applied).toEqual([]);
    expect(plan.pending).toEqual([]);
    expect(plan.drop).toEqual([]);
    expect(plan.sessions.get("s1")).toEqual(a.crew?.sessions[0]?.seats);
  });

  it("adds a seat", () => {
    const a = config([{ id: "s1", seats: [seat("guido-1", { area: ["y/**"] })] }]);
    const t = config([
      {
        id: "s1",
        seats: [seat("guido-0", { area: ["x/**"] }), seat("guido-1", { area: ["y/**"] })],
      },
    ]);
    const plan = planCrew(a, t, none);
    expect(plan.applied).toEqual(["seat guido-0 added"]);
    expect(plan.sessions.get("s1")?.map((s) => s.id)).toEqual(["guido-0", "guido-1"]);
    expect(plan.drop).toEqual([]);
  });

  it("edit: free applies, busy waits", () => {
    const a = config([{ id: "s1", seats: [seat("guido-1")] }]);
    const t = config([{ id: "s1", seats: [seat("guido-1", { model: "opus" })] }]);
    const waiting = planCrew(a, t, (id) => id === "guido-1");
    expect(waiting.pending).toEqual([
      { sessionId: "s1", seatId: "guido-1", change: "edit", reason: EDIT_WAIT },
    ]);
    expect(waiting.sessions.get("s1")?.[0]?.model).toBe("sonnet");
    expect(waiting.applied).toEqual([]);
    const free = planCrew(a, t, none);
    expect(free.pending).toEqual([]);
    expect(free.applied).toEqual(["seat guido-1 changed"]);
    expect(free.drop).toEqual(["guido-1"]);
    expect(free.sessions.get("s1")?.[0]?.model).toBe("opus");
  });

  it("remove: free goes, busy retires, then goes", () => {
    const a = config([{ id: "s1", seats: [seat("guido-1"), seat("guido-2")] }]);
    const t = config([{ id: "s1", seats: [seat("guido-1")] }]);
    const retiring = planCrew(a, t, (id) => id === "guido-2");
    expect(retiring.pending).toEqual([
      { sessionId: "s1", seatId: "guido-2", change: "remove", reason: RETIRE_WAIT },
    ]);
    expect(retiring.applied).toEqual(["seat guido-2 retiring"]);
    expect(retiring.drop).toEqual(["guido-2"]);
    expect(retiring.sessions.get("s1")).toEqual([
      seat("guido-1"),
      seat("guido-2", { retiring: true }),
    ]);
    // the next pass: already retiring, still busy → no second "retiring"
    const held = config([{ id: "s1", seats: retiring.sessions.get("s1") ?? [] }]);
    const again = planCrew(held, t, (id) => id === "guido-2");
    expect(again.applied).toEqual([]);
    expect(again.pending).toHaveLength(1);
    // free: gone
    const gone = planCrew(held, t, none);
    expect(gone.applied).toEqual(["seat guido-2 removed"]);
    expect(gone.pending).toEqual([]);
    expect(gone.sessions.get("s1")).toEqual([seat("guido-1")]);
    expect(planCrew(a, t, none).applied).toEqual(["seat guido-2 removed"]);
  });

  it("re-added while retiring is kept", () => {
    const a = config([{ id: "s1", seats: [seat("guido-1", { retiring: true })] }]);
    const t = config([{ id: "s1", seats: [seat("guido-1")] }]);
    const plan = planCrew(a, t, () => true);
    expect(plan.applied).toEqual(["seat guido-1 kept"]);
    expect(plan.pending).toEqual([]);
    expect(plan.sessions.get("s1")?.[0]).toEqual(seat("guido-1"));
    expect("retiring" in (plan.sessions.get("s1")?.[0] ?? {})).toBe(false);
  });

  describe("pending texts", () => {
    it("moved seat", () => {
      const a = config([
        { id: "s1", seats: [seat("guido-1")] },
        { id: "s2", seats: [seat("guido-2")] },
      ]);
      const t = config([
        { id: "s1", seats: [seat("guido-1"), seat("guido-2")] },
        { id: "s2", seats: [] },
      ]);
      const plan = planCrew(a, t, none);
      expect(plan.pending).toEqual([
        {
          sessionId: "s1",
          seatId: "guido-2",
          change: "add",
          reason: seatMovingText("guido-2", "s2"),
        },
      ]);
      expect(seatMovingText("guido-2", "s2")).toBe("waits for guido-2 to leave s/s2");
    });

    it("new account", () => {
      const a = config([{ id: "s1", seats: [seat("guido-1")] }]);
      const t = config(
        [{ id: "s1", seats: [seat("guido-1"), seat("guido-2", { accountId: "other" })] }],
        {
          accounts: ["claude-main", "other"],
        },
      );
      const plan = planCrew(a, t, none);
      expect(plan.pending).toEqual([
        { sessionId: "s1", seatId: "guido-2", change: "add", reason: accountNewText("other") },
      ]);
      expect(accountNewText("other")).toBe('account "other" is new; restart the hub to use it');
    });

    it("max_seats full", () => {
      const a = config([{ id: "s1", seats: [seat("guido-1")] }], { maxSeats: 1 });
      const t = config([{ id: "s1", seats: [seat("guido-1"), seat("guido-2")] }], { maxSeats: 1 });
      const plan = planCrew(a, t, none);
      expect(plan.pending).toEqual([
        { sessionId: "s1", seatId: "guido-2", change: "add", reason: maxSeatsText(1) },
      ]);
      expect(maxSeatsText(1)).toBe("max_seats 1 is full until a removed seat leaves");
    });

    it("area overlaps a waiting seat", () => {
      const a = config([{ id: "s1", seats: [seat("guido-1", { area: ["a/**"] })] }]);
      // guido-1 is busy and moves to b/**; guido-2 takes a/**'s neighbour a/x/** and must wait
      const t = config([
        {
          id: "s1",
          seats: [seat("guido-1", { area: ["b/**"] }), seat("guido-2", { area: ["a/x/**"] })],
        },
      ]);
      const plan = planCrew(a, t, (id) => id === "guido-1");
      expect(plan.pending).toEqual([
        { sessionId: "s1", seatId: "guido-1", change: "edit", reason: EDIT_WAIT },
        { sessionId: "s1", seatId: "guido-2", change: "add", reason: areaWaitText("guido-1") },
      ]);
      expect(areaWaitText("guido-1")).toBe(
        "its area overlaps guido-1's, which has not changed yet",
      );
      // a free edit into an overlapping area also waits, as an edit
      const t2 = config([
        {
          id: "s1",
          seats: [seat("guido-1", { area: ["a/**"] }), seat("guido-2", { area: ["a/x/**"] })],
        },
      ]);
      const a2 = config([
        {
          id: "s1",
          seats: [seat("guido-1", { area: ["a/**"] }), seat("guido-2", { area: ["c/**"] })],
        },
      ]);
      const plan2 = planCrew(a2, t2, none);
      expect(plan2.pending).toEqual([
        { sessionId: "s1", seatId: "guido-2", change: "edit", reason: areaWaitText("guido-1") },
      ]);
      expect(plan2.sessions.get("s1")?.[1]?.area).toEqual(["c/**"]);
    });
  });

  it("a role change is an edit", () => {
    const a = config([{ id: "s1", seats: [seat("guido-1", { def: undefined })] }]);
    const t = config([
      {
        id: "s1",
        seats: [
          seat("guido-1", {
            def: { mode: "writer", loop: "build", prompt: "roles/X.md", mcTools: [], here: "" },
          }),
        ],
      },
    ]);
    expect(planCrew(a, t, (id) => id === "guido-1").pending[0]?.change).toBe("edit");
    expect(planCrew(a, t, none).applied).toEqual(["seat guido-1 changed"]);
  });
});

describe("planCrew: accounts and the watch seat", () => {
  it("an edit moving a seat to an account the running config lacks waits", () => {
    const a = config([{ id: "s1", seats: [seat("guido-1")] }]);
    const t = config([{ id: "s1", seats: [seat("guido-1", { accountId: "claude-new" })] }]);
    const out = planCrew(a, t, none);
    expect(out.pending).toEqual([
      { sessionId: "s1", seatId: "guido-1", change: "edit", reason: accountNewText("claude-new") },
    ]);
    expect(out.sessions.get("s1")?.[0]?.accountId).toBe("claude-main");
    expect(out.applied).toEqual([]);
  });

  it("a second watch seat waits for the first, even a retiring one", () => {
    const flight = (id: string) => seat(id, { role: "FLIGHT" });
    const a = config([{ id: "s1", seats: [flight("flight-1"), seat("guido-1")] }]);
    const t = config([
      { id: "s1", seats: [flight("flight-1"), seat("guido-1"), flight("flight-2")] },
    ]);
    const out = planCrew(a, t, none);
    expect(out.pending).toEqual([
      { sessionId: "s1", seatId: "flight-2", change: "add", reason: watchWaitText("flight-1") },
    ]);
    // flight-1 is removed while busy: it retires and still holds the watch
    const swap = config([{ id: "s1", seats: [seat("guido-1"), flight("flight-2")] }]);
    const retiring = planCrew(a, swap, (id) => id === "flight-1");
    expect(retiring.pending.map((p) => [p.seatId, p.reason])).toEqual([
      ["flight-1", RETIRE_WAIT],
      ["flight-2", watchWaitText("flight-1")],
    ]);
    // an edit turning a developer seat into a watch seat waits as well
    const edit = config([
      { id: "s1", seats: [flight("flight-1"), seat("guido-1", { role: "FLIGHT" })] },
    ]);
    expect(planCrew(a, edit, none).pending[0]).toMatchObject({
      seatId: "guido-1",
      change: "edit",
      reason: watchWaitText("flight-1"),
    });
    // another session's watch seat counts too
    const two = config([
      { id: "s1", seats: [flight("flight-1")] },
      { id: "s2", seats: [seat("guido-1")] },
    ]);
    const addTwo = config([
      { id: "s1", seats: [flight("flight-1")] },
      { id: "s2", seats: [seat("guido-1"), flight("flight-3")] },
    ]);
    expect(planCrew(two, addTwo, none).pending[0]?.reason).toBe(watchWaitText("flight-1"));
  });

  it("the watch seat itself can be edited", () => {
    const a = config([{ id: "s1", seats: [seat("flight-1", { role: "FLIGHT" })] }]);
    const t = config([
      { id: "s1", seats: [seat("flight-1", { role: "FLIGHT", model: "sonnet" })] },
    ]);
    expect(planCrew(a, t, none).pending).toEqual([]);
  });
});

describe("restartNeeded", () => {
  const base = () => config([{ id: "s1", seats: [seat("guido-1")] }]);
  type Crew = NonNullable<CcConfig["crew"]>;
  const changed = (edit: (c: CcConfig, k: Crew) => void): string[] => {
    const t = base();
    edit(t, t.crew as Crew);
    return restartNeeded(base(), t);
  };

  it("lists each key that differs, in order", () => {
    expect(restartNeeded(base(), base())).toEqual([]);
    expect(
      changed((c) => {
        c.operator.timezone = "Europe/London";
      }),
    ).toEqual(["operator"]);
    expect(
      changed((c) => c.accounts.push({ id: "b", vendor: "claude", alertAt: 1, stopAt: 2 })),
    ).toEqual(["accounts"]);
    expect(
      changed((c) =>
        c.repos.push({ id: "r", github: "o/r", project: 1, statusMap: {}, autonomy: "draft" }),
      ),
    ).toEqual(["repos"]);
    expect(
      changed((c) =>
        c.loops.push({
          id: "l",
          repoId: "r",
          kind: "ta-loop",
          accountId: "claude-main",
          stateDir: "/s",
          worktree: "/w",
          launchdLabel: "x",
        }),
      ),
    ).toEqual(["loops"]);
    expect(
      changed((c) => {
        c.poll.githubSeconds = 5;
      }),
    ).toEqual(["poll"]);
    expect(
      changed((c) => {
        c.poll.githubSeconds = 5;
        c.operator.id = "x";
      }),
    ).toEqual(["operator", "poll"]);
  });

  it("names the crew keys", () => {
    const keys: [string, Partial<Crew>][] = [
      ["crew.worktrees", { worktrees: "/other" }],
      ["crew.node", { node: "/n" }],
      ["crew.deny_read", { denyRead: ["/x"] }],
      ["crew.run_token_budget", { runTokenBudget: 5 }],
    ];
    for (const [name, patch] of keys) {
      expect(changed((_c, k) => void Object.assign(k, patch))).toEqual([name]);
    }
    // not restart keys: the note is prose, max_seats applies live
    expect(changed((_c, k) => void Object.assign(k, { nodeNote: "old node" }))).toEqual([]);
    expect(changed((_c, k) => void Object.assign(k, { maxSeats: 2 }))).toEqual([]);
  });

  it("a changed checkout is crew.sessions; no crew on one side is crew", () => {
    const first = (k: Crew) => k.sessions[0] as Crew["sessions"][number];
    expect(changed((_c, k) => void Object.assign(first(k), { checkout: "/elsewhere" }))).toEqual([
      "crew.sessions",
    ]);
    expect(changed((_c, k) => k.sessions.push({ ...first(k), id: "s2" }))).toEqual([
      "crew.sessions",
    ]);
    expect(changed((c) => void Object.assign(c, { crew: undefined }))).toEqual(["crew"]);
    const bare = base();
    bare.crew = undefined;
    expect(restartNeeded(bare, base())).toEqual(["crew"]);
    expect(restartNeeded(bare, structuredClone(bare))).toEqual([]);
  });
});

describe("the reloader", () => {
  let dir: string;
  let path: string;
  let store: Store;
  let bus: ChangeBus;
  let topics: Topic[];
  let busy: Set<string>;
  let listener: ((e: SupervisorEvent) => void) | null;
  let loaded: CcConfig | Error;
  let applied: CcConfig;

  const supervisor = () => ({
    on: (fn: (e: SupervisorEvent) => void) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    seatBusy: (id: string) => busy.has(id),
  });
  const make = () =>
    createCrewReloader({
      configPath: path,
      config: applied,
      store,
      bus,
      supervisor: supervisor(),
      log: () => {},
      load: () => {
        if (loaded instanceof Error) throw loaded;
        return structuredClone(loaded);
      },
    });
  /** Rewrites the file so its stat changes. */
  const touch = (n: number) => {
    writeFileSync(path, `v${n}`);
    utimesSync(path, new Date(1_000_000 + n * 1000), new Date(1_000_000 + n * 1000));
  };
  const seatsOf = (c: CcConfig) => c.crew?.sessions[0]?.seats.map((s) => s.id);

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "mc-crew-apply-"));
    mkdirSync(dir, { recursive: true });
    path = join(dir, "config.yaml");
    touch(0);
    store = new Store(join(dir, "mc.sqlite"));
    bus = new ChangeBus();
    topics = [];
    bus.subscribe((t) => topics.push(t));
    busy = new Set();
    listener = null;
    applied = config([{ id: "s1", seats: [seat("guido-1")] }]);
    loaded = structuredClone(applied);
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a changed file is reloaded on the poll", async () => {
    const arr = applied.crew?.sessions[0]?.seats;
    const r = make();
    r.start();
    loaded = config([{ id: "s1", seats: [seat("guido-1"), seat("guido-2")] }]);
    touch(1);
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);
    expect(applied.crew?.sessions[0]?.seats).toBe(arr);
    expect(seatsOf(applied)).toEqual(["guido-1", "guido-2"]);
    expect(topics).toContain("config");
    expect(topics).toContain("agents");
    expect(r.status().sessions[0]?.seats.map((s) => s.id)).toEqual(["guido-1", "guido-2"]);
    expect(r.status().checkedAt).not.toBeNull();
    r.stop();
  });

  it("an unchanged file is not reloaded", async () => {
    const load = vi.fn(() => structuredClone(applied));
    const r = createCrewReloader({
      configPath: path,
      config: applied,
      store,
      bus,
      supervisor: supervisor(),
      load,
    });
    r.start();
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS * 3);
    expect(load).not.toHaveBeenCalled();
    r.stop();
  });

  it("an invalid file applies nothing", async () => {
    const r = make();
    loaded = new ConfigError("crew.sessions[0]", "boom");
    const out = await r.reload();
    expect(out.error).toBe("crew.sessions[0]: boom");
    expect(out.applied).toEqual([]);
    expect(seatsOf(applied)).toEqual(["guido-1"]);
    expect(topics).toContain("config");
    loaded = new Error("EACCES secret/path");
    expect((await r.reload()).error).toBe("cannot read config.yaml");
    // a good file clears it
    loaded = config([{ id: "s1", seats: [seat("guido-1"), seat("guido-2")] }]);
    const ok = await r.reload();
    expect(ok.error).toBeNull();
    expect(ok.applied).toEqual(["seat guido-2 added"]);
  });

  it("run-ended settles a waiting edit", async () => {
    const r = make();
    r.start();
    busy.add("guido-1");
    loaded = config([{ id: "s1", seats: [seat("guido-1", { model: "opus" })] }]);
    const out = await r.reload();
    expect(out.pending).toHaveLength(1);
    expect(applied.crew?.sessions[0]?.seats[0]?.model).toBe("sonnet");
    busy.clear();
    listener?.({ kind: "run-ended", seatId: "guido-1", runId: "r", endedBy: "engine" });
    expect(applied.crew?.sessions[0]?.seats[0]?.model).toBe("opus");
    expect(r.status().pending).toEqual([]);
    r.stop();
    expect(listener).toBeNull();
  });

  it("a waiting edit is settled on the poll once the seat is free", async () => {
    const r = make();
    r.start();
    busy.add("guido-1");
    loaded = config([{ id: "s1", seats: [seat("guido-1", { model: "opus" })] }]);
    await r.reload();
    busy.clear();
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);
    expect(applied.crew?.sessions[0]?.seats[0]?.model).toBe("opus");
    r.stop();
  });

  it("a retiring seat's untaken queue rows go; a taken row keeps it busy", async () => {
    applied = config([{ id: "s1", seats: [seat("guido-1"), seat("guido-2")] }]);
    store.replaceQueue("guido-2", [
      { repoId: "shop-app", issue: 1 },
      { repoId: "shop-app", issue: 2 },
    ]);
    expect(store.takeQueued("guido-2", 10)?.issue).toBe(1);
    loaded = config([{ id: "s1", seats: [seat("guido-1")] }]);
    const r = make();
    const out = await r.reload();
    // the taken row keeps the seat busy: it retires, its untaken row is gone
    expect(out.applied).toEqual(["seat guido-2 retiring"]);
    expect(applied.crew?.sessions[0]?.seats[1]?.retiring).toBe(true);
    expect(store.queue("guido-2").map((q) => q.issue)).toEqual([1]);
    expect(r.status().pending[0]?.change).toBe("remove");
  });

  it("an aside run keeps its seat busy: an edit waits, a removal retires", async () => {
    applied = config([{ id: "s1", seats: [seat("guido-1"), seat("guido-2")] }]);
    const aside: Run = {
      id: "guido-1:1",
      agentId: "guido-1",
      repoId: "shop-app",
      seq: 1,
      startedAt: 1000,
      endedAt: null,
      status: "running",
      sessionId: "s",
      model: "sonnet",
      branch: null,
      ticket: "shop-app#9",
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
      loop: { ...NEW_LOOP, aside: { worktree: "/w/x", wake: false } },
    };
    store.upsertRun(aside);
    expect(store.seatSession("guido-1")).toBeNull();
    const r = make();
    loaded = config([{ id: "s1", seats: [seat("guido-1", { model: "opus" }), seat("guido-2")] }]);
    let out = await r.reload();
    expect(out.applied).toEqual([]);
    expect(out.pending).toEqual([
      { sessionId: "s1", seatId: "guido-1", change: "edit", reason: EDIT_WAIT },
    ]);
    expect(applied.crew?.sessions[0]?.seats[0]?.model).toBe("sonnet");
    loaded = config([{ id: "s1", seats: [seat("guido-2")] }]);
    out = await r.reload();
    expect(out.pending).toEqual([
      { sessionId: "s1", seatId: "guido-1", change: "remove", reason: RETIRE_WAIT },
    ]);
    expect(seatsOf(applied)).toEqual(["guido-2", "guido-1"]);
    expect(applied.crew?.sessions[0]?.seats[1]?.retiring).toBe(true);
  });

  it("start twice registers one interval and one listener", async () => {
    const on = vi.fn(supervisor().on);
    const r = createCrewReloader({
      configPath: path,
      config: applied,
      store,
      bus,
      supervisor: { on, seatBusy: () => false },
      log: () => {},
      load: () => structuredClone(loaded as CcConfig),
    });
    r.start();
    r.start();
    expect(on).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    r.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restart-only changes are listed and the observed config is untouched", async () => {
    const r = make();
    loaded = config([{ id: "s1", seats: [seat("guido-1")] }]);
    loaded.poll.githubSeconds = 7;
    const out = await r.reload();
    expect(out.restartNeeded).toEqual(["poll"]);
    expect(applied.poll.githubSeconds).toBe(60);
  });

  it("roles and max_seats apply", async () => {
    const r = make();
    loaded = config([{ id: "s1", seats: [seat("guido-1")] }], { maxSeats: 3 });
    await r.reload();
    expect(applied.crew?.maxSeats).toBe(3);
  });

  it("lane and lane_default apply live, and unsetting the lane clears it", async () => {
    const r = make();
    loaded = config([{ id: "s1", seats: [seat("guido-1")] }]);
    if (loaded.crew === undefined) throw new Error("no crew");
    loaded.crew.lane = "work";
    loaded.crew.laneDefault = true;
    const out = await r.reload();
    expect(out.restartNeeded).toEqual([]);
    expect(applied.crew?.lane).toBe("work");
    expect(applied.crew?.laneDefault).toBe(true);
    loaded = config([{ id: "s1", seats: [seat("guido-1")] }]);
    await r.reload();
    expect(applied.crew?.lane).toBeUndefined();
    expect(applied.crew?.laneDefault).toBe(false);
  });

  it("a missing file is an error and the next poll after it returns reloads", async () => {
    const r = make();
    r.start();
    rmSync(path);
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);
    expect(r.status().error).toBe("cannot read config.yaml");
    loaded = config([{ id: "s1", seats: [seat("guido-1"), seat("guido-2")] }]);
    touch(0);
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);
    expect(r.status().error).toBeNull();
    expect(seatsOf(applied)).toEqual(["guido-1", "guido-2"]);
    r.stop();
  });
});
