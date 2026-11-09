import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMS_CAPCOM, COMMS_CONTROLLER, COMMS_MC, type PullRequestView, type Run } from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { commsTicketCounts } from "../src/comms-ticket-counts.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 9, 9);
const repo = (id: string) => ({
  id,
  github: `o/${id}`,
  project: 1,
  statusMap: {},
  autonomy: "draft" as const,
});
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  loops: [],
  repos: [repo("shop")],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/record-wt",
    maxSeats: 2,
    sessions: [
      {
        id: "shop",
        repoId: "shop",
        checkout: "/tmp/record-co",
        seats: [
          { id: "flight-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
          { id: "guido-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
};
const run = (id: string, changes: Partial<Run> = {}): Run => ({
  id,
  agentId: "guido-1",
  repoId: "shop",
  seq: 1,
  startedAt: NOW - 100,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: "x",
  branch: "feature/7-x",
  ticket: "shop#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "/unused",
  prs: [],
  summary: null,
  ...changes,
});
const pr = (changes: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "shop",
  number: 30,
  title: "PR",
  url: "https://github.com/o/shop/pull/30",
  branch: "feature/7-x",
  state: "open",
  isDraft: false,
  ticket: "shop#7",
  ci: "pending",
  review: null,
  createdAt: NOW,
  updatedAt: NOW,
  mergedAt: null,
  headSha: "a".repeat(40),
  mergeCommitSha: null,
  mergeable: null,
  author: "operator",
  assignees: [],
  checks: [],
  closingIssues: [7, 8, 7],
  ...changes,
});

let store: Store;
let app: FastifyInstance;
const build = (value = config) =>
  buildApp({
    config: value,
    store,
    bus: new ChangeBus(),
    now: () => NOW,
    githubGql: async () => async () => {
      throw Error("offline fixture");
    },
  });
beforeEach(() => {
  store = new Store(":memory:");
  app = build();
});
afterEach(async () => {
  await app.close();
  store.close();
});
const get = async (url: string) => {
  const response = await app.inject({ url });
  expect(response.statusCode).toBe(200);
  return response.json();
};

describe("Comms record reads", () => {
  it("opens the actual hub conversation with stored messages and normal paging", async () => {
    for (let n = 0; n < 3; n++)
      store.addComms({
        from: COMMS_MC,
        to: COMMS_CAPCOM,
        text: `notice ${n}`,
        at: n + 1,
        ticket: null,
        senderKind: "hub",
      });
    const page = await get(`/api/comms/agents/${COMMS_MC}?limit=2`);
    expect(page.messages.map((m: { text: string }) => m.text)).toEqual(["notice 1", "notice 2"]);
    expect(page.hasMore).toBe(true);
    const older = await get(`/api/comms/agents/${COMMS_MC}?limit=2&before=${page.messages[0].id}`);
    expect(older.messages.map((m: { text: string }) => m.text)).toEqual(["notice 0"]);
    expect((await app.inject({ url: "/api/comms/agents/unknown" })).statusCode).toBe(404);
  });

  it("lists the Flight/controller pair truthfully before and after its first message", async () => {
    const empty = await get("/api/comms/agents/flight-1?summary=1");
    expect(empty.contacts.find((c: { id: string }) => c.id === COMMS_CONTROLLER)).toMatchObject({
      count: 0,
      hasMessages: false,
    });
    store.addComms({
      from: COMMS_CONTROLLER,
      to: "flight-1",
      text: "controller note",
      at: 1,
      ticket: null,
      senderKind: "controller",
    });
    const pair = await get(`/api/comms/pairs/flight-1/${COMMS_CONTROLLER}`);
    expect(pair.messages.map((m: { text: string }) => m.text)).toEqual(["controller note"]);
    const list = await get(`/api/comms/agents/${COMMS_CONTROLLER}?summary=1`);
    expect(list.contacts.find((c: { id: string }) => c.id === "flight-1")).toMatchObject({
      count: 1,
      hasMessages: true,
    });
    expect(list.messages).toEqual([]);
  });

  it("returns all-time ticket counts rather than the feed window, without double-counting a reference", async () => {
    expect(await get("/api/comms/ticket-counts")).toEqual({ tickets: [], unassignedCount: 0 });
    for (let n = 0; n < 145; n++)
      store.addComms({
        from: "guido-1",
        to: "flight-1",
        text: "retained",
        at: n + 1,
        ticket: "shop#7",
        ref: "#7",
      });
    store.addComms({
      from: "guido-1",
      to: "flight-1",
      text: "short ref",
      at: 200,
      ticket: null,
      ref: "#8",
    });
    store.addComms({ from: "guido-1", to: "flight-1", text: "no ticket", at: 201, ticket: null });
    const counts = await get("/api/comms/ticket-counts");
    expect(counts).toEqual({
      tickets: [
        { ticket: "shop#7", count: 145 },
        { ticket: "shop#8", count: 1 },
      ],
      unassignedCount: 0,
    });
    expect(counts.tickets.find((x: { ticket: string }) => x.ticket === "shop#9")).toBeUndefined();
  });

  it("resolves PR references to each closing ticket once and honors explicit ticket identity", async () => {
    store.upsertPullRequests("shop", [pr()], NOW);
    store.addComms({
      from: "guido-1",
      to: "flight-1",
      text: "PR",
      at: 1,
      ticket: "PR 30",
      ref: "PR 30",
    });
    store.addComms({
      from: "guido-1",
      to: "flight-1",
      text: "explicit",
      at: 2,
      ticket: "shop#7",
      ref: "PR 30",
    });
    expect(await get("/api/comms/ticket-counts")).toEqual({
      tickets: [
        { ticket: "shop#7", count: 2 },
        { ticket: "shop#8", count: 1 },
      ],
      unassignedCount: 0,
    });
  });

  it("keeps ticket totals after retention removes message bodies, without counting a sweep twice", async () => {
    const old = store.addComms({
      from: "guido-1",
      to: "flight-1",
      text: "old body",
      at: 1,
      ticket: "shop#7",
      ref: "#7",
    });
    store.addComms({
      from: "guido-1",
      to: "flight-1",
      text: "new body",
      at: NOW,
      ticket: "shop#7",
    });
    const before = await get("/api/comms/ticket-counts");
    expect(before.tickets).toEqual([{ ticket: "shop#7", count: 2 }]);
    for (let n = 0; n < 25; n++) await store.pruneHistory(NOW);
    if (old === null) throw Error("The fixture message was not stored");
    expect(store.commsMessage(old.id)).toBeNull();
    expect(await get("/api/comms/ticket-counts")).toEqual(before);
    for (let n = 0; n < 25; n++) await store.pruneHistory(NOW);
    expect(await get("/api/comms/ticket-counts")).toEqual(before);
    store.addComms({
      from: "guido-1",
      to: "flight-1",
      text: "later",
      at: NOW + 1,
      ticket: "shop#7",
    });
    expect((await get("/api/comms/ticket-counts")).tickets).toEqual([
      { ticket: "shop#7", count: 3 },
    ]);
  });

  it("keeps retired ordinary and question-message counts across a database reopen", async () => {
    const folder = mkdtempSync(join(tmpdir(), "mc-comms-totals-"));
    const path = join(folder, "mc.sqlite");
    let copy = new Store(path);
    try {
      const first = copy.addComms({
        from: "guido-1",
        to: "flight-1",
        text: "ordinary",
        at: 1,
        ticket: "shop#7",
      });
      const question = copy.addComms({
        from: "guido-1",
        to: "flight-1",
        text: "old question",
        at: 2,
        ticket: "shop#7",
        label: "question",
      });
      for (let n = 0; n < 25; n++) await copy.pruneHistory(NOW);
      if (first === null || question === null) throw Error("The fixture messages were not stored");
      expect(copy.commsMessage(first.id)).toBeNull();
      expect(copy.commsMessage(question.id)).toBeNull();
      copy.close();
      copy = new Store(path);
      expect(commsTicketCounts(config, copy)).toEqual({
        tickets: [{ ticket: "shop#7", count: 2 }],
        unassignedCount: 0,
      });
      for (let n = 0; n < 25; n++) await copy.pruneHistory(NOW);
      expect(commsTicketCounts(config, copy).tickets).toEqual([{ ticket: "shop#7", count: 2 }]);
    } finally {
      copy.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("keeps ambiguous multi-repo legacy references unassigned instead of guessing", async () => {
    await app.close();
    app = build({ ...config, repos: [...config.repos, repo("other")] });
    store.addComms({
      from: COMMS_CAPCOM,
      to: "flight-1",
      text: "ambiguous",
      at: 1,
      ticket: null,
      ref: "#7",
    });
    store.addComms({
      from: "guido-1",
      to: "flight-1",
      text: "scoped by sender",
      at: 2,
      ticket: null,
      ref: "#7",
    });
    store.addComms({
      from: COMMS_CAPCOM,
      to: "flight-1",
      text: "explicit other",
      at: 3,
      ticket: "other#7",
      ref: "#7",
    });
    expect(await get("/api/comms/ticket-counts")).toEqual({
      tickets: [
        { ticket: "other#7", count: 1 },
        { ticket: "shop#7", count: 1 },
      ],
      unassignedCount: 1,
    });
  });

  it("retains actual sender kinds and leaves legacy message provenance unknown", async () => {
    store.upsertRun(run("r"));
    const actors = [
      [COMMS_CAPCOM, "operator"],
      [COMMS_CONTROLLER, "controller"],
      ["flight-1", "flight"],
      ["guido-1", "seat"],
      [COMMS_MC, "hub"],
    ] as const;
    for (const [from, senderKind] of actors)
      store.addComms({
        from,
        to: "flight-1",
        text: senderKind,
        at: 1,
        ticket: "shop#7",
        senderKind,
      });
    store.addComms({ from: "old-seat", to: "flight-1", text: "legacy", at: 1, ticket: "shop#7" });
    const page = await get("/api/tickets/shop/7");
    const messages = page.timeline.filter((e: { kind: string }) => e.kind === "comms");
    expect(
      Object.fromEntries(
        messages.map((e: { text: string; senderKind: string | null }) => [e.text, e.senderKind]),
      ),
    ).toEqual({
      operator: "operator",
      controller: "controller",
      flight: "flight",
      seat: "seat",
      hub: "hub",
      legacy: null,
    });
  });

  it("returns asked, answered and set-aside questions from the actual ticket runs", async () => {
    store.upsertRun(run("r"));
    const id = store.addQuestion({ agentId: "guido-1", runId: "r", text: "Which version?", at: 1 });
    store.setQuestionAside(id, 2);
    store.recordSetAsideAnswer({
      at: 3,
      seatId: "guido-1",
      questionId: id,
      ref: "shop#7",
      about: "Version",
      decision: "Use the stable version.",
    });
    store.answerQuestion(id, 3);
    const page = await get("/api/tickets/shop/7");
    expect(page.questions).toEqual([
      {
        id,
        runId: "r",
        seat: "guido-1",
        text: "Which version?",
        at: 1,
        passedAt: null,
        asideAt: 2,
        closedAt: 3,
        answer: "Use the stable version.",
        answerAt: 3,
        answerBasis: "Operator answered the set-aside question from its ticket.",
      },
    ]);
    expect(page.questionsNextBefore).toBeNull();
  });

  it("does not invent an answer when a run merely closed its question", async () => {
    store.upsertRun(run("r", { endedAt: NOW }));
    const id = store.addQuestion({ agentId: "guido-1", runId: "r", text: "Unanswered", at: 1 });
    store.answerQuestion(id, 3);
    const page = await get("/api/tickets/shop/7");
    expect(page.questions[0]).toMatchObject({
      id,
      closedAt: 3,
      answer: null,
      answerAt: null,
      answerBasis: null,
    });
  });

  it("pages questions with tied timestamps separately from the existing timeline cursor", async () => {
    store.upsertRun(run("r"));
    store.upsertRun(run("foreign", { repoId: "other", ticket: "other#7" }));
    const ids = Array.from({ length: 5 }, (_, n) =>
      store.addQuestion({ agentId: "guido-1", runId: "r", text: `Q${n}`, at: 1 }),
    );
    store.addQuestion({ agentId: "guido-1", runId: "foreign", text: "private other", at: 100 });
    const first = await get("/api/tickets/shop/7?limit=2");
    expect(first.questions.map((q: { id: number }) => q.id)).toEqual(ids.slice(3).reverse());
    const second = await get(
      `/api/tickets/shop/7?limit=2&questionsBefore=${encodeURIComponent(first.questionsNextBefore)}`,
    );
    const last = await get(
      `/api/tickets/shop/7?limit=2&questionsBefore=${encodeURIComponent(second.questionsNextBefore)}`,
    );
    expect(
      [...first.questions, ...second.questions, ...last.questions].map((q: { id: number }) => q.id),
    ).toEqual([...ids].reverse());
    expect(last.questionsNextBefore).toBeNull();
    expect(second.timeline).toEqual(first.timeline);
    expect(
      (await app.inject({ url: "/api/tickets/shop/7?questionsBefore=1~run:r" })).statusCode,
    ).toBe(400);
  });
});
