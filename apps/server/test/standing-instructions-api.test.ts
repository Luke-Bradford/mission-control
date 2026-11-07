import { OPERATOR_HEADER, type Run } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { FLIGHT_OPERATOR_ACTOR_HEADER } from "../src/flight/operator-call.ts";
import { announceInstruction, flushInstructionNotices } from "../src/instruction-notices.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { Store } from "../src/store.ts";

const NOW = 123456789;
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [{ id: "claude", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "sample", github: "example/sample", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    maxSeats: 2,
    worktrees: "/fixture/worktrees",
    sessions: [
      {
        id: "sample",
        repoId: "sample",
        checkout: "/fixture/clone",
        seats: [
          { id: "flight", role: "FLIGHT", accountId: "claude", model: "opus", area: [] },
          { id: "builder", role: "GUIDO", accountId: "claude", model: "haiku", area: [] },
        ],
      },
    ],
  },
};
const run: Run = {
  id: "flight-run",
  agentId: "flight",
  repoId: "sample",
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
  transcriptPath: "/fixture/transcript",
  prs: [],
  summary: null,
};
let store: Store, bus: ChangeBus, tokens: RunTokens, app: ReturnType<typeof buildApp>;
const headers = { "content-type": "application/json", [OPERATOR_HEADER]: "fictional-token" };
const actor = {
  ...headers,
  [FLIGHT_OPERATOR_ACTOR_HEADER]: JSON.stringify({ seatId: "flight", runId: "flight-run" }),
};
beforeEach(() => {
  store = new Store(":memory:");
  bus = new ChangeBus();
  tokens = new RunTokens();
  store.upsertRun(run);
  app = buildApp({ config, store, bus, tokens, operatorToken: "fictional-token", now: () => NOW });
});
afterEach(async () => {
  await app.close();
  store.close();
});
const post = (url: string, payload: unknown = {}, auth: Record<string, string> = headers) =>
  app.inject({ method: "POST", url, headers: auth, payload: JSON.stringify(payload) });
const snapshot = () =>
  JSON.stringify([
    store.instructions.list(null),
    store.instructions.seat("builder"),
    store.instructions.notices(),
    store.flightDecisions(0, 100),
    store.commsInbox("builder"),
    store.instructions.revision(),
  ]);
it("saves/replaces/revokes global orders with retained direct lookup and strict author fields", async () => {
  const saved = await post("/api/flight/orders", { text: "Ship QA first" });
  expect(saved.statusCode).toBe(200);
  const first = saved.json().entry;
  expect(first).toMatchObject({
    by: "operator",
    at: NOW,
    revokedAt: null,
    text: "Ship QA first",
    seatId: null,
  });
  expect((await post("/api/flight/orders", { text: "bad", by: "operator" })).statusCode).toBe(400);
  const next = (
    await post("/api/flight/orders", { text: "Ship tests first", replacesId: first.id })
  ).json().entry;
  expect((await app.inject(`/api/flight/orders/${first.id}`)).json()).toMatchObject({
    text: "Ship QA first",
    revokedAt: NOW,
  });
  const revoked = await post(`/api/flight/orders/${next.id}/revoke`);
  expect(revoked.json()).toMatchObject({ changed: true, entry: { revokedAt: NOW } });
  const before = snapshot();
  expect((await post(`/api/flight/orders/${next.id}/revoke`)).json().changed).toBe(false);
  expect(snapshot()).toBe(before);
});
it("refuses declared FLIGHT global writes on ordinary and encoded paths without mutations", async () => {
  const order = store.instructions.create(
    null,
    { kind: "text", text: "Protected" },
    "operator",
    NOW,
  ).entry;
  for (const url of [
    "/api/flight/orders",
    "/api/flight/%6frders",
    `/api/flight/orders/${order.id}/revoke`,
  ]) {
    const before = snapshot();
    const result = await post(url, url.endsWith("revoke") ? {} : { text: "Forged" }, actor);
    expect(result.statusCode).toBe(403);
    expect(snapshot()).toBe(before);
  }
});
it("retains declared provenance if the actor run ends after onRequest validation", async () => {
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (req.headers[FLIGHT_OPERATOR_ACTOR_HEADER])
      store.setRunEnded(run.id, NOW + 1, "ok", "operator");
    return payload;
  });
  const order = store.instructions.create(
    null,
    { kind: "text", text: "Protected" },
    "operator",
    NOW,
  ).entry;
  const before = store.instructions.list(null);
  expect((await post(`/api/flight/orders/${order.id}/revoke`, {}, actor)).statusCode).toBe(403);
  expect(store.instructions.list(null)).toEqual(before);
  expect(store.flightDecisions(0, 100)).toEqual([]);
});
it("protects operator seat entries after actor completion during parsing, and rejects malformed/stale actors", async () => {
  const instruction = store.instructions.create(
    "builder",
    { kind: "text", text: "Operator seat rule" },
    "operator",
    NOW,
  ).entry;
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (req.headers[FLIGHT_OPERATOR_ACTOR_HEADER])
      store.setRunEnded(run.id, NOW + 1, "ok", "operator");
    return payload;
  });
  const before = snapshot();
  expect(
    (await post(`/api/seats/builder/instructions/${instruction.id}/revoke`, {}, actor)).statusCode,
  ).toBe(403);
  expect(snapshot()).toBe(before);
  for (const value of [
    "not-json",
    JSON.stringify({ seatId: "flight", runId: "missing" }),
    actor[FLIGHT_OPERATOR_ACTOR_HEADER],
  ]) {
    expect(
      (
        await post(
          "/api/flight/orders",
          { text: "Forged" },
          { ...headers, [FLIGHT_OPERATOR_ACTOR_HEADER]: value },
        )
      ).statusCode,
    ).toBe(403);
  }
});
it("requires a configured matching operator token and refuses seat bearer authority", async () => {
  const before = snapshot();
  expect(
    (await post("/api/flight/orders", { text: "No key" }, { "content-type": "application/json" }))
      .statusCode,
  ).toBe(401);
  const token = tokens.issue("builder", "builder-run");
  expect(
    (
      await post(
        "/api/flight/orders",
        { text: "Seat bearer" },
        { ...headers, authorization: `Bearer ${token}` },
      )
    ).statusCode,
  ).toBe(403);
  expect(snapshot()).toBe(before);
  const noKey = buildApp({ config, store, bus });
  try {
    expect(
      (
        await noKey.inject({
          method: "POST",
          url: "/api/flight/orders",
          headers,
          payload: { text: "No configured key" },
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await noKey.close();
  }
});
it("uses one effective focus across compatibility writes, instruction routes and index", async () => {
  const lower = await post(
    "/api/seats/builder/instructions",
    { kind: "focus", focus: "lane:work" },
    actor,
  );
  expect(lower.statusCode).toBe(200);
  expect((await app.inject("/api/seats/builder/focus")).json().focus).toBe("lane:work");
  const cleared = await post("/api/seats/builder/focus", { focus: null });
  expect(cleared.json()).toMatchObject({
    focus: null,
    entry: { by: "operator", kind: "focus", focus: null },
  });
  expect(
    (await post("/api/seats/builder/focus", { focus: "label:urgent" }, actor)).statusCode,
  ).toBe(409);
  const list = (await app.inject("/api/seats/builder/instructions")).json();
  expect(list.effectiveFocus).toBeNull();
  expect(list.focusInstructionId).toBe(cleared.json().entry.id);
  expect(
    (await app.inject("/api/flight/instructions"))
      .json()
      .seats.find((s: { seatId: string }) => s.seatId === "builder").effectiveFocus,
  ).toBeNull();
  await post(`/api/seats/builder/instructions/${cleared.json().entry.id}/revoke`);
  expect((await app.inject("/api/seats/builder/focus")).json().focus).toBe("lane:work");
});
it("stores a short durable notice before a live notification failure, without duplicate retry", async () => {
  let messages = 0;
  const supervisor = {
    seatFacts: () => ({ inTurn: false, resumedAt: null, rateLimitedUntil: null }),
    message: async () => {
      messages++;
      throw Error("fixture disconnected");
    },
  };
  const result = store.instructions.create(
    "builder",
    { kind: "text", text: "x".repeat(4000) },
    "operator",
    NOW,
  );
  const announced = await announceInstruction({ config, store, bus, supervisor }, result);
  expect(announced.delivery).toBe("inbox");
  expect(messages).toBe(1);
  expect(store.instructions.active("builder")).toHaveLength(1);
  expect(store.instructions.notices()).toEqual([]);
  await flushInstructionNotices({ config, store, bus, supervisor });
  expect(messages).toBe(1);
  const inbox = store.commsInbox("builder");
  expect(inbox).toHaveLength(1);
  expect(inbox[0].text.length).toBeLessThan(1200);
  expect(inbox[0]).toMatchObject({ from: "MC", senderKind: "hub" });
});

it("reports each concurrent mutation's own recipient delivery while draining a shared flush", async () => {
  const extra = {
    id: "other-builder",
    role: "GUIDO",
    accountId: "claude",
    model: "haiku",
    area: [],
  };
  const cfg = structuredClone(config);
  cfg.crew!.sessions[0].seats.push(extra);
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstNotification = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const notified: string[] = [];
  const supervisor = {
    seatFacts: (seatId: string) => ({
      inTurn: seatId === extra.id,
      resumedAt: null,
      rateLimitedUntil: null,
    }),
    message: async (seatId: string) => {
      notified.push(seatId);
      entered();
      await gate;
    },
  };
  const first = store.instructions.create(
    "builder",
    { kind: "text", text: "First mutation" },
    "operator",
    NOW,
  );
  const firstReply = announceInstruction({ config: cfg, store, bus, supervisor }, first);
  await firstNotification;
  const later = store.instructions.create(
    extra.id,
    { kind: "text", text: "Concurrent mutation" },
    "operator",
    NOW + 1,
  );
  const laterReply = announceInstruction({ config: cfg, store, bus, supervisor }, later);
  release();
  expect((await firstReply).delivery).toBe("notified");
  expect((await laterReply).delivery).toBe("inbox");
  expect(notified).toEqual(["builder"]);
  expect(store.commsInbox("builder")).toHaveLength(1);
  expect(store.commsInbox(extra.id)).toHaveLength(1);
  expect(store.instructions.notices()).toEqual([]);
});

it("clears only the focus-import warning when a real capacity failure is resolved", async () => {
  const { importInstructionFocus } = await import("../src/instruction-notices.ts");
  const cfg = structuredClone(config);
  cfg.crew!.sessions[0].seats.find((s) => s.id === "builder")!.focus = "label:catalog";
  let firstId = 0;
  for (let i = 0; i < 64; i++) {
    const entry = store.instructions.create(
      "builder",
      { kind: "text", text: `Retained rule ${i}` },
      "operator",
      NOW,
    ).entry;
    if (i === 0) firstId = entry.id;
  }
  store.raiseNote({
    key: "unrelated-warning",
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: null,
    text: "Leave this warning alone",
    at: NOW,
  });
  const events: string[] = [];
  bus.subscribe((topic) => events.push(topic));
  const logs: string[] = [];
  const deps = { config: cfg, store, bus, now: () => NOW, log: (text: string) => logs.push(text) };
  importInstructionFocus(deps);
  expect(store.notes().map((n) => n.key)).toContain("instruction-focus:builder");
  expect(logs).toHaveLength(1);
  store.instructions.revoke(firstId, "builder", "operator", NOW + 1);
  importInstructionFocus(deps);
  expect(store.instructions.focus("builder").effectiveFocus).toBe("label:catalog");
  expect(store.notes().map((n) => n.key)).not.toContain("instruction-focus:builder");
  expect(store.notes().map((n) => n.key)).toContain("unrelated-warning");
  expect(events.filter((topic) => topic === "attention")).toHaveLength(2);
  importInstructionFocus(deps);
  expect(events.filter((topic) => topic === "attention")).toHaveLength(2);
});
