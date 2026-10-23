import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardItem,
  BRIEF_CLEARED_DECISION,
  BRIEFED_TEXT,
  briefClearedText,
  briefSavedDecision,
  briefSavedText,
  briefTooLongText,
  CI_LOG_EMPTY,
  capText,
  ciLogText,
  ciNoCheckText,
  ciNoFailedText,
  ciNotActionsText,
  ciNotFailedText,
  claimedText,
  DEFAULT_REPO_RULES,
  FLIGHT_ABOUT_MAX,
  FLIGHT_BRIEF_EDITS_PER_HOUR,
  FLIGHT_BRIEF_INPUT_MAX,
  FLIGHT_BRIEF_SECTION_MAX,
  FLIGHT_BRIEF_SECTIONS,
  FLIGHT_BRIEF_TITLES,
  FLIGHT_CI_LOG_LINES,
  FLIGHT_CI_LOG_MAX,
  FLIGHT_GH_READS_PER_HOUR,
  FLIGHT_LIST_PAGES,
  FLIGHT_NOTED,
  FLIGHT_NOTES_PER_HOUR,
  FLIGHT_PR_CHECKS_LISTED,
  FLIGHT_PR_FILES_LISTED,
  FLIGHT_UNPARK_KINDS,
  type FlightDecision,
  GITHUB_WRITES_OFF,
  MC_BAD_ARGS,
  MC_FLIGHT_ONLY,
  MC_RUN_ENDED,
  MC_TEXT_MAX,
  MC_TICKET_READERS_ONLY,
  NEW_LOOP,
  NOT_ON_BOARD,
  PROFILE_PAIR_TEXT,
  READ_NO_GITHUB,
  READ_NO_PR,
  READ_OTHER_REPO,
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
  WAITS_ON_ONLY_BACKLOG,
  waitsOnText,
  wrongAreaText,
  wrongColumnText,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import {
  type CcConfig,
  type CrewSeatConfig,
  crewSeatGrants,
  crewSeatMode,
  SEAT_ID,
} from "../src/config.ts";
import type { AcceptRulingResult, SyncMainResult } from "../src/engine/engine.ts";
import { createFlightTools, seatFree } from "../src/flight/tools.ts";
import type { Move, MoveResult } from "../src/github-board.ts";
import type { GhResult } from "../src/mcp/gh.ts";
import type { McTool, McToolContext } from "../src/mcp/server.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { type SeatBusy, SupervisorError } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);
const MAIN = "d".repeat(40);
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
let asideEnds: string[];
let rulingImpl: (mayRerun: boolean) => Promise<AcceptRulingResult>;
let rulingCalls: { runId: string; mayRerun: boolean }[];
let syncImpl: () => Promise<SyncMainResult>;
let syncCalls: string[];
let dirty: string[] | null;
let fetchImpl: (n: number) => Promise<TicketView | null>;
let moveCalls: Move[];
let moveImpl: () => Promise<MoveResult>;
let ghCalls: string[][];
let ghImpl: (args: string[]) => Promise<GhResult>;
let secrets: string[];
let logs: string[];

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
  asideEnds = [];
  rulingImpl = async () => ({ kind: "rerun", sha: SHA });
  rulingCalls = [];
  syncImpl = async () => ({ kind: "merged", sha: SHA_B, mainSha: MAIN });
  syncCalls = [];
  dirty = [];
  fetchImpl = async () => null;
  moveCalls = [];
  moveImpl = async () => ({ ok: true, changed: true });
  ghCalls = [];
  ghImpl = async () => ({ code: 0, stdout: "", stderr: "" });
  secrets = [];
  logs = [];
  tools = createFlightTools({
    config: cfg,
    store,
    bus,
    login: "me",
    gh: async (a) => {
      ghCalls.push(a);
      return ghImpl(a);
    },
    dbPath: join(dir, "mc.sqlite"),
    knownSecrets: async () => secrets,
    log: (l) => logs.push(l),
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
      endAsideRun: async (runId) => {
        asideEnds.push(runId);
        const r = store.run(runId);
        if (r !== null) store.upsertRun({ ...r, endedAt: nowMs, status: "ok" });
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
      acceptRuling: async (runId, opts) => {
        rulingCalls.push({ runId, mayRerun: opts.mayRerun });
        return rulingImpl(opts.mayRerun);
      },
      syncMain: async (runId) => {
        syncCalls.push(runId);
        return syncImpl();
      },
      uncommitted: async () => dirty,
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
      "accept_ruling",
      "sync_main",
      "create_ticket",
      "comment_ticket",
      "brief_item",
      "read_pr",
      "read_ci_log",
      "list_tickets",
      "update_brief",
      "draft_reply",
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

  it("records the answer as FLIGHT to the asker, about its run's ticket", async () => {
    live("guido-1", "r-guido", { ticket: "mc#7" });
    const id = store.addQuestion({
      agentId: "guido-1",
      runId: "r-guido",
      text: "Which lane?",
      at: NOW,
    });
    await call("answer_question", A(id));
    expect(store.comms(0)).toEqual([
      { at: NOW, from: "flight-1", to: "guido-1", ticket: "mc#7", text: "Lane 2" },
    ]);
    expect(seen).toContain("agents");
  });

  it("records a question passed on as FLIGHT to CAPCOM, with the question's text", async () => {
    live("guido-1", "r-guido", { ticket: "mc#7" });
    const id = store.addQuestion({
      agentId: "guido-1",
      runId: "r-guido",
      text: "Which lane?",
      at: NOW,
    });
    await call("answer_question", { question_id: id, pass_to_operator: true, basis: "spend" });
    expect(store.comms(0)).toEqual([
      { at: NOW, from: "flight-1", to: "CAPCOM", ticket: "mc#7", text: "Which lane?" },
    ]);
    expect(seen).toContain("agents");
  });

  it("returns a send failure and records nothing", async () => {
    const id = ask();
    messageImpl = async () => {
      throw new Error("seat is gone");
    };
    expect(await call("answer_question", A(id))).toEqual(refused("Not sent: seat is gone"));
    expect(decisions()).toEqual([]);
    expect(store.comms(0)).toEqual([]);
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

  it("records the assignment as FLIGHT to the seat, about the ticket", async () => {
    await start();
    expect(store.comms(0)).toEqual([
      {
        at: NOW,
        from: "flight-1",
        to: "guido-1",
        ticket: "mc#7",
        text: expect.stringMatching(/^Assigned mc#7: /),
      },
    ]);
  });

  it("starts with no options when the engine is off", async () => {
    await start();
    expect(startCalls).toEqual([["guido-1", 7, undefined]]);
  });

  it("refuses a profile without its reason, or a reason without its profile", async () => {
    for (const over of [{ profile: "bugfix" }, { profile_reason: "it is a bug" }]) {
      expect(await start(over)).toEqual({
        text: `${MC_BAD_ARGS}${PROFILE_PAIR_TEXT}`,
        isError: true,
      });
    }
    expect(startCalls).toEqual([]);
  });

  it("passes a profile and its reason on as an override by FLIGHT", async () => {
    const override = { profile: "bugfix", reason: "it is a bug", by: "FLIGHT" };
    await start({ profile: "bugfix", profile_reason: "it is a bug" });
    expect(startCalls).toEqual([["guido-1", 7, { override }]]);
  });

  it("passes the override and the loop together when the engine is on", async () => {
    engineOn = true;
    await start({ profile: "bugfix", profile_reason: "it is a bug" });
    expect(startCalls).toEqual([
      [
        "guido-1",
        7,
        { loop: NEW_LOOP, override: { profile: "bugfix", reason: "it is a bug", by: "FLIGHT" } },
      ],
    ]);
  });

  it("refuses an unknown profile before starting", async () => {
    const r = await start({ profile: "zzz", profile_reason: "r" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Not started: no template profile is named "zzz"');
    expect(startCalls).toEqual([]);
  });

  it("refuses a Size M card without a plan when its template needs one, and starts it when not", async () => {
    board(sc(7, { size: "M" }));
    fetchImpl = async (n) => ticket(n, { body: DONE });
    expect((await start()).text).toBe(startNeedsPlanText("mc#7", "M"));
    expect(
      (await start({ profile: "research", profile_reason: "no code" })).isError,
    ).toBeUndefined();
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

    // start_seat's column check names Done first, so a closed card never reaches the rule's text
    it("0: a closed card, or one in Done", async () => {
      board(sc(7, { labels: ["area:server"], closed: true }));
      await nothingStarted(wrongColumnText("mc#7", "Done"));
      board(sc(7, { labels: ["area:server"], status: "Done", state: "done" }));
      await nothingStarted(wrongColumnText("mc#7", "Done"));
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

  it("records the message as FLIGHT to the seat, without the prefix, about its run's ticket", async () => {
    live("guido-1", "r-guido", { ticket: "mc#7" });
    await call("message_seat", M());
    expect(store.comms(0)).toEqual([
      { at: NOW, from: "flight-1", to: "guido-1", ticket: "mc#7", text: "Please push" },
    ]);
    expect(seen).toContain("agents");
  });

  it("records a message to a seat with no run against no ticket", async () => {
    await call("message_seat", M());
    expect(store.comms(0).map((c) => c.ticket)).toEqual([null]);
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
    expect(store.comms(0)).toEqual([]);
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

  describe("a set-aside run, by runId", () => {
    const aside = (id = "r-g") =>
      store.upsertRun(
        run(id, "guido-1", {
          loop: {
            ...NEW_LOOP,
            phase: "parked",
            parked: { kind: "ci", reason: "CI failed", ended: false },
            aside: { worktree: "/tmp/none/wt", wake: false },
          },
        }),
      );

    it("un-parks it without a word to the seat, which is on another run", async () => {
      aside();
      expect(await call("message_seat", U({ runId: "r-g" }))).toEqual({
        text: "Sent to GUIDO-1, and its run is un-parked.",
      });
      expect(messageCalls).toEqual([]);
      expect(engineCalls).toEqual([["r-g", "FLIGHT", { kinds: FLIGHT_UNPARK_KINDS }]]);
      expect(decisions()).toMatchObject([
        { kind: "unpark", seatId: "guido-1", targetRunId: "r-g", about: "GUIDO-1: CI failed" },
      ]);
    });

    it("still sends to the seat when the run is the one it holds", async () => {
      parked("silent");
      expect((await call("message_seat", U({ runId: "r-g" }))).isError).toBeUndefined();
      expect(messageCalls).toHaveLength(1);
    });

    it("refuses another seat's run, an ended run, and a runId without unpark", async () => {
      aside("r-x");
      expect(await call("message_seat", U({ runId: "r-x", seat: "inco-1" }))).toEqual(
        refused("Not sent: r-x is not an unended run of INCO-1."),
      );
      store.upsertRun(run("r-y", "guido-1", { endedAt: NOW, status: "ok" }));
      expect((await call("message_seat", U({ runId: "r-y" }))).isError).toBe(true);
      expect(await call("message_seat", U({ runId: "r-x", unpark: false }))).toEqual(
        refused("Not sent: runId goes with unpark: true."),
      );
      expect(engineCalls).toEqual([]);
    });
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
    runId: "r-g",
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
  /** The run is off its seat, in review, parked. */
  const setAside = () => {
    store.upsertRun(
      run("r-g", "guido-1", {
        ticket: "mc#7",
        loop: {
          ...NEW_LOOP,
          phase: "parked",
          parked: { kind: "ci", reason: "CI failed", ended: false },
          aside: { worktree: "/tmp/none/wt", wake: false },
        },
      }),
    );
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

  it("refuses a run that is still working, and a run that has ended", async () => {
    live("guido-1", "r-g");
    store.setRunLoop("r-g", NEW_LOOP);
    expect(await call("end_run", E())).toEqual(
      refused("Not ended: GUIDO-1's run is not parked or stalled."),
    );
    store.upsertRun(run("r-g", "guido-1", { endedAt: NOW, status: "ok" }));
    expect(await call("end_run", E())).toEqual(refused("Not done: r-g is not an unended run."));
    expect(endCalls).toEqual([]);
    expect(decisions()).toEqual([]);
  });

  it("ends a stalled run: its seat running with no output for ten minutes", async () => {
    live("guido-1", "r-g", { ticket: "mc#7" });
    store.setRunLoop("r-g", NEW_LOOP);
    store.setSeatSession({
      ...row("guido-1", "r-g"),
      state: "running",
      updatedAt: NOW - 11 * 60_000,
    });
    expect((await call("end_run", E())).isError).toBeUndefined();
    expect(endCalls).toEqual(["guido-1"]);
    // a seat that wrote just now is not stalled
    live("inco-1", "r-i", { ticket: "mc#8" });
    store.setRunLoop("r-i", NEW_LOOP);
    store.setSeatSession({ ...row("inco-1", "r-i"), state: "running", updatedAt: NOW });
    expect((await call("end_run", E({ runId: "r-i" }))).isError).toBe(true);
  });

  it("refuses FLIGHT's own run, a run outside the session and a non-developer seat's run", async () => {
    expect(await call("end_run", E({ runId: "r-flight" }))).toEqual(
      refused("Not done: FLIGHT-1 is not a developer seat."),
    );
    expect(await call("end_run", E({ runId: "nobody-9" }))).toEqual(
      refused("Not done: nobody-9 is not an unended run."),
    );
    live("retro-1", "r-retro");
    expect(await call("end_run", E({ runId: "r-retro" }))).toEqual(
      refused("Not done: RETRO-1 is not a developer seat."),
    );
    store.upsertRun(run("r-other", "fao-2", { repoId: "other" }));
    expect((await call("end_run", E({ runId: "r-other" }))).isError).toBe(true);
    expect(endCalls).toEqual([]);
  });

  it("caps ends at 4 an hour", async () => {
    parked();
    for (let i = 0; i < 4; i++) addDecision({ at: NOW - 1000, kind: "end", seatId: "guido-1" });
    expect(await call("end_run", E())).toEqual(
      refused(
        "Not done: you ended runs 4 times in the last hour, the most allowed. Wait, or ask the operator.",
      ),
    );
    expect(endCalls).toEqual([]);
  });

  it("does not count an end older than the hour", async () => {
    parked();
    for (let i = 0; i < 4; i++) addDecision({ at: NOW - 61 * 60_000, kind: "end" });
    expect((await call("end_run", E())).isError).toBeUndefined();
  });

  it("refuses a run with uncommitted work, naming the paths, and ends nothing", async () => {
    parked();
    dirty = ["apps/a.ts", "apps/b.ts"];
    expect(await call("end_run", E())).toEqual(
      refused("Not ended: GUIDO-1 has uncommitted changes in apps/a.ts, apps/b.ts."),
    );
    expect(endCalls).toEqual([]);
    expect(store.run("r-g")?.endedAt).toBeNull();
    expect(decisions()).toEqual([]);
  });

  it("refuses when the worktree cannot be read", async () => {
    parked();
    dirty = null;
    expect(await call("end_run", E())).toEqual(
      refused("Not ended: the run's worktree could not be read."),
    );
    expect(endCalls).toEqual([]);
  });

  it("ends a parked run that is set aside, through endAsideRun", async () => {
    setAside();
    expect(await call("end_run", E())).toEqual({
      text: "Ended GUIDO-1's set-aside run. Recorded in Decided without you.",
    });
    expect(asideEnds).toEqual(["r-g"]);
    expect(endCalls).toEqual([]);
    expect(decisions()).toMatchObject([
      {
        kind: "end",
        seatId: "guido-1",
        targetRunId: "r-g",
        decision: "Ended GUIDO-1's set-aside run.",
      },
    ]);
  });

  it("refuses a set-aside run that is not parked, and a set-aside run with uncommitted work", async () => {
    setAside();
    const r = store.run("r-g");
    if (r?.loop) store.setRunLoop("r-g", { ...r.loop, phase: "review", parked: null });
    expect((await call("end_run", E())).isError).toBe(true);
    if (r?.loop) store.setRunLoop("r-g", r.loop);
    dirty = ["apps/a.ts"];
    expect((await call("end_run", E())).isError).toBe(true);
    expect(asideEnds).toEqual([]);
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

describe("accept_ruling", () => {
  const A = (over: Record<string, unknown> = {}) => ({
    runId: "r-g",
    basis: "the failing test is a known flake",
    ...over,
  });
  beforeEach(() => {
    engineOn = true;
    live("guido-1", "r-g", { ticket: "mc#7" });
    store.setRunLoop("r-g", {
      ...NEW_LOOP,
      phase: "parked",
      ciFailedSha: SHA,
      parked: { kind: "ruling", reason: "ruled", ended: false },
    });
  });

  it("starts the re-run, and records it with its basis", async () => {
    expect(await call("accept_ruling", A())).toEqual({
      text: "Re-running failed CI on aaaaaaa for GUIDO-1; call accept_ruling again when it finishes. Recorded in Decided without you.",
    });
    expect(rulingCalls).toEqual([{ runId: "r-g", mayRerun: true }]);
    expect(decisions()).toMatchObject([
      {
        kind: "rerun",
        seatId: "guido-1",
        targetRunId: "r-g",
        decision:
          "Re-running failed CI on aaaaaaa for GUIDO-1; call accept_ruling again when it finishes.",
        basis: "the failing test is a known flake",
      },
    ]);
    expect(seen).toContain("flight");
  });

  it("accepts the ruling when the re-run passed", async () => {
    rulingImpl = async () => ({ kind: "accepted", sha: SHA });
    expect(await call("accept_ruling", A())).toEqual({
      text: "Re-run passed on aaaaaaa: GUIDO-1's ruling is accepted. Recorded in Decided without you.",
    });
    expect(decisions()).toMatchObject([{ kind: "ruling", targetRunId: "r-g" }]);
  });

  it("refuses the ruling when the re-run failed, and sends the failure back", async () => {
    rulingImpl = async () => ({ kind: "refused", sha: SHA });
    const r = await call("accept_ruling", A());
    expect(r).toEqual({
      text: "Re-run failed on aaaaaaa: GUIDO-1 gets the failure to fix. Recorded in Decided without you.",
    });
    expect(decisions()).toMatchObject([{ kind: "ruling" }]);
  });

  it("says the re-run is still going, recording nothing", async () => {
    rulingImpl = async () => ({ kind: "pending", sha: SHA });
    expect(await call("accept_ruling", A())).toEqual({
      text: "The re-run on aaaaaaa is still going.",
    });
    expect(decisions()).toEqual([]);
  });

  it("passes the engine's refusals on", async () => {
    rulingImpl = async () => ({ kind: "not", text: "the run is not parked on a CI ruling" });
    expect(await call("accept_ruling", A())).toEqual(
      refused("Not accepted: the run is not parked on a CI ruling."),
    );
    expect(decisions()).toEqual([]);
  });

  it("re-runs at most 4 times an hour: the engine is told when the cap is used", async () => {
    for (let i = 0; i < 3; i++) addDecision({ at: NOW - 1000, kind: "rerun" });
    await call("accept_ruling", A());
    expect(rulingCalls.at(-1)?.mayRerun).toBe(true);
    // (the call above filed the 4th)
    rulingImpl = async (mayRerun) => (mayRerun ? { kind: "rerun", sha: SHA } : { kind: "capped" });
    expect(await call("accept_ruling", A())).toEqual(
      refused(
        "Not done: you re-ran CI 4 times in the last hour, the most allowed. Wait, or ask the operator.",
      ),
    );
    expect(rulingCalls.at(-1)?.mayRerun).toBe(false);
  });

  it("refuses with the engine off, a run that is not a developer's, and another seat's token", async () => {
    engineOn = false;
    expect(await call("accept_ruling", A())).toEqual({ text: GITHUB_WRITES_OFF, isError: true });
    engineOn = true;
    expect(await call("accept_ruling", A({ runId: "r-flight" }))).toEqual(
      refused("Not done: FLIGHT-1 is not a developer seat."),
    );
    expect(await call("accept_ruling", A({ runId: "nope" }))).toEqual(
      refused("Not done: nope is not an unended run."),
    );
    expect(await call("accept_ruling", A(), ctx("guido-1", "r-g"))).toEqual({
      text: MC_FLIGHT_ONLY,
      isError: true,
    });
    expect(rulingCalls).toEqual([]);
  });

  it("takes no extra arguments", async () => {
    expect((await call("accept_ruling", A({ seat: "guido-1" }))).isError).toBe(true);
  });
});

describe("sync_main", () => {
  const S = (over: Record<string, unknown> = {}) => ({
    runId: "r-g",
    basis: "the PR conflicts with main and the author is not needed",
    ...over,
  });
  beforeEach(() => {
    engineOn = true;
    live("guido-1", "r-g", { ticket: "mc#7" });
  });

  it("merges main through the engine, and records it", async () => {
    expect(await call("sync_main", S())).toEqual({
      text: "Merged main ddddddd into GUIDO-1's branch as bbbbbbb. Recorded in Decided without you.",
    });
    expect(syncCalls).toEqual(["r-g"]);
    expect(decisions()).toMatchObject([
      {
        kind: "sync",
        seatId: "guido-1",
        targetRunId: "r-g",
        decision: "Merged main ddddddd into GUIDO-1's branch as bbbbbbb.",
        basis: "the PR conflicts with main and the author is not needed",
      },
    ]);
  });

  it("names a conflict the author resolves", async () => {
    syncImpl = async () => ({ kind: "conflict", files: ["apps/a.ts"] });
    expect(await call("sync_main", S())).toEqual({
      text: "Main conflicts in apps/a.ts; GUIDO-1 resolves it. Recorded in Decided without you.",
    });
    expect(decisions()).toMatchObject([{ kind: "sync" }]);
  });

  it("says a branch that has main already is current, recording nothing", async () => {
    syncImpl = async () => ({ kind: "current", mainSha: MAIN });
    expect(await call("sync_main", S())).toEqual({
      text: "GUIDO-1's branch already has main ddddddd.",
    });
    expect(decisions()).toEqual([]);
  });

  it("passes the engine's refusals on", async () => {
    syncImpl = async () => ({ kind: "refused", text: "its seat is in a turn" });
    expect(await call("sync_main", S())).toEqual(refused("Not merged: its seat is in a turn."));
    expect(decisions()).toEqual([]);
  });

  it("merges at most 6 times an hour", async () => {
    for (let i = 0; i < 6; i++) addDecision({ at: NOW - 1000, kind: "sync" });
    expect(await call("sync_main", S())).toEqual(
      refused(
        "Not done: you merged main 6 times in the last hour, the most allowed. Wait, or ask the operator.",
      ),
    );
    expect(syncCalls).toEqual([]);
  });

  it("refuses a run that is not a developer's, and with the engine off", async () => {
    expect((await call("sync_main", S({ runId: "r-flight" }))).isError).toBe(true);
    engineOn = false;
    expect(await call("sync_main", S())).toEqual({ text: GITHUB_WRITES_OFF, isError: true });
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

  it("lists a run set aside in review, with its park, and the seat's run ids", async () => {
    store.upsertRun(
      run("r-aside", "guido-1", {
        ticket: "mc#7",
        loop: {
          ...NEW_LOOP,
          phase: "parked",
          parked: { kind: "ci", reason: "CI failed", ended: false },
          aside: { worktree: "/tmp/none/wt", wake: false },
        },
      }),
    );
    live("inco-1", "r-inco");
    const s = (await state()) as {
      aside: unknown[];
      seats: { id: string; runId: string | null }[];
    };
    expect(s.aside).toEqual([
      {
        runId: "r-aside",
        seat: "guido-1",
        ticket: "mc#7",
        phase: "parked",
        parked: { kind: "ci", reason: "CI failed" },
      },
    ]);
    expect(s.seats.find((x) => x.id === "inco-1")?.runId).toBe("r-inco");
    expect(s.seats.find((x) => x.id === "guido-1")?.runId).toBeNull();
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
      runId: null,
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
      discussions: [],
      time: "13:00",
      repo: "mc",
      lane: null,
      hubLogin: "me",
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
          runId: "r-inco",
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
      aside: [],
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
          laneLabel: null,
          assignees: [],
        },
        {
          ref: "mc#6",
          title: "Ticket 6",
          column: "Ready",
          priority: "P1",
          labels: [],
          ready: true,
          blockedBy: [],
          laneLabel: null,
          assignees: [],
        },
        {
          ref: "mc#1",
          title: "Ticket 1",
          column: "Ready",
          priority: "P1",
          labels: [],
          ready: true,
          blockedBy: ["mc#8"],
          laneLabel: null,
          assignees: [],
        },
      ],
      prs: [
        {
          ref: "mc#7",
          pr: 9,
          seat: "guido-1",
          runId: "r-pr",
          ready: true,
          state: "open",
          headSha: "abc",
          readAt: "13:00",
          stale: false,
          review: null,
          failingChecks: [],
        },
      ],
      items: [{ key: "note:ready:r-pr", kind: "ready", ticket: "mc#7", text: "ready", ageMin: 0 }],
      holds: [],
      recent: [{ time: "12:59", kind: "message", about: "Message to GUIDO-1", decision: "go on" }],
      limits: { startsLeft: 8, messagesLeft: 29 },
      brief: FLIGHT_BRIEF_SECTIONS.map((section) => ({
        section,
        title: FLIGHT_BRIEF_TITLES[section],
        text: "",
        ageMin: null,
      })),
    });
  });

  it("carries the hub's lane and login, and each ticket's lane label and assignees", async () => {
    if (cfg.crew === undefined) throw new Error("no crew");
    cfg.crew.lane = "home";
    board(card(1, { labels: ["lane:home", "area:server"], assignees: ["me"] }));
    const s = (await state()) as {
      lane: string;
      hubLogin: string;
      tickets: { laneLabel: string; assignees: string[] }[];
    };
    expect(s.lane).toBe("home");
    expect(s.hubLogin).toBe("me");
    expect(s.tickets).toMatchObject([{ laneLabel: "lane:home", assignees: ["me"] }]);
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

  describe("holds", () => {
    const pr = (number: number, state: "open" | "merged" | "closed" = "open") => ({
      repoId: "mc",
      number,
      title: `PR ${number}`,
      url: "u",
      branch: `feature/${number}-x`,
      ticket: null,
      state,
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
    });
    const H = (over: Record<string, unknown> = {}) => P({ to: "Backlog", waits_on: 246, ...over });

    beforeEach(() => {
      board(backlog({ status: "Ready" }));
      store.upsertPullRequests("mc", [pr(246), pr(247, "merged"), pr(248, "closed")], NOW);
    });

    it("holds a Ready card FLIGHT did not move, behind an open PR", async () => {
      expect((await call("promote", H())).isError).toBeUndefined();
      expect(moveCalls).toEqual([{ runId: "r-flight", repoId: "mc", issue: 7, column: "Backlog" }]);
      expect(store.activeHolds()).toMatchObject([
        { ref: "mc#7", waitsOn: 246, basis: "it is complete", releasedAt: null },
      ]);
      expect(decisions()).toMatchObject([
        { kind: "promote", ref: "mc#7", decision: "Held in Backlog behind PR #246" },
      ]);
    });

    it("holds a Refinement card too, and counts under the promote cap", async () => {
      board(backlog({ status: "Refinement" }));
      expect((await call("promote", H())).isError).toBeUndefined();
      for (let i = 0; i < 9; i++) addDecision({ kind: "promote" });
      expect((await call("promote", H())).text).toContain("moved tickets 10 times");
    });

    it("refuses a hold on a card with a run", async () => {
      live("guido-1", "r-guido", { ticket: "mc#7" });
      expect(await call("promote", H())).toEqual(refused("Not moved: mc#7 has a run."));
      expect(store.activeHolds()).toEqual([]);
    });

    it("refuses a hold behind a merged, closed or unknown PR", async () => {
      for (const n of [247, 248, 999]) {
        expect(await call("promote", H({ waits_on: n }))).toEqual(
          refused(`Not moved: PR #${n} is not an open PR in mc.`),
        );
      }
      expect(moveCalls).toEqual([]);
      expect(store.activeHolds()).toEqual([]);
    });

    it("refuses waits_on on a move that is not to Backlog, and a hold from Backlog", async () => {
      board(backlog());
      expect(await call("promote", P({ waits_on: 246 }))).toEqual(refused(WAITS_ON_ONLY_BACKLOG));
      expect(await call("promote", P({ to: "Refinement", waits_on: 246 }))).toEqual(
        refused(WAITS_ON_ONLY_BACKLOG),
      );
      expect((await call("promote", H())).isError).toBe(true);
      expect(moveCalls).toEqual([]);
      expect(store.activeHolds()).toEqual([]);
    });

    it("keeps a new hold while the stored board still shows the card in Ready", async () => {
      await call("promote", H());
      await call("flight_state", {});
      expect(store.activeHolds()).toHaveLength(1);
      board(backlog());
      await call("flight_state", {});
      board(backlog({ status: "Ready" }));
      await call("flight_state", {});
      expect(store.activeHolds()).toEqual([]);
    });

    it("releases a hold whose card a run has taken, though the board never showed it in Backlog", async () => {
      await call("promote", H());
      board(backlog({ status: "Ready" }));
      await call("flight_state", {});
      expect(store.activeHolds()).toHaveLength(1);
      live("guido-1", "r-guido", { ticket: "mc#7" });
      await call("flight_state", {});
      expect(store.activeHolds()).toEqual([]);
    });

    it("releases the hold when the card is promoted again", async () => {
      await call("promote", H());
      board(backlog());
      expect((await call("promote", P())).isError).toBeUndefined();
      expect(store.activeHolds()).toEqual([]);
    });

    it("keeps the hold when the promote again is refused", async () => {
      await call("promote", H());
      board(backlog({ labels: [] }));
      expect((await call("promote", P())).isError).toBe(true);
      expect(store.activeHolds()).toHaveLength(1);
    });
  });
});

describe("create_ticket", () => {
  const BODY = "## Outcome\n\nIt works.\n\n## Done when\n\n- a test passes\n";
  const C = (over: Record<string, unknown> = {}) => ({
    title: "Server: fix the flake",
    body: BODY,
    labels: ["area:server", "lane:guido", "bug"],
    basis: "CI flaked twice on main",
    ...over,
  });
  const okGh = (open: { number: number; title: string }[] = []) => {
    ghImpl = async (a) => {
      if (a[0] === "issue" && a[1] === "list") {
        return { code: 0, stdout: JSON.stringify(open), stderr: "" };
      }
      if (a[0] === "issue" && a[1] === "create") {
        return { code: 0, stdout: "https://github.com/o/mc/issues/42\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  };
  beforeEach(() => {
    const mc = cfg.repos[0];
    if (mc === undefined) throw new Error("no repo");
    mc.autonomy = "merge";
    engineOn = true;
    okGh();
  });

  it("does not claim Backlog in a draft repo, where no card moves", async () => {
    const mc = cfg.repos[0];
    if (mc === undefined) throw new Error("no repo");
    mc.autonomy = "draft";
    const r = await call("create_ticket", C());
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("draft workspace");
    expect(r.text).not.toContain("Backlog");
    expect(moveCalls).toEqual([]);
    expect(decisions()).toHaveLength(1);
  });

  it("lists the repo's open issues for the duplicate check, not a search", async () => {
    await call("create_ticket", C({ title: "Server: drop the -v flag" }));
    expect(ghCalls[0]).toEqual([
      "issue",
      "list",
      "--repo=o/mc",
      "--state=open",
      "--json=number,title",
      "--limit=1000",
    ]);
    expect(ghCalls[0]?.some((a) => a.startsWith("--search"))).toBe(false);
  });

  it("serialises calls, so the cap holds when two are in flight together", async () => {
    for (let i = 0; i < 9; i++) addDecision({ kind: "ticket", at: NOW - 60_000 });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = ghImpl;
    ghImpl = async (a) => {
      if (a[1] === "list") await gate;
      return inner(a);
    };
    const both = Promise.all([
      call("create_ticket", C({ title: "First" })),
      call("create_ticket", C({ title: "Second" })),
    ]);
    release();
    const results = await both;
    expect(results.filter((r) => r.isError === undefined)).toHaveLength(1);
    expect(results.filter((r) => r.isError === true)).toHaveLength(1);
    expect(results.find((r) => r.isError === true)?.text).toContain("filed tickets 10 times");
    expect(ghCalls.filter((a) => a[1] === "create")).toHaveLength(1);
  });

  it("writes nothing while the engine is off", async () => {
    engineOn = false;
    expect(await call("create_ticket", C())).toEqual(
      refused("Not done: the loop engine is off on this server, so nothing is written to GitHub."),
    );
    expect(ghCalls).toEqual([]);
  });

  it("is shown only to a granted role", () => {
    expect(named("create_ticket")).toMatchObject({ modes: [], grantable: ["read-only"] });
  });

  it("files the issue with its labels, adds it to the project, moves it to Backlog and records it", async () => {
    expect(await call("create_ticket", C())).toEqual({
      text: "Filed mc#42, on the project in Backlog. Recorded in Decided without you.",
    });
    expect(ghCalls[1]).toEqual([
      "issue",
      "create",
      "--repo=o/mc",
      "--title=Server: fix the flake",
      `--body=${BODY}`,
      "--label=area:server",
      "--label=lane:guido",
      "--label=bug",
    ]);
    expect(ghCalls[2]).toEqual([
      "project",
      "item-add",
      "1",
      "--owner=o",
      "--url=https://github.com/o/mc/issues/42",
    ]);
    expect(moveCalls).toEqual([{ runId: "r-flight", repoId: "mc", issue: 42, column: "Backlog" }]);
    expect(decisions()).toMatchObject([
      {
        kind: "ticket",
        ref: "mc#42",
        about: "mc#42: Server: fix the flake",
        decision: "Filed #42",
        basis: "CI flaked twice on main",
      },
    ]);
    expect(seen).toContain("flight");
  });

  it("refuses a seat that is not FLIGHT", async () => {
    live("guido-1", "r-guido");
    expect(await call("create_ticket", C(), ctx("guido-1", "r-guido"))).toEqual(
      refused(MC_FLIGHT_ONLY),
    );
    expect(ghCalls).toEqual([]);
  });

  it.each([
    ["no area", ["lane:guido"]],
    ["two areas", ["area:server", "area:web", "lane:guido"]],
    ["no lane", ["area:server"]],
    ["two lanes", ["area:server", "lane:guido", "lane:inco"]],
    ["an unknown label", ["area:server", "lane:guido", "wontfix"]],
    ["a repeated label", ["area:server", "lane:guido", "bug", "bug"]],
  ])("refuses %s", async (_what, labels) => {
    const r = await call("create_ticket", C({ labels }));
    expect(r.isError).toBe(true);
    expect(r.text.startsWith("Not filed: ")).toBe(true);
    expect(ghCalls).toEqual([]);
    expect(decisions()).toEqual([]);
  });

  it("takes each type label", async () => {
    for (const t of ["type:feature", "bug", "chore", "test", "docs"]) {
      okGh();
      const labels = ["area:web", "lane:inco", t];
      const r = await call("create_ticket", C({ title: `T ${t}`, labels }));
      expect(r.isError).toBeUndefined();
    }
  });

  it("refuses a body without ## Outcome or ## Done when", async () => {
    expect((await call("create_ticket", C({ body: "## Done when\n\n- x\n" }))).text).toBe(
      "Not filed: the body needs ## Outcome as a heading line.",
    );
    expect((await call("create_ticket", C({ body: "## Outcome\n\nx\n" }))).text).toBe(
      "Not filed: the body needs ## Done when as a heading line.",
    );
    expect((await call("create_ticket", C({ body: "text" }))).text).toBe(
      "Not filed: the body needs ## Outcome and ## Done when as a heading line.",
    );
    expect(ghCalls).toEqual([]);
  });

  it("refuses a title that matches an open issue exactly, naming it", async () => {
    okGh([
      { number: 9, title: "Server: fix the flake please" },
      { number: 17, title: "Server: fix the flake" },
    ]);
    expect(await call("create_ticket", C())).toEqual(
      refused(
        "Not filed: an open issue with that title exists: #17. Comment on it with mc comment_ticket.",
      ),
    );
    expect(ghCalls.some((a) => a[1] === "create")).toBe(false);
    expect(decisions()).toEqual([]);
  });

  it("refuses at 10 an hour, and again once the hour has passed", async () => {
    for (let i = 0; i < 10; i++) addDecision({ kind: "ticket", at: NOW - 60_000 });
    expect(await call("create_ticket", C())).toEqual(
      refused(
        "Not done: you filed tickets 10 times in the last hour, the most allowed. Wait, or ask the operator.",
      ),
    );
    expect(ghCalls).toEqual([]);
    nowMs = NOW + 3_600_000;
    expect((await call("create_ticket", C())).isError).toBeUndefined();
  });

  it("holds the cap across calls", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call("create_ticket", C({ title: `T${i}` }))).isError).toBeUndefined();
    }
    expect((await call("create_ticket", C({ title: "T10" }))).isError).toBe(true);
  });

  it("refuses a mention, an issue reference, and a secret, without calling gh", async () => {
    for (const body of [
      `${BODY}\nask @someone\n`,
      `${BODY}\nsee other/repo#12\n`,
      `${BODY}\nsee o/mc#12\n`,
      `${BODY}\nsee https://github.com/other/repo/issues/12\n`,
    ]) {
      const r = await call("create_ticket", C({ body }));
      expect(r.isError).toBe(true);
      expect(r.text).toContain("The ticket is posted to GitHub");
    }
    expect((await call("create_ticket", C({ title: "fix @someone" }))).isError).toBe(true);
    secrets = ["s3cr3t-token-value"];
    const r = await call("create_ticket", C({ body: `${BODY}\ntoken s3cr3t-token-value\n` }));
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("s3cr3t-token-value");
    expect(ghCalls).toEqual([]);
    expect(store.guardHits(0)).toHaveLength(1);
  });

  it("lets a #n of the repo's own issues through, so a Depends on line works", async () => {
    const r = await call("create_ticket", C({ body: `${BODY}\nDepends on #12, #13\n` }));
    expect(r.isError).toBeUndefined();
    expect(ghCalls.some((a) => a[1] === "create")).toBe(true);
  });

  it("refuses bad arguments", async () => {
    for (const bad of [
      C({ title: "" }),
      C({ title: "a\nb" }),
      C({ title: "x".repeat(201) }),
      C({ body: "" }),
      C({ labels: "bug" }),
      C({ basis: "" }),
      C({ extra: 1 }),
    ]) {
      const r = await call("create_ticket", bad);
      expect(r.isError).toBe(true);
      expect(r.text.startsWith(MC_BAD_ARGS)).toBe(true);
    }
    expect(ghCalls).toEqual([]);
  });

  it("answers a gh failure with a fixed text and logs it, redacting known secrets", async () => {
    secrets = ["tok-123"];
    ghImpl = async (a) =>
      a[1] === "list"
        ? { code: 0, stdout: "[]", stderr: "" }
        : { code: 1, stdout: "", stderr: "bad tok-123" };
    const r = await call("create_ticket", C());
    expect(r).toEqual(refused("Not filed: GitHub refused issue create; see the server log."));
    expect(logs.join("\n")).toContain("[redacted]");
    expect(logs.join("\n")).not.toContain("tok-123");
    expect(decisions()).toEqual([]);
  });

  it("says so when the issue is filed but not added to the project, and still records it", async () => {
    ghImpl = async (a) => {
      if (a[1] === "list") return { code: 0, stdout: "[]", stderr: "" };
      if (a[1] === "create") {
        return { code: 0, stdout: "https://github.com/o/mc/issues/42\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "no scope" };
    };
    const r = await call("create_ticket", C());
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Filed mc#42");
    expect(decisions()).toHaveLength(1);
    expect(moveCalls).toEqual([]);
  });

  it("reports an unconfirmed Backlog move but still counts the ticket as filed", async () => {
    moveImpl = async () => ({ ok: false, reason: "card not on the project" });
    expect(await call("create_ticket", C())).toEqual({
      text: "Filed mc#42, on the project, but not confirmed in Backlog. Recorded in Decided without you.",
    });
    expect(decisions()).toHaveLength(1);
  });

  it("refuses an unparseable gh answer, and records nothing", async () => {
    ghImpl = async (a) =>
      a[1] === "list"
        ? { code: 0, stdout: "[]", stderr: "" }
        : { code: 0, stdout: "created!", stderr: "" };
    expect((await call("create_ticket", C())).isError).toBe(true);
    expect(decisions()).toEqual([]);
  });
});

describe("comment_ticket", () => {
  const K = (over: Record<string, unknown> = {}) => ({
    issue: 12,
    text: "The flake is back on main.",
    basis: "seen in CI",
    ...over,
  });
  beforeEach(() => {
    engineOn = true;
  });

  it("writes nothing while the engine is off", async () => {
    engineOn = false;
    expect((await call("comment_ticket", K())).isError).toBe(true);
    expect(ghCalls).toEqual([]);
  });

  it("is shown only to a granted role", () => {
    expect(named("comment_ticket")).toMatchObject({ modes: [], grantable: ["read-only"] });
  });

  it("posts the comment in the session repo and records it", async () => {
    expect(await call("comment_ticket", K())).toEqual({
      text: "Commented on #12. Recorded in Decided without you.",
    });
    expect(ghCalls).toEqual([
      ["issue", "comment", "12", "--repo=o/mc", "--body=The flake is back on main."],
    ]);
    expect(decisions()).toMatchObject([
      { kind: "comment", ref: "mc#12", decision: "Commented", basis: "seen in CI" },
    ]);
    expect(seen).toContain("flight");
  });

  it("refuses a seat that is not FLIGHT", async () => {
    live("guido-1", "r-guido");
    expect(await call("comment_ticket", K(), ctx("guido-1", "r-guido"))).toEqual(
      refused(MC_FLIGHT_ONLY),
    );
    expect(ghCalls).toEqual([]);
  });

  it("refuses at 20 an hour", async () => {
    for (let i = 0; i < 20; i++) addDecision({ kind: "comment", at: NOW - 60_000 });
    expect(await call("comment_ticket", K())).toEqual(
      refused(
        "Not done: you posted comments 20 times in the last hour, the most allowed. Wait, or ask the operator.",
      ),
    );
    expect(ghCalls).toEqual([]);
  });

  it("lets a #n of the repo's own issues through", async () => {
    expect((await call("comment_ticket", K({ text: "same as #13" }))).isError).toBeUndefined();
  });

  it("refuses a mention, another repo's issue, and a secret", async () => {
    for (const text of ["ping @someone", "see other/repo#13", "see o/mc#13"]) {
      const r = await call("comment_ticket", K({ text }));
      expect(r.isError).toBe(true);
      expect(r.text.startsWith("Not commented: ")).toBe(true);
    }
    secrets = ["s3cr3t-token-value"];
    const s = await call("comment_ticket", K({ text: "key s3cr3t-token-value" }));
    expect(s.isError).toBe(true);
    expect(s.text).not.toContain("s3cr3t-token-value");
    expect(ghCalls).toEqual([]);
  });

  it("refuses bad arguments", async () => {
    for (const bad of [K({ issue: 0 }), K({ text: "" }), K({ basis: "" }), K({ extra: 1 })]) {
      const r = await call("comment_ticket", bad);
      expect(r.isError).toBe(true);
      expect(r.text.startsWith(MC_BAD_ARGS)).toBe(true);
    }
  });

  it("answers a gh failure with a fixed text, and records nothing", async () => {
    ghImpl = async () => ({ code: 1, stdout: "", stderr: "Could not resolve to an issue" });
    expect(await call("comment_ticket", K())).toEqual(
      refused("Not commented: GitHub refused the comment on #12; see the server log."),
    );
    expect(logs).toHaveLength(1);
    expect(decisions()).toEqual([]);
  });
});

describe("brief_item", () => {
  const KEY = "note:blocked:r1:0";
  const raise = (key = "blocked:r1:0", over: Record<string, unknown> = {}) =>
    store.raiseNote({
      key,
      kind: "blocked",
      runId: null,
      seatId: "guido-1",
      repoId: "mc",
      text: "mc#7 parked",
      at: NOW,
      ...over,
    });
  const B = (over: Record<string, unknown> = {}) => ({
    key: KEY,
    context: "mc#7 is parked since 11:00.",
    recommendation: "Un-park it.",
    options: [
      { label: "Un-park", answer: "go" },
      { label: "Leave", answer: "wait" },
    ],
    basis: "read the park",
    ...over,
  });
  beforeEach(() => {
    raise();
    seen.length = 0;
  });

  it("stores a brief on an operator item and emits attention", async () => {
    expect(await call("brief_item", B())).toEqual({ text: BRIEFED_TEXT });
    expect(store.briefs().get(KEY)).toEqual({
      context: "mc#7 is parked since 11:00.",
      recommendation: "Un-park it.",
      options: [
        { label: "Un-park", answer: "go" },
        { label: "Leave", answer: "wait" },
      ],
      basis: "read the park",
      at: NOW,
    });
    expect(seen).toEqual(["attention"]);
    expect(decisions()).toEqual([]);
  });

  it("stores structured evidence and recommends an option by stable identity", async () => {
    const fields = {
      catchUp: {
        kind: "follow-up",
        line: "A decision remains",
        story: ["Parked"],
        aware: ["No action taken"],
      },
      checked: [{ source: "GitHub", finding: "Still parked" }],
      options: [
        { id: "go", label: "Un-park", answer: "go", description: "Resume work" },
        { id: "wait", label: "Leave", answer: "wait", description: "Stay parked" },
      ],
      recommendedOptionId: "go",
    };
    expect(await call("brief_item", B(fields))).toEqual({ text: BRIEFED_TEXT });
    expect(store.briefs().get(KEY)).toMatchObject(fields);
    expect(
      (await call("brief_item", B({ ...fields, recommendedOptionId: "missing" }))).isError,
    ).toBe(true);
  });

  it("binds person replies to the exact source and rejects a draft against an edited message", async () => {
    const source = { kind: "github" as const, messageId: "555", revision: "source-v1" };
    store.upsertNotifications(
      [
        {
          id: "101",
          repoId: "mc",
          subjectType: "Issue",
          title: "Review the plan",
          number: 7,
          reason: "mention",
          url: "https://github.com/o/mc/issues/7#issuecomment-555",
          author: "catalogue-helper",
          snippet: "Please review",
          updatedAt: NOW,
          lastReadAt: null,
          message: {
            source,
            author: "catalogue-helper",
            at: NOW,
            text: "Please review",
            url: "https://github.com/o/mc/issues/7#issuecomment-555",
          },
        },
      ],
      false,
      NOW,
    );
    const state = JSON.parse((await call("flight_state", {})).text);
    expect(
      state.items.find((i: { key: string }) => i.key === `person:101:${NOW}`)?.person,
    ).toMatchObject({ message: { source, text: "Please review" } });
    const person = {
      source,
      assessment: ["Review needed"],
      replies: [{ id: "review", label: "Review", text: "I will review." }],
    };
    const args = B({ key: `person:101:${NOW}`, person });
    expect(await call("brief_item", args)).toEqual({ text: BRIEFED_TEXT });
    expect(store.drafts()).toHaveLength(1);
    expect(ghCalls).toEqual([]);
    const edited = {
      ...args,
      person: { ...person, source: { ...source, revision: "wrong" } },
    };
    expect((await call("brief_item", edited)).isError).toBe(true);
    expect(store.drafts()).toHaveLength(1);
    expect(ghCalls).toEqual([]);
  });

  it("takes no options, and cuts long texts at MC_TEXT_MAX", async () => {
    const long = "x".repeat(MC_TEXT_MAX + 50);
    await call("brief_item", B({ context: long, options: undefined }));
    const b = store.briefs().get(KEY);
    expect(b?.context).toHaveLength(MC_TEXT_MAX);
    expect(b?.context.endsWith("…")).toBe(true);
    expect(b?.options).toEqual([]);
  });

  it("keeps the newest brief on a key", async () => {
    await call("brief_item", B());
    nowMs = NOW + 1000;
    await call("brief_item", B({ recommendation: "Leave it." }));
    expect(store.briefs().get(KEY)?.recommendation).toBe("Leave it.");
  });

  it("allows 20 briefs an hour, then refuses the 21st", async () => {
    for (let i = 0; i < 20; i++) expect((await call("brief_item", B())).isError).toBeUndefined();
    expect(await call("brief_item", B())).toEqual(
      refused(
        "Not done: you briefed items 20 times in the last hour, the most allowed. Wait, or ask the operator.",
      ),
    );
    nowMs = NOW + 61 * 60_000;
    raise("blocked:r1:0", { at: nowMs });
    expect((await call("brief_item", B())).isError).toBeUndefined();
  });

  it("refuses a key that is not the operator's item", async () => {
    expect(await call("brief_item", B({ key: "note:nope" }))).toEqual(
      refused("Not briefed: note:nope is not an item in the operator's Needs-you list."),
    );
    raise("cleanup-branch:x");
    expect((await call("brief_item", B({ key: "note:cleanup-branch:x" }))).isError).toBe(true);
    expect(store.briefs().size).toBe(0);
  });

  it("refuses one or five options, and a seat that is not FLIGHT", async () => {
    const opt = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ label: `L${i}`, answer: `A${i}` }));
    for (const n of [1, 5]) {
      const r = await call("brief_item", B({ options: opt(n) }));
      expect(r.isError).toBe(true);
      expect(r.text.startsWith(MC_BAD_ARGS)).toBe(true);
    }
    live("guido-1", "r-guido");
    expect(await call("brief_item", B(), ctx("guido-1", "r-guido"))).toEqual(
      refused(MC_FLIGHT_ONLY),
    );
    expect(store.briefs().size).toBe(0);
  });
});

describe("update_brief", () => {
  const GOALS = "Goals and priorities";
  const save = (section: string, text: string, c = ctx()) =>
    call("update_brief", { section, text, basis: "a wake" }, c);
  const briefDecisions = () => decisions().filter((d) => d.kind === "brief");

  it("replaces one section and leaves the others", async () => {
    await save("goals", "Ship the brief.");
    await save("risks", "Flaky api test.");
    nowMs = NOW + 1000;
    expect(await save("goals", "Ship the merge step.")).toEqual({
      text: briefSavedText(GOALS, 20),
    });
    expect(store.flightBrief("s1")).toEqual([
      {
        sessionId: "s1",
        section: "goals",
        text: "Ship the merge step.",
        updatedAt: NOW + 1000,
        updatedBy: "flight-1",
      },
      {
        sessionId: "s1",
        section: "risks",
        text: "Flaky api test.",
        updatedAt: NOW,
        updatedBy: "flight-1",
      },
    ]);
    expect(briefDecisions()).toHaveLength(3);
    expect(briefDecisions()[0]).toMatchObject({
      about: "Brief: Goals and priorities",
      decision: briefSavedDecision(20),
    });
    expect(seen).toContain("flight");
    // the log keeps the size, not the text; flight_state's recent leaves brief edits out
    expect(briefDecisions().map((d) => d.decision)).not.toContain("Ship the merge step.");
    const state = JSON.parse((await call("flight_state", {}, ctx())).text) as {
      recent: { kind: string }[];
    };
    expect(state.recent.filter((d) => d.kind === "brief")).toEqual([]);
  });

  it("clears a section with an empty text", async () => {
    await save("goals", "x");
    expect(await save("goals", "")).toEqual({ text: briefClearedText(GOALS) });
    expect(store.flightBrief("s1")[0]?.text).toBe("");
    expect(briefDecisions()[0]?.decision).toBe(BRIEF_CLEARED_DECISION);
  });

  it("holds the 4000-character cap", async () => {
    const full = "x".repeat(FLIGHT_BRIEF_SECTION_MAX);
    expect(await save("goals", full)).toEqual({ text: briefSavedText(GOALS, 4000) });
    expect(await save("goals", "y".repeat(FLIGHT_BRIEF_SECTION_MAX + 1))).toEqual(
      refused(briefTooLongText(GOALS, 4001)),
    );
    expect(store.flightBrief("s1")[0]?.text).toBe(full);
    expect(briefDecisions()).toHaveLength(1);
    const r = await save("goals", "z".repeat(FLIGHT_BRIEF_INPUT_MAX + 1));
    expect(r).toMatchObject({ isError: true });
    expect(r.text.startsWith(MC_BAD_ARGS)).toBe(true);
  });

  it("refuses an unknown section and a non-FLIGHT seat", async () => {
    const r = await save("notes", "x");
    expect(r.isError).toBe(true);
    expect(r.text.startsWith(MC_BAD_ARGS)).toBe(true);
    live("guido-1", "r-guido");
    expect(await save("goals", "x", ctx("guido-1", "r-guido"))).toEqual(refused(MC_FLIGHT_ONLY));
    expect(store.flightBrief("s1")).toEqual([]);
    expect(briefDecisions()).toEqual([]);
  });

  it("allows 30 edits an hour", async () => {
    for (let i = 0; i < FLIGHT_BRIEF_EDITS_PER_HOUR; i++) {
      expect(await save("goals", `v${i}`)).not.toHaveProperty("isError");
    }
    expect(await save("goals", "one more")).toEqual(
      refused(capText("updated your brief", FLIGHT_BRIEF_EDITS_PER_HOUR)),
    );
    nowMs = NOW + 61 * 60_000;
    expect(await save("goals", "later")).not.toHaveProperty("isError");
  });

  it("is carried by flight_state", async () => {
    await save("goals", "G");
    nowMs = NOW + 5 * 60_000;
    const s = JSON.parse((await call("flight_state", {})).text) as {
      brief: { section: string; title: string; text: string; ageMin: number | null }[];
    };
    expect(s.brief).toHaveLength(9);
    expect(s.brief[0]).toEqual({
      section: "goals",
      title: GOALS,
      text: "G",
      ageMin: 5,
    });
    expect(s.brief[8]).toMatchObject({ text: "", ageMin: null });
  });
});

describe("read_ticket of a loop escalation", () => {
  const esc = (n: number, repoId: string) => ({
    id: `${repoId}#${n}`,
    repoId,
    issueNumber: n,
    title: "[loop-blocked] x",
    kind: "loop-blocked" as const,
    source: "title" as const,
    openedAt: NOW,
    url: "u",
    question: null,
  });

  it("reads an open loop escalation's issue in another configured repo, and nothing else there", async () => {
    store.replaceEscalations("other", [esc(4, "other")]);
    fetchImpl = async (n) => ticket(n, { title: "Esc", body: "Body" });
    expect((await call("read_ticket", { issue: 4, repo: "other" })).isError).toBeUndefined();
    expect(fetchRepos).toEqual(["other"]);
    expect(await call("read_ticket", { issue: 5, repo: "other" })).toEqual(
      refused(READ_OTHER_REPO),
    );
    expect(await call("read_ticket", { issue: 4, repo: "nope" })).toEqual(refused(READ_OTHER_REPO));
    live("fao-1", "r-fao");
    expect(await call("read_ticket", { issue: 4, repo: "other" }, ctx("fao-1", "r-fao"))).toEqual(
      refused(READ_OTHER_REPO),
    );
    expect(fetchRepos).toEqual(["other"]);
  });

  it("still reads the session repo when repo names it", async () => {
    fetchImpl = async (n) => ticket(n);
    expect((await call("read_ticket", { issue: 3, repo: "mc" })).isError).toBeUndefined();
    expect(fetchRepos).toEqual(["mc"]);
  });
});

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: "" });
const json = (v: unknown): GhResult => ok(JSON.stringify(v));
const failed = (stderr: string): GhResult => ({ code: 1, stdout: "", stderr });
const TOKEN = `ghp_${"a".repeat(30)}`;
const actionsUrl = (job: number) => `https://github.com/o/mc/actions/runs/11/job/${job}`;
const checkRun = (name: string, conclusion: string, job = 22, status = "COMPLETED") => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: actionsUrl(job),
});
const prView = (over: Record<string, unknown> = {}) => ({
  number: 9,
  title: "Add x",
  state: "OPEN",
  isDraft: false,
  author: { login: "guido" },
  headRefName: "feature/9-x",
  headRefOid: "abc123",
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  files: [
    { path: "a.ts", additions: 10, deletions: 1 },
    { path: "b.ts", additions: 2, deletions: 2 },
  ],
  reviewDecision: "",
  latestReviews: [{ author: { login: "retro" }, state: "APPROVED", body: "secret body" }],
  statusCheckRollup: [],
  ...over,
});

describe("read_pr", () => {
  it("answers the diff summary, checks by name and review state", async () => {
    ghImpl = async () =>
      json(
        prView({
          reviewDecision: "APPROVED",
          statusCheckRollup: [
            checkRun("test", "FAILURE"),
            { __typename: "StatusContext", context: "ci/lint", state: "SUCCESS", targetUrl: "u" },
            checkRun("build", "", 23, "IN_PROGRESS"),
          ],
        }),
      );
    const r = await call("read_pr", { pr: 9 });
    expect(ghCalls).toEqual([
      [
        "pr",
        "view",
        "9",
        "--repo=o/mc",
        "--json=number,title,state,isDraft,author,headRefName,headRefOid,additions,deletions,changedFiles,files,reviewDecision,latestReviews,statusCheckRollup",
      ],
    ]);
    expect(JSON.parse(r.text)).toEqual({
      pr: 9,
      title: "Add x",
      state: "OPEN",
      draft: false,
      author: "guido",
      head: "feature/9-x",
      headSha: "abc123",
      diff: {
        files: 2,
        additions: 12,
        deletions: 3,
        listed: [
          { path: "a.ts", additions: 10, deletions: 1 },
          { path: "b.ts", additions: 2, deletions: 2 },
        ],
      },
      checks: [
        { name: "test", state: "FAILURE" },
        { name: "ci/lint", state: "SUCCESS" },
        { name: "build", state: "IN_PROGRESS" },
      ],
      review: { decision: "APPROVED", reviews: [{ author: "retro", state: "APPROVED" }] },
    });
    expect(r.text).not.toContain("secret body");
  });

  it("caps files and checks and cleans text", async () => {
    ghImpl = async () =>
      json(
        prView({
          title: `Leak ${TOKEN}`,
          files: Array.from({ length: 60 }, (_, i) => ({
            path: `f${i}`,
            additions: 1,
            deletions: 0,
          })),
          statusCheckRollup: Array.from({ length: 55 }, (_, i) => checkRun(`c${i}`, "SUCCESS")),
        }),
      );
    const out = JSON.parse((await call("read_pr", { pr: 9 })).text) as {
      title: string;
      diff: { files: number; listed: unknown[] };
      checks: unknown[];
    };
    expect(out.title).toBe("Leak [redacted]");
    expect(out.diff.listed).toHaveLength(FLIGHT_PR_FILES_LISTED);
    expect(out.diff.files).toBe(2);
    expect(out.checks).toHaveLength(FLIGHT_PR_CHECKS_LISTED);
  });

  it("refuses another seat, a missing PR and GitHub down", async () => {
    live("guido-1", "r-guido");
    expect(await call("read_pr", { pr: 9 }, ctx("guido-1", "r-guido"))).toEqual(
      refused(MC_FLIGHT_ONLY),
    );
    ghImpl = async () =>
      failed("GraphQL: Could not resolve to a PullRequest with the number of 9.");
    expect(await call("read_pr", { pr: 9 })).toEqual(refused(READ_NO_PR));
    ghImpl = async () => failed("HTTP 502");
    expect(await call("read_pr", { pr: 9 })).toEqual(refused(READ_NO_GITHUB));
    expect(logs.join("\n")).not.toContain("HTTP 502");
    ghImpl = async () => ok("not json");
    expect(await call("read_pr", { pr: 9 })).toEqual(refused(READ_NO_GITHUB));
  });

  it("shares the hourly cap with the other two", async () => {
    ghImpl = async () => json(prView());
    for (let i = 0; i < FLIGHT_GH_READS_PER_HOUR; i++) {
      expect((await call(i % 2 === 0 ? "read_pr" : "read_ci_log", { pr: 9 })).text).not.toContain(
        "most allowed",
      );
    }
    const text = capText("read GitHub", FLIGHT_GH_READS_PER_HOUR);
    expect(await call("read_pr", { pr: 9 })).toEqual(refused(text));
    expect(await call("list_tickets", { limit: 5 })).toEqual(refused(text));
    nowMs += 61 * 60_000;
    expect((await call("read_pr", { pr: 9 })).isError).toBeUndefined();
  });
});

describe("read_ci_log", () => {
  const rollup = (...checks: unknown[]) => json({ statusCheckRollup: checks });
  const logOf = (n: number) =>
    Array.from({ length: n }, (_, i) => `job\tstep\tline ${i + 1}`).join("\n");

  it("reads the cleaned tail of the first failed Actions job", async () => {
    ghImpl = async (a) =>
      a[0] === "pr"
        ? rollup(
            checkRun("lint", "SUCCESS", 21),
            checkRun("test", "FAILURE", 22),
            checkRun("e2e", "TIMED_OUT", 23),
          )
        : ok(`${logOf(300)}\nleak ${TOKEN}\r\n`);
    const r = await call("read_ci_log", { pr: 9 });
    expect(ghCalls[0]).toEqual(["pr", "view", "9", "--repo=o/mc", "--json=statusCheckRollup"]);
    expect(ghCalls[1]).toEqual(["run", "view", "--repo=o/mc", "--job=22", "--log-failed"]);
    expect(r.isError).toBeUndefined();
    expect(r.text.startsWith("test (job 22):\nAlso failed: e2e\n\n")).toBe(true);
    const body = r.text.split("\n\n").slice(1).join("\n\n");
    expect(body.split("\n")).toHaveLength(FLIGHT_CI_LOG_LINES);
    expect(body).toContain("leak [redacted]");
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("line 100\n");
  });

  it("cuts the tail at FLIGHT_CI_LOG_MAX on a whole line", async () => {
    const long = Array.from({ length: 150 }, (_, i) => `${i}:${"x".repeat(197)}`).join("\n");
    ghImpl = async (a) => (a[0] === "pr" ? rollup(checkRun("test", "FAILURE")) : ok(long));
    const r = await call("read_ci_log", { pr: 9 });
    const body = r.text.split("\n\n").slice(1).join("\n\n");
    expect(body.length).toBeLessThanOrEqual(FLIGHT_CI_LOG_MAX);
    expect(body.endsWith(`149:${"x".repeat(197)}`)).toBe(true);
    expect(body.split("\n").every((l) => /^\d+:x{197}$/.test(l))).toBe(true);
    expect(body.split("\n").length).toBeLessThan(150);
  });

  it("reads a named check and refuses unknown, passing or non-Actions ones", async () => {
    ghImpl = async (a) =>
      a[0] === "pr"
        ? rollup(
            checkRun("lint", "SUCCESS", 21),
            checkRun("test", "FAILURE", 22),
            checkRun("build", "", 23, "IN_PROGRESS"),
            {
              __typename: "StatusContext",
              context: "ci/ext",
              state: "FAILURE",
              targetUrl: "https://ci.example/1",
            },
          )
        : ok("boom");
    expect((await call("read_ci_log", { pr: 9, check: "test" })).text).toBe(
      ciLogText("test", "22", ["ci/ext"], "boom"),
    );
    expect(await call("read_ci_log", { pr: 9, check: "nope" })).toEqual(
      refused(ciNoCheckText(9, "nope")),
    );
    expect(await call("read_ci_log", { pr: 9, check: "lint" })).toEqual(
      refused(ciNotFailedText("lint", "SUCCESS")),
    );
    expect(await call("read_ci_log", { pr: 9, check: "build" })).toEqual(
      refused(ciNotFailedText("build", "IN_PROGRESS")),
    );
    expect(await call("read_ci_log", { pr: 9, check: "ci/ext" })).toEqual(
      refused(ciNotActionsText("ci/ext")),
    );
  });

  it("skips a failed non-Actions check for a later failed Actions job", async () => {
    const ext = {
      __typename: "StatusContext",
      context: "ci/ext",
      state: "FAILURE",
      targetUrl: "https://ci.example/1",
    };
    ghImpl = async (a) =>
      a[0] === "pr" ? rollup(ext, checkRun("test", "FAILURE", 22)) : ok("boom");
    expect((await call("read_ci_log", { pr: 9 })).text).toBe(
      ciLogText("test", "22", ["ci/ext"], "boom"),
    );
    expect(ghCalls[1]).toContain("--job=22");
    ghImpl = async () => rollup(ext);
    expect(await call("read_ci_log", { pr: 9 })).toEqual(refused(ciNotActionsText("ci/ext")));
  });

  it("says when nothing failed or the log is empty", async () => {
    ghImpl = async () => rollup(checkRun("lint", "SUCCESS"));
    expect(await call("read_ci_log", { pr: 9 })).toEqual(refused(ciNoFailedText(9)));
    ghImpl = async (a) => (a[0] === "pr" ? rollup(checkRun("test", "FAILURE")) : ok("  \n\n"));
    expect(await call("read_ci_log", { pr: 9 })).toEqual({ text: CI_LOG_EMPTY });
    ghImpl = async (a) => (a[0] === "pr" ? rollup(checkRun("test", "FAILURE")) : failed("boom"));
    expect(await call("read_ci_log", { pr: 9 })).toEqual(refused(READ_NO_GITHUB));
  });
});

describe("list_tickets", () => {
  const item = (project: number, status: string | null) => ({
    project: { number: project },
    status: status === null ? null : { name: status },
  });
  const issue = (n: number, over: Record<string, unknown> = {}) => ({
    number: n,
    title: `Ticket ${n}`,
    labels: { nodes: [{ name: "area:server" }, { name: "lane:home" }] },
    assignees: { nodes: [{ login: "me" }] },
    projectItems: { nodes: [item(1, "Ready")] },
    ...over,
  });
  const page = (nodes: unknown[], next: string | null = null) =>
    json({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes },
        },
      },
    });
  const items = (project: number, status: string | null) => ({ nodes: [item(project, status)] });
  const list = async (a: Record<string, unknown>) =>
    JSON.parse((await call("list_tickets", a)).text) as {
      repo: string;
      tickets: {
        number: number;
        column: string;
        laneLabel: string | null;
        assignees: string[];
        labels: string[];
      }[];
      more: boolean;
    };

  it("lists from project items with column, lane label and assignees, though the board is empty", async () => {
    const repo = cfg.repos[0];
    if (repo === undefined) throw new Error("no repo");
    repo.statusMap = { Doing: "in progress" };
    ghImpl = async () =>
      page([
        issue(1),
        issue(2, {
          labels: { nodes: [] },
          assignees: { nodes: [] },
          projectItems: items(7, "Ready"),
        }),
        issue(3, { projectItems: items(1, "Weird") }),
        issue(4, { projectItems: items(1, "Doing") }),
        issue(5, { projectItems: items(1, null) }),
      ]);
    const all = await list({ limit: 10 });
    expect(all.repo).toBe("mc");
    expect(all.tickets.map((t) => [t.number, t.column])).toEqual([
      [1, "Ready"],
      [2, NOT_ON_BOARD],
      [3, "Weird"],
      [4, "In progress"],
      [5, "Backlog"],
    ]);
    expect(all.tickets[0]).toMatchObject({
      laneLabel: "lane:home",
      assignees: ["me"],
      labels: ["area:server", "lane:home"],
    });
    expect(all.tickets[1]).toMatchObject({ laneLabel: null, assignees: [] });
    const none = await list({ limit: 10, column: NOT_ON_BOARD });
    expect(none.tickets.map((t) => t.number)).toEqual([2]);
    const ready = await list({ limit: 10, column: "Ready" });
    expect(ready.tickets.map((t) => t.number)).toEqual([1]);
    expect(store.board("mc")).toEqual([]);
  });

  it("passes label and assignee to GitHub", async () => {
    ghImpl = async () => page([]);
    await list({ limit: 5, label: "area:server", assignee: "me" });
    const a = ghCalls[0] ?? [];
    expect(a.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(a).toContain("owner=o");
    expect(a).toContain("name=mc");
    expect(a).toContain("label=area:server");
    expect(a).toContain("assignee=me");
    expect(a.some((x) => x.startsWith("after="))).toBe(false);
    await list({ limit: 5 });
    const b = ghCalls[1] ?? [];
    expect(b.some((x) => x.startsWith("label=") || x.startsWith("assignee="))).toBe(false);
    for (const bad of [
      { limit: 5, assignee: "a b" },
      { limit: 0 },
      { limit: 101 },
      {},
      { limit: 5, column: "Nope" },
    ]) {
      expect((await call("list_tickets", bad)).isError).toBe(true);
    }
  });

  it("caps at limit and at FLIGHT_LIST_PAGES pages", async () => {
    ghImpl = async () => page([issue(1), issue(2), issue(3)]);
    const few = await list({ limit: 2 });
    expect(few.tickets.map((t) => t.number)).toEqual([1, 2]);
    expect(few.more).toBe(true);
    expect((await list({ limit: 3 })).more).toBe(false);
    ghCalls = [];
    let n = 0;
    ghImpl = async () => page([], `c${++n}`);
    const paged = await list({ limit: 5 });
    expect(ghCalls).toHaveLength(FLIGHT_LIST_PAGES);
    expect(ghCalls[1]).toContain("after=c1");
    expect(paged.more).toBe(true);
    ghImpl = async () => failed("x");
    expect(await call("list_tickets", { limit: 5 })).toEqual(refused(READ_NO_GITHUB));
  });
});

describe("draft_reply", () => {
  it("stores a reply without GitHub calls, and exposes no posting tool", async () => {
    const result = await call("draft_reply", {
      target: "mc#12",
      kind: "issue",
      text: "Prepared reply",
    });
    expect(result.isError).toBeUndefined();
    expect(store.drafts()).toEqual([
      {
        id: 1,
        target: "mc#12",
        kind: "issue",
        text: "Prepared reply",
        createdAt: NOW,
        state: "pending",
      },
    ]);
    expect(ghCalls).toEqual([]);
    expect(tools.filter((t) => /draft.*post|post.*draft/.test(t.name))).toEqual([]);
  });
  it("is available through FLIGHT's MCP grant, which has no draft posting tool", async () => {
    const tokens = new RunTokens();
    const token = tokens.issue("flight-1", "r-flight");
    const app = buildApp({
      config: cfg,
      store,
      bus,
      tokens,
      seatMode: (id) => crewSeatMode(cfg, id),
      seatGrants: (id) => crewSeatGrants(cfg, id),
      mcpTools: () => tools,
    });
    const rpc = (name: string, args: object) =>
      app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/event-stream",
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      });
    try {
      const draft = await rpc("draft_reply", {
        target: "mc#12",
        kind: "issue",
        text: "MCP prepared reply",
      });
      expect(draft.json().result.isError).toBeUndefined();
      expect(store.drafts()[0]?.text).toBe("MCP prepared reply");
      const response = await rpc("post_draft", { id: store.drafts()[0]?.id });
      expect(response.json().error.message).toBe("unknown tool");
      expect(ghCalls).toEqual([]);
      expect(store.drafts()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("refuses invalid targets and non-FLIGHT callers", async () => {
    for (const target of [
      "other-repo#1",
      "https://github.com/o/mc/issues/1",
      "mc#0",
      "mc#1 --help",
    ]) {
      expect((await call("draft_reply", { target, kind: "pr", text: "Reply" })).isError).toBe(true);
    }
    live("guido-1", "r-guido");
    expect(
      (
        await call(
          "draft_reply",
          { target: "mc#1", kind: "issue", text: "Reply" },
          ctx("guido-1", "r-guido"),
        )
      ).isError,
    ).toBe(true);
    expect(store.drafts()).toEqual([]);
    expect(ghCalls).toEqual([]);
  });
});

describe("correlated discussion replies", () => {
  it("returns tagged replies only to their original item, including late replies", async () => {
    const a = store.ensureDiscussion("note:a", "v1");
    const b = store.ensureDiscussion("note:b", "v1");
    store.askDiscussion(a.id, "ask-a", "Why?", NOW);
    store.askDiscussion(b.id, "ask-b", "Which?", NOW);
    const args = {
      about: "Item discussion",
      decision: "Checked the code.",
      basis: "Code",
      discussion: { id: a.id, replyTo: "ask-a", messageId: "reply-a" },
    };
    expect((await call("log_decision", args)).isError).toBeUndefined();
    expect(store.discussion("note:a", a.id)?.messages.at(-1)?.text).toBe(args.decision);
    expect(store.discussion("note:b", b.id)?.messages).toHaveLength(1);
    expect(
      (await call("log_decision", { ...args, discussion: { ...args.discussion, id: b.id } }))
        .isError,
    ).toBe(true);
    expect(decisions()).toEqual([]);
  });
});
