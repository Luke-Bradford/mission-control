import type { AttentionItem, CrewLoop, CrewRow, DriverStop, HudState } from "@mc/core";
import { DEFAULT_PROFILES, profileStep } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  contextPct,
  crewOrder,
  doingLine,
  hasActiveRun,
  isFinishedWork,
  isLoopInFlight,
  LOOP_PATH_TITLE,
  lockSince,
  loopLine,
  loopMarks,
  loopStepLabel,
  loopSteps,
  loopTemplate,
  loopTryText,
  modelLine,
  needLine,
  needsLamp,
  SEAT_STATUS_LABEL,
  seatAreaText,
  seatItems,
  seatStatus,
  sparkValues,
  stepMarks,
  stopLine,
  tokensPerMinute,
  WAIT_TEXT,
  waitText,
} from "../src/crew.ts";
import {
  crewRow,
  item as fixtureItem,
  HOUR,
  item,
  MIN,
  NOW,
  seatRow,
  stoppedSeat,
} from "./fixtures.ts";

const ids = (rows: CrewRow[]) => rows.map((r) => r.id);

const ENDED_LOOP = { phase: "review" as const, text: "", prNumber: null, parked: null };

describe("crewOrder", () => {
  it("puts agents with an attention item first, then by state rank, then config order", () => {
    const rows = [
      crewRow({ id: "a", index: 0, hudState: "idle" }),
      crewRow({ id: "b", index: 1, hudState: "running" }),
      crewRow({ id: "c", index: 2, hudState: "error" }),
      crewRow({ id: "d", index: 3, hudState: "running" }),
      crewRow({ id: "e", index: 4, hudState: "stopped" }),
      crewRow({ id: "f", index: 5, hudState: "stalled" }),
    ];
    const items: AttentionItem[] = [item({ key: "esc:x", agentId: "d", ticket: null })];
    expect(ids(crewOrder(rows, items))).toEqual(["d", "b", "c", "f", "a", "e"]);
  });

  it("does not reorder or mutate its input", () => {
    const rows = [crewRow({ id: "b", index: 1 }), crewRow({ id: "a", index: 0 })];
    expect(ids(crewOrder(rows, []))).toEqual(["a", "b"]);
    expect(ids(rows)).toEqual(["b", "a"]);
  });

  it("does not put a seat first for a set-aside run's item", () => {
    const rows = [
      crewRow({ id: "a", index: 0, hudState: "running", ticket: "shop-app#3349" }),
      crewRow({ id: "b", index: 1, hudState: "running", ticket: "shop-app#3349" }),
    ];
    const old = {
      ...item({ key: "ready:old", agentId: "b", ticket: "shop-app#3000", escalationId: null }),
      kind: "ready",
    } as unknown as AttentionItem;
    expect(ids(crewOrder(rows, [old]))).toEqual(["a", "b"]);
    expect(ids(crewOrder(rows, [{ ...old, ticket: "shop-app#3349" }]))).toEqual(["b", "a"]);
  });

  it("ignores items with no agent", () => {
    const rows = [
      crewRow({ id: "a", index: 0, hudState: "idle" }),
      crewRow({ id: "b", index: 1, hudState: "running" }),
    ];
    expect(ids(crewOrder(rows, [item({ agentId: null })]))).toEqual(["b", "a"]);
  });
});

describe("needsLamp", () => {
  it("is null for nothing", () => {
    expect(needsLamp([], true)).toBeNull();
  });

  it("is red with an error item, amber otherwise, and passes the pulse through", () => {
    expect(needsLamp([item({ kind: "decision" }), item({ kind: "error" })], true)).toEqual({
      kind: "crit",
      pulse: true,
      label: "Error, Decision",
    });
    expect(needsLamp([item({ kind: "stalled" })], false)).toEqual({
      kind: "warn",
      pulse: false,
      label: "Stalled",
    });
  });

  it("lists each kind once, in ATTENTION_KINDS order", () => {
    const lamp = needsLamp(
      [
        item({ kind: "question" }),
        item({ kind: "decision" }),
        item({ kind: "question" }),
        item({ kind: "stalled" }),
      ],
      false,
    );
    expect(lamp?.label).toBe("Stalled, Decision, Question");
  });
});

const digest = (
  over: Partial<NonNullable<CrewRow["digest"]>> = {},
): NonNullable<CrewRow["digest"]> => ({
  toolCalls: 0,
  turns: 0,
  lastEventAt: NOW,
  model: null,
  contextTokens: null,
  contextWindow: null,
  liveTool: null,
  tools: {},
  subagents: [],
  minuteTokens: [],
  turnUsage: [],
  background: [],
  compactions: 0,
  ...over,
});
const TZ = "Europe/London";

describe("stopLine", () => {
  // 2026-10-19 10:00 in London (BST ended 2026-10-25; this is still BST, UTC+1).
  const now = Date.UTC(2026, 9, 19, 9, 0);
  const resets = Date.UTC(2026, 9, 21, 2, 0);
  const quota = (over: Partial<DriverStop> = {}): DriverStop => ({
    reason: "7-day quota utilization 88% >= QUOTA_STOP_PCT=80% -- refusing to fire",
    at: now - HOUR,
    quota: { usedPct: 88, stopPct: 80 },
    resumesAt: resets,
    ...over,
  });

  it("a quota stop says the usage and when the window resets (operator time)", () => {
    expect(stopLine(quota(), now, TZ)).toBe(
      "Stopped at the 7-day quota (88% of 80%) · resumes after Wed 03:00",
    );
  });

  it("a reset already past resumes at its next start; no reset has no resume clause", () => {
    expect(stopLine(quota({ resumesAt: now - MIN }), now, TZ)).toBe(
      "Stopped at the 7-day quota (88% of 80%) · resumes at its next start",
    );
    expect(stopLine(quota({ resumesAt: null }), now, TZ)).toBe(
      "Stopped at the 7-day quota (88% of 80%)",
    );
  });

  it("a quota stop with an unread percentage leaves the figures out", () => {
    expect(
      stopLine(quota({ quota: { usedPct: null, stopPct: 80 }, resumesAt: null }), now, TZ),
    ).toBe("Stopped at the 7-day quota");
  });

  it("any other reason is shown whole", () => {
    expect(
      stopLine(quota({ reason: "MAX_FIRES=6 reached", quota: null, resumesAt: null }), now, TZ),
    ).toBe("Stopped by its driver: MAX_FIRES=6 reached");
  });

  it("doingLine shows the loop's step only for an idle seat with no note", () => {
    const loop = { phase: "ci" as const, text: "CI on abc1234", prNumber: null, parked: null };
    const seat = stoppedSeat({ hudState: "idle", note: null, loop, run: crewRow().run });
    expect(doingLine(seat, now, TZ)).toBe("CI on abc1234");
    expect(loopLine(seat)).toBe("CI on abc1234");
    expect(doingLine({ ...seat, note: "Rate limited" }, now, TZ)).toBe("Rate limited");
    expect(loopLine({ ...seat, note: "Rate limited" })).toBeNull();
    for (const hudState of ["blocked", "parked", "stalled", "error"] as const) {
      const row = { ...seat, hudState, note: "its own reason", sourceError: "boom" };
      expect(doingLine(row, now, TZ)).not.toContain("CI on");
      expect(loopLine(row)).toBeNull();
    }
    expect(
      doingLine({ ...seat, hudState: "blocked", note: "Waiting on the operator" }, now, TZ),
    ).toBe("Waiting on the operator");
    expect(doingLine({ ...seat, hudState: "parked", note: "Rate limited" }, now, TZ)).toBe(
      "Rate limited",
    );
    expect(doingLine({ ...seat, loop: null }, now, TZ)).not.toContain("CI on");
  });

  it("isLoopInFlight needs an unfinished loop on a run that has not ended", () => {
    const parked = { ...ENDED_LOOP, phase: "parked" as const, parked: "CI failed" };
    const ended = stoppedSeat({ loop: parked });
    expect(isLoopInFlight(ended)).toBe(false);
    const open = {
      ...ended,
      run: { ...(ended.run as NonNullable<CrewRow["run"]>), endedAt: null },
    };
    expect(isLoopInFlight(open)).toBe(true);
    expect(isLoopInFlight({ ...open, loop: { ...parked, phase: "done" } })).toBe(false);
    expect(isLoopInFlight({ ...open, loop: null })).toBe(false);
  });

  it("doingLine for a running looped seat shows the tool in hand, not the loop text", () => {
    const loop = { phase: "ci" as const, text: "CI on abc1234", prNumber: null, parked: null };
    const running = stoppedSeat({ hudState: "running", loop });
    expect(doingLine(running, now, TZ)).not.toContain("CI on");
    expect(doingLine(running, now, TZ)).toMatch(/^run #/);
    const live = { name: "Bash", detail: null, since: now - 65_000 };
    const withTool = { ...running, digest: { ...(running.digest as object), liveTool: live } };
    expect(doingLine(withTool as CrewRow, now, TZ)).toBe("run #12 · Bash 1:05");
  });

  it("doingLine ignores a done loop on an idle seat", () => {
    const done = { phase: "done" as const, text: "Done · PR #9", prNumber: 9, parked: null };
    expect(
      doingLine(stoppedSeat({ hudState: "idle", note: null, loop: done }), now, TZ),
    ).not.toContain("Done");
  });

  it("doingLine ignores a done loop: a stopped seat still says why its run ended", () => {
    const done = { phase: "done" as const, text: "Done", prNumber: 9, parked: null };
    expect(doingLine(stoppedSeat({ loop: done }), now, TZ)).toBe("Run ended by you");
  });

  it("doingLine for a stopped seat says why the run ended, not its ticket", () => {
    expect(doingLine(stoppedSeat({ merged: true }), now, TZ)).toBe("Run ended · PR #75 merged");
    expect(doingLine(stoppedSeat(), now, TZ)).toBe("Run ended by you");
    const ended = stoppedSeat().run as NonNullable<CrewRow["run"]>;
    const failed = stoppedSeat({ run: { ...ended, status: "failed" } });
    expect(doingLine({ ...failed, note: "CLI never started" }, now, TZ)).toBe(
      "Run failed: CLI never started",
    );
    expect(doingLine(failed, now, TZ)).toBe("Run failed");
    const unknown = stoppedSeat({ run: { ...ended, status: "unknown" } });
    expect(doingLine(unknown, now, TZ)).toBe("Run ended");
  });

  it("doingLine for a stopped seat names only a merged PR, not an open or closed one", () => {
    const pr = stoppedSeat({ merged: true }).prs[0] as CrewRow["prs"][number];
    for (const state of ["open", "closed", null] as const) {
      expect(doingLine(stoppedSeat({ prs: [{ ...pr, state }] }), now, TZ)).toBe("Run ended by you");
    }
    const open = { ...pr, number: 76, state: "open" as const };
    expect(doingLine(stoppedSeat({ prs: [open, pr] }), now, TZ)).toBe("Run ended · PR #75 merged");
  });

  it("doingLine for a stopped seat whose run failed says failed, even with a merged PR", () => {
    const merged = stoppedSeat({ merged: true });
    const run = { ...(merged.run as NonNullable<CrewRow["run"]>), status: "failed" as const };
    expect(doingLine({ ...merged, run, note: "boom" }, now, TZ)).toBe("Run failed: boom");
  });

  it("doingLine for a stopped seat that never ran falls back to its note, else Stopped", () => {
    expect(doingLine(stoppedSeat({ run: null, note: "n" }), now, TZ)).toBe("n");
    expect(doingLine(stoppedSeat({ run: null }), now, TZ)).toBe("Stopped");
  });

  it("isFinishedWork is true only for a stopped crew seat", () => {
    expect(isFinishedWork(stoppedSeat())).toBe(true);
    expect(isFinishedWork(stoppedSeat({ kind: "loop" }))).toBe(false);
    expect(isFinishedWork(stoppedSeat({ hudState: "idle" }))).toBe(false);
  });

  it("doingLine for a stopped row is the stop line, else its note, else Stopped", () => {
    const stop = quota();
    expect(doingLine(crewRow({ hudState: "stopped", stop }), now, TZ)).toBe(
      stopLine(stop, now, TZ),
    );
    expect(doingLine(crewRow({ hudState: "stopped", note: "stopped: x" }), now, TZ)).toBe(
      "stopped: x",
    );
    expect(doingLine(crewRow({ hudState: "stopped" }), now, TZ)).toBe("Stopped");
  });
});

describe("doingLine", () => {
  it("running: run number, with the live tool and its age", () => {
    expect(doingLine(crewRow(), NOW, TZ)).toBe("run #12");
    const live = crewRow({ digest: digest({ liveTool: { name: "Bash", since: NOW - 125_000 } }) });
    expect(doingLine(live, NOW, TZ)).toBe("run #12 \u00b7 Bash 2:05");
  });

  // Ruling R21: waiting on its own background shell, with no live tool, names the task.
  it("running: the newest background task when no tool is live", () => {
    const background = [
      { taskId: "b1", description: "pnpm build", type: "local_bash" },
      { taskId: "b2", description: "Run the full suite", type: "local_bash" },
    ];
    expect(doingLine(crewRow({ digest: digest({ background }) }), NOW, TZ)).toBe(
      "run #12 \u00b7 background: Run the full suite",
    );
    const live = digest({ background, liveTool: { name: "Bash", since: NOW - 125_000 } });
    expect(doingLine(crewRow({ digest: live }), NOW, TZ)).toBe("run #12 \u00b7 Bash 2:05");
  });

  it("stalled with no output: counts from when the seat went quiet, not from the stall", () => {
    // The server puts a silent seat's stateSince at the stall's start, STALL_MS after it went quiet.
    const row = crewRow({ hudState: "stalled", lastOutputAt: null, stateSince: NOW - MIN });
    expect(doingLine(row, NOW, TZ)).toBe("run #12 \u00b7 no output for 11:00");
  });

  it("stalled: how long since the last output", () => {
    const row = crewRow({ hudState: "stalled", lastOutputAt: NOW - 11 * MIN });
    expect(doingLine(row, NOW, TZ)).toBe("run #12 \u00b7 no output for 11:00");
  });

  it("error, parked, blocked, waiting", () => {
    expect(doingLine(crewRow({ hudState: "error", sourceError: "state dir gone" }), NOW, TZ)).toBe(
      "Error: state dir gone",
    );
    expect(doingLine(crewRow({ hudState: "parked" }), NOW, TZ)).toBe("Paused by you");
    expect(
      doingLine(crewRow({ hudState: "parked", kind: "crew", note: "rate limited" }), NOW, TZ),
    ).toBe("rate limited");
    expect(doingLine(crewRow({ hudState: "blocked" }), NOW, TZ)).toBe("Waiting on you");
    expect(doingLine(crewRow({ hudState: "blocked", note: "needs a call" }), NOW, TZ)).toBe(
      "needs a call",
    );
    expect(doingLine(crewRow({ hudState: "waiting" }), NOW, TZ)).toBe("Waiting");
  });

  it("idle: the note, else idle since the state began (operator time)", () => {
    const since = Date.UTC(2026, 9, 17, 9, 5); // 10:05 BST
    expect(doingLine(crewRow({ hudState: "idle", stateSince: since }), NOW, TZ)).toBe(
      "Idle since 10:05",
    );
    expect(doingLine(crewRow({ hudState: "idle", note: "between runs" }), NOW, TZ)).toBe(
      "between runs",
    );
  });
});

describe("doingLine before the timezone loads", () => {
  it("says everything that needs no clock time, straight away", () => {
    expect(doingLine(crewRow(), NOW, null)).toBe("run #12");
    expect(doingLine(crewRow({ hudState: "waiting" }), NOW, null)).toBe("Waiting");
    expect(doingLine(crewRow({ hudState: "idle", note: "between runs" }), NOW, null)).toBe(
      "between runs",
    );
  });

  it("leaves out only the clock time, which arrives with the zone", () => {
    const since = Date.UTC(2026, 9, 17, 9, 5);
    const idle = crewRow({ hudState: "idle", stateSince: since });
    expect(doingLine(idle, NOW, null)).toBe("Idle");
    expect(doingLine(idle, NOW, TZ)).toBe("Idle since 10:05");
    const stop: DriverStop = {
      reason: "quota",
      at: NOW,
      quota: { usedPct: 88, stopPct: 80 },
      resumesAt: NOW + HOUR,
    };
    const stopped = crewRow({ hudState: "stopped", stop });
    expect(doingLine(stopped, NOW, null)).toBe("Stopped at the 7-day quota (88% of 80%)");
    expect(doingLine(stopped, NOW, TZ)).toContain("resumes after");
  });

  it("a stop whose resume time has passed still says it resumes at its next start", () => {
    const stop: DriverStop = {
      reason: "quota",
      at: NOW - 2 * HOUR,
      quota: { usedPct: 88, stopPct: 80 },
      resumesAt: NOW - HOUR,
    };
    const stopped = crewRow({ hudState: "stopped", stop });
    const line = "Stopped at the 7-day quota (88% of 80%) · resumes at its next start";
    expect(doingLine(stopped, NOW, null)).toBe(line);
    expect(doingLine(stopped, NOW, TZ)).toBe(line);
  });
});

describe("contextPct", () => {
  it("is the context tokens over the window, null when either is missing", () => {
    const d = digest({ contextTokens: 483_137 });
    expect(contextPct(crewRow({ digest: d, contextWindow: 1_000_000 }))).toBeCloseTo(48.3137);
    expect(contextPct(crewRow({ digest: d, contextWindow: null }))).toBeNull();
    expect(contextPct(crewRow({ digest: null, contextWindow: 1_000_000 }))).toBeNull();
    expect(contextPct(crewRow({ digest: digest(), contextWindow: 1_000_000 }))).toBeNull();
  });
});

describe("needLine", () => {
  const row = crewRow({ id: "a" });
  // Items here are about the row's current run unless a test says otherwise.
  const item = (over: Partial<AttentionItem> = {}) => fixtureItem({ ticket: row.ticket, ...over });
  it("is empty without items", () => {
    expect(needLine(row, [], NOW)).toEqual([]);
    expect(needLine(row, [item({ agentId: "b", kind: "stalled" })], NOW)).toEqual([]);
  });

  it("stalled: age from the item and the tool", () => {
    const i = item({
      key: "stall:a:r",
      agentId: "a",
      kind: "stalled",
      at: NOW - 125_000,
      tool: "Bash",
    });
    expect(needLine(row, [i], NOW)).toEqual([
      { text: "Stalled 2:05 in Bash", action: null, key: "stall:a:r" },
    ]);
    expect(needLine(row, [{ ...i, tool: null }], NOW)[0]?.text).toBe("Stalled 2:05");
  });

  describe("a stalled crew seat", () => {
    const seat = seatRow({ id: "guido-1", hudState: "stalled" });
    const stall = fixtureItem({
      key: "stall:guido-1:r",
      agentId: "guido-1",
      kind: "stalled",
      ticket: seat.ticket,
      at: NOW - 11 * MIN,
      tool: "Bash",
    });
    const lock = (holder: string, waiting: string[]) => ({
      holder: { runId: "r-1", seatId: holder, command: "pnpm -s test", since: NOW - 12 * MIN },
      waiting: waiting.map((seatId, i) => ({
        runId: `w-${i}`,
        seatId,
        command: "pnpm -s test",
        since: NOW - MIN,
      })),
    });

    it("holding the test lock reads Stop the run, with the seats waiting", () => {
      const l = lock("guido-1", ["inco-1", "retro-1", "inco-1"]);
      expect(needLine(seat, [stall], NOW, l)).toEqual([
        {
          text: "Stalled 11:00 and holding the test lock; 2 waiting",
          action: "stop",
          key: "stall:guido-1:r",
        },
      ]);
    });

    it("drops the waiting count when nobody waits", () => {
      expect(needLine(seat, [stall], NOW, lock("guido-1", []))[0]?.text).toBe(
        "Stalled 11:00 and holding the test lock",
      );
    });

    it("holding nothing reads the tool, with Interrupt", () => {
      const other = lock("retro-1", ["guido-1"]);
      for (const l of [other, undefined]) {
        expect(needLine(seat, [stall], NOW, l)).toEqual([
          { text: "Stalled 11:00 in Bash", action: "interrupt", key: "stall:guido-1:r" },
        ]);
      }
    });
  });

  it("parked opens the item; asks answer it", () => {
    const p = item({ key: "p", agentId: "a", kind: "parked", text: "Blocked on a rebase" });
    const d = item({ key: "d", agentId: "a", kind: "decision" });
    const q = item({ key: "q", agentId: "a", kind: "question" });
    const ap = item({ key: "ap", agentId: "a", kind: "approval" });
    expect(needLine(row, [d, q, ap, p], NOW)).toEqual([
      { text: "Parked: Blocked on a rebase", action: "open", key: "p" },
      { text: "Decision, question and approval for you", action: "answer", key: "d" },
    ]);
  });

  it("combines a decision and question into one answer keyed to the oldest ask", () => {
    const d = item({ key: "d", agentId: "a", kind: "decision", at: NOW - MIN });
    const q = item({ key: "q", agentId: "a", kind: "question", at: NOW - 2 * MIN });
    for (const asks of [
      [d, q],
      [q, d],
    ]) {
      expect(needLine(row, asks, NOW)).toEqual([
        { text: "Decision and question for you", action: "answer", key: "q" },
      ]);
    }
    expect(needLine(row, [d], NOW)).toEqual([
      { text: "Decision for you", action: "answer", key: "d" },
    ]);
  });

  it("error comes from the row's source error", () => {
    const e = crewRow({ id: "a", hudState: "error", sourceError: "state dir gone" });
    expect(needLine(e, [], NOW)).toEqual([
      { text: "Error: state dir gone", action: null, key: "error:a" },
    ]);
  });

  it("ready to merge in the need line", () => {
    // The `ready` kind arrives with ticket 202; until then the fixture casts it.
    const ready = {
      ...item({ key: "r", agentId: "a" }),
      kind: "ready",
    } as unknown as AttentionItem;
    expect(needLine(row, [ready], NOW).at(-1)).toEqual({
      text: "Ready to merge",
      action: "open",
      key: "r",
    });
    expect(needLine(row, [], NOW).some((p) => p.text === "Ready to merge")).toBe(false);
    expect(needLine(crewRow({ id: "b" }), [ready], NOW)).toEqual([]);
  });

  it("leaves out a set-aside run's items: another ticket's ready note is not the row's", () => {
    const old = {
      ...item({ key: "ready:old", agentId: "a", ticket: "shop-app#3000", escalationId: null }),
      kind: "ready",
    } as unknown as AttentionItem;
    const seatLevel = item({ key: "stall:a", agentId: "a", kind: "stalled", ticket: null });
    expect(needLine(row, [old], NOW)).toEqual([]);
    expect(needLine(row, [old, seatLevel], NOW).map((p) => p.key)).toEqual(["stall:a"]);
    expect(seatItems(row, [old, seatLevel])).toEqual([seatLevel]);
  });
});

describe("the review seat's doing line", () => {
  const reviewing = { prNumber: 12, sha: "abc1234ffff", ref: "mc#7" };

  it("an idle reviewing seat says which PR", () => {
    const row = { ...crewRow({ hudState: "idle" }), reviewing };
    expect(doingLine(row, NOW, TZ)).toBe("Reviewing PR #12 (abc1234) · mc#7");
    expect(doingLine({ ...row, reviewing: { ...reviewing, ref: null } }, NOW, TZ)).toBe(
      "Reviewing PR #12 (abc1234)",
    );
  });

  it("an idle seat with reviewing null keeps its idle line", () => {
    const row = { ...crewRow({ hudState: "idle" }), reviewing: null };
    expect(doingLine(row, NOW, TZ)).not.toContain("Reviewing");
  });

  it("a running reviewing seat keeps its tool line", () => {
    const live = crewRow({ digest: digest({ liveTool: { name: "Bash", since: NOW - 125_000 } }) });
    expect(doingLine({ ...live, reviewing }, NOW, TZ)).toBe("run #12 · Bash 2:05");
  });
});

describe("minute buckets", () => {
  const m = (min: number, tokens: number): [number, number] => [NOW - min * MIN, tokens];
  it("tokensPerMinute is the newest complete bucket, 0 once it is over two minutes old", () => {
    const row = crewRow({ digest: digest({ minuteTokens: [m(4, 100), m(2, 600), m(0, 50)] }) });
    // the bucket starting now is still filling; the one before it is complete
    expect(tokensPerMinute(row.digest, NOW)).toBe(600);
    expect(tokensPerMinute(row.digest, NOW + 3 * MIN)).toBe(0);
    expect(tokensPerMinute(null, NOW)).toBeNull();
  });

  it("sparkValues are the last 24 minutes, gaps filled with 0", () => {
    const d = digest({ minuteTokens: [m(30, 9), m(3, 5), m(0, 7)] });
    const v = sparkValues(d);
    expect(v).toHaveLength(24);
    expect(v.at(-1)).toBe(7);
    expect(v.at(-4)).toBe(5);
    expect(v.at(-2)).toBe(0);
    expect(sparkValues(digest())).toEqual([]);
  });
});

describe("hasActiveRun", () => {
  const run = crewRow().run as NonNullable<CrewRow["run"]>;
  it("is a run that is running and has not ended, whatever the seat's state", () => {
    expect(hasActiveRun({ run: { ...run, status: "running", endedAt: null } })).toBe(true);
    // a seat in error whose run is still running still has that run in flight
    expect(
      hasActiveRun(
        crewRow({ hudState: "error", run: { ...run, status: "running", endedAt: null } }),
      ),
    ).toBe(true);
  });
  it("is false with no run, an ended run, or a run that is not running", () => {
    expect(hasActiveRun({ run: null })).toBe(false);
    expect(hasActiveRun({ run: { ...run, status: "running", endedAt: NOW } })).toBe(false);
    expect(hasActiveRun({ run: { ...run, status: "ok", endedAt: null } })).toBe(false);
  });
});

describe("modelLine", () => {
  const seat = (over: Partial<CrewRow> = {}) =>
    crewRow({ kind: "crew", loopKind: "crew", model: "sonnet", ...over });
  const ran = (model: string | null) => ({
    ...(crewRow().run as NonNullable<CrewRow["run"]>),
    model,
  });

  it("a seat with all three: the run's model id, effort, CLI version", () => {
    const row = seat({
      run: ran("claude-sonnet-5-5"),
      cli: { version: "2.1.302", effort: "high" },
    });
    expect(modelLine(row)).toBe("claude-sonnet-5-5 · high · CLI 2.1.302");
  });

  it("a seat falls back to its config alias, then to a dash", () => {
    expect(modelLine(seat({ run: ran(null) }))).toBe("sonnet · default");
    expect(modelLine(seat({ run: null, model: null }))).toBe("— · default");
  });

  it("a seat with no effort says default; with no version leaves it out", () => {
    const row = seat({ run: ran("claude-sonnet-5-5"), cli: { version: "2.1.302", effort: null } });
    expect(modelLine(row)).toBe("claude-sonnet-5-5 · default · CLI 2.1.302");
    expect(modelLine(seat({ run: ran("m"), cli: { version: null, effort: "high" } }))).toBe(
      "m · high",
    );
  });

  it("a loop is the model only (effort is never shown), or a dash", () => {
    const cli = { version: "2.1.302", effort: "high" };
    expect(modelLine(crewRow({ run: ran("claude-opus-4-1"), cli }))).toBe(
      "claude-opus-4-1 · CLI 2.1.302",
    );
    expect(modelLine(crewRow({ run: null, cli: { version: null, effort: null } }))).toBe("—");
  });
});

describe("loopMarks", () => {
  const loop = (phase: CrewLoop["phase"]): CrewLoop => ({
    phase,
    text: "x",
    prNumber: null,
    parked: null,
  });

  it.each([
    ["working", "running", ["cur", "todo", "todo", "todo"]],
    ["ci", "idle", ["done", "cur", "todo", "todo"]],
    ["review", "idle", ["done", "done", "cur", "todo"]],
    ["review", "waiting", ["done", "done", "held", "todo"]],
    ["working", "stalled", ["held", "todo", "todo", "todo"]],
    ["parked", "running", ["held", "held", "held", "held"]],
    ["parked", "idle", ["held", "held", "held", "held"]],
    ["done", "idle", ["done", "done", "done", "done"]],
  ] as const)("%s while %s", (phase, state: HudState, expected) => {
    expect(loopMarks(loop(phase), state)).toEqual(expected);
  });

  it("parked with heldAt marks steps before it done and it held", () => {
    expect(loopMarks(loop("parked"), "idle", "ci")).toEqual(["done", "held", "todo", "todo"]);
    expect(loopMarks(loop("parked"), "idle", "working")).toEqual(["held", "todo", "todo", "todo"]);
  });

  it("the step bar's tooltip is the path", () => {
    expect(LOOP_PATH_TITLE).toBe("Working → CI → In review → Done");
  });
});

describe("stepMarks", () => {
  const feature = DEFAULT_PROFILES.find((p) => p.name === "feature");
  const loop: CrewLoop = {
    phase: "working",
    text: "Working",
    prNumber: null,
    parked: null,
    steps: feature?.steps,
  };

  it("a run with a plan event shows plan done only for an explicit plan step", () => {
    expect(loopSteps(loop).map((s) => s.name)).toEqual([
      "implement",
      "draft PR",
      "verify",
      "review",
      "merge",
    ]);
    for (const planned of [true, false]) {
      expect(stepMarks({ ...loop, planned }, "running")).toEqual([
        "cur",
        "todo",
        "todo",
        "todo",
        "todo",
      ]);
    }
    const legacy: CrewLoop = {
      ...loop,
      steps: [
        { name: "plan", phase: null },
        { name: "go/no-go", phase: null },
        { name: "implement", phase: "working" },
        { name: "verify", phase: "ci" },
        { name: "review", phase: "review" },
        { name: "draft PR", phase: null },
      ],
    };
    expect(stepMarks({ ...legacy, planned: true }, "running")).toEqual([
      "done",
      "todo",
      "cur",
      "todo",
      "todo",
      "todo",
    ]);
    expect(stepMarks({ ...legacy, planned: false }, "running")).toEqual([
      "todo",
      "todo",
      "cur",
      "todo",
      "todo",
      "todo",
    ]);
  });

  it("parked without a known held phase completes unphased steps only from run evidence", () => {
    const parked: CrewLoop = { ...loop, phase: "parked" };
    const legacyPlan: CrewLoop = {
      ...parked,
      steps: [{ name: "plan", phase: null }],
    };
    expect(stepMarks(legacyPlan, "parked")).toEqual(["todo"]);
    expect(stepMarks({ ...legacyPlan, planned: true }, "parked")).toEqual(["done"]);
    expect(stepMarks({ ...legacyPlan, phase: "done" }, "idle")).toEqual(["todo"]);
    expect(stepMarks(parked, "parked")).toEqual(["held", "todo", "held", "held", "todo"]);
    expect(stepMarks({ ...parked, planned: true, prNumber: 9 }, "parked")).toEqual([
      "held",
      "done",
      "held",
      "held",
      "todo",
    ]);
    expect(stepMarks({ ...parked, phase: "done" }, "idle")).toEqual([
      "done",
      "todo",
      "done",
      "done",
      "todo",
    ]);
  });

  it("unknown profile phases use run evidence or todo without completing earlier steps", () => {
    const unknown = "unknown" as NonNullable<CrewLoop["steps"]>[number]["phase"];
    const current: CrewLoop = {
      ...loop,
      steps: [
        { name: "go/no-go", phase: null },
        { name: "custom", phase: unknown },
        { name: "plan", phase: unknown },
        { name: "draft PR", phase: unknown },
      ],
    };
    expect(stepMarks(current, "running")).toEqual(["todo", "todo", "todo", "todo"]);
    expect(stepMarks({ ...current, planned: true, prNumber: 9 }, "running")).toEqual([
      "todo",
      "todo",
      "done",
      "done",
    ]);
  });

  it("without profile steps it is loopMarks", () => {
    const fallback = { ...loop, phase: "ci" as const, steps: undefined };
    expect(stepMarks(fallback, "idle")).toEqual(["done", "cur", "todo", "todo"]);
    expect(loopSteps(fallback).map((s) => s.name)).toEqual(["Working", "CI", "In review", "Done"]);
  });

  it("draft PR is done once a PR is open", () => {
    const index = loopSteps(loop).findIndex((s) => s.name === "draft PR");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(stepMarks({ ...loop, phase: "review", prNumber: 9 }, "running")[index]).toBe("done");
  });

  it("Overview and the Agent page name the same current step", () => {
    for (const profile of DEFAULT_PROFILES) {
      for (const phase of ["working", "ci", "review"] as const) {
        const step = profileStep(profile, phase);
        if (step === null) continue;
        const current = { ...loop, phase, steps: profile.steps, step };
        const index = stepMarks(current, "running").indexOf("cur");
        expect(loopSteps(current)[index]?.name).toBe(loopStepLabel(current));
      }
    }
  });
});

describe("waitText", () => {
  const loop = (phase: CrewLoop["phase"], over: Partial<CrewLoop> = {}): CrewLoop => ({
    phase,
    text: "x",
    prNumber: null,
    parked: null,
    ...over,
  });
  const CALL = "GUIDO-1";

  it.each([
    ["ci", "ci", "waiting on CI"],
    ["retro", "review", "waiting on RETRO's review"],
    ["main", "review", "waiting on main: updating the branch"],
  ] as const)("%s", (wait, phase, text) => {
    expect(waitText(loop(phase, { wait }), CALL, null, NOW)).toBe(text);
  });

  it("operator: a park reason, none, and in review", () => {
    expect(
      waitText(loop("parked", { wait: "operator", parked: "CI failed 3 times" }), CALL, null, NOW),
    ).toBe("waiting on you: CI failed 3 times");
    expect(waitText(loop("parked", { wait: "operator" }), CALL, null, NOW)).toBe("waiting on you");
    expect(waitText(loop("review", { wait: "operator" }), CALL, null, NOW)).toBe("waiting on you");
  });

  it("lock: timed from when the run joined the line, else bare", () => {
    const l = loop("working", { wait: "lock" });
    expect(waitText(l, CALL, NOW - 65_000, NOW)).toBe("in line for the test lock · 1:05");
    expect(waitText(l, CALL, null, NOW)).toBe(WAIT_TEXT.lock);
  });

  it("seat: names the call sign", () => {
    expect(waitText(loop("review", { wait: "seat" }), CALL, null, NOW)).toBe(
      "waiting on GUIDO-1 for rework",
    );
  });

  it("nothing: wait null or missing", () => {
    expect(waitText(loop("working", { wait: null }), CALL, null, NOW)).toBeNull();
    expect(waitText(loop("working"), CALL, null, NOW)).toBeNull();
  });
});

describe("lockSince", () => {
  const lock = {
    holder: null,
    waiting: [
      { runId: "r-1", seatId: "guido-1", command: "pnpm -s test", since: 5 },
      { runId: "r-1", seatId: "guido-1", command: "pnpm -s test", since: 9 },
    ],
  };
  it("is the first entry's since for the run, else null", () => {
    expect(lockSince(lock, "r-1")).toBe(5);
    expect(lockSince(lock, "r-2")).toBeNull();
    expect(lockSince(lock, null)).toBeNull();
    expect(lockSince(undefined, "r-1")).toBeNull();
  });
});

describe("loopTryText", () => {
  const base = { phase: "ci", text: "x", prNumber: null, parked: null } as const;
  it("shows the try from the second on", () => {
    expect(loopTryText({ ...base, tries: { n: 2, max: 3 } })).toBe(" · try 2 of 3");
    expect(loopTryText({ ...base, tries: { n: 1, max: 3 } })).toBe("");
    expect(loopTryText({ ...base, tries: null })).toBe("");
    expect(loopTryText(base)).toBe("");
  });
});

describe("loopStepLabel", () => {
  const base = { phase: "ci", text: "x", prNumber: null, parked: null } as const;
  it("is the profile's step, else the phase label", () => {
    expect(loopStepLabel({ ...base, step: "verify" })).toBe("verify");
    expect(loopStepLabel(base)).toBe("CI");
  });
});

describe("loopTemplate", () => {
  const base = { phase: "ci", text: "x", prNumber: null, parked: null } as const;
  it("is the run's profile, else the build loop", () => {
    expect(loopTemplate({ ...base, profile: "hotfix" })).toBe("hotfix");
    expect(loopTemplate(base)).toBe("build");
  });
});

describe("seatAreaText", () => {
  it("names read-only, scratch, the globs, or the whole checkout", () => {
    expect(seatAreaText({ mode: "read-only", area: [] })).toBe("read-only");
    expect(seatAreaText({ mode: "scratch", area: [] })).toBe("scratch review copy");
    expect(seatAreaText({ mode: "writer", area: ["apps/**", "docs/**"] })).toBe("apps/**, docs/**");
    expect(seatAreaText({ mode: "writer", area: [] })).toBe("whole checkout");
  });
});

describe("seatStatus", () => {
  const seat = (over: Partial<CrewRow> = {}) =>
    crewRow({ kind: "crew", loopKind: "crew", hudState: "idle", ...over });
  const loop = (phase: CrewLoop["phase"]): CrewLoop => ({
    phase,
    text: "",
    prNumber: null,
    parked: null,
  });

  it("an idle seat with a ci loop on an open run is waiting on CI", () => {
    expect(seatStatus(seat({ loop: loop("ci") }))).toEqual({
      label: SEAT_STATUS_LABEL.ci,
      tone: "neutral",
    });
    expect(SEAT_STATUS_LABEL.ci).toBe("Waiting on CI");
  });

  it("a review loop is In review", () => {
    expect(seatStatus(seat({ loop: loop("review") }))).toEqual({
      label: "In review",
      tone: "neutral",
    });
  });

  it("a parked loop is Blocked, in warn", () => {
    expect(seatStatus(seat({ loop: loop("parked") }))).toEqual({ label: "Blocked", tone: "warn" });
  });

  it("an idle seat between turns, with no loop or a working one, is Idle", () => {
    expect(seatStatus(seat()).label).toBe("Idle");
    expect(seatStatus(seat({ loop: loop("working") })).label).toBe("Idle");
  });

  it("a seat with no open run is Free, whatever its loop says", () => {
    const live = crewRow().run as NonNullable<CrewRow["run"]>;
    const ended = { ...live, status: "ok" as const, endedAt: NOW - MIN };
    expect(seatStatus(seat({ run: ended, loop: loop("ci") }))).toEqual({
      label: "Free",
      tone: "neutral",
    });
    expect(seatStatus(seat({ run: null })).label).toBe("Free");
  });

  it("a running seat is Running, in ok", () => {
    expect(seatStatus(seat({ hudState: "running", loop: loop("ci") }))).toEqual({
      label: "Running",
      tone: "ok",
    });
  });

  it("an observed loop keeps today's pill", () => {
    expect(seatStatus(crewRow({ hudState: "idle", run: null }))).toEqual({
      label: "Idle",
      tone: "neutral",
    });
    expect(seatStatus(crewRow({ hudState: "idle", loop: loop("ci") })).label).toBe("Idle");
  });
});
