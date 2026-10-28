import { type MapSeat, type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  agentCard,
  badgeModels,
  branchList,
  changedElsewhere,
  changeTotals,
  factLine,
  isStuck,
  isWorking,
  recentFailures,
  stageLine,
  uncheckedNotes,
  waitsOnYou,
} from "../src/map/cards.ts";
import { applyDelta } from "../src/map/model.ts";

const now = 2_000_000;
function seat(): MapSeat {
  const s: MapSeat = structuredClone(mapSnapshotFixture.seats[0]);
  s.since = now;
  s.calls = [];
  s.badges = { questions: [], failures: [], review: null, tests: null, ci: null, waiting: null };
  return s;
}

describe("who the stage shows, and its one line", () => {
  const now = 1_000_000;
  it("shows a seat live now or with an unmerged change, and folds the rest", () => {
    const s = seat();
    s.badges.questions = [];
    s.state = "idle";
    s.calls = [];
    s.since = now - 120_000;
    s.scope = { read: ["src/main.ts"], modified: [] };
    expect(isWorking(s, now)).toBe(false);
    s.scope.modified = [{ file: "src/main.ts", add: 1, rem: 0, source: "diff" }];
    expect(isWorking(s, now)).toBe(true);
    s.scope.modified = [];
    s.since = now - 30_000; // within a minute of its last turn
    expect(isWorking(s, now)).toBe(true);
    s.since = now - 120_000;
    s.calls = [{ tool: "Read", detail: "x", files: [], since: now }];
    expect(isWorking(s, now)).toBe(true);
  });
  it("reads call sign · ticket · files · +added −removed from the branch diff, labelling churn", () => {
    const s = seat();
    s.badges.questions = [];
    s.scope.modified = [
      { file: "a.ts", add: 10, rem: 2, source: "diff" },
      { file: "b.ts", add: 5, rem: 0, source: "diff" },
      { file: "mode-only.sh", add: 0, rem: 0, source: "diff" },
    ];
    expect(factLine(s, "GUIDO-CX")).toBe("GUIDO-CX · #7 · 2 files · +15 −2");
    expect(changeTotals(s)).toEqual({ files: 2, add: 15, rem: 2, churn: false });
    // a file not in the diff yet comes from edit churn, and the line says so
    s.scope.modified.push({ file: "new.ts", add: 4, rem: 0, source: "churn" });
    expect(factLine(s, "GUIDO-CX")).toBe("GUIDO-CX · #7 · 3 files · +19 −2 (churn)");
    s.ticket = null;
    s.branches = ["feature/1"];
    s.changedOn = ["feature/1"];
    s.tickets = {};
    s.scope.modified = [{ file: "a.ts", add: 1, rem: 1, source: "diff" }];
    expect(factLine(s)).toBe("GUIDO-1 · 1 file · +1 −1");
    s.branches = ["feature/1", "feature/0-set-aside"];
    s.changedOn = ["feature/1"];
    // an unmerged branch with nothing changed isn't counted on the line
    expect(factLine(s)).toBe("GUIDO-1 · 1 file · +1 −1");
    s.changedOn = ["feature/1", "feature/0-set-aside"];
    expect(factLine(s)).toBe("GUIDO-1 · 1 file · +1 −1 · 2 branches");
    s.branches = ["feature/1"];
    s.changedOn = [];
    s.scope.modified = [];
    expect(factLine(s)).toBe("GUIDO-1 · no changes yet");
    expect(factLine({ ...s, seat: "FLIGHT" }, "FLIGHT")).toBe("FLIGHT");
    s.badges.questions = [{ id: 1, from: "GUIDO-1", to: "CAPCOM", ticket: null, since: 0 }];
    expect(factLine(s)).toBe("GUIDO-1 · no changes yet · waiting on you");
  });
  it("keeps the stage's line to facts: ~ for churn, 2br for branches, no words", () => {
    const s = seat();
    s.scope.modified = [
      { file: "a.ts", add: 100, rem: 60, source: "diff" },
      { file: "new.ts", add: 13, rem: 3, source: "churn" },
    ];
    s.ticket = 717;
    s.branches = ["feature/717-audit", "feature/708-pill"];
    s.changedOn = ["feature/717-audit", "feature/708-pill"];
    s.tickets = { "feature/717-audit": 717, "feature/708-pill": 708 };
    expect(stageLine(s, "INCO-CX")).toBe("INCO-CX · #717 · 2 files · ~+113 −63 · 2br");
    expect(branchList(s)).toBe("feature/717-audit (#717), feature/708-pill (#708)");
    s.scope.modified = [{ file: "a.ts", add: 175, rem: 29, source: "diff" }];
    s.branches = ["feature/747-models"];
    s.changedOn = ["feature/747-models"];
    s.tickets = { "feature/747-models": 747 };
    s.ticket = 747;
    expect(stageLine(s, "GUIDO-CX")).toBe("GUIDO-CX · #747 · 1 file · +175 −29");
  });
  it("says which ticket the changes are on when it isn't the line's", () => {
    const s = seat();
    s.badges.questions = [];
    // the seat's current run is #698; its unmerged changes are all on a set-aside #747 branch
    s.ticket = 698;
    s.branches = ["feature/698-guard", "feature/747-models"];
    s.changedOn = ["feature/747-models"];
    s.tickets = { "feature/698-guard": 698, "feature/747-models": 747 };
    s.scope.modified = [{ file: "a.ts", add: 175, rem: 29, source: "diff" }];
    expect(stageLine(s, "GUIDO-CX")).toBe("GUIDO-CX · #698 · 1 file · +175 −29 on #747");
    expect(factLine(s, "GUIDO-CX")).toBe("GUIDO-CX · #698 · 1 file · +175 −29 on #747");
    expect(changedElsewhere(s)).toBe("#747");
    // changes on the line's own ticket and another: counted as two branches
    s.changedOn = ["feature/698-guard", "feature/747-models"];
    expect(stageLine(s, "GUIDO-CX")).toBe("GUIDO-CX · #698 · 1 file · +175 −29 · 2br");
  });
  it("never folds a seat waiting on the operator; a stopped run or the test lock isn't that", () => {
    const s = seat();
    Object.assign(s, { state: "idle", calls: [], since: 0, scope: { read: [], modified: [] } });
    s.badges.questions = [];
    expect(isWorking(s, 1_000_000)).toBe(false);
    s.badges.waiting = { kind: "parked", since: 0, reason: "Needs CAPCOM", stopped: false };
    expect(waitsOnYou(s)).toBe(true);
    expect(isWorking(s, 1_000_000)).toBe(true);
    s.badges.waiting = { kind: "parked", since: 0, reason: "run ended (stopped)", stopped: true };
    expect(waitsOnYou(s)).toBe(false);
    s.badges.waiting = { kind: "test-lock", since: 0, reason: "pnpm test", stopped: false };
    expect(waitsOnYou(s)).toBe(false);
    s.badges.questions = [{ id: 1, from: "GUIDO-1", to: "CAPCOM", ticket: null, since: 0 }];
    expect(isWorking(s, 1_000_000)).toBe(true);
  });
});

describe("unchecked conflict notes", () => {
  it("names each unmerged branch's unchecked reason, and the branch when the seat has several", () => {
    const s = seat();
    const snapshot: MapSnapshot = {
      ...structuredClone(mapSnapshotFixture),
      conflictsUnchecked: [
        { branch: "set-aside", reason: "head not fetched" },
        { branch: "someone-else", reason: "merge check failed" },
      ],
    };
    s.branches = ["current"];
    expect(uncheckedNotes(s, snapshot)).toEqual([]);
    s.branches = ["current", "set-aside"];
    expect(uncheckedNotes(s, snapshot)).toEqual([
      "Conflicts not checked on set-aside: head not fetched",
    ]);
    s.branches = ["set-aside"];
    expect(uncheckedNotes(s, snapshot)).toEqual(["Conflicts not checked: head not fetched"]);
  });
});

describe("map stuck rule", () => {
  it("marks a stalled run and otherwise leaves an ordinary running turn alone", () => {
    const s = seat();
    expect(isStuck(s, now)).toBe(false);
    s.state = "stalled";
    expect(isStuck(s, now)).toBe(true);
  });
  it("requires a call to run longer than ten minutes, including any parallel call", () => {
    const s = seat();
    s.calls = [{ tool: "Bash", detail: "tests", files: [], since: now - 600_000 }];
    expect(isStuck(s, now)).toBe(false);
    s.calls.push({ tool: "Read", detail: "src/main.ts", files: [], since: now - 600_001 });
    expect(isStuck(s, now)).toBe(true);
  });
  it("counts three mixed refusals and failures only within the last ten minutes", () => {
    const s = seat();
    s.badges.failures = [
      { at: now - 600_000, tool: "Write", refused: true, why: "denied" },
      { at: now - 1, tool: "Bash", refused: false, why: "error" },
      { at: now - 600_001, tool: "Read", refused: false, why: "old" },
      { at: now + 1, tool: "Read", refused: false, why: "future" },
    ];
    expect(recentFailures(s, now)).toHaveLength(2);
    expect(isStuck(s, now)).toBe(false);
    s.badges.failures.push({ at: now, tool: "guard", refused: true, why: "blocked" });
    expect(isStuck(s, now)).toBe(true);
    s.badges.failures = s.badges.failures.filter((f) => f.at <= now);
    expect(isStuck(s, now + 1)).toBe(false);
  });
  it("never calls a seat whose run the operator stopped stuck, however long it has been parked", () => {
    const s = seat();
    s.badges.waiting = {
      kind: "parked",
      since: now - 86_400_000,
      reason: "run ended (stopped)",
      stopped: true,
    };
    expect(isStuck(s, now)).toBe(false);
    s.badges.waiting.stopped = false;
    expect(isStuck(s, now)).toBe(true);
  });
  it.each(["test-lock", "parked"] as const)(
    "requires a %s wait older than fifteen minutes",
    (kind) => {
      const s = seat();
      s.badges.waiting = { kind, since: now - 900_000, reason: "waiting", stopped: false };
      expect(isStuck(s, now)).toBe(false);
      expect(isStuck(s, now + 1)).toBe(true);
    },
  );
});

describe("map badge data", () => {
  it("derives every fixture badge and its age from its own timestamp", () => {
    expect(badgeModels(mapSnapshotFixture.seats[0], 65_000)).toEqual([
      { kind: "questions", text: "Questions: 1 awaiting reply", age: "1m ago", tone: "muted" },
      {
        kind: "failures",
        text: "1 refused in 10 min · Permission denied",
        age: "1m ago",
        tone: "warn",
      },
      {
        kind: "review",
        text: "Review round 1: 0 Critical, 1 Important, 0 Minor",
        age: "1m ago",
        tone: "warn",
      },
      {
        kind: "tests",
        text: "Local tests: 4 passed, 0 failed · edited since",
        age: "1m ago",
        tone: "muted",
      },
      { kind: "ci", text: "CI @aaaaaaaa: unknown", age: "1m ago", tone: "muted" },
    ]);
  });
  it("uses the oldest question, latest failure reason, and drops expired failures", () => {
    const s = seat();
    s.badges.questions = [
      { id: 1, from: "a", to: "b", ticket: 7, since: now - 60_000 },
      { id: 2, from: "a", to: "c", ticket: 8, since: now - 120_000 },
    ];
    s.badges.failures = [
      { at: now - 5_000, tool: "Bash", refused: false, why: "latest" },
      { at: now - 600_001, tool: "Read", refused: false, why: "expired" },
      { at: now - 50_000, tool: "Write", refused: true, why: "older" },
    ];
    expect(badgeModels(s, now).map((b) => [b.text, b.age])).toEqual([
      ["Questions: 2 awaiting reply", "2m ago"],
      ["1 refused · 1 failed in 10 min · latest", "5s ago"],
    ]);
  });
  it("omits absent and wrong-ticket reviews; unknown runners stay unknown", () => {
    const s = seat();
    expect(badgeModels(s, now)).toEqual([]);
    s.badges.review = {
      ticket: 99,
      round: 10,
      counts: { Critical: 9, Important: 9, Minor: 9 },
      at: now,
    };
    s.badges.tests = { runner: null, status: "unknown", at: now - 3_000, editedSince: false };
    expect(badgeModels(s, now).map((b) => b.text)).toEqual(["Local tests: unknown"]);
  });
  it("reports head-SHA check states and waiting kind, reason and age", () => {
    const s = seat();
    s.badges.ci = {
      sha: "0123456789abcdef",
      at: now - 9_000,
      checks: ["passing", "pending", "failing"].map((state) => ({
        name: state,
        kind: "check" as const,
        state: state as "passing" | "pending" | "failing",
        conclusion: state,
        attempt: null,
        url: null,
      })),
    };
    s.badges.waiting = {
      kind: "test-lock",
      reason: "pnpm test",
      since: now - 120_000,
      stopped: false,
    };
    expect(badgeModels(s, now).map((b) => [b.text, b.age])).toEqual([
      ["CI @01234567: 1 passing, 1 failing, 1 pending", "9s ago"],
      ["Waiting: test-lock · pnpm test", "2m ago"],
    ]);
    s.badges.waiting.kind = "parked";
    expect(badgeModels(s, now).at(-1)?.text).toBe("Waiting: parked · pnpm test");
  });
  it("counts unique scope and accessing files; thinking never claims a file", () => {
    const s = seat();
    s.calls = [
      { tool: "Read", detail: "src/main.ts", files: ["src/main.ts"], since: now - 1_000 },
      { tool: "Read", detail: "src/util.ts", files: ["src/main.ts", "src/util.ts"], since: now },
    ];
    expect(agentCard(s, now)).toMatchObject({
      scope: 2,
      modified: 1,
      accessing: 2,
      folder: "src",
    });
    // The card and the orb label read the same state.
    expect(agentCard(s, now).state).toBe("reading src/main.ts 1s · +1 calls");
    s.calls = [];
    expect(agentCard(s, now).state).toBe("thinking");
    s.state = "idle";
    s.since = now - 60_000;
    expect(agentCard(s, now)).toMatchObject({ state: "idle 1m" });
  });
});

describe("live badge changes", () => {
  it.each([null, { runner: null, status: "unknown" } as const])(
    "completes an ordinary Bash call without invalidation for tests=%j",
    (tests) => {
      const s = structuredClone(mapSnapshotFixture);
      s.seq = 10;
      s.seats[0].calls = [{ tool: "Bash", detail: "git status", files: [], since: now - 1000 }];
      const next = applyDelta(
        s,
        {
          seq: 11,
          type: "call.end",
          seat: s.seats[0].seat,
          files: [],
          resultTok: 1,
          error: false,
          refused: false,
          why: null,
          tests,
        },
        now,
      );
      expect(next?.seq).toBe(11);
      expect(next?.seats[0].calls).toEqual([]);
      expect(next?.seats[0].badges.tests).toEqual(s.seats[0].badges.tests);
      expect(s.seats[0].calls).toHaveLength(1);
    },
  );
  it.each([
    ["changed additions", "src/main.ts", 99, 1, true],
    ["changed removals", "src/main.ts", 3, 99, true],
    ["new file", "src/new.ts", 1, 0, true],
    ["unchanged counts", "src/main.ts", 3, 1, false],
  ] as const)("marks test freshness for a diff with %s", (_, file, add, rem, editedSince) => {
    const s: MapSnapshot = structuredClone(mapSnapshotFixture);
    s.seq = 10;
    s.seats[0].scope.modified = [{ file: "src/main.ts", add: 3, rem: 1, source: "diff" }];
    s.seats[0].badges.tests = {
      runner: "vitest",
      status: "passed",
      passed: 4,
      failed: 0,
      at: now - 1000,
      editedSince: false,
    };
    const next = applyDelta(
      s,
      { seq: 11, type: "diff", seat: s.seats[0].seat, file, add, rem },
      now,
    );
    expect(next?.seats[0].badges.tests).toMatchObject({ editedSince, at: now - 1000 });
    expect(s.seats[0].badges.tests?.editedSince).toBe(false);
  });
  it("refetches parsed tests even when a tool succeeded, so their age uses server time", () => {
    const s = structuredClone(mapSnapshotFixture);
    expect(
      applyDelta(
        s,
        {
          seq: 1,
          type: "call.end",
          seat: s.seats[0].seat,
          files: ["src/util.ts"],
          resultTok: 1,
          error: false,
          refused: false,
          why: null,
          tests: { runner: "vitest", status: "failed", passed: 2, failed: 1 },
        },
        now,
      ),
    ).toBeNull();
  });
  it("marks parsed tests edited since on a subsequent edit without changing their timestamp", () => {
    const s: import("@mc/core").MapSnapshot = structuredClone(mapSnapshotFixture);
    s.seats[0].badges.tests = {
      runner: "vitest",
      status: "passed",
      passed: 4,
      failed: 0,
      at: now - 1000,
      editedSince: false,
    };
    const edited = applyDelta(
      s,
      { seq: 1, type: "edit", seat: s.seats[0].seat, file: "src/main.ts", add: 1, rem: 0 },
      now,
    );
    expect(edited?.seats[0].badges.tests).toMatchObject({ editedSince: true, at: now - 1000 });
    expect(s.seats[0].badges.tests?.editedSince).toBe(false);
  });
  it("refetches failures and questions because their delta lacks complete badge data", () => {
    const s = structuredClone(mapSnapshotFixture);
    expect(
      applyDelta(
        s,
        {
          seq: 1,
          type: "call.end",
          seat: s.seats[0].seat,
          files: [],
          resultTok: 0,
          error: true,
          refused: false,
          why: "error",
          tests: null,
        },
        now,
      ),
    ).toBeNull();
    expect(
      applyDelta(
        s,
        { seq: 1, type: "message", from: "GUIDO-1", to: "CAPCOM", kind: "answer", ticket: 7 },
        now,
      ),
    ).toBeNull();
  });
});

it("uses distinct fixture timestamps instead of the seat's state age for badges", () => {
  expect(badgeModels(mapSnapshotFixture.seats[0], 61_550).map((b) => [b.kind, b.age])).toEqual([
    ["questions", "1m ago"],
    ["failures", "1m ago"],
    ["review", "59s ago"],
    ["tests", "1m ago"],
    ["ci", "59s ago"],
  ]);
});

it("refetches waiting metadata on park and when a waiting seat changes state", () => {
  const s = structuredClone(mapSnapshotFixture);
  expect(
    applyDelta(s, { seq: 1, type: "state", seat: "GUIDO-1", state: "parked", since: now }, now),
  ).toBeNull();
  const waiting = s as import("@mc/core").MapSnapshot;
  waiting.seats[0].badges.waiting = {
    kind: "test-lock",
    since: now - 1000,
    reason: "pnpm test",
    stopped: false,
  };
  expect(
    applyDelta(
      waiting,
      { seq: 1, type: "state", seat: "GUIDO-1", state: "running", since: now },
      now,
    ),
  ).toBeNull();
});
