import { type MapSeat, type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { describe, expect, it } from "vitest";
import { agentCard, badgeModels, isStuck, recentFailures } from "../src/map/cards.ts";
import { applyDelta } from "../src/map/model.ts";

const now = 2_000_000;
function seat(): MapSeat {
  const s: MapSeat = structuredClone(mapSnapshotFixture.seats[0]);
  s.since = now;
  s.calls = [];
  s.badges = { questions: [], failures: [], review: null, tests: null, ci: null, waiting: null };
  return s;
}

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
  it.each(["test-lock", "parked"] as const)(
    "requires a %s wait older than fifteen minutes",
    (kind) => {
      const s = seat();
      s.badges.waiting = { kind, since: now - 900_000, reason: "waiting" };
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
    s.badges.waiting = { kind: "test-lock", reason: "pnpm test", since: now - 120_000 };
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
      docked: false,
    });
    // The card and the orb label read the same state.
    expect(agentCard(s, now).state).toBe("reading src/main.ts 1s · +1 calls");
    s.calls = [];
    expect(agentCard(s, now).state).toBe("thinking");
    s.state = "idle";
    s.since = now - 60_000;
    expect(agentCard(s, now)).toMatchObject({ docked: true, state: "idle 1m" });
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
  waiting.seats[0].badges.waiting = { kind: "test-lock", since: now - 1000, reason: "pnpm test" };
  expect(
    applyDelta(
      waiting,
      { seq: 1, type: "state", seat: "GUIDO-1", state: "running", since: now },
      now,
    ),
  ).toBeNull();
});
