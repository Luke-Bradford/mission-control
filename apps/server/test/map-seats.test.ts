import type { MapChange } from "@mc/core";
import { expect, it } from "vitest";
import { runChanges, runWork } from "../src/map/seats.ts";

const scope = (modified: MapChange[], touched: Record<string, number>) => ({
  read: [],
  modified,
  touched,
  editedAt: 0,
  tests: null,
});
const ring = (
  diff: MapChange[] | null,
  modified: MapChange[],
  touched: Record<string, number>,
) => ({
  diff: () => diff,
  scope: () => scope(modified, touched),
});
const commitAt = (at: number | null) => ({
  newestRunCommit: () => (at === null ? null : { sha: "a".repeat(40), at }),
});

it("serves the branch's real diff, not the churn of its Edit and Write calls", () => {
  // a Write counted every line as added; the diff says what the branch really changed
  const churn: MapChange[] = [{ file: "a.ts", add: 120, rem: 0, source: "churn" }];
  const diff: MapChange[] = [{ file: "a.ts", add: 30, rem: 4, source: "diff" }];
  expect(runChanges("r", ring(diff, churn, { "a.ts": 50 }), commitAt(100))).toEqual(diff);
});

it("adds churn only for files edited since the last commit that the diff doesn't show yet", () => {
  const churn: MapChange[] = [
    { file: "new.ts", add: 10, rem: 0, source: "churn" },
    { file: "reverted.ts", add: 3, rem: 3, source: "churn" },
    { file: "a.ts", add: 9, rem: 9, source: "churn" },
  ];
  const diff: MapChange[] = [{ file: "a.ts", add: 2, rem: 1, source: "diff" }];
  expect(
    runChanges(
      "r",
      ring(diff, churn, { "new.ts": 200, "reverted.ts": 50, "a.ts": 300 }),
      commitAt(100),
    ),
  ).toEqual([
    { file: "a.ts", add: 2, rem: 1, source: "diff" },
    { file: "new.ts", add: 10, rem: 0, source: "churn" },
  ]);
});

it("falls back to labelled churn while the diff is unread or unavailable", () => {
  const churn: MapChange[] = [{ file: "a.ts", add: 5, rem: 1, source: "churn" }];
  expect(runChanges("r", ring(null, churn, { "a.ts": 1 }), commitAt(null))).toEqual(churn);
});

it("credits a worktree that moved on to a later run's branch to that run: its ticket, edits and commits", () => {
  const run = (id: string, branch: string, ticket: string) =>
    ({ id, repoId: "mission-control", branch, ticket }) as unknown as import("@mc/core").Run;
  const old = run("old", "feature/698-guard", "mission-control#698");
  const later = run("later", "feature/747-models", "mission-control#747");
  const diff: MapChange[] = [{ file: "a.ts", add: 175, rem: 29, source: "diff" }];
  const scopes: Record<string, ReturnType<typeof scope>> = {
    old: scope([{ file: "stale.ts", add: 9, rem: 0, source: "churn" }], { "stale.ts": 999 }),
    later: scope([{ file: "new.ts", add: 3, rem: 0, source: "churn" }], { "new.ts": 500 }),
  };
  const ring = {
    diff: () => diff,
    diffBranch: () => "feature/747-models",
    scope: (id: string) => scopes[id] ?? scope([], {}),
  };
  const commits: string[] = [];
  const store = {
    latestRunOnBranch: (_repo: string, branch: string) => (branch === later.branch ? later : null),
    newestRunCommit: (id: string) => {
      commits.push(id);
      return { sha: "b".repeat(40), at: 100 };
    },
  };
  const work = runWork(old, ring, store);
  expect(work.branch).toBe("feature/747-models");
  expect(work.owner.ticket).toBe("mission-control#747");
  // the later run's own edit since its last commit, never the old run's stale churn
  expect(work.changes).toEqual([...diff, { file: "new.ts", add: 3, rem: 0, source: "churn" }]);
  expect(commits).toEqual(["later"]);
  // before the diff is read, a run is its own branch's owner
  const unread = runWork(old, { ...ring, diff: () => null, diffBranch: () => null }, store);
  expect(unread.branch).toBe("feature/698-guard");
  expect(unread.owner).toBe(old);
});
