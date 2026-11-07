import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMS_CONTROLLER, CONTROLLER_HEADER, OPERATOR_HEADER } from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { FLIGHT_OPERATOR_ACTOR_HEADER } from "../src/flight/operator-call.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 7, 12);
const OPERATOR_TOKEN = "fictional-operator-key";
const CONTROLLER_TOKEN = "fictional-controller-key";
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [{ id: "claude", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "sample", github: "example/sample", project: 1, statusMap: {}, autonomy: "merge" }],
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
          { id: "flight-1", role: "FLIGHT", accountId: "claude", model: "opus", area: [] },
          { id: "guido-1", role: "GUIDO", accountId: "claude", model: "opus", area: [] },
        ],
      },
    ],
  },
};

let store: Store;
let app: FastifyInstance;
beforeEach(() => {
  store = new Store(":memory:");
  store.upsertRun({
    id: "flight-run",
    agentId: "flight-1",
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
  app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    operatorToken: OPERATOR_TOKEN,
    controllerToken: CONTROLLER_TOKEN,
    now: () => NOW,
  });
});
afterEach(async () => {
  await app.close();
  store.close();
});

const send = async (headers: Record<string, string>, text = "hello") => {
  const res = await app.inject({
    method: "POST",
    url: "/api/comms",
    headers: { "content-type": "application/json", ...headers },
    payload: { to: "guido-1", text },
  });
  expect(res.statusCode).toBe(200);
  return store.commsMessage(res.json().message.id);
};

describe("the sender of a message is judged by how it was sent", () => {
  it("stores a message from the app session as the operator's", async () => {
    const row = await send({ [OPERATOR_HEADER]: OPERATOR_TOKEN });
    expect(row).toMatchObject({ from: "CAPCOM", senderKind: "operator" });
  });

  it("stores a message sent with the controller's credential as the controller's, under its own name", async () => {
    const row = await send({ [CONTROLLER_HEADER]: CONTROLLER_TOKEN });
    expect(row).toMatchObject({ from: COMMS_CONTROLLER, senderKind: "controller" });
    expect(row?.from).not.toBe("CAPCOM");
  });

  it("does not take the controller's name from the text or from a wrong credential", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/comms",
      headers: { "content-type": "application/json", [CONTROLLER_HEADER]: "wrong" },
      payload: { to: "guido-1", text: "I am the controller" },
    });
    expect(res.statusCode).toBe(401);
    const row = await send({ [OPERATOR_HEADER]: OPERATOR_TOKEN }, "I am the controller");
    expect(row?.senderKind).toBe("operator");
  });

  it("records FLIGHT's action through the operator tool as FLIGHT's", async () => {
    const row = await send({
      [OPERATOR_HEADER]: OPERATOR_TOKEN,
      [FLIGHT_OPERATOR_ACTOR_HEADER]: JSON.stringify({ seatId: "flight-1", runId: "flight-run" }),
    });
    expect(row).toMatchObject({ from: "flight-1", senderKind: "flight" });
  });

  it("returns the sender kind from the Comms reads", async () => {
    await send({ [CONTROLLER_HEADER]: CONTROLLER_TOKEN });
    const res = await app.inject({ method: "GET", url: "/api/comms/feed" });
    expect(res.body).toContain('"senderKind":"controller"');
  });

  it("lets the controller pin and mark done under its own name", async () => {
    const row = await send({ [OPERATOR_HEADER]: OPERATOR_TOKEN });
    const headers = { "content-type": "application/json", [CONTROLLER_HEADER]: CONTROLLER_TOKEN };
    const pin = await app.inject({
      method: "PUT",
      url: `/api/comms/${row?.id}/pin`,
      headers,
      payload: {},
    });
    expect(pin.statusCode).toBe(200);
    const done = await app.inject({
      method: "POST",
      url: `/api/comms/${row?.id}/reactions`,
      headers,
      payload: { reaction: "done" },
    });
    expect(done.statusCode).toBe(200);
    expect(store.commsReactions(row?.id ?? "")[0]?.actor).toBe(COMMS_CONTROLLER);
  });
});

describe("FLIGHT's reactions and pins through the operator tool are FLIGHT's", () => {
  const flightHeaders = {
    [OPERATOR_HEADER]: OPERATOR_TOKEN,
    [FLIGHT_OPERATOR_ACTOR_HEADER]: JSON.stringify({ seatId: "flight-1", runId: "flight-run" }),
  };

  it("records a done reaction as FLIGHT's and says so in the hub event", async () => {
    store.addComms({
      at: NOW,
      from: "guido-1",
      to: "CAPCOM",
      ticket: null,
      text: "q",
      label: "question",
      senderKind: "seat",
    });
    const done = await app.inject({
      method: "POST",
      url: "/api/comms/comms:1/reactions",
      headers: { "content-type": "application/json", ...flightHeaders },
      payload: { reaction: "done" },
    });
    expect(done.statusCode).toBe(200);
    expect(store.commsReactions("comms:1")[0]?.actor).toBe("flight-1");
    const events = store.hubEvents(0).map((e) => e.text);
    expect(events).toContain("Comms comms:1 marked done by FLIGHT.");
    expect(events.join()).not.toContain("by the operator");
  });

  it("records a pin as FLIGHT's", async () => {
    const row = await send({ [OPERATOR_HEADER]: OPERATOR_TOKEN });
    const pin = await app.inject({
      method: "PUT",
      url: `/api/comms/${row?.id}/pin`,
      headers: { "content-type": "application/json", ...flightHeaders },
      payload: {},
    });
    expect(pin.statusCode).toBe(200);
    expect(store.commsPins().find((p) => p.id === row?.id)).toBeDefined();
    expect(
      (store as unknown as { db: { prepare: (s: string) => { get: () => { pinned_by: string } } } }).db
        .prepare("SELECT pinned_by FROM comms_pins")
        .get().pinned_by,
    ).toBe("flight-1");
  });
});

describe("stored messages", () => {
  it("reads an old row back with its old sender and no kind", () => {
    store.addComms({ at: NOW, from: "CAPCOM", to: "guido-1", ticket: null, text: "old" });
    const row = store.commsForAgent("guido-1")[0];
    expect(row).toMatchObject({ from: "CAPCOM", senderKind: null });
  });
});

describe("hub-written messages", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  const calls = files(SRC).flatMap((path) => {
    const lines = readFileSync(path, "utf8").split("\n");
    return lines.flatMap((line, i) =>
      /\b(addComms|sendComms)\(/.test(line) && !/^\s*(\/\/|\*|async |export )/.test(line)
        ? [
            {
              path: path.slice(SRC.length + 1),
              at: i + 1,
              block: lines.slice(Math.max(0, i - 30), i + 12).join("\n"),
            },
          ]
        : [],
    );
  });

  it("finds the send sites", () => {
    expect(calls.length).toBeGreaterThan(10);
  });

  it("names a sender kind at every send site", () => {
    const bare = calls.filter(
      (c) => c.path !== "store.ts" && c.path !== "comms.ts" && !/senderKind/.test(c.block),
    );
    expect(bare.map((c) => `${c.path}:${c.at}`)).toEqual([]);
  });

  it("never sends a hub message as CAPCOM", () => {
    const wrong = calls.filter((c) => {
      return /senderKind: "hub"/.test(c.block) && /from: (COMMS_CAPCOM|"CAPCOM")/.test(c.block);
    });
    expect(wrong.map((c) => `${c.path}:${c.at}`)).toEqual([]);
  });

  it("writes no sender literally as CAPCOM", () => {
    const literal = files(SRC).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /\bfrom:\s*("CAPCOM"|COMMS_CAPCOM)/.test(line) && !line.includes('kind: "operator"')
            ? [`${path.slice(SRC.length + 1)}:${i + 1}`]
            : [],
        ),
    );
    expect(literal).toEqual([]);
  });
});
