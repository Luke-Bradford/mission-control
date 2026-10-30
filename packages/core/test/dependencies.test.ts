import { describe, expect, it } from "vitest";
import {
  afterPrs,
  bodyDependencies,
  DEFAULT_REPO_RULES,
  eligibleToStart,
  prStageText,
  ticketWaits,
  undeclaredPrDependency,
  type WaitPr,
  waitChains,
  waitsOnText,
} from "../src/index.ts";

const pr = (over: Partial<WaitPr> & { number: number }): WaitPr => ({
  state: "open",
  branch: `feature/${over.number}`,
  base: "main",
  ticket: null,
  isDraft: false,
  ci: "pending",
  review: null,
  ...over,
});

const card = (
  issueNumber: number,
  over: {
    blockedBy?: { ref: string; closed: boolean }[];
    after?: { issues: number[]; prs: number[] };
  } = {},
) => ({ issueNumber, blockedBy: over.blockedBy ?? [], after: over.after });

describe("afterPrs", () => {
  it("reads the PRs on After PR lines, once each", () => {
    expect(afterPrs("After PR 1033\n- after PRs #1034, 1033 and 7\nSee PR 9\n")).toEqual([
      1033, 1034, 7,
    ]);
    expect(afterPrs("Fixes the thing after PR 12 lands")).toEqual([]);
  });
});

describe("bodyDependencies", () => {
  it("joins Depends on issues and After PR PRs", () => {
    expect(bodyDependencies("Depends on #1015\nAfter PR 1033\n")).toEqual({
      issues: [1015],
      prs: [1033],
    });
  });
});

describe("prStageText", () => {
  it("says where a PR is in plain words", () => {
    expect(prStageText(pr({ number: 1, isDraft: true }))).toBe("PR 1 is a draft");
    expect(prStageText(pr({ number: 1 }))).toBe("PR 1 in CI");
    expect(prStageText(pr({ number: 1, ci: "failing" }))).toBe("PR 1 failing CI");
    expect(prStageText(pr({ number: 1, ci: "passing" }))).toBe("PR 1 in review");
    expect(prStageText(pr({ number: 1, ci: "passing", review: "approved" }))).toBe(
      "PR 1 ready to merge",
    );
  });
});

describe("ticketWaits", () => {
  const board = [
    { issueNumber: 1015, closed: false },
    { issueNumber: 1016, closed: true },
    { issueNumber: 1139, closed: false },
  ];
  const prs = [pr({ number: 1033, ticket: "mc#1015", closingIssues: [1015] })];

  it("waits on an open Depends on issue and names its PR", () => {
    const waits = ticketWaits({
      repoId: "mc",
      card: card(1139, { after: { issues: [1015], prs: [] } }),
      board,
      prs,
    });
    expect(waits).toEqual([{ ref: "mc#1015", text: "mc#1015 (PR 1033 in CI)" }]);
  });

  it("does not wait on a closed dependency", () => {
    expect(
      ticketWaits({
        repoId: "mc",
        card: card(1139, {
          after: { issues: [1016], prs: [] },
          blockedBy: [{ ref: "mc#1016", closed: true }],
        }),
        board,
        prs,
      }),
    ).toEqual([]);
  });

  it("waits on an open GitHub blocked-by link, once with a body line for the same issue", () => {
    const waits = ticketWaits({
      repoId: "mc",
      card: card(1139, {
        blockedBy: [{ ref: "mc#1015", closed: false }],
        after: { issues: [1015], prs: [] },
      }),
      board,
      prs,
    });
    expect(waits.map((w) => w.ref)).toEqual(["mc#1015"]);
  });

  it("waits on an After PR line while that PR is open, not once it merged", () => {
    const open = ticketWaits({
      repoId: "mc",
      card: card(1139, { after: { issues: [], prs: [1033] } }),
      board,
      prs,
    });
    expect(open).toEqual([{ ref: "PR 1033", text: "PR 1033 in CI" }]);
    const merged = ticketWaits({
      repoId: "mc",
      card: card(1139, { after: { issues: [], prs: [1033] } }),
      board,
      prs: [pr({ number: 1033, state: "merged" })],
    });
    expect(merged).toEqual([]);
  });

  it("waits on the PR whose branch its own PR is based on", () => {
    const stacked = [
      pr({ number: 1033, branch: "feature/1015-a", ticket: "mc#1015", closingIssues: [1015] }),
      pr({
        number: 1034,
        branch: "feature/1139-b",
        base: "feature/1015-a",
        ticket: "mc#1139",
        closingIssues: [1139],
      }),
    ];
    expect(ticketWaits({ repoId: "mc", card: card(1139), board, prs: stacked })).toEqual([
      { ref: "PR 1033", text: "PR 1033 in CI" },
    ]);
    expect(ticketWaits({ repoId: "mc", card: card(1015), board, prs: stacked })).toEqual([]);
  });
});

describe("waitChains", () => {
  it("lists each waiting ticket with its chain down to the root", () => {
    const cards = [
      card(3, { after: { issues: [2], prs: [] } }),
      card(2, { after: { issues: [1], prs: [] } }),
      card(1),
    ];
    const board = cards.map((c) => ({ issueNumber: c.issueNumber, closed: false }));
    const chains = waitChains({ repoId: "mc", cards, board, prs: [] });
    expect(chains.map((c) => [c.ref, c.chain])).toEqual([
      ["mc#2", ["mc#2", "mc#1"]],
      ["mc#3", ["mc#3", "mc#2", "mc#1"]],
    ]);
  });

  it("stops at a cycle", () => {
    const cards = [
      card(1, { after: { issues: [2], prs: [] } }),
      card(2, { after: { issues: [1], prs: [] } }),
    ];
    const board = cards.map((c) => ({ issueNumber: c.issueNumber, closed: false }));
    const chains = waitChains({ repoId: "mc", cards, board, prs: [] });
    expect(chains.every((c) => c.chain.length <= 3)).toBe(true);
  });
});

describe("eligibleToStart with waits", () => {
  const base = {
    repoId: "mc",
    issue: 1139,
    card: {
      labels: ["area:server"],
      assignees: [],
      blockedBy: [],
      size: "M",
      status: "Ready",
      state: "planned" as const,
      closed: false,
    },
    rules: { ...DEFAULT_REPO_RULES, areas: { "area:server": ["apps/server/**"] } },
    seat: { call: "GUIDO-1", area: ["apps/server/**"], loop: "build" as const },
    login: null,
    hasRun: false,
    lane: undefined,
    laneDefault: false,
    body: null,
    closed: () => undefined,
  };

  it("refuses a ticket with an open wait, naming it and its PR", () => {
    expect(
      eligibleToStart({
        ...base,
        waits: [{ ref: "mc#1015", text: "mc#1015 (PR 1033 in CI)" }],
      }),
    ).toBe(waitsOnText("mc#1139", ["mc#1015 (PR 1033 in CI)"]));
  });
});

describe("undeclaredPrDependency", () => {
  const open = pr({ number: 1033, ticket: "mc#1015", closingIssues: [1015] });

  it("names the line to add when a body builds on an open PR without one", () => {
    expect(undeclaredPrDependency("Cut from PR 1033.", "mc", [open])).toEqual({
      pr: 1033,
      line: "Depends on #1015",
    });
    expect(
      undeclaredPrDependency("builds on PR #7", "mc", [pr({ number: 7, ticket: null })]),
    ).toEqual({ pr: 7, line: "After PR 7" });
  });

  it("is satisfied by either line, and ignores a merged PR", () => {
    expect(undeclaredPrDependency("Cut from PR 1033.\nDepends on #1015", "mc", [open])).toBeNull();
    expect(undeclaredPrDependency("Cut from PR 1033.\nAfter PR 1033", "mc", [open])).toBeNull();
    expect(
      undeclaredPrDependency("Cut from PR 1033.", "mc", [{ ...open, state: "merged" }]),
    ).toBeNull();
  });
});
