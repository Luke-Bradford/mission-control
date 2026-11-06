import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMS_FLIGHT_ESCALATION_MS, COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdItem } from "../src/attention-holds.ts";
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

  it("a held item that has nothing for the operator is not listed", () => {
    store.replaceEscalations("repo", [escalation(7, "Ready to merge: None for the operator.")]);
    holdItem(
      store,
      "esc:repo#7",
      "Ready to merge: None for the operator.",
      { kind: "manual" },
      "FLIGHT-1",
      SENT + 1,
    );
    const all = attentionItems(config(false), store, NOW, undefined, undefined, null, true);
    expect(all.filter((i) => i.key === "esc:repo#7")).toEqual([]);
  });

  it("the wake-left alert names what waited in words, with no raw epoch", () => {
    const at = Date.UTC(2026, 10, 6, 14, 3);
    const words = wakeReasonWords(
      {
        id: `prFlow:"1415:stage:review:${at}"`,
        label: `prFlow 1415:stage:review:${at}`,
        targets: [],
      },
      "Europe/London",
    );
    expect(words).toBe("PR #1415 has stood at the review step since 6 Nov 14:03");
    expect(words).not.toMatch(/\d{13}/);
    const other = wakeReasonWords(
      { id: "x", label: `signals stalled:seat:${at}`, targets: [] },
      "Europe/London",
    );
    expect(other).not.toMatch(/\d{13}/);
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

  it("one late wake is FLIGHT's watch; several left are the operator's alert", () => {
    leftNote("FLIGHT left 1 wake reason without a decision after two wakes: PR #9 waited");
    expect(noteItems(config(false)).map((i) => i.owner)).not.toContain("operator");
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
});
