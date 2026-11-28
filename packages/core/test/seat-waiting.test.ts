import { describe, expect, it } from "vitest";
import { NEW_LOOP, type Run, type SeatSessionRow, seatWaiting, waitingOn } from "../src/index.ts";

describe("waitingOn", () => {
  it("names FLIGHT, the operator or the ticket the seat's last message waits on", () => {
    expect(waitingOn("Asked FLIGHT to reset my branch.", "mc#7")).toBe("waiting on FLIGHT");
    expect(waitingOn("Blocked until the operator grants database access.", "mc#7")).toBe(
      "waiting on the operator",
    );
    expect(waitingOn("The CAPCOM must approve the token.", "mc#7")).toBe("waiting on the operator");
    expect(waitingOn("This needs #2275 merged first.", "mc#7")).toBe("waiting on #2275");
    expect(waitingOn("This needs ebull#2275 merged first.", "mc#7")).toBe("waiting on ebull#2275");
  });

  it("never names the seat's own ticket, and says plain waiting when nothing is named", () => {
    expect(waitingOn("Work on mc#7 is committed.", "mc#7")).toBe("waiting");
    expect(waitingOn("Work on #7 is committed.", "mc#7")).toBe("waiting");
    expect(waitingOn(null, "mc#7")).toBe("waiting");
  });
});

describe("seatWaiting", () => {
  const run: Pick<Run, "id" | "startedAt" | "endedAt" | "ticket" | "loop"> = {
    id: "r1",
    startedAt: 1000,
    endedAt: null,
    ticket: "mc#7",
    loop: { ...NEW_LOOP, phase: "working" },
  };
  const row = (over: Partial<SeatSessionRow> = {}): SeatSessionRow => ({
    seatId: "guido-1",
    runId: "r1",
    cliSessionId: "c",
    state: "idle",
    reason: null,
    worktree: "/w",
    updatedAt: 5000,
    lastTurnEndedAt: 5000,
    ...over,
  });

  it("a seat that ended its turn on a working run, with no report, waits on what its last message names", () => {
    expect(seatWaiting(row(), run, "Asked FLIGHT to reset my branch.")).toEqual({
      runId: "r1",
      since: 5000,
      text: "waiting on FLIGHT: Asked FLIGHT to reset my branch.",
      lastText: "Asked FLIGHT to reset my branch.",
    });
  });

  it("a seat at work, past its report, or with its own reason is not waiting", () => {
    expect(seatWaiting(row({ state: "running" }), run, "x")).toBeNull();
    expect(seatWaiting(row(), { ...run, loop: { ...NEW_LOOP, phase: "review" } }, "x")).toBeNull();
    expect(seatWaiting(row(), { ...run, endedAt: 6000 }, "x")).toBeNull();
    expect(seatWaiting(row({ reason: "last turn failed" }), run, "x")).toBeNull();
    expect(seatWaiting(row({ runId: "r0" }), run, "x")).toBeNull();
    // a turn that ended before this run began is not this run's
    expect(seatWaiting(row({ lastTurnEndedAt: 500 }), run, "x")).toBeNull();
    expect(seatWaiting(null, run, "x")).toBeNull();
  });
});
