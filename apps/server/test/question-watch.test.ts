import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASKING_RUN_ENDED_REASON,
  type BoardItem,
  COMMS_MC,
  NEW_LOOP,
  OPERATOR_HEADER,
  type PullRequestView,
  prMergedReason,
  questionClosedText,
  type Run,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { attentionItems, NOTE_KEY } from "../src/hud.ts";
import {
  closeSettledQuestions,
  closingFact,
  factsText,
  openQuestionSubjects,
  questionFacts,
} from "../src/question-watch.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-07T12:00:00Z");
let dir: string;
let store: Store;

const config = (): CcConfig => ({
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  crew: {
    worktrees: "/tmp/wt",
    maxSeats: 2,
    sessions: [
      {
        id: "mc-1",
        repoId: "mc",
        checkout: "/tmp/co",
        seats: [
          { id: "guido-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
          { id: "flight-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
  poll: { usageMinutes: 30, githubSeconds: 60 },
});

const card = (n: number, over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: "mc",
  issueNumber: n,
  title: `Ticket ${n}`,
  status: "In progress",
  state: "in progress",
  labels: [],
  priority: null,
  updatedAt: NOW,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: null,
  closed: false,
  prioritySource: null,
  createdAt: NOW - n,
  itemId: `I${n}`,
  projectId: "P1",
  ...over,
});

const pr = (n: number, over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "mc",
  number: n,
  title: `PR ${n}`,
  url: "u",
  branch: `mc/${n}`,
  ticket: "mc#7",
  state: "open",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW,
  updatedAt: NOW,
  mergedAt: null,
  headSha: "a",
  mergeable: "MERGEABLE",
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  id: "r-guido",
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 60_000,
  endedAt: null,
  status: "running",
  sessionId: "cli",
  model: "opus",
  branch: "mc/7",
  ticket: "mc#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
  ...over,
});

/** A seat's question on mc#7 that FLIGHT passed up to the operator with its brief. */
function passedQuestion(): { id: number; key: string } {
  store.upsertRun(run());
  store.setSeatSession({
    seatId: "guido-1",
    runId: "r-guido",
    cliSessionId: "cli",
    state: "idle",
    reason: null,
    worktree: null,
    updatedAt: NOW,
  });
  store.replaceBoard("mc", [card(7)]);
  const id = store.addQuestion({
    agentId: "guido-1",
    runId: "r-guido",
    text: "Which lane?",
    at: NOW - 10 * 60_000,
  });
  const key = `ask:${id}`;
  store.addBrief({
    key,
    for: "operator",
    by: "flight",
    ask: "Which lane should this ship in?",
    assessment: "Two lanes fit.",
    context: "Two lanes fit.",
    recommendation: "Lane 2.",
    options: [
      { id: "a", label: "A", answer: "Do A." },
      { id: "b", label: "B", answer: "Do B." },
    ],
    ticket: "mc#7",
    basis: "read the ticket",
    at: NOW - 5 * 60_000,
  });
  store.passQuestion(id, NOW - 5 * 60_000);
  return { id, key };
}

const operatorKeys = (now = NOW) =>
  attentionItems(config(), store, now)
    .filter((i) => i.owner === "operator")
    .map((i) => i.key);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-question-watch-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the hub closes a question on a recorded fact", () => {
  it("closes a question whose ticket closed", async () => {
    const { key } = passedQuestion();
    expect(operatorKeys()).toContain(key);
    expect(await closeSettledQuestions({ config: config(), store, now: NOW })).toBe(0);
    store.replaceBoard("mc", [card(7, { closed: true })]);
    const deliver = vi.fn(async () => {});
    expect(await closeSettledQuestions({ config: config(), store, now: NOW + 1, deliver })).toBe(1);
    expect(operatorKeys(NOW + 1)).not.toContain(key);
    expect(store.questionClosure(key, NOW - 10 * 60_000)).toMatchObject({
      kind: "ticket-closed",
      reason: "mc#7 was closed.",
      by: "hub",
      question: "Which lane?",
      ticket: "mc#7",
      operator: true,
    });
    // the seat is told, in Comms and in its live run
    const told = questionClosedText("Which lane?", "mc#7 was closed.");
    expect(
      store
        .commsForAgent("guido-1")
        .some(
          (m) =>
            m.from === COMMS_MC && m.senderKind === "hub" && m.to === "guido-1" && m.text === told,
        ),
    ).toBe(true);
    expect(deliver).toHaveBeenCalledWith("guido-1", told);
    // once only
    expect(await closeSettledQuestions({ config: config(), store, now: NOW + 2, deliver })).toBe(0);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("closes a question whose asking run ended", () => {
    const { id, key } = passedQuestion();
    store.endRunQuestions("r-guido", NOW);
    expect(store.question(id)?.answeredAt).toBe(NOW);
    expect(store.questionClosure(key, NOW - 10 * 60_000)).toMatchObject({
      kind: "run-ended",
      reason: ASKING_RUN_ENDED_REASON,
      by: "hub",
      operator: true,
    });
    expect(operatorKeys()).not.toContain(key);
  });

  it("closes an operator question about an item when its PR merged or closed", async () => {
    passedQuestion();
    store.upsertPullRequests("mc", [pr(9)], NOW);
    store.upsertRun(run({ loop: { ...NEW_LOOP, prNumber: 9 } }));
    expect(await closeSettledQuestions({ config: config(), store, now: NOW })).toBe(0);
    store.upsertPullRequests("mc", [pr(9, { state: "merged", mergedAt: NOW })], NOW + 1);
    expect(await closeSettledQuestions({ config: config(), store, now: NOW + 1 })).toBe(1);
    expect(store.questionClosures(0, 5)[0]).toMatchObject({
      kind: "pr-merged",
      reason: prMergedReason(9),
    });
  });

  it("lists both closures under Answered for the last week", async () => {
    const { key } = passedQuestion();
    await closeSettledQuestions({ config: config(), store, now: NOW - 1 });
    store.replaceBoard("mc", [card(7, { closed: true })]);
    await closeSettledQuestions({ config: config(), store, now: NOW });
    const second = store.addQuestion({
      agentId: "guido-1",
      runId: "r-guido",
      text: "And the branch?",
      at: NOW + 5,
    });
    store.addBrief({
      key: `ask:${second}`,
      for: "operator",
      by: "flight",
      ask: "Branch?",
      assessment: "a",
      context: "a",
      recommendation: "main",
      options: [
        { id: "a", label: "A", answer: "Do A." },
        { id: "b", label: "B", answer: "Do B." },
      ],
      ticket: "mc#7",
      basis: "b",
      at: NOW + 6,
    });
    store.passQuestion(second, NOW + 6);
    store.endRunQuestions("r-guido", NOW + 10);
    const app = buildApp({ config: config(), store, bus: new ChangeBus(), operatorToken: "t" });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/attention/answered",
        headers: { [OPERATOR_HEADER]: "t" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { key: string; reason: string }[];
      expect(body.map((c) => [c.key, c.reason])).toEqual([
        [`ask:${second}`, ASKING_RUN_ENDED_REASON],
        [key, "mc#7 was closed."],
      ]);
    } finally {
      await app.close();
    }
  });

  it("never closes a protected item", async () => {
    store.upsertRun(run());
    store.replaceBoard("mc", [card(7, { closed: true })]);
    store.raiseNote({
      key: "blocked:prot",
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: "mc",
      text: "Choose",
      at: NOW - 1,
    });
    store.addBrief({
      key: `${NOTE_KEY}blocked:prot`,
      for: "operator",
      by: "flight",
      ask: "Go?",
      assessment: "a",
      context: "a",
      recommendation: "go",
      options: [
        { id: "a", label: "A", answer: "Do A." },
        { id: "b", label: "B", answer: "Do B." },
      ],
      ticket: "mc#7",
      basis: "b",
      at: NOW,
    });
    expect(openQuestionSubjects({ config: config(), store, now: NOW })).toEqual([]);
    expect(await closeSettledQuestions({ config: config(), store, now: NOW })).toBe(0);
    expect(store.questionClosures(0, 5)).toEqual([]);
  });

  it("reads the facts as one string, and the first closing fact wins", () => {
    const { id } = passedQuestion();
    const subject = openQuestionSubjects({ config: config(), store, now: NOW }).find(
      (s) => s.key === `ask:${id}`,
    );
    if (subject === undefined) throw new Error("subject missing");
    store.upsertPullRequests("mc", [pr(9, { headSha: "abc" })], NOW);
    const facts = questionFacts(store, subject);
    expect(factsText(facts)).toBe("ticket=open;pr=open:abc;run=live");
    expect(closingFact(subject, facts)).toBeNull();
    const merged = {
      ...facts,
      ticket: "closed" as const,
      pr: { number: 9, state: "merged" as const, headSha: "abc" },
    };
    expect(closingFact(subject, merged)?.kind).toBe("ticket-closed");
    expect(closingFact(subject, { ...merged, run: "ended" })?.kind).toBe("run-ended");
  });

  it("does not close a hub note on a run that ended, or a ticket that closed, before the ask", async () => {
    store.upsertRun(run({ id: "r1", endedAt: NOW - 3_600_000, status: "ok" }));
    store.replaceBoard("mc", [card(7, { closed: true, updatedAt: NOW - 3_600_000 })]);
    store.upsertPullRequests(
      "mc",
      [pr(9, { state: "merged", mergedAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000 })],
      NOW,
    );
    store.raiseNote({
      key: "cleanup:r1",
      kind: "blocked",
      runId: "r1",
      seatId: null,
      repoId: "mc",
      text: "Remove the worktree by hand",
      at: NOW - 1_800_000,
    });
    store.addBrief({
      key: `${NOTE_KEY}cleanup:r1`,
      for: "operator",
      by: "flight",
      ask: "Remove it?",
      assessment: "a",
      context: "a",
      recommendation: "yes",
      options: [
        { id: "a", label: "A", answer: "Do A." },
        { id: "b", label: "B", answer: "Do B." },
      ],
      ticket: "mc#7",
      basis: "b",
      at: NOW - 60_000,
    });
    expect(await closeSettledQuestions({ config: config(), store, now: NOW })).toBe(0);
    const item = attentionItems(config(), store, NOW).find(
      (i) => i.key === `${NOTE_KEY}cleanup:r1`,
    );
    expect(item?.owner).toBe("operator");
  });

  it("shows a note raised again under a closed key as a new item", () => {
    store.raiseNote({
      key: "blocked:x",
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: "mc",
      text: "First",
      at: NOW - 3000,
    });
    const key = `${NOTE_KEY}blocked:x`;
    store.addBrief({
      key,
      for: "operator",
      by: "flight",
      ask: "Go?",
      assessment: "a",
      context: "a",
      recommendation: "go",
      options: [
        { id: "a", label: "A", answer: "Do A." },
        { id: "b", label: "B", answer: "Do B." },
      ],
      ticket: "mc#7",
      basis: "b",
      at: NOW - 2000,
    });
    store.closeQuestion({
      key,
      askAt: NOW - 2000,
      kind: "withdrawn",
      reason: "No longer stands.",
      by: "flight-1",
      question: "Go?",
      ticket: null,
      operator: true,
      at: NOW - 1000,
    });
    expect(attentionItems(config(), store, NOW).find((i) => i.key === key)?.flightTriage).toBe(
      "handling",
    );
    store.clearNote("blocked:x", NOW - 500);
    store.raiseNote({
      key: "blocked:x",
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: "mc",
      text: "Second, a new problem",
      at: NOW,
    });
    const again = attentionItems(config(), store, NOW).find((i) => i.key === key);
    expect(again?.flightTriage).not.toBe("handling");
  });
});
