import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardItem,
  DEFAULT_REPO_RULES,
  OPERATOR_HEADER,
  type Run,
  type TicketView,
  WAITING_OPERATOR_LABEL,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { Gql } from "../src/collectors/github.ts";
import type { CcConfig } from "../src/config.ts";
import type { Move } from "../src/github-board.ts";
import type { GhRunner } from "../src/mcp/gh.ts";
import { releaseWaitingOperator } from "../src/needs-you-actions.ts";
import type { Supervisor } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const HEADERS = { [OPERATOR_HEADER]: "test-token" };
let dir: string;
let store: Store;
let ghCalls: string[][];
let moves: Move[];
let messaged: string[];

const config = (): CcConfig => ({
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "merge" }],
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
  status: "Backlog",
  state: "planned",
  labels: [WAITING_OPERATOR_LABEL],
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

const run = (over: Partial<Run> = {}): Run => ({
  id: "r-guido",
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 60_000,
  endedAt: NOW - 1000,
  status: "ok",
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

/** A question set aside by Not now: its run ended with a handoff, the card sits in Backlog. */
function asideQuestion(ticket = "mc#7", runId = "r-guido"): number {
  store.upsertRun(run({ id: runId, ticket }));
  const id = store.addQuestion({
    agentId: "guido-1",
    runId,
    text: "Which lane?",
    at: NOW - 600_000,
  });
  store.addBrief({
    key: `ask:${id}`,
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
    ticket,
    basis: "read the ticket",
    at: NOW - 500_000,
  });
  store.passQuestion(id, NOW - 500_000);
  store.setQuestionAside(id, NOW - 400_000);
  return id;
}

const gh: GhRunner = async (args) => {
  ghCalls.push(args);
  return { code: 0, stdout: "", stderr: "" };
};

const supervisor = {
  status: () => ({ enabled: true, note: null }),
  busy: () => [],
  seat: () => ({ runId: null }),
  message: async (_seat: string, text: string) => {
    messaged.push(text);
  },
  endRun: async () => {},
  endAsideRun: async () => {},
} as unknown as Supervisor;

const app = () =>
  buildApp({
    config: config(),
    store,
    bus: new ChangeBus(),
    operatorToken: "test-token",
    gh,
    supervisor,
    githubGql: async () => ({}) as unknown as Gql,
    knownSecrets: async () => [],
    now: () => NOW,
    needsYou: {
      board: {
        move: async (m) => {
          moves.push(m);
          return { ok: true, changed: true };
        },
      },
      rules: async () => DEFAULT_REPO_RULES,
      fetchTicket: async (_repo, n) => ({ number: n }) as unknown as TicketView,
    },
  });

const answer = (a: ReturnType<typeof app>, n: number, id: number | string, text: string) =>
  a.inject({
    method: "POST",
    url: `/api/tickets/mc/${n}/set-aside/${id}/answer`,
    headers: HEADERS,
    payload: { text },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-needs-you-answer-"));
  store = new Store(join(dir, "db.sqlite"));
  ghCalls = [];
  moves = [];
  messaged = [];
  store.replaceBoard("mc", [card(7), card(8)]);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a question set aside with Not now", () => {
  it("is listed on its ticket with its text, options and date, until it is answered", async () => {
    const id = asideQuestion();
    const answered = asideQuestion("mc#8", "r-other");
    store.answerQuestion(answered, NOW);
    const open = store.addQuestion({
      agentId: "guido-1",
      runId: "r-guido",
      text: "Open?",
      at: NOW,
    });
    const a = app();
    try {
      const res = await a.inject("/api/tickets/mc/7/set-aside");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        {
          id,
          text: "Which lane?",
          ask: "Which lane should this ship in?",
          options: [
            { id: "a", label: "A", answer: "Do A." },
            { id: "b", label: "B", answer: "Do B." },
          ],
          asideAt: NOW - 400_000,
          runId: "r-guido",
        },
      ]);
      expect((await a.inject("/api/tickets/mc/8/set-aside")).json()).toEqual([]);
      expect(open).toBeGreaterThan(0);
      expect((await a.inject("/api/tickets/nope/7/set-aside")).statusCode).toBe(404);
    } finally {
      await a.close();
    }
  });

  it("is answered from its ticket: the seat is told, the question closes, the label goes and the card moves to Ready", async () => {
    const id = asideQuestion();
    const a = app();
    try {
      const res = await answer(a, 7, id, "Use lane 2.");
      expect(res.statusCode).toBe(200);
      expect(store.question(id)?.answeredAt).toBe(NOW);
      expect(
        ghCalls.filter(
          (c) => c[1] === "edit" && c.includes(`--remove-label=${WAITING_OPERATOR_LABEL}`),
        ),
      ).toHaveLength(1);
      expect(moves).toEqual([
        { runId: expect.any(String), repoId: "mc", issue: 7, column: "Ready" },
      ]);
      const sent = store.commsOnTicket("mc#7", "mc#7", [], 10);
      expect(sent.some((m) => m.text.includes("Use lane 2.") && m.to === "guido-1")).toBe(true);
      expect((await a.inject("/api/tickets/mc/7/set-aside")).json()).toEqual([]);
      // a second answer finds nothing to answer
      expect((await answer(a, 7, id, "Again")).statusCode).toBe(409);
    } finally {
      await a.close();
    }
  });

  it("refuses an answer for a question that is unknown, not set aside, on another ticket or carries a secret", async () => {
    const id = asideQuestion();
    const open = store.addQuestion({
      agentId: "guido-1",
      runId: "r-guido",
      text: "Open?",
      at: NOW,
    });
    const a = app();
    try {
      expect((await answer(a, 7, 999, "x")).statusCode).toBe(404);
      expect((await answer(a, 7, open, "x")).statusCode).toBe(409);
      expect((await answer(a, 8, id, "x")).statusCode).toBe(404);
      const bad = await answer(a, 7, id, `token ${"ghp"}_${"a1B2".repeat(9)}`);
      expect(bad.statusCode).toBe(400);
      expect(store.question(id)?.answeredAt).toBeNull();
      expect(moves).toEqual([]);
    } finally {
      await a.close();
    }
  });

  it("leaves the card where it is and still records the answer when the ticket has a live run", async () => {
    const id = asideQuestion();
    store.upsertRun(run({ id: "r-live", endedAt: null, status: "running", seq: 2 }));
    const a = app();
    try {
      expect((await answer(a, 7, id, "Use lane 2.")).statusCode).toBe(200);
      expect(moves).toEqual([]);
      expect(store.question(id)?.answeredAt).toBe(NOW);
    } finally {
      await a.close();
    }
  });

  it("is refused by the seat message route once its run has ended, and nothing is sent", async () => {
    const id = asideQuestion();
    const a = app();
    try {
      const res = await a.inject({
        method: "POST",
        url: "/api/seats/guido-1/message",
        headers: HEADERS,
        payload: { text: "Use lane 2.", question: id },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/answer/i);
      expect(messaged).toEqual([]);
      expect(store.question(id)?.answeredAt).toBeNull();
    } finally {
      await a.close();
    }
  });
});

describe("releasing waiting:operator", () => {
  it("removes the label from a card that left the Backlog, and from nothing else", async () => {
    store.replaceBoard("mc", [
      card(7, { status: "In progress", state: "in progress" }),
      card(8),
      card(9, { status: "Ready", state: "planned", labels: [] }),
      card(10, { status: "Ready", state: "planned", closed: true }),
    ]);
    const released = await releaseWaitingOperator({
      config: config(),
      store,
      gh,
      dbPath: store.path,
    });
    expect(released).toBe(1);
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]).toEqual(
      expect.arrayContaining(["issue", "edit", "7", `--remove-label=${WAITING_OPERATOR_LABEL}`]),
    );
  });
});
