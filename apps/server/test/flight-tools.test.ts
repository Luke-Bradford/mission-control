import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardItem,
  claimedText,
  DEFAULT_REPO_RULES,
  FLIGHT_ABOUT_MAX,
  FLIGHT_NOTED,
  FLIGHT_NOTES_PER_HOUR,
  FLIGHT_UNPARK_KINDS,
  type FlightDecision,
  MC_BAD_ARGS,
  MC_FLIGHT_ONLY,
  MC_RUN_ENDED,
  MC_TICKET_READERS_ONLY,
  NEW_LOOP,
  type RepoRules,
  type Run,
  type RunLoop,
  researchText,
  type SeatSessionRow,
  startMissingNeedsText,
  startNeedsPlanText,
  type TicketView,
  ticketHasRunText,
  twoAreasText,
  waitsOnText,
  wrongAreaText,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import { type CcConfig, type CrewSeatConfig, SEAT_ID } from "../src/config.ts";
import { createFlightTools, seatFree } from "../src/flight/tools.ts";
import type { Move, MoveResult } from "../src/github-board.ts";
import type { McTool, McToolContext } from "../src/mcp/server.ts";
import { type SeatBusy, SupervisorError } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const seat = (id: string, role: string, extra: Partial<CrewSeatConfig> = {}): CrewSeatConfig => ({
  id,
  role,
  accountId: "claude-main",
  model: "opus",
  area: [],
  ...extra,
});
const config = (): CcConfig => ({
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
  repos: [
    { id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" },
    { id: "other", github: "o/other", project: 2, statusMap: {}, autonomy: "draft" },
  ],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/none",
    maxSeats: 8,
    sessions: [
      {
        id: "s1",
        repoId: "mc",
        checkout: "/tmp/none/clone",
        seats: [
          seat("flight-1", "FLIGHT"),
          seat("fao-1", "FAO"),
          seat("guido-1", "GUIDO", { area: ["apps/**"] }),
          seat("inco-1", "INCO", { area: ["apps/web/**"] }),
          seat("retro-1", "RETRO", { mode: "scratch" }),
        ],
      },
      {
        id: "s2",
        repoId: "other",
        checkout: "/tmp/none/clone2",
        seats: [seat("fao-2", "FAO")],
      },
    ],
  },
});

let dir: string;
let store: Store;
let bus: ChangeBus;
let seen: string[];
let tool: McTool;
let nowMs: number;
let cfg: CcConfig;
let tools: McTool[];
let startCalls: unknown[][];
let endCalls: string[];
let messageCalls: unknown[][];
let engineCalls: unknown[][];
let fetchCalls: number[];
let fetchRepos: string[];
let busyNow: SeatBusy[];
let engineOn: boolean;
let lifts: boolean;
let rulesNow: RepoRules;
let startImpl: () => Promise<{ runId: string; branch: string }>;
let messageImpl: () => Promise<void>;
let endImpl: (seatId: string) => Promise<void>;
let fetchImpl: (n: number) => Promise<TicketView | null>;
let moveCalls: Move[];
let moveImpl: () => Promise<MoveResult>;

const run = (id: string, agentId: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId,
  repoId: "mc",
  seq: 1,
  startedAt: NOW,
  endedAt: null,
  status: "running",
  sessionId: "cli",
  model: "opus",
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
  ...over,
});
const row = (seatId: string, runId: string): SeatSessionRow => ({
  seatId,
  runId,
  cliSessionId: "cli",
  state: "idle",
  reason: null,
  worktree: null,
  updatedAt: NOW,
});
const live = (seatId: string, runId: string, over: Partial<Run> = {}) => {
  store.upsertRun(run(runId, seatId, over));
  store.setSeatSession(row(seatId, runId));
};
const ctx = (seatId = "flight-1", runId = "r-flight"): McToolContext => ({ seatId, runId });
const args = (over: Record<string, unknown> = {}) => ({
  about: "GUIDO-1 on 232",
  decision: "held it back",
  basis: "its PR is not green",
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-flight-tools-"));
  store = new Store(join(dir, "mc.sqlite"));
  bus = new ChangeBus();
  seen = [];
  bus.subscribe((t) => seen.push(t));
  nowMs = NOW;
  cfg = config();
  startCalls = [];
  endCalls = [];
  messageCalls = [];
  engineCalls = [];
  fetchCalls = [];
  fetchRepos = [];
  busyNow = [];
  engineOn = false;
  lifts = true;
  rulesNow = DEFAULT_REPO_RULES;
  startImpl = async () => ({ runId: "", branch: "" });
  messageImpl = async () => {};
  // what the supervisor's endRun leaves behind: the run ended, the seat stopped
  endImpl = async (seatId) => {
    const runId = store.seatSession(seatId)?.runId ?? null;
    const r = runId === null ? null : store.run(runId);
    if (r !== null) store.upsertRun({ ...r, endedAt: nowMs, status: "ok" });
    store.setSeatSession({ ...row(seatId, ""), runId: null, state: "stopped" });
  };
  fetchImpl = async () => null;
  moveCalls = [];
  moveImpl = async () => ({ ok: true, changed: true });
  tools = createFlightTools({
    config: cfg,
    store,
    bus,
    login: "me",
    supervisor: {
      message: async (...a) => {
        messageCalls.push(a);
        await messageImpl();
      },
      busy: () => busyNow,
      endRun: async (seatId) => {
        endCalls.push(seatId);
        await endImpl(seatId);
      },
      startRun: async (...a) => {
        startCalls.push(a);
        return startImpl();
      },
    },
    engine: {
      onOperatorMessage: async (...a) => {
        engineCalls.push(a);
        return lifts;
      },
      status: () => ({ on: engineOn, note: null }),
    },
    rules: async () => rulesNow,
    board: {
      move: async (m) => {
        moveCalls.push(m);
        return moveImpl();
      },
    },
    fetchTicket: async (repo, n) => {
      fetchRepos.push(repo.id);
      fetchCalls.push(n);
      return fetchImpl(n);
    },
    now: () => nowMs,
  });
  const t = tools[0];
  if (t === undefined) throw new Error("no tool");
  tool = t;
  live("flight-1", "r-flight");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("log_decision", () => {
  it("is shown only to a role that is granted it", () => {
    expect(tool).toMatchObject({ name: "log_decision", modes: [], grantable: ["read-only"] });
  });

  it("refuses a seat that is not a watch seat", async () => {
    live("guido-1", "r-guido");
    const r = await tool.call(ctx("guido-1", "r-guido"), args());
    expect(r).toEqual({ text: MC_FLIGHT_ONLY, isError: true });
    expect(store.flightDecisions(0, 10)).toEqual([]);
  });

  it("refuses an ended or foreign run", async () => {
    store.upsertRun(run("r-flight", "flight-1", { endedAt: NOW + 1, status: "ok" }));
    expect(await tool.call(ctx(), args())).toEqual({ text: MC_RUN_ENDED, isError: true });
    expect(await tool.call(ctx("flight-1", "r-other"), args())).toEqual({
      text: MC_RUN_ENDED,
      isError: true,
    });
  });

  it("refuses bad arguments", async () => {
    for (const bad of [
      args({ about: "" }),
      args({ about: "x".repeat(FLIGHT_ABOUT_MAX + 1) }),
      args({ extra: 1 }),
      { about: "a", decision: "d" },
      args({ seat: "Not A Seat" }),
    ]) {
      const r = await tool.call(ctx(), bad);
      expect(r.isError).toBe(true);
      expect(r.text.startsWith(MC_BAD_ARGS)).toBe(true);
    }
  });

  it("records a note and emits flight", async () => {
    const r = await tool.call(ctx(), args({ seat: "guido-1" }));
    expect(r).toEqual({ text: FLIGHT_NOTED });
    expect(store.flightDecisions(0, 10)).toEqual([
      {
        id: 1,
        at: NOW,
        kind: "note",
        seatId: "guido-1",
        targetRunId: null,
        ref: null,
        questionId: null,
        about: "GUIDO-1 on 232",
        decision: "held it back",
        basis: "its PR is not green",
      },
    ]);
    expect(seen).toEqual(["flight"]);
  });

  it("refuses a seat that is not in its session", async () => {
    const r = await tool.call(ctx(), args({ seat: "nobody-9" }));
    expect(r).toEqual({
      text: "Not done: nobody-9 is not a seat in your session.",
      isError: true,
    });
    expect(store.flightDecisions(0, 10)).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("allows 60 notes an hour, then refuses the 61st", async () => {
    for (let i = 0; i < FLIGHT_NOTES_PER_HOUR; i++) {
      expect((await tool.call(ctx(), args())).isError).toBeUndefined();
    }
    const r = await tool.call(ctx(), args());
    expect(r).toEqual({
      text: "Not done: you logged notes 60 times in the last hour, the most allowed. Wait, or ask the operator.",
      isError: true,
    });
    nowMs += 61 * 60_000;
    expect((await tool.call(ctx(), args())).isError).toBeUndefined();
  });
});

const named = (name: string): McTool => {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};
const call = (name: string, a: Record<string, unknown>, c = ctx()) => named(name).call(c, a);
const card = (n: number, over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: "mc",
  issueNumber: n,
  title: `Ticket ${n}`,
  status: "Ready",
  state: "planned",
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
  createdAt: NOW,
  itemId: `I${n}`,
  projectId: "P1",
  ...over,
});
const board = (...cards: BoardItem[]) => store.replaceBoard("mc", cards);
const ticket = (n: number, over: Partial<TicketView> = {}): TicketView => ({
  number: n,
  title: `Ticket ${n}`,
  url: "u",
  state: "open",
  body: "Body text",
  bodyTruncated: false,
  bodyLength: 9,
  labels: [],
  milestone: null,
  subIssues: [],
  pullRequests: [],
  ...over,
});
const decisions = () => store.flightDecisions(0, 200);
const addDecision = (over: Partial<FlightDecision>) =>
  store.addFlightDecision({
    at: NOW - 1000,
    kind: "message",
    seatId: null,
    targetRunId: null,
    ref: null,
    questionId: null,
    about: "a",
    decision: "d",
    basis: "b",
    ...over,
  });
const refused = (text: string) => ({ text, isError: true });

describe("tool list", () => {
  it("adds the six tools, each shown only to a granted role", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "log_decision",
      "read_ticket",
      "answer_question",
      "start_seat",
      "message_seat",
      "flight_state",
      "promote",
      "end_run",
    ]);
    for (const t of tools) {
      expect(t).toMatchObject({ modes: [], grantable: ["read-only"] });
      expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });
});

describe("seat schema", () => {
  it("carries the seat id pattern on start_seat and message_seat", () => {
    for (const name of ["start_seat", "message_seat"]) {
      const props = (
        named(name).inputSchema as { properties: Record<string, { pattern?: string }> }
      ).properties;
      expect(props.seat?.pattern).toBe(SEAT_ID.source);
    }
  });
});

describe("seatFree", () => {
  it("is false for a seat with an unended run or named busy", () => {
    expect(seatFree(store, [], "guido-1")).toBe(true);
    expect(seatFree(store, [{ seatId: "guido-1", state: "starting" }], "guido-1")).toBe(false);
    live("guido-1", "r-g");
    expect(seatFree(store, [], "guido-1")).toBe(false);
    store.upsertRun(run("r-g", "guido-1", { endedAt: NOW, status: "ok" }));
    expect(seatFree(store, [], "guido-1")).toBe(true);
  });
});

describe("read_ticket", () => {
  it("answers the ticket with its column", async () => {
    board(card(5));
    fetchImpl = async (n) => ticket(n, { title: "Do it", body: "Plan here" });
    expect(await call("read_ticket", { issue: 5 })).toEqual({
      text: "#5 Do it [Ready]\n\nPlan here",
    });
    expect(fetchCalls).toEqual([5]);
  });

  it("shows the size when the card has one", async () => {
    board(card(5, { size: "M" }));
    fetchImpl = async (n) => ticket(n, { title: "Do it", body: "Text" });
    expect((await call("read_ticket", { issue: 5 })).text).toBe(
      "#5 Do it [Ready · Size M]\n\nText",
    );
  });

  it("says not on the board, and notes a cut body", async () => {
    fetchImpl = async (n) => ticket(n, { body: "abc", bodyTruncated: true, bodyLength: 50 });
    const r = await call("read_ticket", { issue: 6 });
    expect(r.text.startsWith("#6 Ticket 6 [not on the board]\n\n[The ticket body was cut")).toBe(
      true,
    );
    expect(r.text.endsWith("\n\nabc")).toBe(true);
  });

  it("refuses a throw and a missing issue", async () => {
    fetchImpl = async () => {
      throw new Error("net");
    };
    expect(await call("read_ticket", { issue: 5 })).toEqual(
      refused("Not read: GitHub could not be reached; try again in a few minutes."),
    );
    fetchImpl = async () => null;
    expect(await call("read_ticket", { issue: 5 })).toEqual(
      refused("Not read: there is no such issue."),
    );
  });

  it("allows 60 reads an hour, then refuses the 61st", async () => {
    fetchImpl = async (n) => ticket(n);
    for (let i = 0; i < 60; i++) {
      expect((await call("read_ticket", { issue: 1 })).isError).toBeUndefined();
    }
    expect(await call("read_ticket", { issue: 1 })).toEqual(
      refused(
        "Not done: you read tickets 60 times in the last hour, the most allowed. Wait, or ask the operator.",
      ),
    );
    expect(fetchCalls).toHaveLength(60);
  });

  it("answers a planner seat, from its own repo", async () => {
    live("fao-1", "r-fao");
    fetchImpl = async (n) => ticket(n, { title: "Referred", body: "Text" });
    expect(await call("read_ticket", { issue: 7 }, ctx("fao-1", "r-fao"))).toEqual({
      text: "#7 Referred [not on the board]\n\nText",
    });
    expect(fetchCalls).toEqual([7]);
    expect(fetchRepos).toEqual(["mc"]);
  });

  it("reads a planner's own session's repo, not FLIGHT's", async () => {
    live("fao-2", "r-fao2");
    fetchImpl = async (n) => ticket(n);
    expect(
      (await call("read_ticket", { issue: 7 }, ctx("fao-2", "r-fao2"))).isError,
    ).toBeUndefined();
    expect(fetchRepos).toEqual(["other"]);
  });

  it("counts a planner's reads apart from FLIGHT's", async () => {
    live("fao-1", "r-fao");
    fetchImpl = async (n) => ticket(n);
    for (let i = 0; i < 60; i++) await call("read_ticket", { issue: 1 });
    expect((await call("read_ticket", { issue: 1 })).isError).toBe(true);
    expect(
      (await call("read_ticket", { issue: 1 }, ctx("fao-1", "r-fao"))).isError,
    ).toBeUndefined();
  });

  it("refuses an ended planner run", async () => {
    live("fao-1", "r-fao");
    store.upsertRun(run("r-fao", "fao-1", { endedAt: NOW + 1, status: "ok" }));
    expect(await call("read_ticket", { issue: 1 }, ctx("fao-1", "r-fao"))).toEqual(
      refused(MC_RUN_ENDED),
    );
  });

  it("refuses a seat that is neither FLIGHT nor a planner, and bad issue numbers", async () => {
    live("guido-1", "r-guido");
    expect(await call("read_ticket", { issue: 1 }, ctx("guido-1", "r-guido"))).toEqual(
      refused(MC_TICKET_READERS_ONLY),
    );
    for (const bad of [0, 1.5, 2 ** 31, "1"]) {
      expect((await call("read_ticket", { issue: bad })).text.startsWith(MC_BAD_ARGS)).toBe(true);
    }
  });
});

describe("answer_question", () => {
  const ask = (agentId = "guido-1", runId = "r-guido") => {
    live(agentId, runId);
    return store.addQuestion({ agentId, runId, text: "Which lane?", at: NOW });
  };
  const A = (id: number, over: Record<string, unknown> = {}) => ({
    question_id: id,
    answer: "Lane 2",
    basis: "the ticket",
    ...over,
  });

  it("messages the seat, records the answer and emits flight", async () => {
    const id = ask();
    expect(await call("answer_question", A(id))).toEqual({ text: "Answered GUIDO-1." });
    expect(messageCalls).toEqual([
      [
        "guido-1",
        "FLIGHT, answering for the operator: Lane 2",
        { interrupt: false, questions: "unpassed" },
      ],
    ]);
    expect(decisions()).toEqual([
      {
        id: 1,
        at: NOW,
        kind: "answer",
        seatId: "guido-1",
        targetRunId: null,
        ref: null,
        questionId: id,
        about: "GUIDO-1: Which lane?",
        decision: "Lane 2",
        basis: "the ticket",
      },
    ]);
    expect(seen).toContain("flight");
  });

  it("returns a send failure and records nothing", async () => {
    const id = ask();
    messageImpl = async () => {
      throw new Error("seat is gone");
    };
    expect(await call("answer_question", A(id))).toEqual(refused("Not sent: seat is gone"));
    expect(decisions()).toEqual([]);
  });

  it("passes a question to the operator without a message", async () => {
    const id = ask();
    const r = await call("answer_question", {
      question_id: id,
      pass_to_operator: true,
      basis: "spend",
    });
    expect(r).toEqual({
      text: "Passed to the operator. It is in the operator's Needs-you list now; your basis is in Decided without you.",
    });
    expect(store.question(id)?.passedAt).toBe(NOW);
    expect(messageCalls).toEqual([]);
    expect(seen).toContain("attention");
    expect(decisions()).toMatchObject([
      { kind: "pass", seatId: "guido-1", questionId: id, decision: "Passed to the operator" },
    ]);
    // a passed question is no longer open to FLIGHT
    expect((await call("answer_question", A(id))).text).toBe(
      `Not answered: there is no open question ${id}.`,
    );
  });

  it("refuses both fields, or neither", async () => {
    const id = ask();
    for (const bad of [A(id, { pass_to_operator: true }), { question_id: id, basis: "b" }]) {
      expect(await call("answer_question", bad)).toEqual(
        refused(`${MC_BAD_ARGS}give answer or pass_to_operator, not both`),
      );
    }
  });

  it("refuses an unknown or answered question", async () => {
    expect(await call("answer_question", A(99))).toEqual(
      refused("Not answered: there is no open question 99."),
    );
    const id = ask();
    store.answerQuestions("guido-1", NOW);
    expect((await call("answer_question", A(id))).text).toBe(
      `Not answered: there is no open question ${id}.`,
    );
  });

  it("refuses a question from a seat outside FLIGHT's session", async () => {
    cfg.crew?.sessions.push({
      id: "s2",
      repoId: "mc",
      checkout: "/tmp/none/clone2",
      seats: [seat("guido-2", "GUIDO")],
    });
    const id = ask("guido-2", "r-guido2");
    expect(await call("answer_question", A(id))).toEqual(
      refused(`Not answered: there is no open question ${id}.`),
    );
    expect(messageCalls).toEqual([]);
    expect(store.question(id)?.answeredAt).toBeNull();
  });

  it("applies the per-seat message cap to the asker", async () => {
    const id = ask();
    for (let i = 0; i < 6; i++) addDecision({ kind: "message", seatId: "guido-1" });
    expect((await call("answer_question", A(id))).isError).toBe(true);
    expect(messageCalls).toEqual([]);
  });

  it("keeps a passed question open through later FLIGHT messages and answers", async () => {
    const passed = ask();
    await call("answer_question", { question_id: passed, pass_to_operator: true, basis: "spend" });
    const other = store.addQuestion({
      agentId: "guido-1",
      runId: "r-guido",
      text: "Two?",
      at: NOW,
    });
    await call("answer_question", A(other));
    expect(messageCalls.at(-1)?.[2]).toEqual({ interrupt: false, questions: "unpassed" });
    // what the supervisor does with that option
    store.answerQuestions("guido-1", NOW, true);
    expect(store.question(passed)?.answeredAt).toBeNull();
    expect(store.question(other)?.answeredAt).toBe(NOW);
  });

  it("refuses FLIGHT's own question", async () => {
    const id = store.addQuestion({ agentId: "flight-1", runId: "r-flight", text: "q", at: NOW });
    expect(await call("answer_question", A(id))).toEqual(
      refused("Not answered: that is your own question to the operator."),
    );
  });

  it("refuses when the asking run has ended", async () => {
    const id = ask();
    store.upsertRun(run("r-guido", "guido-1", { endedAt: NOW, status: "ok" }));
    expect(await call("answer_question", A(id))).toEqual(
      refused("Not answered: the run of GUIDO-1 that asked it has ended."),
    );
  });

  it("caps answers at 30 messages an hour, but still passes", async () => {
    const id = ask();
    for (let i = 0; i < 30; i++) addDecision({});
    expect(await call("answer_question", A(id))).toEqual(
      refused(
        "Not done: you sent messages 30 times in the last hour, the most allowed. Wait, or ask the operator.",
      ),
    );
    expect(messageCalls).toEqual([]);
    const pass = { question_id: id, pass_to_operator: true, basis: "b" };
    expect((await call("answer_question", pass)).isError).toBeUndefined();
  });
});

describe("start_seat", () => {
  const start = (over: Record<string, unknown> = {}) =>
    call("start_seat", { seat: "guido-1", issue: 7, basis: "ready", ...over });

  // a card and a body that pass the start check: a Size and a Done when section
  const sc = (n: number, over: Partial<BoardItem> = {}) => card(n, { size: "S", ...over });
  const DONE = "## Done when\n\n- it works\n";

  beforeEach(() => {
    board(sc(7));
    fetchImpl = async (n) => ticket(n, { body: DONE });
  });

  it("starts the seat with the loop when the engine is on", async () => {
    engineOn = true;
    expect(await start()).toEqual({ text: "Started GUIDO-1 on mc#7." });
    expect(startCalls).toEqual([["guido-1", 7, { loop: NEW_LOOP }]]);
    expect(decisions()).toMatchObject([
      {
        kind: "start",
        seatId: "guido-1",
        ref: "mc#7",
        about: "mc#7: Ticket 7",
        decision: "Started GUIDO-1",
        basis: "ready",
      },
    ]);
    expect(seen).toEqual(expect.arrayContaining(["agents", "flight"]));
  });

  it("starts with no options when the engine is off", async () => {
    await start();
    expect(startCalls).toEqual([["guido-1", 7, undefined]]);
  });

  it("refuses a card assigned to another login, and starts one assigned to the hub", async () => {
    board(sc(7, { assignees: ["other"] }));
    expect(await start()).toEqual(
      refused("Not started: mc#7 is assigned to other; another hub or person has it."),
    );
    expect(startCalls).toEqual([]);
    board(sc(7, { assignees: ["me"] }));
    expect((await start()).isError).toBeUndefined();
    expect(startCalls).toHaveLength(1);
  });

  it("refuses a seat outside its session", async () => {
    expect(await start({ seat: "nobody-9" })).toEqual(
      refused("Not done: nobody-9 is not a seat in your session."),
    );
  });

  describe("areas", () => {
    beforeEach(() => {
      rulesNow = {
        ...DEFAULT_REPO_RULES,
        areas: { "area:server": ["apps/server/**"], "area:web": ["apps/web/**"] },
      };
    });

    it("refuses a card whose area is not the seat's", async () => {
      board(sc(7, { labels: ["area:server"] }));
      expect(await start({ seat: "inco-1" })).toEqual(
        refused("Not started: mc#7 is in area:server, not INCO-1's area."),
      );
      expect(startCalls).toEqual([]);
      board(sc(7, { labels: ["area:web"] }));
      expect((await start({ seat: "inco-1" })).isError).toBeUndefined();
    });

    it("refuses a card with two area labels", async () => {
      board(sc(7, { labels: ["area:server", "area:web"] }));
      expect(await start()).toEqual(
        refused(
          "Not started: mc#7 spans two areas (area:server, area:web); ask the operator to split it.",
        ),
      );
      expect(startCalls).toEqual([]);
    });
  });

  it("1: refuses a seat that is not a developer seat", async () => {
    expect(await start({ seat: "retro-1" })).toEqual(
      refused("Not started: RETRO-1 is not a developer or planner seat."),
    );
  });

  it("2: starts in a merge repo, with every other check still applying", async () => {
    const repo = cfg.repos[0];
    if (repo === undefined) throw new Error("no repo");
    repo.autonomy = "merge";
    expect(await start()).toEqual({ text: "Started GUIDO-1 on mc#7." });
    expect(startCalls).toHaveLength(1);
    board(sc(8, { blockedBy: [{ ref: "mc#9", closed: false }] }));
    expect(await start({ issue: 8 })).toEqual(refused("Not started: mc#8 waits on mc#9."));
  });

  it("refuses a ticket the engine has taken for another seat, in a merge repo", async () => {
    const repo = cfg.repos[0];
    if (repo === undefined) throw new Error("no repo");
    repo.autonomy = "merge";
    store.replaceQueue("inco-1", [{ repoId: "mc", issue: 7 }]);
    store.takeQueued("inco-1", NOW);
    expect(await start()).toEqual(refused("Not started: mc#7 already has a run."));
    expect(startCalls).toEqual([]);
  });

  it("3: refuses a seat with a run, or busy", async () => {
    busyNow = [{ seatId: "guido-1", state: "starting" }];
    expect(await start()).toEqual(refused("Not started: GUIDO-1 already has a run."));
    busyNow = [];
    live("guido-1", "r-g");
    expect(await start()).toEqual(refused("Not started: GUIDO-1 already has a run."));
  });

  it("4: refuses an account at its usage stop", async () => {
    store.addUsage({
      accountId: "claude-main",
      window: "5h",
      at: NOW,
      pct: 96,
      resetAt: NOW + 1000,
      source: "t",
    });
    expect(await start()).toEqual(
      refused("Not started: GUIDO-1's account claude-main is at its usage stop."),
    );
  });

  it("5: caps starts at 4 an hour per developer seat (8 with two)", async () => {
    for (let i = 0; i < 7; i++) addDecision({ kind: "start", ref: `mc#${100 + i}` });
    expect((await start()).isError).toBeUndefined();
    expect(await start({ issue: 6 })).toEqual(
      refused(
        "Not done: you started tickets 8 times in the last hour, the most allowed. Wait, or ask the operator.",
      ),
    );
  });

  it("5: keeps the cap at 4 an hour with one developer seat", async () => {
    const seats = cfg.crew?.sessions[0]?.seats ?? [];
    seats.splice(
      seats.findIndex((s) => s.id === "inco-1"),
      1,
    );
    for (let i = 0; i < 4; i++) addDecision({ kind: "start", ref: `mc#${100 + i}` });
    expect(await start()).toEqual(
      refused(
        "Not done: you started tickets 4 times in the last hour, the most allowed. Wait, or ask the operator.",
      ),
    );
  });

  it("6: refuses the same ticket within 24 hours", async () => {
    await start();
    nowMs += 2 * 60 * 60_000;
    expect(await start()).toEqual(
      refused(
        "Not started: you started mc#7 in the last 24 hours; ask the operator before starting it again.",
      ),
    );
    nowMs += 25 * 60 * 60_000;
    expect((await start()).isError).toBeUndefined();
  });

  it("7: refuses a card that is missing, in the wrong column, active or blocked", async () => {
    expect(await start({ issue: 8 })).toEqual(refused("Not started: mc#8 is not on the board."));
    board(sc(7, { status: "In progress", state: "in progress" }));
    expect(await start()).toEqual(refused("Not started: mc#7 is in In progress."));
    board(sc(7));
    live("inco-1", "r-i", { ticket: "mc#7" });
    expect(await start()).toEqual(refused("Not started: mc#7 already has a run."));
    store.upsertRun(run("r-i", "inco-1", { ticket: "mc#7", endedAt: NOW, status: "ok" }));
    board(
      sc(7, {
        blockedBy: [
          { ref: "mc#3", closed: false },
          { ref: "mc#4", closed: true },
          { ref: "mc#5", closed: false },
        ],
      }),
    );
    expect(await start()).toEqual(refused("Not started: mc#7 waits on mc#3, mc#5."));
  });

  it("8: needs a Ready column, the ready label or a Plan section", async () => {
    board(sc(7, { status: "Backlog" }));
    fetchImpl = async (n) => ticket(n, { body: `${DONE}just words\n## Planning\n` });
    expect(await start()).toEqual(
      refused("Not started: mc#7 has no ## Plan section, no ready label, and is not in Ready."),
    );
    fetchImpl = async () => {
      throw new Error("net");
    };
    expect(await start()).toEqual(refused("Not started: GitHub could not be reached."));
    expect(startCalls).toEqual([]);
    // the label, with the body read once for the start check
    fetchCalls.length = 0;
    fetchImpl = async (n) => ticket(n, { body: DONE });
    board(sc(7, { status: "Backlog", labels: ["ready"] }));
    expect((await start()).isError).toBeUndefined();
    expect(fetchCalls).toEqual([7]);
  });

  it("starts a Backlog card with a Plan section in its body", async () => {
    board(sc(7, { status: "Backlog" }));
    fetchImpl = async (n) => ticket(n, { body: `${DONE}Intro\n## Plan\nsteps` });
    expect(await start()).toEqual({ text: "Started GUIDO-1 on mc#7." });
  });

  it("returns a refused start's own text, and a generic one for any other failure", async () => {
    startImpl = async () => {
      throw new SupervisorError(409, "rework first");
    };
    expect(await start()).toEqual(refused("Not started: rework first"));
    startImpl = async () => {
      throw new Error("/secret/path");
    };
    expect(await start()).toEqual(refused("Not started: the start failed."));
    expect(decisions()).toEqual([]);
  });

  it("returns the supervisor's 422 text as it is", async () => {
    startImpl = async () => {
      throw new SupervisorError(422, "Not started: mc#7 is not on the board.");
    };
    expect(await start()).toEqual(refused("Not started: mc#7 is not on the board."));
  });

  it("refuses when GitHub cannot be reached for the ticket", async () => {
    fetchImpl = async () => {
      throw new Error("net");
    };
    expect(await start()).toEqual(refused("Not started: GitHub could not be reached."));
    expect(startCalls).toEqual([]);
  });

  describe("the shared start check", () => {
    const AREAS = { "area:server": ["apps/server/**"], "area:web": ["apps/web/**"] };
    const nothingStarted = async (text: string) => {
      expect(await start()).toEqual(refused(text));
      expect(startCalls).toEqual([]);
    };
    beforeEach(() => {
      rulesNow = { ...DEFAULT_REPO_RULES, areas: AREAS };
      board(sc(7, { labels: ["area:server"] }));
    });

    it("1: another lane", async () => {
      const crew = cfg.crew;
      if (crew === undefined) throw new Error("no crew");
      crew.lane = "work";
      board(sc(7, { labels: ["area:server", "lane:home"] }));
      await nothingStarted(
        "Not started: mc#7 has lane:home; this hub starts only lane:work cards.",
      );
    });

    it("2: two areas", async () => {
      board(sc(7, { labels: ["area:server", "area:web"] }));
      await nothingStarted(twoAreasText("mc#7", ["area:server", "area:web"]));
    });

    it("3: no area label", async () => {
      board(sc(7, { labels: [] }));
      await nothingStarted("Not started: mc#7 has no area label.");
    });

    it("4: another seat's area", async () => {
      board(sc(7, { labels: ["area:server"] }));
      expect(await start({ seat: "inco-1" })).toEqual(
        refused(wrongAreaText("INCO-1", "mc#7", ["area:server"])),
      );
      expect(startCalls).toEqual([]);
    });

    it("5: a ticket with a run", async () => {
      live("inco-1", "r-i", { ticket: "mc#7" });
      await nothingStarted(ticketHasRunText("mc#7"));
    });

    it("6: a card assigned to another login", async () => {
      board(sc(7, { labels: ["area:server"], assignees: ["other"] }));
      await nothingStarted(claimedText("mc#7", ["other"]));
    });

    it("7: an open blocker, or an open Depends on issue", async () => {
      board(sc(7, { labels: ["area:server"], blockedBy: [{ ref: "mc#3", closed: false }] }));
      await nothingStarted(waitsOnText("mc#7", ["mc#3"]));
      board(sc(7, { labels: ["area:server"] }), sc(5, { closed: true }), sc(6));
      fetchImpl = async (n) => ticket(n, { body: `${DONE}Depends on #5, #6\n` });
      await nothingStarted(waitsOnText("mc#7", ["mc#6"]));
    });

    it("8: a research ticket", async () => {
      board(sc(7, { labels: ["area:server", "research"] }));
      await nothingStarted(researchText("mc#7"));
    });

    it("9: a missing Done when or Size", async () => {
      fetchImpl = async (n) => ticket(n, { body: "text" });
      board(sc(7, { labels: ["area:server"], size: null }));
      await nothingStarted(startMissingNeedsText("mc#7", ["done_when", "size"]));
    });

    it("10: Size M with no plan", async () => {
      board(sc(7, { labels: ["area:server"], size: "M" }));
      await nothingStarted(startNeedsPlanText("mc#7", "M"));
    });
  });
});

describe("start_seat planner", () => {
  const plan = (over: Record<string, unknown> = {}) =>
    call("start_seat", { seat: "fao-1", issue: 7, basis: "complete", ...over });
  const GOOD = "Body\n\n## Done when\n\n- it works\n";
  const sized = (over: Partial<BoardItem> = {}) =>
    card(7, { status: "Backlog", labels: [], size: "M", ...over });

  beforeEach(() => {
    const mc = cfg.repos[0];
    if (mc === undefined) throw new Error("no repo");
    mc.autonomy = "merge";
    engineOn = true;
    board(sized());
    fetchImpl = async (n) => ticket(n, { body: GOOD });
  });

  it("starts the planner with no loop on a complete Size M Backlog ticket", async () => {
    expect(await plan()).toEqual({ text: "Started FAO-1 on mc#7." });
    expect(startCalls).toEqual([["fao-1", 7]]);
    expect(decisions()).toMatchObject([
      { kind: "start", seatId: "fao-1", ref: "mc#7", decision: "Started FAO-1 to plan" },
    ]);
  });

  it("a planner start does not hold back a developer start on the same ticket", async () => {
    const mc = cfg.repos[0];
    if (mc === undefined) throw new Error("no repo");
    mc.autonomy = "draft";
    expect(await plan()).toEqual({ text: "Started FAO-1 on mc#7." });
    nowMs += 60 * 60_000;
    board(sized({ status: "Ready" }));
    fetchImpl = async (n) => ticket(n, { body: `${GOOD}\n## Plan\n\n1. do\n` });
    expect(
      await call("start_seat", { seat: "guido-1", issue: 7, basis: "planned, ready" }),
    ).toEqual({ text: "Started GUIDO-1 on mc#7." });
    expect(startCalls.map((c) => c.slice(0, 2))).toEqual([
      ["fao-1", 7],
      ["guido-1", 7],
    ]);
  });

  it("refuses a ticket that has a plan", async () => {
    fetchImpl = async (n) => ticket(n, { body: `${GOOD}\n## Plan\n\n1. do\n` });
    expect(await plan()).toEqual(refused("Not started: mc#7 already has a ## Plan."));
    expect(startCalls).toEqual([]);
  });

  it("refuses a body with an unclosed code fence", async () => {
    fetchImpl = async (n) => ticket(n, { body: `${GOOD}\n\`\`\`\ncode\n` });
    expect(await plan()).toEqual(
      refused(
        "Not started: mc#7 has an unclosed code block, so a plan cannot be added; ask the operator to fix the body.",
      ),
    );
  });

  it("refuses a ticket missing its needs", async () => {
    fetchImpl = async (n) => ticket(n, { body: "No sections" });
    expect(await plan()).toEqual(
      refused("Not started: mc#7 has no done_when; move it to Refinement and ask for it."),
    );
    board(sized({ size: null }));
    expect((await plan()).text).toContain("no done_when or size");
  });

  it("a start by a seat no longer in the config still holds back a restart", async () => {
    addDecision({ at: nowMs - 60 * 60_000, kind: "start", seatId: "guido-9", ref: "mc#7" });
    expect(await plan()).toEqual(
      refused(
        "Not started: you started mc#7 in the last 24 hours; ask the operator before starting it again.",
      ),
    );
  });

  it("refuses a ticket with no Size even when the repo does not need one", async () => {
    const mc = cfg.repos[0];
    if (mc === undefined) throw new Error("no repo");
    rulesNow = { ...rulesNow, needs: ["done_when"] };
    board(sized({ size: null }));
    expect(await plan()).toEqual(
      refused("Not started: mc#7 has no size; move it to Refinement and ask for it."),
    );
    expect(startCalls).toEqual([]);
  });

  it("refuses Size S", async () => {
    board(sized({ size: "S" }));
    expect(await plan()).toEqual(
      refused("Not started: mc#7 is Size S; small tickets need no plan, so promote it to Ready."),
    );
    expect(startCalls).toEqual([]);
  });

  it("refuses a card with two areas", async () => {
    rulesNow = {
      ...DEFAULT_REPO_RULES,
      areas: { "area:server": ["apps/server/**"], "area:web": ["apps/web/**"] },
    };
    board(sized({ labels: ["area:server", "area:web"] }));
    expect((await plan()).text).toContain("spans two areas");
    expect(startCalls).toEqual([]);
  });

  it("refuses at the hourly cap", async () => {
    for (let i = 0; i < 8; i++) addDecision({ kind: "start", ref: `mc#${100 + i}` });
    expect((await plan()).text).toContain("started tickets 8 times");
    expect(startCalls).toEqual([]);
  });

  it("starts a build seat as before, and refuses a watch seat", async () => {
    const mc = cfg.repos[0];
    if (mc !== undefined) mc.autonomy = "draft";
    board(card(7, { size: "S" }));
    expect((await call("start_seat", { seat: "guido-1", issue: 7, basis: "b" })).isError).toBe(
      undefined,
    );
    expect(startCalls).toEqual([["guido-1", 7, { loop: NEW_LOOP }]]);
    expect(await call("start_seat", { seat: "flight-1", issue: 7, basis: "b" })).toEqual(
      refused("Not started: FLIGHT-1 is not a developer or planner seat."),
    );
  });
});

describe("message_seat", () => {
  const M = (over: Record<string, unknown> = {}) => ({
    seat: "guido-1",
    text: "Please push",
    basis: "idle",
    ...over,
  });

  it("sends with the FLIGHT prefix and records it", async () => {
    expect(await call("message_seat", M())).toEqual({ text: "Sent to GUIDO-1." });
    expect(messageCalls).toEqual([
      ["guido-1", "FLIGHT: Please push", { interrupt: false, questions: "none" }],
    ]);
    expect(decisions()).toMatchObject([
      {
        kind: "message",
        seatId: "guido-1",
        about: "Message to GUIDO-1",
        decision: "Please push",
        basis: "idle",
      },
    ]);
    expect(seen).toContain("flight");
  });

  it("asks the supervisor to close no questions", async () => {
    await call("message_seat", M());
    expect(messageCalls[0]?.[2]).toEqual({ interrupt: false, questions: "none" });
  });

  it("refuses its own seat, RETRO and a stranger", async () => {
    expect(await call("message_seat", M({ seat: "flight-1" }))).toEqual(
      refused("Not sent: that is your own seat."),
    );
    expect(await call("message_seat", M({ seat: "retro-1" }))).toEqual(
      refused(
        "Not sent: RETRO-1 reviews what Mission Control hands it; it takes no messages from you.",
      ),
    );
    expect((await call("message_seat", M({ seat: "x-1" }))).text).toBe(
      "Not done: x-1 is not a seat in your session.",
    );
    expect(messageCalls).toEqual([]);
  });

  it("caps messages to one seat at 6 an hour", async () => {
    for (let i = 0; i < 6; i++) expect((await call("message_seat", M())).isError).toBeUndefined();
    expect(await call("message_seat", M())).toEqual(
      refused("Not sent: you sent GUIDO-1 6 messages in the last hour, the most allowed."),
    );
    expect((await call("message_seat", M({ seat: "inco-1" }))).isError).toBeUndefined();
  });

  it("caps all messages at 30 an hour", async () => {
    for (let i = 0; i < 30; i++) addDecision({ kind: "unpark", seatId: `s-${i}` });
    expect((await call("message_seat", M())).text).toBe(
      "Not done: you sent messages 30 times in the last hour, the most allowed. Wait, or ask the operator.",
    );
  });

  it("returns a send failure", async () => {
    messageImpl = async () => {
      throw new Error("no process");
    };
    expect(await call("message_seat", M())).toEqual(refused("Not sent: no process"));
    expect(decisions()).toEqual([]);
  });
});

describe("message_seat unpark", () => {
  const U = (over: Record<string, unknown> = {}) => ({
    seat: "guido-1",
    text: "Carry on",
    unpark: true,
    basis: "silent",
    ...over,
  });
  const parked = (kind = "silent", ended = false) => {
    live("guido-1", "r-g");
    const loop: RunLoop = {
      ...NEW_LOOP,
      phase: "parked",
      parked: { kind, reason: "went quiet", ended },
    };
    store.setRunLoop("r-g", loop);
  };
  beforeEach(() => {
    engineOn = true;
  });

  it("un-parks a silent park by FLIGHT", async () => {
    parked("silent");
    expect(await call("message_seat", U())).toEqual({
      text: "Sent to GUIDO-1, and its run is un-parked.",
    });
    expect(messageCalls).toEqual([
      ["guido-1", "FLIGHT: Carry on", { interrupt: false, questions: "none" }],
    ]);
    expect(engineCalls).toEqual([["r-g", "FLIGHT", { kinds: FLIGHT_UNPARK_KINDS }]]);
    expect(decisions()).toMatchObject([
      {
        kind: "unpark",
        seatId: "guido-1",
        targetRunId: "r-g",
        about: "GUIDO-1: went quiet",
        decision: "Carry on",
      },
    ]);
  });

  it("records a message when the engine did not un-park", async () => {
    parked("silent");
    lifts = false;
    expect(await call("message_seat", U())).toEqual({ text: "Sent to GUIDO-1." });
    expect(engineCalls).toEqual([["r-g", "FLIGHT", { kinds: FLIGHT_UNPARK_KINDS }]]);
    expect(decisions()).toMatchObject([{ kind: "message", seatId: "guido-1" }]);
  });

  it("leaves a budget park to the operator", async () => {
    parked("budget");
    expect(await call("message_seat", U())).toEqual(
      refused(
        "Not sent: a budget park is the operator's call; pass it to them with mc ask_operator.",
      ),
    );
    expect(messageCalls).toEqual([]);
  });

  it.each(["review", "review-ruling", "ruling"])(
    "leaves a %s park to the operator",
    async (kind) => {
      parked(kind);
      expect((await call("message_seat", U())).isError).toBe(true);
      expect(messageCalls).toEqual([]);
      expect(engineCalls).toEqual([]);
    },
  );

  it.each(["nothing", "gate", "conflict", "review-failed"])("lifts a %s park", async (kind) => {
    parked(kind);
    expect(await call("message_seat", U())).toEqual({
      text: "Sent to GUIDO-1, and its run is un-parked.",
    });
  });

  it("leaves an ended park to the operator", async () => {
    parked("silent", true);
    expect((await call("message_seat", U())).text).toBe(
      "Not sent: a silent park is the operator's call; pass it to them with mc ask_operator.",
    );
  });

  it("refuses a run that is not parked, or no run", async () => {
    expect(await call("message_seat", U())).toEqual(
      refused("Not sent: GUIDO-1's run is not parked."),
    );
    live("guido-1", "r-g");
    store.setRunLoop("r-g", NEW_LOOP);
    expect((await call("message_seat", U())).text).toBe("Not sent: GUIDO-1's run is not parked.");
  });

  it("caps the 3rd un-park of a run", async () => {
    parked("ci");
    for (let i = 0; i < 2; i++) {
      addDecision({
        at: NOW - 48 * 60 * 60_000,
        kind: "unpark",
        seatId: "guido-1",
        targetRunId: "r-g",
      });
    }
    expect(await call("message_seat", U())).toEqual(
      refused(
        "Not sent: you have un-parked this run 2 times; pass it to the operator with mc ask_operator.",
      ),
    );
  });

  it("refuses with the engine off", async () => {
    parked("silent");
    engineOn = false;
    expect(await call("message_seat", U())).toEqual(
      refused("Not sent: the loop engine is off on this server, so nothing can be un-parked."),
    );
    expect(messageCalls).toEqual([]);
  });
});

describe("end_run", () => {
  const E = (over: Record<string, unknown> = {}) => ({
    seat: "guido-1",
    basis: "its ticket needs a docs note the planning lane wrote",
    ...over,
  });
  const parked = (kind = "nothing") => {
    live("guido-1", "r-g", { ticket: "mc#7" });
    store.setRunLoop("r-g", {
      ...NEW_LOOP,
      phase: "parked",
      parked: { kind, reason: "nothing to push", ended: false },
    });
  };

  it("ends a parked run and leaves the seat idle, with its basis recorded", async () => {
    parked();
    expect((await call("end_run", E())).isError).toBeUndefined();
    expect(endCalls).toEqual(["guido-1"]);
    expect(store.run("r-g")?.endedAt).not.toBeNull();
    expect(store.seatSession("guido-1")).toMatchObject({ state: "idle", runId: null });
    expect(seatFree(store, [], "guido-1")).toBe(true);
    expect(decisions()).toMatchObject([
      {
        kind: "end",
        seatId: "guido-1",
        targetRunId: "r-g",
        basis: "its ticket needs a docs note the planning lane wrote",
      },
    ]);
    expect(seen).toEqual(expect.arrayContaining(["agents", "flight"]));
  });

  it("refuses a run that is still working, and a seat with no run", async () => {
    live("guido-1", "r-g");
    store.setRunLoop("r-g", NEW_LOOP);
    expect((await call("end_run", E())).isError).toBe(true);
    store.upsertRun(run("r-g", "guido-1", { endedAt: NOW, status: "ok" }));
    expect((await call("end_run", E())).isError).toBe(true);
    expect(endCalls).toEqual([]);
    expect(decisions()).toEqual([]);
  });

  it("refuses FLIGHT's own seat, a seat outside the session and a non-developer seat", async () => {
    expect((await call("end_run", E({ seat: "flight-1" }))).isError).toBe(true);
    expect(await call("end_run", E({ seat: "nobody-9" }))).toEqual(
      refused("Not done: nobody-9 is not a seat in your session."),
    );
    expect(await call("end_run", E({ seat: "retro-1" }))).toEqual(
      refused("Not ended: RETRO-1 is not a developer seat."),
    );
    expect(endCalls).toEqual([]);
  });

  it("caps ends an hour", async () => {
    parked();
    for (let i = 0; i < 6; i++) addDecision({ at: NOW - 1000, kind: "end", seatId: "guido-1" });
    expect((await call("end_run", E())).isError).toBe(true);
    expect(endCalls).toEqual([]);
  });

  it("reports a failed end and records nothing", async () => {
    parked();
    endImpl = async () => {
      throw new Error("boom");
    };
    expect(await call("end_run", E())).toEqual(refused("Not ended: boom"));
    expect(decisions()).toEqual([]);
  });
});

describe("flight_state", () => {
  const state = async () => JSON.parse((await call("flight_state", {})).text) as unknown;

  it("is FLIGHT's alone, read-only and takes no arguments", async () => {
    expect(named("flight_state")).toMatchObject({ modes: [], grantable: ["read-only"] });
    live("guido-1", "r-guido");
    expect(await call("flight_state", {}, ctx("guido-1", "r-guido"))).toEqual({
      text: MC_FLIGHT_ONLY,
      isError: true,
    });
    expect((await call("flight_state", { x: 1 })).isError).toBe(true);
  });

  it("lists a merged PR the first time FLIGHT reads it, and not again", async () => {
    store.upsertPullRequests(
      "mc",
      [
        {
          repoId: "mc",
          number: 9,
          title: "PR 9",
          url: "u",
          branch: "feature/7-x",
          ticket: "mc#7",
          state: "merged",
          isDraft: false,
          review: null,
          ci: null,
          createdAt: NOW,
          updatedAt: NOW,
          mergedAt: NOW,
          headSha: "abc",
          mergeable: null,
          author: null,
          assignees: [],
        },
      ],
      NOW,
    );
    const prs = async () => ((await state()) as { prs: unknown[] }).prs;
    expect(await prs()).toMatchObject([{ pr: 9, state: "merged" }]);
    expect(await prs()).toEqual([]);
  });

  it("lists a stopped seat", async () => {
    store.setSeatSession({ ...row("guido-1", ""), runId: null, state: "stopped" });
    const seats = ((await state()) as { seats: { id: string; state: string; free: boolean }[] })
      .seats;
    expect(seats.find((x) => x.id === "guido-1")).toMatchObject({ state: "stopped", free: true });
  });

  it("answers the crew now", async () => {
    live("inco-1", "r-inco", { ticket: "mc#5" });
    store.setRunLoop("r-inco", {
      ...NEW_LOOP,
      phase: "parked",
      parked: { kind: FLIGHT_UNPARK_KINDS[0], reason: "budget", ended: false },
    });
    store.setSeatTurnEnded("inco-1", NOW - 7 * 60_000);
    store.addQuestion({
      agentId: "inco-1",
      runId: "r-inco",
      text: "Which lane?",
      at: NOW - 5 * 60_000,
    });
    // asked in a run that has since ended: not listed
    store.upsertRun(run("r-old", "guido-1", { endedAt: NOW - 1000, status: "ok" }));
    store.addQuestion({ agentId: "guido-1", runId: "r-old", text: "Old?", at: NOW - 9 * 60_000 });
    store.upsertRun(run("r-pr", "guido-1", { ticket: "mc#7" }));
    store.setRunLoop("r-pr", { ...NEW_LOOP, phase: "review", prNumber: 9 });
    store.upsertPullRequests(
      "mc",
      [
        {
          repoId: "mc",
          number: 9,
          title: "PR 9",
          url: "u",
          branch: "feature/7-x",
          ticket: "mc#7",
          state: "open",
          isDraft: false,
          review: null,
          ci: null,
          createdAt: NOW,
          updatedAt: NOW,
          mergedAt: null,
          headSha: "abc",
          mergeable: null,
          author: null,
          assignees: [],
        },
      ],
      NOW,
    );
    store.raiseNote({
      key: "ready:r-pr",
      kind: "ready",
      runId: "r-pr",
      seatId: "guido-1",
      repoId: "mc",
      text: "ready",
      at: NOW,
    });
    board(
      card(1, { priority: "P1", blockedBy: [{ ref: "mc#8", closed: true }] }),
      card(2, { status: "Backlog", labels: ["ready"], priority: "P0" }),
      card(3, { status: "In progress" }),
      card(4, { blockedBy: [{ ref: "mc#9", closed: false }] }),
      card(6, { priority: "P1", createdAt: NOW - 1000 }),
    );
    addDecision({ kind: "message", about: "Message to GUIDO-1", decision: "go on" });
    const bare = {
      state: null,
      ticket: null,
      title: null,
      phase: null,
      parked: null,
      stalled: false,
      idleMin: null,
      openQuestion: false,
      atStop: false,
    };
    expect(await state()).toEqual({
      time: "13:00",
      repo: "mc",
      seats: [
        {
          ...bare,
          id: "fao-1",
          call: "FAO-1",
          role: "FAO",
          loop: "plan",
          area: [],
          free: true,
        },
        {
          ...bare,
          id: "guido-1",
          call: "GUIDO-1",
          role: "GUIDO",
          loop: "build",
          area: ["apps/**"],
          free: true,
          openQuestion: true,
        },
        {
          ...bare,
          id: "inco-1",
          call: "INCO-1",
          role: "INCO",
          loop: "build",
          area: ["apps/web/**"],
          free: false,
          state: "idle",
          idleMin: 7,
          ticket: "mc#5",
          phase: "parked",
          parked: { kind: FLIGHT_UNPARK_KINDS[0], reason: "budget" },
          openQuestion: true,
        },
        {
          ...bare,
          id: "retro-1",
          call: "RETRO-1",
          role: "RETRO",
          loop: "review",
          area: [],
          free: true,
        },
      ],
      questions: [{ id: 1, seat: "inco-1", ticket: "mc#5", text: "Which lane?", ageMin: 5 }],
      tickets: [
        {
          ref: "mc#2",
          title: "Ticket 2",
          column: "Backlog",
          priority: "P0",
          labels: ["ready"],
          ready: true,
          blockedBy: [],
        },
        {
          ref: "mc#6",
          title: "Ticket 6",
          column: "Ready",
          priority: "P1",
          labels: [],
          ready: true,
          blockedBy: [],
        },
        {
          ref: "mc#1",
          title: "Ticket 1",
          column: "Ready",
          priority: "P1",
          labels: [],
          ready: true,
          blockedBy: ["mc#8"],
        },
      ],
      prs: [
        {
          ref: "mc#7",
          pr: 9,
          seat: "guido-1",
          ready: true,
          state: "open",
          headSha: "abc",
          readAt: "13:00",
          stale: false,
        },
      ],
      recent: [{ time: "12:59", kind: "message", about: "Message to GUIDO-1", decision: "go on" }],
      limits: { startsLeft: 8, messagesLeft: 29 },
    });
  });

  it("counts starts left against the per-developer-seat cap", async () => {
    for (let i = 0; i < 4; i++) addDecision({ kind: "start", ref: `mc#${100 + i}` });
    const s = (await state()) as { limits: { startsLeft: number } };
    expect(s.limits.startsLeft).toBe(4);
  });

  it("marks a silent running seat stalled, and every seat on an account at its stop", async () => {
    live("guido-1", "r-guido");
    store.setSeatSession({
      ...row("guido-1", "r-guido"),
      state: "running",
      updatedAt: NOW - 11 * 60_000,
    });
    for (const window of ["5h", "7d"] as const) {
      store.addUsage({
        accountId: "claude-main",
        window,
        at: NOW - 1000,
        pct: 95,
        resetAt: NOW + 60 * 60_000,
        source: "test",
      });
    }
    const s = (await state()) as { seats: { id: string; stalled: boolean; atStop: boolean }[] };
    expect(s.seats.map((x) => [x.id, x.stalled, x.atStop])).toEqual([
      ["fao-1", false, true],
      ["guido-1", true, true],
      ["inco-1", false, true],
      ["retro-1", false, true],
    ]);
  });
});

describe("promote", () => {
  const area = { "area:server": ["apps/server/**"], "area:web": ["apps/web/**"] };
  const GOOD = "Body\n\n## Done when\n\n- it works\n";
  const P = (over: Record<string, unknown> = {}) => ({
    issue: 7,
    to: "Ready",
    basis: "it is complete",
    ...over,
  });
  const backlog = (over: Partial<BoardItem> = {}) =>
    card(7, { status: "Backlog", labels: ["area:server"], size: "S", ...over });

  beforeEach(() => {
    const mc = cfg.repos[0];
    if (mc === undefined) throw new Error("no repo");
    mc.autonomy = "merge";
    engineOn = true;
    rulesNow = { ...DEFAULT_REPO_RULES, promoteBacklog: true, areas: area };
    fetchImpl = async (n) => ticket(n, { body: GOOD });
    board(backlog());
  });

  it("is shown only to a granted role", () => {
    expect(named("promote")).toMatchObject({ modes: [], grantable: ["read-only"] });
  });

  it("moves a complete Backlog ticket to Ready and records it", async () => {
    expect(await call("promote", P())).toEqual({
      text: "Moved mc#7 to Ready. Recorded in Decided without you.",
    });
    expect(moveCalls).toEqual([{ runId: "r-flight", repoId: "mc", issue: 7, column: "Ready" }]);
    expect(decisions()).toMatchObject([
      {
        kind: "promote",
        ref: "mc#7",
        about: "mc#7: Ticket 7",
        decision: "Moved to Ready",
        basis: "it is complete",
      },
    ]);
    expect(seen).toContain("flight");
  });

  it("refuses Size M with no plan for Ready, and moves it with a plan or at Size S", async () => {
    board(backlog({ size: "M" }));
    expect(await call("promote", P())).toEqual(
      refused(
        "Not moved: mc#7 is Size M and has no ## Plan; start the planner on it with mc start_seat first.",
      ),
    );
    expect(moveCalls).toEqual([]);
    fetchImpl = async (n) => ticket(n, { body: `${GOOD}\n## Plan\n\n1. do\n` });
    expect((await call("promote", P())).isError).toBeUndefined();
    fetchImpl = async (n) => ticket(n, { body: GOOD });
    board(backlog({ size: "S" }));
    expect((await call("promote", P())).isError).toBeUndefined();
    expect(moveCalls).toHaveLength(2);
  });

  it("refuses an incomplete ticket for Ready, then moves it to Refinement", async () => {
    fetchImpl = async (n) => ticket(n, { body: "No plan" });
    board(backlog({ size: null }));
    expect(await call("promote", P())).toEqual(
      refused("Not moved: mc#7 has no done_when or size; move it to Refinement and ask for it."),
    );
    expect(moveCalls).toEqual([]);
    expect((await call("promote", P({ to: "Refinement" }))).text).toBe(
      "Moved mc#7 to Refinement. Recorded in Decided without you.",
    );
    expect(moveCalls[0]?.column).toBe("Refinement");
  });

  it("names only what is missing, and honours the rules' needs", async () => {
    board(backlog({ size: null }));
    expect((await call("promote", P())).text).toBe(
      "Not moved: mc#7 has no size; move it to Refinement and ask for it.",
    );
    rulesNow = { ...rulesNow, needs: ["done_when"] };
    expect((await call("promote", P())).isError).toBeUndefined();
  });

  it("moves Refinement to Ready, and back to Backlog only after its own move", async () => {
    board(backlog({ status: "Refinement" }));
    expect((await call("promote", P())).isError).toBeUndefined();
    board(backlog({ status: "Ready" }));
    expect((await call("promote", P({ to: "Backlog" }))).isError).toBeUndefined();
    expect(moveCalls.map((m) => m.column)).toEqual(["Ready", "Backlog"]);
  });

  it("refuses an undo with no earlier promote", async () => {
    board(backlog({ status: "Ready" }));
    expect(await call("promote", P({ to: "Backlog" }))).toEqual(
      refused(
        "Not moved: mc#7 is in Ready; promote moves Backlog to Ready or Refinement, Refinement to Ready, and back to Backlog only a ticket you moved.",
      ),
    );
    expect(moveCalls).toEqual([]);
  });

  it("refuses an undo when only another ticket was promoted", async () => {
    addDecision({ kind: "promote", ref: "mc#8" });
    board(backlog({ status: "Ready" }));
    expect(await call("promote", P({ to: "Backlog" }))).toEqual(
      refused(
        "Not moved: mc#7 is in Ready; promote moves Backlog to Ready or Refinement, Refinement to Ready, and back to Backlog only a ticket you moved.",
      ),
    );
    expect(moveCalls).toEqual([]);
  });

  it("refuses a move from a column outside the pairs", async () => {
    board(backlog({ status: "In progress", state: "in progress" }));
    expect((await call("promote", P({ to: "Refinement" }))).text).toContain(
      "mc#7 is in In progress;",
    );
    board(backlog({ status: "Ready" }));
    expect((await call("promote", P({ to: "Refinement" }))).isError).toBe(true);
    board(backlog({ status: "Refinement" }));
    expect((await call("promote", P({ to: "Refinement" }))).isError).toBe(true);
    expect(moveCalls).toEqual([]);
  });

  it("refuses a bad argument or a stale run", async () => {
    expect((await call("promote", P({ to: "Done" }))).isError).toBe(true);
    expect((await call("promote", P({ basis: "" }))).isError).toBe(true);
    expect((await call("promote", P({ x: 1 }))).isError).toBe(true);
    expect(await call("promote", P(), ctx("guido-1", "r-guido"))).toEqual(refused(MC_RUN_ENDED));
  });

  it("refuses in a draft workspace", async () => {
    const mc = cfg.repos[0];
    if (mc !== undefined) mc.autonomy = "draft";
    expect(await call("promote", P())).toEqual(
      refused("Not moved: mc is a draft workspace, where Mission Control moves no cards."),
    );
  });

  it("refuses with the engine off", async () => {
    engineOn = false;
    expect(await call("promote", P())).toEqual(
      refused("Not moved: the loop engine is off on this server, so no card moves."),
    );
    expect(moveCalls).toEqual([]);
  });

  it("refuses when promote_backlog is off", async () => {
    rulesNow = { ...rulesNow, promoteBacklog: false };
    expect(await call("promote", P())).toEqual(
      refused(
        "Not moved: mc's rules do not let FLIGHT move tickets (promote_backlog is off); ask the operator with mc ask_operator.",
      ),
    );
  });

  it("refuses at the hourly cap", async () => {
    for (let i = 0; i < 10; i++) addDecision({ kind: "promote" });
    expect(await call("promote", P())).toEqual(
      refused(
        "Not done: you moved tickets 10 times in the last hour, the most allowed. Wait, or ask the operator.",
      ),
    );
    nowMs += 61 * 60_000;
    expect((await call("promote", P())).isError).toBeUndefined();
  });

  it("refuses a card that is not on the board", async () => {
    board();
    expect(await call("promote", P())).toEqual(refused("Not moved: mc#7 is not on the board."));
  });

  it("refuses a ticket with a run", async () => {
    live("guido-1", "r-guido", { ticket: "mc#7" });
    expect(await call("promote", P())).toEqual(refused("Not moved: mc#7 has a run."));
  });

  it("refuses Ready when GitHub cannot be reached, but not Refinement", async () => {
    fetchImpl = async () => {
      throw new Error("down");
    };
    expect(await call("promote", P())).toEqual(refused("Not moved: GitHub could not be reached."));
    expect((await call("promote", P({ to: "Refinement" }))).isError).toBeUndefined();
  });

  it("refuses two area labels, or none", async () => {
    board(backlog({ labels: ["area:server", "area:web"] }));
    expect((await call("promote", P())).text).toBe(
      "Not moved: mc#7 spans two areas (area:server, area:web); ask the operator to split it.",
    );
    board(backlog({ labels: [] }));
    expect((await call("promote", P())).text).toBe("Not moved: mc#7 has no area label.");
  });

  it("refuses a ticket that waits on an open dependency", async () => {
    board(
      backlog({
        blockedBy: [
          { ref: "mc#3", closed: false },
          { ref: "mc#4", closed: true },
        ],
      }),
    );
    expect((await call("promote", P())).text).toBe("Not moved: mc#7 waits on mc#3.");
    fetchImpl = async (n) => ticket(n, { body: `${GOOD}\nDepends on #5, #6 and #9\n` });
    board(backlog(), card(5, { closed: true, status: "Done" }), card(6, { status: "Ready" }));
    expect((await call("promote", P())).text).toBe("Not moved: mc#7 waits on mc#6, mc#9.");
  });

  it("answers a failed move, and records nothing", async () => {
    moveImpl = async () => ({ ok: false, reason: "card not on the project" });
    expect(await call("promote", P())).toEqual(refused("Not moved: card not on the project"));
    expect(decisions()).toEqual([]);
  });
});
