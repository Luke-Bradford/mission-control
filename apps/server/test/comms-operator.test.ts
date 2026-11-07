import type { Run } from "@mc/core";
import { expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const seat = (id: string, role: string) => ({
  id,
  role,
  accountId: "claude-main",
  model: "opus",
  area: [],
});
const config: CcConfig = {
  operator: { id: "op", timezone: "UTC" },
  accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
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
        seats: [seat("flight-1", "FLIGHT"), seat("guido-1", "GUIDO"), seat("inco-1", "INCO")],
      },
    ],
  },
};
const run = (over: Partial<Run>): Run => ({
  id: "r1",
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: 1000,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: null,
  ticket: "mc#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "/x/y.log",
  prs: [],
  summary: null,
  reviewId: null,
  ...over,
});
const headers = { "x-mc-operator": "test-token" };

function setup() {
  const store = new Store(":memory:");
  const woken: string[] = [];
  let clock = 100_000;
  const app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    operatorToken: "test-token",
    now: () => clock,
    deliverComms: (seatId) => {
      woken.push(seatId);
    },
  });
  const send = (payload: object) =>
    app.inject({ method: "POST", url: "/api/comms", payload, headers });
  return { store, app, woken, send, tick: (ms: number) => (clock += ms) };
}

it("an operator message to a seat shows stored, wakes the seat, then shows delivered with the time", async () => {
  const { store, app, woken, send } = setup();
  const res = await send({ to: "guido-1", text: "Please look at the failing test." });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body).toMatchObject({ state: "stored", deliveredAt: null, alreadySent: false });
  expect(woken).toEqual(["guido-1"]);
  const id = body.message.id as string;
  // the seat's turn takes it
  store.markCommsInboxRead("guido-1", [id], 123_456);
  const state = await app.inject({ url: `/api/comms/${id}/state`, headers });
  expect(state.json()).toMatchObject({ state: "delivered", deliveredAt: 123_456 });
  await app.close();
});

it("an identical send within a minute is stored once and answers already sent with the first state", async () => {
  const { store, app, woken, send, tick } = setup();
  const first = (await send({ to: "guido-1", text: "same words" })).json();
  store.markCommsInboxRead("guido-1", [first.message.id], 100_500);
  tick(3_000);
  const again = await send({ to: "guido-1", text: "same words" });
  expect(again.statusCode).toBe(200);
  expect(again.json()).toMatchObject({
    alreadySent: true,
    state: "delivered",
    deliveredAt: 100_500,
  });
  expect(again.json().message.id).toBe(first.message.id);
  expect(store.comms(0)).toHaveLength(1);
  expect(store.commsRepeatCount(0)).toBe(1);
  expect(woken).toEqual(["guido-1"]);
  // after the minute it is stored again
  tick(61_000);
  expect((await send({ to: "guido-1", text: "same words" })).json().alreadySent).toBe(false);
  expect(store.comms(0)).toHaveLength(2);
  await app.close();
});

it("a reply to a seat whose run ended goes to the seat now on that ticket, else to FLIGHT", async () => {
  const { store, app, send } = setup();
  store.upsertRun(run({ id: "r1", endedAt: 2_000, status: "ok" }));
  const original = store.addComms({
    at: 1_500,
    from: "guido-1",
    to: "CAPCOM",
    ticket: "mc#7",
    text: "Done with the plan.",
    fromRunId: "r1",
  });
  if (original === null) throw new Error("not stored");
  // no seat is on the ticket: FLIGHT takes it, and the page can say so first
  const route = await app.inject({ url: `/api/comms/${original.id}/reply-route`, headers });
  expect(route.json()).toMatchObject({ to: "flight-1", redirected: true });
  expect(route.json().note).toContain("ended");
  const toFlight = await send({ to: "guido-1", text: "thanks", replyTo: original.id });
  expect(toFlight.json()).toMatchObject({ redirectedTo: "flight-1" });
  expect(toFlight.json().message.to).toBe("flight-1");
  // another seat now works the ticket
  store.upsertRun(run({ id: "r9", agentId: "inco-1", seq: 1 }));
  store.setSeatSession({
    seatId: "inco-1",
    runId: "r9",
    cliSessionId: null,
    state: "running",
    reason: null,
    worktree: null,
    updatedAt: 1,
  });
  const next = await send({ to: "guido-1", text: "and one more", replyTo: original.id });
  expect(next.json().message.to).toBe("inco-1");
  // a reply to a message whose run is still live goes where it was addressed
  store.upsertRun(run({ id: "r2", seq: 2 }));
  const live = store.addComms({
    at: 3_000,
    from: "guido-1",
    to: "CAPCOM",
    ticket: "mc#7",
    text: "Still going.",
    fromRunId: "r2",
  });
  if (live === null) throw new Error("not stored");
  expect((await app.inject({ url: `/api/comms/${live.id}/reply-route`, headers })).json()).toEqual({
    to: "guido-1",
    redirected: false,
    note: "",
  });
  await app.close();
});

it("the choose route validates its body and answers 404 for a question that is not open", async () => {
  const { app } = setup();
  const url = "/api/attention/ask:99/choose";
  expect(
    (await app.inject({ method: "POST", url, payload: { optionId: "yes" }, headers })).statusCode,
  ).toBe(400);
  const gone = await app.inject({
    method: "POST",
    url,
    payload: { optionId: "yes", briefAt: 5 },
    headers,
  });
  expect(gone.statusCode).toBe(404);
  expect((await app.inject({ url: "/api/attention/ask:99/choice", headers })).statusCode).toBe(404);
  await app.close();
});
