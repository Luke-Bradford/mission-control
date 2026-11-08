import type { AuditImprovementKind, Run, RunTokenAudit } from "@mc/core";
import { COMMS_CAPCOM, COMMS_CONTROLLER, COMMS_MC } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 8, 12);
const SINCE = NOW - 7 * 24 * HOUR;

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

const raw = (sql: string, ...args: (string | number | null)[]) =>
  (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    .prepare(sql)
    .run(...args);

const run = (over: Partial<Run>): Run => ({
  id: "r1",
  agentId: "guido-1",
  repoId: "repo",
  seq: 1,
  startedAt: NOW - HOUR,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: "opus",
  branch: null,
  ticket: "repo#7",
  costUsd: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
  transcriptPath: "/x.jsonl",
  prs: [],
  summary: null,
  ...over,
});

const rows = (kind: AuditImprovementKind, thresholds?: Parameters<Store["audit"]>[3]) =>
  (store.audit(SINCE, NOW, new Map(), thresholds).improvements ?? []).filter(
    (r) => r.kind === kind,
  );

const msg = (over: Partial<Parameters<Store["addComms"]>[0]> = {}) =>
  store.addComms({
    at: NOW - HOUR,
    from: "guido-1",
    to: "flight-1",
    ticket: "repo#7",
    text: "hello",
    senderKind: "seat",
    ...over,
  });

describe("question-asked-back", () => {
  const discussion = (key: string, text: string, at: number) =>
    raw(
      "INSERT INTO item_discussions (id, item_key, version, messages) VALUES (?, ?, 'v', ?)",
      `d-${key}`,
      key,
      JSON.stringify([
        { id: "m1", itemKey: key, correlationId: "c", role: "flight", text: "Q", at: at - 1 },
        { id: "m2", itemKey: key, correlationId: "c", role: "operator", text, at },
      ]),
    );
  const choice = (key: string) =>
    raw(
      `INSERT INTO question_choices (key, brief_at, option_id, label, answer, question, ticket, target, target_kind, chosen_at)
       VALUES (?, 1, 'a', 'A', 'a', 'q', 'repo#7', 'guido-1', 'seat', 2)`,
      key,
    );

  it("gives one row, linked to the ticket, when the first reply is a question", () => {
    choice("needs:1");
    discussion("needs:1", "What does this mean?", NOW - HOUR);
    expect(rows("question-asked-back")).toMatchObject([
      { subject: "needs:1", ticket: "repo#7", pr: null },
    ]);
  });
  it("gives no row when the first reply is a statement", () => {
    discussion("needs:2", "Go with the first option.", NOW - HOUR);
    expect(rows("question-asked-back")).toEqual([]);
  });
});

describe("question-waited", () => {
  const ask = (answeredAt: number | null) => {
    store.upsertRun(run({ id: "r1", startedAt: NOW - 10 * HOUR }));
    raw(
      "INSERT INTO seat_questions (agent_id, run_id, text, at, answered_at) VALUES ('guido-1','r1','q?',?,?)",
      NOW - 5 * HOUR,
      answeredAt,
    );
  };
  it("gives one row when a seat's question waited past the set time", () => {
    ask(NOW - 5 * HOUR + 3 * HOUR);
    expect(rows("question-waited")).toMatchObject([
      { subject: "ask:1", ticket: "repo#7", pr: null },
    ]);
  });
  it("gives no row when it was answered within the set time", () => {
    ask(NOW - 5 * HOUR + HOUR);
    expect(rows("question-waited")).toEqual([]);
  });
  it("counts a still open question, and a changed threshold moves the row", () => {
    ask(null);
    expect(rows("question-waited")).toHaveLength(1);
    expect(rows("question-waited", { questionWaitMs: 6 * HOUR })).toEqual([]);
  });
  it("covers an operator question's choice", () => {
    raw(
      `INSERT INTO question_choices (key, brief_at, option_id, label, answer, question, ticket, target, target_kind, chosen_at)
       VALUES ('needs:9', ?, 'a', 'A', 'a', 'q', 'repo#9', 'flight-1', 'flight', ?)`,
      NOW - 6 * HOUR,
      NOW - HOUR,
    );
    expect(rows("question-waited")).toMatchObject([{ ticket: "repo#9" }]);
  });
});

describe("delivered-after-run-ended", () => {
  const setup = (deliveredAt: number) => {
    store.upsertRun(run({ id: "r1", endedAt: NOW - 3 * HOUR, status: "ok" }));
    const m = msg({ from: COMMS_CAPCOM, senderKind: "operator", targetRunId: "r1", pr: 12 });
    raw("UPDATE comms SET delivered_at = ? WHERE id = 1", deliveredAt);
    return m;
  };
  it("gives one row linked to the ticket and PR", () => {
    setup(NOW - 2 * HOUR);
    expect(rows("delivered-after-run-ended")).toMatchObject([
      { subject: "comms:1", ticket: "repo#7", pr: 12 },
    ]);
  });
  it("gives no row when it was delivered before the run ended", () => {
    setup(NOW - 4 * HOUR);
    expect(rows("delivered-after-run-ended")).toEqual([]);
  });
});

describe("chatter", () => {
  const rounds = (n: number) => {
    for (let i = 0; i < n; i++) {
      msg({ at: NOW - HOUR + i * 2, from: "a-1", to: "b-1" });
      msg({ at: NOW - HOUR + i * 2 + 1, from: "b-1", to: "a-1" });
    }
  };
  it("gives one row for a pair past six rounds", () => {
    rounds(7);
    expect(rows("chatter")).toMatchObject([{ ticket: "repo#7", pr: null }]);
  });
  it("gives no row at six rounds", () => {
    rounds(6);
    expect(rows("chatter")).toEqual([]);
  });
});

describe("repeat-message", () => {
  it("gives one row for a message sent twice", () => {
    msg({ pr: 3 });
    store.addComms(
      {
        at: NOW - HOUR + 2000,
        from: "guido-1",
        to: "flight-1",
        ticket: "repo#7",
        text: "hello",
        pr: 3,
        senderKind: "seat",
      },
      undefined,
      NOW - HOUR,
    );
    expect(rows("repeat-message")).toMatchObject([{ subject: "comms:1", ticket: "repo#7", pr: 3 }]);
  });
  it("gives no row for a message sent once", () => {
    msg();
    expect(rows("repeat-message")).toEqual([]);
  });
});

describe("repeat-notice", () => {
  const notice = (n: number, pr = 5) => {
    for (let i = 0; i < n; i++)
      msg({ at: NOW - HOUR + i, from: COMMS_MC, senderKind: "hub", pr, text: "CI failed on abc." });
  };
  it("gives one row when the same notice reaches the set count on a PR", () => {
    notice(3);
    expect(rows("repeat-notice")).toMatchObject([{ ticket: "repo#7", pr: 5 }]);
  });
  it("gives no row below the count, or for other PRs", () => {
    notice(2);
    expect(rows("repeat-notice")).toEqual([]);
    expect(rows("repeat-notice", { noticeRepeats: 2 })).toHaveLength(1);
  });
});

describe("controller-request-waited", () => {
  const request = (age: number) => msg({ at: NOW - age, to: COMMS_CONTROLLER, pr: 8 });
  it("gives one row for a request still open past the set time", () => {
    request(5 * HOUR);
    expect(rows("controller-request-waited")).toMatchObject([
      { subject: "comms:1", ticket: "repo#7", pr: 8 },
    ]);
  });
  it("gives no row for a recent request", () => {
    request(HOUR);
    expect(rows("controller-request-waited")).toEqual([]);
  });
  it("gives no row when the controller replied in time, a row when it replied late", () => {
    request(5 * HOUR);
    msg({
      at: NOW - 5 * HOUR + HOUR,
      from: COMMS_CONTROLLER,
      to: "guido-1",
      senderKind: "controller",
      replyTo: "comms:1",
    });
    expect(rows("controller-request-waited")).toEqual([]);
    raw("UPDATE comms SET at = ? WHERE id = 2", NOW - 30 * MIN);
    expect(rows("controller-request-waited")).toHaveLength(1);
  });
});

describe("ticket-message-volume", () => {
  const talk = (ticket: string, chars: number) =>
    msg({ ticket, text: "x".repeat(chars), at: NOW - HOUR });
  it("gives one row for a ticket with far more text than usual", () => {
    for (const t of ["repo#1", "repo#2", "repo#3"]) talk(t, 1000);
    talk("repo#4", 9000);
    expect(rows("ticket-message-volume")).toMatchObject([
      { subject: "repo#4", ticket: "repo#4", pr: null, chars: 9000 },
    ]);
  });
  it("gives no row when tickets are alike or the text is small", () => {
    for (const t of ["repo#1", "repo#2", "repo#3"]) talk(t, 1000);
    talk("repo#4", 2000);
    expect(rows("ticket-message-volume")).toEqual([]);
  });
});

describe("tool-usage", () => {
  const audit = (byTool: RunTokenAudit["byTool"]): RunTokenAudit => ({
    calls: 1,
    peakContext: 1,
    medianContext: 1,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    rewrites: 0,
    rewriteTokens: 0,
    readAfterReport: null,
    bySource: {},
    byCommand: {},
    byTool,
  });
  it("shows calls and characters of the four tools for the last 24 hours", () => {
    store.upsertRun(run({ id: "new", startedAt: NOW - 2 * HOUR, seq: 1 }));
    store.upsertRun(run({ id: "old", startedAt: NOW - 30 * HOUR, seq: 2 }));
    store.saveRunTokenAudit(
      "new",
      NOW,
      audit({
        mcp__mc__report_findings: { calls: 2, written: 100, returned: 20 },
        mcp__mc__read_ticket: { calls: 1, written: 5, returned: 400 },
      }),
      [],
    );
    store.saveRunTokenAudit(
      "old",
      NOW,
      audit({ mcp__mc__report_findings: { calls: 9, written: 999, returned: 999 } }),
      [],
    );
    const tools = rows("tool-usage");
    expect(tools.map((r) => [r.subject, r.calls, r.chars])).toEqual([
      ["report_findings", 2, 120],
      ["report_evidence", 0, 0],
      ["read_ticket", 1, 405],
      ["preview_browser", 0, 0],
    ]);
  });
});
