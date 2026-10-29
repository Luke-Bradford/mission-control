import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CrewRow, MAP_RECENT_MS as KEEP_MS, type MapChange, type Run } from "@mc/core";
import { afterEach, describe, expect, it } from "vitest";
import { SeatDiff } from "../src/map/diff.ts";
import type { CallRing } from "../src/map/ring.ts";
import { mapSeats, runChanges, runWork } from "../src/map/seats.ts";
import { Store } from "../src/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

type Edit = { file: string; add: number; rem: number; at: number };
const scope = (modified: MapChange[] = [], edits: Edit[] = []) => ({
  read: [],
  modified,
  touched: Object.fromEntries(edits.map((e) => [e.file, e.at])),
  edits,
  editedAt: 0,
  tests: null,
});
interface RingRun {
  diff?: MapChange[] | null;
  branch?: string | null;
  untracked?: string[] | null;
  modified?: MapChange[];
  edits?: Edit[];
}
/** A ring whose runs have these diffs, checkouts and edits. */
const ringOf = (runs: Record<string, RingRun>) => ({
  diff: (id: string) => runs[id]?.diff ?? null,
  diffBranch: (id: string) => runs[id]?.branch ?? null,
  untracked: (id: string) => runs[id]?.untracked ?? null,
  scope: (id: string) => scope(runs[id]?.modified, runs[id]?.edits),
  calls: () => [],
});
const run = (over: Partial<Run>): Run => ({
  id: "r",
  agentId: "guido-1",
  repoId: "mission-control",
  seq: 1,
  startedAt: 1000,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});
const diff = (file: string, add: number, rem: number): MapChange => ({
  file,
  add,
  rem,
  source: "diff",
});
const churn = (file: string, add: number, rem: number): MapChange => ({
  file,
  add,
  rem,
  source: "churn",
});
const noCommits = { newestRunCommit: () => null };

describe("runChanges", () => {
  it("serves the branch's real diff, not the churn of its Edit and Write calls", () => {
    // a Write counted every line as added; the diff says what the branch really changed
    const ring = ringOf({ r: { diff: [diff("a.ts", 30, 4)], modified: [churn("a.ts", 120, 0)] } });
    expect(runChanges("r", ring, noCommits)).toEqual([diff("a.ts", 30, 4)]);
  });

  it("adds churn only for untracked, unignored files, counted from edits since the last commit", () => {
    const ring = ringOf({
      r: {
        diff: [diff("a.ts", 2, 1)],
        untracked: ["new.ts"],
        edits: [
          { file: "new.ts", add: 4, rem: 0, at: 50 }, // before the last commit
          { file: "new.ts", add: 6, rem: 1, at: 200 },
          { file: "reverted.ts", add: 6, rem: 6, at: 300 }, // tracked, unchanged: not in the diff
          { file: ".env.local", add: 2, rem: 0, at: 300 }, // ignored: not listed as untracked
        ],
      },
    });
    const commit = { newestRunCommit: () => ({ sha: "a".repeat(40), at: 100 }) };
    expect(runChanges("r", ring, commit)).toEqual([diff("a.ts", 2, 1), churn("new.ts", 6, 1)]);
    // with no commit recorded, an untracked file's every edit is uncommitted
    expect(runChanges("r", ring, noCommits)).toEqual([diff("a.ts", 2, 1), churn("new.ts", 10, 1)]);
  });

  it("falls back to labelled churn while the diff is unread or unavailable", () => {
    const ring = ringOf({ r: { modified: [churn("a.ts", 5, 1)] } });
    expect(runChanges("r", ring, noCommits)).toEqual([churn("a.ts", 5, 1)]);
  });
});

describe("runWork", () => {
  const old = run({ id: "old", branch: "feature/698-guard", ticket: "mission-control#698" });
  const later = run({ id: "later", branch: "feature/747-models", ticket: "mission-control#747" });
  const store = {
    ...noCommits,
    latestRunOnBranch: (_repo: string, branch: string) => (branch === later.branch ? later : null),
  };

  it("credits a worktree that moved on to a later run's branch to that run, with its edits", () => {
    const ring = ringOf({
      old: {
        diff: [diff("a.ts", 175, 29)],
        branch: later.branch,
        untracked: ["new.ts", "stale.ts"],
      },
      later: { edits: [{ file: "new.ts", add: 3, rem: 0, at: 500 }] },
    });
    // the old run's own edits (stale.ts) are not the later branch's
    const withOld = {
      ...ring,
      scope: (id: string) =>
        id === "old" ? scope([], [{ file: "stale.ts", add: 9, rem: 0, at: 900 }]) : ring.scope(id),
    };
    const work = runWork(old, withOld, store);
    expect(work.branch).toBe("feature/747-models");
    expect(work.owner?.ticket).toBe("mission-control#747");
    expect(work.changes).toEqual([diff("a.ts", 175, 29), churn("new.ts", 3, 0)]);
  });

  it("credits nothing for a branch no run owns, a detached checkout or a review run", () => {
    const onMain = runWork(
      old,
      ringOf({ old: { diff: [diff("a.ts", 1, 0)], branch: "main" } }),
      store,
    );
    expect(onMain).toEqual({ branch: "main", owner: null, changes: [] });
    const detached = runWork(
      old,
      ringOf({ old: { diff: [diff("a.ts", 1, 0)], branch: null } }),
      store,
    );
    expect(detached.changes).toEqual([]);
    // a review's scratch checkout is detached at the developer's PR head: never the reviewer's work
    const review = run({ id: "rv", reviewId: 3, branch: "feature/747-models", ticket: "x#747" });
    expect(
      runWork(review, ringOf({ rv: { diff: [diff("a.ts", 175, 29)], branch: null } }), store),
    ).toEqual({ branch: null, owner: review, changes: [] });
    // before the diff is read, a run is its own branch's owner
    const unread = runWork(old, ringOf({}), store);
    expect(unread.branch).toBe("feature/698-guard");
    expect(unread.owner).toBe(old);
  });
});

describe("mapSeats", () => {
  const row = (over: Partial<CrewRow>): CrewRow =>
    ({
      id: "guido-1",
      kind: "crew",
      role: "GUIDO",
      area: [],
      repoId: "mission-control",
      hudState: "idle",
      stateSince: 0,
      ticket: null,
      ticketTitle: null,
      run: null,
      loop: null,
      ...over,
    }) as unknown as CrewRow;
  const storeOf = (runs: Run[], aside: Run[] = [], prs: { branch: string; state: string }[] = []) =>
    ({
      seatSession: () => null,
      run: (id: string) => runs.find((r) => r.id === id) ?? null,
      mapAsideRuns: () => aside,
      pullRequests: () => prs,
      runsOnTicket: () => [],
      reviewsOfRun: () => [],
      findingsOf: () => [],
      openQuestions: () => [],
      guardHits: () => [],
      newestRunCommit: () => null,
      latestRunOnBranch: (_repo: string, branch: string) =>
        [...runs, ...aside].find((r) => r.branch === branch && r.reviewId == null) ?? null,
    }) as unknown as Store;
  const lock = { holder: null, waiting: [] } as never;
  const seatsOf = (rows: CrewRow[], store: Store, ring: ReturnType<typeof ringOf>) =>
    mapSeats(rows, store, ring as unknown as CallRing, lock, 1000).seats;

  it("carries the seat's configured area globs, a copy and empty when it has none", () => {
    const area = ["apps/web/**", "docs/**"];
    const [seat, free] = seatsOf(
      [row({ area }), row({ id: "retro-1", role: "RETRO", area: [] })],
      storeOf([]),
      ringOf({}),
    );
    expect(seat?.area).toEqual(area);
    expect(seat?.area).not.toBe(area);
    expect(free?.area).toEqual([]);
  });

  it("credits a reviewer nothing from the developer's PR its scratch checkout holds", () => {
    const review = run({
      id: "rv",
      agentId: "retro-1",
      reviewId: 3,
      branch: "feature/747-models",
      ticket: "mission-control#747",
    });
    const [seat] = seatsOf(
      [row({ id: "retro-1", role: "RETRO", run: { id: "rv" } as CrewRow["run"] })],
      storeOf([review]),
      ringOf({ rv: { diff: [diff("a.ts", 175, 29)], branch: null } }),
    );
    expect(seat?.scope.modified).toEqual([]);
    expect(seat?.branches).toEqual([]);
    expect(seat?.changedOn).toEqual([]);
  });

  describe("a seat's recent path", () => {
    const call = (id: string, file: string, end: number | null, tool = "Read", since?: number) => ({
      id,
      runId: "r",
      repoId: "mission-control",
      tool,
      detail: file,
      files: [file],
      since: since ?? (end ?? 0) - 100,
      end,
      resultSize: 0,
      resultTok: 0,
      error: false,
      refused: false,
      why: null,
      tests: null,
      churn: [],
    });
    const pathAt = (calls: ReturnType<typeof call>[], now: number, live = false) =>
      mapSeats(
        [row({ run: { id: "r" } as CrewRow["run"] })],
        {
          ...storeOf([run({ id: "r", status: live ? "running" : "ok", endedAt: 5000 })]),
          seatSession: () => (live ? { state: "running" } : null),
        } as unknown as Store,
        { ...ringOf({ r: {} }), calls: () => calls } as unknown as CallRing,
        lock,
        now,
      ).seats[0]?.recent;

    it("keeps an ended run's path while the ring keeps its calls, and drops it after", () => {
      const calls = [call("1", "a.ts", 2000), call("2", "b.ts", 4000)];
      expect(pathAt(calls, 10_000)).toEqual([
        { file: "a.ts", at: 2000 },
        { file: "b.ts", at: 4000 },
      ]);
      // fifteen minutes on, the first call has aged out, then the second
      expect(pathAt(calls, 2000 + KEEP_MS + 1)).toEqual([{ file: "b.ts", at: 4000 }]);
      expect(pathAt(calls, 4000 + KEEP_MS + 1)).toEqual([]);
    });

    it("ages out a call the ended run cut off from its start; a live one's stays", () => {
      const calls = [call("1", "a.ts", null, "Read", 3000)];
      expect(pathAt(calls, 10_000)).toEqual([{ file: "a.ts", at: 3000 }]);
      expect(pathAt(calls, 3000 + KEEP_MS + 1)).toEqual([]);
      expect(pathAt(calls, 3000 + KEEP_MS + 1, true)).toEqual([{ file: "a.ts", at: 3000 }]);
    });

    it("lists a run of accesses to one file once, at its latest, and leaves out name-only listings", () => {
      const calls = [
        call("1", "a.ts", 1000),
        call("2", "a.ts", 1100),
        call("3", "b.ts", 1200),
        call("4", "c.ts", 1300, "Glob"),
        call("5", "a.ts", 1400),
      ];
      expect(pathAt(calls, 2000)).toEqual([
        { file: "a.ts", at: 1100 },
        { file: "b.ts", at: 1200 },
        { file: "a.ts", at: 1400 },
      ]);
    });

    it("keeps up to 48 accesses, so the map's twelve-node path is never cut short by the hub", () => {
      const calls = Array.from({ length: 60 }, (_, i) =>
        call(`${i}`, `f${i % 2 ? i : 0}.ts`, 1000 + i),
      );
      const path = pathAt(calls, 2000) ?? [];
      expect(path).toHaveLength(48);
      expect(path.at(-1)).toEqual({ file: "f59.ts", at: 1059 });
    });
  });

  it("merges a current and a set-aside branch, dedupes a shared checkout, relabels mixed churn", () => {
    const current = run({ id: "now", branch: "feature/800-new", ticket: "mission-control#800" });
    const aside = run({ id: "aside", branch: "feature/747-old", ticket: "mission-control#747" });
    const twin = run({ id: "twin", branch: "feature/747-old", ticket: "mission-control#747" });
    const merged = run({ id: "gone", branch: "feature/700-merged", ticket: "mission-control#700" });
    const [seat] = seatsOf(
      [row({ ticket: "mission-control#800", run: { id: "now" } as CrewRow["run"] })],
      storeOf(
        [current],
        [aside, twin, merged],
        [{ branch: "feature/700-merged", state: "merged" }],
      ),
      ringOf({
        // the current run has nothing yet; its ticket still leads the line
        now: { diff: [], branch: "feature/800-new" },
        aside: { diff: [diff("a.ts", 10, 2)], branch: "feature/747-old" },
        twin: { diff: [diff("a.ts", 10, 2)], branch: "feature/747-old" },
        gone: { diff: [diff("z.ts", 9, 9)], branch: "feature/700-merged" },
      }),
    );
    // the current run (#800) has nothing changed yet: the line leads with the work that has
    expect(seat?.ticket).toBe(747);
    expect(seat?.nowTicket).toBe(800);
    expect(seat?.branches).toEqual(["feature/800-new", "feature/747-old"]);
    expect(seat?.changedOn).toEqual(["feature/747-old"]);
    expect(seat?.tickets).toEqual({ "feature/800-new": 800, "feature/747-old": 747 });
    expect(seat?.scope.modified).toEqual([diff("a.ts", 10, 2)]);

    const [mixed] = seatsOf(
      [row({ run: { id: "now" } as CrewRow["run"] })],
      storeOf([current], [aside]),
      ringOf({
        now: { diff: [diff("a.ts", 1, 1)], branch: "feature/800-new" },
        aside: { modified: [churn("a.ts", 3, 0)] },
      }),
    );
    expect(mixed?.scope.modified).toEqual([{ file: "a.ts", add: 4, rem: 1, source: "churn" }]);
    // a current run with changes of its own leads, as ever
    expect(mixed?.ticket).toBe(800);
    expect(mixed?.nowTicket).toBeNull();
  });

  it("points a seat's question badge at the FLIGHT node when a FLIGHT seat exists (#758)", () => {
    const current = run({ id: "now", ticket: "mission-control#42" });
    const store = {
      ...storeOf([current]),
      openQuestions: () => [
        { id: 7, agentId: "guido-1", runId: "now", text: "Which lane?", at: 900, passedAt: null },
      ],
    } as unknown as Store;
    const ring = ringOf({ now: { diff: [], branch: null } }) as unknown as CallRing;
    const questions = (flightId?: string) =>
      mapSeats([row({ run: { id: "now" } as CrewRow["run"] })], store, ring, lock, 1000, flightId)
        .seats[0]?.badges.questions;
    expect(questions("flight-1")).toEqual([
      { id: 7, from: "guido-1", to: "FLIGHT", ticket: 42, since: 900 },
    ]);
    expect(questions()?.[0]?.to).toBe("CAPCOM");
  });
});

describe("SeatDiff", () => {
  it("records the branch the worktree had checked out, and none when detached", async () => {
    const cwd = temp("map-seat-diff-");
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args]);
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture");
    writeFileSync(join(cwd, "file.ts"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git("checkout", "-qb", "feature/9-x");
    writeFileSync(join(cwd, "file.ts"), "edited\n");
    writeFileSync(join(cwd, "new.ts"), "new\n");
    writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(cwd, "ignored.txt"), "x\n");
    const seat = new SeatDiff();
    const settle = async () => {
      for (let i = 0; i < 100 && seat.changes() === null; i++)
        await new Promise((r) => setTimeout(r, 20));
    };
    seat.poll(cwd, "");
    await settle();
    expect(seat.branch()).toBe("feature/9-x");
    expect(seat.untracked()?.sort()).toEqual([".gitignore", "new.ts"]);
    git("checkout", "-q", "--detach");
    const detached = new SeatDiff();
    detached.poll(cwd, "");
    for (let i = 0; i < 100 && detached.changes() === null; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(detached.changes()).not.toBeNull();
    expect(detached.branch()).toBeNull();
  });
});

describe("Store.latestRunOnBranch", () => {
  it("returns the newest non-review run on the branch, this seat's own first", () => {
    const store = new Store(join(temp("map-store-"), "mc.sqlite"));
    const at = (id: string, agentId: string, startedAt: number, over: Partial<Run> = {}) =>
      store.upsertRun(run({ id, agentId, startedAt, branch: "feature/747-models", ...over }));
    at("older", "guido-1", 1000);
    at("newer", "guido-1", 2000);
    at("other-seat", "guido-2", 3000);
    at("review", "retro-1", 4000, { reviewId: 1 });
    expect(store.latestRunOnBranch("mission-control", "feature/747-models")?.id).toBe("other-seat");
    expect(store.latestRunOnBranch("mission-control", "feature/747-models", "guido-1")?.id).toBe(
      "newer",
    );
    expect(store.latestRunOnBranch("mission-control", "feature/nope")).toBeNull();
  });
});
