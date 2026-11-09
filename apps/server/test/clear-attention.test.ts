import {
  COMMS_CONTROLLER,
  FLIGHT_LEFT_NOTE_KEY,
  FLIGHT_RUNAWAY_NOTE_KEY,
  NEW_LOOP,
  OPERATOR_HEADER,
  type Run,
} from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { FLIGHT_OPERATOR_ACTOR_HEADER } from "../src/flight/operator-call.ts";
import { attentionItems } from "../src/hud.ts";
import { Store } from "../src/store.ts";

const AT = Date.parse("2026-11-09T06:00:00Z");
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
          { id: "FLIGHT-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
          { id: "GUIDO-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
};
let store: Store;
let app: ReturnType<typeof buildApp>;
let now: number;
let reconcileRun: ReturnType<typeof vi.fn>;
beforeEach(() => {
  now = AT;
  store = new Store(":memory:");
  reconcileRun = vi.fn(async () => {});
  app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    now: () => now,
    operatorToken: "fixture",
    controllerToken: "controller-fixture",
    engine: { status: () => ({ on: true, note: null }), onOperatorMessage: vi.fn(), reconcileRun },
  });
});
afterEach(async () => {
  await app.close();
  store.close();
});
const raise = (key = "hub-update-held", at = AT) =>
  store.raiseNote({
    key,
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: "repo",
    text: "The update waits for the crew.",
    at,
  });
const clear = (key: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: `/api/attention/${encodeURIComponent(key)}/clear`,
    headers: { [OPERATOR_HEADER]: "fixture", ...headers },
    payload: {},
  });

it("keeps FLIGHT's unfinished-wake reminder out of attention while retaining its source", () => {
  raise(FLIGHT_LEFT_NOTE_KEY);
  expect(
    attentionItems(config, store, now).some((i) => i.key === `note:${FLIGHT_LEFT_NOTE_KEY}`),
  ).toBe(false);
  expect(store.notes().some((n) => n.key === FLIGHT_LEFT_NOTE_KEY)).toBe(true);
});
it("clears the source, records a closure and stays gone until a newly raised item", async () => {
  raise();
  const key = "note:hub-update-held";
  const result = await clear(key);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toEqual({ cleared: key });
  expect(attentionItems(config, store, now).some((i) => i.key === key)).toBe(false);
  expect(store.questionClosures(0, 10)).toContainEqual(
    expect.objectContaining({ key, kind: "cleared" }),
  );
  expect(store.comms(0).filter((m) => m.from === "MC" && m.to === "FLIGHT-1")).toHaveLength(1);
  expect((await clear(key)).statusCode).toBe(404);
  now++;
  store.clearNote("hub-update-held", now);
  raise("hub-update-held", now);
  expect(attentionItems(config, store, now).some((i) => i.key === key)).toBe(true);
});

it("drops an answered Update brief while retaining its choice and source history", () => {
  raise();
  const key = "note:hub-update-held";
  store.addBrief({
    key,
    for: "operator",
    by: "flight",
    at: AT,
    context: "The update waits.",
    ask: "Update now?",
    recommendation: "Wait.",
    basis: "The crew is busy.",
    options: [
      { id: "wait", label: "Wait", answer: "Wait." },
      { id: "go", label: "Update", answer: "Update." },
    ],
  });
  store.claimChoice({
    key,
    briefAt: AT,
    optionId: "wait",
    label: "Wait",
    answer: "Wait.",
    question: "Update now?",
    ticket: "repo#1",
    target: "FLIGHT-1",
    targetKind: "flight",
    messageId: null,
    chosenAt: AT,
    chosenBy: "operator",
  });
  expect(attentionItems(config, store, now).find((i) => i.key === key)?.brief).toBeUndefined();
  expect(store.briefs().get(key)?.ask).toBe("Update now?");
});

it("does not attach an old operator brief when a note is newly raised", () => {
  raise();
  const key = "note:hub-update-held";
  store.addBrief({
    key,
    for: "operator",
    by: "flight",
    at: AT,
    context: "The older update waits.",
    ask: "Update the older version?",
    recommendation: "Wait.",
    basis: "Older state.",
    options: [],
  });
  store.clearNote("hub-update-held", AT + 1);
  raise("hub-update-held", AT + 2);
  now += 2;
  expect(attentionItems(config, store, now).find((i) => i.key === key)?.brief).toBeUndefined();
});
it("refuses every delegated FLIGHT actor header before changing the source", async () => {
  raise();
  expect(
    (await clear("note:hub-update-held", { [FLIGHT_OPERATOR_ACTOR_HEADER]: "invalid" })).statusCode,
  ).toBe(403);
  expect(store.questionClosures(0, 10)).toEqual([]);
  expect(store.notes()).toHaveLength(1);
});
it("returns the specified missing-item refusal", async () => {
  const result = await clear("note:missing");
  expect(result.statusCode).toBe(404);
  expect(result.json()).toEqual({ error: "That item is no longer waiting." });
});
it("retains controller attribution instead of calling a controller clear the operator's action", async () => {
  raise();
  const result = await app.inject({
    method: "POST",
    url: "/api/attention/note%3Ahub-update-held/clear",
    headers: { "x-mc-controller": "controller-fixture" },
    payload: {},
  });
  expect(result.statusCode, result.body).toBe(200);
  expect(store.questionClosures(0, 10)).toContainEqual(
    expect.objectContaining({
      by: COMMS_CONTROLLER,
      reason: "The controller cleared this item without an answer.",
    }),
  );
});
it("rolls back the closure and source if its durable notice cannot be stored", async () => {
  raise();
  const db = (store as unknown as { db: { exec: (sql: string) => void } }).db;
  db.exec(
    "CREATE TEMP TRIGGER fail_clear_notice BEFORE INSERT ON comms WHEN NEW.to_id = 'FLIGHT-1' BEGIN SELECT RAISE(ABORT, 'fixture notice storage failure'); END",
  );
  const result = await clear("note:hub-update-held");
  expect(result.statusCode).toBe(500);
  expect(store.questionClosures(0, 10)).toEqual([]);
  expect(store.acks().has("note:hub-update-held")).toBe(false);
  expect(store.notes().some((n) => n.key === "hub-update-held")).toBe(true);
});
it("lets the operator clear an acknowledged item and cancels queued legacy delivery without inventing a delivery receipt", async () => {
  raise();
  const key = "note:hub-update-held";
  store.claimDecisionDefault(
    {
      key,
      briefAt: AT,
      optionId: "go",
      label: "Go",
      dueAt: AT,
      target: "GUIDO-1",
      answer: "Proceed.",
    },
    {
      at: AT,
      from: "MC",
      senderKind: "hub",
      to: "CAPCOM",
      ticket: "repo#1",
      text: "Earlier default was claimed.",
    },
    AT,
  );
  expect(store.pendingDecisionDeliveries()).toHaveLength(1);
  expect((await clear(key)).statusCode).toBe(200);
  expect(store.pendingDecisionDeliveries()).toEqual([]);
});
it("keeps the runaway flag and directs the operator to Lift", async () => {
  raise(FLIGHT_RUNAWAY_NOTE_KEY);
  const result = await clear(`note:${FLIGHT_RUNAWAY_NOTE_KEY}`);
  expect(result.statusCode).toBe(409);
  expect(result.json().error).toMatch(/Lift/);
  expect(store.notes().some((n) => n.key === FLIGHT_RUNAWAY_NOTE_KEY)).toBe(true);
  expect(store.questionClosures(0, 10)).toEqual([]);
});
it("closes only the displayed seat question and stores notice for its preserved run", async () => {
  const run: Run = {
    id: "old",
    agentId: "GUIDO-1",
    repoId: "repo",
    seq: 1,
    startedAt: AT - 1000,
    endedAt: null,
    status: "running",
    sessionId: "cli",
    model: "x",
    branch: null,
    ticket: "repo#1",
    costUsd: null,
    tokens: null,
    transcriptPath: "/fixture",
    prs: [],
    summary: null,
  };
  store.upsertRun(run);
  const id = store.addQuestion({
    agentId: "GUIDO-1",
    runId: run.id,
    text: "Which path?",
    at: AT - 10,
  });
  store.passQuestion(id, AT - 1);
  store.setRunLoop(run.id, { ...NEW_LOOP, aside: { worktree: "/fixture", wake: false, ask: id } });
  const another = store.addQuestion({
    agentId: "GUIDO-1",
    runId: run.id,
    text: "Another question",
    at: AT,
  });
  const result = await clear(`ask:${id}`);
  expect(result.statusCode, result.body).toBe(200);
  expect(store.question(id)?.answeredAt).toBe(AT);
  expect(store.question(another)?.answeredAt).toBeNull();
  expect(store.commsInboxRun("GUIDO-1", run.id)).toContainEqual(
    expect.objectContaining({
      from: "MC",
      senderKind: "hub",
      text: expect.stringMatching(/cleared/i),
    }),
  );
  expect(reconcileRun).toHaveBeenCalledExactlyOnceWith(run.id);
});

it("settles a Comms question and addresses its notice to the original asking run", async () => {
  const old: Run = {
    id: "comms-old",
    agentId: "GUIDO-1",
    repoId: "repo",
    seq: 1,
    startedAt: AT - 60 * 60_000,
    endedAt: null,
    status: "running",
    sessionId: "cli",
    model: "x",
    branch: null,
    ticket: "repo#1",
    costUsd: null,
    tokens: null,
    transcriptPath: "/fixture",
    prs: [],
    summary: null,
  };
  store.upsertRun(old);
  const message = store.addComms({
    at: AT - 46 * 60_000,
    from: "GUIDO-1",
    senderKind: "seat",
    fromRunId: old.id,
    to: "FLIGHT-1",
    ticket: "repo#1",
    text: "Which path should this run use?",
    label: "question",
  });
  if (!message) throw new Error("Missing fixture message");
  store.upsertRun({ ...old, id: "comms-next", seq: 2, startedAt: AT - 1 });
  const result = await clear(`comms-open:${message.id}`);
  expect(result.statusCode, result.body).toBe(200);
  expect(store.commsSettlement(message.id)).toMatchObject({ settledBy: "CAPCOM" });
  expect(store.commsInboxRun("GUIDO-1", old.id)).toContainEqual(
    expect.objectContaining({
      from: "MC",
      senderKind: "hub",
      text: expect.stringContaining("cleared"),
    }),
  );
  expect(store.commsInboxRun("GUIDO-1", "comms-next")).toEqual([]);
});
