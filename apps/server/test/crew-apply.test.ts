import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NEW_LOOP, type Run, type Topic } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import {
  type CcConfig,
  ConfigError,
  type CrewSeatConfig,
  loadConfig,
  seatInput,
} from "../src/config.ts";
import { setSessionSeats } from "../src/config-write.ts";
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
import { crew } from "../src/hud.ts";
import { MACHINE_CAPACITY_DEFAULTS } from "../src/machine-capacity.ts";
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

  it.each([false, true])("moves a free seat in one plan (reverse: %s)", (reverse) => {
    const sessions = [
      { id: "s1", seats: [] as CrewSeatConfig[] },
      { id: "s2", seats: [seat("guido-1")] },
    ];
    if (reverse) sessions.reverse();
    const a = config(sessions, { maxSeats: 1 });
    const t = structuredClone(a);
    for (const session of t.crew?.sessions ?? [])
      session.seats = session.id === "s1" ? [seat("guido-1")] : [];
    const plan = planCrew(a, t, none);
    expect(plan.pending).toEqual([]);
    expect(plan.sessions.get("s1")).toEqual([seat("guido-1")]);
    expect(plan.sessions.get("s2")).toEqual([]);
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

  it("applies focus immediately while other busy-seat edits wait", () => {
    const a = config([{ id: "s1", seats: [seat("guido-1")] }]);
    const t = config([
      { id: "s1", seats: [seat("guido-1", { model: "opus", focus: "label:catalog" })] },
    ]);
    const plan = planCrew(a, t, () => true);
    expect(plan.sessions.get("s1")?.[0]?.focus).toBe("label:catalog");
    expect(plan.sessions.get("s1")?.[0]?.model).toBe("sonnet");
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
      const plan = planCrew(a, t, () => true);
      expect(plan.pending).toEqual([
        {
          sessionId: "s1",
          seatId: "guido-2",
          change: "add",
          reason: seatMovingText("guido-2", "s2"),
        },
        { sessionId: "s2", seatId: "guido-2", change: "remove", reason: RETIRE_WAIT },
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
    expect(changed((_c, k) => void Object.assign(k, { maxOpenRunsPerSeat: 5 }))).toEqual([]);
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
  let rotateFlight: ReturnType<typeof vi.fn<() => void>>;
  let endRunByEngine: ReturnType<typeof vi.fn<(runId: string) => Promise<void>>>;

  let holdsLock = true;
  const endedRemoval = vi.fn();
  const supervisor = () => ({
    holdsCrewLock: () => holdsLock,
    endRemovedAside: (runId: string) => {
      const run = store.run(runId);
      if (!run) return false;
      store.setRunEnded(runId, 2000, "ok", "operator");
      const event = { kind: "run-ended", seatId: run.agentId, runId, endedBy: "operator" } as const;
      endedRemoval(event);
      listener?.(event);
      return true;
    },
    on: (fn: (e: SupervisorEvent) => void) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    seatBusy: (id: string) => busy.has(id),
    endRunByEngine,
  });
  const make = () =>
    createCrewReloader({
      configPath: path,
      config: applied,
      store,
      bus,
      supervisor: supervisor(),
      rotateFlight,
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
    holdsLock = true;
    endedRemoval.mockClear();
    endRunByEngine = vi.fn(async () => {});
    rotateFlight = vi.fn();
    listener = null;
    applied = config([{ id: "s1", seats: [seat("guido-1")] }]);
    loaded = structuredClone(applied);
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies machine-capacity thresholds on reload", async () => {
    const appliedCrew = applied.crew;
    if (appliedCrew === undefined) throw new Error("test fixture has no crew");
    appliedCrew.machineCapacity = { ...MACHINE_CAPACITY_DEFAULTS };
    loaded = structuredClone(applied);
    const loadedCrew = loaded.crew;
    if (loadedCrew === undefined) throw new Error("test fixture has no crew");
    loadedCrew.machineCapacity = {
      ...MACHINE_CAPACITY_DEFAULTS,
      swapUsedPct: 70,
      memoryFreePct: 15,
    };

    await make().reload();

    expect(applied.crew?.machineCapacity).toMatchObject({
      swapUsedPct: 70,
      memoryFreePct: 15,
    });
  });

  describe("flight_powers", () => {
    const repoOf = (flightPowers: "standard" | "superuser") => ({
      id: "shop-app",
      github: "o/shop",
      project: 1,
      statusMap: {},
      flightPowers,
    });
    beforeEach(() => {
      const flight = seat("flight-1", { role: "FLIGHT" });
      applied = config([{ id: "s1", seats: [seat("guido-1"), flight] }]);
      applied.repos = [{ ...repoOf("standard"), autonomy: "draft" }];
      loaded = structuredClone(applied);
      store.setSeatSession({
        seatId: "flight-1",
        runId: "flight-1:1",
        cliSessionId: null,
        state: "idle",
        reason: null,
        worktree: null,
        updatedAt: 1,
      });
    });
    const raise = (to: "standard" | "superuser") => {
      (loaded as CcConfig).repos.forEach((r) => {
        r.flightPowers = to;
      });
    };

    it("is no hub restart; it applies live and requests one FLIGHT rotation", async () => {
      const r = make();
      raise("superuser");
      const out = await r.reload();
      expect(out.restartNeeded).toEqual([]);
      expect(applied.repos[0]?.flightPowers).toBe("superuser");
      expect(out.applied).toContain("repo shop-app flight_powers superuser");
      expect(rotateFlight).toHaveBeenCalledTimes(1);
      expect(endRunByEngine).not.toHaveBeenCalled();
      await r.reload();
      expect(rotateFlight).toHaveBeenCalledTimes(1);
    });

    it("lowering applies live too", async () => {
      for (const r of applied.repos) r.flightPowers = "superuser";
      loaded = structuredClone(applied);
      const r = make();
      raise("standard");
      const out = await r.reload();
      expect(out.restartNeeded).toEqual([]);
      expect(applied.repos[0]?.flightPowers).toBe("standard");
      expect(rotateFlight).toHaveBeenCalledTimes(1);
    });

    it("restartNeeded ignores flightPowers and nothing else in repos", () => {
      const a = structuredClone(applied);
      const b = structuredClone(applied);
      for (const r of b.repos) r.flightPowers = "superuser";
      expect(restartNeeded(a, b)).toEqual([]);
      for (const r of b.repos) r.project = 2;
      expect(restartNeeded(a, b)).toEqual(["repos"]);
    });

    it.each(["plan", "queues"])(
      "applies powers before a failure in %s and a later config load",
      async (where) => {
        const r = make();
        raise("superuser");
        const target = loaded as CcConfig;
        target.crew?.sessions[0]?.seats.push(seat("guido-2", { area: ["other/**"] }));
        if (where === "plan") {
          vi.spyOn(applied.accounts, "some").mockImplementation(() => {
            throw new Error("plan failed");
          });
        } else {
          target.crew?.sessions[0]?.seats.splice(0, 1);
          vi.spyOn(store, "replaceQueues").mockImplementation(() => {
            throw new Error("queues failed");
          });
        }
        const out = await r.reload();
        expect(applied.repos[0]?.flightPowers).toBe("superuser");
        expect(out.applied).toContain("repo shop-app flight_powers superuser");
        expect(rotateFlight).toHaveBeenCalledTimes(1);
        loaded = new ConfigError("crew", "bad config");
        await r.reload();
        expect(applied.repos[0]?.flightPowers).toBe("superuser");
        expect(rotateFlight).toHaveBeenCalledTimes(1);
      },
    );
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

  it("records each seat's loop kind on its older runs at start and before a reload removes it", () => {
    const old = (id: string, agentId: string) =>
      store.upsertRun({
        id,
        agentId,
        repoId: "shop-app",
        seq: 1,
        startedAt: 1,
        endedAt: 2,
        status: "ok",
        sessionId: null,
        model: null,
        branch: null,
        ticket: null,
        costUsd: null,
        tokens: null,
        transcriptPath: "/x",
        prs: [],
        summary: null,
      });
    old("o1", "guido-1");
    const r = make();
    r.start();
    expect(store.run("o1")?.loopKind).toBe("build");
    old("o2", "guido-1");
    loaded = config([{ id: "s1", seats: [seat("guido-2")] }]);
    touch(1);
    return r.reload().then(() => {
      expect(store.run("o2")?.loopKind).toBe("build");
      r.stop();
    });
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

  it("settles once when an ending emits both lifecycle events", () => {
    const r = make();
    r.start();
    vi.spyOn(store, "run").mockReturnValue({ endedAt: 2000 } as Run);
    const reads = vi.spyOn(store, "openQuestions");
    listener?.({ kind: "run-ended", seatId: "guido-1", runId: "r", endedBy: "engine" });
    listener?.({ kind: "seat-free", seatId: "guido-1", runId: "r" });
    expect(reads).toHaveBeenCalledTimes(1);
    r.stop();
  });

  it("seat-free settles before the next poll", async () => {
    const r = make();
    r.start();
    busy.add("guido-1");
    loaded = config([{ id: "s1", seats: [seat("guido-1", { model: "opus" })] }]);
    await r.reload();
    busy.clear();
    listener?.({ kind: "seat-free", seatId: "guido-1", runId: "r" });
    expect(applied.crew?.sessions[0]?.seats[0]?.model).toBe("opus");
    r.stop();
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

  it.each([true, false])(
    "renames a seat immediately, preserving history and queue (busy: %s)",
    async (running) => {
      writeFileSync(
        path,
        readFileSync(resolve(import.meta.dirname, "../../../config.example.yaml"), "utf8").replace(
          "\ncrew:\n",
          `\ncrew:\n  node: ${process.execPath}\n`,
        ),
      );
      applied = loadConfig(path);
      const before = structuredClone(applied);
      const run: Run = {
        id: "guido-1:1",
        agentId: "guido-1",
        repoId: "shop-app",
        seq: 1,
        startedAt: 1000,
        endedAt: null,
        status: "running",
        sessionId: "session-one",
        model: "sonnet",
        branch: "work/one",
        ticket: "shop-app#1",
        costUsd: null,
        tokens: null,
        transcriptPath: join(dir, "transcript.jsonl"),
        prs: [],
        summary: null,
      };
      store.upsertRun(run);
      store.replaceQueue("guido-1", [
        { repoId: "shop-app", issue: 1 },
        { repoId: "shop-app", issue: 2 },
      ]);
      store.addComms({
        at: 1000,
        from: "CAPCOM",
        to: "guido-1",
        ticket: "shop-app#1",
        text: "Check the orbit",
      });
      if (running) {
        busy.add("guido-1");
        store.takeQueued("guido-1", 1000);
      }
      store.setSeatSession({
        seatId: "guido-1",
        runId: run.id,
        cliSessionId: "session-one",
        state: "running",
        reason: null,
        worktree: join(dir, "worktree"),
        updatedAt: 1000,
      });
      const session = store.seatSession("guido-1");
      const runs = store.runs("guido-1", 10);
      const queue = store.queue("guido-1");
      const messages = store.threadComms("guido-1");
      const base = applied.crew?.sessions[0]?.seats.map(seatInput) ?? [];
      await setSessionSeats(
        path,
        "mission-control",
        base,
        base.map((s) => (s.id === "guido-1" ? { ...s, displayCallSign: "Orbit One" } : s)),
        2000,
      );
      const r = createCrewReloader({
        configPath: path,
        config: applied,
        store,
        bus,
        supervisor: supervisor(),
      });
      const out = await r.reload();
      expect(out.pending).toEqual([]);
      expect(applied.crew?.sessions[0]?.seats[0]).toMatchObject({
        id: "guido-1",
        displayCallSign: "Orbit One",
      });
      const renamed = structuredClone(before);
      const renamedSeat = renamed.crew?.sessions[0]?.seats.find((s) => s.id === "guido-1");
      if (!renamedSeat) throw new Error("missing fixture seat");
      renamedSeat.displayCallSign = "Orbit One";
      expect(applied).toEqual(renamed);
      // history is kept; the reload only records the seat's loop kind on its older runs
      expect(store.runs("guido-1", 10)).toEqual(runs.map((r) => ({ ...r, loopKind: "build" })));
      expect(store.seatSession("guido-1")).toEqual(session);
      expect(store.queue("guido-1")).toEqual(queue);
      expect(store.threadComms("guido-1")).toEqual(messages);
      expect(
        crew(applied, store, 2000, undefined, () => null).rows.find((row) => row.id === "guido-1"),
      ).toMatchObject({ id: "guido-1", displayCallSign: "Orbit One" });
      busy.clear();
      await r.reload();
      expect(store.seatSession("guido-1")).toEqual(session);
      expect(store.queue("guido-1")).toEqual(queue);
      expect(store.threadComms("Orbit One")).toEqual([]);
    },
  );

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

  it.each(["live", "open", "parked", "aside", "unlocked"])(
    "preserves absent-seat attention while %s",
    async (state) => {
      const seatId = "absent";
      store.addQuestion({ agentId: seatId, runId: "r", text: "Continue?", at: 1000 });
      store.raiseNote({
        key: "absent",
        kind: "blocked",
        seatId,
        runId: null,
        repoId: "shop-app",
        text: "Waiting",
        at: 1000,
      });
      if (state === "live" || state === "aside") busy.add(seatId);
      if (state === "unlocked") holdsLock = false;
      if (["open", "parked", "aside"].includes(state)) {
        store.upsertRun({
          id: "r",
          agentId: seatId,
          repoId: "shop-app",
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
          ...(state === "aside"
            ? { loop: { ...NEW_LOOP, aside: { worktree: "/w/x", wake: false } } }
            : {}),
          ...(state === "parked"
            ? { loop: { ...NEW_LOOP, parked: { kind: "silent", reason: "waiting", ended: false } } }
            : {}),
        });
      }
      await make().reload();
      expect(store.openQuestions()).toHaveLength(1);
      expect(store.notes()).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "ends removed-seat aside runs (already absent at startup: %s)",
    async (restart) => {
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
      busy.add("guido-1");
      out = await r.reload();
      expect(out.pending).toEqual([
        { sessionId: "s1", seatId: "guido-1", change: "remove", reason: RETIRE_WAIT },
      ]);
      expect(seatsOf(applied)).toEqual(["guido-2", "guido-1"]);
      expect(applied.crew?.sessions[0]?.seats[1]?.retiring).toBe(true);
      store.addQuestion({ agentId: "guido-1", runId: aside.id, text: "Continue?", at: 1000 });
      store.raiseNote({
        key: "old",
        kind: "blocked",
        seatId: "guido-1",
        runId: null,
        repoId: "shop-app",
        text: "Waiting",
        at: 1000,
      });
      busy.clear();
      if (restart) {
        applied = config([{ id: "s1", seats: [seat("guido-2")] }]);
        const restarted = make();
        restarted.start();
        restarted.stop();
      } else {
        r.settle();
      }
      expect(seatsOf(applied)).toEqual(["guido-2"]);
      expect(store.openQuestions()).toEqual([]);
      expect(store.notes()).toEqual([]);
      expect(store.run(aside.id)).toMatchObject({ endedBy: "operator", status: "ok" });
      expect(store.asideRuns()).toEqual([]);
      expect(endedRemoval).toHaveBeenCalledExactlyOnceWith({
        kind: "run-ended",
        seatId: "guido-1",
        runId: aside.id,
        endedBy: "operator",
      });
      expect(store.threadComms("guido-1").some((c) => c.text.includes(aside.id))).toBe(true);
    },
  );

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

  it("roles, max_seats and max_open_runs_per_seat apply", async () => {
    const r = make();
    loaded = config([{ id: "s1", seats: [seat("guido-1")] }], { maxSeats: 3 });
    if (loaded.crew === undefined) throw new Error("no crew");
    loaded.crew.maxOpenRunsPerSeat = 4;
    await r.reload();
    expect(applied.crew?.maxSeats).toBe(3);
    expect(applied.crew?.maxOpenRunsPerSeat).toBe(4);
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
