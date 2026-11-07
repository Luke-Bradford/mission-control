import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttentionItem,
  type BoardItem,
  DEFAULT_REPO_RULES,
  OPERATOR_HEADER,
  type PullRequestView,
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
import type { Supervisor } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const HEADERS = { [OPERATOR_HEADER]: "test-token" };
let dir: string;
let store: Store;
let ghCalls: string[][];
let moves: Move[];
let gqlCalls: string[];
let ended: string[];
let ticketState: "open" | "closed";
let ticketPrs: TicketView["pullRequests"];

const config = (): CcConfig => ({
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [
    { id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "merge" },
    { id: "other", github: "o/other", project: 2, statusMap: {}, autonomy: "merge" },
  ],
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

const ticketView = (n: number, over: Partial<TicketView> = {}): TicketView => ({
  number: n,
  title: `Ticket ${n}`,
  url: `https://github.com/o/mc/issues/${n}`,
  state: ticketState,
  ...(ticketState === "closed" ? { closedAt: NOW + 1000 } : {}),
  body: "Body text",
  bodyTruncated: false,
  bodyLength: 9,
  labels: [],
  milestone: null,
  subIssues: [],
  pullRequests: ticketPrs,
  ...over,
});

/** A seat's question on a ticket that FLIGHT passed up to the operator, with a brief. */
function passedQuestion(ticket = "mc#7"): { id: number; key: string } {
  store.upsertRun(run({ ticket }));
  store.setSeatSession({
    seatId: "guido-1",
    runId: "r-guido",
    cliSessionId: "cli",
    state: "idle",
    reason: null,
    worktree: null,
    updatedAt: NOW,
  });
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
    ticket,
    basis: "read the ticket",
    at: NOW - 5 * 60_000,
  });
  store.passQuestion(id, NOW - 5 * 60_000);
  return { id, key };
}

const gh: GhRunner = async (args) => {
  ghCalls.push(args);
  // GitHub reads the issue closed once a close has run
  if (args[0] === "issue" && args[1] === "close") ticketState = "closed";
  // the dependants search finds nothing
  return { code: 0, stdout: args[0] === "search" ? "[]" : "", stderr: "" };
};
const gql: Gql = (async (query: string) => {
  gqlCalls.push(query.includes("createLabel") ? "createLabel" : "labels");
  return {
    repository: {
      id: "R1",
      existing: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
}) as unknown as Gql;

const supervisor = {
  status: () => ({ enabled: true, note: null }),
  busy: () => [],
  endRun: async (seatId: string) => {
    const row = store.seatSession(seatId);
    if (row?.runId == null) throw new Error("no run");
    ended.push(row.runId);
    // what the real end path does: the run ends and its open questions close
    store.setRunEnded(row.runId, NOW + 1, "ok", "operator");
    store.endRunQuestions(row.runId, NOW + 1);
  },
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
    githubGql: async () => gql,
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
      fetchTicket: async (_repo, n) => ticketView(n),
    },
  });

const post = (a: ReturnType<typeof app>, key: string, action: "not-now" | "drop") =>
  a.inject({
    method: "POST",
    url: `/api/attention/${encodeURIComponent(key)}/${action}`,
    headers: HEADERS,
    payload: {},
  });
const items = async (a: ReturnType<typeof app>): Promise<AttentionItem[]> =>
  (await a.inject("/api/attention")).json();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-needs-you-actions-"));
  store = new Store(join(dir, "db.sqlite"));
  ghCalls = [];
  moves = [];
  gqlCalls = [];
  ended = [];
  ticketState = "open";
  ticketPrs = [];
  store.replaceBoard("mc", [card(7)]);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Not now and Drop on Needs you", () => {
  it("offers both on an unprotected question with a crew ticket, and not on a protected item", async () => {
    const { key } = passedQuestion();
    const a = app();
    try {
      const item = (await items(a)).find((i) => i.key === key);
      expect(item?.offers).toEqual(["not-now", "drop"]);
    } finally {
      await a.close();
    }
  });

  it("Not now ends the run with a handoff, moves and labels the card, comments once, and keeps the question answerable", async () => {
    const { id, key } = passedQuestion();
    const a = app();
    try {
      const res = await post(a, key, "not-now");
      expect(res.statusCode).toBe(200);
      // the run ended and left a handoff
      expect(ended).toEqual(["r-guido"]);
      expect(store.run("r-guido")?.endedAt).not.toBeNull();
      expect(store.handoff("r-guido")).toMatchObject({ runId: "r-guido", ticket: "mc#7" });
      // the card is in Backlog, labelled once
      expect(moves).toEqual([
        { runId: expect.any(String), repoId: "mc", issue: 7, column: "Backlog" },
      ]);
      expect(gqlCalls.filter((c) => c === "createLabel")).toHaveLength(1);
      expect(
        ghCalls.filter(
          (c) => c[1] === "edit" && c.includes(`--add-label=${WAITING_OPERATOR_LABEL}`),
        ),
      ).toHaveLength(1);
      // exactly one comment, with the question, the options and the date
      const comments = ghCalls.filter((c) => c[0] === "issue" && c[1] === "comment");
      expect(comments).toHaveLength(1);
      const body = comments[0]?.find((x) => x.startsWith("--body=")) ?? "";
      expect(body).toContain("Which lane should this ship in?");
      expect(body).toContain("Do A.");
      expect(body).toContain("Do B.");
      expect(body).toContain("2026-11-07");
      // it left Needs you, and is still open for an answer
      expect((await items(a)).some((i) => i.key === key)).toBe(false);
      expect(store.question(id)).toMatchObject({ answeredAt: null, asideAt: NOW });
      expect(store.questionClosure(key, NOW - 10 * 60_000)).toBeNull();
    } finally {
      await a.close();
    }
  });

  it("Not now writes nothing to GitHub and keeps the question in Needs you when the move fails", async () => {
    const { key } = passedQuestion();
    const a = buildApp({
      config: config(),
      store,
      bus: new ChangeBus(),
      operatorToken: "test-token",
      gh,
      supervisor,
      githubGql: async () => gql,
      knownSecrets: async () => [],
      now: () => NOW,
      needsYou: {
        board: { move: async () => ({ ok: false, reason: "no" }) },
        rules: async () => DEFAULT_REPO_RULES,
        fetchTicket: async (_repo, n) => ticketView(n),
      },
    });
    try {
      expect((await post(a, key, "not-now")).statusCode).toBe(502);
      expect(ghCalls.some((c) => c[1] === "comment")).toBe(false);
      expect((await items(a)).some((i) => i.key === key)).toBe(true);
    } finally {
      await a.close();
    }
  });

  it("Drop closes the ticket as not planned with one comment, and refuses with an open PR", async () => {
    const { key } = passedQuestion();
    store.upsertPullRequests("mc", [pr(9)], NOW);
    const a = app();
    try {
      const refused = await post(a, key, "drop");
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatch(/open PR/);
      expect(ghCalls.filter((c) => c[1] === "close")).toEqual([]);
      store.upsertPullRequests("mc", [pr(9, { state: "merged", mergedAt: NOW })], NOW + 1);
      const res = await post(a, key, "drop");
      expect(res.statusCode).toBe(200);
      const closes = ghCalls.filter((c) => c[0] === "issue" && c[1] === "close");
      expect(closes).toHaveLength(1);
      expect(closes[0]).toContain("--reason=not planned");
      expect(closes[0]?.filter((x) => x.startsWith("--comment="))).toHaveLength(1);
      expect(ghCalls.filter((c) => c[1] === "comment")).toEqual([]);
    } finally {
      await a.close();
    }
  });

  describe.each(["not-now", "drop"] as const)("%s", (action) => {
    it("refuses a protected item", async () => {
      store.raiseNote({
        key: "blocked:p",
        kind: "blocked",
        runId: null,
        seatId: null,
        repoId: "mc",
        text: "Choose",
        at: NOW - 1000,
      });
      const a = app();
      try {
        const res = await post(a, "note:blocked:p", action);
        expect(res.statusCode).toBe(409);
        expect(ghCalls).toEqual([]);
        expect(moves).toEqual([]);
      } finally {
        await a.close();
      }
    });

    it("refuses a ticket from another repo", async () => {
      const { key } = passedQuestion("other#7");
      store.replaceBoard("other", [card(7, { repoId: "other" })]);
      const a = app();
      try {
        const res = await post(a, key, action);
        expect(res.statusCode).toBe(409);
        expect(ghCalls).toEqual([]);
        expect(moves).toEqual([]);
        expect(ended).toEqual([]);
        expect((await items(a)).find((i) => i.key === key)?.offers).toBeUndefined();
      } finally {
        await a.close();
      }
    });
  });
});
