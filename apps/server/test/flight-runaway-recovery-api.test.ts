import {
  crewProfileOf,
  FLIGHT_RUNAWAY_LIFTED_SETTING,
  FLIGHT_RUNAWAY_NOTE_KEY,
  FLIGHT_RUNAWAY_SETTING,
  OPERATOR_HEADER,
  RUNAWAY_LIFTED_DECISION,
} from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { type CcConfig, crewSeatDef } from "../src/config.ts";
import { FLIGHT_OPERATOR_ACTOR_HEADER } from "../src/flight/operator-call.ts";
import { recordWrite, runawayTrip, watchRunaway } from "../src/flight/runaway.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 2, 12),
  SEAT = "flight-1",
  RUN = "flight-run";
const TOKEN = "fictional-operator-key";
const ORDINARY = "ordinary-flight-note";
const recovery = [
  "/api/flight/runaway/lift",
  `/api/attention/note:${FLIGHT_RUNAWAY_NOTE_KEY}/dismiss`,
  `/api/attention/note%3A${FLIGHT_RUNAWAY_NOTE_KEY}/dismiss`,
];
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [{ id: "claude", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "sample", github: "example/sample", project: 1, statusMap: {}, autonomy: "merge" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    maxSeats: 1,
    worktrees: "/fixture/worktrees",
    sessions: [
      {
        id: "sample",
        repoId: "sample",
        checkout: "/fixture/clone",
        seats: [{ id: SEAT, role: "FLIGHT", accountId: "claude", model: "opus", area: [] }],
      },
    ],
  },
};
let store: Store, app: FastifyInstance, events: string[], seatToken: string;
const headers = { "content-type": "application/json", [OPERATOR_HEADER]: TOKEN };
const actorHeaders = {
  ...headers,
  [FLIGHT_OPERATOR_ACTOR_HEADER]: JSON.stringify({ seatId: SEAT, runId: RUN }),
};
beforeEach(() => {
  store = new Store(":memory:");
  store.upsertRun({
    id: RUN,
    agentId: SEAT,
    repoId: "sample",
    seq: 1,
    startedAt: NOW - 1000,
    endedAt: null,
    status: "running",
    sessionId: null,
    model: "opus",
    branch: null,
    ticket: null,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    transcriptPath: "/fixture/flight.jsonl",
    prs: [],
    summary: null,
  });
  expect(crewProfileOf("FLIGHT", crewSeatDef(config, SEAT).loop)).toBe("flight-full");
  const bus = new ChangeBus();
  events = [];
  bus.subscribe((topic) => events.push(topic));
  for (let i = 0; i < 5; i++)
    recordWrite(store, { at: NOW - 500 + i, action: "end_run", target: "same-target" });
  watchRunaway(store, bus, NOW - 1);
  expect(runawayTrip(store)).not.toBeNull();
  store.raiseNote({
    key: ORDINARY,
    kind: "flag",
    runId: null,
    seatId: null,
    repoId: null,
    text: "An ordinary note.",
    at: NOW - 50,
  });
  const tokens = new RunTokens();
  seatToken = tokens.issue(SEAT, RUN);
  app = buildApp({ config, store, bus, tokens, operatorToken: TOKEN, now: () => NOW });
  events.length = 0;
});
afterEach(async () => {
  await app.close();
  store.close();
});
const post = (url: string, auth: Record<string, string>) =>
  app.inject({ method: "POST", url, headers: auth, payload: {} });
const snapshot = () => ({
  trip: store.getSetting(FLIGHT_RUNAWAY_SETTING),
  liftedAt: store.getSetting(FLIGHT_RUNAWAY_LIFTED_SETTING),
  writeHistory: store.getSetting("flight.runaway-events"),
  notes: store.notes(),
  audit: store.flightDecisions(0, 100),
});

it.each(recovery)(
  "refuses a valid full-profile actor without a seat bearer on %s, preserving breaker and audit",
  async (url) => {
    const before = snapshot();
    const response = await post(url, actorHeaders);
    expect({ status: response.statusCode, state: snapshot(), events }).toEqual({
      status: 403,
      state: before,
      events: [],
    });
  },
);
it("accepts an ordinary dismissal from that same full-profile actor while preserving recovery state", async () => {
  const before = snapshot();
  const response = await post(`/api/attention/note:${ORDINARY}/dismiss`, actorHeaders);
  expect(response.statusCode).toBe(200);
  const after = snapshot();
  expect(after.trip).toBe(before.trip);
  expect(after.liftedAt).toBe(before.liftedAt);
  expect(after.writeHistory).toBe(before.writeHistory);
  expect(after.audit).toEqual(before.audit);
  expect(after.notes.find((note) => note.key === ORDINARY)?.dismissedAt).toBe(NOW);
  expect(after.notes.find((note) => note.key === FLIGHT_RUNAWAY_NOTE_KEY)).toEqual(
    before.notes.find((note) => note.key === FLIGHT_RUNAWAY_NOTE_KEY),
  );
  expect(events).toEqual(["attention"]);
});
it.each(recovery)("keeps direct operator/controller recovery through %s", async (url) => {
  const response = await post(url, headers);
  expect(response.statusCode).toBe(200);
  expect(runawayTrip(store)).toBeNull();
  expect(store.getSetting("flight.runaway-events")).toBeNull();
  expect(store.getSetting(FLIGHT_RUNAWAY_LIFTED_SETTING)).toBe(String(NOW));
  expect(store.notes().some((note) => note.key === FLIGHT_RUNAWAY_NOTE_KEY)).toBe(false);
  expect(store.notes().find((note) => note.key === ORDINARY)?.dismissedAt).toBeNull();
  expect(
    store.flightDecisions(0, 100).filter((d) => d.decision === RUNAWAY_LIFTED_DECISION),
  ).toMatchObject([{ seatId: null, targetRunId: null, basis: "The operator lifted it." }]);
  expect(events).toEqual(["attention", "flight"]);
});
it.each([...recovery, `/api/attention/note:${ORDINARY}/dismiss`])(
  "preserves recognized seat-bearer denial on %s even with the operator credential",
  async (url) => {
    const before = snapshot();
    const response = await post(url, { ...headers, authorization: `Bearer ${seatToken}` });
    expect({ status: response.statusCode, state: snapshot(), events }).toEqual({
      status: 403,
      state: before,
      events: [],
    });
  },
);
it("still requires the operator credential for actor-provenance attention requests", async () => {
  const before = snapshot();
  const response = await post(recovery[1], {
    "content-type": "application/json",
    [FLIGHT_OPERATOR_ACTOR_HEADER]: actorHeaders[FLIGHT_OPERATOR_ACTOR_HEADER],
  });
  expect({ status: response.statusCode, state: snapshot(), events }).toEqual({
    status: 401,
    state: before,
    events: [],
  });
});
