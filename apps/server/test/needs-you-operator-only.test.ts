import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMS_FLIGHT_ESCALATION_MS, COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateHolds, holdItem, nothingForOperator } from "../src/attention-holds.ts";
import type { CcConfig } from "../src/config.ts";
import { wakeReasonWords } from "../src/flight/state.ts";
import { agentViews, attentionItems } from "../src/hud.ts";
import { Store } from "../src/store.ts";

const SENT = COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT + 60 * 60_000;
const NOW = SENT + 3 * 24 * 60 * 60_000;
let dir: string;
let store: Store;

const config = (paused = true): CcConfig => ({
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "repo", github: "o/repo", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [
    {
      id: "studio",
      repoId: "repo",
      kind: "studio-loop",
      accountId: "a",
      stateDir: join(dir, "state"),
      worktree: join(dir, "wt"),
      launchdLabel: "com.x.studio",
      ...(paused ? { pausedBy: { issue: { repoId: "repo", number: 1818 } } } : {}),
    },
  ],
  crew: {
    worktrees: "/tmp/wt",
    maxSeats: 2,
    sessions: [
      {
        id: "repo-1",
        repoId: "repo",
        checkout: "/tmp/co",
        seats: [
          { id: "GUIDO-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
          { id: "FLIGHT-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
  poll: { usageMinutes: 30, githubSeconds: 60 },
});

const escalation = (issueNumber: number, title: string) => ({
  id: `repo#${issueNumber}`,
  repoId: "repo",
  issueNumber,
  title,
  kind: "autonomy-question" as const,
  source: "label" as const,
  openedAt: SENT,
  url: `https://github.com/o/repo/issues/${issueNumber}`,
  question: null,
});
const operatorItems = (c: CcConfig) =>
  attentionItems(c, store, NOW).filter((i) => i.owner === "operator");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-needs-you-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Needs you counts only what the operator must answer", () => {
  it("a FLIGHT message starting 'For the controller:' is never the operator's", () => {
    for (const label of ["question", "blocker"] as const) {
      store.addComms({
        at: SENT,
        from: "FLIGHT-1",
        to: "CAPCOM",
        ticket: null,
        text: `For the controller: tooling question ${label}`,
        label,
      });
    }
    store.addComms({
      at: SENT,
      from: "FLIGHT-1",
      to: "CAPCOM",
      ticket: null,
      text: "A real question for you",
      label: "question",
    });
    expect(NOW).toBeGreaterThan(SENT + COMMS_FLIGHT_ESCALATION_MS);
    const items = attentionItems(config(false), store, NOW).filter((i) =>
      i.key.startsWith("comms-open:"),
    );
    const mine = items.filter((i) => i.owner === "operator");
    expect(mine.map((i) => i.text)).not.toContain("For the controller: tooling question blocker");
    expect(items.some((i) => i.text.startsWith("For the controller:"))).toBe(true);
    expect(
      items
        .filter((i) => i.text.startsWith("For the controller:"))
        .every((i) => i.owner === "controller"),
    ).toBe(true);
  });

  it("a loop paused by its configured issue keeps its issues on its card", () => {
    store.replaceEscalations("repo", [
      escalation(1818, "autonomy-engine pause"),
      escalation(55, "studio question, 115 days old"),
    ]);
    expect(operatorItems(config())).toEqual([]);
    const view = agentViews(config(), store, NOW).find((v) => v.id === "studio");
    expect(view).toMatchObject({ paused: true, pausedBy: "repo#1818" });
    // the same issues ask the operator once the loop is not paused
    expect(operatorItems(config(false)).length).toBe(2);
  });

  it("a held item with nothing for the operator is not listed, yet holds waiting on it stay", () => {
    store.replaceEscalations("repo", [
      escalation(7, "Ready to merge: None for the operator."),
      escalation(8, "waits on seven"),
    ]);
    holdItem(
      store,
      "esc:repo#7",
      "Ready to merge: None for the operator.",
      { kind: "manual" },
      "FLIGHT-1",
      SENT + 1,
    );
    holdItem(
      store,
      "esc:repo#8",
      "until seven is resolved",
      { kind: "item", key: "esc:repo#7" },
      "FLIGHT-1",
      SENT + 1,
    );
    const all = attentionItems(config(false), store, NOW, undefined, undefined, null, true);
    const shown = all.filter((i) => i.hold && !nothingForOperator(i));
    expect(shown.map((i) => i.key)).toEqual(["esc:repo#8"]);
    // #7 is still a held item, so the hold on it does not release at once
    const keys = new Set(all.map((i) => i.key));
    expect(
      evaluateHolds(
        store,
        NOW,
        () => false,
        () => false,
        () => null,
        (k) => !keys.has(k),
      ),
    ).toBe(false);
  });

  it("each wake fact reads in words: no category name, no colon-joined key, no epoch", () => {
    const at = Date.UTC(2026, 10, 6, 14, 3);
    const cases: [string, unknown, string][] = [
      ["q", 1, "question 1"],
      [
        "prFlow",
        `1415:stage:review:${at}`,
        "PR #1415 has stood at the review step since 6 Nov 14:03",
      ],
      ["prFlow", `9:unowned:${at}`, "PR #9 has had no owner since 6 Nov 14:03"],
      ["prFlow", `9:waiting:operator:${at}`, "PR #9 has waited on the operator since 6 Nov 14:03"],
      ["signals", "seat_call:GUIDO-1", "seat call on GUIDO-1"],
      ["signals", "item_stale:esc:repo#7", "item stale on esc:repo#7"],
      ["triage", "repo#12:missed", "FLIGHT missed repo#12"],
      ["items", "comms-open:42", "Comms message 42 waits for an answer"],
      ["items", "pr:repo#9:PR #9 · You: review", "PR #9 · You: review"],
      ["parked", "GUIDO-1:repo#5:budget", "GUIDO-1 is parked on repo#5 (budget)"],
      ["idle", "GUIDO-1:30m", "GUIDO-1 idle 30m"],
      ["prs", "repo#12:9:true:open:review:", "PR #9 (repo#12) waits on FLIGHT to review"],
      [
        "planned",
        ["p1", at, "check", "repo#12", "look again"],
        "look again on repo#12, due 6 Nov 14:03",
      ],
      ["stopped", "GUIDO-1", "GUIDO-1 is stopped"],
    ];
    for (const [category, item, words] of cases) {
      const got = wakeReasonWords(
        { id: `${category}:${JSON.stringify(item)}`, label: "ignored", targets: [] },
        "Europe/London",
      );
      expect(got).toBe(words);
      expect(got).not.toMatch(/\d{13}/);
      expect(got.startsWith(`${category} `)).toBe(false);
    }
  });

  const noteItems = (c: CcConfig) =>
    attentionItems(c, store, NOW).filter((i) => i.key === "note:flight:left");
  const leftNote = (text: string) =>
    store.raiseNote({
      key: "flight:left",
      kind: "blocked",
      runId: null,
      seatId: "FLIGHT-1",
      repoId: "repo",
      text,
      at: SENT,
    });

  it("the wake-left alert stays the operator's, however many reasons it names", () => {
    leftNote("FLIGHT left 1 wake reason without a decision after two wakes: PR #9 waited");
    expect(noteItems(config(false)).map((i) => i.owner)).toEqual(["operator"]);
    store.clearNote("flight:left", SENT + 1);
    leftNote("FLIGHT left 5 wake reasons without a decision after two wakes: PR #9 waited");
    expect(noteItems(config(false)).map((i) => i.owner)).toEqual(["operator"]);
  });

  it("a review PR no run owns is FLIGHT's, not the operator's", () => {
    store.replaceBoard("repo", [
      {
        repoId: "repo",
        issueNumber: 5,
        title: "t",
        status: "In review",
        state: "review",
        labels: [],
        priority: null,
        updatedAt: SENT,
        url: "https://github.com/o/repo/issues/5",
        stage: null,
        owner: null,
        parent: null,
        subIssues: null,
        blockedBy: [],
        milestone: null,
        size: null,
        closed: false,
        prioritySource: null,
        createdAt: 1,
        itemId: null,
        projectId: null,
      },
    ]);
    store.replacePullRequests(
      "repo",
      [
        {
          repoId: "repo",
          number: 9,
          title: "pr",
          url: "https://github.com/o/repo/pull/9",
          branch: "feature/5",
          ticket: "repo#5",
          state: "open",
          isDraft: false,
          review: null,
          ci: null,
          createdAt: SENT,
          updatedAt: SENT,
          mergedAt: null,
          headSha: null,
          mergeable: null,
        },
      ],
      0,
    );
    const prs = attentionItems(config(false), store, NOW).filter((i) => i.kind === "pr");
    expect(prs.length).toBe(1);
    expect(prs[0]?.owner).not.toBe("operator");
    expect(prs[0]?.text).toBe("PR #9 · You: review");
  });
  it("the 17:40 items together leave only the reworded wake-left alert for the operator", () => {
    const c = config();
    c.repos.push({ id: "repo2", github: "o/repo2", project: 2, statusMap: {}, autonomy: "draft" });
    store.upsertRun({
      id: "f",
      agentId: "FLIGHT-1",
      repoId: "repo",
      seq: 1,
      startedAt: SENT,
      endedAt: null,
      status: "running",
      sessionId: null,
      model: "x",
      branch: null,
      ticket: null,
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
    });
    store.setSeatSession({
      seatId: "FLIGHT-1",
      runId: "f",
      cliSessionId: null,
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    // the paused loop's pause issue and two old questions
    store.replaceEscalations("repo", [
      escalation(1818, "autonomy-engine pause"),
      escalation(31, "studio question one"),
      escalation(32, "studio question two"),
    ]);
    // the wake-left alert, in words
    const at = Date.UTC(2026, 10, 6, 14, 3);
    const words = wakeReasonWords(
      { id: `prFlow:"1415:stage:review:${at}"`, label: "x", targets: [] },
      "Europe/London",
    );
    store.raiseNote({
      key: "flight:left",
      kind: "blocked",
      runId: null,
      seatId: "FLIGHT-1",
      repoId: "repo",
      text: `FLIGHT left 5 wake reasons without a decision after two wakes: ${words}`,
      at: SENT,
    });
    // three review PRs no run owns
    const board = [1, 2, 3].map((n) => ({
      repoId: "repo2",
      issueNumber: n,
      title: `t${n}`,
      status: "In review",
      state: "review" as const,
      labels: [],
      priority: null,
      updatedAt: SENT,
      url: `https://github.com/o/repo2/issues/${n}`,
      stage: null,
      owner: null,
      parent: null,
      subIssues: null,
      blockedBy: [],
      milestone: null,
      size: null,
      closed: false,
      prioritySource: null,
      createdAt: 1,
      itemId: null,
      projectId: null,
    }));
    store.replaceBoard("repo2", board);
    store.replacePullRequests(
      "repo2",
      [1, 2, 3].map((n) => ({
        repoId: "repo2",
        number: 100 + n,
        title: `pr${n}`,
        url: `https://github.com/o/repo2/pull/${100 + n}`,
        branch: `feature/${n}`,
        ticket: `repo2#${n}`,
        state: "open" as const,
        isDraft: false,
        review: null,
        ci: null,
        createdAt: SENT,
        updatedAt: SENT,
        mergedAt: null,
        headSha: null,
        mergeable: null,
      })),
      0,
    );
    // a held item with nothing for the operator, and a tooling question for the controller
    holdItem(
      store,
      "esc:repo#31",
      "Ready to merge: None for the operator.",
      { kind: "manual" },
      "FLIGHT-1",
      SENT + 1,
    );
    store.addComms({
      at: SENT,
      from: "FLIGHT-1",
      to: "CAPCOM",
      ticket: null,
      text: "For the controller: which formatter should the sweep use?",
      label: "question",
    });
    const all = attentionItems(c, store, NOW, undefined, undefined, null, true);
    const mine = all.filter((i) => i.owner === "operator");
    expect(mine.map((i) => i.key)).toEqual(["note:flight:left"]);
    expect(mine[0]?.text).not.toMatch(/\d{13}/);
    expect(all.filter((i) => i.hold && !nothingForOperator(i))).toEqual([]);
    expect(all.filter((i) => i.kind === "pr")).toHaveLength(3);
  });
});
