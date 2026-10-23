import { describe, expect, it, vi } from "vitest";
import { GUARD_WINDOW_DAYS, guardAckKey } from "../src/guard.ts";
import {
  ATTENTION_KINDS,
  ATTENTION_LABEL,
  BACKGROUND_STALL_MS,
  CI_PILL,
  clockHm,
  crewHudState,
  DEFAULT_AWAY,
  driverStopKey,
  ENGINE_NOT_RUNNING,
  escalationKind,
  FLIGHT_NOT_RUNNING,
  FLOW_COLLECTOR_PREFIX,
  flowCollector,
  GUARD_NONE_TEXT,
  GUARD_NOTE,
  guardSummary,
  HUD_COLUMNS,
  HUD_STATE_LABEL,
  HUD_STATE_LAMP,
  HUD_STATE_RANK,
  HUD_STATE_TONE,
  HUD_STATES,
  hudColumnOf,
  hudState,
  LOCK_FREE_TEXT,
  LOCK_HEADER_TITLE,
  LOCK_NOBODY_WAITING,
  LOCK_OUTCOME_TEXT,
  lockHeaderText,
  lockHolderText,
  lockUsualText,
  lockWaitingLine,
  MACHINE_COLLECTOR,
  METER_FULL_PCT,
  METER_WARN_PCT,
  NOTABLE_STATES,
  PR_WAIT_MS,
  prPill,
  prSweepCollector,
  prYouAction,
  RETRY_NOTE,
  runPill,
  STALL_MS,
  STALL_TEXT,
  STATUS_OUT_OF_DATE,
  STREAM_TEXT_MAX,
  SUBAGENT_PILL,
  seatTurnText,
  stallStart,
  startOfLocalDay,
  stateChangeText,
  statusOutOfDate,
  TELEMETRY_RANGES,
  USAGE_COLLECTOR_PREFIX,
  usageCollector,
} from "../src/hud.ts";
import type { SeatState } from "../src/runtime.ts";
import type { AgentState, PullRequestView, SeatSessionRow } from "../src/types.ts";

const now = 1_000_000_000;

describe("constants", () => {
  it("holds the shared values", () => {
    expect(STALL_MS).toBe(600_000);
    expect(STREAM_TEXT_MAX).toBe(2000);
    expect(METER_WARN_PCT).toBe(80);
    expect(METER_FULL_PCT).toBe(100);
    expect(TELEMETRY_RANGES).toEqual({ "1h": 60, "6h": 360, "24h": 1440, "7d": 10080 });
    expect(FLIGHT_NOT_RUNNING).toBe("FLIGHT is not running yet. It arrives in phase 3.");
    expect(ENGINE_NOT_RUNNING).toBe("Arrives with the engine (phase 2).");
    expect(RETRY_NOTE).toBe(
      "Tries 1 and 2 resume the same agent; try 3 starts a fresh agent on a stronger model; after that the ticket parks for you. A retry that makes no progress (same failures, same diff) stops early.",
    );
    expect(DEFAULT_AWAY).toEqual({
      on: false,
      until: "",
      may: { pickUp: true, research: true, check: true, status: true, safePr: true },
    });
  });
  it("builds collector names", () => {
    expect(FLOW_COLLECTOR_PREFIX).toBe("flow:");
    expect(flowCollector("r1")).toBe("flow:r1");
    expect(prSweepCollector("r1")).toBe("github:r1:prs");
    expect(MACHINE_COLLECTOR).toBe("machine");
    expect(USAGE_COLLECTOR_PREFIX).toBe("usage:");
    expect(usageCollector("a1")).toBe("usage:a1");
  });
});

describe("hudState", () => {
  it("maps every state, paused and output age", () => {
    for (const paused of [false, true]) {
      for (const lastOutputAt of [null, now - 9 * 60_000 - 59_000, now - STALL_MS]) {
        const stale = lastOutputAt !== null && now - lastOutputAt >= STALL_MS;
        const h = (state: AgentState) =>
          hudState({ state, paused, stopped: false, lastOutputAt, now, backgroundInFlight: false });
        expect(h("error")).toBe("error");
        expect(h("working")).toBe(stale ? "stalled" : "running");
        expect(h("waiting-you")).toBe("blocked");
        expect(h("waiting-agent")).toBe("waiting");
        expect(h("idle")).toBe(paused ? "parked" : "idle");
      }
    }
  });
  // Ruling R21: a run waiting on its own background shell writes nothing for a long time.
  it("allows a working run with a background task in flight BACKGROUND_STALL_MS of quiet", () => {
    expect(BACKGROUND_STALL_MS).toBe(60 * 60_000);
    const h = (quietMs: number, backgroundInFlight: boolean) =>
      hudState({
        state: "working",
        paused: false,
        stopped: false,
        lastOutputAt: now - quietMs,
        now,
        backgroundInFlight,
      });
    expect(h(35 * 60_000, true)).toBe("running");
    expect(h(BACKGROUND_STALL_MS - 1, true)).toBe("running");
    expect(h(BACKGROUND_STALL_MS, true)).toBe("stalled");
    expect(h(61 * 60_000, true)).toBe("stalled");
    expect(h(35 * 60_000, false)).toBe("stalled");
    // Only a working run: the other states ignore it.
    expect(
      hudState({
        state: "idle",
        paused: false,
        stopped: false,
        lastOutputAt: null,
        now,
        backgroundInFlight: true,
      }),
    ).toBe("idle");
  });
  it("idle and stopped by its driver is stopped; paused wins; other states ignore it", () => {
    const h = (state: AgentState, paused: boolean) =>
      hudState({
        state,
        paused,
        stopped: true,
        lastOutputAt: null,
        now,
        backgroundInFlight: false,
      });
    expect(h("idle", false)).toBe("stopped");
    expect(h("idle", true)).toBe("parked");
    expect(h("waiting-you", false)).toBe("blocked");
    expect(h("error", false)).toBe("error");
    expect(driverStopKey("studio-builder")).toBe("driver-stop:studio-builder");
  });
  it("has labels and ranks for every state", () => {
    expect(HUD_STATES.map((s) => HUD_STATE_LABEL[s])).toEqual([
      "Running",
      "Stalled",
      "Blocked",
      "Parked",
      "Waiting",
      "Idle",
      "Stopped",
      "Error",
    ]);
    expect(HUD_STATE_RANK).toEqual({
      error: 0,
      stalled: 0,
      blocked: 1,
      parked: 1,
      waiting: 2,
      running: 3,
      idle: 4,
      stopped: 5,
    });
  });
});

describe("hudColumnOf", () => {
  it("lets a Status name win, else falls back on state", () => {
    expect(HUD_COLUMNS).toHaveLength(8);
    expect(hudColumnOf({ status: "Todo", state: "planned", closed: false })).toBe("Ready");
    expect(hudColumnOf({ status: "Backlog", state: "planned", closed: false })).toBe("Backlog");
    expect(hudColumnOf({ status: " ready for qa ", state: "review", closed: false })).toBe(
      "Ready for QA",
    );
    expect(hudColumnOf({ status: "Blocking", state: "blocked", closed: false })).toBe("Blocked");
    expect(hudColumnOf({ status: "in review", state: "review", closed: false })).toBe("In review");
    expect(hudColumnOf({ status: "Weird", state: "done", closed: false })).toBe("Done");
    expect(hudColumnOf({ status: "Weird", state: "in progress", closed: false })).toBe(
      "In progress",
    );
  });
});

describe("closed issues and empty Status", () => {
  const open = (status: string, state: "planned" | "in progress" | "done" = "planned") => ({
    status,
    state,
    closed: false,
  });
  it("puts a closed issue in Done whatever its Status says", () => {
    expect(hudColumnOf({ status: "In progress", state: "in progress", closed: true })).toBe("Done");
    expect(hudColumnOf({ status: "", state: "planned", closed: true })).toBe("Done");
  });
  it("puts an open issue with no Status in Backlog, and an open one in Done in Done", () => {
    expect(hudColumnOf(open(""))).toBe("Backlog");
    expect(hudColumnOf(open("Done", "done"))).toBe("Done");
    expect(hudColumnOf(open("In progress", "in progress"))).toBe("In progress");
  });
  it("flags GitHub and the Status disagreeing, and only then", () => {
    expect(statusOutOfDate({ status: "In progress", state: "in progress", closed: true })).toBe(
      true,
    );
    expect(statusOutOfDate({ status: "Done", state: "done", closed: true })).toBe(false);
    expect(statusOutOfDate(open("In progress", "in progress"))).toBe(false);
    expect(statusOutOfDate(open("Done", "done"))).toBe(true);
    expect(statusOutOfDate(open(""))).toBe(false);
    expect(STATUS_OUT_OF_DATE).toBe("Status out of date");
  });
});

describe("attention", () => {
  it("orders kinds and labels them per the catalogue", () => {
    expect([...ATTENTION_KINDS]).toEqual([
      "lock",
      "stalled",
      "error",
      "person",
      "decision",
      "approval",
      "question",
      "blocked",
      "review",
      "ready",
      "flag",
      "ratelimit",
      "tag",
      "parked",
      "pr",
      "message",
      "stray",
    ]);
    expect(ATTENTION_LABEL).toEqual({
      person: "Asked of you",
      decision: "Decision",
      approval: "Approval",
      question: "Question",
      message: "Message",
      tag: "Tagged you",
      stalled: "Stalled",
      parked: "Parked",
      error: "Error",
      pr: "PR",
      stray: "Stray file",
      lock: "Test lock",
      blocked: "Blocked",
      review: "Ready for review",
      ready: "Ready to merge",
      flag: "Check before merging",
      ratelimit: "Rate-limited",
    });
  });
  it("classifies escalations", () => {
    expect(escalationKind({ kind: "operator-decision", source: "title" })).toBe("decision");
    expect(escalationKind({ kind: "mvp-ready", source: "title" })).toBe("approval");
    expect(escalationKind({ kind: "loop-blocked", source: "title" })).toBe("parked");
    expect(escalationKind({ kind: "autonomy-question", source: "title" })).toBe("decision");
    expect(escalationKind({ kind: "operator-decision", source: "label" })).toBe("question");
    expect(escalationKind({ kind: "autonomy-question", source: "label" })).toBe("decision");
  });
});

describe("startOfLocalDay", () => {
  const tz = "Europe/London";
  it("handles summer and winter days", () => {
    expect(startOfLocalDay(Date.parse("2026-07-10T15:30:00Z"), tz)).toBe(
      Date.parse("2026-07-09T23:00:00Z"),
    );
    expect(startOfLocalDay(Date.parse("2026-01-10T15:30:00Z"), tz)).toBe(
      Date.parse("2026-01-10T00:00:00Z"),
    );
  });
  it("on a day with no local midnight, starts at the day's first instant", () => {
    expect(startOfLocalDay(Date.parse("2018-11-04T15:00:00Z"), "America/Sao_Paulo")).toBe(
      Date.parse("2018-11-04T03:00:00Z"),
    );
  });
  it("uses a 24h denominator at 23:00 on the 25-hour day", () => {
    const at = Date.parse("2026-10-25T23:00:00Z");
    expect(startOfLocalDay(at, tz)).toBe(Date.parse("2026-10-24T23:00:00Z"));
    expect(at - startOfLocalDay(at, tz)).toBe(24 * 3_600_000);
  });
  it("gives the same midnight across the repeated hour", () => {
    const m = Date.parse("2026-10-24T23:00:00Z");
    expect(startOfLocalDay(Date.parse("2026-10-25T00:30:00Z"), tz)).toBe(m);
    expect(startOfLocalDay(Date.parse("2026-10-25T01:30:00Z"), tz)).toBe(m);
  });
  it("handles the 23-hour day and the next midnight", () => {
    expect(startOfLocalDay(Date.parse("2026-03-29T12:00:00Z"), tz)).toBe(
      Date.parse("2026-03-29T00:00:00Z"),
    );
    expect(startOfLocalDay(Date.parse("2026-03-30T00:30:00Z"), tz)).toBe(
      Date.parse("2026-03-29T23:00:00Z"),
    );
  });
  // #26 A1: building a formatter per call cost ~90 % of a Board render.
  it("builds at most one date formatter per time zone, however often it is called", () => {
    const Real = Intl.DateTimeFormat;
    const spy = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation((...args: ConstructorParameters<typeof Real>) => new Real(...args));
    try {
      const zone = "Pacific/Chatham"; // no other test uses it, so nothing is cached yet
      const first = startOfLocalDay(Date.parse("2026-07-10T15:30:00Z"), zone);
      for (let i = 0; i < 500; i++) {
        expect(startOfLocalDay(Date.parse("2026-07-10T15:30:00Z") + i * 60_000, zone)).toBe(first);
      }
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
      // Chatham is UTC+12:45 in July: local midnight of 11 Jul is 10 Jul 11:15Z.
      expect(first).toBe(Date.parse("2026-07-10T11:15:00Z"));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("state tones and lamps", () => {
  it("gives every state a pill tone (mockup L112–114)", () => {
    expect(HUD_STATE_TONE).toEqual({
      running: "ok",
      stalled: "warn",
      blocked: "warn",
      parked: "warn",
      waiting: "warn",
      error: "crit",
      idle: "neutral",
      stopped: "neutral",
    });
  });

  it("pulses only where an agent is worked or waits on you", () => {
    expect(HUD_STATE_LAMP).toEqual({
      running: { kind: "ok", pulse: true },
      stalled: { kind: "warn", pulse: true },
      blocked: { kind: "warn", pulse: true },
      waiting: { kind: "warn", pulse: false },
      parked: { kind: "warn", pulse: false },
      error: { kind: "crit", pulse: false },
      idle: { kind: "off", pulse: false },
      stopped: { kind: "off", pulse: false },
    });
  });
});

describe("pills", () => {
  it("names CI and subagent states with their tones", () => {
    expect(CI_PILL).toEqual({
      passing: { label: "CI passing", tone: "ok" },
      failing: { label: "CI failing", tone: "crit" },
      pending: { label: "CI pending", tone: "neutral" },
    });
    expect(SUBAGENT_PILL).toEqual({
      running: { label: "Running", tone: "ok" },
      completed: { label: "Done", tone: "neutral" },
      failed: { label: "Failed", tone: "crit" },
      stopped: { label: "Stopped", tone: "neutral" },
    });
  });

  it.each([
    [{ state: "merged", review: "approved" }, "Merged", "ok"],
    [{ state: "merged", isDraft: true }, "Merged", "ok"],
    [{ state: "closed", review: "changes" }, "Closed", "plain"],
    [{ state: "open", isDraft: true, review: "requested" }, "Draft", "plain"],
    [{ state: "open", isDraft: true, review: "changes" }, "Draft", "plain"],
    [{ state: "open", review: "changes" }, "Changes asked", "crit"],
    [{ state: "open", review: "approved" }, "Approved", "ok"],
    [{ state: "open", review: "requested" }, "Review asked", "plain"],
    [{ state: "open", review: null }, "Open", "plain"],
    [{ state: "open" }, "Open", "plain"],
  ] as const)("prPill(%o) → %s", (pr, label, tone) => {
    expect(prPill(pr)).toEqual({ label, tone });
  });

  const row = (hudState: "running" | "stalled" | "error", status = "running" as const) => ({
    hudState,
    run: { id: "r-2", status } as never,
  });

  it("runPill: the latest running run of a stalled or broken agent says so", () => {
    expect(runPill({ id: "r-2", status: "running" }, row("stalled"))).toEqual({
      label: "Stalled",
      tone: "warn",
    });
    expect(runPill({ id: "r-2", status: "running" }, row("error"))).toEqual({
      label: "Error",
      tone: "crit",
    });
    expect(runPill({ id: "r-2", status: "running" }, row("running"))).toEqual({
      label: "Running",
      tone: "ok",
    });
  });

  it("runPill: a finished latest run and older runs go by their own status", () => {
    // an errored agent whose latest run ended ok: the run finished, the source broke later
    expect(
      runPill({ id: "r-2", status: "ok" }, { hudState: "error", run: { id: "r-2" } as never }),
    ).toEqual({
      label: "Finished",
      tone: "neutral",
    });
    // an older run still marked running (the latest is r-2) is not the stalled one
    expect(runPill({ id: "r-1", status: "running" }, row("stalled"))).toEqual({
      label: "Running",
      tone: "ok",
    });
    expect(runPill({ id: "r-1", status: "failed" }, row("stalled"))).toEqual({
      label: "Failed",
      tone: "crit",
    });
    expect(runPill({ id: "r-1", status: "blocked" }, row("running"))).toEqual({
      label: "Blocked",
      tone: "warn",
    });
    expect(runPill({ id: "r-1", status: "unknown" }, { hudState: "idle", run: null })).toEqual({
      label: "Unknown",
      tone: "neutral",
    });
  });
});

describe("stateChangeText", () => {
  const none = { stop: null, sourceError: null };
  it("names the states and adds the cause for stalled, error and stopped", () => {
    expect(stateChangeText("running", "stalled", none)).toBe(
      "Running → Stalled: no output for 10 min",
    );
    expect(stateChangeText("stalled", "running", none)).toBe("Stalled → Running");
    expect(stateChangeText("running", "error", { ...none, sourceError: "no such file" })).toBe(
      "Running → Error: no such file",
    );
    const stop = { reason: "quota", at: 1, quota: null, resumesAt: null };
    expect(stateChangeText("idle", "stopped", { ...none, stop })).toBe("Idle → Stopped: quota");
    expect(stateChangeText("idle", "parked", none)).toBe("Idle → Parked");
  });
  it("lists the notable states", () => {
    expect(NOTABLE_STATES).toEqual(["stalled", "error", "blocked", "stopped", "parked"]);
  });
});

describe("seatTurnText", () => {
  it("words a seat's turn start and end, and nothing else", () => {
    expect(seatTurnText("idle", "running")).toBe("Idle → Running (your message)");
    expect(seatTurnText("running", "idle")).toBe("Running → Idle (turn ended)");
    expect(seatTurnText("running", "stalled")).toBeNull();
    expect(seatTurnText("idle", "idle")).toBeNull();
  });
});

describe("prYouAction", () => {
  const NOW = 1_000_000_000_000;
  const pr = (over: Partial<PullRequestView> = {}): PullRequestView => ({
    repoId: "shop-app",
    number: 1,
    title: "t",
    url: "u",
    branch: "fix/1-x",
    ticket: "shop-app#1",
    state: "open",
    isDraft: false,
    review: null,
    ci: null,
    createdAt: NOW - 9 * PR_WAIT_MS,
    updatedAt: NOW - PR_WAIT_MS,
    mergedAt: null,
    headSha: null,
    mergeable: null,
    ...over,
  });
  it("waits an hour", () => expect(PR_WAIT_MS).toBe(3_600_000));
  it.each([
    [{ isDraft: true }, "decide on the draft"],
    [{ review: "approved" }, "merge"],
    [{ isDraft: true, review: "approved" }, "decide on the draft"],
    [{}, "review"],
    [{ review: "changes" }, "review"],
  ] as const)("%o -> %s", (over, action) => {
    expect(prYouAction(pr(over), false, NOW)).toBe(action);
  });
  it("null when too recent, agent running, or not open", () => {
    expect(prYouAction(pr({ updatedAt: NOW - PR_WAIT_MS + 1 }), false, NOW)).toBeNull();
    expect(prYouAction(pr(), true, NOW)).toBeNull();
    expect(prYouAction(pr({ state: "closed" }), false, NOW)).toBeNull();
    expect(prYouAction(pr({ state: "merged" }), false, NOW)).toBeNull();
  });
});

describe("clockHm", () => {
  it("gives HH:MM on a 24-hour clock in the time zone", () => {
    const at = Date.parse("2026-07-10T15:05:00Z");
    expect(clockHm(at, "Europe/London")).toBe("16:05");
    expect(clockHm(at, "UTC")).toBe("15:05");
    expect(clockHm(Date.parse("2026-01-10T00:07:00Z"), "Europe/London")).toBe("00:07");
  });
});

describe("stallStart", () => {
  it("is the last output plus the stall threshold the rule used", () => {
    expect(stallStart(1000, false)).toBe(1000 + STALL_MS);
    expect(stallStart(1000, true)).toBe(1000 + BACKGROUND_STALL_MS);
  });

  it("is the moment hudState turns stalled", () => {
    const at = (now: number, backgroundInFlight: boolean) =>
      hudState({
        state: "working",
        paused: false,
        stopped: false,
        lastOutputAt: 1000,
        now,
        backgroundInFlight,
      });
    for (const bg of [false, true]) {
      const t = stallStart(1000, bg);
      expect(at(t - 1, bg)).toBe("running");
      expect(at(t, bg)).toBe("stalled");
    }
  });

  it("names the stall in the Needs-you item", () => {
    expect(STALL_TEXT).toBe("No output");
  });
});

describe("crewHudState", () => {
  const now = 100 * STALL_MS;
  const seat = (
    state: SeatState,
    runId: string | null = "r1",
    updatedAt = now - 1000,
  ): SeatSessionRow => ({
    seatId: "GUIDO-1",
    runId,
    cliSessionId: null,
    state,
    reason: null,
    worktree: null,
    updatedAt,
  });

  it("no row is idle", () => {
    expect(crewHudState(null, null, now)).toBe("idle");
  });
  it("starting and running are running, stalled after STALL_MS without output", () => {
    expect(crewHudState(seat("starting"), null, now)).toBe("running");
    expect(crewHudState(seat("running"), now - STALL_MS + 1, now)).toBe("running");
    expect(crewHudState(seat("running"), now - STALL_MS, now)).toBe("stalled");
    expect(crewHudState(seat("starting"), now - STALL_MS, now)).toBe("stalled");
  });
  it("with no output yet, a seat stalls STALL_MS after its row last changed", () => {
    expect(crewHudState(seat("running", "r1", now - STALL_MS + 1), null, now)).toBe("running");
    expect(crewHudState(seat("running", "r1", now - STALL_MS), null, now)).toBe("stalled");
    expect(crewHudState(seat("starting", "r1", now - STALL_MS), null, now)).toBe("stalled");
  });
  it("maps idle, parked, stopped and error", () => {
    expect(crewHudState(seat("idle"), null, now)).toBe("idle");
    expect(crewHudState(seat("parked"), null, now)).toBe("parked");
    expect(crewHudState(seat("stopped", null), null, now)).toBe("stopped");
    expect(crewHudState(seat("error"), null, now)).toBe("error");
  });
});

describe("guard and test lock copy", () => {
  it("pins the exact text", () => {
    expect(GUARD_NONE_TEXT).toBe("Guard: nothing blocked this week.");
    expect(GUARD_NOTE).toBe(
      "The guard catches agent mistakes and ordinary spellings, not deliberate evasion.",
    );
    expect(guardSummary(1, 0)).toBe("Guard: 1 blocked command (for information)");
    expect(guardSummary(3, 2)).toBe("Guard: 3 blocked commands, 2 new (for information)");
    expect(LOCK_FREE_TEXT).toBe("No full-suite run in progress.");
    expect(LOCK_NOBODY_WAITING).toBe("Nobody waiting.");
    expect(lockHolderText("GUIDO-2", "pnpm test", "1:23")).toBe(
      "GUIDO-2 holds it: pnpm test · 1:23",
    );
    expect(lockWaitingLine("GUIDO-3", "0:12")).toBe("GUIDO-3 waiting · 0:12");
    expect(lockHeaderText(null, 0)).toBe("Lock: free");
    expect(lockHeaderText("GUIDO-2", 1)).toBe("Lock: GUIDO-2 +1");
    expect(LOCK_HEADER_TITLE).toBe("Full-suite test lock");
    expect(GUARD_WINDOW_DAYS).toBe(7);
    expect(guardAckKey(12)).toBe("guard:12");
  });
});

it("describes the usual lock time and how a hold ended", () => {
  expect(lockUsualText(9, false)).toBe("usually about 9 min");
  expect(lockUsualText(9, true)).toBe("usually about 9 min · over its usual time");
  expect(LOCK_OUTCOME_TEXT).toEqual({ done: "finished", freed: "freed with its run" });
});
