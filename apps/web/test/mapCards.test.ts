import { MAP_RECENT_MS, type MapSeat, type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  changeTotals,
  isWorking,
  nodeWork,
  readCount,
  seatToken,
  workLine,
} from "../src/map/cards.ts";

const now = 1_000_000;
function seat(id = "GUIDO-1"): MapSeat {
  const s: MapSeat = structuredClone(mapSnapshotFixture.seats[0]);
  s.seat = id;
  s.since = now;
  s.calls = [];
  s.badges = { questions: [], failures: [], review: null, tests: null, ci: null, waiting: null };
  return s;
}

describe("who the map shows", () => {
  it("shows a seat live now, with a recent path or an unmerged change, and leaves the rest out", () => {
    const s = seat();
    s.state = "idle";
    s.since = now - 120_000;
    s.scope = { read: ["src/main.ts"], modified: [] };
    s.recent = [];
    expect(isWorking(s, now)).toBe(false);
    // a run that ended keeps its path on the map while the hub keeps it
    s.recent = [{ file: "src/main.ts", at: now - 300_000 }];
    expect(isWorking(s, now)).toBe(true);
    // until the hub would have let it go
    expect(isWorking(s, now - 300_000 + MAP_RECENT_MS + 1)).toBe(false);
    s.recent = [];
    s.scope.modified = [{ file: "src/main.ts", add: 1, rem: 0, source: "diff" }];
    expect(isWorking(s, now)).toBe(true);
    s.scope.modified = [];
    s.since = now - 30_000; // within a minute of its last turn
    expect(isWorking(s, now)).toBe(true);
    s.since = now - 120_000;
    s.calls = [{ tool: "Read", detail: "x", files: [], since: now }];
    expect(isWorking(s, now)).toBe(true);
  });

  it("keeps a seat waiting on the operator in the selector; a stopped run or the test lock isn't that", () => {
    const s = seat();
    Object.assign(s, { state: "idle", since: 0, recent: [], scope: { read: [], modified: [] } });
    expect(isWorking(s, now)).toBe(false);
    s.badges.waiting = { kind: "parked", since: 0, reason: "Needs CAPCOM", stopped: false };
    expect(isWorking(s, now)).toBe(true);
    s.badges.waiting = { kind: "parked", since: 0, reason: "run ended (stopped)", stopped: true };
    expect(isWorking(s, now)).toBe(false);
    s.badges.waiting = { kind: "test-lock", since: 0, reason: "pnpm test", stopped: false };
    expect(isWorking(s, now)).toBe(false);
    s.badges.questions = [{ id: 1, from: "GUIDO-1", to: "CAPCOM", ticket: null, since: 0 }];
    expect(isWorking(s, now)).toBe(true);
  });
});

describe("what a seat is on", () => {
  it("says the ticket, its PR and title as the Overview does, or nothing without either", () => {
    const on = { ticket: 7, title: "Handle empty input", pr: null };
    expect(workLine(on)).toBe("#7 · Handle empty input");
    expect(workLine({ ...on, pr: 12 })).toBe("#7 · PR #12 · Handle empty input");
    expect(workLine({ ...on, ticket: null, pr: 12 })).toBe("PR #12 · Handle empty input");
    expect(workLine({ ...on, ticket: null })).toBeNull();
  });

  it("gives each seat one map colour token by its place, FLIGHT its own", () => {
    expect(seatToken("GUIDO-1", 0)).toBe("--seat-1");
    expect(seatToken("GUIDO-1", 9)).toBe("--seat-3");
    expect(seatToken("FLIGHT", 2)).toBe("--seat-flight");
  });

  it("counts its changed files and lines, marking churn, and its distinct reads", () => {
    const s = seat();
    s.recent = [];
    s.scope = {
      read: ["a.ts", "b.ts", "a.ts"],
      modified: [
        { file: "a.ts", add: 10, rem: 2, source: "diff" },
        { file: "c.ts", add: 3, rem: 0, source: "churn" },
        // a mode-only change moved no line, so it counts for nothing
        { file: "d.ts", add: 0, rem: 0, source: "diff" },
      ],
    };
    expect(changeTotals(s)).toEqual({ files: 2, add: 13, rem: 2, churn: true });
    // a.ts and b.ts were read (a.ts changed too)
    expect(readCount(s)).toBe(2);
    // once a run's reads are gone, a file on its path it didn't change still counts, as its disc does
    s.scope.read = [];
    s.recent = [
      { file: "b.ts", at: 1 },
      { file: "a.ts", at: 2 },
    ];
    s.calls = [{ tool: "Glob", detail: "**", files: ["e.ts", "f.ts"], since: 3 }];
    expect(readCount(s)).toBe(1);
  });
});

describe("who worked on a node", () => {
  const snapshot = (): MapSnapshot => {
    const a = seat("GUIDO-1");
    const b = seat("GUIDO-2");
    const c = seat("RETRO-1");
    a.scope = {
      read: ["src/x.ts"],
      modified: [
        { file: "src/x.ts", add: 5, rem: 1, source: "diff" },
        { file: "src/y.ts", add: 2, rem: 2, source: "churn" },
      ],
    };
    b.scope = { read: [], modified: [{ file: "src/x.ts", add: 40, rem: 7, source: "diff" }] };
    c.scope = { read: ["src/x.ts", "src/z.ts"], modified: [] };
    return { ...structuredClone(mapSnapshotFixture), seats: [a, b, c] };
  };

  it("lists each seat that touched a file in seat order: changed with its own +/−, read, or both", () => {
    expect(nodeWork(snapshot(), ["src/x.ts"])).toEqual([
      { seat: "GUIDO-1", changed: { add: 5, rem: 1, churn: false }, read: true },
      { seat: "GUIDO-2", changed: { add: 40, rem: 7, churn: false }, read: false },
      { seat: "RETRO-1", changed: null, read: true },
    ]);
  });

  it("sums a folder's files per seat, and counts a file a call only accessed as read", () => {
    const s = snapshot();
    (s.seats[1] as MapSeat).calls = [{ tool: "Grep", detail: "", files: ["src/z.ts"], since: 0 }];
    expect(nodeWork(s, ["src/x.ts", "src/y.ts", "src/z.ts"])).toEqual([
      { seat: "GUIDO-1", changed: { add: 7, rem: 3, churn: true }, read: true },
      { seat: "GUIDO-2", changed: { add: 40, rem: 7, churn: false }, read: false },
      { seat: "RETRO-1", changed: null, read: true },
    ]);
    expect(nodeWork(s, ["src/w.ts"])).toEqual([]);
    (s.seats[0] as MapSeat).recent = [{ file: "src/w.ts", at: 1 }];
    expect(nodeWork(s, ["src/w.ts"])).toEqual([{ seat: "GUIDO-1", changed: null, read: true }]);
  });
});
