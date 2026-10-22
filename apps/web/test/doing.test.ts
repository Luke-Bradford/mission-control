import {
  type CrewRow,
  LAST_TEXT_MAX,
  LIVE_DETAIL_MAX,
  type RunDigest,
  type RunPr,
  type RunView,
} from "@mc/core";
import { describe, expect, it } from "vitest";
import { doingLine, reviewParts, runPrs, seatActivity, seatReview } from "../src/crew.ts";
import { crewRow, NOW, prView, run, seatRow } from "./fixtures.ts";

const TZ = "Europe/London";
const at = NOW;

const dg = (over: Partial<RunDigest> = {}): RunDigest => ({
  toolCalls: 1,
  turns: 1,
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
const running = (digest: RunDigest | null) => crewRow({ hudState: "running", digest });
const idle = (digest: RunDigest | null, over: Partial<CrewRow> = {}) =>
  crewRow({ hudState: "idle", digest, ...over });

describe("what a seat is doing", () => {
  it("a running seat with a live tool says the tool, what it touches and for how long", () => {
    const live = { name: "Edit", since: at - 12_000, detail: "apps/server/src/backfill.ts" };
    expect(doingLine(running(dg({ liveTool: live })), at, TZ)).toBe(
      "Edit 0:12 · apps/server/src/backfill.ts",
    );
  });

  it("a live tool with no detail (or a null one) keeps today's line", () => {
    const bare = { name: "Bash", since: at - 65_000 };
    expect(doingLine(running(dg({ liveTool: bare })), at, TZ)).toBe("run #12 · Bash 1:05");
    expect(doingLine(running(dg({ liveTool: { ...bare, detail: null } })), at, TZ)).toBe(
      "run #12 · Bash 1:05",
    );
  });

  it("a long detail is cut with an ellipsis at the server's own limit", () => {
    const live = { name: "Bash", since: at, detail: "x".repeat(300) };
    expect(doingLine(running(dg({ liveTool: live })), at, TZ)).toBe(
      `Bash 0:00 · ${"x".repeat(LIVE_DETAIL_MAX - 1)}…`,
    );
  });

  it("a running seat between tools says its last text, cut when long", () => {
    expect(doingLine(running(dg({ lastText: "I'm editing supervisor.ts now…" })), at, TZ)).toBe(
      "I'm editing supervisor.ts now…",
    );
    expect(doingLine(running(dg({ lastText: "y".repeat(500) })), at, TZ)).toBe(
      `${"y".repeat(LAST_TEXT_MAX - 1)}…`,
    );
  });

  it("a live tool wins over the last text; a missing or blank text falls back to the run", () => {
    const live = { name: "Edit", since: at, detail: "a.ts" };
    expect(doingLine(running(dg({ liveTool: live, lastText: "Hello." })), at, TZ)).toBe(
      "Edit 0:00 · a.ts",
    );
    expect(doingLine(running(dg({ lastText: null })), at, TZ)).toBe("run #12");
    expect(doingLine(running(dg({ lastText: "  " })), at, TZ)).toBe("run #12");
    expect(doingLine(running(dg()), at, TZ)).toBe("run #12");
    expect(doingLine(running(null), at, TZ)).toBe("run #12");
  });

  it("an idle seat whose run is open says its last text; with no open run it does not", () => {
    expect(doingLine(idle(dg({ lastText: "Pushed the fix." })), at, TZ)).toBe("Pushed the fix.");
    const ended = { ...(crewRow().run as NonNullable<CrewRow["run"]>), status: "ok" as const };
    const closed = idle(dg({ lastText: "Pushed the fix." }), { run: { ...ended, endedAt: at } });
    expect(doingLine(closed, at, TZ)).toMatch(/^Idle since/);
    expect(doingLine(idle(dg()), at, TZ)).toMatch(/^Idle since/);
    expect(seatActivity(closed, at)).toBeNull();
  });

  it("an idle seat's note still says more than its last text", () => {
    expect(doingLine(idle(dg({ lastText: "Done." }), { note: "Waiting for CI" }), at, TZ)).toBe(
      "Waiting for CI",
    );
  });
});

describe("a seat's PR in its doing line", () => {
  // As live data is: a crew run's own `prs` is empty, and the PR is only in the repo's PRs.
  const seat = (state: "draft" | "open" | "approved" | "changes", over: Partial<CrewRow> = {}) =>
    seatRow({ hudState: "idle", review: { prNumber: 77, state }, prs: [], ...over });

  it.each([
    ["draft", "Draft PR #77 · Cache quotes"],
    ["open", "In review · PR #77 · Cache quotes"],
    ["approved", "In review · PR #77 · Cache quotes"],
    ["changes", "Changes requested · PR #77 · Cache quotes"],
  ] as const)("a %s PR says its state first, then its title from the repo's PRs", (s, line) => {
    expect(doingLine(seat(s), at, TZ, [prView()])).toBe(line);
    expect(seatReview(seat(s), at, [prView()])?.tail).toBe("Cache quotes");
  });

  it("without a title, or without the PR, it stays plain", () => {
    expect(doingLine(seat("draft"), at, TZ, [prView({ title: "" })])).toBe("Draft PR #77");
    expect(doingLine(seat("open"), at, TZ, [])).toBe("In review · PR #77");
    expect(doingLine(seat("open"), at, TZ)).toBe("In review · PR #77");
    expect(doingLine(seat("open"), at, TZ, [prView({ number: 5 })])).toBe("In review · PR #77");
  });

  it("without a title, it shows the seat's last words with the PR", () => {
    const row = seat("draft", { digest: dg({ lastText: "I pushed the review fixes…" }) });
    expect(doingLine(row, at, TZ, [prView({ title: "" })])).toBe(
      "Draft PR #77 · I pushed the review fixes…",
    );
    // a title is the better tail
    expect(doingLine(row, at, TZ, [prView()])).toBe("Draft PR #77 · Cache quotes");
  });

  it("while the repo's PRs are loading it is the bare PR line, never the last words", () => {
    const row = seat("draft", { digest: dg({ lastText: "I pushed the review fixes…" }) });
    expect(doingLine(row, at, TZ, undefined)).toBe("Draft PR #77");
    expect(seatReview(row, at, undefined)?.tail).toBeNull();
  });

  it("the text is the parts DoingLine renders, joined", () => {
    const review = seatReview(seat("open"), at, [prView()]);
    expect(review && reviewParts(review)).toEqual({
      before: "In review · ",
      pr: "PR #77",
      after: " · Cache quotes",
    });
  });
});

describe("a running seat's background task", () => {
  const task = { taskId: "t1", description: "Run the full suite", type: "shell" };

  it("comes ahead of the last text in seatActivity, as in the doing line", () => {
    const row = running(dg({ background: [task], lastText: "Starting the suite." }));
    expect(seatActivity(row, at)).toBe("background: Run the full suite");
    expect(seatActivity(idle(dg({ background: [task], lastText: "Done." })), at)).toBe("Done.");
  });
});

describe("a run's PRs", () => {
  const rv = (over: Partial<RunView> = {}): RunView => ({
    ...run({ branch: "feature/77-cache" }),
    prs: [],
    ...over,
  });

  it("finds the PR on the run's branch in the repo's PRs, as a run's own list is empty", () => {
    const found = runPrs(rv(), [
      prView({ branch: "feature/77-cache" }),
      prView({ number: 9, branch: "other" }),
    ]);
    expect(found.map((p) => [p.number, p.title, p.state])).toEqual([[77, "Cache quotes", "open"]]);
  });

  it("keeps the PRs a run recorded, and does not repeat one", () => {
    const own = { ...runPrs(rv(), [prView({ branch: "feature/77-cache" })])[0] } as RunPr;
    expect(runPrs(rv({ prs: [own] }), [prView({ branch: "feature/77-cache" })])).toHaveLength(1);
    expect(runPrs(rv({ branch: null }), [prView({ branch: "feature/77-cache" })])).toEqual([]);
    expect(runPrs(rv(), undefined)).toEqual([]);
  });
});

describe("the order of a running seat's line", () => {
  const live = { name: "Bash", since: at - 65_000 };

  it("a background task shows ahead of the last text", () => {
    const task = { taskId: "t1", type: "bash", description: "Run the full suite" };
    expect(
      doingLine(running(dg({ background: [task], lastText: "Starting the suite." })), at, TZ),
    ).toBe("run #12 · background: Run the full suite");
  });

  it("a live tool with no detail keeps its line even with last text", () => {
    expect(doingLine(running(dg({ liveTool: live, lastText: "Hello." })), at, TZ)).toBe(
      "run #12 · Bash 1:05",
    );
  });
});
