import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OPERATOR_HEADER, type Run } from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { commsInboxContext } from "../src/comms/index.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const AT = Date.parse("2026-11-09T06:00:00Z");
const FLIGHT = "FLIGHT-1";
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "repo", github: "o/repo", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/fixture",
    maxSeats: 2,
    sessions: [
      {
        id: "s",
        repoId: "repo",
        checkout: "/fixture",
        seats: [
          { id: FLIGHT, role: "FLIGHT", accountId: "a", model: "x", area: [] },
          { id: "GUIDO-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
};
let dir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-flight-conversation-"));
  store = new Store(join(dir, "mc.sqlite"));
  app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    now: () => AT + 100_000,
    operatorToken: "fixture",
  });
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const text = (value: string, at: number | null) => ({
  type: "assistant",
  ...(at === null ? {} : { timestamp: new Date(at).toISOString() }),
  message: { content: [{ type: "text", text: value }] },
});
function run(id: string, frames: object[], seq = 1) {
  let body = "";
  const ids: string[] = [];
  for (const frame of frames) {
    ids.push(`stream:${id}:${Buffer.byteLength(body)}:0`);
    body += `${JSON.stringify(frame)}\n`;
  }
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, body);
  const row: Run = {
    id,
    agentId: FLIGHT,
    repoId: "repo",
    seq,
    startedAt: AT,
    endedAt:
      Math.max(
        AT,
        ...frames.map(
          (frame) => Date.parse((frame as { timestamp?: string }).timestamp ?? "") || AT,
        ),
      ) + 1,
    status: "ok",
    sessionId: "cli",
    model: "x",
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath: path,
    prs: [],
    summary: null,
  };
  store.upsertRun(row);
  return ids;
}
function stored(value: string, at: number, from = "CAPCOM", to = FLIGHT) {
  const message = store.addComms({
    at,
    from,
    to,
    text: value,
    ticket: null,
    senderKind: from === "CAPCOM" ? "operator" : "flight",
  });
  if (!message) throw new Error("Missing fixture message");
  return message;
}
async function page(limit = 50, before?: string) {
  const response = await app.inject(
    `/api/comms/flight?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
const send = (itemKey: string) =>
  app.inject({
    method: "POST",
    url: "/api/comms",
    headers: { [OPERATOR_HEADER]: "fixture" },
    payload: { to: FLIGHT, text: "Explain this item.", itemKey },
  });

it("joins both stored directions and actual turn text in chronological order with the existing page shape", async () => {
  stored("Operator question", AT + 1);
  stored("Stored FLIGHT reply", AT + 3, FLIGHT, "CAPCOM");
  run("flight-run", [text("First turn reply", AT + 2), text("Second turn reply", AT + 4)]);
  const result = await page();
  expect(result).toMatchObject({ hasMore: false, cursor: null, unread: expect.any(Number) });
  expect(result.messages.map((m: { text: string }) => m.text)).toEqual([
    "Operator question",
    "First turn reply",
    "Stored FLIGHT reply",
    "Second turn reply",
  ]);
});
it("reports the current live FLIGHT run with its start time", async () => {
  const startedAt = AT - 60_000;
  const transcriptPath = join(dir, "live-flight-run.jsonl");
  writeFileSync(transcriptPath, "");
  store.upsertRun({
    id: "live-flight-run",
    agentId: FLIGHT,
    repoId: "repo",
    seq: 1,
    startedAt,
    endedAt: null,
    status: "running",
    sessionId: "cli",
    model: "x",
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath,
    prs: [],
    summary: null,
  });
  store.setSeatSession({
    seatId: FLIGHT,
    runId: "live-flight-run",
    cliSessionId: "cli",
    state: "running",
    reason: null,
    worktree: null,
    updatedAt: AT,
    vendor: "claude",
  });

  expect((await page()).flight).toEqual({ live: true, since: startedAt, runId: "live-flight-run" });
});
it("reports a stopped FLIGHT run without a start time", async () => {
  store.setSeatSession({
    seatId: FLIGHT,
    runId: null,
    cliSessionId: null,
    state: "stopped",
    reason: null,
    worktree: null,
    updatedAt: AT,
    vendor: "claude",
  });

  expect((await page()).flight).toEqual({ live: false, since: null, runId: null });
});
it("reports FLIGHT stopped when no FLIGHT seat is configured", async () => {
  const crew = config.crew;
  if (!crew) throw new Error("Fixture crew is missing");
  const noFlight = buildApp({
    config: {
      ...config,
      crew: {
        ...crew,
        sessions: crew.sessions.map((session) => ({
          ...session,
          seats: session.seats.filter((seat) => seat.role !== "FLIGHT"),
        })),
      },
    },
    store,
    bus: new ChangeBus(),
    now: () => AT + 100_000,
    operatorToken: "fixture",
  });
  try {
    const response = await noFlight.inject("/api/comms/flight");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().flight).toEqual({ live: false, since: null, runId: null });
  } finally {
    await noFlight.close();
  }
});
it("pages before either kind of returned id without duplicates or gaps", async () => {
  const question = stored("one", AT + 1);
  const ids = run("flight-run", [text("two", AT + 2), text("four", AT + 4)]);
  stored("three", AT + 3, FLIGHT, "CAPCOM");
  const newest = await page(2);
  expect(newest.messages.map((m: { text: string }) => m.text)).toEqual(["three", "four"]);
  expect(newest.hasMore).toBe(true);
  expect((await page(2, ids[1])).messages.map((m: { text: string }) => m.text)).toEqual([
    "two",
    "three",
  ]);
  expect(
    (await page(2, newest.messages[0].id)).messages.map((m: { text: string }) => m.text),
  ).toEqual(["one", "two"]);
  expect((await page(2, question.id)).messages).toEqual([]);
});
it("excludes hub lines and tools instead of exposing internal work as conversation", async () => {
  stored("[Mission Control] Internal reminder", AT + 1, FLIGHT, "CAPCOM");
  run("flight-run", [
    {
      type: "user",
      timestamp: new Date(AT).toISOString(),
      message: { content: [{ type: "text", text: "[Mission Control] Wake" }] },
    },
    {
      type: "assistant",
      timestamp: new Date(AT + 1).toISOString(),
      message: {
        content: [
          { type: "tool_use", id: "tool1", name: "Bash", input: { command: "hidden command" } },
        ],
      },
    },
    text("Actual reply", AT + 2),
  ]);
  expect((await page()).messages.map((m: { text: string }) => m.text)).toEqual(["Actual reply"]);
});
it("retains item links and derives Stored, Delivered and Answered from actual delivery and response times", async () => {
  const response = await send("note:question");
  expect(response.statusCode, response.body).toBe(200);
  const id = response.json().message.id;
  expect((await page()).messages.find((m: { id: string }) => m.id === id)).toMatchObject({
    state: "stored",
    itemKey: "note:question",
  });
  store.markCommsDelivered(id, AT + 100_001);
  run("flight-run", [text("A turn before delivery", AT + 100_000)]);
  expect((await page()).messages.find((m: { id: string }) => m.id === id)).toMatchObject({
    state: "delivered",
  });
  run("flight-run", [text("A response after delivery", AT + 100_002)]);
  expect((await page()).messages.find((m: { id: string }) => m.id === id)).toMatchObject({
    state: "answered",
  });
});
it("delivers one internal item context to FLIGHT while retaining only the operator words in the conversation", async () => {
  store.raiseNote({
    key: "question",
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: "repo",
    text: "Which storage option should remain?",
    at: AT,
  });
  const response = await send("note:question");
  expect(response.statusCode).toBe(200);
  expect(response.json().message).toMatchObject({
    itemKey: "note:question",
    text: "Explain this item.",
  });
  expect((await send("note:question")).statusCode).toBe(200);
  const inbox = commsInboxContext(store, FLIGHT, "fixture-run");
  const internal = store
    .commsForPair("MC", FLIGHT)
    .filter((m) => m.text.startsWith("[Mission Control] Needs-you context"));
  expect(internal).toHaveLength(1);
  expect(internal[0]?.text).toContain("note:question");
  expect(internal[0]?.text).toContain("Which storage option should remain?");
  expect(inbox.text).toContain("Needs-you context");
  expect((await page()).messages.map((m: { text: string }) => m.text)).toEqual([
    "Explain this item.",
  ]);
});

it("rolls back the operator line if its internal context cannot be stored", async () => {
  const db = new DatabaseSync(join(dir, "mc.sqlite"));
  try {
    db.exec(
      "CREATE TRIGGER reject_context BEFORE INSERT ON comms WHEN NEW.from_id = 'MC' BEGIN SELECT RAISE(ABORT, 'fixture context failure'); END;",
    );
    const response = await send("note:question");
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("fixture context failure");
    expect((await page()).messages).toEqual([]);
    expect(store.commsForPair("MC", FLIGHT)).toEqual([]);
    expect(commsInboxContext(store, FLIGHT, "fixture-run").messageIds).toEqual([]);
  } finally {
    db.close();
  }
});

it("does not deduplicate equal text sent about different items and rejects an oversized item key", async () => {
  expect((await send("note:first")).statusCode).toBe(200);
  expect((await send("note:second")).statusCode).toBe(200);
  expect((await page()).messages.map((m: { itemKey?: string }) => m.itemKey)).toEqual([
    "note:first",
    "note:second",
  ]);
  expect((await send("x".repeat(201))).statusCode).toBe(400);
});
it("returns a stored choice once with its label instead of duplicating the transcript's operator echo", async () => {
  const message = stored("An automatically rendered choice answer", AT + 1);
  store.claimChoice({
    key: "note:choice",
    briefAt: AT,
    optionId: "wait",
    label: "Wait until tomorrow",
    answer: "Wait.",
    question: "When?",
    ticket: null,
    target: FLIGHT,
    targetKind: "flight",
    messageId: message.id,
    chosenAt: AT + 1,
    chosenBy: "operator",
  });
  run("flight-run", [
    {
      type: "user",
      timestamp: new Date(AT + 2).toISOString(),
      message: { content: [{ type: "text", text: "An automatically rendered choice answer" }] },
    },
    text("I will wait.", AT + 3),
  ]);
  const result = await page();
  expect(result.messages.filter((m: { choice?: object }) => m.choice)).toEqual([
    expect.objectContaining({
      id: message.id,
      text: "You chose: Wait until tomorrow",
      choice: { label: "Wait until tomorrow" },
    }),
  ]);
});
it("keeps undated turns honestly undated and stable across repeated reads", async () => {
  const ids = run("flight-run", [text("Known time", AT + 1), text("Undated continuation", null)]);
  expect((await page()).messages.find((m: { id: string }) => m.id === ids[1])).toMatchObject({
    at: null,
    text: "Undated continuation",
  });
  expect((await page()).messages.map((m: { id: string }) => m.id)).toEqual(ids);
});
it("paginates retained turns beyond the latest transcript window and beyond three runs", async () => {
  const expected = Array.from({ length: 245 }, (_, n) => `Turn ${n}`);
  for (let n = 0; n < 4; n++)
    run(
      `flight-run-${n}`,
      expected.slice(n * 70, (n + 1) * 70).map((value, i) => text(value, AT + n * 70 + i)),
      n + 1,
    );
  const found: string[] = [];
  let before: string | undefined;
  for (let n = 0; n < 30; n++) {
    const result = await page(17, before);
    found.unshift(...result.messages.map((m: { text: string }) => m.text));
    if (!result.hasMore) break;
    expect(result.messages.length).toBeGreaterThan(0);
    before = result.messages[0].id;
  }
  expect(found).toEqual(expected);
});
it("rejects a cursor outside this conversation", async () => {
  const other = stored("Private other pair", AT, "CAPCOM", "GUIDO-1");
  const response = await app.inject(`/api/comms/flight?before=${encodeURIComponent(other.id)}`);
  expect(response.statusCode).toBe(400);
});

const read = (messageId: string, scope = "flight") =>
  app.inject({
    method: "POST",
    url: "/api/comms/read",
    headers: { [OPERATOR_HEADER]: "fixture" },
    payload: { scope, messageId },
  });

it("marks through a displayed turn, preserves newer unread lines and never moves backwards", async () => {
  const question = stored("Question", AT);
  const ids = run("flight:run:with:colons", [text("Reply", AT + 1), text("Later", AT + 3)]);
  stored("Another question", AT + 2);
  expect((await page()).unread).toBe(4);
  expect((await read(ids[0])).statusCode).toBe(200);
  expect(await page()).toMatchObject({ cursor: ids[0], unread: 2 });
  expect((await read(question.id)).statusCode).toBe(200);
  expect(await page()).toMatchObject({ cursor: ids[0], unread: 2 });
  expect((await read(ids[1])).statusCode).toBe(200);
  expect(await page()).toMatchObject({ cursor: ids[1], unread: 0 });
  expect(store.commsScopeCursor("flight")).toMatch(/^comms:\d+$/);
});

it("shares the hub unread count between Comms and the FLIGHT fly-out stream", async () => {
  const ids = run("flight-fly-out", [text("Reply", AT + 1)]);
  const flyout = async () => {
    const response = await app.inject("/api/agents/FLIGHT-1/stream");
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { unread?: number };
  };
  expect((await page()).unread).toBe(1);
  expect((await flyout()).unread).toBe(1);
  expect((await read(ids[0] ?? "")).statusCode).toBe(200);
  expect((await page()).unread).toBe(0);
  expect((await flyout()).unread).toBe(0);
});

it("upgrades legacy reads without reviving transcript history or hiding newer mixed replies", async () => {
  const legacy = stored("Legacy read reply", AT + 20, FLIGHT, "CAPCOM");
  store.markCommsScopeRead("flight", legacy.id);
  const historical = run("historical", [text("Previously visible history", AT + 10)]);
  const newer = run(
    "newer",
    [text("First new turn", AT + 30), text("Second new turn", AT + 40)],
    2,
  );
  store.markThreadRead(FLIGHT, [newer[0] ?? ""]);
  stored("New stored reply", AT + 50, FLIGHT, "CAPCOM");
  const settings = vi.spyOn(store, "setSetting");
  const scopes = vi.spyOn(store, "markCommsScopeRead");
  const threads = vi.spyOn(store, "markThreadRead");
  expect(await page()).toMatchObject({ cursor: legacy.id, unread: 2 });
  expect((await page(1)).unread).toBe(2);
  for (const spy of [settings, scopes, threads]) expect(spy).not.toHaveBeenCalled();
  expect((await page()).messages.map((m: { id: string }) => m.id)).toContain(historical[0]);
});

it("rejects fabricated and other-scope read positions without marking anything read", async () => {
  const ids = run("flight-run", [text("Reply", AT)]);
  const other = stored("Private", AT, "CAPCOM", "GUIDO-1");
  for (const id of ["stream:flight-run:999999:0", "comms:999999", other.id])
    expect((await read(id)).statusCode).toBe(400);
  expect((await read(ids[0], "crew")).statusCode).toBe(400);
  expect(await page()).toMatchObject({ cursor: null, unread: 1 });
});

it("reads history without creating delivery, read or setting receipts", async () => {
  const message = stored("Question", AT);
  run("flight-run", [text("Reply", AT + 1)]);
  const settings = vi.spyOn(store, "setSetting");
  const threads = vi.spyOn(store, "markThreadRead");
  const scopes = vi.spyOn(store, "markCommsScopeRead");
  const deliveries = vi.spyOn(store, "markCommsDelivered");
  await page();
  await page();
  for (const spy of [settings, threads, scopes, deliveries]) expect(spy).not.toHaveBeenCalled();
  expect(store.flightConversationStored(FLIGHT, [], 10)[0]).toMatchObject({
    id: message.id,
    deliveredAt: null,
  });
});

it("pages over a single long transcript, same-time lines and undated continuations", async () => {
  const frames = Array.from({ length: 430 }, (_, n) => text(`Turn ${n}`, n % 3 ? null : AT + n));
  const ids = run("long-run", frames);
  const found: string[] = [];
  let before: string | undefined;
  for (let n = 0; n < 50; n++) {
    const result = await page(13, before);
    found.unshift(...result.messages.map((m: { id: string }) => m.id));
    if (!result.hasMore) break;
    before = result.messages[0].id;
  }
  expect(found).toEqual(ids);
});

it("refreshes appended transcripts instead of serving a stale cached answer", async () => {
  run("flight-run", [text("First", AT)]);
  expect((await page()).messages).toHaveLength(1);
  appendFileSync(join(dir, "flight-run.jsonl"), `${JSON.stringify(text("Appended", AT + 1))}\n`);
  expect((await page()).messages.map((m: { text: string }) => m.text)).toEqual([
    "First",
    "Appended",
  ]);
});

it("reaches older replies across an oversized unsupported transcript record", async () => {
  run("flight-run", [
    text("Older reply", AT),
    { type: "unsupported", padding: "x".repeat(9 * 1024 * 1024) },
    text("Latest reply", AT + 1),
  ]);
  expect((await page()).messages.map((m: { text: string }) => m.text)).toEqual([
    "Older reply",
    "Latest reply",
  ]);
});

it("includes an actual operator choice for this crew without exposing ordinary private messages", async () => {
  const choice = stored("Choice payload", AT, "CAPCOM", "GUIDO-1");
  stored("Private ordinary note", AT + 1, "CAPCOM", "GUIDO-1");
  store.claimChoice({
    key: "question:GUIDO-1",
    briefAt: AT,
    optionId: "wait",
    label: "Wait",
    answer: "Wait.",
    question: "When?",
    ticket: null,
    target: "GUIDO-1",
    targetKind: "seat",
    messageId: choice.id,
    chosenAt: AT,
    chosenBy: "operator",
  });
  expect((await page()).messages).toEqual([
    expect.objectContaining({
      id: choice.id,
      text: "You chose: Wait",
      itemKey: "question:GUIDO-1",
    }),
  ]);
});
