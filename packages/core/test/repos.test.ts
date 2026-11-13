import { describe, expect, it } from "vitest";
import {
  COLUMN_STATE,
  FLOW_BATCH,
  FLOW_LONG_TIMELINES,
  FLOW_TIMELINE_MAX_PAGES,
  GITHUB_POINTS_PER_HOUR,
  githubBudget,
  HUD_COLUMNS,
  missingColumns,
  optionForColumn,
  PR_MAX_PAGES,
  proposeStatusMap,
  statusColumns,
} from "../src/index.ts";

const SHOP_APP = {
  Todo: "planned",
  "In Progress": "in progress",
  "In Review": "review",
  Blocked: "blocked",
  Done: "done",
} as const;

describe("COLUMN_STATE", () => {
  it("gives every HUD column a state", () => {
    expect(Object.keys(COLUMN_STATE).sort()).toEqual([...HUD_COLUMNS].sort());
    expect(COLUMN_STATE["Ready for QA"]).toBe("review");
    expect(COLUMN_STATE.Refinement).toBe("planned");
  });
});

describe("optionForColumn", () => {
  it("takes the option named for the column when its state matches", () => {
    expect(optionForColumn(Object.keys(SHOP_APP), SHOP_APP, "In review")).toBe("In Review");
    expect(optionForColumn(Object.keys(SHOP_APP), SHOP_APP, "In progress")).toBe("In Progress");
    expect(optionForColumn(Object.keys(SHOP_APP), SHOP_APP, "Blocked")).toBe("Blocked");
  });

  it("prefers the option named In review over another review option", () => {
    const map = { "Ready for QA": "review", "In review": "review" } as const;
    expect(optionForColumn(["Ready for QA", "In review"], map, "In review")).toBe("In review");
  });

  it("ignores a same-named option whose mapped state is another", () => {
    const map = { "In review": "planned", Reviewing: "review" } as const;
    expect(optionForColumn(["In review", "Reviewing"], map, "In review")).toBe("Reviewing");
  });

  it("falls back to the first option with the state, skipping another column's name", () => {
    const map = { "Ready for QA": "review", Checking: "review", Blocking: "blocked" } as const;
    expect(optionForColumn(["Ready for QA", "Checking"], map, "In review")).toBe("Checking");
    expect(optionForColumn(["Blocking"], map, "Blocked")).toBe("Blocking");
  });

  it("is null when no option has the state, or an option is unmapped", () => {
    expect(optionForColumn(["Todo", "Done"], { Todo: "planned", Done: "done" }, "In review")).toBe(
      null,
    );
    expect(optionForColumn(["Mystery"], {}, "In progress")).toBe(null);
  });
});

describe("proposeStatusMap", () => {
  it("matches shop-app's configured map", () => {
    expect(proposeStatusMap(["Todo", "In Progress", "In Review", "Blocked", "Done"])).toEqual(
      SHOP_APP,
    );
  });

  it("matches site-builder's options, Blocking included", () => {
    expect(proposeStatusMap(["Backlog", "Ready", "In progress", "Blocking", "Done"])).toEqual({
      Backlog: "planned",
      Ready: "planned",
      "In progress": "in progress",
      Blocking: "blocked",
      Done: "done",
    });
  });

  it("reads other wordings by pattern, and a column name case-insensitively", () => {
    expect(proposeStatusMap([" ready for qa ", "Shipped", "Doing", "Whatever"])).toEqual({
      " ready for qa ": "review",
      Shipped: "done",
      Doing: "in progress",
      Whatever: "planned",
    });
  });
});

describe("statusColumns and missingColumns", () => {
  it("places each status by the column rules", () => {
    expect(statusColumns({ ...SHOP_APP })).toEqual([
      { status: "Todo", column: "Ready" },
      { status: "In Progress", column: "In progress" },
      { status: "In Review", column: "In review" },
      { status: "Blocked", column: "Blocked" },
      { status: "Done", column: "Done" },
    ]);
  });

  it("lists columns nothing reaches, never Backlog", () => {
    expect(missingColumns({ ...SHOP_APP })).toEqual(["Refinement", "Ready for QA"]);
    expect(missingColumns({})).toEqual(HUD_COLUMNS.filter((c) => c !== "Backlog"));
  });
});

describe("githubBudget", () => {
  it("counts a board poll, the PR sweep and the flow batches", () => {
    expect(GITHUB_POINTS_PER_HOUR).toBe(5000);
    expect(PR_MAX_PAGES).toBe(10);
    expect(FLOW_BATCH).toBe(20);
    expect(FLOW_TIMELINE_MAX_PAGES).toBe(5);
    // poll: ceil(250/100)=3 pages + 3 markers + 1 label + 1 milestones + 1 PR page = 9; 60 polls/h.
    // flow: 2 * ceil(250/20) = 26 batch calls, plus 4 more timeline pages for each of the 5
    // issues allowed a long timeline.
    expect(FLOW_LONG_TIMELINES).toBe(5);
    expect(githubBudget({ items: 250, needsYouLabels: 1, githubSeconds: 60 })).toEqual({
      boardPerHour: 540,
      sweepPerHour: 10,
      flowPerHour: 46,
      totalPerHour: 596,
    });
    // Fewer items than the allowance: no more long issues than items.
    expect(githubBudget({ items: 2, needsYouLabels: 1, githubSeconds: 60 }).flowPerHour).toBe(
      2 + 2 * 4,
    );
  });
});
