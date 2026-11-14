import { crewProfileOf, OPERATOR_HEADER } from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { CliHold } from "../src/cli/update.ts";
import { type CcConfig, crewSeatDef } from "../src/config.ts";
import { FLIGHT_OPERATOR_ACTOR_HEADER } from "../src/flight/operator-call.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import type { Supervisor } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";
import {
  createQuietGate,
  HUB_INSTALL_NEEDS_PERSON,
  HUB_UNSAFE_NEEDS_PERSON,
  HUB_UPDATE_HELD_KEY,
  HUB_UPDATE_PERSON_KEY,
  UPDATE_HOLD_OWNER,
  UpdateError,
  type Updater,
} from "../src/update.ts";

const NOW = Date.UTC(2026, 10, 7, 12),
  SEAT = "flight-1",
  RUN = "flight-run",
  TOKEN = "fictional-operator-key";
const configFor = (powers: "standard" | "superuser"): CcConfig => ({
  operator: { id: "operator", timezone: "UTC" },
  accounts: [{ id: "claude", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [
    {
      id: "sample",
      github: "example/sample",
      project: 1,
      statusMap: {},
      autonomy: "merge",
      flightPowers: powers,
    },
  ],
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
          { id: SEAT, role: "FLIGHT", accountId: "claude", model: "opus", area: [] },
          { id: "guido-1", role: "GUIDO", accountId: "claude", model: "opus", area: [] },
        ],
      },
    ],
  },
});
let store: Store,
  app: FastifyInstance,
  calls: string[],
  busy: { seatId: string; state: string }[],
  hold: CliHold,
  updateError: UpdateError | null,
  updateOpts: unknown;
const headers = { "content-type": "application/json", [OPERATOR_HEADER]: TOKEN };
const asFlight = {
  ...headers,
  [FLIGHT_OPERATOR_ACTOR_HEADER]: JSON.stringify({ seatId: SEAT, runId: RUN }),
};
const build = (powers: "standard" | "superuser", gate = false) => {
  const config = configFor(powers);
  expect(crewProfileOf("FLIGHT", crewSeatDef(config, SEAT).loop)).toBe("flight-full");
  const updater = {
    update: async (opts?: unknown) => {
      calls.push("update");
      updateOpts = opts;
      if (updateError !== null) throw updateError;
      return { swapped: true };
    },
    restart: () => calls.push("restart"),
  } as unknown as Updater;
  const supervisor = {
    busy: () => busy,
    status: () => ({ enabled: true }),
  } as unknown as Supervisor;
  app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    tokens: new RunTokens(),
    operatorToken: TOKEN,
    now: () => NOW,
    updater,
    supervisor,
    ...(gate ? { updateGate: createQuietGate(hold, { waitMs: 50, pollMs: 5 }) } : {}),
  });
};
beforeEach(() => {
  calls = [];
  hold = new CliHold();
  updateError = null;
  updateOpts = undefined;
  busy = [{ seatId: SEAT, state: "running" }];
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
  store.raiseNote({
    key: HUB_UPDATE_HELD_KEY,
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: null,
    text: "Update waits for you: main changes more than the page and docs.",
    at: NOW - 10,
  });
});
afterEach(async () => {
  await app.close();
  store.close();
});
const update = (h: Record<string, string>) =>
  app.inject({ method: "POST", url: "/api/update", headers: h, payload: {} });

it("lets FLIGHT run a held Update on a superuser repo when no other seat is busy", async () => {
  build("superuser");
  const r = await update(asFlight);
  expect(r.statusCode).toBe(200);
  expect(calls).toEqual(["update"]);
});

it("refuses FLIGHT's Update while another crew seat is working, and says who", async () => {
  build("superuser");
  busy = [...busy, { seatId: "guido-1", state: "running" }];
  const r = await update(asFlight);
  expect(r.statusCode).toBe(409);
  expect(r.json<{ error: string }>().error).toContain("GUIDO-1");
  expect(calls).toEqual([]);
});

it("refuses FLIGHT's Update on a standard repo", async () => {
  build("standard");
  const r = await update(asFlight);
  expect(r.statusCode).toBe(403);
  expect(calls).toEqual([]);
});

it("refuses FLIGHT's Update when none is held for a person", async () => {
  build("superuser");
  store.clearNote(HUB_UPDATE_HELD_KEY, NOW);
  const r = await update(asFlight);
  expect(r.statusCode).toBe(409);
  expect(calls).toEqual([]);
  // the operator's own Update does not need a hold
  expect((await update(headers)).statusCode).toBe(200);
});

it("records an Update FLIGHT ran as FLIGHT's", async () => {
  build("superuser");
  await update(asFlight);
  expect(store.hubEvents(0).map((e: { text: string }) => e.text)).toContain("Updated by FLIGHT");
});

it("leaves the operator's own Update alone while seats are busy", async () => {
  build("standard");
  busy = [...busy, { seatId: "guido-1", state: "running" }];
  const r = await update(headers);
  expect(r.statusCode).toBe(200);
  expect(calls).toEqual(["update"]);
});

it("holds new runs and runs FLIGHT's Update once the working seat's turn ends", async () => {
  build("superuser", true);
  busy = [...busy, { seatId: "guido-1", state: "running" }];
  setTimeout(() => {
    expect(hold.heldBy(UPDATE_HOLD_OWNER)).toBe(true);
    busy = busy.filter((b) => b.seatId !== "guido-1");
  }, 20);
  const r = await update(asFlight);
  expect(r.statusCode).toBe(200);
  expect(calls).toEqual(["update"]);
  expect(updateOpts).toEqual({ refuseUnsafe: true });
  // the Update is done: new runs start again
  expect(hold.reason).toBeNull();
});

it("answers 409 naming the seat when it is still working after the wait, and keeps new runs held", async () => {
  build("superuser", true);
  busy = [...busy, { seatId: "guido-1", state: "running" }];
  const r = await update(asFlight);
  expect(r.statusCode).toBe(409);
  expect(r.json<{ error: string }>().error).toContain("GUIDO-1");
  expect(calls).toEqual([]);
  expect(hold.heldBy(UPDATE_HOLD_OWNER)).toBe(true);
  // a repeat call finds the quiet gap the hold made
  busy = busy.filter((b) => b.seatId !== "guido-1");
  expect((await update(asFlight)).statusCode).toBe(200);
  expect(hold.reason).toBeNull();
});

it("never asks a person-only Update of FLIGHT: a shortcut in the change goes to the operator with its reason", async () => {
  build("superuser", true);
  updateError = new UpdateError(409, HUB_UNSAFE_NEEDS_PERSON, {
    held: { commits: ["a1 one"], paths: ["docs/linked"], unsafePaths: ["docs/linked"] },
  });
  const r = await update(asFlight);
  expect(r.statusCode).toBe(409);
  const person = store.notes().find((n) => n.key === HUB_UPDATE_PERSON_KEY);
  expect(person?.text).toContain("adds a shortcut to another file or folder");
  expect(store.notes().some((n) => n.key === HUB_UPDATE_HELD_KEY)).toBe(false);
});

it("raises a person-only note when pnpm needs a person", async () => {
  build("superuser", true);
  updateError = new UpdateError(409, HUB_INSTALL_NEEDS_PERSON);
  expect((await update(asFlight)).statusCode).toBe(409);
  expect(store.notes().find((n) => n.key === HUB_UPDATE_PERSON_KEY)?.text).toContain(
    "node_modules",
  );
});
